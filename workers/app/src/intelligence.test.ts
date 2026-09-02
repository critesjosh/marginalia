import { beforeEach, describe, expect, it } from 'vitest'
import {
  INTELLIGENCE_PREFIX,
  handleIntelligenceRequest,
  resetTokenCache,
  type IntelligenceEnv,
  type UpstreamCaller,
} from './intelligence'

const TOKEN = 'a-real-looking-sync-token'
const REQUEST_ID = '7f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d'

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    binding: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    } as unknown as KVNamespace,
  }
}

async function env(overrides: Partial<IntelligenceEnv> = {}): Promise<IntelligenceEnv> {
  return {
    MARGINALIA_SYNC_TOKEN_SHA256: await digest(TOKEN),
    MARGINALIA_TRUSTED_USER_ID: 'trusted-personal-user',
    ...overrides,
  }
}

function get(path: string, token = TOKEN): Request {
  return new Request(`https://example.test${INTELLIGENCE_PREFIX}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

function post(path: string, body: unknown, token = TOKEN): Request {
  return new Request(`https://example.test${INTELLIGENCE_PREFIX}${path}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  })
}

const ok: UpstreamCaller = async () =>
  new Response(JSON.stringify({ concepts: [], sourceUpdatedAt: 1 }), { status: 200 })

describe('the intelligence endpoints', () => {
  beforeEach(() => resetTokenCache())

  it('serves an interest profile to a valid token and never caches it', async () => {
    const response = await handleIntelligenceRequest(get('interest-profile'), await env(), {
      upstream: ok,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a missing or wrong token', async () => {
    expect((await handleIntelligenceRequest(get('interest-profile', ''), await env())).status).toBe(
      401,
    )
    const wrong = await handleIntelligenceRequest(get('interest-profile', 'guess'), await env())
    expect(wrong.status).toBe(401)
  })

  it('asks upstream for the server-held user, whatever the browser sent', async () => {
    const asked: string[] = []
    const spy: UpstreamCaller = async (path) => {
      asked.push(path)
      return new Response('{}', { status: 200 })
    }
    // A browser cannot name a user: there is nowhere in the request to put one.
    await handleIntelligenceRequest(get('interest-profile'), await env(), { upstream: spy })
    expect(asked).toEqual(['/api/v1/users/trusted-personal-user/interest-profile'])
  })

  it('stops a disabled user at the edge', async () => {
    const control = kv({ 'sync-state:trusted-personal-user': 'disabled' })
    const response = await handleIntelligenceRequest(
      get('interest-profile'),
      await env({ SYNC_CONTROL: control.binding }),
      { upstream: ok },
    )
    expect(response.status).toBe(423)
  })

  it('disables sync at the edge before it asks for deletion', async () => {
    const control = kv()
    let sawDisabledFirst = false
    const spy: UpstreamCaller = async () => {
      sawDisabledFirst = control.store.get('sync-state:trusted-personal-user') === 'disabled'
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
    }
    const response = await handleIntelligenceRequest(
      post('delete', { requestId: REQUEST_ID }),
      await env({ SYNC_CONTROL: control.binding }),
      { upstream: spy },
    )
    expect(response.status).toBe(200)
    expect(sawDisabledFirst).toBe(true)
  })

  it('leaves sync disabled when creating the request fails, so the same id retries', async () => {
    const control = kv()
    const failing: UpstreamCaller = async () => new Response(null, { status: 500 })
    const response = await handleIntelligenceRequest(
      post('delete', { requestId: REQUEST_ID }),
      await env({ SYNC_CONTROL: control.binding }),
      { upstream: failing },
    )
    expect(response.status).toBe(503)
    expect(control.store.get('sync-state:trusted-personal-user')).toBe('disabled')
  })

  it('still accepts a deletion retry after sync is disabled, with the same id', async () => {
    // Disabling is the first thing deletion does, so a disabled user must still
    // be able to retry. Refusing here would strand a half-finished deletion.
    const control = kv({ 'sync-state:trusted-personal-user': 'disabled' })
    const seen: string[] = []
    const spy: UpstreamCaller = async (path, init) => {
      seen.push(`${init.method} ${path}`)
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
    }
    const retry = await handleIntelligenceRequest(
      post('delete', { requestId: REQUEST_ID }),
      await env({ SYNC_CONTROL: control.binding }),
      { upstream: spy },
    )
    expect(retry.status).toBe(200)
    expect(seen).toEqual([
      'POST /api/v1/users/trusted-personal-user/deletion-requests',
    ])
  })

  it('lets a disabled user read the status of their deletion', async () => {
    const control = kv({ 'sync-state:trusted-personal-user': 'disabled' })
    const response = await handleIntelligenceRequest(
      get(`delete/${REQUEST_ID}`),
      await env({ SYNC_CONTROL: control.binding }),
      { upstream: async () => new Response(JSON.stringify({ status: 'running' }), { status: 200 }) },
    )
    expect(response.status).toBe(200)
  })

  it('passes through statuses a caller can act on rather than calling them all unavailable', async () => {
    const cases: Array<[number, number, string]> = [
      [404, 404, 'not_found'],
      [409, 409, 'already_exists'],
      [429, 429, 'upstream_rate_limited'],
      // An upstream authorization problem is not the browser's token being wrong.
      [403, 503, 'intelligence_unavailable'],
      [500, 503, 'intelligence_unavailable'],
    ]
    for (const [upstreamStatus, expected, code] of cases) {
      const response = await handleIntelligenceRequest(get('book-engagement'), await env(), {
        upstream: async () =>
          new Response(upstreamStatus === 429 ? '{}' : null, {
            status: upstreamStatus,
            headers: upstreamStatus === 429 ? { 'retry-after': '30' } : {},
          }),
      })
      expect([upstreamStatus, response.status]).toEqual([upstreamStatus, expected])
      expect(await response.json()).toEqual({ error: { code } })
      if (upstreamStatus === 429) expect(response.headers.get('retry-after')).toBe('30')
    }
  })

  it('rejects a deletion request id that is not a uuid', async () => {
    const response = await handleIntelligenceRequest(
      post('delete', { requestId: 'whatever' }),
      await env(),
      { upstream: ok },
    )
    expect(response.status).toBe(400)
  })

  it('reports an unreachable upstream as unavailable rather than as an error', async () => {
    const throwing: UpstreamCaller = async () => {
      throw new Error('network')
    }
    const response = await handleIntelligenceRequest(get('book-engagement'), await env(), {
      upstream: throwing,
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'intelligence_unavailable' } })
  })

  it('refuses everything until the Worker is configured', async () => {
    const response = await handleIntelligenceRequest(get('interest-profile'), {}, { upstream: ok })
    expect(response.status).toBe(503)
  })

  it('does not serve an unknown route', async () => {
    const response = await handleIntelligenceRequest(get('everything'), await env(), {
      upstream: ok,
    })
    expect(response.status).toBe(404)
  })
})
