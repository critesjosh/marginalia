import { useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS, type HighlightColor, type ReaderFont } from '../db/types'
import { BUILD } from '../lib/buildInfo'
import { HIGHLIGHT_COLORS } from '../lib/highlights'
import { READER_FONTS } from '../lib/themes'
import { useIssueUrl } from '../lib/useIssueUrl'
import { telemetry } from '../lib/telemetry'
import { BackIcon } from '../components/Icons'
import InstructionsEditor from '../components/InstructionsEditor'
import KoreaderImport from '../components/KoreaderImport'
import Ornament from '../components/Ornament'
import ReportProblemDialog from '../components/ReportProblemDialog'
import { button, card, iconButton } from '../components/ui'

const ISSUES_URL = 'https://github.com/critesjosh/marginalia/issues'
const DISCUSSIONS_URL = 'https://github.com/critesjosh/marginalia/discussions'
const CONTACT_EMAIL = 'rami@agenticpossible.com'

export default function SettingsPage() {
  const issueUrl = useIssueUrl(ISSUES_URL)
  const stored = useLiveQuery(() => getSettings(), [])
  const settings = stored ?? DEFAULT_SETTINGS
  const [reporting, setReporting] = useState(false)

  return (
    <div className="paper-grain min-h-full bg-paper text-ink">
      <header className="pt-safe sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-2">
          <Link to="/" aria-label="Back to library" className={iconButton}>
            <BackIcon />
          </Link>
          <h1 className="font-book text-heading font-medium">Settings</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-8">
        <section className={card}>
          <h2 className="font-book text-heading font-medium">How Rami works</h2>
          <Link to="/help" className={`${button.secondary} mt-3`}>
            Read the guide
          </Link>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Standing instructions</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Sent with every message. Each book can add its own on its Memory tab.
          </p>
          <InstructionsEditor
            stored={settings.instructions}
            label="Standing instructions"
            placeholder="For example: Call me Sam, and work in a little Latin so I can start learning it."
            onSave={(instructions) => saveSettings({ instructions })}
          />
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Data</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Highlights, threads and Rami's notes as JSON. Book files are not included.
          </p>
          <button onClick={() => void exportData()} className={`${button.secondary} mt-3`}>
            Export highlights and chats
          </button>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Feedback and community</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            New issues include the app version, your browser and recent storage errors, never books
            or notes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={DISCUSSIONS_URL} target="_blank" rel="noreferrer" className={button.secondary}>
              Join the discussion ↗
            </a>
            <button onClick={() => setReporting(true)} className={button.secondary}>
              Report a problem
            </button>
            <a href={issueUrl} target="_blank" rel="noreferrer" className={button.secondary}>
              Open an issue ↗
            </a>
            <a href={`mailto:${CONTACT_EMAIL}`} className={button.secondary}>
              Email Rami
            </a>
          </div>
        </section>

        <Ornament short />

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Reading font</h2>
          <div role="radiogroup" aria-label="Reading font" className="mt-3 space-y-2">
            {(Object.keys(READER_FONTS) as ReaderFont[]).map((font) => (
              <FontOption key={font} value={font} current={settings.readerFont} />
            ))}
          </div>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Highlight color</h2>
          <div role="radiogroup" aria-label="Highlight color" className="mt-3 flex gap-2">
            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => {
              const selected = settings.highlightColor === color
              return (
                <button
                  key={color}
                  role="radio"
                  aria-checked={selected}
                  aria-label={color}
                  onClick={() => void saveSettings({ highlightColor: color })}
                  className={`grid h-11 w-11 place-items-center rounded-full border-2 transition ${
                    selected ? 'border-moss' : 'border-transparent'
                  }`}
                >
                  <span
                    style={{ background: HIGHLIGHT_COLORS[color] }}
                    className="block h-8 w-8 rounded-full ring-1 ring-ink/15"
                  />
                </button>
              )
            })}
          </div>
        </section>

        <section className={`${card} space-y-4`}>
          <Toggle
            label="Brief replies"
            note="A few sentences instead of a few paragraphs, unless you ask for more."
            checked={settings.briefReplies ?? false}
            onChange={(briefReplies) => void saveSettings({ briefReplies })}
          />
          <Toggle
            label="Avoid spoilers"
            note="Nothing past where you are, unless you ask."
            checked={settings.spoilerGuard}
            onChange={(spoilerGuard) => void saveSettings({ spoilerGuard })}
          />
        </section>

        <Ornament short />

        <KoreaderImport />

        <UsageDataSection />

        <p className="text-center font-ui text-meta text-ink-faint">
          Version{' '}
          {BUILD.url ? (
            <a href={BUILD.url} target="_blank" rel="noreferrer" className="underline">
              {BUILD.label}
            </a>
          ) : (
            BUILD.label
          )}
          {' · '}
          <Link to="/privacy" className="underline">
            Privacy policy
          </Link>
        </p>
      </main>

      {reporting && <ReportProblemDialog onClose={() => setReporting(false)} />}
    </div>
  )
}

function UsageDataSection() {
  const preference = useSyncExternalStore(telemetry.subscribe, telemetry.preference)
  const configured = useSyncExternalStore(telemetry.subscribe, telemetry.configured)

  return (
    <section className={card}>
      <h2 className="font-book text-heading font-medium">Usage data</h2>
      {configured ? (
        <div className="mt-3">
          <Toggle
            label="Share anonymous usage data"
            note="Counts of actions and error types. Never titles, text, notes, chats or links."
            checked={preference === 'on'}
            onChange={(on) => telemetry.setPreference(on ? 'on' : 'off')}
          />
        </div>
      ) : (
        <p className="mt-1 font-ui text-body text-ink-soft">
          This copy of Rami sends no usage data.
        </p>
      )}
    </section>
  )
}

function Toggle({
  label,
  note,
  checked,
  onChange,
}: {
  label: string
  note: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-moss"
      />
      <span>
        <span className="font-ui text-label font-medium">{label}</span>
        <span className="mt-0.5 block font-ui text-meta text-ink-soft">{note}</span>
      </span>
    </label>
  )
}

function FontOption({ value, current }: { value: ReaderFont; current: ReaderFont }) {
  const selected = current === value
  const { label, stack, weight } = READER_FONTS[value]

  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors duration-150 ${
        selected ? 'border-moss bg-paper' : 'border-rule hover:bg-paper-sunk'
      }`}
    >
      <input
        type="radio"
        name="reader-font"
        value={value}
        checked={selected}
        onChange={() => void saveSettings({ readerFont: value })}
        className="mt-1 h-4 w-4 accent-moss"
      />
      <span>
        <span className="font-ui text-label font-medium">{label}</span>
        <span
          style={{ fontFamily: stack, fontWeight: weight }}
          className="mt-0.5 block text-reading"
        >
          Call me Ishmael. <em>Some years ago, never mind how long precisely.</em>
        </span>
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
    // Blobs are dropped: this is a notes backup, not a library backup. A shared
    // backup must not let its reader take over a published link either.
    books: books.map(({ file: _f, cover: _c, locations: _l, sharedLink, ...rest }) =>
      sharedLink ? { ...rest, sharedLink: { ...sharedLink, ownerToken: undefined } } : rest,
    ),
    highlights,
    // A shared backup must not let its reader take over a published link.
    conversations: conversations.map(({ published, ...rest }) =>
      published ? { ...rest, published: { ...published, ownerToken: undefined } } : rest,
    ),
    messages,
    bookMemory,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `rami-backup-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}
