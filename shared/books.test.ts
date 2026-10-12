import { describe, expect, it, vi } from 'vitest'
import {
  handleBookCover,
  handleBooksRequest,
  parseBookBody,
  type StoredBookLink,
  withBookPreview,
} from './books.ts'
import { LINK_TTL_SECONDS, memoryLinkStore, type PublishOptions } from './publishing.ts'

const ORIGIN = 'https://rami.test'
const BOOK = { title: 'Moby Dick', author: 'Herman Melville', gutenbergId: 2701 }
/** A JPEG as far as the server checks: the start-of-image marker, then anything. */
const COVER = btoa('\xff\xd8\xff\xe0not really an image')

interface Published {
  id: string
  url: string
  ownerToken: string
  expiresAt: number
}

function setup(overrides: Partial<PublishOptions> = {}) {
  const store = memoryLinkStore()
  const fetcher = vi.fn(async () => Response.json({ success: true }))
  const options: PublishOptions = {
    store,
    turnstileSecret: 'secret',
    turnstileSiteKey: 'site-key',
    fetcher: fetcher as unknown as typeof fetch,
    now: () => 1_000,
    ...overrides,
  }
  // A fresh address per setup keeps the module-level throttle out of the way.
  const ip = `10.0.1.${Math.floor(Math.random() * 250)}`
  const call = (path: string, init: RequestInit = {}) =>
    handleBooksRequest(new Request(`${ORIGIN}${path}`, init), options, { ip })
  const publish = async (body: unknown = { book: BOOK, cover: COVER, turnstileToken: 'ok' }) =>
    call('/api/books', { method: 'POST', body: JSON.stringify(body) })
  return { store, fetcher, call, publish }
}

describe('book links', () => {
  it('stores the card under its own prefix and hands back a /b/ link', async () => {
    const { store, publish } = setup()
    const response = await publish()
    expect(response.status).toBe(201)

    const body = (await response.json()) as Published
    expect(body.url).toBe(`${ORIGIN}/b/${body.id}`)
    expect(body.expiresAt).toBe(1_000 + LINK_TTL_SECONDS * 1000)

    expect(await store.get(body.id)).toBeNull()
    const stored = JSON.parse((await store.get(`book:${body.id}`))!) as StoredBookLink
    expect(stored.book).toEqual(BOOK)
    expect(stored.cover).toBe(COVER)
    expect(JSON.stringify(stored)).not.toContain(body.ownerToken)
  })

  it('requires the Turnstile check to create, and the switch to be on', async () => {
    const { publish, fetcher } = setup()
    expect((await publish({ book: BOOK })).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await setup({ enabled: false }).publish()).status).toBe(503)
    expect((await setup({ store: undefined }).publish()).status).toBe(503)
  })

  it('lets anyone read what is needed to add the book, but not the owner hash', async () => {
    const { call, publish } = setup()
    const { id } = (await (await publish()).json()) as Published

    const response = await call(`/api/books/${id}`)
    expect(await response.json()).toEqual({ book: BOOK, cover: true })
    expect((await call('/api/books/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404)
  })

  it('updates and removes only with the owner token', async () => {
    const { store, call, publish } = setup()
    const { id, ownerToken } = (await (await publish()).json()) as Published
    const update = (token: string) =>
      call(`/api/books/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ book: { ...BOOK, title: 'Moby-Dick' } }),
      })

    expect((await update('wrong')).status).toBe(404)
    expect((await update(ownerToken)).status).toBe(200)
    const stored = JSON.parse((await store.get(`book:${id}`))!) as StoredBookLink
    expect(stored.book.title).toBe('Moby-Dick')
    // Updated without a cover, so the old one goes too.
    expect(stored.cover).toBeUndefined()

    const remove = (token: string) =>
      call(`/api/books/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    expect((await remove('wrong')).status).toBe(404)
    expect((await remove(ownerToken)).status).toBe(204)
    expect(store.size()).toBe(0)
  })

  it('refuses cross-origin requests', async () => {
    const { call } = setup()
    const response = await call('/api/books', {
      method: 'POST',
      headers: { Origin: 'https://elsewhere.test', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ book: BOOK, turnstileToken: 'ok' }),
    })
    expect(response.status).toBe(403)
  })
})

describe('parseBookBody', () => {
  it('keeps only the listed fields', () => {
    expect(parseBookBody({ book: { ...BOOK, file: 'x' }, extra: 1, turnstileToken: 't' })).toEqual({
      book: BOOK,
      turnstileToken: 't',
    })
  })

  it('only accepts Project Gutenberg books', () => {
    for (const gutenbergId of [undefined, 0, -1, 1.5, '2701', 100_000_000]) {
      expect(parseBookBody({ book: { ...BOOK, gutenbergId } })).toEqual({
        error: 'Only Project Gutenberg books can be shared.',
      })
    }
  })

  it('only accepts a small JPEG as the cover', () => {
    const png = btoa('\x89PNG\r\n\x1a\n')
    const huge = btoa(`\xff\xd8\xff${'x'.repeat(300 * 1024)}`)
    for (const cover of [png, huge, 'not base64!', 42]) {
      expect(parseBookBody({ book: BOOK, cover })).toHaveProperty('error')
    }
  })

  it('needs a title', () => {
    expect(parseBookBody({ book: { ...BOOK, title: ' ' } })).toHaveProperty('error')
  })
})

describe('the cover and preview tags', () => {
  const stored: StoredBookLink = { book: BOOK, cover: COVER, ownerHash: 'x', publishedAt: 1 }
  const ID = 'AbCdEfGhIjKlMnOpQrStUv'

  it('serves the stored cover as a JPEG', async () => {
    const store = memoryLinkStore()
    await store.put(`book:${ID}`, JSON.stringify(stored), 60)

    const response = await handleBookCover(new Request(`${ORIGIN}/b/${ID}/cover`), store)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff]),
    )

    const missing = await handleBookCover(new Request(`${ORIGIN}/b/${'A'.repeat(22)}/cover`), store)
    expect(missing.status).toBe(404)
  })

  it('adds escaped preview tags to the app page', () => {
    const html = '<html><head><title>Rami</title></head><body></body></html>'
    const hostile = { ...stored, book: { ...BOOK, title: '"><script>alert(1)</script> $&' } }
    const page = withBookPreview(html, hostile, ORIGIN, ID)

    expect(page).toContain(`<meta property="og:image" content="${ORIGIN}/b/${ID}/cover">`)
    expect(page).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp;')
    expect(page).not.toContain('<script>')
    expect(page.match(/<title>/g)).toHaveLength(1)
  })

  it('falls back to the app icon when the book had no cover', () => {
    const page = withBookPreview('<head></head>', { ...stored, cover: undefined }, ORIGIN, ID)
    expect(page).toContain(`content="${ORIGIN}/icon-512.png"`)
  })
})
