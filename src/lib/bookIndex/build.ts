import ePub from 'epubjs'
import { db } from '../../db/db'
import type { BookChunk } from '../../db/types'
import { newId } from '../id'
import { extractChunks } from './extract'

/**
 * Builds and stores a book's chunk index.
 *
 * Bump this when chunking changes shape: a stored index at an older version is
 * rebuilt rather than mixed with new chunks.
 */
export const INDEX_VERSION = 1

/** One build at a time per book, so opening a book twice cannot double-index it. */
const inFlight = new Map<string, Promise<void>>()

export interface IndexProgress {
  bookId: string
  chunkCount: number
}

/**
 * Indexes a book unless it already has a current index.
 *
 * Runs to completion in memory and commits once, rather than streaming chunks
 * into the database. Extraction is parsing, not inference -- seconds, not the
 * tens of minutes a local model would take -- so an interrupted build is cheaper
 * to redo than to resume, and nothing ever reads a half-built index. That
 * changes the day a model writes the notes; see `local-agent-plan.md`.
 */
export function ensureBookIndex(bookId: string, signal?: AbortSignal): Promise<void> {
  // A build already running keeps the signal it started with. There is one
  // reader, so the second caller is the same screen re-mounting, and abandoning
  // its predecessor's crawl to start an identical one wastes the work done.
  const existing = inFlight.get(bookId)
  if (existing) return existing

  const run = build(bookId, signal)
    .catch(() => {
      // The index is an enhancement. A book that will not index still reads, and
      // still chats with exactly the context it had before this existed.
    })
    .finally(() => {
      if (inFlight.get(bookId) === run) inFlight.delete(bookId)
    })

  inFlight.set(bookId, run)
  return run
}

async function build(bookId: string, signal?: AbortSignal): Promise<void> {
  const [state, stored] = await Promise.all([
    db.bookIndexState.get(bookId),
    db.books.get(bookId),
  ])
  if (state?.version === INDEX_VERSION) return
  if (!stored) return

  const buffer = await stored.file.arrayBuffer()

  // A separate epub.js instance from the reader's. Sharing one would mean
  // `section.unload()` clearing a document the rendition is displaying from, and
  // the indexer walks every section by design.
  const book = ePub(buffer)
  try {
    await book.ready
    const nav = await book.loaded.navigation

    const chunks = await extractChunks(book, {
      toc: nav?.toc ?? [],
      yieldToUi: idle,
      cancelled: () => signal?.aborted ?? false,
    })
    // A cancelled crawl returns what it had reached, which is a book missing its
    // second half. Committing that would mark it current and never rebuild it.
    if (signal?.aborted) return

    const charCount = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
    const rows: BookChunk[] = chunks.map((chunk) => ({
      id: newId(),
      bookId,
      index: chunk.index,
      href: chunk.href,
      cfiStart: chunk.cfiStart,
      chapter: chunk.chapter,
      chapterStarts: chunk.chapterStarts,
      // Character offset rather than epub.js locations: the crawl counts
      // characters anyway, and locations may not be generated yet when a book is
      // opened for the first time. Retrieval compares CFIs, so this figure is
      // only ever shown to a person or used as a fallback.
      progress: charCount ? chunk.charOffset / charCount : 0,
      text: chunk.text,
    }))

    // Recorded even when nothing came out. A book the crawl cannot read -- scans
    // with no text layer, or a spine epub.js will not parse -- fails the same way
    // every time, and without a state row it is re-crawled in full on every open
    // for as long as the reader keeps the book.
    await db.transaction('rw', [db.bookChunks, db.bookIndexState], async () => {
      await db.bookChunks.where('bookId').equals(bookId).delete()
      await db.bookChunks.bulkAdd(rows)
      await db.bookIndexState.put({
        bookId,
        version: INDEX_VERSION,
        chunkCount: rows.length,
        charCount,
        builtAt: Date.now(),
      })
    })
  } finally {
    try {
      book.destroy()
    } catch {
      // epub.js can throw when torn down mid-load; there is nothing to recover.
    }
  }
}

/** Hands the thread back between spine documents. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
      }
    ).requestIdleCallback

    if (ric) ric(() => resolve(), { timeout: 500 })
    else window.setTimeout(resolve, 0)
  })
}
