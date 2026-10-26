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
import LocalAgentSection from '../components/LocalAgentSection'
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
          <p className="mt-1 font-ui text-body text-ink-soft">
            Asking about a passage, turning pages, memory, sharing and your library, in one place.
          </p>
          <Link to="/help" className={`${button.secondary} mt-3`}>
            Read the guide
          </Link>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Standing instructions</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Sent with every message about every book. Tell Rami what to call you, how to answer, or
            anything else it should always do. Each book can add its own on its Memory tab.
          </p>
          <InstructionsEditor
            stored={settings.instructions}
            label="Standing instructions"
            placeholder="For example: Call me Sam, and work in a little Latin so I can start learning it."
            onSave={(instructions) => saveSettings({ instructions })}
          />
        </section>

        <LocalAgentSection />

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Data</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Everything lives in this browser's IndexedDB. The export is a JSON file containing your
            highlighted passages and the surrounding text, every thread, and Rami's running notes on
            each book. It does not include the book files. Treat it as a record of what you read and
            thought.
          </p>
          <button onClick={() => void exportData()} className={`${button.secondary} mt-3`}>
            Export highlights and chats
          </button>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Feedback and community</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Share an idea or wander through other readers’ questions in the discussions. Something
            broken? Report a problem or open an issue. Anything else, write to {CONTACT_EMAIL}.
          </p>
          <p className="mt-2 font-ui text-meta text-ink-faint">
            A new issue starts with this app’s version, your browser, and a short log of storage
            problems on this device. It names no books or notes, and you can edit it before
            submitting.
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
          <p className="mt-1 font-ui text-body text-ink-soft">
            Used for the book's text in the reader.
          </p>
          <div role="radiogroup" aria-label="Reading font" className="mt-3 space-y-2">
            {(Object.keys(READER_FONTS) as ReaderFont[]).map((font) => (
              <FontOption key={font} value={font} current={settings.readerFont} />
            ))}
          </div>
        </section>

        <section className={card}>
          <h2 className="font-book text-heading font-medium">Highlight color</h2>
          <p className="mt-1 font-ui text-body text-ink-soft">
            Used for every highlight, old and new.
          </p>
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

        <section className={card}>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={settings.spoilerGuard}
              onChange={(e) => void saveSettings({ spoilerGuard: e.target.checked })}
              className="mt-1 h-4 w-4 accent-moss"
            />
            <span>
              <span className="font-ui text-label font-medium">Avoid spoilers</span>
              <span className="mt-0.5 block font-ui text-meta text-ink-soft">
                Ask the model not to reveal anything past your current position unless you ask.
              </span>
            </span>
          </label>
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
        <label className="mt-3 flex items-start gap-3">
          <input
            type="checkbox"
            checked={preference === 'on'}
            onChange={(e) => telemetry.setPreference(e.target.checked ? 'on' : 'off')}
            className="mt-1 h-4 w-4 accent-moss"
          />
          <span>
            <span className="font-ui text-label font-medium">Share anonymous usage data</span>
            <span className="mt-0.5 block font-ui text-meta text-ink-soft">
              Counts of actions like opening a book or asking Rami, and error types, so we can see
              what breaks. Never book titles, text, highlights, notes, chats, or links. No cookies,
              and no id that outlasts this tab.
            </span>
          </span>
        </label>
      ) : (
        <p className="mt-1 font-ui text-body text-ink-soft">
          This copy of Rami sends no usage data.
        </p>
      )}
      <Link to="/privacy" className={`${button.quiet} mt-2 -ml-3`}>
        How Rami handles your data
      </Link>
    </section>
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
