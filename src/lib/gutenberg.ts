export interface CatalogBook {
  id: number
  title: string
  author: string
  coverUrl: string
}

/** What the relay returns: Gutenberg's OPDS search, already normalized. */
interface SearchResponse {
  results?: { id: number; title: string; author?: string }[]
}

export async function searchGutenberg(
  query: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CatalogBook[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const response = await fetcher(`/api/gutenberg?search=${encodeURIComponent(trimmed)}`, { signal })
  if (!response.ok)
    throw new Error(await relayError(response, 'Could not search Project Gutenberg.'))

  const body = (await response.json()) as SearchResponse
  return (body.results ?? []).map((book) => ({
    id: book.id,
    title: book.title.trim() || `Gutenberg #${book.id}`,
    author: book.author || 'Unknown author',
    // Not every book has one; the dialog falls back when this fails to load.
    coverUrl: `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.cover.medium.jpg`,
  }))
}

export async function downloadGutenbergBook(
  book: { id: number; title?: string },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<File> {
  const response = await fetcher(`/api/gutenberg?book=${book.id}`, { signal })
  if (!response.ok) throw new Error(await relayError(response, 'Could not download that EPUB.'))

  const blob = await response.blob()
  if (blob.size < 4) throw new Error('The downloaded EPUB was empty.')

  return new File([blob], `${safeFilename(book.title ?? '')}.epub`, {
    type: 'application/epub+zip',
  })
}

/**
 * The relay explains a refusal in its JSON body — a throttle, a cross-origin
 * rejection, an upstream timeout. Show that rather than a generic failure, so a
 * reader who is being rate limited can tell why waiting will help.
 */
export async function relayError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === 'string' && body.error ? body.error : fallback
  } catch {
    return fallback
  }
}

function safeFilename(title: string): string {
  const cleaned = title
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 120) || 'project-gutenberg-book'
}

/** Hosts whose URLs carry a Gutenberg book id we can resolve. */
const GUTENBERG_HOSTS = new Set(['gutenberg.org', 'www.gutenberg.org'])

export interface GutenbergRef {
  id: number
  /**
   * How the id was written. A URL is unambiguous, so it goes straight to the
   * book. A bare number is not — "1984" is a book id *and* a title someone
   * might be searching for — so the caller offers both.
   */
  source: 'url' | 'id'
}

/**
 * Reads a Gutenberg book id out of whatever a reader pasted: an ebook page
 * URL, a direct file URL, or the bare number.
 *
 * URLs on other hosts return undefined rather than any id they happen to
 * contain. Quietly treating those as a Gutenberg book would send the reader
 * to a download failure instead of telling them the link is not one we can use.
 */
export function parseGutenbergRef(input: string): GutenbergRef | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  if (/^\d{1,8}$/.test(trimmed)) return { id: Number(trimmed), source: 'id' }

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return undefined
  }
  if (!GUTENBERG_HOSTS.has(url.hostname.toLowerCase())) return undefined

  // /ebooks/2701 and /ebooks/2701.epub3.images, /files/2701/…, and the
  // generated /cache/epub/2701/pg2701.epub all name the same book.
  const match = url.pathname.match(/^\/(?:ebooks|files)\/(\d{1,8})|^\/cache\/epub\/(\d{1,8})/)
  const id = match?.[1] ?? match?.[2]
  return id ? { id: Number(id), source: 'url' } : undefined
}

/**
 * The Gutenberg book an EPUB was built from, read from the `dc:identifier`
 * Gutenberg writes into every file it generates ("http://www.gutenberg.org/2701").
 * Undefined for any other identifier, such as an ISBN or a UUID.
 */
export function gutenbergIdFromIdentifier(identifier: string | undefined): number | undefined {
  const match = identifier
    ?.trim()
    .match(/^https?:\/\/(?:www\.)?gutenberg\.org\/(?:ebooks\/)?(\d{1,8})\/?$/i)
  return match ? Number(match[1]) : undefined
}
