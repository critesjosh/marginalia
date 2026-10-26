import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import InstructionsEditor from './InstructionsEditor'
import { button } from './ui'
import { db } from '../db/db'
import type { Book, BookMemory, Conversation, Settings } from '../db/types'
import { MAX_SUMMARY_CHARS } from '../lib/digest'
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
  settings,
}: {
  book?: Book
  memory?: BookMemory
  /** Most recent conversation, used to show the prompt as it was last sent. */
  latest?: Conversation
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
    instructions: settings.instructions,
    spoilerGuard: settings.spoilerGuard,
    briefReplies: settings.briefReplies,
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
        <h2 className="eyebrow">How to talk about this book</h2>
        <p className="mt-1.5 font-ui text-body text-ink-soft">
          Your instructions for this book, sent with every message about it. Where they conflict
          with your{' '}
          <Link to="/settings" className="underline">
            standing instructions
          </Link>
          , these win.
        </p>
        <InstructionsEditor
          stored={book.instructions}
          label="Instructions for this book"
          placeholder="For example: Answer in simple French so I can practise."
          onSave={(instructions) => db.books.update(book.id, { instructions })}
        />
      </section>

      <section>
        <h2 className="eyebrow">What Rami remembers</h2>
        <p className="mt-1.5 font-ui text-body text-ink-soft">
          A running digest of your threads about this book, kept by Rami and sent with every
          message. Edit it to correct what it thinks, or to add a fact about your reading. Rami
          treats these notes as material, not commands; to change how it replies, use the
          instructions above.
        </p>

        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setDirty(true)
          }}
          rows={10}
          maxLength={MAX_SUMMARY_CHARS}
          placeholder="Nothing yet. Rami starts a digest after a few exchanges, or you can write one here."
          className="mt-3 w-full resize-y rounded-md border border-rule-strong bg-paper-leaf p-3 font-ui text-body text-ink placeholder:text-ink-faint"
        />

        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => void commit(draft)} disabled={!dirty} className={button.primary}>
            Save
          </button>
          <button
            onClick={() => {
              setDraft('')
              setDirty(true)
            }}
            disabled={!draft}
            className={button.secondary}
          >
            Clear
          </button>
          <span className="font-ui text-meta text-ink-soft">
            {saved
              ? 'Saved'
              : dirty
                ? 'Unsaved changes'
                : memory
                  ? `Updated ${new Date(memory.updatedAt).toLocaleDateString()}`
                  : ''}
          </span>
          {draft.length > MAX_SUMMARY_CHARS * 0.9 && (
            <span className="ml-auto font-ui text-meta text-ink-soft">
              {MAX_SUMMARY_CHARS - draft.length} characters left
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="eyebrow">Everything sent with your next message</h2>
        <p className="mt-1.5 font-ui text-body text-ink-soft">
          The instructions, including yours, the book’s own metadata, and the digest above, exactly
          as the model receives them.
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-paper-sunk p-3 text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
          {prompt}
        </pre>
      </section>
    </div>
  )
}
