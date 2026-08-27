import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { archiveBook, db, deleteBook, findArchivedMatch, restoreBook } from '../db/db'
import type { Book } from '../db/types'
import { EpubImportError, parseEpubFile } from '../lib/epub'
import {
  downloadGutenbergBook,
  searchGutenberg,
  type CatalogBook,
} from '../lib/gutenberg'
import { seedSampleBooks } from '../lib/sampleBook'
import { useBlobUrl } from '../lib/useBlobUrl'
import { useModal } from '../lib/useModal'
import RemoveBookDialog from '../components/RemoveBookDialog'
import { GearIcon, PlusIcon, TrashIcon } from '../components/Icons'

export default function LibraryPage() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [seeding, setSeeding] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmRemove, setConfirmRemove] = useState<Book>()
  const [showAddBook, setShowAddBook] = useState(false)

  // Most recently read first, so the book in progress is the one under the
  // thumb. A book that has never been opened falls back to when it arrived,
  // which puts a fresh import at the top where its reader is looking for it.
  //
  // Sorted here rather than by index: `lastOpenedAt` is only written once a book
  // has been opened, and IndexedDB leaves records with no value for a key out of
  // that key's index entirely, so ordering by it would hide every unread book.
  const shelved = useLiveQuery(
    () =>
      db.books
        .toArray()
        .then((rows) =>
          rows.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)),
        ),
    [],
  )
  const books = shelved?.filter((book) => !book.archivedAt)
  const archived = shelved?.filter((book) => book.archivedAt)
  const chatCounts = useLiveQuery(async () => {
    const rows = await db.conversations.toArray()
    return rows.reduce<Record<string, number>>((acc, c) => {
      acc[c.bookId] = (acc[c.bookId] ?? 0) + 1
      return acc
    }, {})
  }, [])

  // A first-time visitor gets the bundled public-domain shelf, so there is
  // something to open before they have found an EPUB of their own.
  useEffect(() => {
    let active = true
    void seedSampleBooks().then(() => {
      if (active) setSeeding(false)
    })
    return () => {
      active = false
    }
  }, [])

  async function importFile(file: File): Promise<string> {
    const book = await parseEpubFile(file, file.name)
    // Importing the same file as a book that was removed but kept picks its
    // shelf back up, rather than standing a second, empty copy next to the
    // notes it belongs to.
    const archivedMatch = await findArchivedMatch(book)
    if (archivedMatch) {
      await restoreBook(archivedMatch.id, book)
      return archivedMatch.id
    }
    await db.books.add(book)
    return book.id
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setImporting(true)
    setError(undefined)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        await importFile(file)
      } catch (err) {
        failures.push(
          `${file.name}: ${err instanceof EpubImportError ? err.message : 'Import failed.'}`,
        )
      }
    }
    if (failures.length) setError(failures.join('\n'))
    setImporting(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <div className="min-h-full bg-stone-950 text-stone-100">
      <header className="pt-safe sticky top-0 z-10 border-b border-stone-800 bg-stone-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 pb-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Marginalia</h1>
            <p className="text-xs text-stone-500">
              {books ? `${books.length} book${books.length === 1 ? '' : 's'}` : 'Loading…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddBook(true)}
              disabled={importing}
              className="flex items-center gap-1.5 rounded-full bg-amber-500 px-3.5 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" />
              {importing ? 'Importing…' : 'Add book'}
            </button>
            <Link
              to="/settings"
              aria-label="Settings"
              className="rounded-full p-2 text-stone-400 hover:bg-stone-800 hover:text-stone-100"
            >
              <GearIcon />
            </Link>
          </div>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <main className="mx-auto max-w-5xl px-4 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm whitespace-pre-line text-red-200">
            {error}
          </div>
        )}

        {books && books.length === 0 && !seeding && (
          <EmptyState onPick={() => setShowAddBook(true)} />
        )}

        {books && books.length === 0 && seeding && (
          <p className="mt-24 text-center text-sm text-stone-500">Setting up your library…</p>
        )}

        {books && books.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
            {books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                chatCount={chatCounts?.[book.id] ?? 0}
                onDelete={() => setConfirmRemove(book)}
              />
            ))}
          </ul>
        )}

        {archived && archived.length > 0 && (
          <ArchivedShelf
            books={archived}
            chatCounts={chatCounts}
            onDelete={setConfirmRemove}
          />
        )}
      </main>

      {showAddBook && (
        <AddBookDialog
          onClose={() => setShowAddBook(false)}
          onChooseFile={() => {
            setShowAddBook(false)
            fileInput.current?.click()
          }}
          onImport={importFile}
        />
      )}

      {confirmRemove && (
        <RemoveBookDialog
          book={confirmRemove}
          theme="dark"
          onCancel={() => setConfirmRemove(undefined)}
          onRemove={async (choice) => {
            if (choice === 'keep') await archiveBook(confirmRemove.id)
            else await deleteBook(confirmRemove.id)
            setConfirmRemove(undefined)
          }}
        />
      )}
    </div>
  )
}

