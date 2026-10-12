/**
 * Sharing a book at a link (`shared/books.ts` serves it). Only the title,
 * author, Project Gutenberg id and a downscaled copy of the cover leave the
 * device. Never the EPUB, the reading position or anything written in it.
 */

import type { Book, PublishedBookLink, PublishedLink } from '../db/types'
import { fingerprint } from './fingerprint'
import { call, removeLink } from './publish'

/** Tried in turn until one fits under the server's 256 KB cap. */
const COVER_HEIGHTS = [900, 640, 420]
const MAX_COVER_BYTES = 240 * 1024

export interface BookCardSnapshot {
  book: { title: string; author: string; gutenbergId: number }
  /** Base64 JPEG. */
  cover?: string
}

/** What `GET /api/books/<id>` returns: enough for the recipient to add the book. */
export interface SharedBook {
  book: { title: string; author: string; gutenbergId: number }
  cover: boolean
}

export async function bookCardFor(
  book: Pick<Book, 'title' | 'author' | 'cover'>,
  gutenbergId: number,
): Promise<BookCardSnapshot> {
  const cover = book.cover ? await coverJpeg(book.cover) : undefined
  return {
    book: { title: book.title, author: book.author ?? '', gutenbergId },
    ...(cover ? { cover } : {}),
  }
}

/** The book's link, unless it has expired; an expired one is replaced on the next share. */
export function liveLink(
  book: Pick<Book, 'sharedLink'>,
  now = Date.now(),
): PublishedBookLink | undefined {
  const link = book.sharedLink
  return link && link.expiresAt > now ? link : undefined
}

/** Identifies the cover a link was sent with, so a changed cover can be sent again. */
export async function coverHash(cover: Blob | undefined): Promise<string> {
  return cover ? fingerprint(await cover.arrayBuffer()) : 'none'
}

/**
 * The cover as a JPEG small enough for a preview card. Redrawing it also drops
 * whatever metadata an uploaded photo carried, such as where it was taken.
 * Undefined when the image cannot be decoded; the link then shows the app icon.
 */
async function coverJpeg(cover: Blob): Promise<string | undefined> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(cover)
  } catch {
    return undefined
  }
  try {
    for (const height of COVER_HEIGHTS) {
      const scale = Math.min(1, height / bitmap.height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) return undefined
      // JPEG has no transparency; without this a transparent PNG turns black.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.85),
      )
      if (jpeg && jpeg.size <= MAX_COVER_BYTES) return toBase64(jpeg)
    }
    return undefined
  } finally {
    bitmap.close()
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // In chunks: spreading a whole image into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function publishBook(
  snapshot: BookCardSnapshot,
  turnstileToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Omit<PublishedLink, 'publishedAt'>> {
  return call(fetcher, '/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...snapshot, turnstileToken }),
  })
}

export function republishBook(
  link: Pick<PublishedBookLink, 'id' | 'ownerToken'>,
  snapshot: BookCardSnapshot,
  fetcher: typeof fetch = fetch,
): Promise<Pick<PublishedLink, 'id' | 'url' | 'expiresAt'>> {
  return call(fetcher, `/api/books/${link.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.ownerToken}` },
    body: JSON.stringify(snapshot),
  })
}

/** Resolves once the link is gone, including when it had already expired. */
export function unpublishBook(
  link: Pick<PublishedBookLink, 'id' | 'ownerToken'>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  return removeLink(`/api/books/${link.id}`, link.ownerToken, fetcher)
}

export function readSharedBook(
  id: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SharedBook> {
  return call(fetcher, `/api/books/${encodeURIComponent(id)}`, { signal })
}
