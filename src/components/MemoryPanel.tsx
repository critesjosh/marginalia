import { useEffect, useRef, useState } from 'react'
import type { Book, BookIndexState, BookMemory, Conversation, Settings } from '../db/types'
import type { BookContext } from '../lib/bookIndex/retrieve'
import { saveBookMemory } from '../lib/memory'
import { buildSystemPrompt, type PromptContext } from '../lib/prompt'

/**
 * What the companion knows about one book, and a way to change it.
 *
 * The digest is the only thing the app carries between conversations, so it is
 * also the only thing a reader cannot infer from the transcripts. Showing it
 * verbatim -- alongside the whole system message it ends up inside -- means the
 * answers the model gives can be traced back to what it was told.
 */
export default function MemoryPanel({
  book,
  memory,
  latest,
  bookContext,
  indexState,
  settings,
}: {
  book?: Book
  memory?: BookMemory
  /** Most recent conversation, used to show the prompt as it was last sent. */
  latest?: Conversation
  /** What the on-device index would contribute to that conversation. */
  bookContext?: BookContext
  indexState?: BookIndexState
  settings: Settings
}) {
  const stored = memory?.summary ?? ''
  const [draft, setDraft] = useState(stored)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  // Read by `commit` after its write resolves, by which point `draft` may have
  // moved on.
  const draftRef = useRef(draft)
  draftRef.current = draft

  // Digest updates land in the background after a reply. Adopt them, but never
  // over the top of an edit the reader is in the middle of writing.
  useEffect(() => {
    if (!dirty) setDraft(stored)
  }, [stored, dirty])

  if (!book) return null

  const context: PromptContext = latest ?? { progress: book.progress }
  const prompt = buildSystemPrompt({
    book,
    conversation: context,
    memory: draft,
    bookContext,
    spoilerGuard: settings.spoilerGuard,
  })

  const commit = async (text: string) => {
    await saveBookMemory(book.id, text)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2000)

    // Only call it clean if it still is. Typing during the write would
    // otherwise be marked saved, and the effect above would then replace those
    // keystrokes with the text that actually went to disk.
    if (draftRef.current === text) setDirty(false)
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
          What the companion remembers
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
          A running digest of your conversations about this book, written by the model and
          sent with every message. Edit it to correct what it thinks, or to tell it
          something it never worked out on its own.
        </p>

        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setDirty(true)
          }}
          rows={10}
          placeholder="Nothing yet. The companion starts a digest after a few exchanges, or you can write one here."
          className="mt-3 w-full resize-y rounded-xl border border-stone-800 bg-stone-900/60 p-3 text-sm leading-relaxed text-stone-200 outline-none placeholder:text-stone-600 focus:border-stone-600"
        />

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void commit(draft)}
            disabled={!dirty}
            className="rounded-lg bg-amber-500 px-3.5 py-2 text-sm font-medium text-stone-950 disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => {
              setDraft('')
              setDirty(true)
            }}
            disabled={!draft}
            className="rounded-lg border border-stone-800 px-3.5 py-2 text-sm text-stone-300 disabled:opacity-40"
          >
            Clear
          </button>
          <span className="text-xs text-stone-500">
            {saved
              ? 'Saved'
              : dirty
                ? 'Unsaved changes'
                : memory
                  ? `Updated ${new Date(memory.updatedAt).toLocaleDateString()}`
                  : ''}
          </span>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
          What this device found in the book
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
          {settings.bookIndex
            ? indexState
              ? `This book is indexed as ${indexState.chunkCount} passages, read straight out of the
                 EPUB on this device. When you start a chat, the ones matching your highlight from
                 earlier in the book are sent along with it — never anything past where you are.`
              : 'Not indexed yet. Open the book and leave it a moment; it is built while you read.'
            : 'Turned off in Settings, so chats carry only the passage you highlighted and the text around it.'}
        </p>
        {bookContext && (
          <p className="mt-2 text-sm text-stone-500">
            For your most recent conversation it found{' '}
            <span className="text-stone-300">
              {bookContext.excerpts.length === 0
                ? 'no matching earlier passages'
                : `${bookContext.excerpts.length} earlier ${
                    bookContext.excerpts.length === 1 ? 'passage' : 'passages'
                  }`}
            </span>
            , across {bookContext.chapters.length}{' '}
            {bookContext.chapters.length === 1 ? 'chapter' : 'chapters'} you have reached. Both are
            in the prompt below.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-xs font-semibold tracking-wide text-stone-400 uppercase">
          Everything sent with your next message
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
          The instructions, the book’s own metadata, the digest above, and anything the index
          found, exactly as the model receives them.
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-xl border border-stone-800 bg-stone-900/60 p-3 text-xs leading-relaxed whitespace-pre-wrap text-stone-400">
          {prompt}
        </pre>
      </section>
    </div>
  )
}
