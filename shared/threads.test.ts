import { describe, expect, it, vi } from 'vitest'
import { escape, handleThreadPage, renderThread } from './threadPage.ts'
import { LINK_TTL_SECONDS, memoryLinkStore, type PublishOptions } from './publishing.ts'
import { handleThreadsRequest, parseBody } from './threads.ts'

const ORIGIN = 'https://rami.test'
const THREAD = {
  book: { title: 'Moby Dick', author: 'Herman Melville' },
  chapter: 'Chapter 1. Loomings',
  passage: 'Call me Ishmael.',
  messages: [
    { role: 'user', content: 'Why open with a name?' },
    { role: 'assistant', content: 'It sets a confiding tone.' },
  ],
}

interface Published {
  id: string
  url: string
  ownerToken: string
  expiresAt: number
}

const read = async (response: Response) => (await response.json()) as Published

function siteverify(success: boolean) {
  return vi.fn(async () => Response.json({ success }))
}

function setup(overrides: Partial<PublishOptions> = {}) {
  const store = memoryLinkStore()
  const fetcher = siteverify(true)
  const options: PublishOptions = {
    store,
    turnstileSecret: 'secret',
    turnstileSiteKey: 'site-key',
    fetcher: fetcher as unknown as typeof fetch,
    now: () => 1_000,
    ...overrides,
  }
  // A fresh address per setup keeps the module-level throttle out of the way.
  const ip = `10.0.0.${Math.floor(Math.random() * 250)}`
  const call = (path: string, init: RequestInit = {}) =>
    handleThreadsRequest(new Request(`${ORIGIN}${path}`, init), options, { ip })
  const publish = (body: unknown = { thread: THREAD, turnstileToken: 'ok' }) =>
    call('/api/threads', { method: 'POST', body: JSON.stringify(body) })
  return { store, fetcher, call, publish }
}

