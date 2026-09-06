export interface ReceivedEvent<T = unknown> {
  schemaVersion?: number
  userId: string
  eventId: string
  eventType: string
  eventTime: string
  emittedAt?: string
  receivedAt: string
  installationId?: string
  sequence?: number
  source?: string
  appVersion?: string
  entities?: Record<string, string>
  privacy?: unknown
  payload: T
}

export interface DeduplicationResult<T> {
  accepted: ReceivedEvent<T>[]
  duplicateEventIds: string[]
  conflicts: { eventId: string; first: ReceivedEvent<T>; conflicting: ReceivedEvent<T> }[]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function deduplicateEvents<T>(events: readonly ReceivedEvent<T>[]): DeduplicationResult<T> {
  const byId = new Map<string, ReceivedEvent<T>>()
  const accepted: ReceivedEvent<T>[] = []
  const duplicateEventIds: string[] = []
  const conflicts: DeduplicationResult<T>['conflicts'] = []

  for (const event of events) {
    const key = `${event.userId}:${event.eventId}`
    const first = byId.get(key)
    if (!first) {
      byId.set(key, event)
      accepted.push(event)
    } else if (
      canonical({
        schemaVersion: first.schemaVersion,
        eventType: first.eventType,
        eventTime: first.eventTime,
        emittedAt: first.emittedAt,
        installationId: first.installationId,
        sequence: first.sequence,
        source: first.source,
        appVersion: first.appVersion,
        entities: first.entities,
        privacy: first.privacy,
        payload: first.payload,
      }) ===
      canonical({
        schemaVersion: event.schemaVersion,
        eventType: event.eventType,
        eventTime: event.eventTime,
        emittedAt: event.emittedAt,
        installationId: event.installationId,
        sequence: event.sequence,
        source: event.source,
        appVersion: event.appVersion,
        entities: event.entities,
        privacy: event.privacy,
        payload: event.payload,
      })
    ) {
      duplicateEventIds.push(event.eventId)
    } else {
      conflicts.push({ eventId: event.eventId, first, conflicting: event })
    }
  }

  return { accepted, duplicateEventIds, conflicts }
}

export interface ReadingEvent {
  eventId: string
  userId: string
  installationId: string
  bookId: string
  eventType: 'book_opened' | 'book_closed' | 'reading_progressed' | 'chapter_entered'
  eventTime: string
  receivedAt?: string
  sequence?: number
}

export interface ReadingSession {
  id: string
  userId: string
  installationId: string
  bookId: string
  startedAt: string
  endedAt: string
  activeSeconds: number
  eventIds: string[]
}

const IDLE_MS = 30 * 60 * 1_000
const ACTIVE_CAP_SECONDS = 120
const FUTURE_CLOCK_MS = 24 * 60 * 60 * 1_000

function effectiveTime(event: ReadingEvent): number {
  const eventTime = Date.parse(event.eventTime)
  const receivedAt = event.receivedAt ? Date.parse(event.receivedAt) : Number.NaN
  return Number.isFinite(receivedAt) && eventTime > receivedAt + FUTURE_CLOCK_MS
    ? receivedAt
    : eventTime
}

function stableId(parts: readonly string[]): string {
  let hash = 2166136261
  for (const code of parts.join('\u0000')) {
    hash ^= code.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `session-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function millis(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/**
 * The same order the Silver pipeline windows by, down to the tie-breaks: a
 * missing sequence or receipt sorts first, matching Spark's nulls-first
 * ascending default, so both sides pick the same event to open a session with.
 */
function compareInStream(a: ReadingEvent, b: ReadingEvent): number {
  // Subtraction would turn two absent values into NaN, so compare directly.
  const order = (left: number, right: number) => (left === right ? 0 : left < right ? -1 : 1)
  const missing = Number.NEGATIVE_INFINITY
  return (
    order(effectiveTime(a), effectiveTime(b)) ||
    order(a.sequence ?? missing, b.sequence ?? missing) ||
    order(millis(a.receivedAt), millis(b.receivedAt)) ||
    a.eventId.localeCompare(b.eventId)
  )
}

function sessionizeOneStream(events: readonly ReadingEvent[]): ReadingSession[] {
  const sorted = [...events].sort(compareInStream)
  const sessions: ReadingSession[] = []
  let current: ReadingSession | undefined
  let lastTime = 0

  function begin(event: ReadingEvent, time: number) {
    current = {
      id: stableId([event.userId, event.installationId, event.bookId, event.eventId]),
      userId: event.userId,
      installationId: event.installationId,
      bookId: event.bookId,
      startedAt: new Date(time).toISOString(),
      endedAt: new Date(time).toISOString(),
      activeSeconds: 0,
      eventIds: [],
    }
  }

  for (const event of sorted) {
    const time = effectiveTime(event)
    const sameStream =
      current?.userId === event.userId &&
      current.installationId === event.installationId &&
      current.bookId === event.bookId
    // An open always starts a session, as it does in the Silver pipeline: one
    // that arrives without its close still must not extend the previous one.
    if (
      !current ||
      !sameStream ||
      event.eventType === 'book_opened' ||
      time - lastTime >= IDLE_MS
    ) {
      if (current) sessions.push(current)
      begin(event, time)
    } else {
      current.activeSeconds += Math.min(ACTIVE_CAP_SECONDS, Math.max(0, (time - lastTime) / 1000))
    }

    current!.eventIds.push(event.eventId)
    current!.endedAt = new Date(time).toISOString()
    lastTime = time

    if (event.eventType === 'book_closed') {
      sessions.push(current!)
      current = undefined
      lastTime = 0
    }
  }

  if (current) sessions.push(current)
  return sessions
}

export function sessionizeReadingEvents(events: readonly ReadingEvent[]): ReadingSession[] {
  const streams = new Map<string, ReadingEvent[]>()
  for (const event of events) {
    const key = `${event.userId}\u0000${event.installationId}\u0000${event.bookId}`
    const stream = streams.get(key) ?? []
    stream.push(event)
    streams.set(key, stream)
  }
  return [...streams.values()]
    .flatMap(sessionizeOneStream)
    .sort(
      (a, b) =>
        Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
    )
}
