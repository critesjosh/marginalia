import type { Book as EpubBook } from 'epubjs'
import type { Book } from '../db/types'
import { fingerprint } from './fingerprint'
import { newId } from './id'

export class EpubImportError extends Error {}

/**
 * Font obfuscation scrambles embedded fonts, not prose. epub.js does not
 * deobfuscate, so these books open with a fallback typeface rather than not
 * at all.
 */
const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
])

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
    const fileHash = await fingerprint(buffer)
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
      fileHash,
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

/**
 * Resources whose encryption actually stops us: the readable content. Anything
 * else in encryption.xml — fonts, images, stylesheets — can stay encrypted and
 * the book still opens, so it is not grounds for turning a reader away.
 */
const READABLE_CONTENT = /\.(x?html?|opf|ncx)$/i

function directChild(parent: Element, localName: string): Element | undefined {
  return Array.from(parent.children).find((el) => el.localName === localName)
}

/** The resource an <EncryptedData> entry covers, per its <CipherReference>. */
function encryptedTarget(entry: Element): string | undefined {
  const cipherData = directChild(entry, 'CipherData')
  const reference = cipherData && directChild(cipherData, 'CipherReference')
  const uri = reference?.getAttribute('URI')
  if (!uri) return undefined

  const path = uri.split(/[?#]/)[0]
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * Returns true only when encryption.xml gives positive evidence that the book's
 * readable content is encrypted with something we cannot read. Everything short
 * of that — font obfuscation, encrypted images, an unparseable file, an entry
 * naming no resource — is let through: a book that renders is worth more than a
 * confident refusal, and epub.js will fail loudly enough if it truly cannot
 * read the content.
 */
export function hasUnsupportedEncryption(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return false

  const entries = Array.from(doc.getElementsByTagNameNS('*', 'EncryptedData'))

  return entries.some((entry) => {
    const target = encryptedTarget(entry)
    if (!target || !READABLE_CONTENT.test(target)) return false

    // Read the algorithm off the entry itself: an <EncryptionMethod> nested in
    // <KeyInfo> describes how the key is wrapped, not the resource.
    const algorithm = directChild(entry, 'EncryptionMethod')?.getAttribute('Algorithm')
    return !algorithm || !FONT_OBFUSCATION_ALGORITHMS.has(algorithm)
  })
}

/** Detects encryption that prevents Marginalia from reading EPUB content. */
async function hasDrm(book: EpubBook): Promise<boolean> {
  try {
    const archive = book.archive as unknown as {
      getText(url: string): Promise<string | undefined>
    }
    const xml = await archive.getText('/META-INF/encryption.xml')
    return Boolean(xml && hasUnsupportedEncryption(xml))
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
