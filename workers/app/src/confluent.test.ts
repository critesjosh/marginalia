import { afterEach, describe, expect, it } from 'vitest'
import { ConfluentProducer, recordKey, type ConfluentConfig } from './confluent'

const CONFIG: ConfluentConfig = {
  restEndpoint: 'https://rest.example/',
  clusterId: 'lkc-test',
  apiKey: 'key',
  apiSecret: 'secret',
  topic: 'marginalia.events.v1',
}

describe('ConfluentProducer', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('calls the default fetch with globalThis as its receiver', async () => {
    // Workers throws "Illegal invocation" when the global fetch is called with
    // any other receiver, which a fetch stored on the instance and invoked as
    // `this.#fetch(...)` does. Node is lenient, so the strict receiver check
    // has to be modelled here for the default path to be covered at all.
    const seen: string[] = []
    globalThis.fetch = function (this: unknown, url: string | URL | Request) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      seen.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify({ error_code: 200, partition_id: 0, offset: 7 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    } as unknown as typeof fetch

    const outcome = await new ConfluentProducer(CONFIG).produce({ key: 'k', value: { a: 1 } })

    expect(outcome).toEqual({ status: 'accepted', partition: 0, offset: 7 })
    expect(seen).toEqual([
      'https://rest.example/kafka/v3/clusters/lkc-test/topics/marginalia.events.v1/records',
    ])
  })
})

describe('recordKey', () => {
  it('joins the user and installation so one installation stays on one partition', () => {
    expect(recordKey('user-1', 'install-1')).toBe('user-1:install-1')
  })
})
