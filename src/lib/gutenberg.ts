export interface CatalogBook {
  id: number
  title: string
  author: string
  languages: string[]
  coverUrl?: string
  downloadCount: number
}

interface GutendexPerson {
  name: string
}

interface GutendexBook {
  id: number
  title: string
  authors?: GutendexPerson[]
  languages?: string[]
  formats?: Record<string, string>
  download_count?: number
}

interface GutendexResponse {
  results?: GutendexBook[]
}

export async function searchGutenberg(
  query: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CatalogBook[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const response = await fetcher(`/api/gutenberg?search=${encodeURIComponent(trimmed)}`, { signal })
  if (!response.ok) throw new Error(await relayError(response, 'Could not search Project Gutenberg.'))

  const body = (await response.json()) as GutendexResponse
  return (body.results ?? []).map((book) => ({
    id: book.id,
    title: book.title?.trim() || `Gutenberg #${book.id}`,
    author: book.authors?.map((author) => author.name).filter(Boolean).join(', ') || 'Unknown author',
    languages: book.languages ?? [],
    coverUrl: book.formats?.['image/jpeg'],
    downloadCount: book.download_count ?? 0,
  }))
}

export async function downloadGutenbergBook(
  book: CatalogBook,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<File> {
  const response = await fetcher(`/api/gutenberg?book=${book.id}`, { signal })
  if (!response.ok) throw new Error(await relayError(response, 'Could not download that EPUB.'))

  const blob = await response.blob()
  if (blob.size < 4) throw new Error('The downloaded EPUB was empty.')

  return new File([blob], `${safeFilename(book.title)}.epub`, {
    type: 'application/epub+zip',
  })
}

/**
 * The relay explains a refusal in its JSON body — a throttle, a cross-origin
 * rejection, an upstream timeout. Show that rather than a generic failure, so a
 * reader who is being rate limited can tell why waiting will help.
 */
async function relayError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === 'string' && body.error ? body.error : fallback
  } catch {
    return fallback
  }
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 120) || 'project-gutenberg-book'
}
