import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  deduplicateEvents,
  sessionizeReadingEvents,
  type ReadingEvent,
  type ReceivedEvent,
} from './semantics'

describe('deduplication reference semantics', () => {
  it('keeps the first event, identifies a delivery duplicate, and quarantines a conflict', () => {
    const first = {
      userId: 'personal',
      eventId: 'event-1',
      eventType: 'highlight_created',
      eventTime: '2026-09-01T10:00:00.000Z',
      receivedAt: '2026-09-01T10:00:01.000Z',
      payload: { text: 'same', nested: { b: 2, a: 1 } },
    }
    const duplicate = {
      ...first,
      receivedAt: '2026-09-01T10:00:02.000Z',
      payload: { nested: { a: 1, b: 2 }, text: 'same' },
    }
    const conflicting = { ...first, payload: { text: 'changed' } }
    const result = deduplicateEvents([first, duplicate, conflicting])

    expect(result.accepted).toEqual([first])
    expect(result.duplicateEventIds).toEqual(['event-1'])
    expect(result.conflicts).toHaveLength(1)
  })
})

describe('sessionization reference semantics', () => {
  const base = {
    userId: 'personal',
    installationId: 'install-1',
    bookId: 'book-1',
  }

  function event(
    eventId: string,
    eventType: ReadingEvent['eventType'],
    minute: number,
  ): ReadingEvent {
    return {
      ...base,
      eventId,
      eventType,
      eventTime: new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString(),
    }
  }

  it('ends explicitly and caps long active intervals', () => {
    const sessions = sessionizeReadingEvents([
      event('open', 'book_opened', 0),
      event('progress', 'reading_progressed', 10),
      event('close', 'book_closed', 11),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].activeSeconds).toBe(180)
    expect(sessions[0].eventIds).toEqual(['open', 'progress', 'close'])
  })

  it('starts a new session at the 30-minute idle boundary', () => {
    const sessions = sessionizeReadingEvents([
      event('one', 'book_opened', 0),
      event('two', 'reading_progressed', 29),
      event('three', 'reading_progressed', 59),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions[0].eventIds).toEqual(['one', 'two'])
    expect(sessions[1].eventIds).toEqual(['three'])
  })

  it('starts a session at an open that arrives without its close', () => {
    const sessions = sessionizeReadingEvents([
      event('one', 'book_opened', 0),
      event('two', 'reading_progressed', 1),
      event('three', 'book_opened', 2),
      event('four', 'reading_progressed', 3),
    ])
    expect(sessions.map((session) => session.eventIds)).toEqual([
      ['one', 'two'],
      ['three', 'four'],
    ])
  })

  it('breaks ties on sequence before receipt, as the Silver windows do', () => {
    const sessions = sessionizeReadingEvents([
      { ...event('zzz', 'reading_progressed', 0), sequence: 1 },
      { ...event('aaa', 'reading_progressed', 0), sequence: 2 },
    ])
    expect(sessions[0].eventIds).toEqual(['zzz', 'aaa'])
  })

  it('keeps a sub-second-short gap in one session', () => {
    // Whole-second arithmetic would round this 1,799.2-second gap up to the
    // 30-minute boundary and split it. The Silver pipeline keeps the fraction
    // for the same reason.
    const at = (iso: string, eventId: string): ReadingEvent => ({
      ...base,
      eventId,
      eventType: 'reading_progressed',
      eventTime: iso,
    })
    const sessions = sessionizeReadingEvents([
      at('2026-09-01T10:00:00.900Z', 'one'),
      at('2026-09-01T10:30:00.100Z', 'two'),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].eventIds).toEqual(['one', 'two'])
  })

  it('is deterministic when input arrives late and out of order', () => {
    const events = [
      event('three', 'book_closed', 2),
      event('one', 'book_opened', 0),
      event('two', 'reading_progressed', 1),
    ]
    expect(sessionizeReadingEvents(events)).toEqual(sessionizeReadingEvents([...events].reverse()))
  })

  it('sessionizes interleaved books independently', () => {
    const events = [
      event('book-one-open', 'book_opened', 0),
      { ...event('book-two-open', 'book_opened', 1), bookId: 'book-2' },
      event('book-one-close', 'book_closed', 2),
      { ...event('book-two-close', 'book_closed', 3), bookId: 'book-2' },
    ]
    const sessions = sessionizeReadingEvents(events)
    expect(sessions).toHaveLength(2)
    expect(sessions.map((session) => session.eventIds)).toEqual([
      ['book-one-open', 'book-one-close'],
      ['book-two-open', 'book-two-close'],
    ])
  })

  it('documents every Phase 2 fixture outcome, including late and future clocks', () => {
    const path = new URL('../../contracts/fixtures/reading-sessions-phase-2.jsonl', import.meta.url)
    const submitted = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const received = submitted.map((item) => ({
      ...item,
      userId: 'fixture-user',
      receivedAt: item.emittedAt,
    })) as unknown as ReceivedEvent[]
    const deduplicated = deduplicateEvents(received)

    expect(deduplicated.accepted).toHaveLength(18)
    expect(deduplicated.duplicateEventIds).toEqual(['40000000-0000-4000-8000-000000000002'])
    expect(deduplicated.conflicts.map((conflict) => conflict.eventId)).toEqual([
      '40000000-0000-4000-8000-000000000003',
    ])

    const readingEvents = deduplicated.accepted.map((item) => ({
      eventId: item.eventId,
      userId: item.userId,
      installationId: item.installationId!,
      bookId: item.entities!.bookId,
      eventType: item.eventType,
      eventTime: item.eventTime,
      receivedAt: item.receivedAt,
      sequence: item.sequence,
    })) as ReadingEvent[]
    const sessions = sessionizeReadingEvents(readingEvents)

    expect(sessions).toHaveLength(6)
    expect(sessions.map((session) => session.activeSeconds)).toEqual([300, 120, 120, 480, 240, 0])
    expect(sessions[3].eventIds).toContain('40000000-0000-4000-8000-000000000014')
    expect(sessions[5].startedAt).toBe('2026-09-01T11:10:00.000Z')
  })
})
