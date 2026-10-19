import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = 'a'.repeat(43)

const rows = vi.hoisted(() => ({
  conversations: new Map<string, Record<string, unknown>>(),
  books: new Map<string, Record<string, unknown>>(),
  messages: [] as Record<string, unknown>[],
}))

vi.mock('../db/db', () => ({
  db: {
    conversations: {
      get: async (id: string) => rows.conversations.get(id),
      orderBy: () => ({ primaryKeys: async () => [...rows.conversations.keys()] }),
    },
    books: { get: async (id: string) => rows.books.get(id) },
    messages: {
      where: () => ({
        equals: (id: string) => ({
          sortBy: async () => rows.messages.filter((m) => m.conversationId === id),
        }),
      }),
    },
  },
}))

// Fresh modules for each test, so one test's cached folder check is not another's.
let mirrorThreads: typeof import('./threadMirror').mirrorThreads
let saveAllThreads: typeof import('./threadMirror').saveAllThreads
let savePairing: typeof import('./localAgent').savePairing

let store: Map<string, string>
let saveDir: string | null
let puts: { url: string; init: RequestInit }[]
let putStatus: number
let putCode: string | undefined

beforeEach(async () => {
  vi.resetModules()
  ;({ mirrorThreads, saveAllThreads } = await import('./threadMirror'))
  ;({ savePairing } = await import('./localAgent'))
  store = new Map()
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  saveDir = '/home/reader/Notes/Rami'
  puts = []
  putStatus = 204
  putCode = undefined
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/v1/status')) return Response.json({ agent: 'claude', mcp: [], saveDir })
    puts.push({ url, init })
    return putStatus === 204
      ? new Response(null, { status: 204 })
      : Response.json(
          { error: { message: 'The save folder is missing.', code: putCode } },
          { status: putStatus },
        )
  })

  rows.conversations.clear()
  rows.books.clear()
  rows.messages = []
  rows.books.set('book-1', {
    id: 'book-1',
    title: 'Moby Dick',
    author: 'Herman Melville',
    file: new Blob(['epub bytes']),
  })
  rows.conversations.set('thread-1', {
    id: 'thread-1',
    bookId: 'book-1',
    title: 'Loomings',
    seedText: 'Call me Ishmael.',
    context: 'surrounding text that should stay home',
    chapter: 'Chapter 1',
    progress: 0.01,
    createdAt: 1,
    updatedAt: 2,
    published: { id: 'p', ownerToken: 'owner-secret' },
  })
  rows.messages = [
    { id: 'm0', conversationId: 'thread-1', role: 'system', content: 'rules', createdAt: 0 },
    { id: 'm1', conversationId: 'thread-1', role: 'user', content: 'Who?', createdAt: 1 },
    { id: 'm2', conversationId: 'thread-1', role: 'assistant', content: 'Ishmael.', createdAt: 2 },
  ]
})

afterEach(() => vi.unstubAllGlobals())

describe('mirrorThreads', () => {
  it('sends nothing unless paired with a bridge that has a save folder', async () => {
    await mirrorThreads(['thread-1'])
    expect(puts).toEqual([])

    savePairing(TOKEN)
    saveDir = null
    await saveAllThreads()
    expect(puts).toEqual([])
  })

  it('sends only the allowlisted fields of a thread, with the token', async () => {
    savePairing(TOKEN)
    const result = await mirrorThreads(['thread-1'])
    expect(result).toMatchObject({ kind: 'saved', count: 1 })

    const [{ url, init }] = puts
    expect(url).toBe('http://127.0.0.1:47615/v1/threads/thread-1')
    expect(init.method).toBe('PUT')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      book: { id: 'book-1', title: 'Moby Dick', author: 'Herman Melville' },
      thread: {
        id: 'thread-1',
        title: 'Loomings',
        chapter: 'Chapter 1',
        progress: 0.01,
        passage: 'Call me Ishmael.',
        createdAt: 1,
        updatedAt: 2,
      },
      turns: [
        { role: 'user', content: 'Who?', createdAt: 1 },
        { role: 'assistant', content: 'Ishmael.', createdAt: 2 },
      ],
    })
    expect(String(init.body)).not.toMatch(/owner-secret|surrounding text|rules/)
  })

  it('reports a failure without throwing, and treats a newer saved copy as fine', async () => {
    savePairing(TOKEN)
    putStatus = 503
    await expect(saveAllThreads()).resolves.toMatchObject({
      kind: 'failed',
      message: 'The save folder is missing.',
    })
    putStatus = 409
    putCode = 'stale'
    await expect(saveAllThreads()).resolves.toMatchObject({ kind: 'saved' })
    // Any other refusal, such as a symlink where the file should be, is a failure.
    putCode = undefined
    await expect(saveAllThreads()).resolves.toMatchObject({ kind: 'failed' })

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(saveAllThreads()).resolves.toMatchObject({ kind: 'failed' })
  })
})