function AddBookDialog({
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
  const [results, setResults] = useState<CatalogBook[]>([])
  const [searching, setSearching] = useState(false)
  const [addingId, setAddingId] = useState<number>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setSearching(false)
      setError(undefined)
      return
    }

    const controller = new AbortController()
    // Set before the debounce, not inside it: during those 350 ms the results
    // are empty, and a `searching` of false there renders "No EPUBs found."
    // for a search that has not run yet.
    setSearching(true)
    setError(undefined)

    const timer = window.setTimeout(() => {
      void searchGutenberg(trimmed, controller.signal)
        .then((books) => setResults(books))
        .catch((err) => {
          if (controller.signal.aborted) return
          setResults([])
          setError(err instanceof Error ? err.message : 'Search failed.')
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 350)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  // A download the reader walked away from must not pull them into the reader
  // when it lands. The controller cancels the transfer as the dialog closes;
  // the guards cover the window between the bytes arriving and the import
  // finishing, when there is no longer a dialog to report back to.
  const download = useRef<AbortController | null>(null)
  useEffect(() => () => download.current?.abort(), [])

  async function addBook(book: CatalogBook) {
    const controller = new AbortController()
    download.current = controller
    setAddingId(book.id)
    setError(undefined)
    try {
      const file = await downloadGutenbergBook(book, controller.signal)
      const bookId = await onImport(file)
      if (controller.signal.aborted) return
      onClose()
      navigate(`/book/${bookId}`)
    } catch (err) {
      if (controller.signal.aborted) return
      setError(
        err instanceof EpubImportError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not add that book.',
      )
      setAddingId(undefined)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center sm:justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden />
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-book-title"
        className="relative max-h-[88vh] w-full overflow-y-auto rounded-t-2xl border border-stone-800 bg-stone-950 p-4 shadow-2xl sm:max-w-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="add-book-title" className="text-lg font-semibold text-stone-100">
              Add a book
            </h2>
            <p className="text-xs text-stone-500">Search free public-domain EPUBs or import your own.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none text-stone-400 hover:bg-stone-800 hover:text-stone-100"
          >
            ×
          </button>
        </div>

        <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-stone-500">
          Project Gutenberg
        </label>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by title or author"
          className="mt-2 w-full rounded-xl border border-stone-700 bg-stone-900 px-3.5 py-3 text-base text-stone-100 outline-none placeholder:text-stone-600 focus:border-amber-500"
        />

        {searching && <p className="mt-3 text-sm text-stone-500">Searching Project Gutenberg…</p>}
        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        {!searching && query.trim().length >= 2 && !error && results.length === 0 && (
          <p className="mt-3 text-sm text-stone-500">No EPUBs found.</p>
        )}

        {results.length > 0 && (
          <ul className="mt-3 divide-y divide-stone-800 rounded-xl border border-stone-800 bg-stone-900/50">
            {results.map((book) => (
              <li key={book.id} className="flex gap-3 p-3">
                <div className="h-20 w-14 shrink-0 overflow-hidden rounded bg-stone-800">
                  {book.coverUrl ? (
                    <img src={book.coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center px-1 text-center text-[10px] text-stone-500">
                      No cover
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium text-stone-200">{book.title}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-stone-500">{book.author}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-stone-600">
                      {book.languages.join(', ').toUpperCase() || 'EPUB'}
                    </span>
                    <button
                      type="button"
                      disabled={addingId !== undefined}
                      onClick={() => void addBook(book)}
                      className="rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-stone-950 disabled:opacity-50"
                    >
                      {addingId === book.id ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="my-5 flex items-center gap-3 text-xs text-stone-600">
          <div className="h-px flex-1 bg-stone-800" />
          or
          <div className="h-px flex-1 bg-stone-800" />
        </div>

        <button
          type="button"
          onClick={onChooseFile}
          className="w-full rounded-xl border border-stone-700 bg-stone-900 px-4 py-3 text-sm font-medium text-stone-200 hover:bg-stone-800"
        >
          Choose an EPUB from this device
        </button>
        <p className="mt-2 text-center text-xs text-stone-600">Books stay stored on this device.</p>
      </section>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="mt-24 text-center">
      <div className="mx-auto mb-4 flex h-16 w-12 items-end justify-center rounded-sm border-2 border-stone-700 bg-stone-900">
        <div className="mb-2 h-1 w-6 rounded bg-stone-700" />
      </div>
      <h2 className="text-base font-medium text-stone-300">Your library is empty</h2>
      <p className="mx-auto mt-1 max-w-xs text-sm text-stone-500">
        Search Project Gutenberg or add a DRM-free EPUB to start reading.
      </p>
      <button
        onClick={onPick}
        className="mt-5 rounded-full bg-stone-800 px-4 py-2 text-sm font-medium text-stone-100"
      >
        Add a book
      </button>
    </div>
  )
}

function BookCard({
  book,
  chatCount,
  onDelete,
}: {
  book: Book
  chatCount: number
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const coverUrl = useBlobUrl(book.cover)
  const progress = Math.round((book.progress ?? 0) * 100)

  return (
    <li className="group relative">
      <button
        onClick={() => navigate(`/book/${book.id}`)}
        className="block w-full text-left"
      >
        <div className="relative aspect-2/3 w-full overflow-hidden rounded-lg bg-stone-800 shadow-lg shadow-black/40 ring-1 ring-stone-700/50">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full flex-col justify-center bg-linear-to-br from-stone-700 to-stone-900 p-3">
              <span className="line-clamp-4 text-sm font-medium text-stone-200">
                {book.title}
              </span>
              <span className="mt-1 line-clamp-2 text-xs text-stone-400">{book.author}</span>
            </div>
          )}

          {chatCount > 0 && (
            <span className="absolute top-1.5 right-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-stone-950">
              {chatCount}
            </span>
          )}

          {progress > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
              <div className="h-full bg-amber-500" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>

        <p className="mt-2 line-clamp-2 text-sm leading-snug font-medium text-stone-200">
          {book.title}
        </p>
        <p className="line-clamp-1 text-xs text-stone-500">{book.author}</p>
      </button>

      <button
        onClick={onDelete}
        aria-label={`Remove ${book.title}`}
        className="absolute top-0.5 left-0.5 flex h-11 w-11 items-center justify-center rounded-full text-stone-300 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </li>
  )
}

/**
 * Books the reader removed but chose to keep the notes for.
 *
 * Kept visible rather than silently held in storage: the conversations and
 * memory are still there, still reachable, and importing the EPUB again puts
 * the book back where it was.
 */
function ArchivedShelf({
  books,
  chatCounts,
  onDelete,
}: {
  books: Book[]
  chatCounts?: Record<string, number>
  onDelete: (book: Book) => void
}) {
  return (
    <section className="mt-10 border-t border-stone-800 pt-5">
      <h2 className="text-sm font-medium text-stone-300">Removed books</h2>
      <p className="mt-0.5 text-xs text-stone-500">
        Their conversations, highlights and memory are kept. Import the same EPUB file
        again to pick up where you left off.
      </p>

      <ul className="mt-3 space-y-2">
        {books.map((book) => (
          <ArchivedRow
            key={book.id}
            book={book}
            chatCount={chatCounts?.[book.id] ?? 0}
            onDelete={() => onDelete(book)}
          />
        ))}
      </ul>
    </section>
  )
}

function ArchivedRow({
  book,
  chatCount,
  onDelete,
}: {
  book: Book
  chatCount: number
  onDelete: () => void
}) {
  const coverUrl = useBlobUrl(book.cover)

  return (
    <li className="flex items-center gap-3 rounded-xl border border-stone-800 bg-stone-900/60 p-2.5">
      <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-stone-800">
        {coverUrl && <img src={coverUrl} alt="" className="h-full w-full object-cover" />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-200">{book.title}</p>
        <p className="truncate text-xs text-stone-500">{book.author}</p>
        <Link
          to={`/book/${book.id}/chats`}
          className="mt-0.5 inline-block text-xs text-amber-500 underline"
        >
          {chatCount === 1 ? '1 conversation' : `${chatCount} conversations`} and memory
        </Link>
      </div>

      <button
        onClick={onDelete}
        aria-label={`Delete ${book.title} and its notes`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-400 hover:text-stone-100"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </li>
  )
}
