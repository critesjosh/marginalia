import Dexie, { type EntityTable } from 'dexie'
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

/** Removes a conversation and its messages. */
export async function deleteConversation(conversationId: string): Promise<void> {
  await db.transaction('rw', [db.conversations, db.messages], async () => {
    await db.messages.where('conversationId').equals(conversationId).delete()
    await db.conversations.delete(conversationId)
  })
}
