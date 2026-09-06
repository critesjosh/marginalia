import { db } from '../db/db'
import { enqueueEvent } from './outbox'
import type { EventPayloadByType, RecommendationFeedback } from './types'

/**
 * What the reader did with a recommendation.
 *
 * These five outcomes are the training data a learned ranker would need, and
 * the plan blocks that ranker until enough of them exist. So they are recorded
 * now and used for nothing yet, which is the point: a dataset gathered after
 * the model that needs it is a dataset shaped by the model that needs it.
 *
 * Every one carries the candidate's work key and the score version that
 * produced it. A recommendation is only interpretable against the scoring
 * behind it, and an outcome without that version cannot be told apart from an
 * outcome under a different formula.
 *
 * None of this is book text. A candidate id is an Open Library work key, which
 * is public, so these need only `syncEnabled` and no content consent. The one
 * thing they say about the reader is what they did with a list, which is
 * exactly what behavioural metadata means here.
 */

function timestamp(at: number): string {
  return new Date(at).toISOString()
}

export interface RecommendationRef {
  candidateId: string
  scoreVersion?: string
  rank?: number
  recommendationScore?: number
}

/**
 * How much of a decision each action is.
 *
 * A note is only ever replaced by a stronger one. Without that, an impression
 * still in flight when the reader dismisses the card lands afterwards, writes
 * `shown` over `dismissed`, and the book returns on the next load as though
 * nobody had said no to it.
 */
const WEIGHT: Record<RecommendationFeedback['action'], number> = {
  shown: 0,
  opened: 1,
  dismissed: 2,
  added: 3,
  started: 4,
}

/**
 * The event and the local note of it, in one transaction.
 *
 * The invariant is one-directional: no event without its note. The reverse is
 * allowed, because with sync off there is no event to enqueue and the reader
 * has still decided something about a card that is in front of them. What must
 * not happen is an outcome reported to the cloud that the list then forgets,
 * which is why the two writes share a transaction rather than merely happening
 * near each other.
 */
async function note(
  candidateId: string,
  action: RecommendationFeedback['action'],
  at: number,
  scoreVersion?: string,
  bookId?: string,
): Promise<void> {
  const existing = await db.recommendationFeedback.get(candidateId)
  // What the list remembers, which is the strongest thing the reader has done
  // with this card rather than the most recent. A weaker later action does not
  // un-dismiss a book. The events remain the record of what happened and in
  // what order; this row exists only to decide whether to show the card again.
  const keep = existing && WEIGHT[existing.action] > WEIGHT[action]
  await db.recommendationFeedback.put({
    candidateId,
    action: keep ? existing.action : action,
    at: keep ? existing.at : at,
    ...((bookId ?? existing?.bookId) ? { bookId: bookId ?? existing?.bookId } : {}),
    ...((scoreVersion ?? existing?.scoreVersion)
      ? { scoreVersion: scoreVersion ?? existing?.scoreVersion }
      : {}),
  })
}

async function record(
  action: RecommendationFeedback['action'],
  recommendation: RecommendationRef,
  at: number,
  enqueue: () => Promise<unknown>,
): Promise<void> {
  await db.transaction(
    'rw',
    [db.settings, db.syncState, db.eventOutbox, db.recommendationFeedback],
    async () => {
      await enqueue()
      await note(recommendation.candidateId, action, at, recommendation.scoreVersion)
    },
  )
}

/**
 * An impression. Emitted once per candidate per list, not once per render:
 * a component that re-rendered would otherwise report the reader looking at
 * something they never looked at twice.
 */
export async function recordRecommendationShown(
  recommendation: RecommendationRef,
  at = Date.now(),
): Promise<void> {
  const payload: EventPayloadByType['recommendation_shown'] = {
    shownAt: timestamp(at),
    candidateId: recommendation.candidateId,
    ...(recommendation.scoreVersion ? { scoreVersion: recommendation.scoreVersion } : {}),
    ...(recommendation.rank ? { rank: recommendation.rank } : {}),
    ...(typeof recommendation.recommendationScore === 'number'
      ? { recommendationScore: recommendation.recommendationScore }
      : {}),
  }
  await record('shown', recommendation, at, () =>
    enqueueEvent({
      eventType: 'recommendation_shown',
      eventTime: at,
      entities: {},
      content: () => ({ payload, included: [] }),
    }),
  )
}

