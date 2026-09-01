export const CONSENT_VERSION = 1 as const
export const EVENT_SCHEMA_VERSION = 1 as const

export type PrivacyCategory =
  | 'bookMetadata'
  | 'highlightText'
  | 'highlightNotes'
  | 'conversationText'
  | 'assistantText'
  | 'bookMemory'
  | 'surroundingContext'

export type ConsentChangeCategory = PrivacyCategory | 'usageMetadata'

export interface SyncConsentV1 {
  consentVersion: typeof CONSENT_VERSION
  consentUpdatedAt: string
  syncEnabled: boolean
  shareBookMetadata: boolean
  shareHighlightText: boolean
  shareHighlightNotes: boolean
  shareConversationText: boolean
  shareAssistantText: boolean
  shareBookMemory: boolean
  shareSurroundingContext: boolean
}

export type SyncPreferenceKey = Exclude<keyof SyncConsentV1, 'consentVersion' | 'consentUpdatedAt'>

export interface PrivacySnapshot {
  consentVersion: typeof CONSENT_VERSION
  included: PrivacyCategory[]
}

export type PhaseZeroEventType =
  | 'privacy_consent_changed'
  | 'highlight_created'
  | 'highlight_updated'
  | 'highlight_deleted'
  | 'conversation_started'
  | 'question_asked'

export interface EventEntities {
  bookId?: string
  highlightId?: string
  conversationId?: string
  messageId?: string
}

export interface HighlightSnapshotPayload {
  color: 'yellow' | 'green' | 'blue' | 'pink'
  chapter?: string
  progress?: number
  createdAt: string
  text?: string
  note?: string
}

export interface EventPayloadByType {
  privacy_consent_changed: {
    changed: { category: ConsentChangeCategory; enabled: boolean }[]
    consentUpdatedAt: string
  }
  highlight_created: HighlightSnapshotPayload
  highlight_updated: HighlightSnapshotPayload & {
    changedFields: ('color' | 'chapter' | 'progress' | 'text' | 'note')[]
  }
  highlight_deleted: { deletedAt: string }
  conversation_started: {
    createdAt: string
    title?: string
    seedText?: string
    chapter?: string
    progress?: number
  }
  question_asked: {
    createdAt: string
    chapter?: string
    progress?: number
    content?: string
  }
}

export type MarginaliaEventV1<T extends PhaseZeroEventType = PhaseZeroEventType> = {
  schemaVersion: typeof EVENT_SCHEMA_VERSION
  eventId: string
  installationId: string
  sequence: number
  source: 'pwa' | 'koreader'
  appVersion: string
  eventType: T
  eventTime: string
  emittedAt: string
  entities: EventEntities
  privacy: PrivacySnapshot
  payload: EventPayloadByType[T]
}

export type OutboxStatus = 'held' | 'pending' | 'rejected'

export interface EventOutboxRow {
  eventId: string
  sequence: number
  eventType: PhaseZeroEventType
  eventTime: string
  payload: MarginaliaEventV1
  privacySnapshot: PrivacySnapshot
  status: OutboxStatus
  attempts: number
  nextAttemptAt: number
  lastErrorCode?: string
  createdAt: number
}

export interface SyncState {
  id: 'sync'
  installationId: string
  nextSequence: number
  leaseOwner?: string
  leaseExpiresAt?: number
  lastSuccessfulDeliveryAt?: number
  pausedReason?: 'invalid_token' | 'rejected_event'
  activeDeletionRequestId?: string
}

export interface InsightsCache {
  id: string
  payload: unknown
  sourceUpdatedAt: number
  cachedAt: number
}

export type DeliveryResult =
  | { eventId: string; status: 'accepted' }
  | { eventId: string; status: 'retry'; code: string }
  | { eventId: string; status: 'rejected'; code: string }

export interface DeliveryTransport {
  send(events: MarginaliaEventV1[]): Promise<DeliveryResult[]>
}
