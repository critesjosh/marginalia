import { describe, expect, it, vi } from 'vitest'
import { downloadGutenbergBook, searchGutenberg } from './gutenberg.ts'

describe('searchGutenberg', () => {
  it('normalizes Gutendex results and URL-encodes the search', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          {
            id: 1342,
            title: 'Pride and Prejudice',
            authors: [{ name: 'Austen, Jane' }],
            languages: ['en'],
            formats: { 'image/jpeg': 'https://example.test/cover.jpg' },
            download_count: 123,
          },
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
        author: 'Austen, Jane',
        languages: ['en'],
        coverUrl: 'https://example.test/cover.jpg',
        downloadCount: 123,
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
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        headers: { 'Content-Type': 'application/epub+zip' },
      }),
    ) as unknown as typeof fetch

    const file = await downloadGutenbergBook(
      {
        id: 2701,
        title: 'Moby-Dick: or, The Whale?',
        author: 'Melville, Herman',
        languages: ['en'],
        downloadCount: 10,
      },
      undefined,
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith('/api/gutenberg?book=2701', { signal: undefined })
    expect(file.name).toBe('Moby-Dick or, The Whale.epub')
    expect(file.type).toBe('application/epub+zip')
    expect(file.size).toBe(4)
  })
})
