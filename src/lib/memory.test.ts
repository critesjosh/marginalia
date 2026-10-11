import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { getBookMemory, saveBookMemory, updateBookMemory } from './memory'

const FENCE = 'BOOKDATA_0123456789ABCDEF'

/** Stands in for the hosted relay, calling `respond` with each request body. */
function relay(
  respond: (body: { messages: { content: string }[] }) => Response | Promise<Response>,
) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    respond(JSON.parse(init.body as string)),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const reply = (content: string) =>
  Response.json({ choices: [{ message: { content } }] }, { status: 200 })

async function seedConversation(count: number, content = 'A synthetic turn.') {
  await db.books.put({ id: 'b1', title: 'Moby Dick', author: 'Herman Melville', addedAt: 1 })
  await db.conversations.put({ id: 'c1', bookId: 'b1', title: 't', createdAt: 1, updatedAt: 1 })
  await db.messages.bulkPut(
    Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      conversationId: 'c1',
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content,
      createdAt: i,
    })),
  )
}

const summarizedCount = async () => (await db.conversations.get('c1'))?.summarizedCount

beforeEach(async () => {
  await db.delete()
  await db.open()
})
afterEach(() => vi.unstubAllGlobals())

describe('updateBookMemory', () => {
  it('waits for enough new messages before calling the summarizer', async () => {
    const fetch = relay(() => reply('unused'))
    await seedConversation(3)
    await updateBookMemory('b1', 'c1')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stores the digest without echoed fences and advances the count', async () => {
    const fetch = relay(() => reply(`${FENCE}\nIshmael ships out.\n${FENCE}`))
    await seedConversation(4)
    await updateBookMemory('b1', 'c1')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toBe('/api/chat')
    expect(await getBookMemory('b1')).toBe('Ishmael ships out.')
    expect(await summarizedCount()).toBe(4)
  })

  it('swallows a summarizer failure and retries those messages next time', async () => {
    relay(() => Response.json({ error: { message: 'down' } }, { status: 503 }))
    await seedConversation(4)
    await expect(updateBookMemory('b1', 'c1')).resolves.toBeUndefined()
    expect(await getBookMemory('b1')).toBeUndefined()
    expect(await summarizedCount()).toBeUndefined()
  })

  it('never wipes a digest with a reply that is only delimiters', async () => {
    relay(() => reply(`${FENCE}\n${FENCE}`))
    await seedConversation(4)
    await saveBookMemory('b1', 'Written by hand.')
    await updateBookMemory('b1', 'c1')
    expect(await getBookMemory('b1')).toBe('Written by hand.')
  })

  it("keeps the reader's edit made while the summarizer was working", async () => {
    await seedConversation(4)
    // Edits are told apart by `updatedAt`; a real summary call takes far longer
    // than the millisecond two saves in a row can share.
    await db.bookMemory.put({ bookId: 'b1', summary: 'Before.', updatedAt: 1 })
    relay(async () => {
      await saveBookMemory('b1', 'Edited mid-flight.')
      return reply('From the model.')
    })
    await updateBookMemory('b1', 'c1')
    expect(await getBookMemory('b1')).toBe('Edited mid-flight.')
    expect(await summarizedCount()).toBeUndefined()
  })

  it('runs one update at a time per book, each merging the last', async () => {
    const seen: string[] = []
    let started!: () => void
    let release!: () => void
    const inFlight = new Promise<void>((resolve) => (started = resolve))
    const released = new Promise<void>((resolve) => (release = resolve))
    relay(async ({ messages }) => {
      seen.push(messages.map((m) => m.content).join('\n'))
      if (seen.length === 1) {
        started()
        await released
      }
      return reply(`Digest ${seen.length}.`)
    })
    await seedConversation(4)
    const first = updateBookMemory('b1', 'c1')
    await inFlight
    // Four more turns land while the first update is still in flight.
    await db.messages.bulkPut(
      [4, 5, 6, 7].map((i) => ({
        id: `m${i}`,
        conversationId: 'c1',
        role: 'user' as const,
        content: 'Later turn.',
        createdAt: i,
      })),
    )
    const second = updateBookMemory('b1', 'c1')
    release()
    await Promise.all([first, second])
    expect(await getBookMemory('b1')).toBe('Digest 2.')
    expect(seen[1]).toContain('Digest 1.')
    expect(await summarizedCount()).toBe(8)
  })

  it('bounds a backlog to the newest turns', async () => {
    let transcript = ''
    relay(({ messages }) => {
      transcript = messages.map((m) => m.content).join('\n')
      return reply('Bounded.')
    })
    await seedConversation(40, 'x'.repeat(2_000))
    await updateBookMemory('b1', 'c1')
    expect(transcript.length).toBeLessThan(40 * 2_000)
    expect(transcript.length).toBeGreaterThan(20_000)
    expect(await summarizedCount()).toBe(40)
  })
})

describe('saveBookMemory', () => {
  it('deletes the digest when it is cleared', async () => {
    await saveBookMemory('b1', 'Notes.')
    await saveBookMemory('b1', `  ${FENCE}  `)
    expect(await getBookMemory('b1')).toBeUndefined()
  })
})
