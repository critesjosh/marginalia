import { describe, expect, it, vi } from 'vitest'
import { handleTelemetryRequest, sanitizeEvent } from './telemetryRelay.ts'
import { MAX_BATCH } from './telemetrySchema.ts'

// Built at runtime so secret scanners don't take the fixture for a real key.
const KEY = `phc_${'a'.repeat(32)}`
const HOST = 'https://eu.i.posthog.test'
const SESSION_ID = '0b5c1f0e-8d4e-4c38-9a4d-5a3f8f2a1b7c'

function event(name = 'app_opened', properties: Record<string, unknown> = {}) {
  return {
    event: name,
    timestamp: '2026-10-12T10:00:00.000Z',
    properties: { distinct_id: SESSION_ID, ...properties },
  }
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://rami.test/api/telemetry/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function upstream(ok = true) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    ok ? new Response('{"status":"Ok"}') : new Response('', { status: 500 }),
  )
}

async function send(request: Request, fetch = upstream(), options = {}) {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const response = await handleTelemetryRequest(
    request,
    { apiKey: KEY, host: HOST, fetch: fetch as typeof globalThis.fetch, ...options },
    // A fresh address each time, so the shared throttle never trips across tests.
    { ip: `203.0.113.${Math.floor(Math.random() * 250)}` },
  )
  return { response, fetch }
}

describe('GET /api/telemetry/config', () => {
  const config = (options = {}, country = 'GB') =>
    handleTelemetryRequest(
      new Request('https://rami.test/api/telemetry/config'),
      { apiKey: KEY, host: HOST, ...options },
      { ip: '', country },
    )

  it('answers with the region rule only, uncached', async () => {
    const response = await config()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ enabled: true, consent: 'opt_out' })
    expect(await (await config({}, 'DE')).json()).toEqual({ enabled: true, consent: 'opt_in' })
  })

  it('asks everywhere when the default is off', async () => {
    expect(await (await config({ defaultMode: 'off' })).json()).toEqual({
      enabled: true,
      consent: 'opt_in',
    })
  })

  it('is off without a project key and an https host', async () => {
    for (const options of [
      { apiKey: undefined },
      { apiKey: `phx_${'a'.repeat(32)}` },
      { host: undefined },
      { host: 'http://eu.i.posthog.test' },
      { host: `${HOST}/capture` },
    ]) {
      expect(await (await config(options)).json()).toEqual({ enabled: false })
    }
  })

  it('rejects anything but GET', async () => {
    const request = new Request('https://rami.test/api/telemetry/config', { method: 'POST' })
    const response = await handleTelemetryRequest(request, {}, { ip: '' })
    expect(response.status).toBe(405)
  })
})

describe('POST /api/telemetry/events', () => {
  it('forwards the batch with the key and no reader headers', async () => {
    const { response, fetch } = await send(
      post(
        { batch: [event()] },
        {
          'CF-Connecting-IP': '203.0.113.9',
          'User-Agent': 'Mozilla/5.0 Reader',
          Cookie: 'a=b',
        },
      ),
    )
    expect(response.status).toBe(204)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`${HOST}/batch/`)
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init?.referrer).toBeUndefined()
    const body = JSON.parse(String(init?.body))
    expect(body.api_key).toBe(KEY)
    expect(body.batch).toHaveLength(1)
    expect(JSON.stringify(body)).not.toMatch(/203\.0\.113|Mozilla|a=b/)
  })

  it('re-applies the allowlist and sets the privacy flags itself', () => {
    const sanitized = sanitizeEvent(
      event('reader_opened', {
        book_kind: 'imported',
        title: 'Moby Dick',
        url: 'https://example.com/book.epub',
        browser_family: 'firefox',
        $ip: '203.0.113.9',
        $process_person_profile: true,
        $set: { email: 'a@b.c' },
      }),
    )
    expect(sanitized).toEqual({
      event: 'reader_opened',
      timestamp: '2026-10-12T10:00:00.000Z',
      properties: {
        book_kind: 'imported',
        browser_family: 'firefox',
        distinct_id: SESSION_ID,
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: 'rami-web',
      },
    })
  })

  it('scrubs report notes again', () => {
    const sanitized = sanitizeEvent(
      event('problem_reported', { has_feedback: true, feedback: 'mail me at a@b.co' }),
    )
    expect(sanitized?.properties.feedback).toBe('mail me at [email]')
  })

  it('drops unknown events, ids that are not session ids, and bad timestamps', async () => {
    expect(sanitizeEvent(event('$pageview'))).toBeUndefined()
    expect(sanitizeEvent(event('app_opened', { distinct_id: 'reader@example.com' }))).toBe(
      undefined,
    )
    expect(sanitizeEvent({ ...event(), timestamp: 'soon' })).not.toHaveProperty('timestamp')

    const { response, fetch } = await send(post({ batch: [event('$pageview')] }))
    expect(response.status).toBe(204)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses malformed, oversized and cross-origin requests', async () => {
    expect((await send(post('not json'))).response.status).toBe(400)
    expect((await send(post({ events: [] }))).response.status).toBe(400)
    const tooMany = { batch: Array.from({ length: MAX_BATCH + 1 }, () => event()) }
    expect((await send(post(tooMany))).response.status).toBe(413)
    expect((await send(post({ batch: ['x'.repeat(70_000)] }))).response.status).toBe(413)
    // A chunked body has no Content-Length; reading stops at the limit.
    let chunksRead = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (chunksRead++ === 200) controller.close()
        else controller.enqueue(new Uint8Array(1024))
      },
    })
    const chunked = new Request('https://rami.test/api/telemetry/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    expect((await send(chunked)).response.status).toBe(413)
    expect(chunksRead).toBeLessThan(100)
    const crossSite = post({ batch: [event()] }, { Origin: 'https://evil.test' })
    expect((await send(crossSite)).response.status).toBe(403)
    const get = new Request('https://rami.test/api/telemetry/events')
    expect((await send(get)).response.status).toBe(405)
  })

  it('is off without a key, and reports an upstream failure', async () => {
    const off = await send(post({ batch: [event()] }), upstream(), { apiKey: '' })
    expect(off.response.status).toBe(503)
    expect(off.fetch).not.toHaveBeenCalled()
    expect((await send(post({ batch: [event()] }), upstream(false))).response.status).toBe(502)
  })

  it('throttles a burst from one address', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetch = upstream() as unknown as typeof globalThis.fetch
    const statuses = []
    for (let i = 0; i < 61; i++) {
      const response = await handleTelemetryRequest(
        post({ batch: [event()] }),
        { apiKey: KEY, host: HOST, fetch },
        { ip: '198.51.100.1' },
      )
      statuses.push(response.status)
    }
    expect(statuses.at(-1)).toBe(429)
  })
})
