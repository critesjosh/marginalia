import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { readSharedBook } from '../lib/bookLink'
import { parseGutenbergRef } from '../lib/gutenberg'
import { addGutenbergBook } from '../lib/importBook'
import { PublishError } from '../lib/publish'
import { telemetry } from '../lib/telemetry'
import { button } from '../components/ui'

/**
 * Where a shared link lands, in one of two ways:
 *
 * - `/b/<id>`: a book another reader shared from Rami (`shared/books.ts`).
 * - `/add`: the manifest registers this as a share target, so a Gutenberg book
 *   page shared out of the browser arrives here as a query string.
 *
 * Either way the reader already decided what they wanted by opening the link,
 * so this page just adds the book and opens it. There is nothing to confirm.
 */
export default function AddSharedPage() {
  const { linkId } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [title, setTitle] = useState<string>()

  // Share sheets disagree about which field carries a link. Android browsers
  // commonly put it in `text`, often after the page title, so take the first
  // URL found there.
  const shared = params.get('url') ?? params.get('text') ?? ''
  const id = parseGutenbergRef(shared.match(/https?:\/\/\S+/i)?.[0] ?? shared)?.id

  useEffect(() => {
    if (!linkId && id === undefined) {
      setError(shared ? 'That link is not a Project Gutenberg book page.' : 'No link was shared.')
      return
    }

    // The abort is what keeps StrictMode's double-invoke from importing the
    // book twice: the first run is canceled before it can finish, and the
    // checks below stop a canceled run from storing or navigating anyway.
    const controller = new AbortController()
    void (async () => {
      try {
        let gutenbergId = id
        if (linkId) {
          const link = await readSharedBook(linkId, controller.signal)
          if (controller.signal.aborted) return
          setTitle(link.book.title)
          gutenbergId = link.book.gutenbergId
        }
        if (gutenbergId === undefined) return
        const bookId = await addGutenbergBook(gutenbergId, controller.signal)
        telemetry.recordImport('shared_link')
        if (controller.signal.aborted) return
        // Replace, so going back does not re-run the import.
        navigate(`/book/${bookId}`, { replace: true })
      } catch (err) {
        if (controller.signal.aborted) return
        telemetry.recordImport('shared_link', err)
        setError(failure(err))
      }
    })()

    return () => controller.abort()
  }, [linkId, id, shared, navigate])

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-paper px-6 text-center text-ink">
      {error ? (
        <>
          <p className="font-ui text-meta text-danger">{error}</p>
          {!linkId && (
            <p className="max-w-xs font-ui text-meta text-ink-soft">
              Share a book page such as https://www.gutenberg.org/ebooks/2701, or add the book from
              the library.
            </p>
          )}
        </>
      ) : (
        <p className="font-ui text-meta text-ink-soft">{progress(linkId, title, id)}</p>
      )}
      <Link to="/" className={button.secondary}>
        Go to library
      </Link>
    </div>
  )
}

function progress(linkId?: string, title?: string, gutenbergId?: number): string {
  if (!linkId) return `Adding book #${gutenbergId} from Project Gutenberg…`
  if (title) return `Adding ${title} to your library…`
  return 'Opening the shared book…'
}

function failure(err: unknown): string {
  if (err instanceof PublishError && err.status === 404) {
    return 'This link is no longer available. It expired or its owner removed it.'
  }
  return err instanceof Error ? err.message : 'Could not add that book.'
}
