/**
 * Same-origin relay for finding replacement book covers on Open Library,
 * shared by the Cloudflare Worker and the Vite dev middleware. Written against
 * Web APIs only so both runtimes can use it unchanged.
 *
 * The browser has to read the image bytes to store a cover in IndexedDB, and
 * the CSP only lets it fetch this origin. Like the Gutenberg relay this stays
 * narrow: it accepts a title and author to search, or a numeric Open Library
 * cover id to download, and never proxies an arbitrary URL. Thumbnails load
 * through it too, so a reader browsing covers only ever talks to this site.
 */

import { createRateLimiter, fetchUpstream, isCrossOrigin, json } from './http-guards.ts'

const SEARCH_URL = 'https://openlibrary.org/search.json'
const COVERS_URL = 'https://covers.openlibrary.org/b/id'
const USER_AGENT = 'Rami/1.0 (+https://github.com/critesjosh/marginalia)'

/** How many candidates one search offers. A grid of covers, not a catalog. */
const MAX_RESULTS = 8

/** Open Library's large covers run to a few hundred KB; anything far past that is not one. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** SVG is left out on purpose: it is a document, not a picture, and it can carry script. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Its own throttle, so browsing covers never spends the budget for searching
 * Gutenberg or asking a question. Opening the picker costs one search plus up
 * to eight thumbnails, so this allows a reader to browse a dozen books' worth.
 */
const rateLimited = createRateLimiter({ windowMs: 5 * 60_000, maxRequests: 150 })

export interface CoverRelayOptions {
  fetch?: typeof fetch
  /** Client address, used for throttling. Empty string disables the throttle. */
  ip?: string
}

export interface CoverResult {
  /** Open Library cover id, what `?id=` takes. */
  id: number
  title: string
  author?: string
  year?: number
}

export async function handleCoverRequest(
  request: Request,
  options: CoverRelayOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405)
  if (isCrossOrigin(request)) return json({ error: 'Cross-origin requests are not allowed.' }, 403)
  if (rateLimited(options.ip ?? '')) {
    return json({ error: 'Too many requests from this address. Wait a minute and retry.' }, 429)
  }

  const fetcher = options.fetch ?? fetch
  const url = new URL(request.url)
  const title = url.searchParams.get('title')?.trim()
  const author = url.searchParams.get('author')?.trim()
  const id = url.searchParams.get('id')?.trim()

  if (title) {
    if (title.length > 200 || (author?.length ?? 0) > 200) {
      return json({ error: 'Search is too long.' }, 400)
    }
    return searchCovers(fetcher, title, author)
  }

  if (id) {
    if (!/^\d{1,10}$/.test(id)) return json({ error: 'Invalid cover id.' }, 400)
    const size = url.searchParams.get('size') ?? 'L'
    if (size !== 'M' && size !== 'L') return json({ error: 'Size must be M or L.' }, 400)
    return downloadCover(fetcher, id, size)
  }

  return json({ error: 'Provide either title or id.' }, 400)
}

async function searchCovers(
  fetcher: typeof fetch,
  title: string,
  author: string | undefined,
): Promise<Response> {
  // Metadata is often rough ("Moby Dick; Or, The Whale", "Melville, Herman"),
  // and a strict author match can miss every edition. Widen to the title alone
  // before telling the reader there is nothing.
  let results = await searchOpenLibrary(fetcher, title, author)
  if (results && results.length === 0 && author) {
    results = await searchOpenLibrary(fetcher, title)
  }
  if (!results) return json({ error: 'Open Library is unavailable. Try again shortly.' }, 502)

  return Response.json(
    { results },
    { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400' } },
  )
}

/** Returns `undefined` when upstream failed, an empty list when it found nothing. */
async function searchOpenLibrary(
  fetcher: typeof fetch,
  title: string,
  author?: string,
): Promise<CoverResult[] | undefined> {
  const upstream = new URL(SEARCH_URL)
  upstream.searchParams.set('title', title)
  if (author) upstream.searchParams.set('author', author)
  upstream.searchParams.set('fields', 'title,author_name,cover_i,first_publish_year')
  upstream.searchParams.set('limit', '20')

  const response = await fetchUpstream(fetcher, upstream, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
  })
  if (!response?.ok) return undefined
  const body: unknown = await response.json().catch(() => undefined)
  if (!body || typeof body !== 'object') return undefined
  return parseSearchResults(body)
}

/**
 * Keeps works that have a cover, once per cover. Popular books list the same
 * edition's art under several works, and a grid of identical tiles is noise.
 */
export function parseSearchResults(body: object): CoverResult[] {
  const docs = (body as { docs?: unknown }).docs
  if (!Array.isArray(docs)) return []

  const seen = new Set<number>()
  const results: CoverResult[] = []
  for (const doc of docs as Record<string, unknown>[]) {
    const id = doc?.cover_i
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)

    const author = Array.isArray(doc.author_name) ? doc.author_name[0] : undefined
    const year = doc.first_publish_year
    results.push({
      id,
      title: typeof doc.title === 'string' ? doc.title : '',
      ...(typeof author === 'string' && { author }),
      ...(typeof year === 'number' && { year }),
    })
    if (results.length === MAX_RESULTS) break
  }
  return results
}

async function downloadCover(fetcher: typeof fetch, id: string, size: 'M' | 'L') {
  // Without `default=false` a missing cover answers 200 with a blank placeholder.
  const response = await fetchUpstream(fetcher, `${COVERS_URL}/${id}-${size}.jpg?default=false`, {
    headers: { Accept: 'image/*', 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!response) return json({ error: 'That cover took too long to download.' }, 504)
  if (response.status === 404) return json({ error: 'That cover is not available.' }, 404)

  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (!response.ok || !IMAGE_TYPES.has(type) || declared > MAX_IMAGE_BYTES) {
    return json({ error: 'That cover could not be downloaded.' }, 502)
  }

  // Buffered rather than streamed so the cap holds when upstream omits a length.
  const bytes = await readCapped(response, MAX_IMAGE_BYTES)
  if (!bytes || bytes.byteLength === 0) {
    return json({ error: 'That cover could not be downloaded.' }, 502)
  }

  return new Response(bytes, {
    headers: {
      'Content-Type': type,
      // A cover id always names the same image.
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * Reads a body up to `limit` bytes and gives up the moment it passes it, so an
 * oversized image never sits whole in the Worker's memory. Returns `undefined`
 * past the limit or when the read fails.
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        void reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }

  const bytes = new Uint8Array(new ArrayBuffer(total))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
