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
  return { ...DEFAULT_SETTINGS, ...stored }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, id: 'settings' })
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
