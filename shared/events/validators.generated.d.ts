// Types for the generated validators. The generator emits plain JavaScript so
// the Worker can run it without dynamic code generation, so the declarations
// are generated alongside it by tools/generate-event-validators.mjs.
export interface StandaloneValidatorError {
  instancePath: string
  schemaPath: string
  keyword: string
  message?: string
  params?: Record<string, unknown>
}

export interface StandaloneValidator {
  (data: unknown): boolean
  errors?: StandaloneValidatorError[] | null
}

export declare const validate_envelope: StandaloneValidator
export declare const validate_consent: StandaloneValidator
export declare const validate_privacy_consent_changed: StandaloneValidator
export declare const validate_highlight_created: StandaloneValidator
export declare const validate_highlight_updated: StandaloneValidator
export declare const validate_highlight_deleted: StandaloneValidator
export declare const validate_conversation_started: StandaloneValidator
export declare const validate_question_asked: StandaloneValidator
export declare const validate_book_opened: StandaloneValidator
export declare const validate_book_closed: StandaloneValidator
export declare const validate_reading_progressed: StandaloneValidator
export declare const validate_chapter_entered: StandaloneValidator
export declare const validate_book_completed: StandaloneValidator
export declare const validate_book_reopened: StandaloneValidator
export declare const validate_book_added: StandaloneValidator
export declare const validate_book_archived: StandaloneValidator
export declare const validate_book_restored: StandaloneValidator
export declare const validate_book_memory_updated: StandaloneValidator
export declare const validate_conversation_deleted: StandaloneValidator
export declare const validate_book_deleted: StandaloneValidator
export declare const validate_assistant_response_received: StandaloneValidator
export declare const validate_conversation_resumed: StandaloneValidator
export declare const validate_recommendation_dismissed: StandaloneValidator
export declare const validate_recommendation_shown: StandaloneValidator
export declare const validate_recommendation_opened: StandaloneValidator
export declare const validate_recommended_book_added: StandaloneValidator
export declare const validate_recommended_book_started: StandaloneValidator
