/**
 * Same-origin relay for product telemetry (decision 0008, docs/telemetry.md).
 *
 * The PWA never talks to PostHog. `GET /api/telemetry/config` says whether
 * this deployment collects usage data and which consent rule applies to the
 * reader's region; `POST /api/telemetry/events` takes a batch, applies the
 * allowlist again, adds the project key and forwards it to PostHog with none
 * of the reader's request headers, so PostHog never sees their IP address or
 * user agent. Without a valid key and host the relay is off and says so.
 *
 * Shared by the Cloudflare app Worker and the Vite dev server, so it is
 * written against Web APIs only.
 */

import { createRateLimiter, fetchUpstream, isCrossOrigin, json } from './http-guards.ts'
import { boundedText } from './resilience.ts'
import { operationMetric } from './telemetry.ts'
import { consentForCountry } from './telemetryRegion.ts'
import {
  COMMON_SCHEMA,
  EVENT_SCHEMA,
  isEventName,
  MAX_BATCH,
  pickAllowed,
  scrubFeedback,
} from './telemetrySchema.ts'

const MAX_BODY_BYTES = 64 * 1024
/** The PWA's session id (`newId`): a UUID, or a base-36 fallback on insecure origins. */
const SESSION_ID_PATTERN = /^[a-z0-9-]{8,64}$/

/** A tab flushes every few seconds at most; a burst beyond this is not a reader. */
const rateLimited = createRateLimiter({ windowMs: 60_000, maxRequests: 60 })

export interface TelemetryRelayOptions {
  /** PostHog project key (`phc_…`). Unset or malformed turns the relay off. */
  apiKey?: string
  /** PostHog ingestion origin, e.g. `https://eu.i.posthog.com`. */
  host?: string
  /** `off` asks for consent everywhere; anything else follows the region. */
  defaultMode?: string
  fetch?: typeof fetch
}

export interface TelemetryRequestContext {
  ip: string
  /** Cloudflare's country for the request; read for the consent rule, never kept. */
  country?: string | null
}

export type TelemetryConfigResponse =
  { enabled: false } | { enabled: true; consent: 'opt_in' | 'opt_out' }

interface ForwardedEvent {
  event: string
  timestamp?: string
  properties: Record<string, unknown>
}

/** Personal keys (`phx_…`) can read data, so only a project key is accepted. */
function isProjectKey(key: string | undefined): key is string {
  return typeof key === 'string' && /^phc_[A-Za-z0-9]{20,64}$/.test(key)
}

function ingestionOrigin(host: string | undefined): string | undefined {
  if (!host) return undefined
  try {
    const url = new URL(host)
    const bare = url.pathname === '/' && !url.search && !url.username && !url.password
    return url.protocol === 'https:' && bare ? url.origin : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
}

/**
 * Rebuilds one event from allowlisted parts only. Anything the schema does
 * not name, including PostHog's own `$` properties, is dropped and the
 * privacy flags are set here rather than trusted from the client.
 */
export function sanitizeEvent(raw: unknown): ForwardedEvent | undefined {
  if (!isRecord(raw) || !isEventName(raw.event) || !isRecord(raw.properties)) return undefined
  const { properties } = raw
  const distinctId = properties.distinct_id
  if (typeof distinctId !== 'string' || !SESSION_ID_PATTERN.test(distinctId)) return undefined

  const kept = {
    ...pickAllowed(COMMON_SCHEMA, properties),
    ...pickAllowed(EVENT_SCHEMA[raw.event], properties),
  }
  if (typeof kept.feedback === 'string') {
    kept.feedback = scrubFeedback(kept.feedback) || undefined
    kept.has_feedback = kept.feedback !== undefined
  }

  return {
    event: raw.event,
    ...(isTimestamp(raw.timestamp) && { timestamp: raw.timestamp }),
    properties: {
      ...kept,
      distinct_id: distinctId,
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'rami-web',
    },
  }
}

export async function handleTelemetryRequest(
  request: Request,
  options: TelemetryRelayOptions,
  context: TelemetryRequestContext,
): Promise<Response> {
  const started = performance.now()
  const response = await route(request, options, context)
  console.info(
    JSON.stringify(operationMetric('telemetry', response.status, performance.now() - started)),
  )
  return response
}

async function route(
  request: Request,
  options: TelemetryRelayOptions,
  context: TelemetryRequestContext,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const apiKey = isProjectKey(options.apiKey) ? options.apiKey : undefined
  const origin = ingestionOrigin(options.host)

  if (pathname === '/api/telemetry/config') {
    if (request.method !== 'GET') return failure(405, 'Method not allowed.')
    let body: TelemetryConfigResponse = { enabled: false }
    if (apiKey && origin) {
      const consent = options.defaultMode === 'off' ? 'opt_in' : consentForCountry(context.country)
      body = { enabled: true, consent }
    }
    // Per reader: the answer depends on where the request came from.
    return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  if (pathname !== '/api/telemetry/events') return failure(404, 'Not found.')
  if (request.method !== 'POST') return failure(405, 'Method not allowed.')
  if (isCrossOrigin(request)) return failure(403, 'Cross-origin request.')
  if (!apiKey || !origin) return failure(503, 'Usage data is off.')
  if (rateLimited(context.ip)) return failure(429, 'Too many requests.')

  const batch = await readBatch(request)
  if (batch === 'too_large') return failure(413, 'Batch too large.')
  if (!batch) return failure(400, 'Expected a JSON batch.')

  const events = batch.map(sanitizeEvent).filter((event) => event !== undefined)
  if (!events.length) return new Response(null, { status: 204 })

  // Only the body goes upstream: no IP, user agent, cookies or referrer.
  const upstream = await fetchUpstream(options.fetch ?? fetch, `${origin}/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, batch: events }),
  })
  if (!upstream?.ok) return failure(502, 'Could not reach analytics.')
  return new Response(null, { status: 204 })
}

function failure(status: number, message: string): Response {
  return json({ error: { message } }, status)
}

async function readBatch(request: Request): Promise<unknown[] | 'too_large' | undefined> {
  if (!request.headers.get('content-type')?.includes('application/json')) return undefined
  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_BODY_BYTES) return 'too_large'
  let text: string
  try {
    text = await boundedText(request, MAX_BODY_BYTES)
  } catch {
    return 'too_large'
  }
  try {
    const body: unknown = JSON.parse(text)
    if (!isRecord(body) || !Array.isArray(body.batch)) return undefined
    return body.batch.length > MAX_BATCH ? 'too_large' : body.batch
  } catch {
    return undefined
  }
}
