import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleGutenbergRequest, parseBookFeed, parseSearchFeed } from './gutenberg.ts'

/** Trimmed from a real `search.opds` response, thumbnails elided. */
const SEARCH_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Books: pride prejudice</title>
<entry>
<id>https://www.gutenberg.org/ebooks/authors/search.opds/?query=pride+prejudice</id>
<title>Authors</title>
<content type="text">One author name matches your search.</content>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/1342.opds</id>
<title>Pride and Prejudice</title>
<content type="text">Jane Austen</content>
<link type="image/png" rel="http://opds-spec.org/image/thumbnail" href="data:image/png;base64,AAAA"/>
</entry>
<entry>
<id>https://www.gutenberg.org/ebooks/10471.opds</id>
<title>The World&#8217;s Greatest Books &amp;
More</title>
<content type="text">1,190 downloads</content>
</entry>
</feed>`

/** Trimmed from a real `42671.opds` response: an edited edition of #1342. */
const BOOK_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Pride and Prejudice by Jane Austen</title>
<author><name>Project Gutenberg</name></author>
<entry>
<title>Pride and Prejudice</title>
<content type="xhtml">
<div xmlns="http://www.w3.org/1999/xhtml">
<p>This edition had all images removed.</p>
<p>
Title:
Pride and Prejudice
</p>
<p>
Note:
Wikipedia page about this book: https:<a href="//en.wikipedia.org/wiki/Pride_and_Prejudice">//en.wikipedia.org/wiki/Pride_and_Prejudice</a>
</p>
<p>
Note:
This title is also available as eBook <a href="/ebooks/1342.bibrec.mobile">#1342</a>.
</p>
<p>
Credits:
E-text prepared by Greg Weeks and the Online Distributed Proofreading Team
</p>
<p>
Summary:
"Pride and Prejudice" by Jane Austen is a novel published in 1813. (This is an automatically generated summary.)
</p>
<p>
Reading Level:
Reading ease score: 69.5 (8th &amp; 9th grade). Neither easy nor difficult to read.
</p>
<p>Author: Austen, Jane, 1775-1817</p><p>Editor: Chapman, R. W. (Robert William), 1881-1960</p>
<p>EBook No.: 42671</p>
<p>Published: May 9, 2013</p>
<p>Downloads: 14621</p>
<p>Language: English</p>
<p>Subject: England -- Fiction</p><p>Subject: Love stories</p>
<p>Category: Text</p>
</div>
</content>
<contributor><name>Chapman, R. W. (Robert William)</name></contributor>
<author><name>Austen, Jane</name></author>
</entry>
</feed>`

const BOOK_DETAILS = {
  id: 42671,
  title: 'Pride and Prejudice',
  people: [
    { role: 'Author', name: 'Jane Austen', dates: '1775-1817' },
    { role: 'Editor', name: 'R. W. Chapman', dates: '1881-1960' },
  ],
  summary:
    '"Pride and Prejudice" by Jane Austen is a novel published in 1813. (This is an automatically generated summary.)',
  notes: [],
  credits: 'E-text prepared by Greg Weeks and the Online Distributed Proofreading Team',
  released: 'May 9, 2013',
  downloads: 14621,
  language: 'English',
  subjects: ['England -- Fiction', 'Love stories'],
  readingLevel: '69.5 (8th & 9th grade). Neither easy nor difficult to read.',
  otherEditions: [1342],
}

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
  it('searches Gutenberg OPDS and answers with normalized JSON', async () => {
    fetchMock.mockResolvedValue(new Response(SEARCH_FEED, { status: 200 }))

    const response = await handleGutenbergRequest(catalogRequest('search=pride%20prejudice'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(200)
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(String(url)).toBe('https://www.gutenberg.org/ebooks/search.opds/?query=pride+prejudice')
    expect(await response.json()).toEqual({
      results: [
        { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
        { id: 10471, title: 'The World’s Greatest Books & More' },
      ],
    })
  })

  it('reports a failed upstream search as unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))

    const response = await handleGutenbergRequest(catalogRequest('search=whale'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(502)
  })

  it('lets the browser reuse a search it already ran', async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }))

    const response = await handleGutenbergRequest(catalogRequest('search=whale'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.headers.get('Cache-Control')).toContain('max-age=300')
  })

  it('describes one book from its Gutenberg OPDS record', async () => {
    fetchMock.mockResolvedValue(new Response(BOOK_FEED, { status: 200 }))

    const response = await handleGutenbergRequest(catalogRequest('details=42671'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.gutenberg.org/ebooks/42671.opds',
      expect.anything(),
    )
    expect(response.headers.get('Cache-Control')).toContain('max-age=300')
    expect(await response.json()).toEqual(BOOK_DETAILS)
  })

  it('rejects a details id that is not a number', async () => {
    const response = await handleGutenbergRequest(catalogRequest('details=../search.opds'), {
      fetch: fetchMock as unknown as typeof fetch,
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tells a missing book apart from an unavailable catalog', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    const missing = await handleGutenbergRequest(catalogRequest('details=99999999'), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(missing.status).toBe(404)
    expect(await errorMessage(missing)).toBe('Gutenberg has no book #99999999.')

    // A record for some other book is not an answer for this one.
    fetchMock.mockResolvedValueOnce(new Response(BOOK_FEED, { status: 200 }))
    const wrong = await handleGutenbergRequest(catalogRequest('details=1342'), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(wrong.status).toBe(502)
    expect(wrong.headers.get('Cache-Control')).toBe('no-store')
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

describe('parseSearchFeed', () => {
  it('keeps book entries, decodes text, and skips author and subject links', () => {
    expect(parseSearchFeed(SEARCH_FEED)).toEqual([
      { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
      { id: 10471, title: 'The World’s Greatest Books & More' },
    ])
  })

  it('leaves an out-of-range character reference alone rather than throwing', () => {
    const feed =
      '<entry><id>https://www.gutenberg.org/ebooks/1.opds</id><title>A &#99999999; B</title></entry>'
    expect(parseSearchFeed(feed)).toEqual([{ id: 1, title: 'A &#99999999; B' }])
  })
})

describe('parseBookFeed', () => {
  it('keeps a subject that names a person out of the contributors', () => {
    const feed = BOOK_FEED.replace(
      '<p>Subject: Love stories</p>',
      '<p>Subject: Austen, Jane, 1775-1817 -- Correspondence</p>',
    )
    const book = parseBookFeed(feed, 42671)

    expect(book?.people.map((person) => person.name)).toEqual(['Jane Austen', 'R. W. Chapman'])
    expect(book?.subjects).toContain('Austen, Jane, 1775-1817 -- Correspondence')
  })

  it('leaves no markup behind from nested tags', () => {
    const feed = BOOK_FEED.replace('Love stories', 'Love <<b>script>stories &lt;3')

    expect(parseBookFeed(feed, 42671)?.subjects).toContain('Love script>stories <3')
  })

  it('keeps titles and suffixes after a reordered name', () => {
    const feed = BOOK_FEED.replace(
      'Austen, Jane, 1775-1817',
      'Tolstoy, Leo, graf, 1828-1910',
    ).replace('<name>Austen, Jane</name>', '<name>Tolstoy, Leo, graf</name>')

    expect(parseBookFeed(feed, 42671)?.people[0]).toEqual({
      role: 'Author',
      name: 'Leo Tolstoy, graf',
      dates: '1828-1910',
    })
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
    fetchMock.mockImplementation(async () => new Response(SEARCH_FEED))
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
