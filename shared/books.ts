/**
 * Shared book links: an invitation to read a Project Gutenberg book, published
 * at `/b/<id>` with the sharer's cover as its preview image. Opening one adds
 * the book from Gutenberg; nothing of the sharer's copy is stored. See
 * `docs/decisions/0007-shared-book-links.md`.
 *
 * Runs in the app Worker (Workers KV) and the Vite dev server (an in-memory
 * map), so it is written against Web APIs only.
 */

import { createRateLimiter, isCrossOrigin, json } from './http-guards.ts'
import {
  authorizeOwner,
  canPublish,
  errorResponse,
  expiresAt,
  ID_PATTERN,
  isRecord,
  isText,
  LINK_TTL_SECONDS,
  type LinkStore,
  newLink,
  now,
  type PublishOptions,
  type PublishRequestContext,
  verifyTurnstile,
} from './publishing.ts'
import { boundedText } from './resilience.ts'
import { operationMetric } from './telemetry.ts'
import { escape } from './threadPage.ts'

/** Shares the threads namespace; the prefix keeps the two apart. */
const KEY_PREFIX = 'book:'

/** The PWA sends a downscaled JPEG well under this; anything larger is not one. */
const MAX_COVER_BYTES = 256 * 1024
const MAX_BODY_BYTES = 400 * 1024
const MAX_LABEL_CHARS = 300
const MAX_GUTENBERG_ID = 99_999_999

const APP_NAME = 'Rami'

/** Its own budget, so sharing books never spends the one for threads. */
const rateLimited = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 10 })

interface BookCard {
  title: string
  author: string
  gutenbergId: number
}

export interface StoredBookLink {
  book: BookCard
  /** Base64 JPEG. Absent when the book had no cover to send. */
  cover?: string
  /** SHA-256 of the owner token, hex. The token itself is never stored. */
  ownerHash: string
  publishedAt: number
}

export async function handleBooksRequest(
  request: Request,
  options: PublishOptions,
  context: PublishRequestContext,
): Promise<Response> {
  const started = performance.now()
  const response = await route(request, options, context)
  console.info(
    JSON.stringify(operationMetric('books', response.status, performance.now() - started)),
  )
  return response
}

/** Reads a book link, or `null` when it is gone. */
export async function loadBookLink(
  store: LinkStore | undefined,
  id: string,
): Promise<StoredBookLink | null> {
  if (!store || !ID_PATTERN.test(id)) return null
  const raw = await store.get(KEY_PREFIX + id)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredBookLink
  } catch {
    return null
  }
}

async function route(
  request: Request,
  options: PublishOptions,
  { ip }: PublishRequestContext,
): Promise<Response> {
  const { store } = options
  if (!store) return errorResponse(503, 'Sharing books is not available on this deployment.')
  if (isCrossOrigin(request)) return errorResponse(403, 'Cross-origin requests are not allowed.')

  const id = new URL(request.url).pathname.replace(/^\/api\/books\/?/, '')
  if (!id) {
    if (request.method !== 'POST') return errorResponse(405, 'Use POST.')
    if (!canPublish(options)) {
      return errorResponse(503, 'Sharing books is not available on this deployment.')
    }
    return create(request, options, store, ip)
  }
  if (!ID_PATTERN.test(id)) return errorResponse(404, 'No such link.')
  // Reading and removing keep working while publishing is switched off.
  if (request.method === 'GET') return read(store, id)
  if (request.method === 'DELETE') return remove(request, store, id)
  if (request.method === 'PUT') {
    if (!canPublish(options)) {
      return errorResponse(503, 'Sharing books is not available on this deployment.')
    }
    return update(request, options, store, id, ip)
  }
  return errorResponse(405, 'Use GET, PUT or DELETE.')
}

async function create(
  request: Request,
  options: PublishOptions,
  store: LinkStore,
  ip: string,
): Promise<Response> {
  if (rateLimited(ip)) return errorResponse(429, 'Too many links shared. Try again later.')

  const body = await readBody(request)
  if ('error' in body) return errorResponse(400, body.error)

  const human = await verifyTurnstile(options, body.turnstileToken, ip)
  if (!human) return errorResponse(403, 'The verification check did not pass. Try again.')

  const { id, ownerToken, ownerHash } = await newLink()
  const publishedAt = now(options)
  await save(store, id, { book: body.book, cover: body.cover, ownerHash, publishedAt })
  return json({ id, url: linkUrl(request, id), ownerToken, expiresAt: expiresAt(publishedAt) }, 201)
}

async function update(
  request: Request,
  options: PublishOptions,
  store: LinkStore,
  id: string,
  ip: string,
): Promise<Response> {
  if (rateLimited(ip)) return errorResponse(429, 'Too many updates. Try again later.')

  const existing = await authorize(request, store, id)
  if (existing instanceof Response) return existing

  const body = await readBody(request)
  if ('error' in body) return errorResponse(400, body.error)

  const publishedAt = now(options)
  await save(store, id, { ...existing, book: body.book, cover: body.cover, publishedAt })
  return json({ id, url: linkUrl(request, id), expiresAt: expiresAt(publishedAt) })
}

