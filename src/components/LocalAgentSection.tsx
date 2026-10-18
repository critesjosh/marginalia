import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  checkBridge,
  clearPairing,
  isPairingToken,
  localAgentState,
  savePairing,
  subscribeLocalAgent,
  type BridgeCheck,
  type BridgeStatus,
} from '../lib/localAgent'
import { button, card } from './ui'

const BRIDGE_DOCS = 'https://github.com/critesjosh/marginalia/blob/main/docs/agent-bridge.md'

/** Settings: pairing with the reader's own Claude Code or Codex (decision 0010). */
export default function LocalAgentSection() {
  const state = useSyncExternalStore(subscribeLocalAgent, localAgentState)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<BridgeCheck | null>(null)
  const [error, setError] = useState('')
  const token = state.kind === 'paired' ? state.token : null
  // The Connect still waiting on the bridge, so a change of pairing (here or
  // in another tab) or leaving Settings can cancel it before it saves.
  const pending = useRef<AbortController | null>(null)

  useEffect(() => {
    pending.current?.abort()
  }, [state.kind])
  useEffect(() => () => pending.current?.abort(), [])

  // Shows what the paired bridge is running each time Settings opens.
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    void checkBridge(token, controller.signal).then((result) => {
      if (!controller.signal.aborted) setCheck(result)
    })
    return () => controller.abort()
  }, [token])

  async function connect() {
    const candidate = draft.trim()
    setError('')
    if (!isPairingToken(candidate)) {
      setError('That is not a pairing token. Copy the whole token the bridge printed.')
      return
    }
    pending.current?.abort()
    const attempt = new AbortController()
    pending.current = attempt
    setBusy(true)
    const result = await checkBridge(candidate, attempt.signal)
    if (attempt.signal.aborted) {
      // Cancelled by a pairing change rather than replaced by a newer attempt.
      if (pending.current === attempt) {
        pending.current = null
        setBusy(false)
      }
      return
    }
    pending.current = null
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    // Another tab may have paired meanwhile; its token wins.
    if (localAgentState().kind !== 'off') return
    if (!savePairing(candidate)) {
      setError('This browser would not save the pairing, so Rami keeps using its own relay.')
      return
    }
    setDraft('')
    setCheck(result)
  }

  function disconnect() {
    pending.current?.abort()
    setBusy(false)
    setCheck(null)
    if (!clearPairing()) setError('This browser would not forget the pairing. Clear site data.')
  }

  return (
    <section className={card}>
      <h2 className="font-book text-heading font-medium">Local agent</h2>
      <p className="mt-1 font-ui text-body text-ink-soft">
        Answer from your own Claude Code or Codex on this computer, with the tools you allow it.
        Start the bridge from a Rami checkout with <code>npm run agent-bridge</code> and paste the
        token it prints. Works in Chrome, Edge and Firefox on a computer, not on phones or in
        Safari.
      </p>

      {state.kind === 'unreadable' && (
        <p className="mt-3 font-ui text-meta text-danger" role="alert">
          Rami can't read its pairing in this browser, so chat is paused rather than sent elsewhere.
          Allow this site to store data, then disconnect and pair again.
        </p>
      )}

      {state.kind === 'paired' ? (
        <>
          <p className="mt-3 font-ui text-body" role="status">
            {check === null ? 'Checking the bridge…' : describe(check)}
          </p>
          <p className="mt-2 font-ui text-meta text-ink-faint">
            While connected, your passages, threads and Rami's notes go to that agent, its provider
            and the servers you allow, not to Rami's relay. Disconnecting sends later chats,
            including earlier messages in a thread, back through the relay.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={disconnect} className={button.secondary}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Pairing token"
            placeholder="Pairing token"
            autoComplete="off"
            spellCheck={false}
            className="min-h-tap min-w-0 flex-1 rounded-md border border-rule-strong bg-paper-leaf px-3 font-ui text-body text-ink placeholder:text-ink-faint"
          />
          <button
            onClick={() => void connect()}
            disabled={busy || !draft.trim() || state.kind === 'unreadable'}
            className={button.secondary}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 font-ui text-meta text-danger" role="alert">
          {error}
        </p>
      )}
      {state.kind === 'unreadable' && (
        <button onClick={disconnect} className={`${button.quiet} mt-2 -ml-3`}>
          Disconnect
        </button>
      )}
      <a
        href={BRIDGE_DOCS}
        target="_blank"
        rel="noreferrer"
        className={`${button.quiet} mt-2 -ml-3`}
      >
        How the bridge works ↗
      </a>
    </section>
  )
}

function describe(check: BridgeCheck): string {
  if (!check.ok) return check.message
  return `Connected to ${agentName(check.status)}, with ${servers(check.status)}.`
}

function agentName({ agent }: BridgeStatus): string {
  if (agent === 'claude') return 'Claude Code'
  if (agent === 'codex') return 'Codex'
  return agent
}

function servers({ mcp }: BridgeStatus): string {
  if (mcp === 'all') return 'every MCP server it has'
  return mcp.length ? `MCP servers: ${mcp.join(', ')}` : 'no MCP servers'
}
