import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { archiveBook, db, deleteBook } from '../db/db'
import type { Book } from '../db/types'
import { EpubImportError } from '../lib/epub'
import { importEpub } from '../lib/importBook'
import { retireHint, useRetireOnceSeen, useSeenHints } from '../lib/hints'
import { FIRST_RUN_BOOK, seedSampleBooks } from '../lib/sampleBook'
import { telemetry } from '../lib/telemetry'
import { useModal } from '../lib/useModal'
import AddBookDialog from '../components/AddBookDialog'
import CoverPickerDialog from '../components/CoverPickerDialog'
import FirstRunHint from '../components/FirstRunHint'
import HintNote from '../components/HintNote'
import InstallBanner from '../components/InstallBanner'
import RemoveBookDialog from '../components/RemoveBookDialog'
import ShareBookDialog from '../components/ShareBookDialog'
import BookCover from '../components/BookCover'
import Ornament from '../components/Ornament'
import Ribbon from '../components/Ribbon'
import Wordmark from '../components/Wordmark'
import { ChatIcon, GearIcon, MoreIcon, PlusIcon, TrashIcon } from '../components/Icons'
import { button, iconButton } from '../components/ui'

const COFFEE_URL = 'https://buymeacoffee.com/critesjosh'
const X_URL = 'https://x.com/rami_reader'

