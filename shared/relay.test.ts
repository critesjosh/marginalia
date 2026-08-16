import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRelayRequest } from './relay.ts'

const OPTIONS = { apiKey: 'test-key', siteUrl: 'https://marginalia.test' }

function chatRequest(body: unknown = { messages: [{ role: 'user', content: 'hello' }] }): Request {
  return new Request('https://marginalia.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function upstreamResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The body of each recorded call, in order. */
function requestedBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(
    ([, init]) =>
      JSON.parse((init as RequestInit).body as string) as {
        model: string
        provider: { order: string[]; allow_fallbacks: boolean }
      },
  )
}

/** The model each recorded call asked for, in order. */
function requestedModels(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return requestedBodies(fetchMock).map((body) => body.model)
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } }
  return body.error.message
}

let fetchMock: ReturnType<typeof vi.fn>

// The relay keeps the free-tier cooldown and the per-IP window in module scope,
// where no test can reset them. Each test instead runs an hour after the last
// one ended, which is long enough for both to have expired.
let clock = Date.now()

beforeEach(() => {
  clock += 3_600_000
  vi.useFakeTimers()
  vi.setSystemTime(clock)

  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  clock = Date.now()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('request policy', () => {
  it('refuses anything but a POST with a JSON body and a configured key', async () => {
    const get = new Request('https://marginalia.test/api/chat')
    expect((await handleRelayRequest(get, OPTIONS, { ip: '' })).status).toBe(405)

    const keyless = await handleRelayRequest(chatRequest(), { apiKey: '' }, { ip: '' })
    expect(keyless.status).toBe(503)

    const empty = await handleRelayRequest(chatRequest({ messages: [] }), OPTIONS, { ip: '' })
    expect(empty.status).toBe(400)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('upstream routing', () => {
  it('streams the free tier back untouched when it answers', async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )

    const response = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: {}\n\n')
    expect(requestedModels(fetchMock)).toEqual(['google/gemma-4-26b-a4b-it:free'])
  })

  it('pays for the answer when the free tier is exhausted', async () => {
    fetchMock
      .mockResolvedValueOnce(upstreamResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(upstreamResponse(200, { choices: [] }))

    const response = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    expect(response.status).toBe(200)
    expect(requestedModels(fetchMock)).toEqual([
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-4-26b-a4b-it',
    ])
  })

  it('lets no route hand the reader\'s book text to an unvetted provider', async () => {
    fetchMock
      .mockResolvedValueOnce(upstreamResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(upstreamResponse(200, { choices: [] }))

    await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    // An open fallback set can land on a provider that scrubs the prompt before
    // the model sees it, so the answer comes back discussing `[PERSON_NAME]`
    // and `[ADDRESS]` instead of the author and the country in the passage.
    const bodies = requestedBodies(fetchMock)
    expect(bodies).toHaveLength(2)
    for (const { provider } of bodies) {
      expect(provider.allow_fallbacks).toBe(false)
      expect(provider.order.length).toBeGreaterThan(0)
      expect(provider.order.every((slug) => ['google-ai-studio', 'cloudflare'].includes(slug))).toBe(
        true,
      )
    }
  })
})

describe('unreachable provider', () => {
  it('answers with a JSON error rather than letting the fetch rejection escape', async () => {
    fetchMock.mockRejectedValue(new TypeError('error sending request'))

    const response = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    // An escaping rejection is what the platform turns into a bare 502 with an
    // HTML body, which the reader sees as an unexplained status code.
    expect(response.status).toBe(502)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(await errorMessage(response)).toMatch(/could not reach the model provider/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the upstream explanation when both routes refuse', async () => {
    fetchMock
      .mockResolvedValueOnce(upstreamResponse(429, { error: { message: 'free pool exhausted' } }))
      .mockResolvedValueOnce(upstreamResponse(503, { error: { message: 'no provider available' } }))

    const response = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    expect(response.status).toBe(503)
    expect(await errorMessage(response)).toBe('no provider available')
  })

  it('gives up rather than starting a fallback it has no time to finish', async () => {
    // A provider that hangs until the budget is spent: the fallback would only
    // abort on arrival, trading a real upstream message for a generic one.
    fetchMock.mockImplementationOnce(() => {
      vi.advanceTimersByTime(30_000)
      return Promise.resolve(upstreamResponse(504, { error: { message: 'upstream timed out' } }))
    })

    const response = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    expect(response.status).toBe(504)
    expect(await errorMessage(response)).toBe('upstream timed out')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bounds how long a provider may think, not how long its answer may be', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return Promise.resolve(upstreamResponse(200, { choices: [] }))
    })

    await handleRelayRequest(chatRequest(), OPTIONS, { ip: '' })

    // Headers have landed, so the timer is cleared: a long reply streams on.
    vi.advanceTimersByTime(10 * 60_000)
    expect(signal?.aborted).toBe(false)
  })
})

describe('throttling', () => {
  it('turns away an address that keeps hammering the endpoint', async () => {
    fetchMock.mockResolvedValue(upstreamResponse(200, { choices: [] }))

    let last = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '203.0.113.7' })
    for (let attempt = 0; attempt < 40 && last.status === 200; attempt++) {
      last = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '203.0.113.7' })
    }

    expect(last.status).toBe(429)
    // A different reader in the same region is unaffected.
    const other = await handleRelayRequest(chatRequest(), OPTIONS, { ip: '203.0.113.8' })
    expect(other.status).toBe(200)
  })
})
