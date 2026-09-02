import { db } from '../db/db'
import { enqueueEvent } from './outbox'
import type { EventPayloadByType } from './types'

export const READING_PROGRESS_INTERVAL_MS = 30_000
export const READING_PROGRESS_DELTA = 0.002
export const BOOK_REOPENED_INTERVAL_MS = 24 * 60 * 60_000

export interface ReadingSnapshot {
  cfi: string
  progress: number
  chapter?: string
}

export type ReadingIntent =
  | { eventType: 'book_opened'; eventTime: number; payload: EventPayloadByType['book_opened'] }
  | { eventType: 'book_closed'; eventTime: number; payload: EventPayloadByType['book_closed'] }
  | {
      eventType: 'reading_progressed'
      eventTime: number
      payload: EventPayloadByType['reading_progressed']
    }
  | {
      eventType: 'chapter_entered'
      eventTime: number
      payload: EventPayloadByType['chapter_entered']
    }
  | {
      eventType: 'book_completed'
      eventTime: number
      payload: EventPayloadByType['book_completed']
    }
  | {
      eventType: 'book_reopened'
      eventTime: number
      payload: EventPayloadByType['book_reopened']
    }

function timestamp(at: number): string {
  return new Date(at).toISOString()
}

function withChapter<T extends object>(payload: T, chapter: string | undefined): T & { chapter?: string } {
  // TOC labels are usage metadata in the v1 contract, not book body text or
  // bibliographic metadata. They never add a privacy inclusion category.
  return chapter === undefined ? payload : { ...payload, chapter }
}

/**
 * Pure state machine for one mounted reader. Persistence is deliberately kept
 * outside it so timing and threshold behavior can be tested without IndexedDB.
 */
export class ReadingActivityTracker {
  readonly #previousLastOpenedAt?: number
  #active = false
  #lastSnapshot?: ReadingSnapshot
  #lastProgressAt = 0
  #lastProgress = 0
  #lastActivityAt?: number
  #completed: boolean

  constructor(previous?: { lastOpenedAt?: number; progress?: number }) {
    this.#previousLastOpenedAt = previous?.lastOpenedAt
    this.#completed = (previous?.progress ?? 0) >= 1
  }

  observe(snapshot: ReadingSnapshot, at: number): ReadingIntent[] {
    if (!this.#active) return this.open(snapshot, at)

    const intents: ReadingIntent[] = []
    const chapterChanged =
      snapshot.chapter !== undefined && snapshot.chapter !== this.#lastSnapshot?.chapter

    if (chapterChanged) {
      intents.push({
        eventType: 'chapter_entered',
        eventTime: at,
        payload: {
          chapter: snapshot.chapter!,
          progress: snapshot.progress,
          enteredAt: timestamp(at),
        },
      })
    }

    if (
      at - this.#lastProgressAt >= READING_PROGRESS_INTERVAL_MS &&
      (Math.abs(snapshot.progress - this.#lastProgress) >= READING_PROGRESS_DELTA ||
        chapterChanged)
    ) {
      intents.push(this.progressed(snapshot, at, chapterChanged ? 'chapter_change' : 'progress_delta'))
    }

    if (!this.#completed && snapshot.progress >= 1) {
      intents.push({
        eventType: 'book_completed',
        eventTime: at,
        payload: { progress: snapshot.progress, completedAt: timestamp(at) },
      })
      this.#completed = true
    }

    this.#lastSnapshot = snapshot
    this.#lastActivityAt = at
    return intents
  }

  open(snapshot: ReadingSnapshot, at: number): ReadingIntent[] {
    if (this.#active) return []
    const previous = this.#lastActivityAt ?? this.#previousLastOpenedAt
    const reopened = previous !== undefined
    const intents: ReadingIntent[] = [
      {
        eventType: 'book_opened',
        eventTime: at,
        payload: withChapter(
          { progress: snapshot.progress, openedAt: timestamp(at), ...(reopened ? { reopened: true } : {}) },
          snapshot.chapter,
        ),
      },
    ]

    if (previous !== undefined && at - previous >= BOOK_REOPENED_INTERVAL_MS) {
      intents.push({
        eventType: 'book_reopened',
        eventTime: at,
        payload: withChapter(
          {
            progress: snapshot.progress,
            reopenedAt: timestamp(at),
            daysSinceLastOpen: Math.max(0, (at - previous) / 86_400_000),
          },
          snapshot.chapter,
        ),
      })
    }

    this.#active = true
    this.#lastSnapshot = snapshot
    this.#lastProgressAt = at
    this.#lastProgress = snapshot.progress
    this.#lastActivityAt = at
    return intents
  }

  close(
    snapshot: ReadingSnapshot,
    at: number,
    reason: EventPayloadByType['book_closed']['reason'],
  ): ReadingIntent[] {
    if (!this.#active) return []
    const intents: ReadingIntent[] = []
    if (at - this.#lastProgressAt >= READING_PROGRESS_INTERVAL_MS) {
      intents.push(
        this.progressed(snapshot, at, reason === 'backgrounded' ? 'backgrounded' : 'closing'),
      )
    }
    intents.push({
      eventType: 'book_closed',
      eventTime: at,
      payload: withChapter(
        { progress: snapshot.progress, closedAt: timestamp(at), reason },
        snapshot.chapter,
      ),
    })
    this.#active = false
    this.#lastSnapshot = snapshot
    this.#lastActivityAt = at
    return intents
  }

  #markProgress(snapshot: ReadingSnapshot, at: number): void {
    this.#lastProgressAt = at
    this.#lastProgress = snapshot.progress
  }

  private progressed(
    snapshot: ReadingSnapshot,
    at: number,
    trigger: EventPayloadByType['reading_progressed']['trigger'],
  ): Extract<ReadingIntent, { eventType: 'reading_progressed' }> {
    this.#markProgress(snapshot, at)
    return {
      eventType: 'reading_progressed',
      eventTime: at,
      payload: withChapter(
        { progress: snapshot.progress, observedAt: timestamp(at), trigger },
        snapshot.chapter,
      ),
    }
  }
}

async function enqueueReadingIntent(bookId: string, intent: ReadingIntent): Promise<void> {
  const base = { eventTime: intent.eventTime, entities: { bookId } }
  switch (intent.eventType) {
    case 'book_opened':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
    case 'book_closed':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
    case 'reading_progressed':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
    case 'chapter_entered':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
    case 'book_completed':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
    case 'book_reopened':
      await enqueueEvent({ ...base, eventType: intent.eventType, content: () => ({ payload: intent.payload, included: [] }) })
      break
  }
}

/** Persists the chosen location and every derived event atomically. */
export async function recordReadingActivity(
  bookId: string,
  snapshot: ReadingSnapshot,
  intents: readonly ReadingIntent[],
  at: number,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.books, db.settings, db.syncState, db.eventOutbox],
    async () => {
      await db.books.update(bookId, {
        lastCfi: snapshot.cfi,
        progress: snapshot.progress,
        lastOpenedAt: at,
      })
      for (const intent of intents) await enqueueReadingIntent(bookId, intent)
    },
  )
}
