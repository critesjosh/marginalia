import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { EpubImportError } from '../lib/epub'
import { downloadGutenbergBook, parseGutenbergRef } from '../lib/gutenberg'
import { importEpub } from '../lib/importBook'

/**
 * Where a shared link lands. The manifest registers this route as a share
 * target, so a Gutenberg book page shared out of the browser arrives here as a
 * query string. The reader already decided what they wanted by choosing
 * Marginalia from the share sheet, so this page just does it and opens the
 * book — there is nothing left to confirm.
 */
export default function AddSharedPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string>()

  // Share sheets disagree about which field carries a link — Android browsers
  // commonly put it in `text` even when it is plainly a URL — so try both.
  const shared = params.get('url') ?? params.get('text') ?? ''
  const ref = parseGutenbergRef(shared)
  const id = ref?.id

  useEffect(() => {
    if (id === undefined) {
      setError(
        shared
          ? 'That link is not a Project Gutenberg book page.'
          : 'No link was shared.',
      )
      return
    }

    // The abort is what keeps StrictMode's double-invoke from importing the
    // book twice: the first run is cancelled before it can finish, and the
    // checks below stop a cancelled run from storing or navigating anyway.
    const controller = new AbortController()
    void (async () => {
      try {
        const file = await downloadGutenbergBook({ id }, controller.signal)
        if (controller.signal.aborted) return
        const bookId = await importEpub(file)
        if (controller.signal.aborted) return
        // Replace, so going back does not re-run the import.
        navigate(`/book/${bookId}`, { replace: true })
      } catch (err) {
        if (controller.signal.aborted) return
        setError(
          err instanceof EpubImportError || err instanceof Error
            ? err.message
            : 'Could not add that book.',
        )
      }
    })()

    return () => controller.abort()
  }, [id, shared, navigate])

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-stone-950 px-6 text-center text-stone-100">
      {error ? (
        <>
          <p className="text-sm text-red-300">{error}</p>
          <p className="max-w-xs text-xs text-stone-500">
            Share a book page such as https://www.gutenberg.org/ebooks/2701, or add the book
            from the library.
          </p>
        </>
      ) : (
        <p className="text-sm text-stone-400">
          Adding book #{id} from Project Gutenberg…
        </p>
      )}
      <Link
        to="/"
        className="rounded-full border border-stone-700 px-4 py-2 text-sm font-medium text-stone-300 hover:bg-stone-800 hover:text-stone-100"
      >
        Go to library
      </Link>
    </div>
  )
}
