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
export async function readCachedInsights<T>(id: string, now = Date.now()): Promise<InsightsView<T>> {
  const cached = (await db.insightsCache.get(id)) as InsightsCache | undefined
  if (!cached) return { status: 'unavailable', rows: [] }

  const envelope = cached.payload as InsightsEnvelope<T> | undefined
  return {
    status: now - cached.cachedAt > STALE_AFTER_MS ? 'stale' : 'fresh',
    rows: envelope?.rows ?? [],
    sourceUpdatedAt: cached.sourceUpdatedAt || undefined,
    cachedAt: cached.cachedAt,
  }
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
    return await readCachedInsights<T>(id, now)
  }

  if (!response.ok) return await readCachedInsights<T>(id, now)

  let envelope: InsightsEnvelope<T>
  try {
    envelope = (await response.json()) as InsightsEnvelope<T>
  } catch {
    return await readCachedInsights<T>(id, now)
  }
  if (!Array.isArray(envelope?.rows)) return await readCachedInsights<T>(id, now)

  const sourceUpdatedAt = envelope.sourceUpdatedAt ? Date.parse(envelope.sourceUpdatedAt) : Number.NaN
  await db.insightsCache.put({
    id,
    payload: envelope,
    sourceUpdatedAt: Number.isFinite(sourceUpdatedAt) ? sourceUpdatedAt : 0,
    cachedAt: now,
  })

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
  const settings = await db.settings.get('settings')
  const token = settings?.syncToken
  const existing = (await db.syncState.get('sync'))?.activeDeletionRequestId
  const requestId = options.requestId ?? existing ?? crypto.randomUUID()

  await db.transaction('rw', [db.settings, db.syncState, db.eventOutbox, db.insightsCache], async () => {
    const current = await db.settings.get('settings')
    if (current) await db.settings.put({ ...current, syncEnabled: false })
    const state = await db.syncState.get('sync')
    if (state) {
      await db.syncState.put({
        ...state,
        activeDeletionRequestId: requestId,
        pausedReason: 'sync_disabled',
      })
    }
    await db.eventOutbox.clear()
    await db.insightsCache.clear()
  })

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
