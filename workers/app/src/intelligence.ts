// Public intelligence endpoints.
//
// The browser reaches Gold only through here, and never learns that Databricks
// or Lakebase exist. It presents the same sync token it uses for events; the
// trusted user id is stamped server-side, exactly as it is for ingestion, so a
// browser cannot ask for somebody else's profile by asking nicely.

import {
  SYNC_DISABLED,
  bearerToken,
  digestFromHex,
  syncControlKey,
  syncDisabled,
  tokenMatches,
} from './events'

export const INTELLIGENCE_PREFIX = '/api/intelligence/v1/'

export interface IntelligenceEnv {
  MARGINALIA_SYNC_TOKEN_SHA256?: string
  MARGINALIA_TRUSTED_USER_ID?: string
  SYNC_CONTROL?: KVNamespace
  INTELLIGENCE_RATE_LIMITER?: RateLimit
  // The Databricks App the Worker calls. OAuth M2M: the client credentials are
  // Worker secrets and never reach the browser.
  DATABRICKS_APP_URL?: string
  DATABRICKS_OAUTH_TOKEN_URL?: string
  DATABRICKS_CLIENT_ID?: string
  DATABRICKS_CLIENT_SECRET?: string
}

/** Injectable so the tests never need a network or a real token endpoint. */
export interface UpstreamCaller {
  (path: string, init: { method: string; body?: string }): Promise<Response>
}

const UPSTREAM_TIMEOUT_MS = 10_000
// Refreshed a little before expiry so a request never races the clock.
const TOKEN_EXPIRY_MARGIN_MS = 60_000

interface CachedToken {
  value: string
  expiresAt: number
}

let cachedToken: CachedToken | undefined

/** Test seam. Module state would otherwise leak between cases. */
export function resetTokenCache(): void {
  cachedToken = undefined
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Private per-reader data. Never store it in a shared cache.
      'cache-control': 'no-store',
    },
  })
}

function failure(status: number, code: string): Response {
  return json({ error: { code } }, status)
}

async function accessToken(env: IntelligenceEnv, now: number): Promise<string | undefined> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now) return cachedToken.value
  if (!env.DATABRICKS_OAUTH_TOKEN_URL || !env.DATABRICKS_CLIENT_ID || !env.DATABRICKS_CLIENT_SECRET) {
    return undefined
  }

  const credentials = btoa(`${env.DATABRICKS_CLIENT_ID}:${env.DATABRICKS_CLIENT_SECRET}`)
  const response = await fetch(env.DATABRICKS_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) return undefined

  const body = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) return undefined

  cachedToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  }
  return cachedToken.value
}

/**
 * Every route resolves the caller the same way before it does anything else.
 * Returning the user id rather than a boolean means a route cannot forget to
 * use it.
 */
export async function authorize(
  request: Request,
  env: IntelligenceEnv,
): Promise<{ userId: string } | Response> {
  if (
    !env.MARGINALIA_SYNC_TOKEN_SHA256 ||
    !digestFromHex(env.MARGINALIA_SYNC_TOKEN_SHA256) ||
    !env.MARGINALIA_TRUSTED_USER_ID
  ) {
    return failure(503, 'sync_not_configured')
  }

  if (env.INTELLIGENCE_RATE_LIMITER) {
    const address = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success } = await env.INTELLIGENCE_RATE_LIMITER.limit({ key: `ip:${address}` })
    if (!success) return failure(429, 'rate_limited')
  }

  const token = bearerToken(request)
  if (!token) return failure(401, 'missing_token')
  if (!(await tokenMatches(token, env.MARGINALIA_SYNC_TOKEN_SHA256))) {
    return failure(401, 'invalid_token')
  }

  const userId = env.MARGINALIA_TRUSTED_USER_ID
  return { userId }
}

/**
 * How this Worker calls the App: one definition, used by the Insights routes
 * and by the MCP server.
 *
 * Written once so a second surface cannot acquire a second set of timeouts,
 * headers, or opinions about what to do when the App is unreachable.
 */
