import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import envelopeSchema from '../../contracts/events/v1/envelope.schema.json'
import highlightCreatedSchema from '../../contracts/events/v1/payloads/highlight-created.schema.json'
import highlightUpdatedSchema from '../../contracts/events/v1/payloads/highlight-updated.schema.json'
import highlightDeletedSchema from '../../contracts/events/v1/payloads/highlight-deleted.schema.json'
import conversationStartedSchema from '../../contracts/events/v1/payloads/conversation-started.schema.json'
import questionAskedSchema from '../../contracts/events/v1/payloads/question-asked.schema.json'
import privacyChangedSchema from '../../contracts/events/v1/payloads/privacy-consent-changed.schema.json'
import consentSchema from '../../contracts/privacy/v1/consent.schema.json'
import type { MarginaliaEventV1, PhaseZeroEventType, SyncConsentV1 } from './types'

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
addFormats(ajv)

const compile = (schema: object) => ajv.compile(schema)

const validateEnvelope = compile(envelopeSchema)
const validateConsentSchema = compile(consentSchema)
const payloadValidators: Record<PhaseZeroEventType, ValidateFunction> = {
  privacy_consent_changed: compile(privacyChangedSchema),
  highlight_created: compile(highlightCreatedSchema),
  highlight_updated: compile(highlightUpdatedSchema),
  highlight_deleted: compile(highlightDeletedSchema),
  conversation_started: compile(conversationStartedSchema),
  question_asked: compile(questionAskedSchema),
}

export interface ValidationResult {
  valid: boolean
  errors: ErrorObject[]
}

function result(validator: ValidateFunction, value: unknown): ValidationResult {
  const valid = validator(value)
  return { valid, errors: valid ? [] : structuredClone(validator.errors ?? []) }
}

export function validateEvent(value: unknown): ValidationResult {
  const envelope = result(validateEnvelope, value)
  if (!envelope.valid) return envelope

  const event = value as MarginaliaEventV1
  const validator = payloadValidators[event.eventType]
  return validator
    ? result(validator, event.payload)
    : { valid: false, errors: [{ keyword: 'eventType', instancePath: '/eventType', schemaPath: '', params: {}, message: 'is unsupported' }] }
}

export function validateConsent(value: unknown): ValidationResult {
  return result(validateConsentSchema, value)
}

export function assertValidEvent(value: unknown): asserts value is MarginaliaEventV1 {
  const checked = validateEvent(value)
  if (!checked.valid) {
    throw new Error(`Invalid Marginalia event: ${ajv.errorsText(checked.errors)}`)
  }
}

export function assertValidConsent(value: unknown): asserts value is SyncConsentV1 {
  const checked = validateConsent(value)
  if (!checked.valid) {
    throw new Error(`Invalid Marginalia consent: ${ajv.errorsText(checked.errors)}`)
  }
}
