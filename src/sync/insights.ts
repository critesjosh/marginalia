import { db } from '../db/db'
import type { InsightsCache } from './types'

/**
 * Insights are a cached read of cloud-computed profiles. Nothing here is on the
 * path of reading a book: every failure resolves to cached or unavailable, and
 * the reader is told which they are looking at rather than being shown a stale
 * number as if it were current.
 */

export const INTEREST_PROFILE = 'interest-profile'
export const BOOK_ENGAGEMENT = 'book-engagement'
export const RECOMMENDATIONS = 'recommendations'

/** Older than this and a cached read is worth saying is old. */
export const STALE_AFTER_MS = 60 * 60_000

export interface InterestConcept {
  conceptId: string
  interestScore: number
  evidenceCount: number
  distinctBooks: number
  lastEvidenceAt?: string
}

export interface BookEngagement {
  bookId: string
  activeMinutes: number
  sessionCount: number
  maximumProgress: number
  currentHighlights: number
  questions: number
  completed: boolean
  engagementScore: number
}

/**
 * One recommended book, with the components that produced its score.
 *
 * The explanation is a column rather than generated prose, so what the reader
 * is told is the same thing the score was computed from. `candidateId` is an
 * Open Library work key: public, and the key every outcome event carries back.
 */
export interface RecommendedBook {
  candidateId: string
  candidateTitle: string
  authors?: string
  publicationYear?: number
  recommendationScore: number
  explanation?: string
  matchedConcepts?: string
  scoreVersion?: string
}

export interface InsightsEnvelope<T> {
  rows: T[]
  sourceUpdatedAt?: string
}

export type InsightsStatus = 'fresh' | 'stale' | 'unavailable'

export interface InsightsView<T> {
  status: InsightsStatus
  rows: T[]
  /** When the cloud last recomputed this, not when we last asked for it. */
  sourceUpdatedAt?: number
  cachedAt?: number
}

export interface InsightsTransport {
  (path: string, token: string, init?: { method: string; body?: string }): Promise<Response>
}

