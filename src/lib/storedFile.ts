import { db } from '../db/db'
import type { Book } from '../db/types'
import { idleDays, logDiagnostic } from './diagnostics'
import { readEpubCover } from './epub'
import { fetchSampleBook, isSampleBookId } from './sampleBook'

/**
 * WebKit keeps a stored Blob's bytes in a file beside the database, and on iOS
 * that file can go missing while the row survives. Reading the Blob then
 * rejects with this, worded "The object can not be found here."
 */
function isLostBlob(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'NotFoundError'
}

/** Whether a stored Blob's bytes are gone. Any other read failure is not ours to judge. */
async function isLost(blob: Blob): Promise<boolean> {
  try {
    await blob.arrayBuffer()
    return false
  } catch (err) {
    if (isLostBlob(err)) return true
    throw err
  }
}

/**
 * Mends a book whose cover was lost. WebKit refuses to write a row that still
 * holds a lost Blob, so a lost EPUB beside it is recovered in the same write;
 * otherwise the EPUB's own cover stands in for the one that is gone.
 */
export async function repairLostCover(book: Book): Promise<void> {
  if (!book.cover || !(await isLost(book.cover))) return
  if (book.file && (await isLost(book.file))) {
    await recoverLostFile(book)
    return
  }
  logDiagnostic({ type: 'lost-cover', book: bookKind(book), idleDays: idleDays(book) })
  await db.books.update(book.id, { cover: book.file && (await readEpubCover(book.file)) })
}

/** The EPUB's bytes, recovering them if they were lost. */
export async function readBookFile(stored: Book, file: Blob): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer()
  } catch (err) {
    if (!isLostBlob(err)) throw err
  }
  return recoverLostFile(stored)
}

/**
 * A bundled book is fetched again, as long as it is still the edition the
 * reading position and highlights were taken in. Anything else stays on the
 * shelf, marked as missing its EPUB: the reader did not remove it, so it must
 * not disappear (#122). Importing the same EPUB again matches it by
 * fingerprint and puts the file back under its notes.
 */
async function recoverLostFile(stored: Book): Promise<ArrayBuffer> {
  const log = (outcome: 'restored' | 'unrecoverable' | 'offline', coverLost = false) =>
    logDiagnostic({
      type: 'lost-file',
      book: bookKind(stored),
      outcome,
      coverLost,
      idleDays: idleDays(stored),
    })

  let sample: Book | undefined
  try {
    sample = await fetchSampleBook(stored.id)
  } catch {
    log('offline')
    throw new Error(
      'This book could not be read from this device. Try again when you are online to download it again.',
    )
  }

  const coverLost = stored.cover ? await isLost(stored.cover) : false

  // A row from before fingerprints were kept cannot prove its edition, so its
  // anchors are not handed to whatever is bundled now.
  if (sample?.file && stored.fileHash && sample.fileHash === stored.fileHash) {
    // A cover the reader chose is kept, unless it was lost too.
    await db.books.update(stored.id, {
      file: sample.file,
      cover: stored.cover && !coverLost ? stored.cover : sample.cover,
    })
    log('restored', coverLost)
    return sample.file.arrayBuffer()
  }

  log('unrecoverable', coverLost)
  await db.books.update(stored.id, {
    missingFileAt: Date.now(),
    file: undefined,
    ...(coverLost && { cover: undefined }),
  })
  throw new Error(
    'This device lost the EPUB for this book. Add the same EPUB again to keep reading; your highlights and conversations are safe.',
  )
}

function bookKind(book: Book): 'bundled' | 'imported' {
  return isSampleBookId(book.id) ? 'bundled' : 'imported'
}
