// Types for the generated validators. The generator emits plain JavaScript so
// the Worker can run it without dynamic code generation; the shape below is
// fixed by tools/generate-event-validators.mjs.
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
