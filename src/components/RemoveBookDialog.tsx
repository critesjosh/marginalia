import { useState } from 'react'
import type { Book, ReaderTheme } from '../db/types'
import { THEMES } from '../lib/themes'
import { useModal } from '../lib/useModal'

/** What removing the book should leave behind. */
type Choice = 'keep' | 'purge'

/**
 * Confirms removing a book, and asks what to do with the notes anchored to it.
 *
 * Keeping them shelves the book: the EPUB — the only large part of the record —
 * is dropped, while highlights, conversations and memory stay reachable and
 * come back if the same file is imported again.
 *
 * For a book that is already shelved there is nothing left to keep, so the
 * choice collapses to a plain confirmation.
 */
export default function RemoveBookDialog({
  book,
  theme,
  onCancel,
  onRemove,
}: {
  book: Book
  theme: ReaderTheme
  onCancel: () => void
  onRemove: (choice: Choice) => void | Promise<void>
}) {
  const archived = Boolean(book.archivedAt)
  const [choice, setChoice] = useState<Choice>(archived ? 'purge' : 'keep')
  const [working, setWorking] = useState(false)
  const palette = THEMES[theme]

  // Cancel is the safe default, so focus lands there rather than on Remove.
  const ref = useModal<HTMLDivElement>(onCancel, '[data-cancel]')

  async function confirm() {
    setWorking(true)
    try {
      await onRemove(choice)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-book-title"
        className={`w-full max-w-sm rounded-xl border p-5 ${palette.chrome} ${palette.chromeText} ${palette.border}`}
      >
        <h2 id="remove-book-title" className="text-base font-medium">
          {archived ? 'Delete' : 'Remove'} “{book.title}”?
        </h2>

        {archived ? (
          <p className="mt-1.5 text-sm opacity-70">
            This deletes its highlights, conversations and memory for good. It cannot be
            undone.
          </p>
        ) : (
          <fieldset className="mt-4">
            <legend className="sr-only">What to do with this book’s notes</legend>
            <ChoiceRow
              theme={theme}
              checked={choice === 'keep'}
              onSelect={() => setChoice('keep')}
              label="Keep my notes"
              hint="Frees the space the EPUB takes up. Highlights, conversations and memory are kept, and importing the book again restores them."
            />
            <ChoiceRow
              theme={theme}
              checked={choice === 'purge'}
              onSelect={() => setChoice('purge')}
              label="Delete everything"
              hint="Removes the book along with its highlights, conversations and memory. It cannot be undone."
            />
          </fieldset>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            data-cancel
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm font-medium opacity-80"
          >
            Cancel
          </button>
          <button
            onClick={() => void confirm()}
            disabled={working}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              choice === 'purge' ? 'bg-red-600' : 'bg-stone-600'
            }`}
          >
            {choice === 'purge' ? 'Delete' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ChoiceRow({
  theme,
  checked,
  onSelect,
  label,
  hint,
}: {
  theme: ReaderTheme
  checked: boolean
  onSelect: () => void
  label: string
  hint: string
}) {
  const palette = THEMES[theme]

  return (
    <label
      className={`mb-2 flex cursor-pointer gap-3 rounded-lg border p-3 ${palette.border} ${
        checked ? 'opacity-100' : 'opacity-60'
      }`}
      style={checked ? { borderColor: palette.link } : undefined}
    >
      <input
        type="radio"
        name="remove-book-choice"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 accent-amber-500"
      />
      <span className="text-sm">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-xs opacity-70">{hint}</span>
      </span>
    </label>
  )
}
