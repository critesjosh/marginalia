// Contract validation shared by the Worker and the delivery tests.
//
// The validators are generated ahead of time (see
// tools/generate-event-validators.mjs) because the Workers runtime refuses the
// dynamic code generation Ajv uses to compile a schema at runtime.
import {
  validate_conversation_started,
  validate_envelope,
  validate_highlight_created,
  validate_highlight_deleted,
  validate_highlight_updated,
  validate_privacy_consent_changed,
  validate_question_asked,
  validate_book_opened,
  validate_book_closed,
  validate_reading_progressed,
  validate_chapter_entered,
  validate_book_completed,
  validate_book_reopened,
  validate_book_added,
  validate_book_archived,
  validate_book_restored,
  validate_book_deleted,
  validate_assistant_response_received,
  validate_conversation_resumed,
  validate_recommendation_dismissed,
  validate_recommendation_opened,
  validate_recommendation_shown,
  validate_recommended_book_added,
  validate_recommended_book_started,
  validate_book_memory_updated,
  validate_conversation_deleted,
  type StandaloneValidator,
  type StandaloneValidatorError,
} from './validators.generated.js'

export const EVENT_SCHEMA_VERSION = 1

export const PAYLOAD_VALIDATORS: Record<string, StandaloneValidator> = {
  privacy_consent_changed: validate_privacy_consent_changed,
  highlight_created: validate_highlight_created,
  highlight_updated: validate_highlight_updated,
  highlight_deleted: validate_highlight_deleted,
  conversation_started: validate_conversation_started,
  question_asked: validate_question_asked,
  book_opened: validate_book_opened,
  book_closed: validate_book_closed,
  reading_progressed: validate_reading_progressed,
  chapter_entered: validate_chapter_entered,
  book_completed: validate_book_completed,
  book_reopened: validate_book_reopened,
  book_added: validate_book_added,
  book_archived: validate_book_archived,
  book_restored: validate_book_restored,
  book_deleted: validate_book_deleted,
  assistant_response_received: validate_assistant_response_received,
  conversation_resumed: validate_conversation_resumed,
  recommendation_dismissed: validate_recommendation_dismissed,
  recommendation_shown: validate_recommendation_shown,
  recommendation_opened: validate_recommendation_opened,
  recommended_book_added: validate_recommended_book_added,
  recommended_book_started: validate_recommended_book_started,
  book_memory_updated: validate_book_memory_updated,
  conversation_deleted: validate_conversation_deleted,
}

/** Why an event may not be produced. Every code is stable and log-safe. */
export type RejectionCode =
  | 'not_an_object'
  | 'unknown_schema_version'
  | 'browser_supplied_user_id'
  | 'unknown_field'
  | 'unknown_event_type'
  | 'schema_invalid'

export type EventValidation =
  | { valid: true; eventId: string; eventType: string; installationId: string; sequence: number }
  | { valid: false; eventId?: string; code: RejectionCode; detail: string }

function detailOf(errors: readonly StandaloneValidatorError[] | null | undefined): string {
  // Schema paths and keywords only. Instance values may hold consented reader
  // text and must never reach a log line or a response body.
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.keyword}`)
    .join('; ')
}

function unknownFieldName(
  errors: readonly StandaloneValidatorError[] | null | undefined,
): string | undefined {
  for (const error of errors ?? []) {
    if (error.keyword !== 'additionalProperties') continue
    const name = (error.params as { additionalProperty?: string } | undefined)?.additionalProperty
    if (name) return name
  }
  return undefined
}

/**
 * Validates one submitted event against the v1 envelope and its payload
 * contract. A valid event carries no field the contract does not name, so
 * private data cannot ride through on a permissive schema.
 */
export function validateSubmittedEvent(value: unknown): EventValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, code: 'not_an_object', detail: 'event is not an object' }
  }

  const candidate = value as Record<string, unknown>
  const eventId = typeof candidate.eventId === 'string' ? candidate.eventId : undefined

  if (candidate.schemaVersion !== EVENT_SCHEMA_VERSION) {
    return {
      valid: false,
      eventId,
      code: 'unknown_schema_version',
      detail: `schemaVersion ${String(candidate.schemaVersion)} is not supported`,
    }
  }

  // The Worker assigns the identity. A body that names a user is refused
  // outright rather than quietly overwritten.
  if ('userId' in candidate) {
    return {
      valid: false,
      eventId,
      code: 'browser_supplied_user_id',
      detail: 'userId is assigned by the server',
    }
  }

  if (!validate_envelope(candidate)) {
    const unknown = unknownFieldName(validate_envelope.errors)
    return {
      valid: false,
      eventId,
      code: unknown ? 'unknown_field' : 'schema_invalid',
      detail: unknown ? `unknown field ${unknown}` : detailOf(validate_envelope.errors),
    }
  }

  const eventType = candidate.eventType as string
  const payloadValidator = PAYLOAD_VALIDATORS[eventType]
  if (!payloadValidator) {
    return { valid: false, eventId, code: 'unknown_event_type', detail: eventType }
  }

  if (!payloadValidator(candidate.payload)) {
    const unknown = unknownFieldName(payloadValidator.errors)
    return {
      valid: false,
      eventId,
      code: unknown ? 'unknown_field' : 'schema_invalid',
      detail: unknown ? `unknown field ${unknown}` : detailOf(payloadValidator.errors),
    }
  }

  return {
    valid: true,
    eventId: candidate.eventId as string,
    eventType,
    installationId: candidate.installationId as string,
    sequence: candidate.sequence as number,
  }
}
