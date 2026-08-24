import { useRef, useState } from 'react'
import { db } from '../db/db'
import type { Book } from '../db/types'
import {
  HandoffError,
  REJECTION_REASONS,
  importHandoff,
  parseHandoff,
  type Handoff,
  type ImportProgress,
  type ImportResult,
} from '../lib/koreader'

/**
 * Bringing highlights over from KOReader.
 *
 * The plugin in `koreader/` writes a JSON file into the e-reader's storage;
 * this reads it back. There is no sync service in between because there is no
 * account to sync against — everything here lives in this browser.
 *
 * The matching rule is strict on purpose. A highlight is only ever given to the
 * exact EPUB it was taken from, identified by the hash of its bytes, because
 * two editions share a title and an author while numbering their sections
 * differently, and a passage handed to the wrong one lands on unrelated text.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'working'; label: string; progress?: ImportProgress }
  | { name: 'done'; result: ImportResult; handoff: Handoff }
  | { name: 'error'; message: string }

async function openEpub(book: Book) {
  const module = await import('epubjs')
  const buffer = await (book.file as Blob).arrayBuffer()
  const epub = module.default(buffer)
  await epub.opened
  return epub
}

export default function KoreaderImport() {
  const input = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })

  async function run(file: File) {
    setPhase({ name: 'working', label: 'Reading the file…' })

    let handoff: Handoff
    try {
      handoff = parseHandoff(await file.text())
    } catch (err) {
      setPhase({
        name: 'error',
        message:
          err instanceof HandoffError
            ? err.message
            : 'That file could not be read as a KOReader export.',
      })
      return
    }

    const matches = await db.books.filter((row) => row.fileHash === handoff.sha256).toArray()
    if (matches.length === 0) {
      setPhase({
        name: 'error',
        message: `No book in your library is the same file as “${handoff.title}”. Add that exact EPUB here first — the same file you read on the e-reader, not another copy of the same book.`,
      })
      return
    }

    // Adding the same EPUB twice while it is already on the shelf makes a
    // second row: `findArchivedMatch` only reclaims books that were removed.
    // Picking one of them arbitrarily would put the highlights on whichever
    // happened to sort first, which is the failure the hash rule exists to
    // prevent — so say so instead.
    const usable = matches.filter((row) => row.file)
    if (usable.length > 1) {
      setPhase({
        name: 'error',
        message: `Your library holds ${usable.length} copies of this same file (“${usable[0].title}”), so there is no telling which one these highlights belong to. Remove the copies you don't want and import again.`,
      })
      return
    }

    const match = usable[0]
    if (!match) {
      setPhase({
        name: 'error',
        message: `“${matches[0].title}” is on the shelf but its EPUB was removed. Add the file again, then import.`,
      })
      return
    }

    try {
      const epub = await openEpub(match)
      try {
        const result = await importHandoff(handoff, match.id, epub, (progress) =>
          setPhase({
            name: 'working',
            label:
              progress.phase === 'indexing'
                ? 'Reading the book…'
                : progress.phase === 'locating'
                  ? 'Finding the passages…'
                  : 'Saving…',
            progress,
          }),
        )
        setPhase({ name: 'done', result, handoff })
      } finally {
        epub.destroy()
      }
    } catch (err) {
      setPhase({
        name: 'error',
        message: err instanceof Error ? err.message : 'The import failed.',
      })
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">Import from KOReader</h2>
      <p className="mt-1 text-sm text-stone-400">
        Highlights made on an e-reader running KOReader, brought in through the Marginalia
        plugin's export file. Each passage is found again by its text, so the import needs
        the same EPUB file that is on the e-reader.
      </p>

      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void run(file)
        }}
      />

      <button
        onClick={() => input.current?.click()}
        disabled={phase.name === 'working'}
        className="mt-3 rounded-lg border border-stone-700 px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {phase.name === 'working' ? 'Importing…' : 'Choose an export file'}
      </button>

      {phase.name === 'working' && <Working phase={phase} />}
      {phase.name === 'error' && (
        <p className="mt-3 text-sm text-red-300">{phase.message}</p>
      )}
      {phase.name === 'done' && <Summary result={phase.result} handoff={phase.handoff} />}
    </section>
  )
}

function Working({ phase }: { phase: Extract<Phase, { name: 'working' }> }) {
  const { progress } = phase
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : undefined

  return (
    <p className="mt-3 text-sm text-stone-400" aria-live="polite">
      {phase.label}
      {percent !== undefined && ` ${percent}%`}
    </p>
  )
}

function Summary({ result, handoff }: { result: ImportResult; handoff: Handoff }) {
  const added = result.highlightsAdded
  // Rejections do not make an import eventful: a re-import that places nothing
  // new still re-reports the passages it could not place, and "Imported 0
  // highlights" reads like a failure rather than like nothing to do.
  const nothingNew =
    added === 0 && result.threadsAdded === 0 && result.messagesAdded === 0

  return (
    <div className="mt-3 space-y-2 text-sm" aria-live="polite">
      <p className="text-emerald-300">
        {nothingNew
          ? `Nothing new — “${handoff.title}” was already up to date.`
          : `Imported ${added} ${added === 1 ? 'highlight' : 'highlights'}${
              result.threadsAdded > 0
                ? ` and ${result.threadsAdded} ${
                    result.threadsAdded === 1 ? 'conversation' : 'conversations'
                  }`
                : ''
            } from “${handoff.title}”.`}
      </p>

      {result.messagesAdded > 0 && (
        <p className="text-stone-400">
          {result.messagesAdded} new {result.messagesAdded === 1 ? 'turn' : 'turns'} added
          to conversations you already had.
        </p>
      )}

      {(result.highlightsSkipped > 0 || result.threadsSkipped > 0) && (
        <p className="text-stone-400">
          {result.highlightsSkipped + result.threadsSkipped} already here, left alone.
        </p>
      )}

      {result.rejected.length > 0 && (
        <details className="rounded-lg border border-stone-800 p-3">
          <summary className="cursor-pointer text-amber-300">
            {result.rejected.length}{' '}
            {result.rejected.length === 1 ? 'passage' : 'passages'} could not be placed in
            this edition
          </summary>
          <ul className="mt-2 space-y-2">
            {result.rejected.map((rejection, index) => (
              <li key={index} className="text-stone-400">
                <span className="line-clamp-2 text-stone-300">“{rejection.text}”</span>
                <span className="text-xs">{REJECTION_REASONS[rejection.failure]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            These are still in the export file, which is the record of them. They are left
            out here rather than added without a position, because a highlight that cannot
            be opened in the book is a dead end in every screen that lists it.
          </p>
        </details>
      )}
    </div>
  )
}
