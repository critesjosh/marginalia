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
  type ConfluentEnv,
  type ProduceOutcome,
} from './confluent'

export const EVENTS_PATH = '/api/events/v1/batches'
export const MAX_BATCH_EVENTS = 20
export const MAX_BATCH_BYTES = 128 * 1024

export interface EventsEnv extends ConfluentEnv {
  MARGINALIA_SYNC_TOKEN_SHA256?: string
  MARGINALIA_TRUSTED_USER_ID?: string
  SYNC_CONTROL?: KVNamespace
  EVENTS_RATE_LIMITER?: RateLimit
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

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
}

export function digestFromHex(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(value)) return undefined
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Compares fixed-length digests with the runtime's constant-time primitive. */
export async function tokenMatches(value: string, expectedHex: string): Promise<boolean> {
  const expected = digestFromHex(expectedHex)
  if (!expected) return false
  const presented = await sha256(value)
  // Cloudflare exposes timingSafeEqual on SubtleCrypto. Node's Web Crypto does
  // not yet, so unit tests use the fixed-length fallback below.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => boolean
  }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(presented, expected)

  const left = new Uint8Array(presented)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ expected[index]
  return difference === 0
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match?.[1]
}

async function boundedText(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel('request body exceeds event batch limit')
        return undefined
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/**
 * A disabled installation is stopped at the edge. Full cloud deletion sets this
 * before it asks Databricks to purge, so another tab still holding the token
 * cannot repopulate what is being deleted.
 */
export function syncControlKey(userId: string): string {
  return `sync-state:${userId}`
}

export const SYNC_DISABLED = 'disabled'

export async function syncDisabled(
  env: { SYNC_CONTROL?: KVNamespace },
  userId: string,
): Promise<boolean> {
  if (!env.SYNC_CONTROL) return false
  return (await env.SYNC_CONTROL.get(syncControlKey(userId))) === SYNC_DISABLED
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

  if (
    !env.MARGINALIA_SYNC_TOKEN_SHA256 ||
    !digestFromHex(env.MARGINALIA_SYNC_TOKEN_SHA256) ||
    !env.MARGINALIA_TRUSTED_USER_ID
  ) {
    return failure(503, 'sync_not_configured')
  }

  // Rate-limit before authentication so token guessing is bounded too. The
  // Cloudflare-provided address is not logged or persisted by this Worker.
  if (env.EVENTS_RATE_LIMITER) {
    const address = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success } = await env.EVENTS_RATE_LIMITER.limit({ key: `ip:${address}` })
    if (!success) return failure(429, 'rate_limited')
  }

  const token = bearerToken(request)
  if (!token) return failure(401, 'missing_token')
  if (!(await tokenMatches(token, env.MARGINALIA_SYNC_TOKEN_SHA256))) {
    return failure(401, 'invalid_token')
  }

  const userId = env.MARGINALIA_TRUSTED_USER_ID

  if (await syncDisabled(env, userId)) return failure(423, 'sync_disabled')

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0')
  if (declaredLength > MAX_BATCH_BYTES) return failure(413, 'batch_too_large')

  const body = await boundedText(request, MAX_BATCH_BYTES)
  if (body === undefined) return failure(413, 'batch_too_large')

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

  const configuration = confluentConfigFrom(env)
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
