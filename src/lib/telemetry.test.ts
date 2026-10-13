import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTelemetry, type TelemetryDeps } from './telemetry'
import { classifyError, newErrorRef } from './telemetryErrors'
import {
  ERROR_REF_PATTERN,
  MAX_BATCH,
  durationBucket,
  lengthBucket,
  scrubFeedback,
} from '../../shared/telemetrySchema'
import type { TelemetryConfigResponse } from '../../shared/telemetryRelay'

/** The relay's answers: on by default with notice, ask first, or collecting nothing. */
const INFORM: TelemetryConfigResponse = { enabled: true, consent: 'opt_out' }
const ASK: TelemetryConfigResponse = { enabled: true, consent: 'opt_in' }
const OFF: TelemetryConfigResponse = { enabled: false }

function memoryStore() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

interface Sent {
  url: string
  init: RequestInit
  body: { batch: { event: string; properties: Record<string, unknown> }[] }
}

async function setup(server = INFORM, deps: Partial<TelemetryDeps> = {}, start = true) {
  const sent: Sent[] = []
  const store = memoryStore()
  const session = memoryStore()
  const telemetry = createTelemetry(
    { appVersion: 'a1b2c3d' },
    {
      store,
      session,
      fetch: (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body as string) })
        return Promise.resolve({ ok: true })
      },
      now: () => Date.parse('2026-10-12T12:00:00.000Z'),
      newId: () => 'session-1',
      privacySignal: () => false,
      context: () => ({ form_factor: 'touch', browser_family: 'safari' }),
      serverConfig: () => Promise.resolve(server),
      ...deps,
    },
  )
  if (start) await telemetry.start()
  const events = () => sent.flatMap((request) => request.body.batch)
  return { telemetry, sent, events, store, session }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('configuration', () => {
  it('loads on origins without crypto.randomUUID, such as plain-HTTP LAN hosts', async () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    try {
      vi.resetModules()
      const module = await import('./telemetry')
      expect(module.telemetry.configured()).toBe(false)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    }
  })

  it('sends nothing when the relay collects nothing, or cannot be reached', async () => {
    const unreachable = () => Promise.reject(new TypeError('Failed to fetch'))
    for (const options of [{}, { serverConfig: unreachable }]) {
      const { telemetry, sent, store } = await setup(OFF, options)
      store.setItem('marginalia.telemetry', 'on')
      telemetry.capture('annotation_deleted')
      await telemetry.flush()
      expect(telemetry.configured()).toBe(false)
      expect(telemetry.notice()).toBeUndefined()
      expect(sent).toEqual([])
    }
  })
})

