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

/** Free tier, served by Google AI Studio. Costs nothing and is the usual path. */
const PRIMARY: Route = {
  model: 'google/gemma-4-26b-a4b-it:free',
  order: ['google-ai-studio'],
  allowFallbacks: false,
}

/**
 * Paid tier, used only when the free tier is exhausted or unavailable.
 * Cloudflare is first because it is the fastest endpoint for this model.
 */
const FALLBACK: Route = {
  model: 'google/gemma-4-26b-a4b-it',
  order: ['cloudflare'],
  allowFallbacks: true,
}

/**
 * Lets the model look things up mid-answer.
 *
 * This is an OpenRouter server tool: the model asks for a search, OpenRouter
 * runs it and feeds the results back, and the finished reply arrives here with
 * `url_citation` annotations attached. Nothing in this file issues a query, so
 * there is no second search key to provision — the OpenRouter key pays for it.
 *
 * Searches are billed per result, which is the whole reason `max_results` is
 * small and the tool is offered on so few requests.
 */
const WEB_SEARCH_TOOL = { type: 'openrouter:web_search', parameters: { max_results: 3 } }

/** Caps on what one request may ask for, since anyone can call this endpoint. */
const MAX_MESSAGES = 60
const MAX_TOTAL_CHARS = 120_000
const MAX_OUTPUT_TOKENS = 1500

/** Best-effort per-IP throttle. See `rateLimited` for what this does not cover. */
const WINDOW_MS = 5 * 60_000
const MAX_REQUESTS_PER_WINDOW = 40

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

  // Offered on streamed turns only, which are the ones a reader is waiting on.
  // The background digest calls arrive here non-streamed, and re-summarising a
  // conversation that already happened never needs the live web — enabling it
  // there would buy nothing and bill for every reply in the app.
  const search = stream && !searchCoolingOff()

  let detail = ''
  if (!freeTierCoolingOff()) {
    const primary = await callRoute(PRIMARY, messages, stream, apiKey, siteUrl, search)
    if (primary.ok) return relayResponse(primary)

    // The free tier shares an upstream pool that is regularly exhausted. Note
    // that and stop trying for a while, so later readers do not each pay the
    // latency of a request that is going to be refused.
    if (primary.status === 429) coolOffFreeTier()
    detail = await primary.text().catch(() => '')
  }

  // Fall back to the paid model rather than surfacing the outage to the reader.
  // The cooldown is re-read rather than reusing `search`: the primary route may
  // have just discovered that the tool is refused, and asking again here would
  // spend another round trip learning it twice in one reply.
  const fallback = await callRoute(
    FALLBACK,
    messages,
    stream,
    apiKey,
    siteUrl,
    search && !searchCoolingOff(),
  )
  if (fallback.ok) return relayResponse(fallback)

  return errorResponse(
    fallback.status,
    upstreamMessage(await fallback.text().catch(() => '')) ||
      upstreamMessage(detail) ||
      'The model provider is unavailable right now.',
  )
}

/**
 * Calls one route, retrying without web search if the tool was what upstream
 * objected to rather than the conversation.
 *
 * Tool support belongs to the provider serving the model, not the model name, so
 * the paid route's `allow_fallbacks` can land the same request somewhere that
 * refuses tools. Losing the reply over an enhancement would be the wrong trade:
 * an answer without a lookup beats an error. Callers still get an unread body on
 * failure, so they can pull the upstream message out of it as before.
 */
async function callRoute(
  route: Route,
  messages: RelayMessage[],
  stream: boolean,
  apiKey: string,
  siteUrl: string | undefined,
  search: boolean,
): Promise<Response> {
  const response = await callOpenRouter(route, messages, stream, apiKey, siteUrl, search)
  if (response.ok || !search) return response

  const detail = await response.text().catch(() => '')
  if (!rejectedTools(detail)) {
    return new Response(detail, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
    })
  }

  // Both routes run the same model, so one flag covers them. Stop asking for a
  // while: without it every reader pays this extra round trip to be told the
  // same thing.
  coolOffSearch()
  return callOpenRouter(route, messages, stream, apiKey, siteUrl, false)
}

/**
 * Whether an upstream refusal was about the tool rather than the request.
 *
 * Matched on the message because OpenRouter reports it as an ordinary 404 or
 * 400; there is no distinct code to key off. Anything unrecognised is treated as
 * a real failure and surfaced, so a genuine outage is never retried into silence.
 */
function rejectedTools(body: string): boolean {
  const message = (upstreamMessage(body) || body).toLowerCase()

  // Routing that has been narrowed to nothing is reported without naming what
  // narrowed it: "no allowed providers are available" never says "tool". Since
  // this is only reached on a request that carried the tool, read it as the
  // tool. Being wrong costs one retry, whose own failure is still surfaced.
  if (message.includes('no endpoints') || message.includes('no allowed providers')) return true

  return (
    message.includes('tool') &&
    (message.includes('not support') || message.includes('unsupported'))
  )
}

function callOpenRouter(
  route: Route,
  messages: RelayMessage[],
  stream: boolean,
  apiKey: string,
  siteUrl: string | undefined,
  search: boolean,
): Promise<Response> {
  return fetch(OPENROUTER_ENDPOINT, {
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
      ...(search ? { tools: [WEB_SEARCH_TOOL] } : {}),
    }),
  })
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

/** How long to skip the free model after it reports being rate limited. */
const FREE_TIER_COOLDOWN_MS = 60_000
let freeTierBlockedUntil = 0

function freeTierCoolingOff(): boolean {
  return Date.now() < freeTierBlockedUntil
}

function coolOffFreeTier(): void {
  freeTierBlockedUntil = Date.now() + FREE_TIER_COOLDOWN_MS
}

/**
 * How long to stop offering web search after upstream refuses the tool.
 *
 * Longer than the free-tier cooldown because this tracks a capability rather
 * than a quota: when the answer is no it stays no until routing changes, and one
 * wasted request every ten minutes is the price of noticing that it has.
 */
const SEARCH_COOLDOWN_MS = 10 * 60_000
let searchBlockedUntil = 0

function searchCoolingOff(): boolean {
  return Date.now() < searchBlockedUntil
}

function coolOffSearch(): void {
  searchBlockedUntil = Date.now() + SEARCH_COOLDOWN_MS
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