const httpTransport: InsightsTransport = (path, token, init) =>
  fetch(`/api/intelligence/v1/${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body,
    // Private data. It must not land in any shared cache on the way here.
    cache: 'no-store',
  })

async function credentials(): Promise<string | undefined> {
  const settings = await db.settings.get('settings')
  if (!settings?.syncEnabled) return undefined
  return settings.syncToken || undefined
}

/**
 * Reads the cache first so a view can render immediately, then refreshes. A
 * refresh that fails leaves the cached copy exactly as it was: a reader who is
 * offline keeps seeing their insights, labelled old.
 */
export async function readCachedInsights<T>(
  id: string,
  now = Date.now(),
  force: InsightsStatus | undefined = undefined,
): Promise<InsightsView<T>> {
  // Consent is rechecked on every read, not only when fetching. A tab that
  // turned sync off, or a deletion that completed elsewhere, must not leave a
  // previous opt-in's insights readable from this one.
  if (!(await credentials())) return { status: 'unavailable', rows: [] }

  const cached = (await db.insightsCache.get(id)) as InsightsCache | undefined
  if (!cached) return { status: 'unavailable', rows: [] }

  const envelope = cached.payload as InsightsEnvelope<T> | undefined
  return {
    status: force ?? (now - cached.cachedAt > STALE_AFTER_MS ? 'stale' : 'fresh'),
    rows: envelope?.rows ?? [],
    sourceUpdatedAt: cached.sourceUpdatedAt || undefined,
    cachedAt: cached.cachedAt,
  }
}

/**
 * A refresh that did not succeed is stale by definition, however recently the
 * cache was written. The reader is looking at something the cloud may already
 * have changed, and saying "fresh" would be a claim we cannot support.
 */
function staleCache<T>(id: string, now: number): Promise<InsightsView<T>> {
  return readCachedInsights<T>(id, now, 'stale')
}

function isRowShaped(rows: unknown): rows is unknown[] {
  return Array.isArray(rows) && rows.every((row) => typeof row === 'object' && row !== null)
}

export async function refreshInsights<T>(
  id: string,
  options: { transport?: InsightsTransport; now?: number } = {},
): Promise<InsightsView<T>> {
  const now = options.now ?? Date.now()
  const transport = options.transport ?? httpTransport

  const token = await credentials()
  // Sync off is not a failure. There is simply nothing to show, and any cached
  // copy from a previous opt-in must not resurface.
  if (!token) return { status: 'unavailable', rows: [] }

  let response: Response
  try {
    response = await transport(id, token)
  } catch {
    return await staleCache<T>(id, now)
  }

  if (!response.ok) return await staleCache<T>(id, now)

  let envelope: InsightsEnvelope<T>
  try {
    envelope = (await response.json()) as InsightsEnvelope<T>
  } catch {
    return await staleCache<T>(id, now)
  }
  // Every row must be an object. An array of nulls is a successful response and
  // would replace a good cache with something that cannot be rendered.
  if (!isRowShaped(envelope?.rows)) return await staleCache<T>(id, now)

  const sourceUpdatedAt = envelope.sourceUpdatedAt ? Date.parse(envelope.sourceUpdatedAt) : Number.NaN
  // Consent is rechecked inside the write. A request that began while sync was
  // on can land after another tab turned it off or finished a deletion, and it
  // must not repopulate what that tab just cleared.
  const written = await db.transaction('rw', [db.settings, db.insightsCache], async () => {
    if (!(await db.settings.get('settings'))?.syncEnabled) return false
    await db.insightsCache.put({
      id,
      payload: envelope,
      sourceUpdatedAt: Number.isFinite(sourceUpdatedAt) ? sourceUpdatedAt : 0,
      cachedAt: now,
    })
    return true
  })
  if (!written) return { status: 'unavailable', rows: [] }

  return {
    status: 'fresh',
    rows: envelope.rows,
    sourceUpdatedAt: Number.isFinite(sourceUpdatedAt) ? sourceUpdatedAt : undefined,
    cachedAt: now,
  }
}

export async function clearInsightsCache(): Promise<void> {
  await db.insightsCache.clear()
}

export interface DeletionRequest {
  requestId: string
  status: 'accepted' | 'running' | 'completed' | 'failed'
}

/**
 * The browser owns the request id, so a retry after any failure is the same
 * request rather than a second one. Local state is torn down first and in one
 * transaction: if the network call never happens, sync is still off and the
 * queue is still gone.
 */
export async function requestCloudDeletion(
  options: { transport?: InsightsTransport; requestId?: string } = {},
): Promise<{ requestId: string; submitted: boolean }> {
  const token = (await db.settings.get('settings'))?.syncToken

  // The id is chosen and claimed inside the transaction. Choosing it outside
  // lets two tabs that start together both see no request, mint different ids,
  // and open two deletions of which only the last is trackable.
  const requestId = await db.transaction(
    'rw',
    [db.settings, db.syncState, db.eventOutbox, db.insightsCache],
    async () => {
      const current = await db.settings.get('settings')
      if (current) await db.settings.put({ ...current, syncEnabled: false })

      const state = await db.syncState.get('sync')
      const claimed =
        options.requestId ?? state?.activeDeletionRequestId ?? crypto.randomUUID()
      // The row may not exist yet: enabling sync does not create it, and a
      // reader can ask for deletion before a single event has been queued.
      await db.syncState.put({
        id: 'sync',
        installationId: state?.installationId ?? crypto.randomUUID(),
        nextSequence: state?.nextSequence ?? 1,
        ...state,
        activeDeletionRequestId: claimed,
        pausedReason: 'sync_disabled',
      })

      await db.eventOutbox.clear()
      await db.insightsCache.clear()
      return claimed
    },
  )

  if (!token) return { requestId, submitted: false }

  const transport = options.transport ?? httpTransport
  try {
    const response = await transport('delete', token, {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    })
    return { requestId, submitted: response.ok }
  } catch {
    return { requestId, submitted: false }
  }
}

/** Polls the status of a deletion the browser has already asked for. */
export async function readDeletionStatus(
  requestId: string,
  options: { transport?: InsightsTransport } = {},
): Promise<DeletionRequest | undefined> {
  const token = (await db.settings.get('settings'))?.syncToken
  if (!token) return undefined
  const transport = options.transport ?? httpTransport
  try {
    const response = await transport(`delete/${requestId}`, token)
    if (!response.ok) return undefined
    return (await response.json()) as DeletionRequest
  } catch {
    return undefined
  }
}