describe('consent', () => {
  it('stays off by default in opt-in mode until the reader turns it on', async () => {
    const { telemetry, events } = await setup(ASK)
    telemetry.capture('annotation_deleted')
    expect(telemetry.enabled()).toBe(false)
    telemetry.setPreference('on')
    telemetry.capture('annotation_created', { trigger: 'ask' })
    await telemetry.flush()
    expect(events().map((event) => event.event)).toEqual(['annotation_created'])
  })

  it('treats a browser privacy signal as off unless the reader chose otherwise', async () => {
    const { telemetry } = await setup(INFORM, { privacySignal: () => true })
    expect(telemetry.preference()).toBe('off')
    telemetry.setPreference('on')
    expect(telemetry.enabled()).toBe(true)
  })

  it('opting out drops queued events and stops capture', async () => {
    const { telemetry, sent, store } = await setup()
    telemetry.capture('annotation_deleted')
    telemetry.setPreference('off')
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(sent).toEqual([])
    expect(store.getItem('marginalia.telemetry')).toBe('off')
  })

  it('remembers an opt-out stored by an earlier visit', async () => {
    const store = memoryStore()
    store.setItem('marginalia.telemetry', 'off')
    expect((await setup(INFORM, { store })).telemetry.enabled()).toBe(false)
  })

  it('holds an opt-out for the page when storage refuses writes', async () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const { telemetry } = await setup(INFORM, { store })
    telemetry.setPreference('off')
    expect(telemetry.enabled()).toBe(false)
  })

  it('drops queued events at flush when another tab opted out', async () => {
    const { telemetry, sent, store } = await setup()
    telemetry.capture('annotation_deleted')
    store.setItem('marginalia.telemetry', 'off')
    await telemetry.flush()
    expect(sent).toEqual([])
  })

  it('lets an opt-out stored by another tab override this tab’s earlier choice', async () => {
    const { telemetry, store } = await setup(ASK)
    telemetry.setPreference('on')
    store.setItem('marginalia.telemetry', 'off')
    expect(telemetry.enabled()).toBe(false)
  })

  it('honors an opt-out that storage refused to save over an earlier opt-in', async () => {
    const values = new Map([['marginalia.telemetry', 'on']])
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    const { telemetry, sent } = await setup(INFORM, { store })
    telemetry.setPreference('off')
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(telemetry.preference()).toBe('off')
    expect(sent).toEqual([])
  })

  it('notifies subscribers of a change', async () => {
    const { telemetry } = await setup()
    const listener = vi.fn()
    const unsubscribe = telemetry.subscribe(listener)
    telemetry.setPreference('off')
    unsubscribe()
    telemetry.setPreference('on')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('regional default', () => {
  function deferred() {
    let resolve!: (answer: TelemetryConfigResponse) => void
    const promise = new Promise<TelemetryConfigResponse>((done) => (resolve = done))
    return { promise, resolve }
  }

  function holding(serverConfig: () => Promise<TelemetryConfigResponse>, store = memoryStore()) {
    const sent: unknown[] = []
    const telemetry = createTelemetry(
      { appVersion: 'a1b2c3d' },
      {
        store,
        fetch: (_url, init) => {
          sent.push(JSON.parse(init.body as string))
          return Promise.resolve({ ok: true })
        },
        now: () => 0,
        newId: () => 'session-1',
        privacySignal: () => false,
        context: () => ({ form_factor: 'touch', browser_family: 'safari' }),
        serverConfig,
      },
    )
    return { telemetry, sent }
  }

  it('holds events until the relay answers, sending none meanwhile', async () => {
    const region = deferred()
    const { telemetry, sent } = holding(() => region.promise)
    telemetry.capture('app_opened', { display_mode: 'browser' })
    await telemetry.flush()
    expect(sent).toEqual([])
    expect(telemetry.notice()).toBeUndefined()

    const started = telemetry.start()
    region.resolve(INFORM)
    await started
    await telemetry.flush()
    expect(sent).toHaveLength(1)
    expect(telemetry.notice()).toBe('inform')
  })

  it('drops held events where the region needs opt-in, and asks', async () => {
    const { telemetry, sent } = holding(() => Promise.resolve(ASK))
    telemetry.capture('app_opened', { display_mode: 'browser' })
    await telemetry.start()
    await telemetry.flush()
    expect(sent).toEqual([])
    expect(telemetry.enabled()).toBe(false)
    expect(telemetry.notice()).toBe('ask')
    telemetry.setPreference('on')
    expect(telemetry.notice()).toBeUndefined()
  })

  it('holds a stored opt-in until the relay answers, then drops it if the relay is off', async () => {
    const store = memoryStore()
    store.setItem('marginalia.telemetry', 'on')
    const answer = deferred()
    const { telemetry, sent } = holding(() => answer.promise, store)
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(sent).toEqual([])
    const started = telemetry.start()
    answer.resolve(OFF)
    await started
    await telemetry.flush()
    expect(sent).toEqual([])
  })

  it('asks the relay once, however often it starts', async () => {
    const serverConfig = vi.fn(() => Promise.resolve(INFORM))
    const { telemetry } = holding(serverConfig)
    await Promise.all([telemetry.start(), telemetry.start()])
    await telemetry.report({})
    expect(serverConfig).toHaveBeenCalledTimes(1)
  })

  it('never asks or sends with a browser privacy signal', async () => {
    const { telemetry } = await setup(INFORM, { privacySignal: () => true })
    expect(telemetry.notice()).toBeUndefined()
    expect(telemetry.enabled()).toBe(false)
  })
})

describe('emission', () => {
  it('posts a batch to the relay, with no key, cookies or referrer', async () => {
    const { telemetry, sent } = await setup()
    telemetry.capture('book_imported', { source: 'file', outcome: 'success' })
    await telemetry.flush()

    expect(sent).toHaveLength(1)
    const [{ url, init, body }] = sent
    expect(url).toBe('/api/telemetry/events')
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(body).toEqual({ batch: [expect.any(Object)] })
    expect(body.batch[0]).toEqual({
      event: 'book_imported',
      timestamp: '2026-10-12T12:00:00.000Z',
      properties: {
        source: 'file',
        outcome: 'success',
        app_version: 'a1b2c3d',
        form_factor: 'touch',
        browser_family: 'safari',
        distinct_id: 'session-1',
      },
    })
  })

  it('flushes on its own once ten events are queued, or after a pause', async () => {
    vi.useFakeTimers()
    const { telemetry, sent } = await setup()
    for (let i = 0; i < 10; i++) telemetry.capture('annotation_deleted')
    expect(sent).toHaveLength(1)
    telemetry.capture('annotation_deleted')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toHaveLength(2)
  })

  it('splits a long held queue into batches the relay accepts', async () => {
    const { telemetry, sent } = await setup(INFORM, {}, false)
    for (let i = 0; i < MAX_BATCH + 5; i++) telemetry.capture('annotation_deleted')
    await telemetry.start()
    await telemetry.flush()
    expect(sent.map((request) => request.body.batch.length)).toEqual([MAX_BATCH, 5])
  })

  it('keeps one id for the tab session, stored only once something is sent', async () => {
    const SESSION = 'marginalia.telemetry.session'
    const declined = await setup(ASK)
    declined.telemetry.capture('annotation_deleted')
    await declined.telemetry.flush()
    await declined.telemetry.report({ feedback: 'Stuck on chapter 2' })
    expect(declined.events()[0].properties.distinct_id).toBe('session-1')
    expect(declined.session.getItem(SESSION)).toBeNull()

    // A reload in the same tab reuses the stored id; a malformed one is replaced.
    const ids = vi.fn(() => 'session-2')
    const { telemetry, events, session } = await setup(INFORM, { newId: ids })
    session.setItem(SESSION, 'reloaded-tab-id')
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events()[0].properties.distinct_id).toBe('reloaded-tab-id')
    expect(ids).not.toHaveBeenCalled()

    telemetry.setPreference('off')
    expect(session.getItem(SESSION)).toBeNull()
    telemetry.setPreference('on')
    session.setItem(SESSION, 'Not An Id!')
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events()[1].properties.distinct_id).toBe('session-2')
    expect(session.getItem(SESSION)).toBe('session-2')
  })

  it('starts a new session after an opt-out in another tab', async () => {
    const SESSION = 'marginalia.telemetry.session'
    const ids = ['session-1', 'session-2']
    const { telemetry, events, store, session } = await setup(INFORM, {
      newId: () => ids.shift() ?? 'spare-id',
    })
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    store.setItem('marginalia.telemetry', 'off')
    telemetry.refresh()
    expect(session.getItem(SESSION)).toBeNull()
    store.setItem('marginalia.telemetry', 'on')
    telemetry.refresh()
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events().map((event) => event.properties.distinct_id)).toEqual([
      'session-1',
      'session-2',
    ])
  })

  it('falls back to an id for the page load when session storage is blocked', async () => {
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const session = { getItem: blocked, setItem: blocked, removeItem: blocked }
    const { telemetry, events } = await setup(INFORM, { session })
    telemetry.capture('annotation_deleted')
    telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events().map((event) => event.properties.distinct_id)).toEqual([
      'session-1',
      'session-1',
    ])
  })

  it('caps events per page load', async () => {
    const { telemetry, events } = await setup()
    for (let i = 0; i < 400; i++) telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events()).toHaveLength(300)
  })

  it('never throws when the network fails', async () => {
    const { telemetry } = await setup(INFORM, {
      fetch: () => Promise.reject(new TypeError('offline')),
    })
    telemetry.capture('annotation_deleted')
    await expect(telemetry.flush()).resolves.toBe(false)
  })
})

