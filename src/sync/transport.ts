import type { DeliveryResult, DeliveryTransport, MarginaliaEventV1, SyncState } from './types'

export const EVENTS_ENDPOINT = '/api/events/v1/batches'

export type PauseReason = NonNullable<SyncState['pausedReason']>

export interface HttpDeliveryOptions {
  /** Resolves the sync token the reader pasted into Settings, if any. */
  token: () => Promise<string | undefined>
  endpoint?: string
  fetchImpl?: typeof fetch
  onPause?: (reason: PauseReason) => Promise<void> | void
}

function allRetry(
  events: readonly MarginaliaEventV1[],
  code: string,
): DeliveryResult[] {
  return events.map((event) => ({ eventId: event.eventId, status: 'retry', code }))
}

/**
 * Sends queued events to the same-origin Worker endpoint.
 *
 * Delivery stays head-of-line: once one event in a request is not accepted,
 * every later event is reported back as blocked rather than sent ahead of it.
 */
export class HttpDeliveryTransport implements DeliveryTransport {
  readonly #options: HttpDeliveryOptions

  constructor(options: HttpDeliveryOptions) {
    this.#options = options
  }

  async send(events: MarginaliaEventV1[]): Promise<DeliveryResult[]> {
    if (!events.length) return []
    return this.#sendChunk(events)
  }

  async #sendChunk(events: MarginaliaEventV1[]): Promise<DeliveryResult[]> {
    const token = await this.#options.token()
    if (!token) return allRetry(events, 'no_sync_token')

    const fetchImpl = this.#options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(this.#options.endpoint ?? EVENTS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      })
    } catch {
      return allRetry(events, 'network_error')
    }

    if (response.status === 401) {
      await this.#options.onPause?.('invalid_token')
      return allRetry(events, 'invalid_token')
    }

    if (response.status === 423) {
      await this.#options.onPause?.('sync_disabled')
      return allRetry(events, 'sync_disabled')
    }

    if (response.status === 413) return this.#halve(events)

    if (response.status === 429 || response.status >= 500) {
      return allRetry(events, 'upstream_unavailable')
    }

    if (!response.ok) return allRetry(events, `http_${response.status}`)

    let body: { results?: DeliveryResult[] }
    try {
      body = (await response.json()) as { results?: DeliveryResult[] }
    } catch {
      return allRetry(events, 'malformed_response')
    }

    const byId = new Map((body.results ?? []).map((result) => [result.eventId, result]))
    return events.map(
      (event) =>
        byId.get(event.eventId) ?? {
          eventId: event.eventId,
          status: 'retry' as const,
          code: 'missing_delivery_result',
        },
    )
  }

  /**
   * A rejected batch size is retried in halves. One event that is still too
   * large can never succeed, so it is rejected into local diagnostics instead
   * of retrying forever.
   */
  async #halve(events: MarginaliaEventV1[]): Promise<DeliveryResult[]> {
    if (events.length === 1) {
      return [{ eventId: events[0].eventId, status: 'rejected', code: 'event_too_large' }]
    }

    const middle = Math.ceil(events.length / 2)
    const head = await this.#sendChunk(events.slice(0, middle))
    const tail = events.slice(middle)

    if (head.some((result) => result.status !== 'accepted')) {
      return [...head, ...allRetry(tail, 'blocked_by_prior_event')]
    }
    return [...head, ...(await this.#sendChunk(tail))]
  }
}
