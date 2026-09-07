import { db, findArchivedMatch, restoreBook } from '../db/db'
import { parseEpubFile } from './epub'

/**
 * Stores an EPUB and returns the id of the book to open.
 *
 * Importing the same file as a book that was removed but kept picks its shelf
 * back up, rather than standing a second, empty copy next to the notes it
 * belongs to.
 *
 * Shared by every way a book can arrive — the file picker, the Gutenberg
 * catalog, and a link shared to the app — so all three land in one place.
 */
export async function importEpub(file: File): Promise<string> {
  const book = await parseEpubFile(file, file.name)

  const archivedMatch = await findArchivedMatch(book)
  if (archivedMatch) {
    await restoreBook(archivedMatch.id, book)
    return archivedMatch.id
  }

  await db.books.add(book)
  return book.id
}
