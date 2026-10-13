/**
 * Same-origin relay for Gutenberg discovery and one-at-a-time EPUB downloads,
 * shared by the Cloudflare Worker and the Vite dev middleware. Written against
 * Web APIs only so both runtimes can use it unchanged.
 *
 * Gutenberg's ebook responses do not consistently expose CORS headers, so the
 * browser cannot reliably read them directly. Keep this endpoint deliberately
 * narrow: it accepts only a search string or a numeric Gutenberg book id (to
 * describe or to download) and never proxies an arbitrary URL. It still streams multi-megabyte files on the
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
  const details = url.searchParams.get('details')?.trim()

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

  if (details) return describeBook(details, fetcher)

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

  return json({ error: 'Provide one of search, details, or book.' }, 400)
}

/**
 * One book's catalog record, so a reader can tell editions that share a title
 * apart before downloading one. Gutenberg answers these as quickly as search.
 */
async function describeBook(id: string, fetcher: typeof fetch): Promise<Response> {
  if (!/^\d{1,8}$/.test(id)) return json({ error: 'Invalid Gutenberg book id.' }, 400)

  const response = await fetchUpstream(fetcher, `${GUTENBERG_URL}/${id}.opds`, {
    headers: { Accept: 'application/atom+xml', 'User-Agent': USER_AGENT },
  })
  if (!response) return json({ error: 'Project Gutenberg took too long to answer.' }, 504)
  if (response.status === 404) return json({ error: `Gutenberg has no book #${id}.` }, 404)
  const feed = response.ok ? await response.text().catch(() => undefined) : undefined
  const book = feed === undefined ? undefined : parseBookFeed(feed, Number(id))
  if (!book) return json({ error: 'Project Gutenberg details are unavailable.' }, 502)

  return Response.json(book, {
    headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600' },
  })
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

interface CatalogPerson {
  /** As Gutenberg labels it: Author, Editor, Translator, Illustrator… */
  role: string
  name: string
  /** Life dates as catalogued, such as `1775-1817`. */
  dates?: string
}

export interface CatalogDetails {
  id: number
  title: string
  alternateTitle?: string
  people: CatalogPerson[]
  summary?: string
  /** Anthologies list their pieces. */
  contents?: string
  notes: string[]
  credits?: string
  /** When Gutenberg released this edition, not when the work was written. */
  released?: string
  /** Downloads in the last 30 days. */
  downloads?: number
  language?: string
  subjects: string[]
  readingLevel?: string
  /** Other Gutenberg ebooks of the same title, as the catalog cross-references them. */
  otherEditions: number[]
}

/**
 * Reads a single-book OPDS feed (`/ebooks/<n>.opds`). Its entry carries an
 * XHTML summary of `Label: value` paragraphs that hold more than the Atom
 * elements do, such as each contributor's role. Returns undefined for a feed
 * that does not describe the requested book.
 */
export function parseBookFeed(feed: string, id: number): CatalogDetails | undefined {
  const entry = feed.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
  if (!entry) return undefined
  const title = decodeXml(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
  const content = entry.match(/<content type="xhtml">([\s\S]*?)<\/content>/)?.[1] ?? ''

  const fields: [string, string][] = []
  for (const [, paragraph] of content.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    // The text between the tags. It is only ever rendered as text, never HTML.
    const text = decodeXml(paragraph.split(/<[^>]*>/).join(''))
    const colon = text.indexOf(': ')
    if (colon > 0) fields.push([text.slice(0, colon), text.slice(colon + 2)])
  }
  if (!title || !fields.some(([label, value]) => label === 'EBook No.' && value === String(id))) {
    return undefined
  }

  // Role paragraphs ("Translator: Maude, Aylmer, 1858-1938") are told apart
  // from other fields by matching the names Atom lists as author or contributor.
  const names = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(([, name]) => decodeXml(name))
  const book: CatalogDetails = {
    id,
    title,
    people: [],
    notes: [],
    subjects: [],
    otherEditions: [],
  }

  for (const [label, value] of fields) {
    // Checked before roles: a subject can name a person ("Johnson, Samuel, 1709-1784").
    if (label === 'Subject') {
      book.subjects.push(value)
      continue
    }
    const person = rolePerson(label, value, names)
    if (person) {
      book.people.push(person)
    } else if (label === 'Note' && /^This title is also available as/.test(value)) {
      for (const [, other] of value.matchAll(/#(\d{1,8})/g)) book.otherEditions.push(Number(other))
    } else if (label === 'Note' && !value.startsWith('Wikipedia page')) {
      book.notes.push(value)
    } else if (Object.hasOwn(TEXT_FIELDS, label)) {
      book[TEXT_FIELDS[label]] = value
    } else if (label === 'Downloads' && /^\d+$/.test(value)) {
      book.downloads = Number(value)
    }
  }
  if (book.readingLevel) book.readingLevel = book.readingLevel.replace(/^Reading ease score: /, '')
  return book
}

/** Catalog labels kept verbatim, by the field they fill. */
const TEXT_FIELDS: Record<
  string,
  'alternateTitle' | 'summary' | 'contents' | 'credits' | 'released' | 'language' | 'readingLevel'
> = {
  'Alternate Title': 'alternateTitle',
  Summary: 'summary',
  Contents: 'contents',
  Credits: 'credits',
  Published: 'released',
  Language: 'language',
  'Reading Level': 'readingLevel',
}

/** A role paragraph holds one catalogued name and, optionally, life dates. */
function rolePerson(role: string, value: string, names: string[]): CatalogPerson | undefined {
  const name = names.find((candidate) => value.startsWith(candidate))
  const dates = name && value.slice(name.length).match(/^(?:,\s*([^,]*\d[^,]*))?$/)
  if (!name || !dates) return undefined
  return { role, name: displayName(name), ...(dates[1] && { dates: dates[1] }) }
}

/**
 * "Austen, Jane" reads as "Jane Austen", and "Tolstoy, Leo, graf" as "Leo
 * Tolstoy, graf". Parenthesized full forms of initials are dropped.
 */
function displayName(catalogued: string): string {
  const [last, first, ...rest] = catalogued
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
    .split(', ')
  return first ? [`${first} ${last}`, ...rest].join(', ') : last
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
