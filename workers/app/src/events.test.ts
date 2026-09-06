import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProduceOutcome } from './confluent'
import { MAX_BATCH_BYTES, handleEventBatchRequest, type EventsEnv } from './events'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/fixtures/nietzsche-phase-0.jsonl',
)

const fixtureEvents: Record<string, unknown>[] = readFileSync(FIXTURES, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>)

const TOKEN = 'test-sync-token'
const USER_ID = 'trusted-user-1'

async function digestOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

class FakeProducer {
  readonly records: { key: string; value: Record<string, unknown> }[] = []
  outcomes: ProduceOutcome[] = []

  async produce(record: { key: string; value: unknown }): Promise<ProduceOutcome> {
    this.records.push({ key: record.key, value: record.value as Record<string, unknown> })
    return (
      this.outcomes.shift() ?? {
        status: 'accepted',
        partition: 0,
        offset: this.records.length - 1,
      }
    )
  }
}

let env: EventsEnv
let producer: FakeProducer
let logs: string[]

beforeEach(async () => {
  producer = new FakeProducer()
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line))
  env = {
    MARGINALIA_SYNC_TOKEN_SHA256: await digestOf(TOKEN),
    MARGINALIA_TRUSTED_USER_ID: USER_ID,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function batchRequest(
  events: unknown[],
  init: { token?: string | null; method?: string } = {},
): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = init.token === undefined ? TOKEN : init.token
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const method = init.method ?? 'POST'
  return new Request('https://marginalia.test/api/events/v1/batches', {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ events }),
  })
}

const send = (events: unknown[], init?: { token?: string | null; method?: string }) =>
  handleEventBatchRequest(batchRequest(events, init), env, { producer })

describe('the sync token', () => {
  it('is the only way in', async () => {
    expect((await send(fixtureEvents, { token: null })).status).toBe(401)
    expect((await send(fixtureEvents, { token: 'wrong-token' })).status).toBe(401)
    expect(producer.records).toHaveLength(0)
  })

  it('is never compared against a digest that was never configured', async () => {
    env.MARGINALIA_SYNC_TOKEN_SHA256 = undefined
    expect((await send(fixtureEvents)).status).toBe(503)
  })

  it('fails closed when the configured digest is malformed', async () => {
    env.MARGINALIA_SYNC_TOKEN_SHA256 = 'not-a-sha256-digest'
    expect((await send(fixtureEvents)).status).toBe(503)
    expect(producer.records).toHaveLength(0)
  })
})

describe('the request shape', () => {
  it('accepts only POST', async () => {
    expect((await send(fixtureEvents, { method: 'GET' })).status).toBe(405)
  })

  it('refuses more than twenty events', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...fixtureEvents[0],
      eventId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sequence: index + 1,
    }))
    expect((await send(many)).status).toBe(413)
  })

  it('refuses a body past the size limit', async () => {
    const oversized = {
      ...fixtureEvents[0],
      payload: { ...(fixtureEvents[0].payload as object), text: 'x'.repeat(MAX_BATCH_BYTES) },
    }
    expect((await send([oversized])).status).toBe(413)
  })

  it('refuses an empty batch', async () => {
    expect((await send([])).status).toBe(400)
  })
})

describe('validation', () => {
  const resultsOf = async (events: unknown[]) =>
    (await (await send(events)).json()) as {
      results: { eventId: string; status: string; code?: string }[]
    }

  it('refuses a browser-supplied user id', async () => {
    const { results } = await resultsOf([{ ...fixtureEvents[0], userId: 'someone-else' }])
    expect(results[0]).toMatchObject({ status: 'rejected', code: 'browser_supplied_user_id' })
    expect(producer.records).toHaveLength(0)
  })

  it('refuses an unknown field in a known payload', async () => {
    const event = {
      ...fixtureEvents[0],
      payload: { ...(fixtureEvents[0].payload as object), surroundingContext: 'nearby prose' },
    }
    const { results } = await resultsOf([event])
    expect(results[0]).toMatchObject({ status: 'rejected', code: 'unknown_field' })
    expect(producer.records).toHaveLength(0)
  })

  it('refuses an unknown schema version', async () => {
    const { results } = await resultsOf([{ ...fixtureEvents[0], schemaVersion: 2 }])
    expect(results[0]).toMatchObject({ status: 'rejected', code: 'unknown_schema_version' })
  })

  it('produces nothing at all when one event in the batch is invalid', async () => {
    const { results } = await resultsOf([fixtureEvents[0], { ...fixtureEvents[1], sequence: 0 }])
    expect(results.map((result) => result.status)).toEqual(['retry', 'rejected'])
    // Not blocked_by_prior_event: nothing prior to it failed, and that code is
    // the one the client retries without backing off.
    expect(results[0].code).toBe('batch_not_produced')
    expect(producer.records).toHaveLength(0)
  })
})

describe('production', () => {
  it('forwards every fixture event in sequence order under the trusted identity', async () => {
    const response = await send([...fixtureEvents].reverse())
    const { results } = (await response.json()) as { results: { status: string }[] }

    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(results.every((result) => result.status === 'accepted')).toBe(true)
    expect(producer.records.map((record) => record.value.sequence)).toEqual(
      fixtureEvents.map((event) => event.sequence),
    )
    for (const record of producer.records) {
      expect(record.key).toBe(`${USER_ID}:${record.value.installationId as string}`)
      expect(record.value.userId).toBe(USER_ID)
      expect(typeof record.value.receivedAt).toBe('string')
    }
  })

  it('stops at the first event Kafka does not take', async () => {
    producer.outcomes = [
      { status: 'accepted', partition: 0, offset: 0 },
      { status: 'retry', code: 'upstream_unavailable', detail: '503' },
    ]
    const { results } = (await (await send(fixtureEvents)).json()) as {
      results: { status: string; code?: string }[]
    }

    expect(results[0].status).toBe('accepted')
    expect(results[1]).toMatchObject({ status: 'retry', code: 'upstream_unavailable' })
    expect(results.slice(2).every((result) => result.code === 'blocked_by_prior_event')).toBe(true)
    expect(producer.records).toHaveLength(2)
  })
})

describe('the sync control flag', () => {
  it('locks out an installation whose cloud data is being deleted', async () => {
    env.SYNC_CONTROL = {
      get: async (key: string) =>
        key === `sync-state:${USER_ID}` ? 'disabled' : null,
    } as unknown as KVNamespace

    expect((await send(fixtureEvents)).status).toBe(423)
    expect(producer.records).toHaveLength(0)
  })
})

describe('rate limiting', () => {
  it('turns away a caller over the limit', async () => {
    env.EVENTS_RATE_LIMITER = { limit: async () => ({ success: false }) }
    expect((await send(fixtureEvents)).status).toBe(429)
  })

  it('rate-limits before checking an invalid token', async () => {
    const keys: string[] = []
    env.EVENTS_RATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: false }
      },
    }
    const request = batchRequest(fixtureEvents, { token: 'wrong-token' })
    request.headers.set('CF-Connecting-IP', '192.0.2.10')

    expect((await handleEventBatchRequest(request, env, { producer })).status).toBe(429)
    expect(keys).toEqual(['ip:192.0.2.10'])
  })
})

describe('logging', () => {
  it('records counts and codes but never a consented passage', async () => {
    await send(fixtureEvents)
    const consentedText = (fixtureEvents[0].payload as { text: string }).text

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('"accepted"')
    expect(logs.join('\n')).not.toContain(consentedText)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})
