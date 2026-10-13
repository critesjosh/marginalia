import Dexie, { type EntityTable } from 'dexie'
import { normalizeSummary } from '../lib/digest'
import { fingerprint } from '../lib/fingerprint'
import { unpublishBook } from '../lib/bookLink'
import { unpublishAll } from '../lib/publish'
import {
  DEFAULT_SETTINGS,
  type Book,
  type BookMemory,
  type Conversation,
  type Highlight,
  type Hint,
  type Message,
  type Settings,
} from './types'

class MarginaliaDB extends Dexie {
  books!: EntityTable<Book, 'id'>
  highlights!: EntityTable<Highlight, 'id'>
  conversations!: EntityTable<Conversation, 'id'>
  messages!: EntityTable<Message, 'id'>
  bookMemory!: EntityTable<BookMemory, 'bookId'>
  settings!: EntityTable<Settings, 'id'>

  constructor() {
    super('marginalia')
    this.version(1).stores({
      books: 'id, title, author, addedAt, lastOpenedAt',
      highlights: 'id, bookId, createdAt, [bookId+createdAt]',
      conversations: 'id, bookId, highlightId, updatedAt, [bookId+updatedAt]',
      messages: 'id, conversationId, createdAt, [conversationId+createdAt]',
      bookMemory: 'bookId, updatedAt',
      settings: 'id',
    })

    // Digests written before the limits existed carry a pair of echoed fence
    // tokens for every update that ever ran, and may sit over the ceiling.
    // Clean them in place rather than waiting for the next write, which for a
    // book the reader has finished may never come.
    this.version(2).upgrade(async (tx) => {
      const memory = tx.table<BookMemory, string>('bookMemory')

      // `updatedAt` stays put: this rewrites how the notes are stored, not what
      // they say, and the panel shows that date to the reader.
      await memory.toCollection().modify((row) => {
        row.summary = normalizeSummary(row.summary)
      })

      // A digest that was nothing but delimiters holds no notes to keep.
      await memory.filter((row) => !row.summary).delete()
    })

    // `archivedAt` joins the index so the library can ask for shelved books
    // without pulling every EPUB blob out of storage to filter in memory.
    this.version(3).stores({
      books: 'id, title, author, addedAt, lastOpenedAt, archivedAt',
    })

    // Imported records carry the id they had where they were written, so a
    // second import of the same file adds nothing. Indexed rather than scanned:
    // an import asks this question once per highlight, and a book can hold
    // hundreds. Existing rows have no `externalId` and are simply absent from
    // the index, which is what a sparse index does.
    this.version(4).stores({
      highlights: 'id, bookId, createdAt, [bookId+createdAt], [bookId+externalId]',
      conversations: 'id, bookId, highlightId, updatedAt, [bookId+updatedAt], [bookId+externalId]',
      messages:
        'id, conversationId, createdAt, [conversationId+createdAt], [conversationId+externalId]',
    })

    // Audiobook playback was removed; drop its token and position so the
    // secret does not outlive the feature.
    this.version(5).upgrade(async (tx) => {
      await tx
        .table('settings')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          delete row.audiobookAccessToken
          delete row.audiobookPositionSeconds
        })
    })

    // The own-OpenAI-key option was removed; every request now goes through
    // the relay. Drop the key so the secret does not outlive the feature.
    this.version(6).upgrade(async (tx) => {
      await tx
        .table('settings')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          delete row.provider
          delete row.apiKey
          delete row.model
          delete row.summaryModel
        })
    })
  }
}

export const db = new MarginaliaDB()

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await db.settings.get('settings')) }
}

/**
 * Applies a patch atomically.
 *
 * Read-modify-write outside a transaction lets two overlapping saves read the
 * same record, so the slower write puts back stale values for fields the other
 * one owned. The font-size slider alone fires this on every change.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const current = await getSettings()
    await db.settings.put({ ...current, ...patch, id: 'settings' })
  })
}

/**
 * Records a one-time hint as shown, and says whether this call did. Atomic, so
 * two hints closing together both stick and only one caller sees `true`.
 */
