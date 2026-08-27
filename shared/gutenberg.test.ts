import { describe, expect, it, vi } from 'vitest'
import { handleGutenbergRequest } from './gutenberg'

describe('handleGutenbergRequest', () => {
  it('proxies search through Gutendex with the EPUB filter', async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [] })) as unknown as typeof fetch

    const response = await handleGutenbergRequest(
      new Request('https://marginalia.test/api/gutenberg?search=pride%20prejudice'),
      { fetch: fetcher },
    )

    expect(response.status).toBe(200)
    const [url] = fetcher.mock.calls[0]
    expect(String(url)).toContain('https://gutendex.com/books?')
    expect(String(url)).toContain('search=pride+prejudice')
    expect(String(url)).toContain('mime_type=application%2Fepub%2Bzip')
  })

  it('rejects arbitrary book paths instead of becoming an open proxy', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch

    const response = await handleGutenbergRequest(
      new Request('https://marginalia.test/api/gutenberg?book=../../etc/passwd'),
      { fetch: fetcher },
    )

    expect(response.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fetches only the stable Gutenberg EPUB3 endpoint for numeric ids', async () => {
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 }),
    ) as unknown as typeof fetch

    const response = await handleGutenbergRequest(
      new Request('https://marginalia.test/api/gutenberg?book=2701'),
      { fetch: fetcher },
    )

    expect(response.status).toBe(200)
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.gutenberg.org/ebooks/2701.epub3.images',
      expect.objectContaining({ redirect: 'follow' }),
    )
    expect(response.headers.get('content-type')).toBe('application/epub+zip')
  })
})
