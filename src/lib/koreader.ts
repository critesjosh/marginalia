import type { Book as EpubBook } from 'epubjs'
import { db } from '../db/db'
import type {
  Conversation,
  Highlight,
  HighlightColor,
  Message,
  Role,
} from '../db/types'
import { BookAnchors, isMatch, type AnchorFailure } from './anchor'
import { newId } from './id'

/**
 * Reading a handoff file written by the KOReader plugin in `koreader/`.
 *
 * The file arrives from a device over USB and is not trusted: it is parsed
 * strictly, with a ceiling on everything that could be large, and anything not
 * fully understood is refused rather than half-imported.
 *
 * Two properties are worth stating because the import relies on them:
 *
 * - **A book is identified by the SHA-256 of its bytes**, the same rule
 *   `findArchivedMatch` follows. Title and author would match a different
 *   edition, whose sections are numbered differently, and hand it highlights
 *   that land on arbitrary text.
 * - **Import is additive.** Every record carries the id it had on the device,
 *   and anything already here is left exactly as it is. Importing the same file
 *   twice is a genuine no-op; a conversation that gained turns on the e-reader
 *   since the last import gains them here too, because a thread is appended to
 *   and never edited. What this does *not* do is reconcile an edit — a passage
 *   or note changed on the device after an import stays as it was imported,
 *   rather than being merged under a policy nobody asked for.
 */

export const HANDOFF_FORMAT = 'marginalia-koreader'
export const HANDOFF_VERSION = 1

/** Ceilings. Generous for real books, closed against a hostile file. */
const LIMITS = {
  fileBytes: 32 * 1024 * 1024,
  highlights: 5000,
  threads: 2000,
  messagesPerThread: 500,
  textChars: 20000,
  contextChars: 40000,
  shortChars: 500,
}

export class HandoffError extends Error {}

export interface HandoffHighlight {
  externalId: string
  text: string
  note?: string
  chapter?: string
  color: HighlightColor
  createdAt: number
  progress?: number
  context?: string
}

export interface HandoffMessage {
  externalId: string
  role: Role
  content: string
  createdAt: number
}

export interface HandoffThread {
  externalId: string
  highlightExternalId?: string
  title: string
  seedText?: string
  context?: string
  chapter?: string
  progress?: number
  createdAt: number
  messages: HandoffMessage[]
}

export interface Handoff {
  title: string
  authors: string
  sha256: string
  exportedAt?: number
  highlights: HandoffHighlight[]
  threads: HandoffThread[]
}

const COLORS = new Set<HighlightColor>(['yellow', 'green', 'blue', 'pink'])
const ROLES = new Set<Role>(['user', 'assistant'])

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HandoffError(`Expected ${what} to be an object.`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new HandoffError(`Expected ${what} to be text.`)
  if (value.length > max) throw new HandoffError(`${what} is too long.`)
  return value
}

function optionalString(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return asString(value, what, max)
}

function asArray(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new HandoffError(`Expected ${what} to be a list.`)
  if (value.length > max) throw new HandoffError(`Too many ${what} (limit ${max}).`)
  return value
}

