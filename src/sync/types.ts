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

export type MarginaliaEventType =
  | 'privacy_consent_changed'
  | 'highlight_created'
  | 'highlight_updated'
  | 'highlight_deleted'
  | 'conversation_started'
  | 'question_asked'
  | 'book_opened'
  | 'book_closed'
  | 'reading_progressed'
  | 'chapter_entered'
  | 'book_completed'
  | 'book_reopened'
  | 'book_added'
  | 'book_archived'
  | 'book_restored'
  | 'book_deleted'
  | 'assistant_response_received'
  | 'conversation_resumed'
  | 'recommendation_dismissed'
  | 'recommendation_shown'
  | 'recommendation_opened'
  | 'recommended_book_added'
  | 'recommended_book_started'
  | 'book_memory_updated'
  | 'conversation_deleted'

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
  book_opened: { progress: number; chapter?: string; openedAt: string; reopened?: boolean }
  book_closed: {
    progress: number
    chapter?: string
    closedAt: string
    reason: 'explicit' | 'backgrounded' | 'navigated_away'
  }
  reading_progressed: {
    progress: number
    chapter?: string
    observedAt: string
    trigger: 'progress_delta' | 'chapter_change' | 'closing' | 'backgrounded'
  }
  chapter_entered: {
    chapter: string
    chapterIndex?: number
    progress: number
    enteredAt: string
  }
  book_completed: { progress: number; completedAt: string }
  book_reopened: {
    progress: number
    chapter?: string
    reopenedAt: string
    daysSinceLastOpen: number
  }
  book_added: {
    addedAt: string
    origin: 'import' | 'sample' | 'gutenberg' | 'koreader'
    title?: string
    author?: string
    publisher?: string
    published?: string
    language?: string
    description?: string
  }
  book_archived: { archivedAt: string; progress?: number }
  book_restored: { restoredAt: string; progress?: number }
  book_deleted: {
    removedAt: string
    highlightsRemoved?: number
    conversationsRemoved?: number
  }
  assistant_response_received: {
    receivedAt: string
    succeeded: boolean
    latencyMs?: number
    model?: string
    failureCode?: string
    content?: string
  }
  conversation_resumed: {
    resumedAt: string
    messageCount?: number
    chapter?: string
    progress?: number
  }
  recommendation_dismissed: {
    dismissedAt: string
    candidateId: string
    scoreVersion?: string
    reason?: 'not_interested' | 'already_read' | 'wrong_topic' | 'unspecified'
  }
  /**
   * The impression. `rank` is here because an impression at the top of a list
   * and one at the bottom are not the same evidence, and a ranker trained
   * without it learns the list's own order as though it were the reader's
   * preference.
   */
  recommendation_shown: {
    shownAt: string
    candidateId: string
    scoreVersion?: string
    rank?: number
    recommendationScore?: number
  }
  recommendation_opened: {
    openedAt: string
    candidateId: string
    scoreVersion?: string
    rank?: number
  }
  recommended_book_added: { addedAt: string; candidateId: string; scoreVersion?: string }
  recommended_book_started: { startedAt: string; candidateId: string; scoreVersion?: string }
  book_memory_updated: { updatedAt: string; summary?: string; cleared?: boolean }
  conversation_deleted: { deletedAt: string; messagesRemoved?: number }
}

export type MarginaliaEventV1<T extends MarginaliaEventType = MarginaliaEventType> = {
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
  eventType: MarginaliaEventType
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
  pausedReason?: 'invalid_token' | 'rejected_event' | 'sync_disabled'
  activeDeletionRequestId?: string
}

/**
 * What the reader has already done with one recommendation.
 *
 * A local view of outcomes the events already carry, kept so a dismissed book
 * does not reappear when the cloud recomputes its candidate list on its own
 * schedule. Losing it costs a repeated card, not a lost dismissal: the event is
 * the record, this is only what the list remembers.
 */
export interface RecommendationFeedback {
  candidateId: string
  action: 'shown' | 'opened' | 'dismissed' | 'added' | 'started'
  at: number
  /**
   * The book this recommendation became, once the reader added it. It is the
   * only thing connecting an EPUB in the library to a work key a list once
   * suggested, and so the only way a later start can be attributed.
   */
  bookId?: string
  /**
   * The scoring that produced the recommendation, kept because a start can
   * happen months after the list that suggested it and the outcome is only
   * interpretable against the formula behind it. Without this the strongest
   * positive is the one signal with no provenance.
   */
  scoreVersion?: string
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
