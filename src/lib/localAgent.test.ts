import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeChat, InferenceError, streamChat } from './inference'
import {
  BRIDGE_ORIGIN,
  BRIDGE_UNREACHABLE,
  checkBridge,
  clearPairing,
  localAgentState,
  savePairing,
} from './localAgent'

const TOKEN = 'a'.repeat(43)
const MESSAGES = [{ role: 'user' as const, content: 'Who is Ahab?' }]

let store: Map<string, string>
let failReads: boolean
let dropWrites: boolean

beforeEach(() => {
  store = new Map()
  failReads = false
  dropWrites = false
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('localStorage', {
    getItem(key: string) {
      if (failReads) throw new Error('SecurityError')
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (!dropWrites) store.set(key, value)
    },
    removeItem: (key: string) => void store.delete(key),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const answer = (content: string) =>
  Response.json({ choices: [{ message: { role: 'assistant', content } }] })

describe('pairing state', () => {
  it('is off until a token is saved, and off again after disconnecting', () => {
    expect(localAgentState()).toEqual({ kind: 'off' })
    expect(savePairing(TOKEN)).toBe(true)
    expect(localAgentState()).toEqual({ kind: 'paired', token: TOKEN })
    expect(clearPairing()).toBe(true)
    expect(localAgentState()).toEqual({ kind: 'off' })
  })

  it('treats unreadable or damaged storage as unknown, never as off', () => {
    store.set('rami.localAgent', '{"token": 42}')
    expect(localAgentState()).toEqual({ kind: 'unreadable' })
    failReads = true
    expect(localAgentState()).toEqual({ kind: 'unreadable' })
  })

  it('reports a save the browser did not keep', () => {
    dropWrites = true
    expect(savePairing(TOKEN)).toBe(false)
    expect(localAgentState()).toEqual({ kind: 'off' })
  })
})

describe('routing', () => {
  it('uses the relay when not paired', async () => {
    const fetch = vi.fn(async () => answer('From the relay'))
    vi.stubGlobal('fetch', fetch)
    expect(await completeChat({ messages: MESSAGES })).toBe('From the relay')
    expect(fetch).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }))
  })

  it('sends chat and summaries to the bridge with the token, never to the relay', async () => {
    savePairing(TOKEN)
    const fetch = vi.fn(async () => answer('From the agent'))
    vi.stubGlobal('fetch', fetch)
    expect(await completeChat({ messages: MESSAGES })).toBe('From the agent')

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BRIDGE_ORIGIN}/v1/chat`)
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' })
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
    expect(JSON.parse(String(init.body))).toEqual({ messages: MESSAGES, stream: false })
  })

  it('names the bridge when it cannot be reached, without trying the relay', async () => {
    savePairing(TOKEN)
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)
    await expect(streamChat({ messages: MESSAGES, onDelta: () => {} })).rejects.toThrow(
      BRIDGE_UNREACHABLE,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes through the reader stopping a reply', async () => {
    savePairing(TOKEN)
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(completeChat({ messages: MESSAGES, signal: controller.signal })).rejects.toThrow(
      'Aborted',
    )
  })

  it('sends nothing when the pairing cannot be read', async () => {
    failReads = true
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(completeChat({ messages: MESSAGES })).rejects.toBeInstanceOf(InferenceError)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('checkBridge', () => {
  it('reads the status, and explains the ways it can fail', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ agent: 'codex', mcp: 'all' }))
    expect(await checkBridge(TOKEN)).toEqual({
      ok: true,
      status: { agent: 'codex', mcp: 'all', saveDir: null },
    })

    const narrowed = { agent: 'claude', mcp: ['miyo'], mcpTools: { miyo: ['search'] } }
    vi.stubGlobal('fetch', async () => Response.json(narrowed))
    expect(await checkBridge(TOKEN)).toEqual({ ok: true, status: { ...narrowed, saveDir: null } })
    vi.stubGlobal('fetch', async () => Response.json({ ...narrowed, mcpTools: { miyo: 'search' } }))
    expect(await checkBridge(TOKEN)).toEqual({
      ok: true,
      status: { agent: 'claude', mcp: ['miyo'], saveDir: null },
    })

    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }))
    expect(await checkBridge(TOKEN)).toMatchObject({ ok: false, message: /rejected/ })

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await checkBridge(TOKEN)).toEqual({ ok: false, message: BRIDGE_UNREACHABLE })

    vi.stubGlobal('fetch', async () => new Response('not json'))
    expect(await checkBridge(TOKEN)).toMatchObject({ ok: false })
  })
})