export async function recordRecommendationOpened(
  recommendation: RecommendationRef,
  at = Date.now(),
): Promise<void> {
  const payload: EventPayloadByType['recommendation_opened'] = {
    openedAt: timestamp(at),
    candidateId: recommendation.candidateId,
    ...(recommendation.scoreVersion ? { scoreVersion: recommendation.scoreVersion } : {}),
    ...(recommendation.rank ? { rank: recommendation.rank } : {}),
  }
  await record('opened', recommendation, at, () =>
    enqueueEvent({
      eventType: 'recommendation_opened',
      eventTime: at,
      entities: {},
      content: () => ({ payload, included: [] }),
    }),
  )
}

/**
 * An explicit negative, which is the scarcest thing in this dataset and the
 * reason the gate counts it separately. A list nobody dismisses teaches a
 * ranker only what was already ranked highly.
 */
export async function recordRecommendationDismissed(
  recommendation: RecommendationRef,
  reason: EventPayloadByType['recommendation_dismissed']['reason'] = 'unspecified',
  at = Date.now(),
): Promise<void> {
  const payload: EventPayloadByType['recommendation_dismissed'] = {
    dismissedAt: timestamp(at),
    candidateId: recommendation.candidateId,
    ...(recommendation.scoreVersion ? { scoreVersion: recommendation.scoreVersion } : {}),
    reason,
  }
  await record('dismissed', recommendation, at, () =>
    enqueueEvent({
      eventType: 'recommendation_dismissed',
      eventTime: at,
      entities: {},
      content: () => ({ payload, included: [] }),
    }),
  )
}

/**
 * The reader put the recommended book in their library. `bookId` is the local
 * book this became, which is what ties the outcome to everything the reader
 * subsequently does with it.
 */
export async function recordRecommendedBookAdded(
  recommendation: RecommendationRef,
  bookId: string,
  at = Date.now(),
): Promise<void> {
  const payload: EventPayloadByType['recommended_book_added'] = {
    addedAt: timestamp(at),
    candidateId: recommendation.candidateId,
    ...(recommendation.scoreVersion ? { scoreVersion: recommendation.scoreVersion } : {}),
  }
  await db.transaction(
    'rw',
    [db.settings, db.syncState, db.eventOutbox, db.recommendationFeedback],
    async () => {
      await enqueueEvent({
        eventType: 'recommended_book_added',
        eventTime: at,
        entities: { bookId },
        content: () => ({ payload, included: [] }),
      })
      // The book id is what lets the start be attributed later: by the time the
      // reader opens it, the only thing linking a book in the library to a
      // recommendation is this row. Through the same guard as every other
      // note, so an add cannot walk back a start.
      await note(recommendation.candidateId, 'added', at, recommendation.scoreVersion, bookId)
    },
  )
}

/**
 * The recommendation a book in the library came from, if it came from one.
 *
 * How a start gets attributed. Nothing else connects an EPUB the reader opened
 * to a work key a list once suggested.
 */
export async function candidateForBook(
  bookId: string,
): Promise<RecommendationFeedback | undefined> {
  const rows = await db.recommendationFeedback.where('action').anyOf('added', 'started').toArray()
  return rows.find((row) => row.bookId === bookId)
}

/** The stronger positive: they added it and then opened it to read. */
export async function recordRecommendedBookStarted(
  recommendation: RecommendationRef,
  bookId: string,
  at = Date.now(),
): Promise<void> {
  const payload: EventPayloadByType['recommended_book_started'] = {
    startedAt: timestamp(at),
    candidateId: recommendation.candidateId,
    ...(recommendation.scoreVersion ? { scoreVersion: recommendation.scoreVersion } : {}),
  }
  await record('started', recommendation, at, () =>
    enqueueEvent({
      eventType: 'recommended_book_started',
      eventTime: at,
      entities: { bookId },
      content: () => ({ payload, included: [] }),
    }),
  )
}

/**
 * Candidates the reader has already dealt with, so the list does not offer them
 * again between cloud refreshes.
 *
 * An impression is not "dealt with": seeing a book is not a decision about it,
 * and hiding what has merely been shown would empty the list after one look.
 */
export async function settledCandidates(): Promise<Set<string>> {
  const rows = await db.recommendationFeedback
    .where('action')
    .anyOf('dismissed', 'added', 'started')
    .toArray()
  return new Set(rows.map((row) => row.candidateId))
}

/** Every candidate already reported as seen, so an impression is not repeated. */
export async function alreadyShown(): Promise<Set<string>> {
  const rows = await db.recommendationFeedback.toArray()
  return new Set(rows.map((row) => row.candidateId))
}
