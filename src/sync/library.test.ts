import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addBook, archiveBook, db, deleteBook, deleteConversation, restoreBook } from '../db/db'
import { DEFAULT_SETTINGS, type Book } from '../db/types'
import { saveBookMemory } from '../lib/memory'
import type { EventOutboxRow } from './types'

const NOW = Date.UTC(2026, 8, 2, 9)

function book(id: string): Book {
  return {
    id,
    title: 'On the Genealogy of Morality',
    author: 'Friedrich Nietzsche',
    description: 'Three essays.',
    addedAt: NOW,
    file: new Blob(['epub']),
  } as Book
}

async function settings(overrides: Record<string, unknown> = {}) {
  await db.settings.put({ ...DEFAULT_SETTINGS, id: 'settings', ...overrides })
}

async function queued(): Promise<EventOutboxRow[]> {
  return db.eventOutbox.orderBy('sequence').toArray()
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 1 })
})

describe('library lifecycle events', () => {
  it('queues nothing at all while sync is off', async () => {
    await settings({ syncEnabled: false })
    await addBook(book('book-1'), 'import')
    await archiveBook('book-1')
    expect(await queued()).toEqual([])
    // The product write still happened. Sync is an addition, never a gate.
    expect((await db.books.get('book-1'))?.archivedAt).toBeTruthy()
  })

  it('records a book arriving, with its title only when metadata is shared', async () => {
    await settings({ syncEnabled: true, shareBookMetadata: true })
    await addBook(book('book-1'), 'import')
    const [added] = await queued()
    expect(added.eventType).toBe('book_added')
    expect(added.payload.payload).toMatchObject({ origin: 'import', title: 'On the Genealogy of Morality' })
    expect(added.privacySnapshot.included).toEqual(['bookMetadata'])
  })

  it('still records the arrival without a title when metadata is not shared', async () => {
    await settings({ syncEnabled: true, shareBookMetadata: false })
    await addBook(book('book-1'), 'sample')
    const [added] = await queued()
    expect(added.payload.payload).toEqual({ addedAt: new Date(added.eventTime).toISOString(), origin: 'sample' })
    expect(added.privacySnapshot.included).toEqual([])
  })

  it('counts what a removal actually removed', async () => {
    await settings({ syncEnabled: true })
    await addBook(book('book-1'), 'import')
    await db.highlights.bulkAdd([
      { id: 'h1', bookId: 'book-1', cfi: 'a', text: 't', createdAt: NOW },
      { id: 'h2', bookId: 'book-1', cfi: 'b', text: 't', createdAt: NOW },
    ] as never)
    await db.conversations.add({ id: 'c1', bookId: 'book-1', createdAt: NOW } as never)

    await deleteBook('book-1')
    const removal = (await queued()).at(-1)!
    expect(removal.eventType).toBe('book_removed')
    expect(removal.payload.payload).toMatchObject({ highlightsRemoved: 2, conversationsRemoved: 1 })
  })

  it('records archiving and restoring against the same book', async () => {
    await settings({ syncEnabled: true })
    await addBook(book('book-1'), 'import')
    await archiveBook('book-1')
    await restoreBook('book-1', book('book-1'))
    expect((await queued()).map((row) => row.eventType)).toEqual([
      'book_added',
      'book_archived',
      'book_restored',
    ])
  })

  it('records a deleted conversation with the book it belonged to', async () => {
    await settings({ syncEnabled: true })
    await db.conversations.add({ id: 'c1', bookId: 'book-1', createdAt: NOW } as never)
    await db.messages.bulkAdd([
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: NOW },
    ] as never)

    await deleteConversation('c1')
    const [deleted] = await queued()
    expect(deleted.eventType).toBe('conversation_deleted')
    expect(deleted.payload.entities).toEqual({ bookId: 'book-1', conversationId: 'c1' })
    expect(deleted.payload.payload).toMatchObject({ messagesRemoved: 1 })
  })

  it('shares a book digest only when the memory category is consented', async () => {
    await settings({ syncEnabled: true, shareBookMemory: false })
    await saveBookMemory('book-1', 'Where moral values came from.')
    let [event] = await queued()
    expect(event.payload.payload).not.toHaveProperty('summary')

    await db.eventOutbox.clear()
    await settings({ syncEnabled: true, shareBookMemory: true })
    await saveBookMemory('book-1', 'Where moral values came from.')
    ;[event] = await queued()
    expect(event.payload.payload).toMatchObject({ summary: 'Where moral values came from.' })
    expect(event.privacySnapshot.included).toEqual(['bookMemory'])
  })

  it('rolls the product write back when the event cannot be queued', async () => {
    await settings({ syncEnabled: true })
    const failing = vi
      .spyOn(db.eventOutbox, 'add')
      .mockRejectedValue(new Error('outbox unavailable'))
    try {
      await expect(addBook(book('book-2'), 'import')).rejects.toThrow()
    } finally {
      failing.mockRestore()
    }
    // Neither, or both. A book on the shelf with no record of arriving is the
    // failure this transaction exists to prevent.
    expect(await db.books.get('book-2')).toBeUndefined()
  })
})