export default function LibraryPage() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [seeding, setSeeding] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmRemove, setConfirmRemove] = useState<Book>()
  const [showAddBook, setShowAddBook] = useState(false)
  const [changeCover, setChangeCover] = useState<Book>()
  const [shareBook, setShareBook] = useState<Book>()

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

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setImporting(true)
    setError(undefined)
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        await importEpub(file)
        telemetry.recordImport('file')
      } catch (err) {
        telemetry.recordImport(
          'file',
          err,
          err instanceof EpubImportError ? 'invalid_epub' : undefined,
        )
        failures.push(
          `${file.name}: ${err instanceof EpubImportError ? err.message : 'Import failed.'}`,
        )
      }
    }
    if (failures.length) setError(failures.join('\n'))
    setImporting(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  const continuing = books?.find((book) => book.lastOpenedAt)
  const highlightCount = useLiveQuery(() => db.highlights.count(), [])
  const seenHints = useSeenHints()
  // Both wait for settings and the thread count, so neither flashes past.
  const hintsReady = seenHints !== undefined && chatCounts !== undefined
  // A reader who already chats never needs the card.
  const showHint =
    hintsReady && !seenHints.includes('library') && Object.keys(chatCounts).length === 0
  // The ⋯ note waits for a visit without the card, so the two never stack.
  const [cardShown, setCardShown] = useState(false)
  if (showHint && !cardShown) setCardShown(true)
  const showShelfHint =
    hintsReady && !seenHints.includes('shelf') && !showHint && !cardShown && Boolean(books?.length)
  const shelfHintSeen = useRetireOnceSeen('shelf', showShelfHint)

  return (
    <div className="paper-grain min-h-full bg-paper text-ink">
      <header className="pt-safe sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-page items-center justify-between px-4 sm:h-[72px] sm:px-8">
          <Link to="/" aria-label="Rami, your library" className="rounded-md">
            <Wordmark size={28} />
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/settings" aria-label="Settings" className={iconButton}>
              <GearIcon />
            </Link>
            <button
              onClick={() => setShowAddBook(true)}
              disabled={importing}
              aria-label="Add book"
              className={`${button.primary} max-sm:!px-3`}
            >
              <PlusIcon />
              <span className="hidden sm:inline">{importing ? 'Adding…' : 'Add book'}</span>
            </button>
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

      <main className="mx-auto max-w-page px-4 pt-10 pb-16 sm:px-8 sm:pt-16 sm:pb-24">
        <section className="mb-8 flex items-end justify-between gap-6">
          <div>
            <p className="eyebrow mb-2">Your library</p>
            <h1 className="font-book text-[40px] leading-[44px] font-medium tracking-[-0.01em] sm:text-display">
              {greeting()}
            </h1>
          </div>
          {books && (
            <p className="hidden shrink-0 font-ui text-meta text-ink-faint sm:block">
              {plural(books.length, 'book')}
              {highlightCount ? ` · ${plural(highlightCount, 'highlight')}` : ''}
            </p>
          )}
        </section>

        {error && (
          <div className="mb-6 rounded-md border border-danger bg-paper-leaf p-3 font-ui text-meta whitespace-pre-line text-danger">
            {error}
          </div>
        )}

        {showHint && (
          <FirstRunHint
            tryLink={firstRunLink(books)}
            onDismiss={() => void retireHint('library', 'dismissed')}
            onFollow={() => void retireHint('library', 'link')}
          />
        )}

        {continuing && <ContinueCard book={continuing} />}

        {books && books.length === 0 && !seeding && (
          <EmptyState onPick={() => setShowAddBook(true)} />
        )}

        {books && books.length === 0 && seeding && (
          <p className="mt-24 text-center font-ui text-body text-ink-soft italic">
            Setting out the shelf…
          </p>
        )}

        {books && books.length > 0 && (
          <section className={continuing ? 'mt-12' : ''}>
            <h2 className="mb-6 font-book text-heading font-medium">All books</h2>
            {showShelfHint && (
              <div className="mb-6 max-w-[640px]">
                <HintNote
                  label="The book menu"
                  onDismiss={() => void retireHint('shelf', 'dismissed')}
                  onSeen={shelfHintSeen}
                >
                  Tap ⋯ beside a book to change its cover or, for a Project Gutenberg book, share it
                  with someone.
                </HintNote>
              </div>
            )}
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 min-[640px]:grid-cols-3 min-[1024px]:grid-cols-4">
              {books.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  chatCount={chatCounts?.[book.id] ?? 0}
                  onShare={() => setShareBook(book)}
                  onChangeCover={() => setChangeCover(book)}
                  onDelete={() => setConfirmRemove(book)}
                />
              ))}
              <li>
                <button
                  onClick={() => setShowAddBook(true)}
                  disabled={importing}
                  className="flex aspect-2/3 w-full flex-col items-center justify-center rounded-[3px_8px_8px_3px] border border-dashed border-rule-strong px-3 text-center text-ink-soft transition-colors duration-150 hover:bg-paper-sunk"
                >
                  <span className="mb-4 grid h-11 w-11 place-items-center rounded-full border border-rule-strong">
                    <PlusIcon className="h-5 w-5" />
                  </span>
                  <strong className="font-ui text-label font-medium">
                    {importing ? 'Adding…' : 'Add a book'}
                  </strong>
                  <small className="mt-1.5 font-ui text-caption text-ink-faint">
                    Kept privately on this device
                  </small>
                </button>
              </li>
            </ul>
          </section>
        )}

        {archived && archived.length > 0 && (
          <ArchivedShelf books={archived} chatCounts={chatCounts} onDelete={setConfirmRemove} />
        )}
      </main>

      <footer className="pb-safe mx-auto max-w-page px-4 sm:px-8">
        <p className="border-t border-rule py-8 text-center font-ui text-body text-ink-soft">
          Rami is made by one reader. If it has kept you good company,{' '}
          <a
            href={COFFEE_URL}
            target="_blank"
            rel="noreferrer"
            className="text-moss underline underline-offset-2 hover:text-moss-deep"
          >
            buy me a coffee
          </a>
          . Follow along on{' '}
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            className="text-moss underline underline-offset-2 hover:text-moss-deep"
          >
            X
          </a>
          .
        </p>
      </footer>

      <InstallBanner />

      {showAddBook && (
        <AddBookDialog
          onClose={() => setShowAddBook(false)}
          onChooseFile={() => {
            setShowAddBook(false)
            fileInput.current?.click()
          }}
          onImport={importEpub}
        />
      )}

      {shareBook && <ShareBookDialog book={shareBook} onClose={() => setShareBook(undefined)} />}

      {changeCover && (
        <CoverPickerDialog book={changeCover} onClose={() => setChangeCover(undefined)} />
      )}

      {confirmRemove && (
        <RemoveBookDialog
          book={confirmRemove}
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

/** Opens at Chapter 1 the first time, and at the saved place after that. */
function firstRunLink(books?: Book[]) {
  const book = books?.find((candidate) => candidate.id === FIRST_RUN_BOOK.id)
  if (!book) return undefined
  const path = `/book/${book.id}`
  return book.lastCfi ? path : `${path}?cfi=${encodeURIComponent(FIRST_RUN_BOOK.start)}`
}

function greeting(now = new Date()) {
  const hour = now.getHours()
  if (hour < 5) return 'A quiet hour for reading'
  if (hour < 12) return 'A good morning for reading'
  if (hour < 18) return 'A good afternoon for reading'
  return 'A good evening for reading'
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "12 minutes ago", "yesterday", "last week": coarse, like a shelf label. */
function readingStatus(book: Book): string {
  if (book.missingFileAt) return 'EPUB missing · Add the same file again'
  if (book.lastOpenedAt) return lastRead(book.lastOpenedAt)
  return 'Not yet opened'
}

function lastRead(timestamp: number, now = Date.now()) {
  const minutes = Math.round((timestamp - now) / 60_000)
  if (minutes > -1) return 'just now'
  if (minutes > -60) return RELATIVE.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return RELATIVE.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (days > -7) return RELATIVE.format(days, 'day')
  const weeks = Math.round(days / 7)
  if (weeks > -5) return RELATIVE.format(weeks, 'week')
  return new Date(timestamp).toLocaleDateString()
}

function ContinueCard({ book }: { book: Book }) {
  const navigate = useNavigate()
  const progress = Math.round((book.progress ?? 0) * 100)

  return (
    <button
      onClick={() => navigate(`/book/${book.id}`)}
      aria-label={`Continue reading ${book.title}`}
      className="group grid w-full max-w-[640px] grid-cols-[84px_1fr] items-center gap-6 rounded-lg border border-rule bg-paper-leaf p-6 text-left shadow-leaf min-[560px]:grid-cols-[104px_1fr] min-[560px]:px-8"
    >
      <div className="aspect-2/3 overflow-hidden rounded-[3px_8px_8px_3px] shadow-book transition-transform duration-300 ease-out group-hover:-translate-y-[3px] group-hover:rotate-[0.25deg] motion-reduce:transform-none">
        <BookCover book={book} compact />
      </div>
      <div className="min-w-0">
        <p className="eyebrow">Continue reading</p>
        <h2 className="mt-1.5 mb-1 line-clamp-2 font-book text-[28px] leading-8 font-medium">
          {book.title}
        </h2>
        <p className="mb-4 truncate font-book text-[17px] leading-6 text-ink-soft italic">
          {book.author}
        </p>
        <Ribbon progress={progress} className="max-w-[370px]" />
      </div>
    </button>
  )
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="mt-20 text-center">
      <p className="mx-auto max-w-xs font-ui text-body text-ink-soft">
        Every book starts somewhere. Add one to begin.
      </p>
      <p className="mx-auto mt-2 max-w-xs font-ui text-meta text-ink-faint">
        Find one on Project Gutenberg or add a DRM-free EPUB. Books stay on this device.
      </p>
      <button onClick={onPick} className={`${button.primary} mt-6`}>
        <PlusIcon />
        Add book
      </button>
      <Ornament short className="mt-10" />
    </div>
  )
}

function BookCard({
  book,
  chatCount,
  onShare,
  onChangeCover,
  onDelete,
}: {
  book: Book
  chatCount: number
  onShare: () => void
  onChangeCover: () => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const progress = Math.round((book.progress ?? 0) * 100)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <li className="group min-w-0">
      <button
        onClick={() => navigate(`/book/${book.id}`)}
        aria-label={`${book.title}, ${book.author}`}
        className="relative block aspect-2/3 w-full overflow-hidden rounded-[3px_8px_8px_3px] text-left shadow-book transition-transform duration-300 ease-out hover:-translate-y-[3px] hover:rotate-[0.25deg] motion-reduce:transform-none"
      >
        <BookCover book={book} />

        {chatCount > 0 && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-sm bg-paper-leaf px-[7px] py-0.5 font-ui text-caption font-medium text-rubric">
            <ChatIcon className="h-3 w-3" />
            {chatCount}
          </span>
        )}
      </button>

      <div className="flex items-start justify-between gap-2 pt-3">
        <div className="min-w-0">
          <h3 className="line-clamp-2 font-book text-book-title font-medium">{book.title}</h3>
          <p className="mt-0.5 truncate font-ui text-meta text-ink-soft">{book.author}</p>
          {progress > 0 && <Ribbon progress={progress} showPercent={false} className="mt-2" />}
          <span className="mt-1 block font-ui text-caption text-ink-faint">
            {readingStatus(book)}
          </span>
        </div>
        <div className="relative -mr-2 shrink-0">
          <button
            onClick={() => setMenuOpen(true)}
            aria-label={`More for ${book.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={iconButton}
          >
            <MoreIcon />
          </button>
          {menuOpen && (
            <BookMenu
              onClose={() => setMenuOpen(false)}
              items={[
                { label: 'Share book', action: onShare },
                { label: 'Change cover', action: onChangeCover },
                { label: 'Remove book', action: onDelete },
              ]}
            />
          )}
        </div>
      </div>
    </li>
  )
}
/** The actions behind a book's ⋯ button. Closes on Escape, an outside tap, or a choice. */
function BookMenu({
  items,
  onClose,
}: {
  items: { label: string; action: () => void }[]
  onClose: () => void
}) {
  const ref = useModal<HTMLDivElement>(onClose)

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="menu"
        className="absolute right-0 bottom-full z-30 mb-1 min-w-44 overflow-hidden rounded-md border border-rule bg-paper-leaf py-1 shadow-sheet"
      >
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            onClick={() => {
              onClose()
              item.action()
            }}
            className="block min-h-tap w-full px-4 text-left font-ui text-control text-ink transition-colors duration-150 hover:bg-paper-sunk"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
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
    <section className="mt-16">
      <Ornament />
      <h2 className="font-book text-heading font-medium">Removed books</h2>
      <p className="mt-1 max-w-reading font-ui text-body text-ink-soft">
        Their threads, highlights and memory are kept. Add the same EPUB again to pick up where you
        left off.
      </p>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
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
  return (
    <li className="flex items-center gap-3 rounded-md border border-rule bg-paper-leaf p-2.5">
      <div className="h-14 w-10 shrink-0 overflow-hidden rounded-[2px_5px_5px_2px] shadow-book">
        <BookCover book={book} compact />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-book text-book-title font-medium">{book.title}</p>
        <p className="truncate font-ui text-meta text-ink-soft">{book.author}</p>
        <Link
          to={`/book/${book.id}/chats`}
          className="inline-block font-ui text-meta text-moss underline underline-offset-2"
        >
          {chatCount === 1 ? '1 thread' : `${chatCount} threads`} and memory
        </Link>
      </div>

      <button
        onClick={onDelete}
        aria-label={`Delete ${book.title} and its notes`}
        className={iconButton}
      >
        <TrashIcon />
      </button>
    </li>
  )
}
