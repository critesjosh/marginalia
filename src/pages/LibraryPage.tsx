import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteBook } from '../db/db'
import type { Book } from '../db/types'
import { EpubImportError, parseEpubFile } from '../lib/epub'
import { seedSampleBook } from '../lib/sampleBook'
import { useBlobUrl } from '../lib/useBlobUrl'
import { useModal } from '../lib/useModal'
import { GearIcon, PlusIcon, TrashIcon } from '../components/Icons'

export default function LibraryPage() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [seeding, setSeeding] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<Book>()

  const books = useLiveQuery(() => db.books.orderBy('addedAt').reverse().toArray(), [])
  const chatCounts = useLiveQuery(async () => {
    const rows = await db.conversations.toArray()
    return rows.reduce<Record<string, number>>((acc, c) => {
      acc[c.bookId] = (acc[c.bookId] ?? 0) + 1
      return acc
    }, {})
  }, [])

  // A first-time visitor gets the bundled Moby Dick, so there is something to
  // open before they have found an EPUB of their own.
  useEffect(() => {
    let active = true
    void seedSampleBook().then(() => {
      if (active) setSeeding(false)
    })
    return () => {
      active = false
    }
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setImporting(true)
    setError(undefined)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const book = await parseEpubFile(file, file.name)
        await db.books.add(book)
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
              onClick={() => fileInput.current?.click()}
              disabled={importing}
              className="flex items-center gap-1.5 rounded-full bg-amber-500 px-3.5 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" />
              {importing ? 'Importing…' : 'Add EPUB'}
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
          <EmptyState onPick={() => fileInput.current?.click()} />
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
                onDelete={() => setConfirmDelete(book)}
              />
            ))}
          </ul>
        )}
      </main>

      {confirmDelete && (
        <ConfirmDeleteDialog
          book={confirmDelete}
          onCancel={() => setConfirmDelete(undefined)}
          onConfirm={async () => {
            await deleteBook(confirmDelete.id)
            setConfirmDelete(undefined)
          }}
        />
      )}
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
        Add a DRM-free EPUB to start reading. Books are stored on this device only.
      </p>
      <button
        onClick={onPick}
        className="mt-5 rounded-full bg-stone-800 px-4 py-2 text-sm font-medium text-stone-100"
      >
        Choose a file
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
        aria-label={`Delete ${book.title}`}
        className="absolute top-0.5 left-0.5 flex h-11 w-11 items-center justify-center rounded-full text-stone-300 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </li>
  )
}

function ConfirmDeleteDialog({
  book,
  onCancel,
  onConfirm,
}: {
  book: Book
  onCancel: () => void
  onConfirm: () => void
}) {
  // Cancel is the safe default, so focus lands there rather than on Delete.
  const ref = useModal<HTMLDivElement>(onCancel, '[data-cancel]')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        className="w-full max-w-sm rounded-xl border border-stone-800 bg-stone-900 p-5"
      >
        <h2 id="confirm-delete-title" className="text-base font-medium">
          Delete “{book.title}”?
        </h2>
        <p className="mt-1.5 text-sm text-stone-400">
          This also removes its highlights and conversations. It cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            data-cancel
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-sm font-medium text-stone-300"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-medium text-white"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
