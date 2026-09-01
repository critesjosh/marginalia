// POST /api/events/v1/batches
//
// The browser never supplies an identity. A valid Marginalia sync token maps to
// the server-held trusted user, and only then is a consented event forwarded to
// Kafka. Nothing about a submitted payload is logged.
import { validateSubmittedEvent, type EventValidation } from '../../../shared/events/validate'
import {
  ConfluentProducer,
  confluentConfigFrom,
  recordKey,
  type ProduceOutcome,
} from './confluent'

export const EVENTS_PATH = '/api/events/v1/batches'
export const MAX_BATCH_EVENTS = 20
export const MAX_BATCH_BYTES = 128 * 1024

export interface EventsEnv {
  MARGINALIA_SYNC_TOKEN_SHA256?: string
  MARGINALIA_TRUSTED_USER_ID?: string
  SYNC_CONTROL?: KVNamespace
  EVENTS_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  [key: string]: unknown
}

export type DeliveryResult =
  | { eventId: string; status: 'accepted' }
  | { eventId: string; status: 'retry'; code: string }
  | { eventId: string; status: 'rejected'; code: string }

export interface EventsOptions {
  /** Injected by the tests; production builds one from the Worker secrets. */
  producer?: { produce(record: { key: string; value: unknown }): Promise<ProduceOutcome> }
  now?: () => number
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function failure(status: number, code: string): Response {
  return json({ error: { code } }, status)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Length-independent comparison so a wrong token leaks no timing signal. */
function equalsConstantTime(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match?.[1]
}

/**
 * A disabled installation is stopped at the edge. Full cloud deletion sets this
 * before it asks Databricks to purge, so another tab still holding the token
 * cannot repopulate what is being deleted.
 */
async function syncDisabled(env: EventsEnv, userId: string): Promise<boolean> {
  if (!env.SYNC_CONTROL) return false
  return (await env.SYNC_CONTROL.get(`sync-state:${userId}`)) === 'disabled'
}

function validationResults(events: readonly unknown[]): {
  checked: EventValidation[]
  allValid: boolean
} {
  const checked = events.map((event) => validateSubmittedEvent(event))
  return { checked, allValid: checked.every((result) => result.valid) }
}

/**
 * One invalid event aborts the whole batch before anything is produced. The
 * valid events are reported as `batch_not_produced` rather than
 * `blocked_by_prior_event`: nothing prior to them failed, and the client backs
 * that code off normally instead of retrying it for free.
 */
function rejectedResults(checked: readonly EventValidation[]): DeliveryResult[] {
  return checked.map((result, index) => {
    const eventId = result.valid ? result.eventId : result.eventId ?? `index-${index}`
    return result.valid
      ? { eventId, status: 'retry', code: 'batch_not_produced' }
      : { eventId, status: 'rejected', code: result.code }
  })
}

export async function handleEventBatchRequest(
  request: Request,
  env: EventsEnv,
  options: EventsOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed')

  if (!env.MARGINALIA_SYNC_TOKEN_SHA256 || !env.MARGINALIA_TRUSTED_USER_ID) {
    return failure(503, 'sync_not_configured')
  }

  const token = bearerToken(request)
  if (!token) return failure(401, 'missing_token')
  const presented = await sha256Hex(token)
  if (!equalsConstantTime(presented, env.MARGINALIA_SYNC_TOKEN_SHA256.toLowerCase())) {
    return failure(401, 'invalid_token')
  }

  const userId = env.MARGINALIA_TRUSTED_USER_ID

  // Keyed on the digest so no rate-limiter key ever holds the token itself.
  if (env.EVENTS_RATE_LIMITER) {
    const { success } = await env.EVENTS_RATE_LIMITER.limit({ key: presented })
    if (!success) return failure(429, 'rate_limited')
  }

  if (await syncDisabled(env, userId)) return failure(423, 'sync_disabled')

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0')
  if (declaredLength > MAX_BATCH_BYTES) return failure(413, 'batch_too_large')

  const body = await request.text()
  if (new TextEncoder().encode(body).length > MAX_BATCH_BYTES) {
    return failure(413, 'batch_too_large')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failure(400, 'malformed_json')
  }

  const events = (parsed as { events?: unknown })?.events
  if (!Array.isArray(events) || events.length === 0) return failure(400, 'empty_batch')
  if (events.length > MAX_BATCH_EVENTS) return failure(413, 'batch_too_large')

  // Every event is checked before any event is produced, so one bad record
  // cannot leave half a batch on the topic.
  const { checked, allValid } = validationResults(events)
  if (!allValid) {
    const results = rejectedResults(checked)
    logBatch(userId, results, 'validation_failed')
    return json({ results })
  }

  const configuration = confluentConfigFrom(env as Record<string, unknown>)
  const producer =
    options.producer ?? (configuration ? new ConfluentProducer(configuration) : undefined)
  if (!producer) return failure(503, 'sync_not_configured')

  const valid = checked as Extract<EventValidation, { valid: true }>[]
  const order = valid
    .map((result, index) => ({ result, event: events[index] }))
    .sort((a, b) => a.result.sequence - b.result.sequence)

  const results: DeliveryResult[] = []
  let blocked = false
  const receivedAt = new Date(options.now?.() ?? Date.now()).toISOString()

  for (const { result, event } of order) {
    if (blocked) {
      results.push({ eventId: result.eventId, status: 'retry', code: 'blocked_by_prior_event' })
      continue
    }

    const outcome = await producer.produce({
      key: recordKey(userId, result.installationId),
      value: { ...(event as object), userId, receivedAt },
    })

    if (outcome.status === 'accepted') {
      results.push({ eventId: result.eventId, status: 'accepted' })
      continue
    }

    blocked = true
    results.push({ eventId: result.eventId, status: outcome.status, code: outcome.code })
  }

  logBatch(userId, results, 'produced')
  return json({ results })
}

function logBatch(userId: string, results: readonly DeliveryResult[], outcome: string): void {
  // Counts and codes only. Event payloads and consented text never appear here.
  const codes: Record<string, number> = {}
  for (const result of results) {
    const code = result.status === 'accepted' ? 'accepted' : `${result.status}:${result.code}`
    codes[code] = (codes[code] ?? 0) + 1
  }
  console.log(
    JSON.stringify({ message: 'event batch', userId, outcome, count: results.length, codes }),
  )
}
