// Confluent Cloud Kafka REST v3 producer.
//
// Personal traffic is low and every event needs an unambiguous delivery report
// before its outbox row is acknowledged, so records are produced one at a time
// with the non-streaming Produce request rather than batched blindly.

export interface ConfluentConfig {
  restEndpoint: string
  clusterId: string
  apiKey: string
  apiSecret: string
  topic: string
}

export type ProduceOutcome =
  | { status: 'accepted'; partition: number; offset: number }
  | { status: 'retry'; code: 'upstream_unavailable' | 'upstream_unauthorized'; detail: string }
  | { status: 'rejected'; code: 'upstream_rejected'; detail: string }

const PRODUCE_TIMEOUT_MS = 10_000

export function confluentConfigFrom(
  env: Record<string, unknown>,
): ConfluentConfig | undefined {
  const read = (key: string): string | undefined =>
    typeof env[key] === 'string' && env[key] ? (env[key] as string) : undefined

  const restEndpoint = read('CONFLUENT_REST_ENDPOINT')
  const clusterId = read('CONFLUENT_CLUSTER_ID')
  const apiKey = read('CONFLUENT_API_KEY')
  const apiSecret = read('CONFLUENT_API_SECRET')
  const topic = read('CONFLUENT_TOPIC')

  if (!restEndpoint || !clusterId || !apiKey || !apiSecret || !topic) return undefined
  return { restEndpoint, clusterId, apiKey, apiSecret, topic }
}

/**
 * The record key keeps one installation's events on one partition, so source
 * order stays inspectable even after the topic is widened past one partition.
 */
export function recordKey(userId: string, installationId: string): string {
  return `${userId}:${installationId}`
}

export interface ProduceRequest {
  key: string
  value: unknown
}

export class ConfluentProducer {
  readonly #config: ConfluentConfig
  readonly #fetch: typeof fetch

  // The global fetch must stay bound to globalThis: called as `this.#fetch(...)`
  // an unbound reference throws "Illegal invocation" in Workers.
  constructor(config: ConfluentConfig, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#config = config
    this.#fetch = fetchImpl
  }

  get #url(): string {
    const base = this.#config.restEndpoint.replace(/\/+$/, '')
    return `${base}/kafka/v3/clusters/${this.#config.clusterId}/topics/${encodeURIComponent(
      this.#config.topic,
    )}/records`
  }

  get #authorization(): string {
    return `Basic ${btoa(`${this.#config.apiKey}:${this.#config.apiSecret}`)}`
  }

  async produce(record: ProduceRequest): Promise<ProduceOutcome> {
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          Authorization: this.#authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: { type: 'STRING', data: record.key },
          value: { type: 'JSON', data: record.value },
        }),
        signal: AbortSignal.timeout(PRODUCE_TIMEOUT_MS),
      })
    } catch (error) {
      return {
        status: 'retry',
        code: 'upstream_unavailable',
        detail: error instanceof Error ? error.name : 'network_error',
      }
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'retry', code: 'upstream_unauthorized', detail: String(response.status) }
    }
    if (response.status === 429 || response.status >= 500) {
      return { status: 'retry', code: 'upstream_unavailable', detail: String(response.status) }
    }

    let body: { error_code?: number; partition_id?: number; offset?: number } | undefined
    try {
      body = (await response.json()) as typeof body
    } catch {
      body = undefined
    }

    if (!response.ok) {
      return { status: 'rejected', code: 'upstream_rejected', detail: String(response.status) }
    }

    // Kafka REST reports a per-record failure inside a 200 response.
    const errorCode = body?.error_code ?? 200
    if (errorCode !== 200) {
      return errorCode >= 500
        ? { status: 'retry', code: 'upstream_unavailable', detail: String(errorCode) }
        : { status: 'rejected', code: 'upstream_rejected', detail: String(errorCode) }
    }

    if (typeof body?.partition_id !== 'number' || typeof body?.offset !== 'number') {
      // No delivery report means no acknowledgement.
      return { status: 'retry', code: 'upstream_unavailable', detail: 'missing_delivery_report' }
    }

    return { status: 'accepted', partition: body.partition_id, offset: body.offset }
  }
}
