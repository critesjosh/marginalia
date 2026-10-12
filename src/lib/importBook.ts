import { db, findRestorableMatch, restoreBook } from '../db/db'
import type { Book } from '../db/types'
import { parseEpubFile } from './epub'
import { downloadGutenbergBook } from './gutenberg'
import { shelveSampleBook } from './sampleBook'

/**
 * Stores an EPUB and returns the id of the book to open.
 *
 * Importing the same file as a book that was removed but kept, or whose EPUB
 * the browser lost, picks that book back up, rather than standing a second,
 * empty copy next to the notes it belongs to.
 *
 * Shared by every way a book can arrive — the file picker, the Gutenberg
 * catalog, and a link shared to the app — so all three land in one place.
 */
export async function importEpub(
  file: File,
  { reuseShelved = false }: { reuseShelved?: boolean } = {},
): Promise<string> {
  const book = await parseEpubFile(file, file.name)

  if (reuseShelved) {
    const shelved = await findShelvedMatch(book)
    if (shelved) return shelved.id
  }

  const match = await findRestorableMatch(book)
  if (match) {
    await restoreBook(match.id, book)
    return match.id
  }

  await db.books.add(book)
  return book.id
}

/**
 * Adds the Gutenberg book a shared link names, and returns the id to open.
 * A recipient who already has that exact file gets their own copy back, not
 * a duplicate, and a book the app ships is never downloaded at all.
 */
export async function addGutenbergBook(id: number, signal?: AbortSignal): Promise<string> {
  const sample = await shelveSampleBook(id, signal)
  if (sample) return sample

  const file = await downloadGutenbergBook({ id }, signal)
  signal?.throwIfAborted()
  return importEpub(file, { reuseShelved: true })
}

/** A book already on the shelf with these exact bytes. */
function findShelvedMatch(book: Book): Promise<Book | undefined> {
  const { fileHash } = book
  if (!fileHash) return Promise.resolve(undefined)
  return db.books
    .filter((row) => !row.archivedAt && !row.missingFileAt && row.fileHash === fileHash)
    .first()
}
