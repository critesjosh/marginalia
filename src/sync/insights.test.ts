import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import { DEFAULT_SETTINGS } from '../db/types'
import {
  INTEREST_PROFILE,
  STALE_AFTER_MS,
  readCachedInsights,
  readDeletionStatus,
  refreshInsights,
  requestCloudDeletion,
  type InsightsTransport,
  type InterestConcept,
} from './insights'

const NOW = Date.UTC(2026, 8, 2, 12)
const TOKEN = 'sync-token'
const REQUEST_ID = '7f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'

const ROWS: InterestConcept[] = [
  { conceptId: 'morality', interestScore: 1, evidenceCount: 2, distinctBooks: 1 },
]

function responding(body: unknown, status = 200): InsightsTransport {
  return async () => new Response(JSON.stringify(body), { status })
}

async function settings(overrides: Record<string, unknown> = {}) {
  await db.settings.put({ ...DEFAULT_SETTINGS, id: 'settings', ...overrides })
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 1 })
})

describe('insights caching', () => {
  it('is unavailable, not failed, while sync is off', async () => {
    await settings({ syncEnabled: false, syncToken: TOKEN })
    const view = await refreshInsights(INTEREST_PROFILE, {
      transport: responding({ rows: ROWS }),
      now: NOW,
    })
    expect(view).toEqual({ status: 'unavailable', rows: [] })
    // Nothing was written, so opting out cannot leave insights behind.
    expect(await db.insightsCache.get(INTEREST_PROFILE)).toBeUndefined()
  })

  it('caches a successful read with the source timestamp, not the fetch time', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    const view = await refreshInsights<InterestConcept>(INTEREST_PROFILE, {
      transport: responding({ rows: ROWS, sourceUpdatedAt: '2026-09-02T11:00:00.000Z' }),
      now: NOW,
    })
    expect(view.status).toBe('fresh')
    expect(view.rows).toEqual(ROWS)
    expect(view.sourceUpdatedAt).toBe(Date.UTC(2026, 8, 2, 11))
    expect(view.cachedAt).toBe(NOW)
  })

  it('labels a cached read stale once it is old enough', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await refreshInsights(INTEREST_PROFILE, { transport: responding({ rows: ROWS }), now: NOW })

    const fresh = await readCachedInsights<InterestConcept>(INTEREST_PROFILE, NOW + STALE_AFTER_MS)
    expect(fresh.status).toBe('fresh')
    const stale = await readCachedInsights<InterestConcept>(
      INTEREST_PROFILE,
      NOW + STALE_AFTER_MS + 1,
    )
    expect(stale.status).toBe('stale')
    expect(stale.rows).toEqual(ROWS)
  })

  it('does not overwrite a good cache with a bad response', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await refreshInsights(INTEREST_PROFILE, { transport: responding({ rows: ROWS }), now: NOW })

    for (const bad of [responding({ nonsense: true }), responding({}, 503)]) {
      const view = await refreshInsights<InterestConcept>(INTEREST_PROFILE, {
        transport: bad,
        now: NOW + 1,
      })
      expect(view.rows).toEqual(ROWS)
    }
  })

  it('does not repopulate the cache from a request that outlived consent', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    // The response lands after another tab has turned sync off.
    const racing: InsightsTransport = async () => {
      await settings({ syncEnabled: false, syncToken: TOKEN })
      return new Response(JSON.stringify({ rows: ROWS }), { status: 200 })
    }
    const view = await refreshInsights(INTEREST_PROFILE, { transport: racing, now: NOW })
    expect(view).toEqual({ status: 'unavailable', rows: [] })
    expect(await db.insightsCache.get(INTEREST_PROFILE)).toBeUndefined()
  })

  it('will not read a cache back once sync is off', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await refreshInsights(INTEREST_PROFILE, { transport: responding({ rows: ROWS }), now: NOW })
    await settings({ syncEnabled: false, syncToken: TOKEN })
    expect(await readCachedInsights(INTEREST_PROFILE, NOW)).toEqual({
      status: 'unavailable',
      rows: [],
    })
  })

  it('keeps showing cached insights when the network fails, labelled stale', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await refreshInsights(INTEREST_PROFILE, { transport: responding({ rows: ROWS }), now: NOW })
    const offline: InsightsTransport = async () => {
      throw new Error('offline')
    }
    // One second old, and still stale: the cloud may already have moved on.
    const view = await refreshInsights<InterestConcept>(INTEREST_PROFILE, {
      transport: offline,
      now: NOW + 1000,
    })
    expect(view.status).toBe('stale')
    expect(view.rows).toEqual(ROWS)
  })

  it('refuses rows that are not objects rather than caching something the view cannot draw', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await refreshInsights(INTEREST_PROFILE, { transport: responding({ rows: ROWS }), now: NOW })
    const view = await refreshInsights<InterestConcept>(INTEREST_PROFILE, {
      transport: responding({ rows: [null] }),
      now: NOW + 1,
    })
    expect(view.rows).toEqual(ROWS)
  })

  it('reports nothing at all as unavailable rather than as empty', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    const view = await readCachedInsights(INTEREST_PROFILE, NOW)
    expect(view.status).toBe('unavailable')
  })
})

