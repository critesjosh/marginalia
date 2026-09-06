import { db } from '../db/db'
import type { SyncState } from './types'

const LOCK_NAME = 'marginalia-event-delivery'
const LEASE_MS = 30_000

async function claimLease(owner: string, now: number): Promise<boolean> {
  return db.transaction('rw', db.syncState, async () => {
    const current = await db.syncState.get('sync')
    const state: SyncState = current ?? {
      id: 'sync',
      installationId: crypto.randomUUID(),
      nextSequence: 1,
    }
    if (state.leaseOwner && state.leaseExpiresAt && state.leaseExpiresAt > now) return false
    await db.syncState.put({ ...state, leaseOwner: owner, leaseExpiresAt: now + LEASE_MS })
    return true
  })
}

async function releaseLease(owner: string): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const state = await db.syncState.get('sync')
    if (state?.leaseOwner === owner) {
      await db.syncState.put({ ...state, leaseOwner: undefined, leaseExpiresAt: undefined })
    }
  })
}

async function renewLease(owner: string): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const state = await db.syncState.get('sync')
    if (state?.leaseOwner === owner) {
      await db.syncState.put({ ...state, leaseExpiresAt: Date.now() + LEASE_MS })
    }
  })
}

export async function runCoordinatedDelivery(
  task: () => Promise<void>,
  options: { now?: number; forceLease?: boolean; owner?: string } = {},
): Promise<boolean> {
  const lockManager = !options.forceLease ? navigator.locks : undefined
  if (lockManager) {
    return lockManager.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return false
      await task()
      return true
    })
  }

  const owner = options.owner ?? crypto.randomUUID()
  if (!(await claimLease(owner, options.now ?? Date.now()))) return false
  const heartbeat = globalThis.setInterval(() => void renewLease(owner), LEASE_MS / 2)
  try {
    await task()
    return true
  } finally {
    globalThis.clearInterval(heartbeat)
    await releaseLease(owner)
  }
}
