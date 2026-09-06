import { db } from '../db/db'
import type { DeliveryResult, DeliveryTransport, EventOutboxRow } from './types'

export const MAX_BATCH_EVENTS = 20
export const HELD_RECOVERY_AGE_MS = 15 * 60_000

/**
 * A Confluent response that is neither a throttle nor a server fault means the
 * request or the topic configuration is wrong, and retrying cannot fix it.
 * Delivery is head-of-line, so retrying forever would silently stop sync for
 * good. Give the operator time to correct it, then reject into diagnostics so
 * the reader is actually told.
 */
export const MAX_CONFIGURATION_ATTEMPTS = 8

export function nextHeadOfLineBatch(
  rows: readonly EventOutboxRow[],
  now: number,
  limit = MAX_BATCH_EVENTS,
): EventOutboxRow[] {
  const outstanding = [...rows].sort((a, b) => a.sequence - b.sequence)
  if (!outstanding.length) return []

  const head = outstanding[0]
  if (head.status !== 'pending' || head.nextAttemptAt > now) return []

  const batch: EventOutboxRow[] = []
  for (const row of outstanding) {
    if (batch.length >= limit) break
    if (row.status !== 'pending' || row.nextAttemptAt > now) break
    batch.push(row)
  }
  return batch
}

export function retryAt(attempts: number, now: number, random = Math.random): number {
  const base = Math.min(300_000, 2 ** Math.min(attempts, 18) * 1_000)
  return now + Math.round(base * (1 + random() * 0.25))
}

function resultById(results: readonly DeliveryResult[]): Map<string, DeliveryResult> {
  return new Map(results.map((result) => [result.eventId, result]))
}

export async function deliverPendingEvents(
  transport: DeliveryTransport,
  options: { now?: number; random?: () => number } = {},
): Promise<number> {
  const now = options.now ?? Date.now()
  const rows = await db.eventOutbox.toArray()
  const batch = nextHeadOfLineBatch(rows, now)
  if (!batch.length) return 0

  const results = resultById(await transport.send(batch.map((row) => row.payload)))
  let accepted = 0

  await db.transaction('rw', [db.eventOutbox, db.syncState], async () => {
    let blocked = false
    for (const row of batch) {
      // A rejection is a verdict about this event itself, so it survives an
      // earlier failure in the same batch; discarding it would strand the row as
      // pending forever, invisible to the diagnostics that let it be retried or
      // discarded. Any other result after a failure is replaced, because nothing
      // was produced once the batch stopped.
      const reported = results.get(row.eventId)
      const delivery =
        reported && (!blocked || reported.status === 'rejected')
          ? reported
          : {
              eventId: row.eventId,
              status: 'retry' as const,
              code: blocked ? 'blocked_by_prior_event' : 'missing_delivery_result',
            }

      if (delivery.status === 'accepted') {
        await db.eventOutbox.delete(row.eventId)
        accepted += 1
        continue
      }

      blocked = true
      if (delivery.status === 'rejected') {
        await db.eventOutbox.update(row.eventId, {
          status: 'rejected',
          lastErrorCode: delivery.code,
        })
        const state = await db.syncState.get('sync')
        if (state) await db.syncState.put({ ...state, pausedReason: 'rejected_event' })
        continue
      }

      const attempts = row.attempts + (delivery.code === 'blocked_by_prior_event' ? 0 : 1)

      if (delivery.code === 'upstream_configuration' && attempts >= MAX_CONFIGURATION_ATTEMPTS) {
        await db.eventOutbox.update(row.eventId, {
          status: 'rejected',
          attempts,
          lastErrorCode: delivery.code,
        })
        const state = await db.syncState.get('sync')
        if (state) await db.syncState.put({ ...state, pausedReason: 'rejected_event' })
        continue
      }

      await db.eventOutbox.update(row.eventId, {
        attempts,
        lastErrorCode: delivery.code,
        nextAttemptAt:
          delivery.code === 'blocked_by_prior_event'
            ? row.nextAttemptAt
            : retryAt(attempts, now, options.random),
      })
    }

    if (accepted) {
      const state = await db.syncState.get('sync')
      if (state) await db.syncState.put({ ...state, lastSuccessfulDeliveryAt: now })
    }
  })

  return accepted
}

export async function retryRejectedEvent(eventId: string, now = Date.now()): Promise<void> {
  await db.eventOutbox.update(eventId, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastErrorCode: undefined,
  })
  await clearRejectedPauseWhenPossible()
}

/**
 * Releases stale provisional question events left behind by a tab that
 * disappeared while the model was answering. A recent held row may still
 * belong to another tab's live stream, so it is never released early. The
 * question message was committed in the same transaction as the held event and
 * is the recovery record; an orphan is discarded immediately.
 */
export async function recoverHeldQuestions(
  now = Date.now(),
  minimumAge = HELD_RECOVERY_AGE_MS,
): Promise<{ released: number; discarded: number }> {
  return db.transaction('rw', [db.eventOutbox, db.messages], async () => {
    const held = await db.eventOutbox.where('status').equals('held').toArray()
    let released = 0
    let discarded = 0

    for (const row of held) {
      if (row.eventType !== 'question_asked') continue
      const messageId = row.payload.entities.messageId
      const message = messageId ? await db.messages.get(messageId) : undefined
      if (!message) {
        await db.eventOutbox.delete(row.eventId)
        discarded += 1
      } else if (now - row.createdAt >= minimumAge) {
        await db.eventOutbox.update(row.eventId, {
          status: 'pending',
          nextAttemptAt: now,
          lastErrorCode: undefined,
        })
        released += 1
      }
    }

    return { released, discarded }
  })
}

export async function releaseHeldEvent(eventId: string, now = Date.now()): Promise<void> {
  const row = await db.eventOutbox.get(eventId)
  if (row?.status !== 'held') return
  await db.eventOutbox.update(eventId, {
    status: 'pending',
    nextAttemptAt: now,
    lastErrorCode: undefined,
  })
}

export async function discardOutboxEvent(eventId: string): Promise<void> {
  await db.eventOutbox.delete(eventId)
  await clearRejectedPauseWhenPossible()
}

async function clearRejectedPauseWhenPossible(): Promise<void> {
  if ((await db.eventOutbox.where('status').equals('rejected').count()) > 0) return
  const state = await db.syncState.get('sync')
  if (state?.pausedReason === 'rejected_event') {
    await db.syncState.put({ ...state, pausedReason: undefined })
  }
}
