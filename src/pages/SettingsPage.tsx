import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS, type Provider } from '../db/types'
import { HOSTED_MODEL_LABEL, verifyKey } from '../lib/inference'
import { createAudiobookSession } from '../lib/audiobooks'
import { BackIcon } from '../components/Icons'
import KoreaderImport from '../components/KoreaderImport'

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

  const settings = stored ?? DEFAULT_SETTINGS

  useEffect(() => {
    if (stored && !dirtyKey) setApiKey(stored.apiKey ?? '')
  }, [stored, dirtyKey])

  useEffect(() => {
    if (stored && !dirtyAudiobookToken) {
      setAudiobookToken(stored.audiobookAccessToken ?? '')
    }
  }, [stored, dirtyAudiobookToken])

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
