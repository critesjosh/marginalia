/**
 * Request guards shared by the relays in this directory. Both endpoints are
 * open to every visitor and both spend something the site pays for — inference
 * credit for `/api/chat`, bandwidth for `/api/gutenberg` — so both need the
 * same speed bumps. Written against Web APIs only, like the relays themselves.
 */

/**
 * Rejects requests whose Origin is not this site. A determined caller can forge
 * the header, so this only stops casual reuse of the endpoint from other pages.
 *
 * A request with no Origin at all passes, and that is deliberate rather than an
 * oversight: browsers always send one on a cross-origin request, while a
 * non-browser client sends none. The KOReader plugin in `koreader/` is one such
 * client, and asking a question from an e-reader goes through the chat relay.
 * Those requests identify themselves with `X-Marginalia-Client` if they ever
 * need throttling separately.
 */
export function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host !== new URL(request.url).host
  } catch {
    return true
  }
}

export interface RateLimit {
  windowMs: number
  maxRequests: number
}

/**
 * Sliding window kept in isolate memory. Edge isolates are per-region and
 * short-lived, so this trims obvious hammering rather than enforcing a global
 * quota — treat it as a speed bump, not a budget.
 *
 * Each endpoint gets its own limiter, so a reader searching Gutenberg never
 * spends the budget for asking a question.
 */
export function createRateLimiter({ windowMs, maxRequests }: RateLimit): (ip: string) => boolean {
  const hits = new Map<string, number[]>()

  return function rateLimited(ip: string): boolean {
    if (!ip) return false
    const now = Date.now()
    const recent = (hits.get(ip) ?? []).filter((at) => now - at < windowMs)
    recent.push(now)
    hits.set(ip, recent)

    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (times.every((at) => now - at >= windowMs)) hits.delete(key)
      }
    }

    return recent.length > maxRequests
  }
}
