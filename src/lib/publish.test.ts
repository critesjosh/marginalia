import { describe, expect, it, vi } from 'vitest'
import {
  isStale,
  PublishError,
  publishThread,
  snapshotFor,
  unpublishAll,
  unpublishThread,
} from './publish'

const BOOK = { title: 'Moby Dick', author: 'Herman Melville' }

describe('snapshotFor', () => {
  it('sends only the book, chapter, passage and turns', () => {
    const snapshot = snapshotFor(
      { chapter: 'Chapter 1', seedText: ' Call me Ishmael. ' },
      [
        { role: 'system', content: 'hidden' },
        { role: 'user', content: 'Why?' },
        { role: 'assistant', content: 'Because.' },
      ],
      { ...BOOK, file: new Blob(), instructions: 'private' } as never,
    )
    expect(snapshot).toEqual({
      book: BOOK,
      chapter: 'Chapter 1',
      passage: 'Call me Ishmael.',
      messages: [
        { role: 'user', content: 'Why?' },
        { role: 'assistant', content: 'Because.' },
      ],
    })
  })

  it('trims a passage longer than the server accepts', () => {
    const { passage } = snapshotFor({ seedText: 'x'.repeat(5_000) }, [], BOOK)
    expect(passage).toHaveLength(2_000)
    expect(passage?.endsWith('…')).toBe(true)
  })
})

describe('isStale', () => {
  const published = { id: 'a', url: 'u', ownerToken: 't', publishedAt: 100, expiresAt: 0 }

  it('notices turns added after publishing', () => {
    expect(isStale({ published }, [{ createdAt: 50 }])).toBe(false)
    expect(isStale({ published }, [{ createdAt: 50 }, { createdAt: 150 }])).toBe(true)
    expect(isStale({}, [{ createdAt: 150 }])).toBe(false)
  })
})

describe('requests', () => {
  it('surfaces the server’s message', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { message: 'Too many links published.' } }, { status: 429 }),
    )
    await expect(publishThread(snapshotFor({}, [], BOOK), 't', fetcher)).rejects.toThrow(
      new PublishError('Too many links published.', 429),
    )
  })

  it('explains an unreachable server', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('offline')
    })
    await expect(unpublishThread('a', 't', fetcher)).rejects.toThrow(/Could not reach Rami/)
  })

  it('treats removing an already-gone link as done', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(unpublishThread('a', 't', fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('/api/threads/a', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    })
  })
  it('removes every published link before a deletion, and fails if one cannot go', async () => {
    const link = (id: string) => ({
      published: { id, url: 'u', ownerToken: `t-${id}`, publishedAt: 0, expiresAt: 0 },
    })
    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    await unpublishAll([link('a'), {}, link('b')], ok)
    expect(ok).toHaveBeenCalledTimes(2)

    const offline = vi.fn(async () => {
      throw new TypeError('offline')
    })
    await expect(unpublishAll([link('a')], offline)).rejects.toThrow(PublishError)
  })
})
