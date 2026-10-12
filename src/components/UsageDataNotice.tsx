import { useSyncExternalStore } from 'react'
import { telemetry } from '../lib/telemetry'
import { button } from './ui'

const COPY = {
  ask: { title: 'Help improve Rami?', decline: 'No thanks', accept: 'Share usage data' },
  inform: { title: 'Rami counts anonymous usage', decline: 'Turn off', accept: 'OK' },
}

/**
 * Shown once, until the reader chooses (decision 0008). Where consent is
 * needed it asks, with declining as easy as accepting; elsewhere it says data
 * is on and offers the way to turn it off.
 */
export default function UsageDataNotice() {
  const notice = useSyncExternalStore(telemetry.subscribe, telemetry.notice)
  if (!notice) return null
  const copy = COPY[notice]

  return (
    <aside
      aria-label="Usage data"
      className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-rule bg-paper-leaf p-4"
    >
      <div className="min-w-0 flex-1 basis-64 font-ui">
        <p className="text-label font-medium text-ink">{copy.title}</p>
        <p className="text-meta text-ink-soft">
          Counts of actions like opening a book or asking Rami, and error types, sent to PostHog.
          Never titles, text, notes, chats, or links, and no id that outlasts this page. You can
          change this in Settings.
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => telemetry.setPreference('off')} className={button.secondary}>
          {copy.decline}
        </button>
        <button onClick={() => telemetry.setPreference('on')} className={button.secondary}>
          {copy.accept}
        </button>
      </div>
    </aside>
  )
}
