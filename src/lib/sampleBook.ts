import { db, getSettings, saveSettings } from '../db/db'
import { parseEpubFile } from './epub'

/**
 * Public-domain Moby Dick (Project Gutenberg #2701), shipped in `public/` so a
 * first-time visitor has something to read without finding an EPUB first.
 */
const SAMPLE_URL = '/books/moby-dick.epub'
const SAMPLE_FILENAME = 'moby-dick.epub'

/** StrictMode mounts effects twice in dev; one import attempt is enough. */
let inFlight: Promise<boolean> | undefined

/**
 * Adds the sample book on a first run, and records that it did so — deleting it
 * is meant to stick, so this never runs a second time on the same device.
 *
 * Resolves true when a book was added. Failures resolve false: the empty
 * library is a perfectly good fallback, and offline first runs will hit this.
 */
export function seedSampleBook(): Promise<boolean> {
  inFlight ??= run().finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function run(): Promise<boolean> {
  try {
    const settings = await getSettings()
    if (settings.sampleBookSeeded) return false

    // Someone arriving with a library already built does not need the sample.
    if ((await db.books.count()) > 0) {
      await saveSettings({ sampleBookSeeded: true })
      return false
    }

    const response = await fetch(SAMPLE_URL)
    if (!response.ok) return false

    const book = await parseEpubFile(await response.blob(), SAMPLE_FILENAME)
    await db.books.add(book)
    await saveSettings({ sampleBookSeeded: true })
    return true
  } catch {
    // Retried on the next visit, since the flag is only set on success.
    return false
  }
}
