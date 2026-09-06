import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { DEFAULT_SETTINGS } from '../db/types'
import {
  READING_PROGRESS_INTERVAL_MS,
  BOOK_REOPENED_INTERVAL_MS,
  ReadingActivityTracker,
  recordReadingActivity,
  type ReadingSnapshot,
} from './reading'
import type { EventOutboxRow } from './types'
import { validateEvent } from './validate'

const START = Date.UTC(2026, 8, 1, 9)
const BOOK_ID = 'sample-genealogy-of-morals'

function snapshot(progress: number, chapter = 'First Essay'): ReadingSnapshot {
  return { cfi: `epubcfi(/6/2!/4/2/2:${Math.round(progress * 1000)})`, progress, chapter }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
  await db.open()
})

describe('reading activity thresholds', () => {
  it('opens immediately and throttles progress to the documented interval and delta', () => {
    const tracker = new ReadingActivityTracker()
    expect(tracker.observe(snapshot(0.1), START).map((intent) => intent.eventType)).toEqual([
      'book_opened',
    ])
    expect(tracker.observe(snapshot(0.104), START + READING_PROGRESS_INTERVAL_MS - 1)).toEqual([])
    expect(
      tracker
        .observe(snapshot(0.104), START + READING_PROGRESS_INTERVAL_MS)
        .map((intent) => intent.eventType),
    ).toEqual(['reading_progressed'])
  })

  it('records chapter transitions without bypassing the progress throttle', () => {
    const tracker = new ReadingActivityTracker()
    tracker.observe(snapshot(0.1), START)

    expect(
      tracker.observe(snapshot(0.11, 'Second Essay'), START + 1_000).map((intent) => intent.eventType),
    ).toEqual(['chapter_entered'])
    expect(
      tracker
        .observe(snapshot(0.12, 'Third Essay'), START + READING_PROGRESS_INTERVAL_MS)
        .map((intent) => intent.eventType),
    ).toEqual(['chapter_entered', 'reading_progressed'])
  })

  it('closes once, emits a final throttled observation, and reopens deterministically', () => {
    const tracker = new ReadingActivityTracker()
    const current = snapshot(0.2)
    tracker.observe(current, START)
    expect(
      tracker
        .close(current, START + READING_PROGRESS_INTERVAL_MS, 'backgrounded')
        .map((intent) => intent.eventType),
    ).toEqual(['reading_progressed', 'book_closed'])
    expect(tracker.close(current, START + READING_PROGRESS_INTERVAL_MS + 1, 'backgrounded')).toEqual(
      [],
    )

    const reopened = tracker.open(current, START + READING_PROGRESS_INTERVAL_MS + 10_000)
    expect(reopened.map((intent) => intent.eventType)).toEqual(['book_opened'])
  })

  it('emits book_reopened only after at least a day away', () => {
    const tracker = new ReadingActivityTracker({ lastOpenedAt: START, progress: 0.2 })
    const reopened = tracker.observe(snapshot(0.2), START + BOOK_REOPENED_INTERVAL_MS)
    expect(reopened.map((intent) => intent.eventType)).toEqual(['book_opened', 'book_reopened'])
    expect(reopened[1].payload).toMatchObject({ daysSinceLastOpen: 1 })
  })

  it('emits completion only on the first transition to complete', () => {
    const tracker = new ReadingActivityTracker({ progress: 0.9 })
    tracker.observe(snapshot(0.9), START)
    expect(
      tracker.observe(snapshot(1), START + READING_PROGRESS_INTERVAL_MS).map((intent) => intent.eventType),
    ).toContain('book_completed')
    expect(
      tracker.observe(snapshot(0.5), START + READING_PROGRESS_INTERVAL_MS * 2).map((intent) => intent.eventType),
    ).not.toContain('book_completed')
    expect(
      tracker.observe(snapshot(1), START + READING_PROGRESS_INTERVAL_MS * 3).map((intent) => intent.eventType),
    ).not.toContain('book_completed')
  })
})

describe('reading persistence', () => {
  async function seed(syncEnabled: boolean) {
    await db.books.add({ id: BOOK_ID, title: 'Genealogy', author: 'Nietzsche', addedAt: START })
    await db.settings.put({
      ...DEFAULT_SETTINGS,
      syncEnabled,
      consentUpdatedAt: new Date(START).toISOString(),
    })
  }

  it('updates the product position and queues metadata-only valid events together', async () => {
    await seed(true)
    const tracker = new ReadingActivityTracker()
    const current = snapshot(0.1)
    await recordReadingActivity(BOOK_ID, current, tracker.observe(current, START), START)

    expect(await db.books.get(BOOK_ID)).toMatchObject({
      lastCfi: current.cfi,
      progress: 0.1,
      lastOpenedAt: START,
    })
    const rows = await db.eventOutbox.toArray()
    expect(rows.map((row) => row.eventType)).toEqual(['book_opened'])
    expect(rows[0].privacySnapshot.included).toEqual([])
    expect(validateEvent(rows[0].payload).valid).toBe(true)
  })

  it('rolls the position back when event insertion fails', async () => {
    await seed(true)
    const duplicateId = '10000000-0000-4000-8000-000000000099'
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 1 })
    await db.eventOutbox.add({
      eventId: duplicateId,
      sequence: 99,
      eventType: 'book_opened',
      eventTime: new Date(START).toISOString(),
      payload: {} as EventOutboxRow['payload'],
      privacySnapshot: { consentVersion: 1, included: [] },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: START,
      createdAt: START,
    })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(duplicateId)
    const tracker = new ReadingActivityTracker()
    const current = snapshot(0.2)

    await expect(
      recordReadingActivity(BOOK_ID, current, tracker.observe(current, START), START),
    ).rejects.toThrow()
    expect(await db.books.get(BOOK_ID)).not.toHaveProperty('lastCfi')
  })
})
