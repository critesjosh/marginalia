import Dexie, { type EntityTable } from 'dexie'
import { normalizeSummary } from '../lib/digest'
import { fingerprint } from '../lib/fingerprint'
import {
  recordBookAdded,
  recordBookArchived,
  recordBookRemoved,
  recordBookRestored,
  recordConversationDeleted,
} from '../sync/library'
import {
  DEFAULT_SETTINGS,
  type Book,
  type BookMemory,
  type Conversation,
  type EventOutboxRow,
  type Highlight,
  type InsightsCache,
  type Message,
  type Settings,
  type SyncState,
} from './types'

export class MarginaliaDB extends Dexie {
  books!: EntityTable<Book, 'id'>
  highlights!: EntityTable<Highlight, 'id'>
  conversations!: EntityTable<Conversation, 'id'>
  messages!: EntityTable<Message, 'id'>
  bookMemory!: EntityTable<BookMemory, 'bookId'>
  settings!: EntityTable<Settings, 'id'>
  eventOutbox!: EntityTable<EventOutboxRow, 'eventId'>
  syncState!: EntityTable<SyncState, 'id'>
  insightsCache!: EntityTable<InsightsCache, 'id'>

  constructor(name = 'marginalia') {
    super(name)
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
      conversations:
        'id, bookId, highlightId, updatedAt, [bookId+updatedAt], [bookId+externalId]',
      messages:
        'id, conversationId, createdAt, [conversationId+createdAt], [conversationId+externalId]',
    })

    // Intelligence sync stays local in Phase 0. These tables add an atomic
    // outbox, one installation-scoped sequence, and a future Insights cache;
    // no existing table is rewritten during this migration.
    this.version(5).stores({
      eventOutbox: 'eventId, sequence, nextAttemptAt, status, [status+sequence]',
      syncState: 'id',
      insightsCache: 'id, sourceUpdatedAt, cachedAt',
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
/**
 * Puts a new book on the shelf and records that it arrived, in one transaction.
 * `origin` says how it got here, which is the difference between a reader
 * choosing a book and one of the bundled samples being seeded.
 */
export async function addBook(
  book: Book,
  origin: 'import' | 'sample' | 'gutenberg' | 'koreader',
): Promise<void> {
  await db.transaction('rw', [db.books, db.settings, db.syncState, db.eventOutbox], async () => {
    await db.books.add(book)
    await recordBookAdded(book, origin)
  })
}

export async function deleteBook(bookId: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.highlights,
      db.conversations,
      db.messages,
      db.bookMemory,
      db.settings,
      db.syncState,
      db.eventOutbox,
    ],
    async () => {
      const conversationIds = await db.conversations
        .where('bookId')
        .equals(bookId)
        .primaryKeys()
      const highlightsRemoved = await db.highlights.where('bookId').equals(bookId).count()
      await db.messages.where('conversationId').anyOf(conversationIds).delete()
      await db.conversations.where('bookId').equals(bookId).delete()
      await db.highlights.where('bookId').equals(bookId).delete()
      await db.bookMemory.delete(bookId)
      await db.books.delete(bookId)
      // Counted before the deletes, queued inside the same transaction: the
      // record of what was removed cannot survive a rollback of the removal.
      await recordBookRemoved(bookId, {
        highlightsRemoved,
        conversationsRemoved: conversationIds.length,
      })
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

  const at = Date.now()
  await db.transaction('rw', [db.books, db.settings, db.syncState, db.eventOutbox], async () => {
    await db.books.update(bookId, {
      archivedAt: at,
      fileHash,
      // Dexie's update only writes the keys it is given, and `undefined` is one
      // of them: this is what actually reclaims the space.
      file: undefined,
    })
    await recordBookArchived(bookId, stored.progress, at)
  })
}

/**
 * The archived book an import is the same file as, if there is one.
 *
 * Matched on content, never on title and author: two editions share those
 * while numbering their sections differently, so metadata alone would hand a
 * book's highlights and saved position to a different edition that cannot
 * carry them. An archived book with no fingerprint — its file was already gone
 * before one was taken — stays archived, and the import comes in as new.
 */
export async function findArchivedMatch(book: Book): Promise<Book | undefined> {
  if (!book.fileHash) return undefined
  const archived = await db.books.where('archivedAt').above(0).toArray()
  return archived.find((row) => row.fileHash === book.fileHash)
}

/**
 * Puts an archived book back on the shelf using a freshly imported file.
 *
 * Reading position and metadata come back with it. Only ever called for a file
 * whose fingerprint matches the one that was archived, so the CFIs the
 * highlights and the saved position are written in still address the same
 * document they were taken from.
 */
export async function restoreBook(bookId: string, imported: Book): Promise<void> {
  const { id: _id, addedAt: _addedAt, ...metadata } = imported
  const at = Date.now()
  await db.transaction('rw', [db.books, db.settings, db.syncState, db.eventOutbox], async () => {
    await db.books.update(bookId, { ...metadata, archivedAt: undefined })
    const restored = await db.books.get(bookId)
    await recordBookRestored(bookId, restored?.progress, at)
  })
}

/** Removes a conversation and its messages. */
export async function deleteConversation(conversationId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.conversations, db.messages, db.settings, db.syncState, db.eventOutbox],
    async () => {
      const conversation = await db.conversations.get(conversationId)
      const messagesRemoved = await db.messages
        .where('conversationId')
        .equals(conversationId)
        .count()
      await db.messages.where('conversationId').equals(conversationId).delete()
      await db.conversations.delete(conversationId)
      if (conversation) {
        await recordConversationDeleted(conversation.bookId, conversationId, messagesRemoved)
      }
    },
  )
}