describe('filtering', () => {
  it('drops properties outside the allowlist and values that fail their check', async () => {
    const { telemetry, events } = await setup()
    telemetry.capture('text_selected', {
      length_bucket: 'under_20',
      // A careless call site passing content: none of this may leave the device.
      ...({
        text: 'Call me Ishmael.',
        title: 'Moby Dick',
        $current_url: 'https://x/book/1',
      } as object),
    })
    telemetry.capture('book_imported', {
      source: 'somewhere' as 'file',
      outcome: 'success',
    })
    telemetry.capture('error_occurred', {
      feature: 'chat',
      operation: 'send_message',
      error_name: 'Error: The passage “Call me Ishmael”' as string,
      http_status: 1234,
      error_ref: 'not-a-ref',
    })
    telemetry.capture('hint_closed', {
      hint: 'library',
      how: 'Try it with Moby Dick' as 'link',
    })
    await telemetry.flush()

    const [selected, imported, failed, hint] = events().map((event) => event.properties)
    expect(selected).not.toHaveProperty('text')
    expect(selected).not.toHaveProperty('title')
    expect(selected).not.toHaveProperty('$current_url')
    expect(selected.length_bucket).toBe('under_20')
    expect(imported).not.toHaveProperty('source')
    expect(failed).toMatchObject({ feature: 'chat', operation: 'send_message' })
    expect(failed).not.toHaveProperty('error_name')
    expect(failed).not.toHaveProperty('http_status')
    expect(failed).not.toHaveProperty('error_ref')
    expect(hint).toMatchObject({ hint: 'library' })
    expect(hint).not.toHaveProperty('how')
  })

  it('ignores event names outside the schema', async () => {
    const { telemetry, sent } = await setup()
    telemetry.capture('$pageview' as 'annotation_deleted')
    await telemetry.flush()
    expect(sent).toEqual([])
  })

  it('buckets lengths and durations instead of sending them', async () => {
    expect([5, 20, 999, 5000].map(lengthBucket)).toEqual([
      'under_20',
      '20_199',
      '200_999',
      '1000_plus',
    ])
    expect([100, 5000, 20_000, 60_000].map(durationBucket)).toEqual([
      'under_2s',
      '2_10s',
      '10_30s',
      '30s_plus',
    ])
  })
})

