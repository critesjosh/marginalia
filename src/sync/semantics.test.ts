import { describe, expect, it } from 'vitest'
import { deduplicateEvents, sessionizeReadingEvents, type ReadingEvent } from './semantics'

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
})
