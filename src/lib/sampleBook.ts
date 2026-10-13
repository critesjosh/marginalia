import { db, getSettings, restoreBook, saveSettings } from '../db/db'
import type { Book } from '../db/types'
import { parseEpubFile } from './epub'

interface SampleBook {
  /**
   * Fixed, rather than generated per import. Two tabs opened at once on a fresh
   * profile both see an empty library and both fetch, and `inFlight` only guards
   * one JavaScript realm. Sharing a primary key means the second insert loses to
   * a ConstraintError instead of producing a second copy of the book.
   *
   * Claiming the flag before the fetch would also prevent it, but a first run
   * that is offline would then never retry.
   */
  id: string
  filename: string
  /** Lets a shared link for the same book open this copy instead of downloading another. */
  gutenbergId: number
  /**
   * Replaces what the OPF says, when Gutenberg metadata
   * does not survive contact with the UI. The Genealogy's `dc:title` is the
   * whole collected-works citation, which fills the reader's header bar and
   * leaves no room for anything else. This also goes to the model as book
   * metadata, so this is not only cosmetic.
   *
   * Applied here rather than by rewriting the EPUBs, so the shipped files stay
   * byte-identical to Gutenberg's and the edit stays visible in review.
   */
  title?: string
  author?: string
}

/**
 * Public-domain shelf shipped in `public/` so a first-time visitor has
 * something to read without finding an EPUB first.
 *
 * Listed in the order they should appear on the shelf.
 */
const SAMPLE_BOOKS: SampleBook[] = [
  { id: 'sample-moby-dick', filename: 'moby-dick.epub', gutenbergId: 2701 },
  {
    id: 'sample-genealogy-of-morals',
    filename: 'genealogy-of-morals.epub',
    gutenbergId: 52319,
    title: 'The Genealogy of Morals',
    author: 'Friedrich Nietzsche',
  },
  { id: 'sample-king-james-bible', filename: 'king-james-bible.epub', gutenbergId: 10 },
]

/**
 * Where the library's first-run hint sends a new reader: Moby Dick's opening
 * chapter rather than its cover, which has no text to select. A TOC href, as
 * the reader's table of contents passes it, so it rests on the shipped file.
 */
export const FIRST_RUN_BOOK = {
  id: 'sample-moby-dick',
  start: '8047383309311746791_2701-h-0.htm.xhtml#pgepubid00006',
}

const SAMPLE_IDS = new Set(SAMPLE_BOOKS.map((sample) => sample.id))

export function isSampleBookId(id: string): boolean {
  return SAMPLE_IDS.has(id)
}

/** StrictMode mounts effects twice in dev; one import attempt is enough. */
let inFlight: Promise<boolean> | undefined

/**
 * Adds the sample books on a first run, and records that it did so — deleting
 * them is meant to stick, so this never runs a second time on the same device.
 *
 * Resolves true when a book was added. Failures resolve false: the empty
 * library is a perfectly good fallback, and offline first runs will hit this.
 */
