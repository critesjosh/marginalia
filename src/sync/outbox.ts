import { db } from '../db/db'
import { DEFAULT_SETTINGS, type Settings } from '../db/types'
import { newId } from '../lib/id'
import { consentFromSettings, privacySnapshot } from './privacy'
import {
  EVENT_SCHEMA_VERSION,
  type EventEntities,
  type EventOutboxRow,
  type EventPayloadByType,
  type MarginaliaEventV1,
  type OutboxStatus,
  type MarginaliaEventType,
  type PrivacyCategory,
  type SyncConsentV1,
  type SyncState,
} from './types'

const APP_VERSION = '0.0.0'

export interface EventContent<T extends MarginaliaEventType> {
  payload: EventPayloadByType[T]
  included: PrivacyCategory[]
}

export interface EnqueueEventInput<T extends MarginaliaEventType> {
  eventType: T
  eventTime: number
  entities: EventEntities
  status?: OutboxStatus
  now?: number
  content: (consent: SyncConsentV1) => EventContent<T>
}

function settingsWithDefaults(stored: Settings | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...stored }
}

async function syncState(): Promise<SyncState> {
  const stored = await db.syncState.get('sync')
  if (stored) return stored
  return {
    id: 'sync',
    installationId: newId(),
    nextSequence: 1,
  }
}

/**
 * Queues an event inside the caller's Dexie transaction.
 *
 * Every caller must include settings, syncState, and eventOutbox in the
 * transaction together with the product table it changes.
 */
export async function enqueueEvent<T extends MarginaliaEventType>(
  input: EnqueueEventInput<T>,
): Promise<EventOutboxRow | undefined> {
  const settings = settingsWithDefaults(await db.settings.get('settings'))
  const consent = consentFromSettings(settings)
  if (!consent.syncEnabled) return undefined

  const state = await syncState()
  const now = input.now ?? Date.now()
  const content = input.content(consent)
  const event: MarginaliaEventV1<T> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: newId(),
    installationId: state.installationId,
    sequence: state.nextSequence,
    source: 'pwa',
    appVersion: APP_VERSION,
    eventType: input.eventType,
    eventTime: new Date(input.eventTime).toISOString(),
    emittedAt: new Date(now).toISOString(),
    entities: input.entities,
    privacy: privacySnapshot(consent, content.included),
    payload: content.payload,
  }

  const row: EventOutboxRow = {
    eventId: event.eventId,
    sequence: event.sequence,
    eventType: event.eventType,
    eventTime: event.eventTime,
    payload: event as MarginaliaEventV1,
    privacySnapshot: event.privacy,
    status: input.status ?? 'pending',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
  }

  await db.syncState.put({ ...state, nextSequence: state.nextSequence + 1 })
  await db.eventOutbox.add(row)
  return row
}
