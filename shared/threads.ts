/**
 * Published threads: a snapshot of one conversation a reader chose to share,
 * stored under an unguessable id and served read-only at `/t/<id>`. See
 * `docs/decisions/0006-public-thread-links.md`.
 *
 * Shared by the Cloudflare app Worker (Workers KV) and the Vite dev server (an
 * in-memory map), so it is written against Web APIs only and takes its store
 * as a parameter.
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

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGES = 200
/** Keeps a link from republishing long stretches of an imported book. */
const MAX_PASSAGE_CHARS = 2_000
const MAX_LABEL_CHARS = 300

/** Publishing is rare; a burst beyond this is not a reader. */
const rateLimited = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 10 })

interface ThreadMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What a reader publishes. Nothing else from the device is sent. */
interface ThreadSnapshot {
  book: { title: string; author: string }
  chapter?: string
  passage?: string
  messages: ThreadMessage[]
}

export interface StoredThread {
  thread: ThreadSnapshot
  /** SHA-256 of the owner token, hex. The token itself is never stored. */
  ownerHash: string
  publishedAt: number
}

export async function handleThreadsRequest(
  request: Request,
  options: PublishOptions,
  context: PublishRequestContext,
): Promise<Response> {
  const started = performance.now()
  const response = await route(request, options, context)
  console.info(
    JSON.stringify(operationMetric('threads', response.status, performance.now() - started)),
  )
  return response
}

/** Reads a published thread for the viewer page, or `null` when it is gone. */
export async function loadThread(
  store: LinkStore | undefined,
  id: string,
): Promise<StoredThread | null> {
  if (!store || !ID_PATTERN.test(id)) return null
  const raw = await store.get(id)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredThread
  } catch {
    return null
  }
}

async function route(
  request: Request,
  options: PublishOptions,
  { ip }: PublishRequestContext,
): Promise<Response> {
  const { store, turnstileSiteKey = '' } = options
  const unavailable = () =>
    errorResponse(503, 'Publishing threads is not available on this deployment.')
  if (!store) return unavailable()
  if (isCrossOrigin(request)) {
    return errorResponse(403, 'Cross-origin requests are not allowed.')
  }

  const id = new URL(request.url).pathname.replace(/^\/api\/threads\/?/, '')
  // Owners can still remove their links while publishing is switched off.
  if (request.method === 'DELETE' && ID_PATTERN.test(id)) return remove(request, store, id)
  if (!canPublish(options)) return unavailable()

  if (!id) {
    if (request.method === 'GET') return json({ siteKey: turnstileSiteKey.trim() })
    if (request.method === 'POST') return create(request, options, store, ip)
    return errorResponse(405, 'Use GET or POST.')
  }
  if (!ID_PATTERN.test(id)) return errorResponse(404, 'No such thread.')
  if (request.method === 'PUT') return update(request, options, store, id, ip)
  if (request.method === 'DELETE') return remove(request, store, id)
  return errorResponse(405, 'Use PUT or DELETE.')
}

async function create(
  request: Request,
  options: PublishOptions,
  store: LinkStore,
  ip: string,
): Promise<Response> {
  if (rateLimited(ip)) return errorResponse(429, 'Too many links published. Try again later.')

  const body = await readBody(request)
  if ('error' in body) return errorResponse(400, body.error)
  const { thread, turnstileToken } = body

  const human = await verifyTurnstile(options, turnstileToken, ip)
  if (!human) return errorResponse(403, 'The verification check did not pass. Try again.')

  const { id, ownerToken, ownerHash } = await newLink()
  const publishedAt = now(options)
  const stored: StoredThread = { thread, ownerHash, publishedAt }
  await store.put(id, JSON.stringify(stored), LINK_TTL_SECONDS)

  return json(
    { id, url: threadUrl(request, id), ownerToken, expiresAt: expiresAt(publishedAt) },
    201,
  )
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
  const stored: StoredThread = { ...existing, thread: body.thread, publishedAt }
  await store.put(id, JSON.stringify(stored), LINK_TTL_SECONDS)
  return json({ id, url: threadUrl(request, id), expiresAt: expiresAt(publishedAt) })
}

async function remove(request: Request, store: LinkStore, id: string): Promise<Response> {
  const existing = await authorize(request, store, id)
  if (existing instanceof Response) return existing
  await store.delete(id)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

function authorize(
  request: Request,
  store: LinkStore,
  id: string,
): Promise<StoredThread | Response> {
  return authorizeOwner(request, () => loadThread(store, id), 'No such thread.')
}

type ParsedBody = { thread: ThreadSnapshot; turnstileToken: string } | { error: string }

async function readBody(request: Request): Promise<ParsedBody> {
  let payload: unknown
  try {
    payload = JSON.parse(await boundedText(request, MAX_BODY_BYTES))
  } catch {
    return { error: `Expected a JSON body under ${MAX_BODY_BYTES / 1024} KB.` }
  }
  return parseBody(payload)
}

/** Validates untrusted input field by field and keeps only what is listed. */
export function parseBody(payload: unknown): ParsedBody {
  if (!isRecord(payload) || !isRecord(payload.thread)) return { error: 'Missing thread.' }
  const { book, chapter, passage, messages } = payload.thread
  const turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : ''

  if (!isRecord(book) || !isText(book.title, MAX_LABEL_CHARS) || !book.title.trim()) {
    return { error: 'The thread needs a book title.' }
  }
  if (!isText(book.author, MAX_LABEL_CHARS)) return { error: 'Invalid author.' }
  if (chapter !== undefined && !isText(chapter, MAX_LABEL_CHARS)) {
    return { error: 'Invalid chapter.' }
  }
  if (passage !== undefined && !isText(passage, MAX_PASSAGE_CHARS)) {
    return { error: `The passage is limited to ${MAX_PASSAGE_CHARS} characters.` }
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { error: `A thread needs between 1 and ${MAX_MESSAGES} messages.` }
  }

  const kept: ThreadMessage[] = []
  for (const message of messages) {
    if (
      !isRecord(message) ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string'
    ) {
      return { error: 'Each message needs a user or assistant role and text.' }
    }
    kept.push({ role: message.role, content: message.content })
  }

  return {
    turnstileToken,
    thread: {
      book: { title: book.title, author: book.author },
      ...(chapter ? { chapter } : {}),
      ...(passage ? { passage } : {}),
      messages: kept,
    },
  }
}

function threadUrl(request: Request, id: string): string {
  return new URL(`/t/${id}`, request.url).toString()
}
