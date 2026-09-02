import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS, type Provider } from '../db/types'
import { HOSTED_MODEL_LABEL, verifyKey } from '../lib/inference'
import { createAudiobookSession } from '../lib/audiobooks'
import { BackIcon } from '../components/Icons'
import KoreaderImport from '../components/KoreaderImport'
import { updateSyncPreferences } from '../sync/preferences'
import { discardOutboxEvent, releaseHeldEvent, retryRejectedEvent } from '../sync/delivery'
import { deliverNow } from '../sync/scheduler'
import { readDeletionStatus, requestCloudDeletion } from '../sync/insights'
import type { SyncPreferenceKey, SyncState } from '../sync/types'

const PAUSE_EXPLANATION: Record<NonNullable<SyncState['pausedReason']>, string> = {
  invalid_token: 'Delivery is paused: the server did not accept this sync token.',
  rejected_event: 'Delivery is paused on a rejected event. Retry or discard it below.',
  sync_disabled: 'Delivery is paused while cloud data is being deleted for this account.',
}

// Keep retired models listed: a stored value with no matching option renders the
// select blank, so anything a user might already have saved has to stay.
const MODELS = [
  { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna — newest' },
  { value: 'gpt-5', label: 'gpt-5 — general purpose' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini — small and fast' },
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini — small and fast, older' },
  { value: 'gpt-4o', label: 'gpt-4o — older' },
]

const ISSUES_URL = 'https://github.com/critesjosh/marginalia/issues'

export default function SettingsPage() {
  const stored = useLiveQuery(() => getSettings(), [])
  const [apiKey, setApiKey] = useState('')
  const [dirtyKey, setDirtyKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState<string>()
  const [audiobookToken, setAudiobookToken] = useState('')
  const [dirtyAudiobookToken, setDirtyAudiobookToken] = useState(false)
  const [audiobookStatus, setAudiobookStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>(
    'idle',
  )
  const [audiobookMessage, setAudiobookMessage] = useState<string>()
  const [syncToken, setSyncToken] = useState('')
  const [dirtySyncToken, setDirtySyncToken] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string>()

  const outbox = useLiveQuery(() => db.eventOutbox.orderBy('sequence').toArray(), []) ?? []
  const pendingErrors = outbox.filter(
    (row) =>
      row.status === 'pending' &&
      row.lastErrorCode !== undefined &&
      row.lastErrorCode !== 'blocked_by_prior_event',
  )
  const syncState = useLiveQuery(() => db.syncState.get('sync'), [])
  const [delivering, setDelivering] = useState(false)
  const [confirmingDeletion, setConfirmingDeletion] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletionMessage, setDeletionMessage] = useState<string>()
  const [deletionStatus, setDeletionStatus] = useState<string>()
  // Bumped by a retry so the status effect runs again for the same request id.
  const [deletionAttempts, setDeletionAttempts] = useState(0)

  const activeDeletion = syncState?.activeDeletionRequestId
  useEffect(() => {
    if (!activeDeletion) return
    let cancelled = false

    // The first read can land before the request has been created, and a retry
    // reuses the same id, so neither the id nor a single read is enough to keep
    // the status current. Poll until it reaches a state that cannot change.
    const poll = async () => {
      const result = await readDeletionStatus(activeDeletion)
      if (cancelled) return
      setDeletionStatus(result?.status)
      if (result?.status === 'completed' || result?.status === 'failed') {
        window.clearInterval(timer)
      }
    }
    const timer = window.setInterval(() => void poll(), 15_000)
    void poll()

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeDeletion, deletionAttempts])

  async function startDeletion() {
    setDeleting(true)
    setDeletionMessage(undefined)
    try {
      const { submitted } = await requestCloudDeletion()
      // Local state is gone either way. Only the asking can fail, and it is
      // retried with the same reference rather than starting again.
      setDeletionMessage(
        submitted
          ? 'Requested. Sync is off on this device and the queue is empty.'
          : 'Sync is off on this device and the queue is empty, but the request did not reach the server. Retry when you are online.',
      )
    } finally {
      setDeleting(false)
      setConfirmingDeletion(false)
      setDeletionAttempts((count) => count + 1)
    }
  }

  const settings = stored ?? DEFAULT_SETTINGS

  useEffect(() => {
    if (stored && !dirtyKey) setApiKey(stored.apiKey ?? '')
  }, [stored, dirtyKey])

  useEffect(() => {
    if (stored && !dirtyAudiobookToken) {
      setAudiobookToken(stored.audiobookAccessToken ?? '')
    }
  }, [stored, dirtyAudiobookToken])

  useEffect(() => {
    if (stored && !dirtySyncToken) setSyncToken(stored.syncToken ?? '')
  }, [stored, dirtySyncToken])

  async function testAndSave() {
    const key = apiKey.trim()
    if (!key) {
      await saveSettings({ apiKey: undefined })
      setStatus('idle')
      setMessage('Key cleared.')
      return
    }

    setStatus('checking')
    setMessage(undefined)
    try {
      await verifyKey(key, settings.model)
      await saveSettings({ apiKey: key })
      setDirtyKey(false)
      setStatus('ok')
      setMessage('Key works and is saved on this device.')
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Could not verify that key.')
    }
  }

  async function testAndSaveAudiobookToken() {
    const token = audiobookToken.trim()
    if (!token) {
      await saveSettings({ audiobookAccessToken: undefined })
      setDirtyAudiobookToken(false)
      setAudiobookStatus('idle')
      setAudiobookMessage('Token cleared.')
      return
    }

    setAudiobookStatus('checking')
    setAudiobookMessage(undefined)
    try {
      await createAudiobookSession(token)
      await saveSettings({ audiobookAccessToken: token })
      setDirtyAudiobookToken(false)
      setAudiobookStatus('ok')
      setAudiobookMessage('Token works and is saved on this device.')
    } catch (err) {
      setAudiobookStatus('error')
      setAudiobookMessage(err instanceof Error ? err.message : 'Could not verify that token.')
    }
  }

  async function setSyncPreference(key: SyncPreferenceKey, value: boolean) {
    await updateSyncPreferences({ [key]: value })
  }

  async function saveSyncToken() {
    const token = syncToken.trim()
    await saveSettings({ syncToken: token || undefined })
    setDirtySyncToken(false)
    setSyncMessage(token ? 'Sync token saved only on this device.' : 'Sync token cleared.')

    // A token the server refused pauses the loop. Saving a new one is the
    // reader's way of saying it is worth trying again.
    const state = await db.syncState.get('sync')
    if (token && state?.pausedReason === 'invalid_token') {
      await db.syncState.put({ ...state, pausedReason: undefined })
    }
  }

  async function sendQueuedEvents() {
    setDelivering(true)
    try {
      const accepted = await deliverNow()
      setSyncMessage(accepted ? `Delivered ${accepted} events.` : 'Nothing was delivered.')
    } catch (err) {
      // Without this the button silently resets and the failure surfaces only as
      // an unhandled rejection in the console.
      setSyncMessage(err instanceof Error ? err.message : 'Could not send queued events.')
    } finally {
      setDelivering(false)
    }
  }

  return (
    <div className="min-h-full bg-stone-950 text-stone-100">
      <header className="pt-safe sticky top-0 z-10 border-b border-stone-800 bg-stone-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-1 px-2 pb-2">
          <Link to="/" aria-label="Back to library" className="rounded-lg p-2.5 text-stone-400">
            <BackIcon />
          </Link>
          <h1 className="text-base font-semibold">Settings</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-8 px-4 py-6">
        <section>
          <h2 className="text-sm font-semibold">Chat model</h2>
          <p className="mt-1 text-sm text-stone-400">
            Chat works out of the box — no account or key needed.
          </p>

          <div className="mt-3 space-y-2">
            <ProviderOption
              value="hosted"
              current={settings.provider}
              title="Built-in model"
              detail={`${HOSTED_MODEL_LABEL}. Free, and your key stays out of it — requests go through this site's relay.`}
            />
            <ProviderOption
              value="openai"
              current={settings.provider}
              title="My own OpenAI key"
              detail="Sends your conversations straight to api.openai.com, billed to you."
            />
          </div>
        </section>

        {settings.provider === 'openai' && (
          <>
            <section>
              <h2 className="text-sm font-semibold">OpenAI API key</h2>
              <p className="mt-1 text-sm text-stone-400">
                Stored only in this browser and sent only to api.openai.com. Don't use this on a
                shared device.
              </p>

              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setDirtyKey(true)
                  setStatus('idle')
                  setMessage(undefined)
                }}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                className="mt-3 w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2.5 font-mono text-sm outline-none focus:border-amber-500"
              />

              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => void testAndSave()}
                  disabled={status === 'checking'}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
                >
                  {status === 'checking' ? 'Checking…' : 'Test and save'}
                </button>
                {message && (
                  <p
                    className={`text-sm ${
                      status === 'error' ? 'text-red-300' : 'text-emerald-300'
                    }`}
                  >
                    {message}
                  </p>
                )}
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold">OpenAI models</h2>
              <select
                value={settings.model}
                onChange={(e) => void saveSettings({ model: e.target.value })}
                className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2.5 text-sm"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              <h3 className="mt-5 text-sm font-semibold">Summary model</h3>
              <p className="mt-1 text-xs text-stone-500">
                Used for the per-book memory digest. A cheap model is plenty.
              </p>
              <select
                value={settings.summaryModel}
                onChange={(e) => void saveSettings({ summaryModel: e.target.value })}
                className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2.5 text-sm"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </section>
          </>
        )}

        <section>
          <h2 className="text-sm font-semibold">Personal audiobook</h2>
          <p className="mt-1 text-sm text-stone-400">
            Unlocks the private <em>Twilight of the Idols</em> stream. The token is stored only
            in this browser's IndexedDB and is sent only to the audiobook Worker. Don't use it
            on a shared device.
          </p>
          <input
            type="password"
            value={audiobookToken}
            onChange={(e) => {
              setAudiobookToken(e.target.value)
              setDirtyAudiobookToken(true)
              setAudiobookStatus('idle')
              setAudiobookMessage(undefined)
            }}
            placeholder="Personal access token"
            autoComplete="off"
            spellCheck={false}
            className="mt-3 w-full rounded-lg border border-stone-700 bg-stone-900 px-3 py-2.5 font-mono text-sm outline-none focus:border-amber-500"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => void testAndSaveAudiobookToken()}
              disabled={audiobookStatus === 'checking'}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-stone-950 disabled:opacity-50"
            >
              {audiobookStatus === 'checking' ? 'Checking…' : 'Test and save'}
            </button>
            {audiobookMessage && (
              <p
                className={`text-sm ${
                  audiobookStatus === 'error' ? 'text-red-300' : 'text-emerald-300'
                }`}
              >
                {audiobookMessage}
              </p>
            )}
          </div>
        </section>

        <section>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.spoilerGuard}
              onChange={(e) => void saveSettings({ spoilerGuard: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-amber-500"
            />
            <span>
              <span className="text-sm font-medium">Avoid spoilers</span>
              <span className="mt-0.5 block text-sm text-stone-400">
                Ask the model not to reveal anything past your current position unless you ask.
              </span>
            </span>
          </label>
        </section>

        <section className="rounded-xl border border-stone-800 bg-stone-900/50 p-4">
          <h2 className="text-sm font-semibold">Private intelligence sync</h2>
          <p className="mt-1 text-sm text-stone-400">
            Off unless you turn it on. With sync on and a token saved, recorded events are
            sent to Marginalia's own server; with either missing, they stay in this browser.
          </p>

          <label className="mt-4 flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.syncEnabled}
              onChange={(event) => void setSyncPreference('syncEnabled', event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber-500"
            />
            <span>
              <span className="text-sm font-medium">Record future activity for sync</span>
              <span className="mt-0.5 block text-xs text-stone-400">
                Off by default. Existing books, highlights, and chats are never backfilled.
              </span>
            </span>
          </label>

          {settings.storagePersistence === 'denied' && (
            <p role="status" className="mt-3 rounded-lg bg-amber-950/60 p-3 text-xs text-amber-200">
              This browser did not grant persistent storage. Queued events can be evicted under
              storage pressure; normal reading data has the same browser limitation.
            </p>
          )}
          {settings.storagePersistence === 'unavailable' && settings.syncEnabled && (
            <p role="status" className="mt-3 rounded-lg bg-stone-800 p-3 text-xs text-stone-300">
              Persistent-storage status is unavailable in this browser. Sync remains local and
              enabled, but queued events are not eviction-proof.
            </p>
          )}

          <div className="mt-5">
            <label htmlFor="sync-token" className="text-sm font-medium">
              Personal sync token
            </label>
            <p className="mt-1 text-xs text-stone-400">
              Stored only in this browser and sent to Marginalia's own server to authorize
              delivery. Without it, queued events stay on this device.
            </p>
            <input
              id="sync-token"
              type="password"
              value={syncToken}
              onChange={(event) => {
                setSyncToken(event.target.value)
                setDirtySyncToken(true)
                setSyncMessage(undefined)
              }}
              placeholder="Personal sync token"
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2.5 font-mono text-sm outline-none focus:border-amber-500"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={() => void saveSyncToken()}
                disabled={!dirtySyncToken}
                className="rounded-lg border border-stone-700 px-3 py-2 text-sm font-medium disabled:opacity-40"
              >
                Save token
              </button>
              {syncMessage && <p className="text-xs text-emerald-300">{syncMessage}</p>}
            </div>
          </div>

          <fieldset className="mt-5">
            <legend className="text-sm font-medium">Text shared with intelligence</legend>
            <p className="mt-1 text-xs text-stone-400">
              Each category is separate and off by default. Metadata-only events can still be
              recorded when activity sync is on.
            </p>
            <div className="mt-3 space-y-3">
              <ConsentToggle
                label="Book metadata"
                detail="Title, author, publisher, date, language, and description."
                checked={settings.shareBookMetadata}
                onChange={(value) => void setSyncPreference('shareBookMetadata', value)}
              />
              <ConsentToggle
                label="Highlighted passages"
                detail="The exact text you highlight."
                checked={settings.shareHighlightText}
                onChange={(value) => void setSyncPreference('shareHighlightText', value)}
              />
              <ConsentToggle
                label="Highlight notes"
                detail="Notes you write on highlights."
                checked={settings.shareHighlightNotes}
                onChange={(value) => void setSyncPreference('shareHighlightNotes', value)}
              />
              <ConsentToggle
                label="Your conversation text"
                detail="Conversation titles, seed text, and questions you ask."
                checked={settings.shareConversationText}
                onChange={(value) => void setSyncPreference('shareConversationText', value)}
              />
              <ConsentToggle
                label="Assistant replies"
                detail="AI responses, kept separate from your own words."
                checked={settings.shareAssistantText}
                onChange={(value) => void setSyncPreference('shareAssistantText', value)}
              />
              <ConsentToggle
                label="Book memory"
                detail="The rolling digest that carries context between chats."
                checked={settings.shareBookMemory}
                onChange={(value) => void setSyncPreference('shareBookMemory', value)}
              />
              <ConsentToggle
                label="Surrounding prose"
                detail="Nearby book text. This remains excluded from the first deployed slice."
                checked={settings.shareSurroundingContext}
                onChange={(value) => void setSyncPreference('shareSurroundingContext', value)}
              />
            </div>
          </fieldset>

          <div className="mt-5 border-t border-stone-800 pt-4">
            <h3 className="text-sm font-medium">Delivery</h3>
            <p className="mt-1 text-xs text-stone-400">
              {outbox.length === 0
                ? 'No queued events.'
                : `${outbox.length} queued: ${outbox.filter((row) => row.status === 'held').length} held, ${outbox.filter((row) => row.status === 'pending').length} pending, ${outbox.filter((row) => row.status === 'rejected').length} rejected.`}
            </p>
            <p className="mt-1 text-xs text-stone-400">
              {syncState?.lastSuccessfulDeliveryAt
                ? `Last delivered ${new Date(syncState.lastSuccessfulDeliveryAt).toLocaleString()}.`
                : 'Nothing has been delivered from this device yet.'}
            </p>
            {syncState?.pausedReason && (
              <p role="status" className="mt-2 rounded-lg bg-amber-950/60 p-3 text-xs text-amber-200">
                {PAUSE_EXPLANATION[syncState.pausedReason]}
              </p>
            )}
            <button
              onClick={() => void sendQueuedEvents()}
              disabled={delivering || !settings.syncEnabled || !settings.syncToken}
              className="mt-2 rounded-lg border border-stone-700 px-3 py-2 text-sm font-medium disabled:opacity-40"
            >
              {delivering ? 'Sending…' : 'Send queued events now'}
            </button>
            {outbox.filter((row) => row.status === 'held').map((row) => (
              <div key={row.eventId} className="mt-3 rounded-lg border border-amber-900/60 p-3">
                <p className="break-all text-xs font-medium text-amber-200">
                  {row.eventType} · {row.eventId}
                </p>
                <p className="mt-1 text-xs text-stone-400">
                  Waiting for its chat turn to finish. If that turn was interrupted, release it
                  so later activity can be delivered.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void releaseHeldEvent(row.eventId)}
                    className="rounded border border-stone-700 px-2 py-1 text-xs"
                  >
                    Release
                  </button>
                  <button
                    onClick={() => void discardOutboxEvent(row.eventId)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-200"
                  >
                    Discard event
                  </button>
                </div>
              </div>
            ))}
            {pendingErrors.map((row) => (
              <div key={row.eventId} className="mt-3 rounded-lg border border-amber-900/60 p-3">
                <p className="break-all text-xs font-medium text-amber-200">
                  {row.eventType} · {row.eventId}
                </p>
                <p className="mt-1 text-xs text-stone-400">
                  Retrying automatically after: {row.lastErrorCode}
                </p>
                <button
                  onClick={() => void discardOutboxEvent(row.eventId)}
                  className="mt-2 rounded border border-red-900 px-2 py-1 text-xs text-red-200"
                >
                  Discard event
                </button>
              </div>
            ))}
            {outbox.filter((row) => row.status === 'rejected').map((row) => (
              <div key={row.eventId} className="mt-3 rounded-lg border border-red-900/60 p-3">
                <p className="break-all text-xs font-medium text-red-200">
                  {row.eventType} · {row.eventId}
                </p>
                <p className="mt-1 text-xs text-stone-400">
                  {row.lastErrorCode ?? 'Rejected without an error code'}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void retryRejectedEvent(row.eventId)}
                    className="rounded border border-stone-700 px-2 py-1 text-xs"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => void discardOutboxEvent(row.eventId)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-200"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>

            <div className="mt-6 rounded-lg border border-red-900/60 p-3">
              <h3 className="text-sm font-medium text-red-200">Delete my cloud data</h3>
              <p className="mt-1 text-sm text-stone-400">
                Turns sync off on this device, empties the queue and the cached insights, and
                asks the cloud to erase everything it holds for you. Your books, highlights, and
                conversations stay on this device. Other devices stop syncing too, and every
                device needs a new sync token afterwards.
              </p>
              {syncState?.activeDeletionRequestId ? (
                <p className="mt-2 break-all text-xs text-stone-400">
                  Requested. Reference {syncState.activeDeletionRequestId}
                  {deletionStatus ? ` · ${deletionStatus}` : ''}
                </p>
              ) : null}
              <div className="mt-2 flex gap-2">
                {confirmingDeletion ? (
                  <>
                    <button
                      onClick={() => void startDeletion()}
                      disabled={deleting}
                      className="rounded border border-red-800 bg-red-950 px-2 py-1 text-xs text-red-100 disabled:opacity-50"
                    >
                      {deleting ? 'Requesting…' : 'Yes, delete everything in the cloud'}
                    </button>
                    <button
                      onClick={() => setConfirmingDeletion(false)}
                      className="rounded border border-stone-700 px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmingDeletion(true)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-200"
                  >
                    {syncState?.activeDeletionRequestId ? 'Retry deletion request' : 'Delete my cloud data'}
                  </button>
                )}
              </div>
              {deletionMessage && (
                <p className="mt-2 text-xs text-stone-400">{deletionMessage}</p>
              )}
            </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold">Data</h2>
          <p className="mt-1 text-sm text-stone-400">
            Everything lives in this browser's IndexedDB. The export is a JSON file containing
            your highlighted passages and the surrounding text, every chat message, and the
            AI's running notes on each book. It does not include your API key, audiobook token,
            or the book files. Treat it as a record of what you read and thought.
          </p>
          <button
            onClick={() => void exportData()}
            className="mt-3 rounded-lg border border-stone-700 px-4 py-2 text-sm font-medium"
          >
            Export highlights and chats
          </button>
        </section>

        <KoreaderImport />

        <section>
          <h2 className="text-sm font-semibold">Feedback</h2>
          <p className="mt-1 text-sm text-stone-400">
            Something broken, or an idea for the app? Open an issue on GitHub.
          </p>
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block rounded-lg border border-stone-700 px-4 py-2 text-sm font-medium"
          >
            Send feedback on GitHub ↗
          </a>
        </section>
      </main>
    </div>
  )
}

function ConsentToggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-amber-500"
      />
      <span>
        <span className="text-sm">{label}</span>
        <span className="block text-xs text-stone-400">{detail}</span>
      </span>
    </label>
  )
}

function ProviderOption({
  value,
  current,
  title,
  detail,
}: {
  value: Provider
  current: Provider
  title: string
  detail: string
}) {
  const selected = current === value

  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
        selected ? 'border-amber-500 bg-stone-900' : 'border-stone-700'
      }`}
    >
      <input
        type="radio"
        name="provider"
        value={value}
        checked={selected}
        onChange={() => void saveSettings({ provider: value })}
        className="mt-0.5 h-4 w-4 accent-amber-500"
      />
      <span>
        <span className="text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-sm text-stone-400">{detail}</span>
      </span>
    </label>
  )
}

async function exportData() {
  const [books, highlights, conversations, messages, bookMemory] = await Promise.all([
    db.books.toArray(),
    db.highlights.toArray(),
    db.conversations.toArray(),
    db.messages.toArray(),
    db.bookMemory.toArray(),
  ])

  const payload = {
    exportedAt: new Date().toISOString(),
    // Blobs are dropped: this is a notes backup, not a library backup.
    books: books.map(({ file: _f, cover: _c, locations: _l, ...rest }) => rest),
    highlights,
    conversations,
    messages,
    bookMemory,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `marginalia-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}
