import { useState, useSyncExternalStore } from 'react'
import { useModal } from '../lib/useModal'
import { telemetry } from '../lib/telemetry'
import { MAX_FEEDBACK_LENGTH } from '../../shared/telemetrySchema'
import { button } from './ui'

const ISSUES_URL = 'https://github.com/critesjosh/marginalia/issues/new'

/**
 * Report a problem: an optional note plus the reference of the last error on
 * this page load. Nothing is sent until the reader presses Send. A deployment
 * without telemetry points to GitHub issues instead.
 */
export default function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose)
  const configured = useSyncExternalStore(telemetry.subscribe, telemetry.configured)
  const lastError = telemetry.lastError()
  const [note, setNote] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  const sent = state === 'sent'
  const canSend = !sent && configured

  async function send() {
    setState('sending')
    const ok = await telemetry.report({ feedback: note, error: lastError })
    setState(ok ? 'sent' : 'failed')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-problem-title"
        className="w-full max-w-md rounded-lg border border-rule bg-paper-leaf p-6 text-ink shadow-sheet"
      >
        <h2 id="report-problem-title" className="font-book text-heading font-medium">
          Report a problem
        </h2>

        {sent && (
          <p className="mt-3 font-ui text-body text-ink-soft" role="status">
            Thanks. Your report was sent
            {lastError ? ` with reference ${lastError.ref}` : ''}.
          </p>
        )}
        {canSend && (
          <>
            <p className="mt-1 font-ui text-body text-ink-soft">
              Tell us what went wrong, if you like.
            </p>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              maxLength={MAX_FEEDBACK_LENGTH}
              aria-label="What went wrong (optional)"
              placeholder="What were you doing when it happened?"
              className="mt-3 w-full resize-y rounded-md border border-rule-strong bg-paper-leaf p-3 font-ui text-body text-ink placeholder:text-ink-faint"
            />
            <p className="mt-2 font-ui text-meta text-ink-faint">
              {lastError
                ? `Includes error reference ${lastError.ref} (${lastError.feature}, ${lastError.category}) and this app’s version.`
                : 'Includes this app’s version and browser family.'}{' '}
              It is sent even if usage data is off, because you chose to send it.
            </p>
            {state === 'failed' && (
              <p className="mt-2 font-ui text-meta text-danger" role="alert">
                Could not send the report. Check your connection and try again.
              </p>
            )}
          </>
        )}
        {!configured && (
          <p className="mt-3 font-ui text-body text-ink-soft">
            This copy of Rami doesn’t send reports. Open an issue on GitHub instead
            {lastError ? `, and mention reference ${lastError.ref}` : ''}.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className={button.secondary}>
            {sent ? 'Close' : 'Cancel'}
          </button>
          {canSend && (
            <button
              onClick={() => void send()}
              disabled={state === 'sending'}
              className={button.primary}
            >
              {state === 'sending' ? 'Sending…' : 'Send report'}
            </button>
          )}
          {!configured && (
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={button.primary}>
              Open an issue ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