describe('errors', () => {
  it('records a sanitized error with a reference, even when telemetry is off', async () => {
    const { telemetry, sent } = await setup(ASK)
    const err = Object.assign(new Error('Could not read “Moby Dick” at /books/abc?token=x'), {
      name: 'InferenceError',
      status: 429,
    })
    const ref = telemetry.captureError('chat', 'send_message', err)
    await telemetry.flush()

    expect(ref).toMatch(ERROR_REF_PATTERN)
    expect(sent).toEqual([])
    expect(telemetry.lastError()).toEqual({
      ref,
      feature: 'chat',
      operation: 'send_message',
      category: 'rate_limited',
      name: 'InferenceError',
      status: 429,
    })
  })

  it('sends the class, category and status, never the message or stack', async () => {
    const { telemetry, sent } = await setup()
    telemetry.captureError('import', 'import_file', new Error('Moby Dick: chapter 1 is broken'))
    await telemetry.flush()
    const payload = JSON.stringify(sent[0].body)
    expect(payload).not.toContain('Moby')
    expect(payload).not.toContain('stack')
    expect(sent[0].body.batch[0].properties).toMatchObject({
      feature: 'import',
      operation: 'import_file',
      error_category: 'unknown',
      error_name: 'Error',
    })
  })

  it('lets the caller name a category it recognizes', async () => {
    const { telemetry } = await setup()
    telemetry.captureError('import', 'import_file', new Error('bad zip'), 'invalid_epub')
    expect(telemetry.lastError()?.category).toBe('invalid_epub')
  })

  it('records an import outcome and its failure category', async () => {
    const { telemetry, events } = await setup()
    telemetry.recordImport('gutenberg')
    telemetry.recordImport('shared_link', new TypeError('Failed to fetch'))
    await telemetry.flush()
    expect(
      events().map(({ event, properties }) => [
        event,
        properties.outcome ?? properties.error_category,
      ]),
    ).toEqual([
      ['book_imported', 'success'],
      ['error_occurred', 'network'],
      ['book_imported', 'failure'],
    ])
    expect(events()[2].properties.error_category).toBe('network')
  })

  it('classifies common failures', async () => {
    const named = (name: string, message = '') => Object.assign(new Error(message), { name })
    expect(classifyError(named('AbortError')).category).toBe('canceled')
    expect(classifyError(named('TimeoutError')).category).toBe('timeout')
    expect(classifyError(named('QuotaExceededError')).category).toBe('storage_quota')
    expect(classifyError(named('DatabaseClosedError')).category).toBe('storage')
    expect(classifyError(new TypeError('Failed to fetch')).category).toBe('network')
    expect(classifyError(new TypeError('x is undefined')).category).toBe('unknown')
    expect(classifyError({ status: 503 }).category).toBe('unavailable')
    expect(classifyError({ status: 502 }).category).toBe('server')
    expect(classifyError({ status: 404 }).category).toBe('not_found')
    expect(classifyError({ status: 400 }).category).toBe('client')
    expect(classifyError('a string').category).toBe('unknown')
    expect(classifyError(null)).toEqual({ category: 'unknown', name: undefined, status: undefined })
    expect(classifyError(named('e.minified')).name).toBeUndefined()
  })

  it('makes references from an unambiguous alphabet', async () => {
    expect(newErrorRef(() => new Uint8Array([0, 1, 2, 30, 31, 255]))).toBe('E-ABC899')
    expect(newErrorRef()).toMatch(ERROR_REF_PATTERN)
  })
})

