import { describe, expect, it, vi } from 'vitest'
import {
  gutenbergIdFromIdentifier,
  downloadGutenbergBook,
  parseGutenbergRef,
  searchGutenberg,
  type CatalogBook,
} from './gutenberg.ts'

describe('searchGutenberg', () => {
  it('maps relay results and URL-encodes the search', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
          { id: 10471, title: "The World's Greatest Books" },
        ],
      }),
    ) as unknown as typeof fetch

    const books = await searchGutenberg(' pride & prejudice ', undefined, fetcher)

    expect(fetcher).toHaveBeenCalledWith('/api/gutenberg?search=pride%20%26%20prejudice', {
      signal: undefined,
    })
    expect(books).toEqual([
      {
        id: 1342,
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
        coverUrl: 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg',
      },
      {
        id: 10471,
        title: "The World's Greatest Books",
        author: 'Unknown author',
        coverUrl: 'https://www.gutenberg.org/cache/epub/10471/pg10471.cover.medium.jpg',
      },
    ])
  })

  it('does not fetch an empty query', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(searchGutenberg('   ', undefined, fetcher)).resolves.toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('surfaces failed searches', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch
    await expect(searchGutenberg('melville', undefined, fetcher)).rejects.toThrow(
      'Could not search Project Gutenberg.',
    )
  })
})

describe('downloadGutenbergBook', () => {
  it('downloads an EPUB and gives it a safe filename', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          headers: { 'Content-Type': 'application/epub+zip' },
        }),
    ) as unknown as typeof fetch

    // Typed rather than inline, so this keeps pinning that a whole catalog
    // result is an acceptable argument even though only the id is required.
    const book: CatalogBook = {
      id: 2701,
      title: 'Moby-Dick: or, The Whale?',
      author: 'Melville, Herman',
      coverUrl: 'https://www.gutenberg.org/cache/epub/2701/pg2701.cover.medium.jpg',
    }

    const file = await downloadGutenbergBook(book, undefined, fetcher)

    expect(fetcher).toHaveBeenCalledWith('/api/gutenberg?book=2701', { signal: undefined })
    expect(file.name).toBe('Moby-Dick or, The Whale.epub')
    expect(file.type).toBe('application/epub+zip')
    expect(file.size).toBe(4)
  })
})

describe('parseGutenbergRef', () => {
  it('reads the id out of the URL shapes Gutenberg hands out', () => {
    for (const [input, id] of [
      ['https://www.gutenberg.org/ebooks/2701', 2701],
      ['https://gutenberg.org/ebooks/2701', 2701],
      ['http://www.gutenberg.org/ebooks/2701/', 2701],
      ['https://www.gutenberg.org/ebooks/2701.epub3.images', 2701],
      ['https://www.gutenberg.org/files/1342/1342-h/1342-h.htm', 1342],
      ['https://www.gutenberg.org/cache/epub/84/pg84.epub', 84],
      ['  https://www.gutenberg.org/ebooks/11?query=x#frag  ', 11],
      ['www.gutenberg.org/ebooks/2701', 2701],
    ] as const) {
      expect(parseGutenbergRef(input), input).toEqual({ id, source: 'url' })
    }
  })

  it('takes a bare number, but marks it ambiguous', () => {
    // "1984" is a book id and also a title someone might search for, so the
    // dialog has to offer both readings rather than pick one.
    expect(parseGutenbergRef('1984')).toEqual({ id: 1984, source: 'id' })
  })

  it('refuses anything that is not a Gutenberg reference', () => {
    for (const input of [
      '',
      '   ',
      'moby dick',
      'https://example.test/ebooks/2701',
      'https://gutenberg.org.evil.test/ebooks/2701',
      'https://www.gutenberg.org/about/',
      'not a url',
    ]) {
      expect(parseGutenbergRef(input), input).toBeUndefined()
    }
  })
})

describe('gutenbergIdFromIdentifier', () => {
  it('reads the identifier Gutenberg writes into its EPUBs', () => {
    expect(gutenbergIdFromIdentifier('http://www.gutenberg.org/2701')).toBe(2701)
    expect(gutenbergIdFromIdentifier(' https://gutenberg.org/ebooks/10/ ')).toBe(10)
  })

  it('ignores every other kind of identifier', () => {
    for (const identifier of [
      undefined,
      '',
      'urn:uuid:4f0c6a0e-6b0e-4a43-9b51-8c7e5e7d9a11',
      '9780142437247',
      'http://www.gutenberg.org/files/2701/2701-h/2701-h.htm',
      'http://example.com/gutenberg.org/2701',
    ]) {
      expect(gutenbergIdFromIdentifier(identifier)).toBeUndefined()
    }
  })
})