/** What the app needs to add the book. The cover is served on its own. */
async function read(store: LinkStore, id: string): Promise<Response> {
  const stored = await loadBookLink(store, id)
  if (!stored) return errorResponse(404, 'No such link.')
  return json({ book: stored.book, cover: Boolean(stored.cover) })
}

async function remove(request: Request, store: LinkStore, id: string): Promise<Response> {
  const existing = await authorize(request, store, id)
  if (existing instanceof Response) return existing
  await store.delete(KEY_PREFIX + id)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

function save(store: LinkStore, id: string, stored: StoredBookLink): Promise<void> {
  return store.put(KEY_PREFIX + id, JSON.stringify(stored), LINK_TTL_SECONDS)
}

function authorize(
  request: Request,
  store: LinkStore,
  id: string,
): Promise<StoredBookLink | Response> {
  return authorizeOwner(request, () => loadBookLink(store, id), 'No such link.')
}

type ParsedBody = { book: BookCard; cover?: string; turnstileToken: string } | { error: string }

async function readBody(request: Request): Promise<ParsedBody> {
  let payload: unknown
  try {
    payload = JSON.parse(await boundedText(request, MAX_BODY_BYTES))
  } catch {
    return { error: `Expected a JSON body under ${MAX_BODY_BYTES / 1024} KB.` }
  }
  return parseBookBody(payload)
}

/** Validates untrusted input field by field and keeps only what is listed. */
export function parseBookBody(payload: unknown): ParsedBody {
  if (!isRecord(payload) || !isRecord(payload.book)) return { error: 'Missing book.' }
  const { title, author, gutenbergId } = payload.book
  const turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : ''

  if (!isText(title, MAX_LABEL_CHARS) || !title.trim()) return { error: 'The book needs a title.' }
  if (!isText(author, MAX_LABEL_CHARS)) return { error: 'Invalid author.' }
  if (
    typeof gutenbergId !== 'number' ||
    !Number.isInteger(gutenbergId) ||
    gutenbergId < 1 ||
    gutenbergId > MAX_GUTENBERG_ID
  ) {
    return { error: 'Only Project Gutenberg books can be shared.' }
  }

  let cover: string | undefined
  if (payload.cover !== undefined) {
    if (typeof payload.cover !== 'string' || !isJpeg(payload.cover)) {
      return { error: `The cover must be a JPEG under ${MAX_COVER_BYTES / 1024} KB.` }
    }
    cover = payload.cover
  }

  return { turnstileToken, book: { title, author, gutenbergId }, ...(cover ? { cover } : {}) }
}

function isJpeg(base64: string): boolean {
  const bytes = decodeBase64(base64)
  return (
    bytes !== undefined &&
    bytes.length <= MAX_COVER_BYTES &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> | undefined {
  // Four characters encode three bytes; checked before decoding anything large.
  if (base64.length > Math.ceil(MAX_COVER_BYTES / 3) * 4) return undefined
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** `GET /b/<id>/cover`: the preview image chat apps fetch for the card. */
export async function handleBookCover(
  request: Request,
  store: LinkStore | undefined,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Use GET.', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const id = new URL(request.url).pathname.replace(/^\/b\//, '').replace(/\/cover$/, '')
  const stored = await loadBookLink(store, id)
  const bytes = stored?.cover ? decodeBase64(stored.cover) : undefined
  if (!bytes) return new Response('Not found.', { status: 404 })
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/jpeg',
      // Short, so a changed cover or a removed link shows up soon.
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'noindex',
    },
  })
}

/**
 * The app's own `index.html` with the link's preview tags added, served at
 * `/b/<id>`. Chat apps read the tags; a person gets the PWA, which adds the
 * book. An unknown or expired id gets the page unchanged, and the app says
 * the link is gone.
 */
export function withBookPreview(
  html: string,
  stored: StoredBookLink,
  origin: string,
  id: string,
): string {
  const { title, author } = stored.book
  const description = author
    ? `By ${author}. Open it in ${APP_NAME} to add it to your library.`
    : `Open it in ${APP_NAME} to add it to your library.`
  const image = stored.cover ? `${origin}/b/${id}/cover` : `${origin}/icon-512.png`
  const tags = `
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${escape(description)}">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:type" content="website">
<meta property="og:url" content="${origin}/b/${id}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary">
`
  // Function replacers, so a `$&` in a title is text rather than a pattern.
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escape(title)} · ${APP_NAME}</title>`)
    .replace('</head>', () => `${tags}</head>`)
}

function linkUrl(request: Request, id: string): string {
  return new URL(`/b/${id}`, request.url).toString()
}
