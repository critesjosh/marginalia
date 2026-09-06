import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/db'
import {
  candidateForBook,
  recordRecommendationDismissed,
  recordRecommendationOpened,
  recordRecommendationShown,
  recordRecommendedBookAdded,
  settledCandidates,
} from './recommendations'

/**
 * The outcome emitters, run against a real IndexedDB.
 *
 * The failures worth testing here are ordering ones, and no amount of reading
 * the source finds them: an impression still in flight when the reader
 * dismisses a card lands afterwards and, under a plain `put`, tells the next
 * page load that nobody said no.
 */

const CANDIDATE = '/works/OL1234W'

async function enableSync() {
  await db.settings.put({
    id: 'settings',
    syncEnabled: true,
    consentVersion: 1,
    consentUpdatedAt: Date.now(),
  } as never)
  await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 1 } as never)
}

describe('recommendation outcomes', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
    await enableSync()
  })

  it('enqueues one event per outcome', async () => {
    await recordRecommendationShown({ candidateId: CANDIDATE, rank: 1 })
    await recordRecommendationOpened({ candidateId: CANDIDATE, rank: 1 })

    // By sequence, not by primary key: the outbox is keyed by event id, which
    // is a UUID and says nothing about the order things happened in.
    const queued = await db.eventOutbox.orderBy('sequence').toArray()
    expect(queued.map((row) => row.eventType)).toEqual([
      'recommendation_shown',
      'recommendation_opened',
    ])
  })

  it('carries the candidate and the scoring on every outcome', async () => {
    await recordRecommendationShown({
      candidateId: CANDIDATE,
      scoreVersion: 'recommendation_heuristic_v1',
      rank: 3,
      recommendationScore: 0.71,
    })
    const [row] = await db.eventOutbox.toArray()
    expect(row.payload.payload).toMatchObject({
      candidateId: CANDIDATE,
      scoreVersion: 'recommendation_heuristic_v1',
      rank: 3,
      recommendationScore: 0.71,
    })
  })

  it('asks for no content consent, because there is no content in it', async () => {
    await recordRecommendationDismissed({ candidateId: CANDIDATE })
    const [row] = await db.eventOutbox.toArray()
    expect(row.privacySnapshot.included).toEqual([])
  })

  it('does not let a late impression erase a dismissal', async () => {
    // The order a real page produces when the reader is quick: the card is
    // rendered, the impression starts, and they dismiss it before it lands.
    await recordRecommendationDismissed({ candidateId: CANDIDATE })
    await recordRecommendationShown({ candidateId: CANDIDATE, rank: 1 })

    const note = await db.recommendationFeedback.get(CANDIDATE)
    expect(note?.action).toBe('dismissed')
    expect(await settledCandidates()).toContain(CANDIDATE)
  })

  it('does let a decision replace an impression', async () => {
    await recordRecommendationShown({ candidateId: CANDIDATE, rank: 1 })
    await recordRecommendationDismissed({ candidateId: CANDIDATE })
    expect((await db.recommendationFeedback.get(CANDIDATE))?.action).toBe('dismissed')
  })

  it('treats an impression as something other than a decision', async () => {
    await recordRecommendationShown({ candidateId: CANDIDATE, rank: 1 })
    // Seeing a book is not deciding about it. Hiding what has merely been shown
    // would empty the list after one look.
    expect(await settledCandidates()).not.toContain(CANDIDATE)
  })

  it('remembers which book a recommendation became', async () => {
    await recordRecommendedBookAdded({ candidateId: CANDIDATE }, 'book-1')
    const origin = await candidateForBook('book-1')
    expect(origin?.candidateId).toBe(CANDIDATE)
    expect(origin?.action).toBe('added')
  })

  it('keeps the book link when a later outcome is recorded', async () => {
    // Otherwise a start could not be attributed, because the row that named the
    // book would have been overwritten by the row that named the outcome.
    await recordRecommendedBookAdded({ candidateId: CANDIDATE }, 'book-1')
    await recordRecommendationOpened({ candidateId: CANDIDATE })
    expect((await db.recommendationFeedback.get(CANDIDATE))?.bookId).toBe('book-1')
  })

  it('keeps the scoring so a much later start can still cite it', async () => {
    // A start can happen months after the list that suggested the book, by
    // which time the only thing that remembers the formula is this row.
    await recordRecommendedBookAdded(
      { candidateId: CANDIDATE, scoreVersion: 'recommendation_heuristic_v1' },
      'book-1',
    )
    const origin = await candidateForBook('book-1')
    expect(origin?.scoreVersion).toBe('recommendation_heuristic_v1')
  })

  it('does not let an add walk back a start', async () => {
    await recordRecommendedBookAdded({ candidateId: CANDIDATE }, 'book-1')
    await recordRecommendationOpened({ candidateId: CANDIDATE })
    await recordRecommendedBookAdded({ candidateId: CANDIDATE }, 'book-1')
    expect((await db.recommendationFeedback.get(CANDIDATE))?.action).toBe('added')
  })

  it('writes the event and the note together or not at all', async () => {
    await recordRecommendationDismissed({ candidateId: CANDIDATE })
    const queued = await db.eventOutbox.toArray()
    const note = await db.recommendationFeedback.get(CANDIDATE)
    expect(queued).toHaveLength(1)
    expect(note).toBeDefined()
  })

  it('still records the reader’s decision when sync is off', async () => {
    // With sync off there is no outcome to report, and the reader has still
    // decided something about a card in front of them. The invariant is one
    // directional: no event without a note, not the other way round.
    await db.settings.put({ id: 'settings', syncEnabled: false } as never)
    await recordRecommendationDismissed({ candidateId: CANDIDATE })

    expect(await db.eventOutbox.count()).toBe(0)
    expect((await db.recommendationFeedback.get(CANDIDATE))?.action).toBe('dismissed')
  })
})
