/**
 * Same-origin relay for Gutenberg discovery and one-at-a-time EPUB downloads,
 * shared by the Cloudflare Worker and the Vite dev middleware. Written against
 * Web APIs only so both runtimes can use it unchanged.
 *
 * Gutenberg's ebook responses do not consistently expose CORS headers, so the
 * browser cannot reliably read them directly. Keep this endpoint deliberately
 * narrow: it accepts only a search string or a numeric Gutenberg book id and
 * never proxies an arbitrary URL. It still streams multi-megabyte files on the
 * site's bandwidth, so it carries the same origin check and per-IP throttle as
 * the chat relay next door.
 */

import { createRateLimiter, fetchUpstream, isCrossOrigin, json } from './http-guards.ts'

const GUTENBERG_URL = 'https://www.gutenberg.org/ebooks'
const USER_AGENT = 'Rami/1.0 (+https://github.com/critesjosh/marginalia)'

/**
 * Best-effort per-IP throttle, separate from the chat relay's so that searching
 * the catalog never spends the budget for asking a question. Search is debounced
 * client-side, so a reader browsing normally stays far below this.
 */
const rateLimited = createRateLimiter({ windowMs: 5 * 60_000, maxRequests: 60 })

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

    // Gutenberg's own OPDS search, not Gutendex: it answers in a few hundred
    // milliseconds where Gutendex ranges from seconds to well past the upstream
    // budget, and it is the host the download already depends on.
    const upstream = new URL(`${GUTENBERG_URL}/search.opds/`)
    upstream.searchParams.set('query', search)

    const response = await fetchUpstream(fetcher, upstream, {
      headers: { Accept: 'application/atom+xml', 'User-Agent': USER_AGENT },
    })
    // Distinct from the 502 below: a reader who timed out should retry, and a
    // reader whose upstream refused should not be told to wait it out.
    if (!response) return json({ error: 'Project Gutenberg took too long to answer.' }, 504)
    const feed = response.ok ? await response.text().catch(() => undefined) : undefined
    if (feed === undefined) return json({ error: 'Project Gutenberg search is unavailable.' }, 502)

    return Response.json(
      { results: parseSearchFeed(feed) },
      // Browsers reuse an answer for five minutes; the Worker's edge cache keeps
      // it for an hour, since the catalog barely moves.
      { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } },
    )
  }

  if (book) {
    if (!/^\d{1,8}$/.test(book)) return json({ error: 'Invalid Gutenberg book id.' }, 400)

    // EPUB3 with images is Gutenberg's current recommended EPUB format. The
    // stable /ebooks/:id format endpoint redirects to the generated file.
    const response = await fetchUpstream(fetcher, `${GUTENBERG_URL}/${book}.epub3.images`, {
      headers: {
        Accept: 'application/epub+zip, application/octet-stream;q=0.9',
        'User-Agent': USER_AGENT,
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

export interface CatalogResult {
  id: number
  title: string
  /** Absent for anthologies, where Gutenberg shows a download count instead. */
  author?: string
}

/**
 * Pulls book entries out of a Gutenberg OPDS search feed. Workers have no XML
 * parser, but this feed is machine-generated and flat: book entries are the
 * ones whose id names `/ebooks/<n>.opds`, and the rest (author and subject
 * links) are skipped.
 */
export function parseSearchFeed(feed: string): CatalogResult[] {
  const results: CatalogResult[] = []
  for (const [, entry] of feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = entry.match(/<id>[^<]*\/ebooks\/(\d{1,8})\.opds<\/id>/)?.[1]
    const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
    if (!id || !title) continue

    const content = decodeXml(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '')
    const author = content && !/^\d[\d,]* downloads?$/.test(content) ? content : undefined
    results.push({ id: Number(id), title, ...(author && { author }) })
  }
  return results
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXml(text: string): string {
  return text
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (match, dec, hex, name) => {
      if (!dec && !hex) return XML_ENTITIES[name] ?? match
      const code = dec ? Number(dec) : parseInt(hex, 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(/\s+/g, ' ')
    .trim()
}
