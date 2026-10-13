import { ERROR_NAME_PATTERN, type ErrorCategory } from '../../shared/telemetrySchema'

/**
 * What an error may say about itself in telemetry: a fixed category, the
 * class name and an HTTP status. Messages and stacks are never read out, since
 * they can quote book text, file names or URLs.
 */
export interface ClassifiedError {
  category: ErrorCategory
  name?: string
  status?: number
}

const STORAGE_ERROR_NAMES = new Set([
  'ConstraintError',
  'DataError',
  'DatabaseClosedError',
  'InvalidStateError',
  'MissingAPIError',
  'NotFoundError',
  'OpenFailedError',
  'ReadOnlyError',
  'TransactionInactiveError',
  'UnknownError',
  'VersionError',
])

function statusCategory(status: number): ErrorCategory {
  if (status === 404) return 'not_found'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'unavailable'
  return status >= 500 ? 'server' : 'client'
}

/** The class name, when it looks like one; minified or odd names are dropped. */
function errorName(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null)?.name
  return typeof name === 'string' && ERROR_NAME_PATTERN.test(name) ? name : undefined
}

export function classifyError(err: unknown): ClassifiedError {
  const name = errorName(err)
  const rawStatus = (err as { status?: unknown } | null)?.status
  const status = Number.isInteger(rawStatus) ? (rawStatus as number) : undefined

  let category: ErrorCategory = 'unknown'
  if (name === 'AbortError') category = 'canceled'
  else if (name === 'TimeoutError') category = 'timeout'
  else if (name === 'QuotaExceededError') category = 'storage_quota'
  else if (status !== undefined && status >= 400 && status <= 599) category = statusCategory(status)
  // `fetch` rejects with a TypeError when the network fails, in every browser.
  else if (
    name === 'TypeError' &&
    /fetch|network|load failed/i.test(String((err as Error).message))
  )
    category = 'network'
  else if (name && STORAGE_ERROR_NAMES.has(name)) category = 'storage'

  return { category, name, status }
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * A short code the reader can quote, matching one error event to one report.
 * Random per error, held only in memory: it identifies an incident, not a person.
 */
export function newErrorRef(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(6)
  return `E-${Array.from(bytes, (byte) => REF_ALPHABET[byte % REF_ALPHABET.length]).join('')}`
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}
