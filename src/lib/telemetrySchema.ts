/**
 * The complete list of product events and the properties each may carry
 * (docs/telemetry.md, decision 0008). Anything not named here is dropped
 * before it leaves the device, so a careless call site cannot send book text,
 * titles, notes, prompts, replies, URLs or other free text.
 */

type Validator<T> = (value: unknown) => value is T

function oneOf<const T extends string>(...values: T[]): Validator<T> {
  const allowed = new Set<string>(values)
  return (value): value is T => typeof value === 'string' && allowed.has(value)
}

function matching(pattern: RegExp): Validator<string> {
  return (value): value is string => typeof value === 'string' && pattern.test(value)
}

const isBoolean: Validator<boolean> = (value): value is boolean => typeof value === 'boolean'

const httpStatus: Validator<number> = (value): value is number =>
  Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599

const ERROR_CATEGORIES = [
  'network',
  'timeout',
  'canceled',
  'rate_limited',
  'unavailable',
  'server',
  'client',
  'storage',
  'storage_quota',
  'invalid_epub',
  'not_found',
  'unknown',
] as const
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

const FEATURES = ['app', 'import', 'reader', 'annotations', 'chat', 'feedback'] as const
export type Feature = (typeof FEATURES)[number]

const OPERATIONS = [
  'uncaught',
  'unhandled_rejection',
  'render',
  'import_file',
  'import_gutenberg',
  'import_shared_link',
  'open_book',
  'save_highlight',
  'delete_highlight',
  'send_message',
] as const
export type Operation = (typeof OPERATIONS)[number]

/** `E-` and six characters from an alphabet without characters that look alike. */
export const ERROR_REF_PATTERN = /^E-[A-HJ-NP-Z2-9]{6}$/

const errorCategory = oneOf(...ERROR_CATEGORIES)
const errorRef = matching(ERROR_REF_PATTERN)
const outcome = oneOf('success', 'failure')
const feature = oneOf(...FEATURES)
const operation = oneOf(...OPERATIONS)
/** A code-defined class name such as `TypeError`, never a message. */
export const ERROR_NAME_PATTERN = /^[A-Z][A-Za-z]{0,39}$/
const errorName = matching(ERROR_NAME_PATTERN)

/** Free text the reader typed into Report a problem, already scrubbed. */
export const MAX_FEEDBACK_LENGTH = 1000
const feedback: Validator<string> = (value): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_FEEDBACK_LENGTH

export const EVENT_SCHEMA = {
  app_opened: { display_mode: oneOf('browser', 'standalone') },
  book_imported: {
    source: oneOf('file', 'gutenberg', 'shared_link'),
    outcome,
    error_category: errorCategory,
  },
  reader_opened: {
    book_kind: oneOf('bundled', 'imported'),
    outcome,
    error_category: errorCategory,
  },
  text_selected: { length_bucket: oneOf('under_20', '20_199', '200_999', '1000_plus') },
  annotation_created: { trigger: oneOf('highlight', 'ask') },
  annotation_deleted: {},
  ai_message_sent: {
    outcome: oneOf('success', 'failure', 'canceled'),
    turn: oneOf('first', 'follow_up'),
    duration_bucket: oneOf('under_2s', '2_10s', '10_30s', '30s_plus'),
    error_category: errorCategory,
    http_status: httpStatus,
  },
  error_occurred: {
    feature,
    operation,
    error_category: errorCategory,
    error_name: errorName,
    http_status: httpStatus,
    error_ref: errorRef,
  },
  /** Carries the last error's sanitized details: with usage data off, nothing else does. */
  problem_reported: {
    has_feedback: isBoolean,
    feedback,
    error_ref: errorRef,
    feature,
    operation,
    error_category: errorCategory,
    error_name: errorName,
    http_status: httpStatus,
  },
} satisfies Record<string, Record<string, Validator<unknown>>>

/** Sent with every event; set by the client, not by call sites. */
export const COMMON_SCHEMA = {
  app_version: matching(/^[\w.-]{1,40}$/),
  form_factor: oneOf('touch', 'pointer'),
  browser_family: oneOf('chrome', 'edge', 'firefox', 'safari', 'other'),
}

export type EventName = keyof typeof EVENT_SCHEMA
type Validated<V> = V extends Validator<infer T> ? T : never
export type EventProperties<E extends EventName> = {
  [K in keyof (typeof EVENT_SCHEMA)[E]]?: Validated<(typeof EVENT_SCHEMA)[E][K]>
}
export type CommonProperties = {
  [K in keyof typeof COMMON_SCHEMA]: Validated<(typeof COMMON_SCHEMA)[K]>
}

export function isEventName(name: unknown): name is EventName {
  return typeof name === 'string' && Object.hasOwn(EVENT_SCHEMA, name)
}

/** Keeps only the properties `schema` names, and only values that pass its check. */
export function pickAllowed(
  schema: Record<string, Validator<unknown>>,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, valid] of Object.entries(schema)) {
    if (Object.hasOwn(properties, key) && valid(properties[key])) kept[key] = properties[key]
  }
  return kept
}

export function lengthBucket(length: number): EventProperties<'text_selected'>['length_bucket'] {
  if (length < 20) return 'under_20'
  if (length < 200) return '20_199'
  if (length < 1000) return '200_999'
  return '1000_plus'
}

export function durationBucket(ms: number): EventProperties<'ai_message_sent'>['duration_bucket'] {
  if (ms < 2000) return 'under_2s'
  if (ms < 10_000) return '2_10s'
  if (ms < 30_000) return '10_30s'
  return '30s_plus'
}
