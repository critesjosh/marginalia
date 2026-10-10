import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book } from './types'

type DbModule = typeof import('./db')

const FENCE = 'BOOKDATA_0123456789ABCDEF'
let mod: DbModule

/** Opens the app's database fresh, running every upgrade from what is stored. */
async function openApp(): Promise<DbModule> {
  vi.resetModules()
  mod = await import('./db')
  await mod.db.open()
  return mod
}

/** Writes rows the way version 1 of the schema stored them. */
async function seedVersion1(rows: Record<string, object[]>): Promise<void> {
  const old = new Dexie('marginalia')
  old.version(1).stores({
    books: 'id, title, author, addedAt, lastOpenedAt',
    highlights: 'id, bookId, createdAt, [bookId+createdAt]',
    conversations: 'id, bookId, highlightId, updatedAt, [bookId+updatedAt]',
    messages: 'id, conversationId, createdAt, [conversationId+createdAt]',
    bookMemory: 'bookId, updatedAt',
    settings: 'id',
  })
  for (const [table, values] of Object.entries(rows)) await old.table(table).bulkPut(values)
  old.close()
}

function book(overrides: Partial<Book> = {}): Book {
  return { id: 'b1', title: 'Moby Dick', author: 'Herman Melville', addedAt: 1, ...overrides }
}

beforeEach(() => Dexie.delete('marginalia'))
afterEach(() => mod?.db.close())

describe('upgrades from version 1', () => {
  it('strips echoed fence lines from digests and keeps their date', async () => {
    await seedVersion1({
      bookMemory: [
        { bookId: 'b1', summary: `${FENCE}\nAhab wants the whale.\n${FENCE}`, updatedAt: 42 },
        { bookId: 'b2', summary: `${FENCE}\n${FENCE}`, updatedAt: 43 },
      ],
    })
    const { db } = await openApp()
    expect(await db.bookMemory.toArray()).toEqual([
      { bookId: 'b1', summary: 'Ahab wants the whale.', updatedAt: 42 },
    ])
  })

  it('removes the retired audiobook secret and keeps other settings', async () => {
    await seedVersion1({
      settings: [
        {
          id: 'settings',
          provider: 'hosted',
          fontSize: 120,
          audiobookAccessToken: 'synthetic-token',
          audiobookPositionSeconds: 30,
        },
      ],
    })
    const { db } = await openApp()
    expect(await db.settings.get('settings')).toEqual({
      id: 'settings',
      provider: 'hosted',
      fontSize: 120,
    })
  })

  it('indexes archived books and imported records', async () => {
    await seedVersion1({ books: [book()] })
    const { db } = await openApp()
    expect(await db.books.where('archivedAt').above(0).count()).toBe(0)
    expect(
      await db.highlights.where('[bookId+externalId]').equals(['b1', 'koreader:x']).count(),
    ).toBe(0)
  })
})

describe('settings', () => {
  it('keeps a reader with a key and no provider on OpenAI', async () => {
    await seedVersion1({ settings: [{ id: 'settings', apiKey: 'sk-synthetic', model: 'm' }] })
    const { getSettings } = await openApp()
    expect((await getSettings()).provider).toBe('openai')
  })

  it('keeps both of two overlapping saves', async () => {
    const { getSettings, saveSettings } = await openApp()
    await Promise.all([saveSettings({ fontSize: 130 }), saveSettings({ theme: 'sepia' })])
    expect(await getSettings()).toMatchObject({ fontSize: 130, theme: 'sepia' })
  })
})

describe('archiving and restoring a book', () => {
  it('drops the file, keeps the notes, and matches the same bytes back', async () => {
    const { db, archiveBook, findArchivedMatch, restoreBook } = await openApp()
    const cover = new Blob(['chosen cover'])
    await db.books.put(book({ file: new Blob(['epub bytes']), cover, lastCfi: 'epubcfi(/6/4)' }))
    await db.highlights.put({
      id: 'h1',
      bookId: 'b1',
      cfiRange: 'epubcfi(/6/4!/2)',
      text: 'Call me Ishmael.',
      color: 'yellow',
      createdAt: 1,
    })

    await archiveBook('b1')
    const archived = (await db.books.get('b1'))!
    expect(archived.file).toBeUndefined()
    expect(archived.archivedAt).toBeGreaterThan(0)
    expect(archived.fileHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await db.highlights.count()).toBe(1)

    // Same title, different bytes: another edition, not this book.
    const edition = book({ id: 'b2', fileHash: 'f'.repeat(64) })
    expect(await findArchivedMatch(edition)).toBeUndefined()

    const imported = book({ id: 'b3', fileHash: archived.fileHash, file: new Blob(['epub bytes']) })
    expect((await findArchivedMatch(imported))?.id).toBe('b1')

    await restoreBook('b1', { ...imported, cover: new Blob(['epub cover']) })
    const restored = (await db.books.get('b1'))!
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.lastCfi).toBe('epubcfi(/6/4)')
    expect(await restored.cover!.text()).toBe('chosen cover')
  })
})

describe('deleting', () => {
  it('removes a book and everything anchored to it, and nothing else', async () => {
    const { db, deleteBook } = await openApp()
    await db.books.bulkPut([book(), book({ id: 'b2' })])
    await db.conversations.bulkPut([
      { id: 'c1', bookId: 'b1', title: 't', createdAt: 1, updatedAt: 1 },
      { id: 'c2', bookId: 'b2', title: 't', createdAt: 1, updatedAt: 1 },
    ])
    await db.messages.bulkPut([
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'a', createdAt: 1 },
      { id: 'm2', conversationId: 'c2', role: 'user', content: 'b', createdAt: 1 },
    ])
    await db.bookMemory.put({ bookId: 'b1', summary: 's', updatedAt: 1 })

    await deleteBook('b1')
    expect(await db.books.toCollection().primaryKeys()).toEqual(['b2'])
    expect(await db.conversations.toCollection().primaryKeys()).toEqual(['c2'])
    expect(await db.messages.toCollection().primaryKeys()).toEqual(['m2'])
    expect(await db.bookMemory.count()).toBe(0)
  })
})
