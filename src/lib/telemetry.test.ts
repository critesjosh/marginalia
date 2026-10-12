import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTelemetry,
  isProjectKey,
  type TelemetryConfig,
  type TelemetryDeps,
} from './telemetry'
import { classifyError, newErrorRef, scrubFeedback } from './telemetryErrors'
import { ERROR_REF_PATTERN, durationBucket, lengthBucket } from './telemetrySchema'

// Synthetic, low-entropy keys: shaped like PostHog's, never real.
const KEY = `phc_${'a'.repeat(32)}`
const PERSONAL_KEY = `phx_${'a'.repeat(32)}`
const HOST = 'https://eu.i.posthog.com'

function memoryStore() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

interface Sent {
  url: string
  init: RequestInit
  body: { api_key: string; batch: { event: string; properties: Record<string, unknown> }[] }
}

async function setup(config: Partial<TelemetryConfig> = {}, deps: Partial<TelemetryDeps> = {}) {
  const sent: Sent[] = []
  const store = memoryStore()
  const telemetry = createTelemetry(
    { apiKey: KEY, host: HOST, defaultMode: 'regional', appVersion: 'a1b2c3d', ...config },
    {
      store,
      fetch: (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body as string) })
        return Promise.resolve({ ok: true })
      },
      now: () => Date.parse('2026-10-12T12:00:00.000Z'),
      loadId: () => 'load-1',
      privacySignal: () => false,
      context: () => ({ form_factor: 'touch', browser_family: 'safari' }),
      region: () => Promise.resolve('opt_out'),
      ...deps,
    },
  )
  await telemetry.start()
  const events = () => sent.flatMap((request) => request.body.batch)
  return { telemetry, sent, events, store }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('configuration', () => {
  it('loads on origins without crypto.randomUUID, such as plain-HTTP LAN hosts', async () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    // Independent of a developer's .env.local, which Vitest also loads.
    vi.stubEnv('VITE_POSTHOG_KEY', '')
    try {
      vi.resetModules()
      const module = await import('./telemetry')
      expect(module.telemetry.configured).toBe(false)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
      vi.unstubAllEnvs()
    }
  })

  it('sends nothing without a project key and host', async () => {
    for (const config of [{ apiKey: undefined }, { host: undefined }, { host: 'http://x.test' }]) {
      const { telemetry, sent } = await setup(config)
      telemetry.capture('annotation_deleted')
      await telemetry.flush()
      expect(telemetry.configured).toBe(false)
      expect(sent).toEqual([])
    }
  })

  it('accepts only public project keys, never personal ones', async () => {
    expect(isProjectKey(KEY)).toBe(true)
    expect(isProjectKey(PERSONAL_KEY)).toBe(false)
    expect(isProjectKey('')).toBe(false)
    expect((await setup({ apiKey: PERSONAL_KEY })).telemetry.configured).toBe(false)
  })
})