export function appCaller(env: IntelligenceEnv, now: number): UpstreamCaller {
  return async (path, init) => {
    if (!env.DATABRICKS_APP_URL) return new Response(null, { status: 503 })
    const token = await accessToken(env, now)
    if (!token) return new Response(null, { status: 503 })
    return fetch(new URL(path, env.DATABRICKS_APP_URL), {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  }
}

export async function handleIntelligenceRequest(
  request: Request,
  env: IntelligenceEnv,
  options: { upstream?: UpstreamCaller; now?: number } = {},
): Promise<Response> {
  const url = new URL(request.url)
  const route = url.pathname.slice(INTELLIGENCE_PREFIX.length)
  const now = options.now ?? Date.now()

  const authorized = await authorize(request, env)
  if (authorized instanceof Response) return authorized
  const { userId } = authorized

  // Reading intelligence stops when the user is disabled. Deleting does not:
  // disabling is the first thing deletion does, so refusing a disabled user
  // here would leave a failed request with no way to retry, and the status of the
  // deletion permanently unreadable.
  const isDeletion = route === 'delete' || route.startsWith('delete/')
  if (!isDeletion && (await syncDisabled(env, userId))) return failure(423, 'sync_disabled')

  const upstream: UpstreamCaller = options.upstream ?? appCaller(env, now)

  // The user id comes from the server's own secret, never from the path the
  // browser asked for.
  const base = `/api/v1/users/${encodeURIComponent(userId)}`

  if (request.method === 'GET' && route === 'interest-profile') {
    return await proxy(upstream, `${base}/interest-profile`, 'GET')
  }
  if (request.method === 'GET' && route === 'book-engagement') {
    return await proxy(upstream, `${base}/book-engagement`, 'GET')
  }
  if (request.method === 'GET' && route === 'recommendations') {
    return await proxy(upstream, `${base}/recommendations`, 'GET')
  }
  if (request.method === 'GET' && route === 'frontier') {
    return await proxy(upstream, `${base}/frontier`, 'GET')
  }

  if (request.method === 'POST' && route === 'delete') {
    let body: { requestId?: unknown }
    try {
      body = (await request.json()) as { requestId?: unknown }
    } catch {
      return failure(400, 'invalid_body')
    }
    const requestId = body.requestId
    if (typeof requestId !== 'string' || !isUuid(requestId)) {
      return failure(400, 'invalid_request_id')
    }

    // Disabled at the edge before the request is created, so another
    // installation still holding the token stops immediately. If creating the
    // request then fails, sync stays disabled and the same id retries.
    if (env.SYNC_CONTROL) {
      await env.SYNC_CONTROL.put(syncControlKey(userId), SYNC_DISABLED)
    }
    return await proxy(
      upstream,
      `${base}/deletion-requests`,
      'POST',
      JSON.stringify({ requestId }),
    )
  }

  if (request.method === 'GET' && route.startsWith('delete/')) {
    const requestId = route.slice('delete/'.length)
    if (!isUuid(requestId)) return failure(400, 'invalid_request_id')
    return await proxy(upstream, `${base}/deletion-requests/${requestId}`, 'GET')
  }

  return failure(404, 'not_found')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function proxy(
  upstream: UpstreamCaller,
  path: string,
  method: string,
  body?: string,
): Promise<Response> {
  let response: Response
  try {
    response = await upstream(path, { method, body })
  } catch {
    return failure(503, 'intelligence_unavailable')
  }

  // Pass through the statuses a caller can act on, and collapse the rest.
  // Reporting an upstream authorization problem as 401 would tell a browser its
  // own token was wrong, which it was not.
  if (response.status === 404) return failure(404, 'not_found')
  if (response.status === 409) return failure(409, 'already_exists')
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const throttled = failure(429, 'upstream_rate_limited')
    if (retryAfter) throttled.headers.set('retry-after', retryAfter)
    return throttled
  }
  if (!response.ok) return failure(503, 'intelligence_unavailable')

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return failure(503, 'intelligence_unavailable')
  }
  return json(payload, 200)
}
