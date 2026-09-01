import { describe, expect, it } from 'vitest'
import { HttpDeliveryTransport, type PauseReason } from './transport'
import type { MarginaliaEventV1 } from './types'

function event(sequence: number): MarginaliaEventV1 {
  return {
    schemaVersion: 1,
    eventId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    installationId: '20000000-0000-4000-8000-000000000001',
    sequence,
    source: 'pwa',
    appVersion: '0.0.0',
    eventType: 'highlight_deleted',
    eventTime: '2026-09-01T14:30:00.000Z',
    emittedAt: '2026-09-01T14:30:00.050Z',
    entities: { bookId: 'book-1', highlightId: 'highlight-1' },
    privacy: { consentVersion: 1, included: [] },
    payload: { deletedAt: '2026-09-01T14:30:00.000Z' },
  } as MarginaliaEventV1
}

interface Attempt {
  events: MarginaliaEventV1[]
}

function transportWith(
  respond: (attempt: Attempt) => Response,
  options: { token?: string | null; pauses?: PauseReason[] } = {},
) {
  const attempts: Attempt[] = []
  const pauses = options.pauses ?? []
  const transport = new HttpDeliveryTransport({
    token: async () => (options.token === null ? undefined : options.token ?? 'sync-token'),
    onPause: (reason) => void pauses.push(reason),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const attempt = { events: (JSON.parse(init.body as string) as { events: MarginaliaEventV1[] }).events }
      attempts.push(attempt)
      return respond(attempt)
    }) as unknown as typeof fetch,
  })
  return { transport, attempts, pauses }
}

const accepted = (attempt: Attempt) =>
  Response.json({
    results: attempt.events.map((item) => ({ eventId: item.eventId, status: 'accepted' })),
  })

describe('delivering a batch', () => {
  it('returns the Worker result for each event', async () => {
    const { transport } = transportWith(accepted)
    const results = await transport.send([event(1), event(2)])
    expect(results.map((result) => result.status)).toEqual(['accepted', 'accepted'])
  })

  it('keeps everything queued when the network is gone', async () => {
    const { transport } = transportWith(() => {
      throw new Error('offline')
    })
    const results = await transport.send([event(1)])
    expect(results[0]).toMatchObject({ status: 'retry', code: 'network_error' })
  })

  it('sends nothing without a token', async () => {
    const { transport, attempts } = transportWith(accepted, { token: null })
    const results = await transport.send([event(1)])
    expect(attempts).toHaveLength(0)
    expect(results[0]).toMatchObject({ status: 'retry', code: 'no_sync_token' })
  })

  it('retries a rate limit and an upstream failure', async () => {
    for (const status of [429, 500, 503]) {
      const { transport } = transportWith(() => new Response('', { status }))
      const results = await transport.send([event(1)])
      expect(results[0]).toMatchObject({ status: 'retry', code: 'upstream_unavailable' })
    }
  })

  it('keeps an event whose delivery report never arrived', async () => {
    const { transport } = transportWith(() => Response.json({ results: [] }))
    const results = await transport.send([event(1)])
    expect(results[0]).toMatchObject({ status: 'retry', code: 'missing_delivery_result' })
  })
})

describe('pausing', () => {
  it('stops the loop on a token the Worker will not accept', async () => {
    const { transport, pauses } = transportWith(() => new Response('', { status: 401 }))
    const results = await transport.send([event(1)])
    expect(pauses).toEqual(['invalid_token'])
    expect(results[0]).toMatchObject({ status: 'retry', code: 'invalid_token' })
  })

  it('stops the loop while cloud data is being deleted', async () => {
    const { transport, pauses } = transportWith(() => new Response('', { status: 423 }))
    await transport.send([event(1)])
    expect(pauses).toEqual(['sync_disabled'])
  })
})

describe('a batch the Worker calls too large', () => {
  it('is halved and retried', async () => {
    const { transport, attempts } = transportWith((attempt) =>
      attempt.events.length > 2 ? new Response('', { status: 413 }) : accepted(attempt),
    )

    const results = await transport.send([event(1), event(2), event(3), event(4)])

    expect(attempts.map((attempt) => attempt.events.length)).toEqual([4, 2, 2])
    expect(results.map((result) => result.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ])
  })

  it('rejects a single event that can never fit', async () => {
    const { transport } = transportWith(() => new Response('', { status: 413 }))
    const results = await transport.send([event(1)])
    expect(results[0]).toMatchObject({ status: 'rejected', code: 'event_too_large' })
  })

  it('never sends a later event past one that was not accepted', async () => {
    const { transport, attempts } = transportWith((attempt) => {
      if (attempt.events.length > 2) return new Response('', { status: 413 })
      if (attempt.events[0].sequence === 1) return new Response('', { status: 503 })
      return accepted(attempt)
    })

    const results = await transport.send([event(1), event(2), event(3), event(4)])

    expect(attempts.map((attempt) => attempt.events.length)).toEqual([4, 2])
    expect(results.slice(2).every((result) => result.status === 'retry')).toBe(true)
    expect(results[2]).toMatchObject({ code: 'blocked_by_prior_event' })
  })
})
