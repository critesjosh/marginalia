/**
 * Privacy-first product telemetry (decision 0008, docs/telemetry.md), sent to
 * Rami's own relay (`shared/telemetryRelay.ts`), which forwards it to PostHog
 * Cloud without the reader's IP address or headers.
 *
 * Off unless the relay says this deployment collects usage data, and then only
 * while the reader's preference is on. Events and properties are allowlisted
 * in `shared/telemetrySchema.ts`, here and again on the relay. There is no SDK,
 * so no autocapture, session recording, cookies or stored identifiers: each
 * page load gets a random id held in memory.
 */

import { APP_VERSION } from './buildInfo'
import { newId } from './id'
import {
  COMMON_SCHEMA,
  EVENT_SCHEMA,
  isEventName,
  MAX_BATCH,
  pickAllowed,
  type CommonProperties,
  type ErrorCategory,
  type EventName,
  type EventProperties,
  type Feature,
  type Operation,
  scrubFeedback,
} from '../../shared/telemetrySchema'
import type { TelemetryConfigResponse } from '../../shared/telemetryRelay'
import { classifyError, newErrorRef, type ClassifiedError } from './telemetryErrors'

const PREFERENCE_KEY = 'marginalia.telemetry'
const EVENTS_URL = '/api/telemetry/events'
const FLUSH_AT = 10
const FLUSH_INTERVAL_MS = 10_000
/** A runaway loop must not turn into a flood of requests. */
const MAX_EVENTS_PER_LOAD = 300

export type Preference = 'on' | 'off'
/** What a reader is asked before choosing: to opt in, or told they may opt out. */
export type Notice = 'ask' | 'inform'
/** What the relay said: still asking, collecting nothing, or the region's rule. */
type ServerState = 'pending' | 'disabled' | 'opt_in' | 'opt_out'

type ImportSource = NonNullable<EventProperties<'book_imported'>['source']>
const IMPORT_OPERATIONS: Record<ImportSource, Operation> = {
  file: 'import_file',
  gutenberg: 'import_gutenberg',
  shared_link: 'import_shared_link',
}

