import { useState } from 'react'
import type { Book } from '../db/types'
import { useModal } from '../lib/useModal'
import { button } from './ui'

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
  onCancel,
  onRemove,
}: {
  book: Book
  onCancel: () => void
  onRemove: (choice: Choice) => void | Promise<void>
}) {
  const archived = Boolean(book.archivedAt)
  const [choice, setChoice] = useState<Choice>(archived ? 'purge' : 'keep')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  // Cancel is the safe default, so focus lands there rather than on Remove.
  const ref = useModal<HTMLDivElement>(onCancel, '[data-cancel]')

  async function confirm() {
    setWorking(true)
    setError(undefined)
    try {
      await onRemove(choice)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the book.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-book-title"
        className="w-full max-w-sm rounded-lg border border-rule bg-paper-leaf p-6 text-ink shadow-sheet"
      >
        <h2 id="remove-book-title" className="font-book text-heading font-medium">
          {archived ? 'Delete' : 'Remove'} “{book.title}”?
        </h2>

        {archived ? (
          <p className="mt-1.5 font-ui text-body text-ink-soft">
            This deletes its highlights, conversations and memory for good. It cannot be undone.
          </p>
        ) : (
          <fieldset className="mt-4">
            <legend className="sr-only">What to do with this book’s notes</legend>
            <ChoiceRow
              checked={choice === 'keep'}
              onSelect={() => setChoice('keep')}
              label="Keep my notes"
              hint="Frees the space the EPUB takes up. Highlights, conversations and memory are kept, and importing the book again restores them."
            />
            <ChoiceRow
              checked={choice === 'purge'}
              onSelect={() => setChoice('purge')}
              label="Delete everything"
              hint="Removes the book along with its highlights, conversations and memory. It cannot be undone."
            />
          </fieldset>
        )}

        {error && <p className="mt-3 font-ui text-meta text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button data-cancel onClick={onCancel} className={button.secondary}>
            Cancel
          </button>
          <button
            onClick={() => void confirm()}
            disabled={working}
            className={choice === 'purge' ? button.danger : button.primary}
          >
            {choice === 'purge' ? 'Delete everything' : 'Remove book'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ChoiceRow({
  checked,
  onSelect,
  label,
  hint,
}: {
  checked: boolean
  onSelect: () => void
  label: string
  hint: string
}) {
  return (
    <label
      className={`mb-2 flex cursor-pointer gap-3 rounded-md border p-3 transition-colors duration-150 ${
        checked ? 'border-moss bg-paper' : 'border-rule hover:bg-paper-sunk'
      }`}
    >
      <input
        type="radio"
        name="remove-book-choice"
        checked={checked}
        onChange={onSelect}
        className="mt-1 accent-moss"
      />
      <span>
        <span className="block font-ui text-label font-medium">{label}</span>
        <span className="mt-1 block font-ui text-meta text-ink-soft">{hint}</span>
      </span>
    </label>
  )
}