/** A timestamp the plugin wrote with its offset, so there is nothing to guess. */
function asTime(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/**
 * Parses and validates a handoff file.
 *
 * @throws HandoffError with a sentence the import screen can show as-is.
 */
export function parseHandoff(text: string): Handoff {
  if (text.length > LIMITS.fileBytes) {
    throw new HandoffError('That file is too large to be a KOReader export.')
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new HandoffError('That file is not valid JSON.')
  }

  const root = asRecord(payload, 'the file')
  if (root.format !== HANDOFF_FORMAT) {
    throw new HandoffError('That is not a Marginalia export from KOReader.')
  }
  if (root.version !== HANDOFF_VERSION) {
    throw new HandoffError(
      `This export is version ${String(root.version)}; this reader understands version ${HANDOFF_VERSION}. Update one of them.`,
    )
  }

  const book = asRecord(root.book, 'the book')
  const file = asRecord(book.file, "the book's file details")
  const sha256 = asString(file.sha256, 'the book fingerprint', 128)
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new HandoffError('The book fingerprint in that file is not a SHA-256.')
  }

  const exportedAt = asTime(root.exportedAt, Date.now())

  const highlights: HandoffHighlight[] = []
  for (const raw of asArray(book.highlights, 'highlights', LIMITS.highlights)) {
    const entry = asRecord(raw, 'a highlight')
    const passage = asString(entry.text, 'a highlighted passage', LIMITS.textChars)
    if (!passage.trim()) continue

    const color = entry.color as HighlightColor
    highlights.push({
      externalId: asString(entry.externalId, 'a highlight id', LIMITS.shortChars),
      text: passage,
      note: optionalString(entry.note, 'a highlight note', LIMITS.textChars),
      chapter: optionalString(entry.chapter, 'a chapter name', LIMITS.shortChars),
      color: COLORS.has(color) ? color : 'yellow',
      createdAt: asTime(entry.createdAt, exportedAt),
      progress: asProgress(entry.progress),
      context: optionalString(entry.context, 'a highlight context', LIMITS.contextChars),
    })
  }

  const threads: HandoffThread[] = []
  for (const raw of asArray(book.threads, 'conversations', LIMITS.threads)) {
    const entry = asRecord(raw, 'a conversation')
    const messages: HandoffMessage[] = []

    for (const rawMessage of asArray(entry.messages, 'messages', LIMITS.messagesPerThread)) {
      const message = asRecord(rawMessage, 'a message')
      const role = message.role as Role
      if (!ROLES.has(role)) continue
      messages.push({
        externalId: asString(message.externalId, 'a message id', LIMITS.shortChars),
        role,
        content: asString(message.content, 'a message', LIMITS.textChars),
        createdAt: asTime(message.createdAt, exportedAt),
      })
    }

    if (messages.length === 0) continue

    const seedText = optionalString(entry.seedText, 'a conversation passage', LIMITS.textChars)
    threads.push({
      externalId: asString(entry.externalId, 'a conversation id', LIMITS.shortChars),
      highlightExternalId: optionalString(
        entry.highlightExternalId, 'a conversation highlight id', LIMITS.shortChars,
      ),
      title: optionalString(entry.title, 'a conversation title', LIMITS.shortChars)
        ?? seedText?.slice(0, 60) ?? 'Conversation',
      seedText,
      context: optionalString(entry.context, 'a conversation context', LIMITS.contextChars),
      chapter: optionalString(entry.chapter, 'a chapter name', LIMITS.shortChars),
      progress: asProgress(entry.progress),
      createdAt: asTime(entry.createdAt, exportedAt),
      messages,
    })
  }

  return {
    title: optionalString(book.title, 'the book title', LIMITS.shortChars) ?? 'Untitled',
    authors: optionalString(book.authors, 'the book author', LIMITS.shortChars) ?? 'Unknown author',
    sha256,
    exportedAt,
    highlights,
    threads,
  }
}

/** What could not be brought in, and why, so the summary can be specific. */
export interface Rejection {
  text: string
  failure: AnchorFailure
}

export interface ImportResult {
  highlightsAdded: number
  highlightsSkipped: number
  threadsAdded: number
  threadsSkipped: number
  /** Turns appended to conversations that were already here. */
  messagesAdded: number
  rejected: Rejection[]
}

export interface ImportProgress {
  phase: 'indexing' | 'locating' | 'saving'
  done: number
  total: number
}

/**
 * Brings a handoff into the library, against a book already matched by hash.
 *
 * Every passage is anchored first and the database is touched only at the end:
 * loading spine sections is asynchronous work outside Dexie, and doing it
 * inside a transaction lets that transaction commit out from under the writes
 * that were supposed to be part of it.
 */
