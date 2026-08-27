const GUTENDEX_URL = 'https://gutendex.com/books'
const GUTENBERG_URL = 'https://www.gutenberg.org/ebooks'

export interface GutenbergRelayOptions {
  fetch?: typeof fetch
}

/**
 * Same-origin relay for Gutenberg discovery and one-at-a-time EPUB downloads.
 *
 * Gutenberg's ebook responses do not consistently expose CORS headers, so the
 * browser cannot reliably read them directly. Keep this endpoint deliberately
 * narrow: it accepts only a search string or a numeric Gutenberg book id and
 * never proxies an arbitrary URL.
 */
export async function handleGutenbergRequest(
  request: Request,
  options: GutenbergRelayOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const fetcher = options.fetch ?? fetch
  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim()
  const book = url.searchParams.get('book')?.trim()

  if (search) {
    if (search.length > 200) return json({ error: 'Search is too long.' }, 400)

    const upstream = new URL(GUTENDEX_URL)
    upstream.searchParams.set('search', search)
    upstream.searchParams.set('mime_type', 'application/epub+zip')

    const response = await fetcher(upstream, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return json({ error: 'Project Gutenberg search is unavailable.' }, 502)

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    })
  }

  if (book) {
    if (!/^\d{1,8}$/.test(book)) return json({ error: 'Invalid Gutenberg book id.' }, 400)

    // EPUB3 with images is Gutenberg's current recommended EPUB format. The
    // stable /ebooks/:id format endpoint redirects to the generated file.
    const response = await fetcher(`${GUTENBERG_URL}/${book}.epub3.images`, {
      headers: {
        Accept: 'application/epub+zip, application/octet-stream;q=0.9',
        'User-Agent': 'Marginalia/1.0 (+https://github.com/critesjosh/marginalia)',
      },
      redirect: 'follow',
    })
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
