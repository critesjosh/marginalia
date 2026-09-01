import { db } from '../db/db'
import type { DeliveryResult, DeliveryTransport, EventOutboxRow } from './types'

export const MAX_BATCH_EVENTS = 20

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
      const delivery = blocked
        ? { eventId: row.eventId, status: 'retry' as const, code: 'blocked_by_prior_event' }
        : results.get(row.eventId) ?? {
            eventId: row.eventId,
            status: 'retry' as const,
            code: 'missing_delivery_result',
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