export async function importHandoff(
  handoff: Handoff,
  bookId: string,
  epub: EpubBook,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
  const existingHighlights = await db.highlights.where('bookId').equals(bookId).toArray()
  const knownHighlight = new Map(
    existingHighlights
      .filter((h) => h.externalId)
      .map((h) => [h.externalId as string, h]),
  )
  const existingThreads = await db.conversations.where('bookId').equals(bookId).toArray()
  const knownThread = new Map(
    existingThreads.filter((c) => c.externalId).map((c) => [c.externalId as string, c]),
  )

  const pending = handoff.highlights.filter((h) => !knownHighlight.has(h.externalId))
  const result: ImportResult = {
    highlightsAdded: 0,
    highlightsSkipped: handoff.highlights.length - pending.length,
    threadsAdded: 0,
    threadsSkipped: 0,
    messagesAdded: 0,
    rejected: [],
  }

  const anchors = await BookAnchors.build(epub, (done, total) =>
    onProgress?.({ phase: 'indexing', done, total }),
  )

  /** Which local highlight each imported one became, for the threads to link to. */
  const highlightIdByExternal = new Map<string, string>(
    [...knownHighlight].map(([externalId, highlight]) => [externalId, highlight.id]),
  )
  const rows: Highlight[] = []

  for (let i = 0; i < pending.length; i += 1) {
    const entry = pending[i]
    onProgress?.({ phase: 'locating', done: i, total: pending.length })

    const located = await anchors.locate(entry.text)
    if (!isMatch(located)) {
      result.rejected.push({ text: entry.text, failure: located.failure })
      continue
    }

    const id = newId()
    highlightIdByExternal.set(entry.externalId, id)
    rows.push({
      id,
      bookId,
      cfiRange: located.cfiRange,
      text: entry.text,
      sectionHref: located.sectionHref,
      context: entry.context,
      chapter: entry.chapter,
      progress: entry.progress,
      color: entry.color,
      note: entry.note,
      createdAt: entry.createdAt,
      source: 'koreader',
      externalId: entry.externalId,
    })
  }

  const conversations: Conversation[] = []
  const messages: Message[] = []
  const touched: { id: string; updatedAt: number }[] = []

  for (const thread of handoff.threads) {
    const existing = knownThread.get(thread.externalId)

    if (existing) {
      // A thread is not finished when it is first exported: asking a follow-up
      // on the e-reader appends to the same thread under the same id. So a
      // conversation already here is not skipped wholesale — only the turns it
      // already holds are.
      const held = await db.messages
        .where('conversationId')
        .equals(existing.id)
        .toArray()
      const seen = new Set(held.map((m) => m.externalId).filter(Boolean))

      const fresh = thread.messages.filter((m) => !seen.has(m.externalId))
      if (fresh.length === 0) {
        result.threadsSkipped += 1
        continue
      }

      for (const message of fresh) {
        messages.push({
          id: newId(),
          conversationId: existing.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          externalId: message.externalId,
        })
      }
      result.messagesAdded += fresh.length
      touched.push({
        id: existing.id,
        updatedAt: Math.max(
          existing.updatedAt,
          fresh[fresh.length - 1]?.createdAt ?? existing.updatedAt,
        ),
      })
      continue
    }

    const conversationId = newId()
    conversations.push({
      id: conversationId,
      bookId,
      // A thread whose passage could not be anchored still keeps its `seedText`,
      // so the thinking survives even when the mark could not be placed.
      highlightId: thread.highlightExternalId
        ? highlightIdByExternal.get(thread.highlightExternalId)
        : undefined,
      title: thread.title,
      seedText: thread.seedText,
      context: thread.context,
      chapter: thread.chapter,
      progress: thread.progress,
      createdAt: thread.createdAt,
      updatedAt: thread.messages[thread.messages.length - 1]?.createdAt ?? thread.createdAt,
      source: 'koreader',
      externalId: thread.externalId,
    })

    for (const message of thread.messages) {
      messages.push({
        id: newId(),
        conversationId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        externalId: message.externalId,
      })
    }
  }

  onProgress?.({ phase: 'saving', done: 0, total: 1 })

  await db.transaction('rw', [db.highlights, db.conversations, db.messages], async () => {
    if (rows.length) await db.highlights.bulkAdd(rows)
    if (conversations.length) await db.conversations.bulkAdd(conversations)
    if (messages.length) await db.messages.bulkAdd(messages)
    // A conversation that grew needs its sort position to grow with it, or the
    // chats list keeps showing it where it sat before the follow-up.
    for (const { id, updatedAt } of touched) {
      await db.conversations.update(id, { updatedAt })
    }
  })

  result.highlightsAdded = rows.length
  result.threadsAdded = conversations.length
  return result
}

/** How a rejection reads in the summary. */
export const REJECTION_REASONS: Record<AnchorFailure, string> = {
  'not-found': 'not found in this edition',
  ambiguous: 'appears more than once, so its place is not certain',
  unverified: 'found, but the position did not check out',
  'section-failed': 'the chapter it lives in could not be read',
  'incomplete-book':
    'part of this EPUB could not be read, so no passage can be placed with certainty',
}
