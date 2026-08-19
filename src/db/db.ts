import Dexie, { type EntityTable } from 'dexie'
import { normalizeSummary } from '../lib/digest'
import {
  DEFAULT_SETTINGS,
  type Book,
  type BookMemory,
  type Conversation,
  type Highlight,
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
  }
}

export const db = new MarginaliaDB()

export async function getSettings(): Promise<Settings> {
  const stored = await db.settings.get('settings')
  const settings = { ...DEFAULT_SETTINGS, ...stored }

  // Records written before the hosted relay existed have a key but no provider;
  // those readers were using OpenAI directly and should stay on it.
  if (stored && !stored.provider && stored.apiKey) settings.provider = 'openai'

  return settings
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
    // Through getSettings, not the raw row: it applies the provider migration,
    // and reading around it would write `hosted` over a reader who is on their
    // own key the first time they change any unrelated setting.
    const current = await getSettings()
    await db.settings.put({ ...current, ...patch, id: 'settings' })
  })
}

/** Removes a book and everything anchored to it. */
export async function deleteBook(bookId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.highlights, db.conversations, db.messages, db.bookMemory],
    async () => {
      const conversationIds = await db.conversations
        .where('bookId')
        .equals(bookId)
        .primaryKeys()
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
  await db.books.update(bookId, {
    archivedAt: Date.now(),
    // Dexie's update only writes the keys it is given, and `undefined` is one
    // of them: this is what actually reclaims the space.
    file: undefined,
  })
}

/** Title and author, folded so the same book imported twice matches itself. */
function shelfKey(title: string, author: string): string {
  return `${title.trim().toLowerCase()}\u0000${author.trim().toLowerCase()}`
}

/** An archived book the given import would be a second copy of, if there is one. */
export async function findArchivedMatch(book: Book): Promise<Book | undefined> {
  const key = shelfKey(book.title, book.author)
  const archived = await db.books.where('archivedAt').above(0).toArray()
  return archived.find((row) => shelfKey(row.title, row.author) === key)
}

/**
 * Puts an archived book back on the shelf using a freshly imported file.
 *
 * Reading position and metadata come back with it. Highlights are anchored by
 * CFI, so they line up again as long as this is the same edition; a different
 * edition under the same title and author is the case that misplaces them,
 * which is the same exposure highlights already carry across app versions.
 */
export async function restoreBook(bookId: string, imported: Book): Promise<void> {
  const { id: _id, addedAt: _addedAt, ...metadata } = imported
  await db.books.update(bookId, { ...metadata, archivedAt: undefined })
}

/** Removes a conversation and its messages. */
export async function deleteConversation(conversationId: string): Promise<void> {
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('conversationId').equals(conversationId).delete()
    await db.conversations.delete(conversationId)
  })
}