describe('publishing', () => {
  it('stores the snapshot and hands back an unguessable link and owner token', async () => {
    const { store, fetcher, publish } = setup()
    const response = await publish()
    expect(response.status).toBe(201)

    const body = await read(response)
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.url).toBe(`${ORIGIN}/t/${body.id}`)
    expect(body.ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.expiresAt).toBe(1_000 + LINK_TTL_SECONDS * 1000)

    const stored = JSON.parse((await store.get(body.id))!)
    expect(stored.thread).toEqual(THREAD)
    expect(stored.ownerHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(body.ownerToken)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('refuses without a passing Turnstile check', async () => {
    const failing = setup({ fetcher: siteverify(false) as unknown as typeof fetch })
    expect((await failing.publish()).status).toBe(403)
    expect(failing.store.size()).toBe(0)

    const { publish, fetcher } = setup()
    expect((await publish({ thread: THREAD })).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('is off when disabled or unconfigured', async () => {
    for (const overrides of [
      { enabled: false },
      { store: undefined },
      { turnstileSecret: ' ' },
      { turnstileSiteKey: '' },
    ]) {
      expect((await setup(overrides).publish()).status).toBe(503)
    }
  })

  it('gives the PWA the public site key', async () => {
    const response = await setup().call('/api/threads')
    expect(await response.json()).toEqual({ siteKey: 'site-key' })
  })

  it('turns away other sites', async () => {
    const { call } = setup()
    const response = await call('/api/threads', {
      method: 'POST',
      headers: { Origin: 'https://elsewhere.test' },
      body: JSON.stringify({ thread: THREAD, turnstileToken: 'ok' }),
    })
    expect(response.status).toBe(403)
  })

  it('rejects an oversized body', async () => {
    const big = { ...THREAD, messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }
    expect((await setup().publish({ thread: big, turnstileToken: 'ok' })).status).toBe(400)
  })
})

describe('owner actions', () => {
  async function published() {
    const harness = setup()
    const { id, ownerToken } = await read(await harness.publish())
    const auth = (token = ownerToken) => ({ Authorization: `Bearer ${token}` })
    return { ...harness, id, auth }
  }

  it('republishes to the same link and restarts the year', async () => {
    let clock = 1_000
    const harness = setup({ now: () => clock })
    const { id, ownerToken } = await read(await harness.publish())
    clock = 5_000

    const longer = { ...THREAD, messages: [...THREAD.messages, { role: 'user', content: 'More?' }] }
    const response = await harness.call(`/api/threads/${id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ thread: longer }),
    })
    expect(response.status).toBe(200)
    expect((await read(response)).expiresAt).toBe(5_000 + LINK_TTL_SECONDS * 1000)
    expect(JSON.parse((await harness.store.get(id))!).thread.messages).toHaveLength(3)
  })

  it('deletes with the owner token', async () => {
    const { call, store, id, auth } = await published()
    const response = await call(`/api/threads/${id}`, { method: 'DELETE', headers: auth() })
    expect(response.status).toBe(204)
    expect(await store.get(id)).toBeNull()
  })

  it('answers a wrong token like a missing thread', async () => {
    const { call, store, id, auth } = await published()
    const wrong = await call(`/api/threads/${id}`, { method: 'DELETE', headers: auth('nope') })
    const missing = await call('/api/threads/AAAAAAAAAAAAAAAAAAAAAA', {
      method: 'DELETE',
      headers: auth(),
    })
    expect(wrong.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await store.get(id)).not.toBeNull()

    const anonymous = await call(`/api/threads/${id}`, { method: 'DELETE' })
    expect(anonymous.status).toBe(401)
  })

  it('still deletes while publishing is switched off', async () => {
    const { store, id, auth } = await published()
    const off = { store, enabled: false, turnstileSecret: '', turnstileSiteKey: '' }
    const call = (init: RequestInit) =>
      handleThreadsRequest(new Request(`${ORIGIN}/api/threads/${id}`, init), off, { ip: '' })

    expect((await call({ method: 'PUT', headers: auth(), body: '{}' })).status).toBe(503)
    expect((await call({ method: 'DELETE', headers: auth() })).status).toBe(204)
    expect(await store.get(id)).toBeNull()
  })
})

describe('parseBody', () => {
  it('keeps only the listed fields', () => {
    const parsed = parseBody({
      turnstileToken: 't',
      extra: 'dropped',
      thread: {
        ...THREAD,
        context: 'dropped',
        book: { ...THREAD.book, file: 'dropped' },
        messages: [{ role: 'user', content: 'hi', id: 'dropped' }],
      },
    })
    expect(parsed).toEqual({
      turnstileToken: 't',
      thread: {
        book: THREAD.book,
        chapter: THREAD.chapter,
        passage: THREAD.passage,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
  })

  it.each([
    ['no thread', {}],
    ['no title', { thread: { ...THREAD, book: { title: ' ', author: '' } } }],
    ['no messages', { thread: { ...THREAD, messages: [] } }],
    ['a system message', { thread: { ...THREAD, messages: [{ role: 'system', content: 'x' }] } }],
    ['a long passage', { thread: { ...THREAD, passage: 'x'.repeat(2_001) } }],
  ])('rejects %s', (_, body) => {
    expect(parseBody(body)).toHaveProperty('error')
  })
})

describe('the viewer page', () => {
  it('serves a published thread, escaped and unindexed', async () => {
    const { store, publish } = setup()
    const hostile = {
      ...THREAD,
      book: { title: '<script>alert(1)</script>', author: '' },
      messages: [{ role: 'assistant', content: 'Visit https://spam.test <a href="x">now</a>' }],
    }
    const { id } = await read(await publish({ thread: hostile, turnstileToken: 'ok' }))

    const response = await handleThreadPage(new Request(`${ORIGIN}/t/${id}`), store)
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const html = await response.text()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<a href="x">')
    expect(html).not.toContain('href="https://spam.test')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain(`href="${ORIGIN}/"`)
  })

  it('says a removed or unknown link is gone', async () => {
    const { store } = setup()
    for (const path of ['/t/AAAAAAAAAAAAAAAAAAAAAA', '/t/../../etc', '/t/']) {
      const response = await handleThreadPage(new Request(`${ORIGIN}${path}`), store)
      expect(response.status).toBe(404)
    }
  })

  it('renders the passage, both voices, and the source', () => {
    const html = renderThread({ thread: THREAD as never, ownerHash: '', publishedAt: 0 }, ORIGIN)
    expect(html).toContain('Moby Dick by Herman Melville')
    expect(html).toContain('<blockquote>Call me Ishmael.</blockquote>')
    expect(html).toContain('<p class="you">Why open with a name?</p>')
    expect(html).toContain('It sets a confiding tone.')
    expect(html).toContain('<meta property="og:title" content="A conversation about Moby Dick">')
  })

  it('cuts a long preview description even without spaces', () => {
    const thread = { ...THREAD, passage: 'x'.repeat(500) }
    const html = renderThread({ thread: thread as never, ownerHash: '', publishedAt: 0 }, ORIGIN)
    expect(html).toContain(`<meta name="description" content="${'x'.repeat(199)}…">`)
  })

  it('escapes every markup character', () => {
    expect(escape(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})
