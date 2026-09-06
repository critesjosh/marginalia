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
 * Paths in encryption.xml and in epub.js both point at ZIP entries, but only
 * one of them arrives with a leading slash and percent-encoding intact.
 */
function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0]
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // A malformed escape is not worth failing over; compare the raw path.
  }
  return decoded.replace(/^\.?\//, '')
}

function directChild(parent: Element, localName: string): Element | undefined {
  return Array.from(parent.children).find((el) => el.localName === localName)
}

/** The resource an <EncryptedData> entry covers, per its <CipherReference>. */
function encryptedTarget(entry: Element): string | undefined {
  const cipherData = directChild(entry, 'CipherData')
  const reference = cipherData && directChild(cipherData, 'CipherReference')
  const uri = reference?.getAttribute('URI')
  return uri ? normalizePath(uri) : undefined
}

/**
 * Returns true only when encryption.xml says a document the reader actually
 * has to render — one in the spine — is encrypted with something we cannot
 * read. epub.js decrypts nothing, so there is no book we turn away here that
 * we could have opened anyway.
 *
 * Everything else is let through: font obfuscation, encrypted images, an
 * unparseable file, an entry naming no resource, and encrypted documents that
 * are not in the spine (stale metadata for a file the book no longer uses is
 * no reason to refuse the book).
 */
export function hasUnsupportedEncryption(
  xml: string,
  spinePaths: Iterable<string>,
): boolean {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) return false

  const spine = new Set(Array.from(spinePaths, normalizePath))
  if (spine.size === 0) return false

  const entries = Array.from(doc.getElementsByTagNameNS('*', 'EncryptedData'))

  return entries.some((entry) => {
    const target = encryptedTarget(entry)
    if (!target || !spine.has(target)) return false

    // Read the algorithm off the entry itself: an <EncryptionMethod> nested in
    // <KeyInfo> describes how the key is wrapped, not the resource.
    const algorithm = directChild(entry, 'EncryptionMethod')?.getAttribute('Algorithm')
    return !algorithm || !FONT_OBFUSCATION_ALGORITHMS.has(algorithm)
  })
}

/** Spine documents as ZIP-relative paths, to match encryption.xml's URIs. */
function spinePaths(book: EpubBook): string[] {
  const spine = book.spine as unknown as { items?: { href?: string }[] }
  const paths: string[] = []
  for (const item of spine.items ?? []) {
    const resolved = item.href && book.resolve(item.href)
    if (resolved) paths.push(resolved)
  }
  return paths
}

/** Detects encryption that prevents Marginalia from reading EPUB content. */
async function hasDrm(book: EpubBook): Promise<boolean> {
  try {
    const archive = book.archive as unknown as {
      getText(url: string): Promise<string | undefined>
    }
    const xml = await archive.getText('/META-INF/encryption.xml')
    return Boolean(xml && hasUnsupportedEncryption(xml, spinePaths(book)))
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
