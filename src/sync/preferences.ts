import { db } from '../db/db'
import { DEFAULT_SETTINGS, type Settings } from '../db/types'
import {
  changedContentConsent,
  consentFromSettings,
  revokedCategories,
} from './privacy'
import { enqueueEvent } from './outbox'
import type { SyncPreferenceKey } from './types'

type SyncPreferencePatch = Partial<Pick<Settings, SyncPreferenceKey>>

export async function requestPersistentStorage(): Promise<Settings['storagePersistence']> {
  if (!navigator.storage?.persist) return 'unavailable'
  try {
    return (await navigator.storage.persist()) ? 'granted' : 'denied'
  } catch {
    return 'unavailable'
  }
}

export async function updateSyncPreferences(
  patch: SyncPreferencePatch,
  now = Date.now(),
): Promise<Settings> {
  const observed = { ...DEFAULT_SETTINGS, ...(await db.settings.get('settings')) }
  const enabling = !observed.syncEnabled && patch.syncEnabled === true
  const storagePersistence = enabling
    ? await requestPersistentStorage()
    : observed.storagePersistence

  return db.transaction('rw', [db.settings, db.eventOutbox, db.syncState], async () => {
    // The UI, another tab, or an automation driver can issue overlapping
    // changes. Read inside the transaction so the second caller sees the
    // first commit and a duplicate transition becomes a true no-op.
    const current = { ...DEFAULT_SETTINGS, ...(await db.settings.get('settings')) }
    const changedPreference = Object.entries(patch).some(
      ([key, value]) => current[key as keyof Settings] !== value,
    )
    const nextStoragePersistence =
      !current.syncEnabled && patch.syncEnabled === true
        ? storagePersistence
        : current.storagePersistence
    if (!changedPreference && nextStoragePersistence === current.storagePersistence) return current

    const next: Settings = {
      ...current,
      ...patch,
      storagePersistence: nextStoragePersistence,
      consentVersion: 1,
      consentUpdatedAt: changedPreference
        ? new Date(now).toISOString()
        : current.consentUpdatedAt,
      id: 'settings',
    }
    const previousConsent = consentFromSettings(current)
    const nextConsent = consentFromSettings(next)
    const revoked = new Set(revokedCategories(previousConsent, nextConsent))

    await db.settings.put(next)

    if (!next.syncEnabled) {
      await db.eventOutbox.clear()
      const state = await db.syncState.get('sync')
      if (state) await db.syncState.put({ ...state, pausedReason: undefined })
      return next
    }

    if (revoked.size) {
      await db.eventOutbox
        .filter((row) => row.privacySnapshot.included.some((category) => revoked.has(category)))
        .delete()
    }

    const changed = changedContentConsent(previousConsent, nextConsent)
    if (!previousConsent.syncEnabled && nextConsent.syncEnabled) {
      changed.unshift({ category: 'usageMetadata', enabled: true })
    }

    if (changed.length) {
      await enqueueEvent({
        eventType: 'privacy_consent_changed',
        eventTime: now,
        entities: {},
        now,
        content: () => ({
          payload: { changed, consentUpdatedAt: next.consentUpdatedAt },
          included: [],
        }),
      })
    }
    return next
  })
}
