import { describe, expect, it, vi } from 'vitest'
import {
  coverHash,
  liveLink,
  publishBook,
  readSharedBook,
  republishBook,
  unpublishBook,
} from './bookLink'
import { PublishError } from './publish'

const SNAPSHOT = { book: { title: 'Moby Dick', author: 'Herman Melville', gutenbergId: 2701 } }
const LINK = { id: 'AbCdEfGhIjKlMnOpQrStUv', ownerToken: 'owner' }

function fetcher(response: Response) {
  return vi.fn(async (_url: string, _init?: RequestInit) => response)
}

describe('book link requests', () => {
  it('creates with the Turnstile token and updates with the owner token', async () => {
    const create = fetcher(Response.json({ id: LINK.id }, { status: 201 }))
    await publishBook(SNAPSHOT, 'turnstile', create as unknown as typeof fetch)
    expect(create).toHaveBeenCalledWith('/api/books', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(create.mock.calls[0]![1]!.body as string)).toEqual({
      ...SNAPSHOT,
      turnstileToken: 'turnstile',
    })

    const update = fetcher(Response.json({ id: LINK.id }))
    await republishBook(LINK, SNAPSHOT, update as unknown as typeof fetch)
    const init = update.mock.calls[0]![1]!
    expect(update.mock.calls[0]![0]).toBe(`/api/books/${LINK.id}`)
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer owner')
  })

  it('counts a link that already expired as removed', async () => {
    const gone = fetcher(Response.json({ error: { message: 'No such link.' } }, { status: 404 }))
    await expect(unpublishBook(LINK, gone as unknown as typeof fetch)).resolves.toBeUndefined()
  })

  it('reports a missing link with its status, so the page can say it is gone', async () => {
    const gone = fetcher(Response.json({ error: { message: 'No such link.' } }, { status: 404 }))
    await expect(
      readSharedBook(LINK.id, undefined, gone as unknown as typeof fetch),
    ).rejects.toEqual(new PublishError('No such link.', 404))
  })
})

describe('coverHash', () => {
  it('tells covers apart, and names the absence of one', async () => {
    const a = await coverHash(new Blob(['a']))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await coverHash(new Blob(['a']))).toBe(a)
    expect(await coverHash(new Blob(['b']))).not.toBe(a)
    expect(await coverHash(undefined)).toBe('none')
  })
})

describe('liveLink', () => {
  const link = {
    id: 'x',
    url: 'u',
    ownerToken: 't',
    publishedAt: 0,
    expiresAt: 1_000,
    coverHash: 'none',
  }

  it('treats an expired link as gone, so a new one is offered', () => {
    expect(liveLink({ sharedLink: link }, 999)).toBe(link)
    expect(liveLink({ sharedLink: link }, 1_000)).toBeUndefined()
    expect(liveLink({}, 0)).toBeUndefined()
  })
})