describe('consent', () => {
  it('stays off by default in opt-in mode until the reader turns it on', async () => {
    const { telemetry, events } = await setup({ defaultMode: 'off' })
    telemetry.capture('annotation_deleted')
    expect(telemetry.enabled()).toBe(false)
    telemetry.setPreference('on')
    telemetry.capture('annotation_created', { trigger: 'ask' })
    await telemetry.flush()
    expect(events().map((event) => event.event)).toEqual(['annotation_created'])
  })

  it('treats a browser privacy signal as off unless the reader chose otherwise', async () => {
    const { telemetry } = await setup({}, { privacySignal: () => true })
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
    expect((await setup({}, { store })).telemetry.enabled()).toBe(false)
  })

  it('holds an opt-out for the page when storage refuses writes', async () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const { telemetry } = await setup({}, { store })
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
    const { telemetry, store } = await setup({ defaultMode: 'off' })
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
    const { telemetry, sent } = await setup({}, { store })
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
    let resolve!: (consent: 'opt_in' | 'opt_out') => void
    const promise = new Promise<'opt_in' | 'opt_out'>((done) => (resolve = done))
    return { promise, resolve }
  }

  function holding(region: () => Promise<'opt_in' | 'opt_out'>) {
    const sent: unknown[] = []
    const telemetry = createTelemetry(
      { apiKey: KEY, host: HOST, defaultMode: 'regional', appVersion: 'a1b2c3d' },
      {
        store: memoryStore(),
        fetch: (_url, init) => {
          sent.push(JSON.parse(init.body as string))
          return Promise.resolve({ ok: true })
        },
        now: () => 0,
        loadId: () => 'load-1',
        privacySignal: () => false,
        context: () => ({ form_factor: 'touch', browser_family: 'safari' }),
        region,
      },
    )
    return { telemetry, sent }
  }

  it('holds events until the region is known, sending none meanwhile', async () => {
    const region = deferred()
    const { telemetry, sent } = holding(() => region.promise)
    telemetry.capture('app_opened', { display_mode: 'browser' })
    await telemetry.flush()
    expect(sent).toEqual([])
    expect(telemetry.notice()).toBeUndefined()

    const started = telemetry.start()
    region.resolve('opt_out')
    await started
    await telemetry.flush()
    expect(sent).toHaveLength(1)
    expect(telemetry.notice()).toBe('inform')
  })

  it('drops held events where the region needs opt-in, and asks', async () => {
    const { telemetry, sent } = holding(() => Promise.resolve('opt_in'))
    telemetry.capture('app_opened', { display_mode: 'browser' })
    await telemetry.start()
    await telemetry.flush()
    expect(sent).toEqual([])
    expect(telemetry.enabled()).toBe(false)
    expect(telemetry.notice()).toBe('ask')
    telemetry.setPreference('on')
    expect(telemetry.notice()).toBeUndefined()
  })

  it('treats a failed region lookup as opt-in', async () => {
    const { telemetry } = holding(() => Promise.reject(new TypeError('Failed to fetch')))
    await telemetry.start()
    expect(telemetry.enabled()).toBe(false)
    expect(telemetry.notice()).toBe('ask')
  })

  it('never asks or sends with a browser privacy signal', async () => {
    const { telemetry } = await setup({}, { privacySignal: () => true })
    expect(telemetry.notice()).toBeUndefined()
    expect(telemetry.enabled()).toBe(false)
  })

  it('asks everywhere in opt-in mode, without a region lookup', async () => {
    const region = vi.fn(() => Promise.resolve('opt_out' as const))
    const { telemetry } = await setup({ defaultMode: 'off' }, { region })
    expect(region).not.toHaveBeenCalled()
    expect(telemetry.notice()).toBe('ask')
  })

  it('shows no notice when the build sends nothing', async () => {
    const { telemetry } = await setup({ apiKey: undefined })
    expect(telemetry.notice()).toBeUndefined()
  })
})

describe('emission', () => {
  it('posts a batch with no person profile, location lookup, cookies or referrer', async () => {
    const { telemetry, sent } = await setup()
    telemetry.capture('book_imported', { source: 'file', outcome: 'success' })
    await telemetry.flush()

    expect(sent).toHaveLength(1)
    const [{ url, init, body }] = sent
    expect(url).toBe('https://eu.i.posthog.com/batch/')
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(body.api_key).toBe(KEY)
    expect(body.batch[0]).toEqual({
      event: 'book_imported',
      timestamp: '2026-10-12T12:00:00.000Z',
      properties: {
        source: 'file',
        outcome: 'success',
        app_version: 'a1b2c3d',
        form_factor: 'touch',
        browser_family: 'safari',
        distinct_id: 'load-1',
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: 'rami-web',
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

  it('caps events per page load', async () => {
    const { telemetry, events } = await setup()
    for (let i = 0; i < 400; i++) telemetry.capture('annotation_deleted')
    await telemetry.flush()
    expect(events()).toHaveLength(300)
  })

  it('never throws when the network fails', async () => {
    const { telemetry } = await setup({}, { fetch: () => Promise.reject(new TypeError('offline')) })
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
    await telemetry.flush()

    const [selected, imported, failed] = events().map((event) => event.properties)
    expect(selected).not.toHaveProperty('text')
    expect(selected).not.toHaveProperty('title')
    expect(selected).not.toHaveProperty('$current_url')
    expect(selected.length_bucket).toBe('under_20')
    expect(imported).not.toHaveProperty('source')
    expect(failed).toMatchObject({ feature: 'chat', operation: 'send_message' })
    expect(failed).not.toHaveProperty('error_name')
    expect(failed).not.toHaveProperty('http_status')
    expect(failed).not.toHaveProperty('error_ref')
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
    const { telemetry, sent } = await setup({ defaultMode: 'off' })
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
    const { telemetry, sent } = await setup({ defaultMode: 'off' })
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

  it('reports failure when the build has no telemetry configured', async () => {
    const { telemetry, sent } = await setup({ apiKey: undefined })
    await expect(telemetry.report({ feedback: 'hi' })).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  it('caps the note length', async () => {
    expect(scrubFeedback('a'.repeat(5000))).toHaveLength(1000)
    expect(scrubFeedback('see www.example.com/x  and\n\nmore')).toBe('see [link] and more')
  })
})