describe('cloud deletion', () => {
  it('tears local state down in one transaction before it asks', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    await db.eventOutbox.add({
      eventId: 'event-1',
      sequence: 1,
      eventType: 'highlight_created',
      eventTime: new Date(NOW).toISOString(),
      payload: {} as never,
      privacySnapshot: { consentVersion: 1, included: [] },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      createdAt: NOW,
    })
    await db.insightsCache.put({ id: INTEREST_PROFILE, payload: { rows: ROWS }, sourceUpdatedAt: 0, cachedAt: NOW })

    let asked: { method?: string; body?: string } | undefined
    const transport: InsightsTransport = async (_path, _token, init) => {
      // The local teardown has to have happened before the network call.
      asked = init
      expect(await db.eventOutbox.count()).toBe(0)
      return new Response('{}', { status: 200 })
    }

    const result = await requestCloudDeletion({ transport })
    expect(result.submitted).toBe(true)
    expect(JSON.parse(asked!.body!)).toEqual({ requestId: result.requestId })
    expect((await db.settings.get('settings'))?.syncEnabled).toBe(false)
    expect(await db.insightsCache.count()).toBe(0)
    expect((await db.syncState.get('sync'))?.activeDeletionRequestId).toBe(result.requestId)
  })

  it('retries with the same request id after a failure', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    const failing: InsightsTransport = async () => {
      throw new Error('offline')
    }
    const first = await requestCloudDeletion({ transport: failing })
    expect(first.submitted).toBe(false)

    const second = await requestCloudDeletion({ transport: responding({}) })
    expect(second.requestId).toBe(first.requestId)
    expect(second.submitted).toBe(true)
  })

  it('claims one request id even when two tabs ask at once', async () => {
    await settings({ syncEnabled: true, syncToken: TOKEN })
    const [first, second] = await Promise.all([
      requestCloudDeletion({ transport: responding({}) }),
      requestCloudDeletion({ transport: responding({}) }),
    ])
    expect(first.requestId).toBe(second.requestId)
    expect((await db.syncState.get('sync'))?.activeDeletionRequestId).toBe(first.requestId)
  })

  it('records the request id even with no sync state row to put it in', async () => {
    // A reader can ask for deletion before a single event has been queued.
    await db.syncState.clear()
    await settings({ syncEnabled: true, syncToken: TOKEN })
    const failing: InsightsTransport = async () => {
      throw new Error('offline')
    }
    const first = await requestCloudDeletion({ transport: failing })
    expect((await db.syncState.get('sync'))?.activeDeletionRequestId).toBe(first.requestId)
    const retry = await requestCloudDeletion({ transport: responding({}) })
    expect(retry.requestId).toBe(first.requestId)
  })

  it('still disables sync locally when there is no token to ask with', async () => {
    await settings({ syncEnabled: true, syncToken: '' })
    const result = await requestCloudDeletion({ transport: responding({}) })
    expect(result.submitted).toBe(false)
    expect((await db.settings.get('settings'))?.syncEnabled).toBe(false)
  })

  it('reads a deletion status back', async () => {
    await settings({ syncEnabled: false, syncToken: TOKEN })
    const status = await readDeletionStatus(REQUEST_ID, {
      transport: responding({ requestId: REQUEST_ID, status: 'running' }),
    })
    expect(status).toEqual({ requestId: REQUEST_ID, status: 'running' })
  })
})