describe('report a problem', () => {
  it('sends a scrubbed note with the last error’s details, even with usage data off', async () => {
    const { telemetry, sent } = await setup(ASK)
    const err = Object.assign(new Error('Could not open “Moby Dick”'), {
      name: 'InferenceError',
      status: 503,
    })
    const ref = telemetry.captureError('chat', 'send_message', err)
    expect(sent).toEqual([])

    const ok = await telemetry.report({
      feedback:
        'Broke at https://rami.test/book/1?x=y, mail me at sam@example.com or +1 555 123 4567',
      error: telemetry.lastError(),
    })
    expect(ok).toBe(true)
    expect(sent[0].body.batch[0]).toMatchObject({
      event: 'problem_reported',
      properties: {
        has_feedback: true,
        feedback: 'Broke at [link] mail me at [email] or [number]',
        error_ref: ref,
        feature: 'chat',
        operation: 'send_message',
        error_category: 'unavailable',
        error_name: 'InferenceError',
        http_status: 503,
      },
    })
    expect(JSON.stringify(sent)).not.toContain('Moby')
  })

  it('sends no feedback property for an empty note', async () => {
    const { telemetry, sent } = await setup()
    await telemetry.report({ feedback: '   ' })
    expect(sent[0].body.batch[0].properties).toMatchObject({ has_feedback: false })
    expect(sent[0].body.batch[0].properties).not.toHaveProperty('feedback')
  })

  it('reports failure when the relay collects nothing', async () => {
    const { telemetry, sent } = await setup(OFF)
    await expect(telemetry.report({ feedback: 'hi' })).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  it('caps the note length', async () => {
    expect(scrubFeedback('a'.repeat(5000))).toHaveLength(1000)
    expect(scrubFeedback('see www.example.com/x  and\n\nmore')).toBe('see [link] and more')
  })
})
