import { db } from '../db/db'
import { DEFAULT_SETTINGS } from '../db/types'
import { runCoordinatedDelivery } from './coordinator'
import { deliverPendingEvents, recoverHeldQuestions } from './delivery'
import { HttpDeliveryTransport, type HttpDeliveryOptions, type PauseReason } from './transport'

export const DELIVERY_INTERVAL_MS = 60_000

async function readSyncToken(): Promise<string | undefined> {
  return (await db.settings.get('settings'))?.syncToken
}

async function pauseDelivery(reason: PauseReason): Promise<void> {
  const state = await db.syncState.get('sync')
  if (state) await db.syncState.put({ ...state, pausedReason: reason })
}

export function createDeliveryTransport(
  overrides: Partial<HttpDeliveryOptions> = {},
): HttpDeliveryTransport {
  return new HttpDeliveryTransport({
    token: readSyncToken,
    onPause: pauseDelivery,
    ...overrides,
  })
}

/**
 * Delivers whatever is queued, if delivery is allowed right now.
 *
 * Reading never waits on this: a paused, disabled, or offline installation
 * simply does nothing and leaves the outbox intact.
 */
export async function deliverNow(
  transport = createDeliveryTransport(),
): Promise<number> {
  const settings = { ...DEFAULT_SETTINGS, ...(await db.settings.get('settings')) }
  if (!settings.syncEnabled || !settings.syncToken) return 0

  // Recheck on every delivery tick so an interrupted provisional question is
  // released after its stale window without requiring another page load.
  await recoverHeldQuestions()

  const state = await db.syncState.get('sync')
  if (state?.pausedReason) return 0
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0

  let accepted = 0
  await runCoordinatedDelivery(async () => {
    accepted = await deliverPendingEvents(transport)
  })
  return accepted
}

/**
 * Starts the background delivery loop and returns its teardown function.
 * Coming back online, returning to the tab, and a one-minute timer each nudge
 * it; none of them block the reader.
 */
export function startDeliveryLoop(transport = createDeliveryTransport()): () => void {
  const run = () => {
    void deliverNow(transport).catch(() => {
      // Delivery failures are already recorded on the outbox rows.
    })
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') run()
  }

  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', onVisible)
  const timer = window.setInterval(run, DELIVERY_INTERVAL_MS)
  run()

  return () => {
    window.removeEventListener('online', run)
    document.removeEventListener('visibilitychange', onVisible)
    window.clearInterval(timer)
  }
}
