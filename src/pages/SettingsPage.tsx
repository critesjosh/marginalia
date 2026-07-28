import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS } from '../db/types'
import { verifyKey } from '../lib/openai'
import { BackIcon } from '../components/Icons'

const MODELS = [
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini — fast and cheap' },
  { value: 'gpt-4o', label: 'gpt-4o — stronger, pricier' },
]

export default function SettingsPage() {
  const stored = useLiveQuery(() => getSettings(), [])
  const [apiKey, setApiKey] = useState('')
  const [dirtyKey, setDirtyKey] = useState(false)
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState<string>()

  const settings = stored ?? DEFAULT_SETTINGS

  useEffect(() => {
    if (stored && !dirtyKey) setApiKey(stored.apiKey ?? '')
  }, [stored, dirtyKey])

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
          <h2 className="text-sm font-semibold">OpenAI API key</h2>
          <p className="mt-1 text-sm text-stone-400">
            Stored only in this browser and sent only to api.openai.com. This is a single-user
            tool; don't use it on a shared device.
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
          <h2 className="text-sm font-semibold">Chat model</h2>
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

          <h2 className="mt-5 text-sm font-semibold">Summary model</h2>
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
            Everything lives in this browser's IndexedDB. Export keeps a JSON backup of your
            highlights and conversations (books themselves are not included).
          </p>
          <button
            onClick={() => void exportData()}
            className="mt-3 rounded-lg border border-stone-700 px-4 py-2 text-sm font-medium"
          >
            Export highlights and chats
          </button>
        </section>
      </main>
    </div>
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
