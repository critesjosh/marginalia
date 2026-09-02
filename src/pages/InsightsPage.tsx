import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BackIcon } from '../components/Icons'
import {
  BOOK_ENGAGEMENT,
  INTEREST_PROFILE,
  readCachedInsights,
  refreshInsights,
  type BookEngagement,
  type InsightsView,
  type InterestConcept,
} from '../sync/insights'

/**
 * A read-only view of what the cloud worked out. It renders from cache first so
 * it never waits on the network, and it says plainly whether what is on screen
 * is current, old, or absent. Nothing here can affect reading.
 */

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function Freshness({ view }: { view: InsightsView<unknown> }) {
  if (view.status === 'unavailable') return null
  const now = Date.now()
  return (
    <p className="mt-1 text-xs text-stone-500">
      {view.status === 'stale' ? (
        <span className="text-amber-300">Showing saved insights. </span>
      ) : null}
      {view.sourceUpdatedAt
        ? `Computed ${ago(view.sourceUpdatedAt, now)}.`
        : view.cachedAt
          ? `Saved ${ago(view.cachedAt, now)}.`
          : null}
    </p>
  )
}

function Bar({ value }: { value: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-stone-800"
      role="img"
      aria-label={`${percent} percent`}
    >
      <div className="h-full rounded-full bg-stone-400" style={{ width: `${percent}%` }} />
    </div>
  )
}

function Unavailable() {
  return (
    <p className="mt-2 text-sm text-stone-500">
      Nothing yet. Insights appear once cloud sync is on and your reading has been processed.
    </p>
  )
}

export default function InsightsPage() {
  const [interests, setInterests] = useState<InsightsView<InterestConcept>>({
    status: 'unavailable',
    rows: [],
  })
  const [books, setBooks] = useState<InsightsView<BookEngagement>>({
    status: 'unavailable',
    rows: [],
  })

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // Cache first, so the page is never blank while a request is in flight.
      const [cachedInterests, cachedBooks] = await Promise.all([
        readCachedInsights<InterestConcept>(INTEREST_PROFILE),
        readCachedInsights<BookEngagement>(BOOK_ENGAGEMENT),
      ])
      if (cancelled) return
      setInterests(cachedInterests)
      setBooks(cachedBooks)

      const [freshInterests, freshBooks] = await Promise.all([
        refreshInsights<InterestConcept>(INTEREST_PROFILE),
        refreshInsights<BookEngagement>(BOOK_ENGAGEMENT),
      ])
      if (cancelled) return
      setInterests(freshInterests)
      setBooks(freshBooks)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-full bg-stone-950 text-stone-100">
      <header className="pt-safe sticky top-0 z-10 border-b border-stone-800 bg-stone-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-1 px-2 pb-2">
          <Link to="/" aria-label="Back to library" className="rounded-lg p-2.5 text-stone-400">
            <BackIcon />
          </Link>
          <h1 className="text-base font-semibold">Insights</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-8 px-4 py-6">
        <section>
          <h2 className="text-sm font-semibold">What you are reading about</h2>
          <Freshness view={interests} />
          {interests.rows.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="mt-3 space-y-3">
              {interests.rows.map((concept) => (
                <li key={concept.conceptId}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm">{concept.conceptId}</span>
                    <span className="shrink-0 text-xs text-stone-500">
                      {concept.evidenceCount} {concept.evidenceCount === 1 ? 'mark' : 'marks'}
                      {concept.distinctBooks > 1 ? ` · ${concept.distinctBooks} books` : ''}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Bar value={concept.interestScore} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold">Time with each book</h2>
          <Freshness view={books} />
          {books.rows.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="mt-3 space-y-3">
              {books.rows.map((book) => (
                <li key={book.bookId}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="break-all text-sm">{book.bookId}</span>
                    <span className="shrink-0 text-xs text-stone-500">
                      {Math.round(book.activeMinutes)} min · {book.sessionCount}{' '}
                      {book.sessionCount === 1 ? 'session' : 'sessions'}
                      {book.completed ? ' · finished' : ''}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Bar value={book.engagementScore} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-stone-600">
          Insights are computed in the cloud from the activity you chose to share. They never
          affect reading, and they are always available offline from the last saved copy.
        </p>
      </main>
    </div>
  )
}