export function seedSampleBooks(): Promise<boolean> {
  inFlight ??= run().finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function run(): Promise<boolean> {
  try {
    const settings = await getSettings()
    if (settings.sampleBookSeeded) return false

    // Someone arriving with a library already built does not need the samples.
    // Rows this function put there do not count, or a run that seeded two of
    // three and failed on the last one would call the library built and set the
    // flag on its retry, stranding the book that never arrived.
    const existing = await db.books.toCollection().primaryKeys()
    if (existing.some((id) => !SAMPLE_IDS.has(id))) {
      await saveSettings({ sampleBookSeeded: true })
      return false
    }

    // A book offered by an earlier, partly failed run is not offered again: it
    // would be fetched, parsed and hashed only for `add` to reject the id it
    // already has, and if the reader has deleted it since, the retry would put
    // it back. Row presence cannot answer this — a book that was deleted and a
    // book that never arrived both leave no row.
    const offered = new Set(settings.seededSampleIds ?? [])

    // `addedAt` is otherwise whenever each parallel fetch happened to finish,
    // and the shelf sorts on it. Space them by position in the list, not by
    // position among the pending ones, so a retry lands them in the same order
    // a clean run would have.
    const addedAt = Date.now()
    const added = await Promise.all(
      SAMPLE_BOOKS.map((sample, index) =>
        offered.has(sample.id) ? false : seed(sample, addedAt - index),
      ),
    )
    if (!added.some(Boolean)) return false

    const seeded = SAMPLE_BOOKS.filter(
      (sample, index) => offered.has(sample.id) || added[index],
    ).map((sample) => sample.id)

    // The one-shot flag goes on only once every book has been offered, so a
    // partial first run retries the ones that are missing and only those.
    await saveSettings({
      seededSampleIds: seeded,
      sampleBookSeeded: seeded.length === SAMPLE_BOOKS.length,
    })
    return true
  } catch {
    // Retried on the next visit, since the flag is only set on success.
    return false
  }
}

/** A bundled book, freshly fetched and parsed. Undefined for any other id; throws if the fetch fails. */
export async function fetchSampleBook(id: string): Promise<Book | undefined> {
  const sample = SAMPLE_BOOKS.find((candidate) => candidate.id === id)
  if (!sample) return undefined
  const book = await fetchSample(sample)
  if (!book) throw new Error(`Could not fetch ${sample.filename}.`)
  return book
}

/**
 * Shelves the bundled copy of a Gutenberg book, for a shared link that names
 * one, and returns its id. Undefined when no sample is that book, or its file
 * could not be fetched.
 *
 * A fresh Gutenberg download differs byte for byte from the shipped file, so
 * downloading would stand a second copy beside the sample the reader already
 * has, or one that seeding adds later. A sample they removed comes back with
 * its notes, but only if the bundle is still the edition those notes were
 * taken in; otherwise the caller adds a fresh copy beside it.
 */
export async function shelveSampleBook(
  gutenbergId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const sample = SAMPLE_BOOKS.find((candidate) => candidate.gutenbergId === gutenbergId)
  if (!sample) return undefined
  const shelved = await db.books.get(sample.id)
  if (shelved && !shelved.archivedAt && !shelved.missingFileAt) return sample.id

  const book = await fetchSample(sample).catch(() => undefined)
  if (!book || signal?.aborted) return undefined
  if (shelved) {
    if (!shelved.fileHash || shelved.fileHash !== book.fileHash) return undefined
    await restoreBook(sample.id, book)
    return sample.id
  }

  // The same file imported by hand after the sample was deleted: open that
  // copy, or give it its EPUB back, rather than adding another.
  const imported = await db.books.filter((row) => row.fileHash === book.fileHash).first()
  if (imported) {
    if (imported.archivedAt || imported.missingFileAt) await restoreBook(imported.id, book)
    return imported.id
  }

  await db.books.add(book).catch((err: { name?: string } | undefined) => {
    // Seeding in another tab got there first; the book is on the shelf either way.
    if (err?.name !== 'ConstraintError') throw err
  })
  return sample.id
}

async function fetchSample(sample: SampleBook): Promise<Book | undefined> {
  const response = await fetch(`/books/${sample.filename}`)
  if (!response.ok) return undefined

  const book = await parseEpubFile(await response.blob(), sample.filename)
  return {
    ...book,
    id: sample.id,
    title: sample.title ?? book.title,
    author: sample.author ?? book.author,
  }
}

async function seed(sample: SampleBook, addedAt: number): Promise<boolean> {
  try {
    const book = await fetchSample(sample)
    if (!book) return false

    await db.books.add({ ...book, addedAt })
    return true
  } catch (err) {
    // A second tab beat us to this row. The book is on the shelf either way,
    // and treating it as a failure would keep the flag from ever being set.
    return (err as { name?: string } | undefined)?.name === 'ConstraintError'
  }
}
