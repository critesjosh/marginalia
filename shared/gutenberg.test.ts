import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleGutenbergRequest } from './gutenberg.ts'

function catalogRequest(query: string, headers?: Record<string, string>): Request {
  return new Request(`https://marginalia.test/api/gutenberg?${query}`, { headers })
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error: string }
  return body.error
}

let fetchMock: ReturnType<typeof vi.fn>

// The relay keeps its per-IP window in module scope, where no test can reset
// it. Each test instead runs an hour after the last one ended, which is long
// enough for the window to have expired.
let clock = Date.now()

beforeEach(() => {
  clock += 3_600_000
  vi.useFakeTimers()
  vi.setSystemTime(clock)
  fetchMock = vi.fn()
})

afterEach(() => {
  clock = Date.now()
  vi.useRealTimers()
})

describe('handleGutenbergRequest', () => {
  it('proxies search through Gutendex without the slow format filter', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }))

    const response = await handleGutenbergRequest(catalogRequest('search=pride%20prejudice'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toContain('https://gutendex.com/books?')
    expect(String(url)).toContain('search=pride+prejudice')
    // Filtering by format here makes Gutendex scan each book's formats blob,
    // which is what pushed slow queries past the budget. The client filters.
    expect(String(url)).not.toContain('mime_type')
  })

  it('lets the CDN answer a search someone already ran', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }))

    const response = await handleGutenbergRequest(catalogRequest('search=whale'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.headers.get('Netlify-CDN-Cache-Control')).toContain('s-maxage=3600')
    expect(response.headers.get('Cache-Control')).toContain('max-age=300')
  })

  it('rejects arbitrary book paths instead of becoming an open proxy', async () => {
    const response = await handleGutenbergRequest(catalogRequest('book=../../etc/passwd'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches only the stable Gutenberg EPUB3 endpoint for numeric ids', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 }),
    )

    const response = await handleGutenbergRequest(catalogRequest('book=2701'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.gutenberg.org/ebooks/2701.epub3.images',
      expect.objectContaining({ redirect: 'follow' }),
    )
    expect(response.headers.get('content-type')).toBe('application/epub+zip')
  })
})

describe('request policy', () => {
  it('turns away another site trying to stream EPUBs on this one’s bandwidth', async () => {
    const response = await handleGutenbergRequest(
      catalogRequest('book=2701', { Origin: 'https://not-marginalia.test' }),
      { fetch: fetchMock as unknown as typeof fetch },
    )

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a cross-site browser GET even when it omits Origin', async () => {
    const response = await handleGutenbergRequest(
      catalogRequest('book=2701', { 'Sec-Fetch-Site': 'cross-site' }),
      { fetch: fetchMock as unknown as typeof fetch },
    )

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns away an address that keeps hammering the endpoint', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }))
    const options = { fetch: fetchMock as unknown as typeof fetch, ip: '203.0.113.7' }

    let last = await handleGutenbergRequest(catalogRequest('search=whale'), options)
    for (let attempt = 0; attempt < 60 && last.status === 200; attempt++) {
      last = await handleGutenbergRequest(catalogRequest('search=whale'), options)
    }

    expect(last.status).toBe(429)
    // A different reader in the same region is unaffected.
    const other = await handleGutenbergRequest(catalogRequest('search=whale'), {
      ...options,
      ip: '203.0.113.8',
    })
    expect(other.status).toBe(200)
  })

  it('refuses anything but a GET', async () => {
    const response = await handleGutenbergRequest(
      new Request('https://marginalia.test/api/gutenberg?search=whale', { method: 'POST' }),
      { fetch: fetchMock as unknown as typeof fetch },
    )

    expect(response.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('unreachable upstream', () => {
  it('answers with a JSON error rather than letting the fetch rejection escape', async () => {
    // An escaping rejection is what the platform turns into a bare 502 with no
    // JSON body — and in dev it leaves the Vite middleware with nothing to
    // write, so the request hangs until the browser gives up.
    fetchMock.mockRejectedValue(new TypeError('error sending request'))

    const response = await handleGutenbergRequest(catalogRequest('search=whale'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(504)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await errorMessage(response)).toMatch(/too long/i)
  })

  it('cuts off a download that never sends headers', async () => {
    // Rejects only when the signal it was handed fires, so this fails if the
    // relay ever stops passing `signal` to fetch.
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    const pending = handleGutenbergRequest(catalogRequest('book=2701'), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    const response = await pending

    expect(response.status).toBe(504)
    expect(await errorMessage(response)).toMatch(/too long/i)
  })

  it('bounds how long Gutenberg may take to start, not how long the file may take', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return Promise.resolve(new Response(new Uint8Array([0x50, 0x4b]), { status: 200 }))
    })

    await handleGutenbergRequest(catalogRequest('book=2701'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    // Headers have landed, so the timer is cleared: a large EPUB streams on.
    vi.advanceTimersByTime(10 * 60_000)
    expect(signal?.aborted).toBe(false)
  })
})
