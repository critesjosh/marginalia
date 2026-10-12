import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import type { Book, PublishedLink } from '../db/types'
import {
  bookCardFor,
  coverHash,
  liveLink,
  readSharedBook,
  publishBook,
  republishBook,
  unpublishBook,
} from '../lib/bookLink'
import { readGutenbergId } from '../lib/epub'
import { PublishError } from '../lib/publish'
import { readBookFile } from '../lib/storedFile'
import { bookShare, prefersShareSheet, shareContent } from '../lib/share'
import { useModal } from '../lib/useModal'
import BookCover from './BookCover'
import { Challenge } from './PublishDialog'
import { button } from './ui'

/**
 * Shares a book at a link that adds it to the recipient's library, with this
 * reader's cover as the preview. Nothing is sent until they confirm, and only
 * Project Gutenberg books qualify: the recipient's copy comes from there.
 * See `docs/decisions/0007-shared-book-links.md`.
 */
export default function ShareBookDialog({ book, onClose }: { book: Book; onClose: () => void }) {
  // Live, so the dialog follows the link this device saves or removes.
  const current = useLiveQuery(() => db.books.get(book.id), [book.id]) ?? book
  const published = liveLink(current)
  // Undefined while the EPUB is read; null when it is not a Gutenberg book.
  const [gutenbergId, setGutenbergId] = useState<number | null>()
  // Why the EPUB could not be read, such as bytes the browser lost.
  const [readError, setReadError] = useState<string>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [note, setNote] = useState<string>()
  // Passing the check only unlocks the button: publishing waits for the tap.
  const [token, setToken] = useState<string>()
  // Tokens are single use, so a failed attempt remounts the check for a fresh one.
  const [challenge, setChallenge] = useState(0)
  // A new link this device failed to save or remove; kept so removal can be retried.
  const [unsaved, setUnsaved] = useState<PublishedLink>()
  const sheet = prefersShareSheet()

  // A live link this device could not save holds the only owner token, so the
  // dialog stays open until it is removed, and while a request that could
  // produce one is still in flight.
  function dismiss() {
    if (working) return
    if (unsaved) {
      setError(
        'Remove the link before closing. Otherwise it stays public with no way to remove it.',
      )
    } else onClose()
  }
  const ref = useModal<HTMLDivElement>(dismiss, '[data-cancel]')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Through the stored-file path, which recovers a bundled book whose bytes were lost.
        const bytes = book.file ? await readBookFile(book, book.file) : undefined
        const id = bytes ? await readGutenbergId(bytes) : undefined
        if (!cancelled) setGutenbergId(id ?? null)
      } catch (err) {
        if (cancelled) return
        setReadError(err instanceof Error ? err.message : 'Could not read this book.')
        setGutenbergId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [book])

  async function run(action: () => Promise<void>) {
    setWorking(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setWorking(false)
    }
  }

  // The preview is meant to show the cover the reader has now, so a link sent
  // with an older one is brought up to date before it is shared again. An
  // unchanged one is still checked, since the link may have been taken down.
  const linkId = published?.id
  useEffect(() => {
    if (!linkId || !gutenbergId) return
    void run(async () => {
      const stored = await db.books.get(book.id)
      const link = stored && liveLink(stored)
      if (!stored || !link) return
      const hash = await coverHash(stored.cover)
      try {
        if (hash === link.coverHash) {
          await readSharedBook(link.id)
          return
        }
        const updated = await republishBook(link, await bookCardFor(stored, gutenbergId))
        await db.books.update(book.id, {
          sharedLink: { ...link, ...updated, coverHash: hash, publishedAt: Date.now() },
        })
      } catch (err) {
        // Expired or removed elsewhere: forget it, and offer a new link.
        if (err instanceof PublishError && err.status === 404) {
          await db.books.update(book.id, { sharedLink: undefined })
          return
        }
        throw err
      }
    })
  }, [linkId, gutenbergId, current.cover, book.id])

  const create = () =>
    run(async () => {
      if (!token || !gutenbergId) return
      try {
        const hash = await coverHash(current.cover)
        const link = await publishBook(await bookCardFor(current, gutenbergId), token)
        const publishedAt = Date.now()
        const saved = await db.books
          .update(book.id, { sharedLink: { ...link, coverHash: hash, publishedAt } })
          .catch(() => 0)
        // Without its owner token on this device the link could never be removed.
        if (!saved) {
          const removed = await unpublishBook(link).then(
            () => true,
            () => false,
          )
          if (removed) throw new Error('Could not save the link on this device, so it was removed.')
          setUnsaved({ ...link, publishedAt })
          throw new Error(
            'Could not save the link on this device, and it is still live. Remove it before closing.',
          )
        }
      } catch (err) {
        setToken(undefined)
        setChallenge((count) => count + 1)
        throw err
      }
    })

  const removeUnsaved = () =>
    run(async () => {
      if (!unsaved) return
      await unpublishBook(unsaved)
      setUnsaved(undefined)
      setNote('The link was removed.')
    })

  const remove = () =>
    run(async () => {
      if (!published) return
      await unpublishBook(published)
      await db.books.update(book.id, { sharedLink: undefined })
      onClose()
    })

  async function share() {
    if (!published) return
    // A desktop copies the invitation even where a share sheet exists.
    const host = sheet ? navigator : { clipboard: navigator.clipboard }
    const outcome = await shareContent(bookShare(current, published.url), host)
    if (outcome === 'copied') setNote('Invitation copied to the clipboard.')
    else if (outcome === 'failed') setNote('Could not share. Copy the link above instead.')
  }

  const unsupported = gutenbergId === null ? (readError ?? unsupportedReason(book)) : undefined
  // Known to be a Gutenberg book, so a link can be made.
  const shareable = typeof gutenbergId === 'number'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-book-title"
        className="w-full max-w-sm rounded-lg border border-rule bg-paper-leaf p-6 text-ink shadow-sheet"
      >
        <div className="flex items-center gap-4">
          <div className="h-[72px] w-12 shrink-0 overflow-hidden rounded-[2px_5px_5px_2px] shadow-book">
            <BookCover book={current} compact />
          </div>
          <div className="min-w-0">
            <h2 id="share-book-title" className="font-book text-heading font-medium">
              Share book
            </h2>
            <p className="truncate font-ui text-meta text-ink-soft">{current.title}</p>
          </div>
        </div>

        {gutenbergId === undefined ? (
          <p className="mt-4 font-ui text-body text-ink-soft">Checking the book…</p>
        ) : unsupported ? (
          <p className="mt-4 font-ui text-body text-ink-soft">{unsupported}</p>
        ) : published ? (
          <>
            <input
              readOnly
              value={published.url}
              aria-label="Link to this book"
              onFocus={(e) => e.currentTarget.select()}
              className="mt-4 min-h-tap w-full rounded-md border border-rule-strong bg-paper px-3 font-ui text-meta text-ink"
            />
            <p className="mt-2 font-ui text-meta text-ink-soft">
              Opening it adds the book to the recipient’s library. The link works until{' '}
              {new Date(published.expiresAt).toLocaleDateString()}.
            </p>
          </>
        ) : (
          <>
            <p className="mt-4 font-ui text-body text-ink-soft">
              Creates a link that adds this book to anyone’s Rami library. Its preview shows your
              cover, the title and the author, and nothing else from your library. The link lasts a
              year, and you can remove it from here.
            </p>
            <Challenge key={challenge} onToken={setToken} onError={setError} />
          </>
        )}

        <p aria-live="polite" className="mt-3 font-ui text-meta text-ink-soft empty:hidden">
          {working ? 'Working…' : note}
        </p>
        {error && <p className="mt-3 font-ui text-meta text-danger">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {published && (
            <button onClick={() => void remove()} disabled={working} className={button.danger}>
              Remove link
            </button>
          )}
          <button data-cancel onClick={dismiss} className={button.secondary}>
            {published || unsupported ? 'Done' : 'Cancel'}
          </button>
          {shareable && published && (
            <button onClick={() => void share()} disabled={working} className={button.primary}>
              {sheet ? 'Share' : 'Copy invitation'}
            </button>
          )}
          {shareable && !published && unsaved && (
            <button
              onClick={() => void removeUnsaved()}
              disabled={working}
              className={button.danger}
            >
              Remove link
            </button>
          )}
          {shareable && !published && !unsaved && (
            <button
              onClick={() => void create()}
              disabled={working || !token}
              className={button.primary}
            >
              Create link
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function unsupportedReason(book: Pick<Book, 'file'>): string {
  if (!book.file) return 'Add this book’s EPUB again to share it.'
  return 'Only books from Project Gutenberg can be shared. The recipient’s copy comes from there, and this book was added from a file.'
}
