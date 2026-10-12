import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  downloadGutenbergBook,
  parseGutenbergRef,
  searchGutenberg,
  type CatalogBook,
} from '../lib/gutenberg'
import { useModal } from '../lib/useModal'
import { button, iconButton } from './ui'
import { CloseIcon } from './Icons'
import BookDetails from './BookDetails'

/** How long a search may run before the dialog admits it is being slow. */
const SLOW_SEARCH_MS = 5_000

const PRIMARY_BUTTON = `${button.primary} shrink-0`

/** Searches Project Gutenberg or hands off to the device file picker. */
export default function AddBookDialog({
  onClose,
  onChooseFile,
  onImport,
}: {
  onClose: () => void
  onChooseFile: () => void
  onImport: (file: File) => Promise<string>
}) {
  const navigate = useNavigate()
  // Searching is why the dialog opens, so focus lands in the field.
  const ref = useModal<HTMLElement>(onClose, 'input[type="search"]')
  const [query, setQuery] = useState('')
  // A pasted link resolves to a book on its own; a bare number is ambiguous
  // and gets offered alongside the search rather than instead of it.
  const pastedRef = parseGutenbergRef(query)
  const [results, setResults] = useState<CatalogBook[]>([])
  const [searching, setSearching] = useState(false)
  const [slow, setSlow] = useState(false)
  const [addingId, setAddingId] = useState<number>()
  // Kept apart because only one of them is worth offering a Retry for.
  const [searchError, setSearchError] = useState<string>()
  const [addError, setAddError] = useState<string>()
  // Bumped by Retry to re-run the effect on an unchanged query.
  const [attempt, setAttempt] = useState(0)
  // Books whose details are open, newest last: following "Other editions"
  // pushes, and Back pops until the results show again.
  const [editions, setEditions] = useState<number[]>([])
  const viewing = editions.at(-1)
  // Where the reader was in the results, to put them back there.
  const opener = useRef<{ id: number; scrollTop: number }>(undefined)

  function openDetails(id: number) {
    opener.current = { id, scrollTop: ref.current?.scrollTop ?? 0 }
    setAddError(undefined)
    setEditions([id])
  }

  function showEdition(id: number) {
    setAddError(undefined)
    setEditions((open) => [...open, id])
  }

  function back() {
    setAddError(undefined)
    setEditions((open) => open.slice(0, -1))
  }

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (viewing !== undefined) {
      // The control that opened this view is gone, so focus would fall to the
      // body, where the modal's Tab trap cannot catch it.
      dialog.scrollTop = 0
      dialog.querySelector<HTMLElement>('[data-details-back]')?.focus()
      return
    }
    const from = opener.current
    if (!from) return
    opener.current = undefined
    dialog.scrollTop = from.scrollTop
    dialog.querySelector<HTMLElement>(`[data-details-for="${from.id}"]`)?.focus()
  }, [viewing, ref])

  useEffect(() => {
    const trimmed = query.trim()
    // Searching for the text of a URL can only ever return nothing.
    if (pastedRef?.source === 'url' || trimmed.length < 2) {
      setResults([])
      setSearching(false)
      setSlow(false)
      setSearchError(undefined)
      return
    }

    const controller = new AbortController()
    // Set before the debounce, not inside it: during those 350 ms the results
    // are empty, and a `searching` of false there renders "No books found."
    // for a search that has not run yet.
    setSearching(true)
    setSlow(false)
    setSearchError(undefined)

    const timer = window.setTimeout(() => {
      void searchGutenberg(trimmed, controller.signal)
        .then((books) => setResults(books))
        .catch((err) => {
          if (controller.signal.aborted) return
          setResults([])
          setSearchError(err instanceof Error ? err.message : 'Search failed.')
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearching(false)
            setSlow(false)
          }
        })
    }, 350)

    // Gutenberg is usually quick, but not always. Saying so is the difference
    // between a wait a reader will sit through and a spinner they cannot tell
    // apart from a hang.
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_SEARCH_MS)

    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(slowTimer)
      controller.abort()
    }
  }, [query, attempt, pastedRef?.source])

  // A download the reader walked away from must not land in the library or pull
  // them into the reader. The controller cancels the transfer as the dialog
  // closes; the guards cover the window after the bytes arrive.
  const download = useRef<AbortController | null>(null)
  useEffect(() => () => download.current?.abort(), [])

  async function addBook(book: { id: number; title?: string }) {
    const controller = new AbortController()
    download.current = controller
    setAddingId(book.id)
    setAddError(undefined)
    try {
      const file = await downloadGutenbergBook(book, controller.signal)
      if (controller.signal.aborted) return
      const bookId = await onImport(file)
      if (controller.signal.aborted) return
      onClose()
      navigate(`/book/${bookId}`)
    } catch (err) {
      if (controller.signal.aborted) return
      setAddError(err instanceof Error ? err.message : 'Could not add that book.')
      setAddingId(undefined)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center sm:p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-book-title"
        className="relative max-h-[88vh] w-full overflow-y-auto rounded-t-lg border border-rule bg-paper-leaf p-5 text-ink shadow-sheet sm:max-w-xl sm:rounded-lg sm:p-6"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="add-book-title" className="font-book text-heading font-medium">
              Add a book
            </h2>
            <p className="font-ui text-meta text-ink-soft">
              Search free public-domain EPUBs or import your own.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={iconButton}>
            <CloseIcon />
          </button>
        </div>

        {viewing !== undefined ? (
          <BookDetails
            key={viewing}
            id={viewing}
            adding={addingId === viewing}
            addDisabled={addingId !== undefined}
            addError={addError}
            onAdd={(book) => void addBook(book)}
            onBack={back}
            onOpenEdition={showEdition}
          />
        ) : (
          <>
            <label htmlFor="gutenberg-search" className="eyebrow mt-5 block">
              Project Gutenberg
            </label>
            <input
              id="gutenberg-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title or author"
              className="mt-2 w-full min-h-tap w-full rounded-md border border-rule-strong bg-paper px-3.5 font-ui text-control text-ink placeholder:text-ink-faint"
            />
            <p className="mt-2 font-ui text-meta text-ink-soft">
              Or paste a book link from{' '}
              <a
                href="https://www.gutenberg.org/ebooks/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-moss underline underline-offset-2"
              >
                gutenberg.org
              </a>
              .
            </p>

            {pastedRef && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-rule bg-paper/60 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Project Gutenberg #{pastedRef.id}</p>
                  <p className="mt-0.5 font-ui text-meta text-ink-soft">
                    {pastedRef.source === 'url'
                      ? 'From the link you pasted.'
                      : 'Add this book id directly.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={addingId !== undefined}
                  onClick={() => void addBook({ id: pastedRef.id })}
                  className={PRIMARY_BUTTON}
                >
                  {addingId === pastedRef.id ? 'Adding…' : 'Add'}
                </button>
              </div>
            )}

            {searching && (
              <p className="mt-3 font-ui text-meta text-ink-soft">
                {slow
                  ? 'Still searching. Project Gutenberg is slow right now…'
                  : 'Searching Project Gutenberg…'}
              </p>
            )}
            {searchError && (
              <div className="mt-3 flex items-start justify-between gap-3">
                <p className="font-ui text-meta text-danger">{searchError}</p>
                <button
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                  className={`${button.secondary} shrink-0`}
                >
                  Retry
                </button>
              </div>
            )}
            {addError && <p className="mt-3 font-ui text-meta text-danger">{addError}</p>}
            {!searching &&
              !pastedRef &&
              query.trim().length >= 2 &&
              !searchError &&
              results.length === 0 && (
                <p className="mt-3 font-ui text-meta text-ink-soft">No books found.</p>
              )}

            {results.length > 0 && (
              <ul className="mt-3 divide-y divide-rule rounded-md border border-rule bg-paper/60">
                {results.map((book) => (
                  <li key={book.id} className="flex gap-3 p-3">
                    {/* A larger target for the same action as the title, so it
                    stays out of the tab order. */}
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      onClick={() => openDetails(book.id)}
                      className="relative h-20 w-14 shrink-0 overflow-hidden rounded bg-rule"
                    >
                      <span className="absolute inset-0 flex items-center justify-center px-1 text-center font-ui text-caption text-ink-faint">
                        No cover
                      </span>
                      <img
                        src={book.coverUrl}
                        alt=""
                        className="relative h-full w-full object-cover"
                        loading="lazy"
                        // Some books have no cover; uncover the placeholder behind.
                        onError={(event) => {
                          event.currentTarget.hidden = true
                        }}
                      />
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        data-details-for={book.id}
                        onClick={() => openDetails(book.id)}
                        className="line-clamp-2 text-left font-book text-[15px] leading-snug font-medium underline decoration-rule-strong underline-offset-4 hover:decoration-moss"
                      >
                        {book.title}
                      </button>
                      <p className="mt-0.5 line-clamp-1 font-ui text-meta text-ink-soft">
                        {book.author}
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        {/* Editions often share a title; the number tells them apart. */}
                        <span className="font-ui text-caption text-ink-faint">#{book.id}</span>
                        <button
                          type="button"
                          disabled={addingId !== undefined}
                          onClick={() => void addBook(book)}
                          className={PRIMARY_BUTTON}
                        >
                          {addingId === book.id ? 'Adding…' : 'Add'}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="my-5 flex items-center gap-3 font-ui text-caption text-ink-faint">
              <div className="h-px flex-1 bg-rule" />
              or
              <div className="h-px flex-1 bg-rule" />
            </div>

            <button
              type="button"
              onClick={onChooseFile}
              className="w-full rounded-md border border-rule bg-paper px-4 py-3 text-sm font-medium transition hover:bg-paper-sunk"
            >
              Choose an EPUB from this device
            </button>
            <p className="mt-2 text-center font-ui text-caption text-ink-faint">
              Books stay stored on this device.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
