/**
 * Privacy-first product telemetry, sent to PostHog Cloud's capture API
 * (decision 0008, docs/telemetry.md).
 *
 * Off unless the build names a PostHog project key and host, and then only
 * while the reader's preference is on. Events and properties are allowlisted
 * in `telemetrySchema.ts`. There is no SDK, so no autocapture, session
 * recording, cookies or stored identifiers: each page load gets a random id
 * held in memory, and PostHog is told not to build a person profile or look up
 * the request's location.
 */

import { APP_VERSION } from './buildInfo'
import { newId } from './id'
import {
  COMMON_SCHEMA,
  EVENT_SCHEMA,
  isEventName,
  pickAllowed,
  type CommonProperties,
  type ErrorCategory,
  type EventName,
  type EventProperties,
  type Feature,
  type Operation,
} from './telemetrySchema'
import { classifyError, newErrorRef, scrubFeedback, type ClassifiedError } from './telemetryErrors'

const PREFERENCE_KEY = 'marginalia.telemetry'
const FLUSH_AT = 10
const FLUSH_INTERVAL_MS = 10_000
/** A runaway loop must not turn into a flood of requests. */
const MAX_EVENTS_PER_LOAD = 300

export type Preference = 'on' | 'off'
/** What a reader is asked before choosing: to opt in, or told they may opt out. */
export type Notice = 'ask' | 'inform'
/** Server answer for this reader's region (shared/telemetryRegion.ts). */
type RegionConsent = 'opt_in' | 'opt_out'

type ImportSource = NonNullable<EventProperties<'book_imported'>['source']>
const IMPORT_OPERATIONS: Record<ImportSource, Operation> = {
  file: 'import_file',
  gutenberg: 'import_gutenberg',
  shared_link: 'import_shared_link',
}

export interface TelemetryConfig {
  /** PostHog project API key (`phc_…`), which is public by design. */
  apiKey?: string
  /** PostHog ingestion host, e.g. `https://eu.i.posthog.com`. */
  host?: string
  /**
   * Preference before the reader chooses. `regional` asks the server: opt-in in
   * the EU, EEA and Switzerland, opt-out elsewhere. `off` is opt-in everywhere.
   * A browser privacy signal always makes it `off`.
   */
  defaultMode: 'regional' | 'off'
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
  /** The region's consent rule; a failure counts as opt-in. */
  region: () => Promise<RegionConsent>
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

/** Accepts only a project key: a personal key (`phx_…`) must never reach the browser. */
export function isProjectKey(key: string | undefined): key is string {
  return typeof key === 'string' && /^phc_[A-Za-z0-9]{20,64}$/.test(key)
}

function isHost(host: string | undefined): host is string {
  if (!host) return false
  try {
    const url = new URL(host)
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.username
  } catch {
    return false
  }
}

export function createTelemetry(config: TelemetryConfig, deps: TelemetryDeps) {
  const configured = isProjectKey(config.apiKey) && isHost(config.host)
  const endpoint = configured ? new URL('/batch/', config.host).href : ''
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
  // The default before the reader chooses; `pending` until the region is known.
  let regionDefault: Preference | 'pending' =
    config.defaultMode === 'regional' && configured ? 'pending' : 'off'

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

  /** No choice yet and the region still unknown: hold events, send nothing. */
  function pending(): boolean {
    return !explicit() && !deps.privacySignal() && regionDefault === 'pending'
  }

  function preference(): Preference {
    const stored = explicit()
    if (stored) return stored
    if (deps.privacySignal() || regionDefault === 'pending') return 'off'
    return regionDefault
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  /** Learns the region's default, then sends or drops what was held meanwhile. */
  async function start(): Promise<void> {
    if (regionDefault !== 'pending') return
    const consent = await deps.region().catch((): RegionConsent => 'opt_in')
    regionDefault = consent === 'opt_out' ? 'on' : 'off'
    if (!enabled()) queue = []
    else if (queue.length) timer ??= setTimeout(() => void flush(), FLUSH_INTERVAL_MS)
    notify()
  }

  /** The one-time notice to show, if the reader has not chosen yet. */
  function notice(): Notice | undefined {
    if (!configured || explicit() || deps.privacySignal() || regionDefault === 'pending') return
    return regionDefault === 'on' ? 'inform' : 'ask'
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
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: 'rami-web',
      },
    }
  }

  function post(batch: QueuedEvent[]): Promise<boolean> {
    return deps
      .fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: config.apiKey, batch }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        keepalive: true,
      })
      .then((response) => response.ok)
      .catch(() => false)
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
    return configured && preference() === 'on'
  }

  function capture<E extends EventName>(name: E, properties: EventProperties<E> = {}) {
    const holding = configured && pending()
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
    capture('error_occurred', {
      feature,
      operation,
      error_category: classified.category,
      error_name: classified.name,
      http_status: classified.status,
      error_ref: ref,
    })
    return ref
  }

  /**
   * Sends a report the reader wrote and chose to submit. Its own consent, so
   * it goes even with usage data off; it still needs a configured build.
   */
  function report({
    feedback,
    errorRef,
    feature,
  }: {
    feedback?: string
    errorRef?: string
    feature?: Feature
  }): Promise<boolean> {
    if (!configured) return Promise.resolve(false)
    const note = feedback ? scrubFeedback(feedback) : ''
    return post([
      build('problem_reported', {
        has_feedback: Boolean(note),
        feedback: note || undefined,
        error_ref: errorRef,
        feature,
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
    region: async () => {
      const response = await fetch('/api/telemetry/region', { credentials: 'omit' })
      const body = (await response.json()) as { consent?: unknown }
      return body.consent === 'opt_out' ? 'opt_out' : 'opt_in'
    },
  }
}

export const telemetry: Telemetry = createTelemetry(
  {
    apiKey: import.meta.env.VITE_POSTHOG_KEY as string | undefined,
    host: import.meta.env.VITE_POSTHOG_HOST as string | undefined,
    defaultMode: import.meta.env.VITE_TELEMETRY_DEFAULT === 'off' ? 'off' : 'regional',
    appVersion: APP_VERSION,
  },
  browserDeps(),
)

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
  // Held until the region is known; nothing is sent before then.
  void telemetry.start()
}
