import { useEffect, useState, type ReactNode } from 'react'
import { getGutenbergDetails, type CatalogDetails } from '../lib/gutenberg'
import { button } from './ui'
import { BackIcon } from './Icons'

type Details = CatalogDetails & { coverUrl: string }

/**
 * One Gutenberg book's catalog record, inside the add-book dialog. Editions
 * often share a title, so this shows what tells them apart: who edited or
 * translated it, when Gutenberg released it, and how many people read it.
 */
export default function BookDetails({
  id,
  adding,
  addDisabled,
  addError,
  onAdd,
  onBack,
  onOpenEdition,
}: {
  id: number
  adding: boolean
  addDisabled: boolean
  addError?: string
  onAdd: (book: { id: number; title: string }) => void
  onBack: () => void
  onOpenEdition: (id: number) => void
}) {
  const [book, setBook] = useState<Details>()
  const [error, setError] = useState<string>()
  // Bumped by Retry to re-run the effect for the same book.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setBook(undefined)
    setError(undefined)
    getGutenbergDetails(id, controller.signal)
      .then(setBook)
      .catch((err) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Could not load details for that book.')
      })
    return () => controller.abort()
  }, [id, attempt])

  return (
    <div className="mt-4">
      <button type="button" data-details-back onClick={onBack} className={`${button.quiet} -ml-3`}>
        <BackIcon />
        Back to results
      </button>

      {!book && !error && (
        <p className="mt-3 font-ui text-meta text-ink-soft">Loading details for #{id}…</p>
      )}
      {error && (
        <div className="mt-3 flex items-start justify-between gap-3">
          <p className="font-ui text-meta text-danger">{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className={`${button.secondary} shrink-0`}
          >
            Retry
          </button>
        </div>
      )}

      {book && (
        <article aria-labelledby="book-details-title" className="mt-3">
          <div className="flex gap-4">
            <div className="relative h-36 w-24 shrink-0 overflow-hidden rounded bg-rule shadow-book">
              <span className="absolute inset-0 flex items-center justify-center px-1 text-center font-ui text-caption text-ink-faint">
                No cover
              </span>
              <img
                src={book.coverUrl}
                alt=""
                className="relative h-full w-full object-cover"
                onError={(event) => {
                  event.currentTarget.hidden = true
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="book-details-title" className="font-book text-book-title font-medium">
                {book.title}
              </h3>
              {book.alternateTitle && (
                <p className="font-book text-[15px] text-ink-soft italic">
                  Also known as {book.alternateTitle}
                </p>
              )}
              <ul className="mt-1 font-ui text-meta text-ink-soft">
                {book.people.map((person) => (
                  <li key={`${person.role}:${person.name}`}>
                    {person.role === 'Author' ? '' : `${person.role}: `}
                    <span className="text-ink">{person.name}</span>
                    {person.dates && ` (${person.dates})`}
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-ui text-caption text-ink-faint">{editionLine(book)}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={addDisabled}
              onClick={() => onAdd(book)}
              className={button.primary}
            >
              {adding ? 'Adding…' : 'Add to library'}
            </button>
            <a
              href={`https://www.gutenberg.org/ebooks/${book.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className={button.quiet}
            >
              View on gutenberg.org
            </a>
          </div>
          {addError && <p className="mt-3 font-ui text-meta text-danger">{addError}</p>}

          {book.summary && <p className="mt-4 font-ui text-control">{book.summary}</p>}

          <dl className="mt-4 space-y-3 font-ui text-meta">
            {book.otherEditions.length > 0 && (
              <Field label="Other editions">
                <div className="-ml-3 flex flex-wrap gap-1">
                  {book.otherEditions.map((other) => (
                    <button
                      key={other}
                      type="button"
                      onClick={() => onOpenEdition(other)}
                      className={button.quiet}
                    >
                      #{other}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {book.notes.map((note) => (
              <Field key={note} label="Note">
                {note}
              </Field>
            ))}
            {book.contents && (
              <Field label="Contents">
                <span className="line-clamp-4">{book.contents}</span>
              </Field>
            )}
            {book.subjects.length > 0 && <Field label="Subjects">{book.subjects.join('; ')}</Field>}
            {book.readingLevel && <Field label="Reading ease">{book.readingLevel}</Field>}
            {book.credits && <Field label="Produced by">{book.credits}</Field>}
          </dl>
        </article>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-ink-soft">{children}</dd>
    </div>
  )
}

/** "#42671 · Released May 9, 2013 · English · 14,621 downloads in the last 30 days" */
function editionLine(book: Details): string {
  return [
    `#${book.id}`,
    book.released && `Released ${book.released}`,
    book.language,
    book.downloads !== undefined &&
      `${book.downloads.toLocaleString()} downloads in the last 30 days`,
  ]
    .filter(Boolean)
    .join(' · ')
}