export async function markHintSeen(hint: Hint): Promise<boolean> {
  return db.transaction('rw', db.settings, async () => {
    const current = await getSettings()
    if (current.seenHints?.includes(hint)) return false
    await db.settings.put({ ...current, seenHints: [...(current.seenHints ?? []), hint] })
    return true
  })
}

/**
 * Removes a book and everything anchored to it. Its published links go first,
 * so a failure to remove one leaves the book in place.
 */
export async function deleteBook(bookId: string): Promise<void> {
  await unpublishAll(await db.conversations.where('bookId').equals(bookId).toArray())
  const sharedLink = (await db.books.get(bookId))?.sharedLink
  if (sharedLink) await unpublishBook(sharedLink)
  await db.transaction(
    'rw',
    [db.books, db.highlights, db.conversations, db.messages, db.bookMemory],
    async () => {
      const conversationIds = await db.conversations.where('bookId').equals(bookId).primaryKeys()
      await db.messages.where('conversationId').anyOf(conversationIds).delete()
      await db.conversations.where('bookId').equals(bookId).delete()
      await db.highlights.where('bookId').equals(bookId).delete()
      await db.bookMemory.delete(bookId)
      await db.books.delete(bookId)
    },
  )
}

/**
 * Shelves a book: the EPUB goes, everything anchored to it stays.
 *
 * The record itself is kept so its highlights, conversations and memory still
 * have a book to belong to, and so importing the same EPUB again lands back on
 * this row rather than starting an empty second copy of the book.
 */
export async function archiveBook(bookId: string): Promise<void> {
  const stored = await db.books.get(bookId)
  if (!stored) return

  // Last chance to take the fingerprint: books imported before it was recorded
  // still have their file here, and will not once this returns.
  const fileHash =
    stored.fileHash ??
    (stored.file ? await fingerprint(await stored.file.arrayBuffer()) : undefined)

  await db.books.update(bookId, {
    archivedAt: Date.now(),
    missingFileAt: undefined,
    fileHash,
    // Dexie's update only writes the keys it is given, and `undefined` is one
    // of them: this is what actually reclaims the space.
    file: undefined,
  })
}

/**
 * The book waiting for this file, if there is one: removed by the reader, or
 * lost by the browser.
 *
 * Matched on content, never on title and author: two editions share those
 * while numbering their sections differently, so metadata alone would hand a
 * book's highlights and saved position to a different edition that cannot
 * carry them. A book with no fingerprint (its file was already gone before one
 * was taken) keeps waiting, and the import comes in as new.
 */
export async function findRestorableMatch(book: Book): Promise<Book | undefined> {
  if (!book.fileHash) return undefined
  return db.books
    .filter((row) => Boolean(row.archivedAt || row.missingFileAt) && row.fileHash === book.fileHash)
    .first()
}

/**
 * Gives a removed or file-missing book its EPUB again.
 *
 * Reading position and metadata come back with it. Only ever called for a file
 * whose fingerprint matches the original one, so the CFIs the
 * highlights and the saved position are written in still address the same
 * document they were taken from.
 */
export async function restoreBook(bookId: string, imported: Book): Promise<void> {
  const { id: _id, addedAt: _addedAt, ...metadata } = imported
  await db.transaction('rw', db.books, async () => {
    // The shelved cover is the EPUB's own unless the reader replaced it, and a
    // replacement is the one they chose to keep.
    const stored = await db.books.get(bookId)
    await db.books.update(bookId, {
      ...metadata,
      cover: stored?.cover ?? metadata.cover,
      archivedAt: undefined,
      missingFileAt: undefined,
    })
  })
}

/** Removes a conversation and its messages, and its published link first. */
export async function deleteConversation(conversationId: string): Promise<void> {
  const conversation = await db.conversations.get(conversationId)
  if (conversation) await unpublishAll([conversation])
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('conversationId').equals(conversationId).delete()
    await db.conversations.delete(conversationId)
  })
}
