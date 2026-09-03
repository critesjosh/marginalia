import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BackIcon } from '../components/Icons'
import {
  BOOK_ENGAGEMENT,
  INTEREST_PROFILE,
  RECOMMENDATIONS,
  readCachedInsights,
  refreshInsights,
  type BookEngagement,
  type InsightsView,
  type InterestConcept,
  type RecommendedBook,
} from '../sync/insights'
import {
  alreadyShown,
  recordRecommendationDismissed,
  recordRecommendationOpened,
  recordRecommendationShown,
  settledCandidates,
} from '../sync/recommendations'

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
  const [suggestions, setSuggestions] = useState<InsightsView<RecommendedBook>>({
    status: 'unavailable',
    rows: [],
  })
  // Candidates the reader has already dismissed, added, or started. The cloud
  // recomputes its list on its own schedule, so without this a dismissed book
  // comes back on the next refresh and is dismissed again.
  const [dealtWith, setDealtWith] = useState<Set<string>>(new Set())
  const [books, setBooks] = useState<InsightsView<BookEngagement>>({
    status: 'unavailable',
    rows: [],
  })

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // Cache first, so the page is never blank while a request is in flight.
      const [cachedInterests, cachedBooks, cachedSuggestions, settled] = await Promise.all([
        readCachedInsights<InterestConcept>(INTEREST_PROFILE),
        readCachedInsights<BookEngagement>(BOOK_ENGAGEMENT),
        readCachedInsights<RecommendedBook>(RECOMMENDATIONS),
        settledCandidates(),
      ])
      if (cancelled) return
      setInterests(cachedInterests)
      setBooks(cachedBooks)
      setDealtWith(settled)
      setSuggestions(cachedSuggestions)

      const [freshInterests, freshBooks, freshSuggestions] = await Promise.all([
        refreshInsights<InterestConcept>(INTEREST_PROFILE),
        refreshInsights<BookEngagement>(BOOK_ENGAGEMENT),
        refreshInsights<RecommendedBook>(RECOMMENDATIONS),
      ])
      if (cancelled) return
      setInterests(freshInterests)
      setBooks(freshBooks)
      setSuggestions(freshSuggestions)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(
    () => suggestions.rows.filter((book) => !dealtWith.has(book.candidateId)),
    [suggestions.rows, dealtWith],
  )

  // One impression per candidate, not one per render.
  //
  // Three things conspire here. `visible` is a new array on every render, so
  // the effect must depend on something stable; two runs overlapping would each
  // read the same "already shown" snapshot and report twice; and a re-render
  // mid-loop would start a second pass over the same books. A ref claimed
  // synchronously before any await is what makes a candidate reported once,
  // because it is the only thing in this file that cannot interleave.
  const reported = useRef<Set<string>>(new Set())
  const impressionKey = visible.map((book) => book.candidateId).join('\u0000')
  useEffect(() => {
    const report = async () => {
      const seen = await alreadyShown()
      for (const [index, book] of visible.entries()) {
        if (seen.has(book.candidateId) || reported.current.has(book.candidateId)) continue
        reported.current.add(book.candidateId)
        try {
          await recordRecommendationShown({ ...book, rank: index + 1 })
        } catch {
          // Let the next pass try again rather than silently never reporting it.
          reported.current.delete(book.candidateId)
        }
      }
    }
    if (visible.length > 0) void report()
    // Keyed by which candidates are on screen rather than by the array's
    // identity, so a re-render that changes nothing re-runs nothing.
  }, [impressionKey, visible])

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

        <section>
          <h2 className="text-sm font-semibold">What to read next</h2>
          <Freshness view={suggestions} />
          {visible.length === 0 ? (
            <Unavailable />
          ) : (
            <ul className="mt-3 space-y-4">
              {visible.map((book, index) => (
                <li key={book.candidateId}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm">{book.candidateTitle}</span>
                    <span className="shrink-0 text-xs text-stone-500">
                      {book.authors ? book.authors : null}
                      {book.publicationYear ? ` · ${book.publicationYear}` : ''}
                    </span>
                  </div>
                  {book.explanation ? (
                    <p className="mt-1 text-xs text-stone-400">{book.explanation}</p>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-stone-700 px-2.5 py-1 text-xs text-stone-200"
                      onClick={() => {
                        void recordRecommendationOpened({ ...book, rank: index + 1 })
                      }}
                    >
                      Look into it
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-stone-800 px-2.5 py-1 text-xs text-stone-400"
                      onClick={() => {
                        void recordRecommendationDismissed({ ...book }, 'not_interested').then(() =>
                          setDealtWith((current) => new Set(current).add(book.candidateId)),
                        )
                      }}
                    >
                      Not for me
                    </button>
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
