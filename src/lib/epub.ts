import type { Book as EpubBook } from 'epubjs'
import type { Book } from '../db/types'
import { newId } from './id'

export class EpubImportError extends Error {}

/**
 * epub.js pulls in JSZip and is by far the largest dependency. The library page
 * only needs it once someone actually picks a file, so load it on demand and
 * keep it out of the initial bundle.
 */
async function loadEpubJs() {
  const module = await import('epubjs')
  return module.default
}

async function extractCover(book: EpubBook): Promise<Blob | undefined> {
  try {
    const coverHref = await book.loaded.cover
    if (!coverHref) return undefined
    const archive = book.archive as unknown as {
      getBlob(url: string): Promise<Blob | undefined>
    }
    // `cover` is relative to the OPF; resolve it against the package path.
    const resolved = book.resolve(coverHref)
    return await archive.getBlob(resolved)
  } catch {
    return undefined
  }
}

/** Reads OPF metadata + cover out of an EPUB file and builds a Book record. */
export async function parseEpubFile(file: File | Blob, filename?: string): Promise<Book> {
  const buffer = await file.arrayBuffer()
  if (!looksLikeZip(buffer)) {
    throw new EpubImportError('That file is not a valid EPUB (expected a ZIP archive).')
  }

  const ePub = await loadEpubJs()
  const book = ePub(buffer)
  try {
    await book.opened
    const meta = await book.loaded.metadata
    if (meta.rights?.toLowerCase().includes('drm') || (await hasDrm(book))) {
      throw new EpubImportError('This EPUB is DRM-protected and cannot be opened.')
    }
    const cover = await extractCover(book)
    const fallbackTitle = (filename ?? 'Untitled').replace(/\.epub$/i, '')

    return {
      id: newId(),
      title: meta.title?.trim() || fallbackTitle,
      author: meta.creator?.trim() || 'Unknown author',
      publisher: meta.publisher?.trim() || undefined,
      published: meta.pubdate?.trim() || undefined,
      description: stripHtml(meta.description)?.slice(0, 2000) || undefined,
      language: meta.language || undefined,
      cover,
      file: file instanceof File ? file.slice(0, file.size, 'application/epub+zip') : file,
      addedAt: Date.now(),
    }
  } catch (err) {
    if (err instanceof EpubImportError) throw err
    throw new EpubImportError(
      `Could not read that EPUB: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    book.destroy()
  }
}

/** EPUBs are ZIPs; check the local file header before handing it to epub.js. */
function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false
  const sig = new Uint8Array(buffer, 0, 4)
  return sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04
}

/** Adobe/other DRM leaves an encryption.xml in META-INF. */
async function hasDrm(book: EpubBook): Promise<boolean> {
  try {
    const archive = book.archive as unknown as {
      getText(url: string): Promise<string | undefined>
    }
    const xml = await archive.getText('/META-INF/encryption.xml')
    return Boolean(xml && xml.includes('EncryptedData'))
  } catch {
    return false
  }
}

function stripHtml(html?: string): string | undefined {
  if (!html) return undefined
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent?.replace(/\s+/g, ' ').trim() || undefined
}
