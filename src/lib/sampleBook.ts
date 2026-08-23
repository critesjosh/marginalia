import { db, getSettings, saveSettings } from '../db/db'
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
  /**
   * Replaces what the OPF says, for the two editions whose Gutenberg metadata
   * does not survive contact with the UI. The Genealogy's `dc:title` is the
   * whole collected-works citation, which fills the reader's header bar and
   * leaves no room for anything else; Meditations' `dc:creator` is a
   * half-reversed "Emperor of Rome Marcus Aurelius". Both also go to the model
   * as book metadata, so this is not only cosmetic.
   *
   * Applied here rather than by rewriting the EPUBs, so the shipped files stay
   * byte-identical to Gutenberg's and the edit stays visible in review.
   */
  title?: string
  author?: string
}

/**
 * Public-domain shelf shipped in `public/` so a first-time visitor has
 * something to read without finding an EPUB first. Moby Dick is Project
 * Gutenberg #2701, Meditations #2680, The Genealogy of Morals #52319.
 *
 * Listed in the order they should appear on the shelf.
 */
const SAMPLE_BOOKS: SampleBook[] = [
  { id: 'sample-moby-dick', filename: 'moby-dick.epub' },
  { id: 'sample-meditations', filename: 'meditations.epub', author: 'Marcus Aurelius' },
  {
    id: 'sample-genealogy-of-morals',
    filename: 'genealogy-of-morals.epub',
    title: 'The Genealogy of Morals',
    author: 'Friedrich Nietzsche',
  },
]

const SAMPLE_IDS = new Set(SAMPLE_BOOKS.map((sample) => sample.id))

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

async function seed(sample: SampleBook, addedAt: number): Promise<boolean> {
  try {
    const response = await fetch(`/books/${sample.filename}`)
    if (!response.ok) return false

    const book: Book = await parseEpubFile(await response.blob(), sample.filename)
    await db.books.add({
      ...book,
      id: sample.id,
      addedAt,
      title: sample.title ?? book.title,
      author: sample.author ?? book.author,
    })
    return true
  } catch (err) {
    // A second tab beat us to this row. The book is on the shelf either way,
    // and treating it as a failure would keep the flag from ever being set.
    return (err as { name?: string } | undefined)?.name === 'ConstraintError'
  }
}
