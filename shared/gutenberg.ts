/**
 * Same-origin relay for Gutenberg discovery and one-at-a-time EPUB downloads,
 * shared by the Netlify edge function, the Cloudflare Worker and the Vite dev
 * middleware. Written against Web APIs only so all three runtimes can use it
 * unchanged.
 *
 * Gutenberg's ebook responses do not consistently expose CORS headers, so the
 * browser cannot reliably read them directly. Keep this endpoint deliberately
 * narrow: it accepts only a search string or a numeric Gutenberg book id and
 * never proxies an arbitrary URL. It still streams multi-megabyte files on the
 * site's bandwidth, so it carries the same origin check and per-IP throttle as
 * the chat relay next door.
 */

import { createRateLimiter, isCrossOrigin } from './http-guards.ts'

const GUTENDEX_URL = 'https://gutendex.com/books'
const GUTENBERG_URL = 'https://www.gutenberg.org/ebooks'

/**
 * Best-effort per-IP throttle, separate from the chat relay's so that searching
 * the catalog never spends the budget for asking a question. Search is debounced
 * client-side, so a reader browsing normally stays far below this.
 */
const rateLimited = createRateLimiter({ windowMs: 5 * 60_000, maxRequests: 60 })

/**
 * How long an upstream attempt may spend waiting for response headers. Cleared
 * as soon as they land, so this bounds how long Gutenberg may take to start a
 * download, not how long the download itself may run. Without it a stalled
 * upstream burns the whole edge-function time budget and the platform answers
 * with an opaque 502 instead of the JSON error the client knows how to show.
 */
const UPSTREAM_BUDGET_MS = 20_000

export interface GutenbergRelayOptions {
  fetch?: typeof fetch
  /** Client address, used for throttling. Empty string disables the throttle. */
  ip?: string
}

export async function handleGutenbergRequest(
  request: Request,
  options: GutenbergRelayOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405)
  if (isCrossOrigin(request)) return json({ error: 'Cross-origin requests are not allowed.' }, 403)
  if (rateLimited(options.ip ?? '')) {
    return json({ error: 'Too many requests from this address. Wait a minute and retry.' }, 429)
  }

  const fetcher = options.fetch ?? fetch
  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim()
  const book = url.searchParams.get('book')?.trim()

  if (search) {
    if (search.length > 200) return json({ error: 'Search is too long.' }, 400)

    // Deliberately no `mime_type` filter. Gutendex matches that against each
    // book's formats blob rather than an index, and paying for it on top of a
    // full-text search is slow enough to push some queries past the budget
    // below — while excluding almost nothing, since nearly every Gutenberg
    // book has an EPUB. The client drops the few results that lack one.
    const upstream = new URL(GUTENDEX_URL)
    upstream.searchParams.set('search', search)

    const response = await fetchUpstream(fetcher, upstream, {
      headers: { Accept: 'application/json' },
    })
    // Distinct from the 502 below: a reader who timed out should retry, and a
    // reader whose upstream refused should not be told to wait it out.
    if (!response) return json({ error: 'Project Gutenberg took too long to answer.' }, 504)
    if (!response.ok) return json({ error: 'Project Gutenberg search is unavailable.' }, 502)

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        // The browser directive above only spares the reader who repeats their
        // own search. Gutendex is slow enough that nobody should reach it for a
        // query someone already ran, and the catalog barely moves, so the CDN
        // holds answers for an hour and serves stale ones for a day while it
        // refreshes. Netlify reads this header; other platforms ignore it.
        'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  }

  if (book) {
    if (!/^\d{1,8}$/.test(book)) return json({ error: 'Invalid Gutenberg book id.' }, 400)

    // EPUB3 with images is Gutenberg's current recommended EPUB format. The
    // stable /ebooks/:id format endpoint redirects to the generated file.
    const response = await fetchUpstream(fetcher, `${GUTENBERG_URL}/${book}.epub3.images`, {
      headers: {
        Accept: 'application/epub+zip, application/octet-stream;q=0.9',
        'User-Agent': 'Marginalia/1.0 (+https://github.com/critesjosh/marginalia)',
      },
      redirect: 'follow',
    })
    if (!response) return json({ error: 'That EPUB took too long to download.' }, 504)
    if (!response.ok || !response.body) {
      return json({ error: 'That EPUB could not be downloaded.' }, 502)
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/epub+zip',
        'Content-Disposition': `attachment; filename="gutenberg-${book}.epub"`,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  }

  return json({ error: 'Provide either search or book.' }, 400)
}

/**
 * Fetches upstream under a deadline and never rejects, so an unreachable host
 * stays a value this handler can turn into a JSON error. An escaping rejection
 * is what the platform turns into a bare 502 — and in dev it leaves the Vite
 * middleware with no response to write, so the request simply hangs.
 *
 * Returns `undefined` when the attempt failed or timed out.
 */
async function fetchUpstream(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
): Promise<Response | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_BUDGET_MS)

  try {
    return await fetcher(input, { ...init, signal: controller.signal })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