export interface TelemetryConfig {
  appVersion: string
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export interface TelemetryDeps {
  store?: KeyValueStore
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok'>>
  now: () => number
  /** Random id for this page load only. */
  loadId: () => string
  /** Global Privacy Control or Do Not Track. */
  privacySignal: () => boolean
  context: () => Omit<CommonProperties, 'app_version'>
  /**
   * Whether the relay collects usage data and, if so, the reader's region rule:
   * opt-in in the EU, EEA and Switzerland, opt-out elsewhere. A failure counts
   * as collecting nothing for this page load.
   */
  serverConfig: () => Promise<TelemetryConfigResponse>
}

interface RecordedError extends ClassifiedError {
  ref: string
  feature: Feature
  operation: Operation
}

interface QueuedEvent {
  event: string
  timestamp: string
  properties: Record<string, unknown>
}

/** The sanitized fields an error contributes to `error_occurred` and `problem_reported`. */
function errorProperties(error: RecordedError) {
  return {
    error_ref: error.ref,
    feature: error.feature,
    operation: error.operation,
    error_category: error.category,
    error_name: error.name,
    http_status: error.status,
  }
}

export function createTelemetry(config: TelemetryConfig, deps: TelemetryDeps) {
  const distinctId = deps.loadId()
  const listeners = new Set<() => void>()
  let queue: QueuedEvent[] = []
  let sentThisLoad = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError: RecordedError | undefined
  // This tab's choice. The stored value wins while saving works, so an opt-out
  // in another tab applies here too; once a save fails, this choice wins.
  let chosen: Preference | undefined
  let unsaved = false
  let server: ServerState = 'pending'
  let starting: Promise<void> | undefined

  function readStored(): Preference | undefined {
    try {
      const value = deps.store?.getItem(PREFERENCE_KEY)
      return value === 'on' || value === 'off' ? value : undefined
    } catch {
      return undefined
    }
  }

  function explicit(): Preference | undefined {
    return unsaved ? chosen : (readStored() ?? chosen)
  }

  function configured(): boolean {
    return server === 'opt_in' || server === 'opt_out'
  }

  /** The relay has not answered and the reader may be on: hold events, send nothing. */
  function pending(): boolean {
    if (server !== 'pending') return false
    const stored = explicit()
    return stored ? stored === 'on' : !deps.privacySignal()
  }

  function preference(): Preference {
    const stored = explicit()
    if (stored) return stored
    return server === 'opt_out' && !deps.privacySignal() ? 'on' : 'off'
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  /** Asks the relay once, then sends or drops what was held meanwhile. */
  function start(): Promise<void> {
    starting ??= load()
    return starting
  }

  async function load(): Promise<void> {
    const answer = await deps
      .serverConfig()
      .catch((): TelemetryConfigResponse => ({ enabled: false }))
    if (!answer.enabled) server = 'disabled'
    else server = answer.consent === 'opt_out' ? 'opt_out' : 'opt_in'
    if (!enabled()) queue = []
    else if (queue.length) timer ??= setTimeout(() => void flush(), FLUSH_INTERVAL_MS)
    notify()
  }

  /** The one-time notice to show, if the reader has not chosen yet. */
  function notice(): Notice | undefined {
    if (!configured() || explicit() || deps.privacySignal()) return
    return server === 'opt_out' ? 'inform' : 'ask'
  }

  function setPreference(next: Preference) {
    chosen = next
    try {
      deps.store?.setItem(PREFERENCE_KEY, next)
      unsaved = false
    } catch {
      // Blocked or full storage: the choice still holds until the page closes.
      unsaved = true
    }
    if (next === 'off') {
      queue = []
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    notify()
  }

  function build(name: EventName, properties: Record<string, unknown>): QueuedEvent {
    const common = pickAllowed(COMMON_SCHEMA, { ...deps.context(), app_version: config.appVersion })
    return {
      event: name,
      timestamp: new Date(deps.now()).toISOString(),
      properties: {
        ...common,
        ...pickAllowed(EVENT_SCHEMA[name], properties),
        distinct_id: distinctId,
      },
    }
  }

  function postChunk(batch: QueuedEvent[]): Promise<boolean> {
    return deps
      .fetch(EVENTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: true,
      })
      .then((response) => response.ok)
      .catch(() => false)
  }

  /** In chunks the relay accepts; events held before the relay answered can exceed one. */
  async function post(batch: QueuedEvent[]): Promise<boolean> {
    const chunks = []
    for (let i = 0; i < batch.length; i += MAX_BATCH) chunks.push(batch.slice(i, i + MAX_BATCH))
    const results = await Promise.all(chunks.map(postChunk))
    return results.every(Boolean)
  }

  function flush(): Promise<boolean> {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (pending()) return Promise.resolve(false)
    // The reader may have opted out in another tab since these were queued.
    if (!enabled()) queue = []
    if (!queue.length) return Promise.resolve(true)
    const batch = queue
    queue = []
    return post(batch)
  }

  function enabled(): boolean {
    return configured() && preference() === 'on'
  }

  function capture<E extends EventName>(name: E, properties: EventProperties<E> = {}) {
    const holding = pending()
    if ((!holding && !enabled()) || !isEventName(name) || sentThisLoad >= MAX_EVENTS_PER_LOAD)
      return
    sentThisLoad++
    queue.push(build(name, properties as Record<string, unknown>))
    if (holding) return
    if (queue.length >= FLUSH_AT) void flush()
    else timer ??= setTimeout(() => void flush(), FLUSH_INTERVAL_MS)
  }

  /**
   * Records a failure and returns its reference, which is kept even when
   * telemetry is off. `category` overrides classification for errors the
   * caller recognizes.
   */
  function captureError(
    feature: Feature,
    operation: Operation,
    err: unknown,
    category?: ErrorCategory,
  ): string {
    const classified = { ...classifyError(err), ...(category && { category }) }
    const ref = newErrorRef()
    lastError = { ...classified, ref, feature, operation }
    capture('error_occurred', errorProperties(lastError))
    return ref
  }

  /**
   * Sends a report the reader wrote and chose to submit. Its own consent, so
   * it goes even with usage data off; it still needs a relay that collects.
   */
  async function report({
    feedback,
    error,
  }: {
    feedback?: string
    error?: RecordedError
  }): Promise<boolean> {
    await start()
    if (!configured()) return false
    const note = feedback ? scrubFeedback(feedback) : ''
    return post([
      build('problem_reported', {
        has_feedback: Boolean(note),
        feedback: note || undefined,
        ...(error && errorProperties(error)),
      }),
    ])
  }

  /** One import attempt: `err` is absent on success. */
  function recordImport(
    source: ImportSource,
    err?: unknown,
    category?: ErrorCategory,
  ): ErrorCategory | undefined {
    if (err === undefined) {
      capture('book_imported', { source, outcome: 'success' })
      return undefined
    }
    captureError('import', IMPORT_OPERATIONS[source], err, category)
    const failed = lastError?.category
    capture('book_imported', { source, outcome: 'failure', error_category: failed })
    return failed
  }

  return {
    configured,
    enabled,
    preference,
    setPreference,
    capture,
    captureError,
    recordImport,
    report,
    flush,
    lastError: () => lastError,
    refresh() {
      if (!enabled() && !pending()) queue = []
      notify()
    },
    start,
    notice,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export type Telemetry = ReturnType<typeof createTelemetry>

function defaultStore(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function browserFamily(userAgent: string): CommonProperties['browser_family'] {
  if (/Edg\//.test(userAgent)) return 'edge'
  if (/Firefox\/|FxiOS/.test(userAgent)) return 'firefox'
  if (/Chrome\/|CriOS/.test(userAgent)) return 'chrome'
  if (/Safari\//.test(userAgent)) return 'safari'
  return 'other'
}

function browserDeps(): TelemetryDeps {
  return {
    store: defaultStore(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    // `crypto.randomUUID` is missing on plain-HTTP origins such as a LAN dev server.
    loadId: newId,
    privacySignal: () => {
      const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
      return nav.globalPrivacyControl === true || nav.doNotTrack === '1'
    },
    context: () => ({
      form_factor: matchMedia('(pointer: coarse)').matches ? 'touch' : 'pointer',
      browser_family: browserFamily(navigator.userAgent),
    }),
    serverConfig: async () => {
      const response = await fetch('/api/telemetry/config', { credentials: 'omit' })
      const body = (await response.json()) as { enabled?: unknown; consent?: unknown }
      if (!response.ok || body.enabled !== true) return { enabled: false }
      return { enabled: true, consent: body.consent === 'opt_out' ? 'opt_out' : 'opt_in' }
    },
  }
}

export const telemetry: Telemetry = createTelemetry({ appVersion: APP_VERSION }, browserDeps())

/** Reports uncaught errors and sends what is queued before the page goes away. */
export function installTelemetry(target: Window = window) {
  target.addEventListener('error', (event) => {
    telemetry.captureError('app', 'uncaught', event.error ?? event)
  })
  target.addEventListener('unhandledrejection', (event) => {
    telemetry.captureError('app', 'unhandled_rejection', event.reason)
  })
  target.addEventListener('pagehide', () => void telemetry.flush())
  // Another tab changed the preference: let this tab's Settings toggle follow.
  target.addEventListener('storage', (event) => {
    if (event.key === PREFERENCE_KEY) telemetry.refresh()
  })
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.visibilityState === 'hidden') void telemetry.flush()
  })
  telemetry.capture('app_opened', {
    display_mode: target.matchMedia('(display-mode: standalone)').matches
      ? 'standalone'
      : 'browser',
  })
  // Held until the relay answers; nothing is sent before then.
  void telemetry.start()
}
