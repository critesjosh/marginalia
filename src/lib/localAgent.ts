/**
 * Pairing with the reader's local agent bridge (decision 0010). While paired,
 * chat and background notes go to the bridge on this computer instead of
 * Rami's relay.
 *
 * The token lives in localStorage, so it never enters IndexedDB, the JSON
 * export, a published thread, diagnostics or telemetry. Storage that cannot be
 * read counts as an unknown state, not as unpaired, so a broken read can never
 * quietly send a local reader's passages to the relay.
 */

export const BRIDGE_ORIGIN = 'http://127.0.0.1:47615'

/** The bridge's token shape: 32 bytes as unpadded base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const STORAGE_KEY = 'rami.localAgent'

export type LocalAgentState =
  { kind: 'off' } | { kind: 'paired'; token: string } | { kind: 'unreadable' }

const OFF: LocalAgentState = { kind: 'off' }
const UNREADABLE: LocalAgentState = { kind: 'unreadable' }

export function isPairingToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

let cached: { raw: string | null; state: LocalAgentState } | null = null

/** Stable between changes, as `useSyncExternalStore` needs. */
export function localAgentState(): LocalAgentState {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return UNREADABLE
  }
  if (cached?.raw === raw) return cached.state
  cached = { raw, state: parse(raw) }
  return cached.state
}

function parse(raw: string | null): LocalAgentState {
  if (raw === null) return OFF
  try {
    const { token } = JSON.parse(raw) as { token?: unknown }
    if (typeof token === 'string' && isPairingToken(token)) return { kind: 'paired', token }
  } catch {
    // Falls through: a damaged entry is not the same as no entry.
  }
  return UNREADABLE
}

const listeners = new Set<() => void>()

export function subscribeLocalAgent(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function notify() {
  for (const listener of listeners) listener()
}

/** Saves the token and reads it back. False means the browser did not keep it. */
export function savePairing(token: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token }))
  } catch {
    return false
  } finally {
    notify()
  }
  const state = localAgentState()
  return state.kind === 'paired' && state.token === token
}

/** Forgets the token here. The bridge keeps accepting it until `--new-token`. */
export function clearPairing(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    return false
  } finally {
    notify()
  }
  return localAgentState().kind === 'off'
}

/** Never sends cookies, never follows a redirect, never uses the HTTP cache. */
export function bridgeFetch(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${BRIDGE_ORIGIN}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
}

export const BRIDGE_UNREACHABLE =
  "Rami can't reach your local agent. Start it with `npm run agent-bridge`, and allow Rami to " +
  'reach this device if your browser asks. Safari cannot connect to it.'

export interface BridgeStatus {
  agent: string
  mcp: string[] | 'all'
}

export type BridgeCheck = { ok: true; status: BridgeStatus } | { ok: false; message: string }

export async function checkBridge(token: string, signal?: AbortSignal): Promise<BridgeCheck> {
  let response: Response
  try {
    response = await bridgeFetch('/v1/status', token, { signal })
  } catch {
    return { ok: false, message: BRIDGE_UNREACHABLE }
  }
  if (response.status === 401) {
    return {
      ok: false,
      message: 'The bridge rejected that token. Copy it again from its terminal.',
    }
  }
  if (!response.ok) {
    return { ok: false, message: `The bridge answered with an error (${response.status}).` }
  }
  try {
    const { agent, mcp } = (await response.json()) as Partial<BridgeStatus>
    if (typeof agent !== 'string') throw new Error('No agent')
    return { ok: true, status: { agent, mcp: mcp === 'all' || Array.isArray(mcp) ? mcp : [] } }
  } catch {
    return { ok: false, message: 'The bridge sent an answer Rami could not read.' }
  }
}
