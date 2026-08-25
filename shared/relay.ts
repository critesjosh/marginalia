/**
 * Inference relay shared by the Netlify edge function (production) and the Vite
 * dev middleware (local). Written against Web APIs only so both runtimes can use
 * it unchanged, and so the OpenRouter key never reaches the browser.
 *
 * The model and provider routing are pinned here rather than taken from the
 * request: this endpoint is open to every visitor, so the client gets to choose
 * only the conversation, never what it costs to answer it.
 */

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

interface Route {
  model: string
  /** OpenRouter provider slugs, most preferred first. */
  order: string[]
  /** Whether OpenRouter may route outside `order` if those providers fail. */
  allowFallbacks: boolean
}

/**
 * The only route. Cloudflare is first because it is the fastest endpoint for
 * this model, and other providers are allowed so that one provider's outage
 * does not become the site's outage.
 *
 * A free-tier route ran ahead of this one, served by Google AI Studio. It drew
 * on a shared upstream pool that was regularly exhausted, so most requests paid
 * a refused round-trip before arriving here anyway, and the ones it did answer
 * came from the slower endpoint.
 */
const ROUTE: Route = {
  model: 'google/gemma-4-26b-a4b-it',
  order: ['cloudflare'],
  allowFallbacks: true,
}

/** Caps on what one request may ask for, since anyone can call this endpoint. */
const MAX_MESSAGES = 60
const MAX_TOTAL_CHARS = 120_000
const MAX_OUTPUT_TOKENS = 1500

/** Best-effort per-IP throttle. See `rateLimited` for what this does not cover. */
const WINDOW_MS = 5 * 60_000
const MAX_REQUESTS_PER_WINDOW = 40

/**
 * How long the upstream attempt may spend waiting for response headers. The
 * platform gives an edge function a bounded window to start responding and
 * turns an overrun into an opaque 502. Only time-to-headers is covered — once a
 * streaming reply has begun, it runs to its own end.
 */
const UPSTREAM_BUDGET_MS = 30_000

/** Shown when the route did not answer and did not say why. */
const UNAVAILABLE = 'The model provider is unavailable right now.'

export interface RelayOptions {
  apiKey: string
  /** Sent to OpenRouter as HTTP-Referer, which it uses for app attribution. */
  siteUrl?: string
}

export interface RelayRequestContext {
  /** Client address, used for throttling. Empty string disables the throttle. */
  ip: string
}

export async function handleRelayRequest(
  request: Request,
  { apiKey, siteUrl }: RelayOptions,
  { ip }: RelayRequestContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'Use POST.')
  }
  if (!apiKey) {
    return errorResponse(503, 'This deployment has no inference key configured.')
  }
  if (isCrossOrigin(request)) {
    return errorResponse(403, 'Cross-origin requests are not allowed.')
  }
  if (rateLimited(ip)) {
    return errorResponse(429, 'Too many requests from this address. Wait a minute and retry.')
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return errorResponse(400, 'Expected a JSON body.')
  }

  const parsed = parseBody(payload)
  if ('error' in parsed) return errorResponse(400, parsed.error)
  const { messages, stream } = parsed

  const upstream = await callOpenRouter(ROUTE, messages, stream, apiKey, siteUrl)
  if (upstream.ok) return relayResponse(upstream)

  return errorResponse(
    upstream.status,
    upstreamMessage(await upstream.text().catch(() => '')) || UNAVAILABLE,
  )
}

/**
 * Calls OpenRouter and always resolves, so a refusal stays a value the handler
 * can turn into a JSON error. An unreachable provider rejects `fetch`, and an
 * escaping rejection is what the platform turns into a bare 502 with no JSON
 * body — the reader sees "the chat request failed (502)" instead of what went
 * wrong.
 */
async function callOpenRouter(
  route: Route,
  messages: RelayMessage[],
  stream: boolean,
  apiKey: string,
  siteUrl: string | undefined,
): Promise<Response> {
  // Cleared as soon as the headers land, so the timeout bounds how long the
  // provider may think, not how long its answer may be.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_BUDGET_MS)

  try {
    return await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(siteUrl ? { 'HTTP-Referer': siteUrl } : {}),
        'X-Title': 'Marginalia',
      },
      body: JSON.stringify({
        model: route.model,
        messages,
        stream,
        max_tokens: MAX_OUTPUT_TOKENS,
        provider: { order: route.order, allow_fallbacks: route.allowFallbacks },
      }),
      signal: controller.signal,
    })
  } catch {
    return controller.signal.aborted
      ? errorResponse(504, 'The model provider took too long to respond. Try again.')
      : errorResponse(502, 'Could not reach the model provider. Try again in a moment.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Hands the upstream body straight back. The body is not read here so the
 * platform can stream it through without buffering.
 */
function relayResponse(upstream: Response): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  const contentType = upstream.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  return new Response(upstream.body, { status: 200, headers })
}

export interface RelayMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type ParsedBody = { messages: RelayMessage[]; stream: boolean } | { error: string }

function parseBody(payload: unknown): ParsedBody {
  if (typeof payload !== 'object' || payload === null) return { error: 'Expected a JSON object.' }
  const { messages, stream } = payload as { messages?: unknown; stream?: unknown }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Expected a non-empty `messages` array.' }
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: `Too many messages (limit ${MAX_MESSAGES}).` }
  }

  const clean: RelayMessage[] = []
  let chars = 0
  for (const message of messages) {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: 'Each message needs a role of system, user or assistant.' }
    }
    if (typeof content !== 'string') {
      return { error: 'Each message needs string content.' }
    }
    chars += content.length
    if (chars > MAX_TOTAL_CHARS) {
      return { error: `Conversation is too long (limit ${MAX_TOTAL_CHARS} characters).` }
    }
    clean.push({ role, content })
  }

  return { messages: clean, stream: stream === true }
}

/**
 * Rejects requests whose Origin is not this site. A determined caller can forge
 * the header, so this only stops casual reuse of the endpoint from other pages;
 * the spend ceiling is the credit limit on the OpenRouter key itself.
 *
 * A request with no Origin at all passes, and that is deliberate rather than an
 * oversight: browsers always send one on a cross-origin request, while a
 * non-browser client sends none. The KOReader plugin in `koreader/` is one such
 * client, and asking a question from an e-reader goes through this endpoint.
 * Those requests identify themselves with `X-Marginalia-Client` if they ever
 * need throttling separately.
 */
function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host !== new URL(request.url).host
  } catch {
    return true
  }
}

const hits = new Map<string, number[]>()

/**
 * Sliding window kept in isolate memory. Edge isolates are per-region and
 * short-lived, so this trims obvious hammering rather than enforcing a global
 * quota — treat it as a speed bump, not a budget.
 */
function rateLimited(ip: string): boolean {
  if (!ip) return false
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)

  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(key)
    }
  }

  return recent.length > MAX_REQUESTS_PER_WINDOW
}

/** Pulls OpenRouter's own message out of an error body, if it sent one. */
function upstreamMessage(body: string): string {
  try {
    return JSON.parse(body)?.error?.message ?? ''
  } catch {
    return ''
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
