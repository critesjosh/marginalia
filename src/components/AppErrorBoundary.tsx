import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Link, useRouteError } from 'react-router-dom'
import { telemetry } from '../lib/telemetry'
import ReportProblemDialog from './ReportProblemDialog'
import Wordmark from './Wordmark'
import { button } from './ui'

/** Route errors, so each is recorded once even when StrictMode renders twice. */
const recorded = new WeakSet<object>()

export function RouteErrorPage() {
  const error = useRouteError()
  if (typeof error === 'object' && error && !recorded.has(error)) {
    recorded.add(error)
    telemetry.captureError('app', 'render', error)
  }
  return <AppErrorPage reference={telemetry.lastError()?.ref} />
}

function AppErrorPage({ reference }: { reference?: string }) {
  const [reporting, setReporting] = useState(false)

  return (
    <main className="paper-grain flex min-h-full flex-col items-center justify-center bg-paper px-6 text-center text-ink">
      <Wordmark size={28} />
      <h1 className="mt-8 font-book text-title">Rami couldn’t open this page</h1>
      <p className="mt-3 max-w-md font-ui text-body text-ink-soft">
        The app may have updated while it was open, or lost its connection. Check your connection,
        then reload.
      </p>
      {reference && <p className="mt-3 font-ui text-meta text-ink-faint">Reference {reference}</p>}
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <button className={button.primary} onClick={() => window.location.reload()}>
          Reload Rami
        </button>
        <button className={button.secondary} onClick={() => setReporting(true)}>
          Report a problem
        </button>
      </div>
      {reporting && <ReportProblemDialog onClose={() => setReporting(false)} />}
    </main>
  )
}

export function AppNotFoundPage() {
  return (
    <main className="paper-grain flex min-h-full flex-col items-center justify-center bg-paper px-6 text-center text-ink">
      <Wordmark size={28} />
      <h1 className="mt-8 font-book text-title">This page isn’t on the shelf</h1>
      <Link className={`${button.secondary} mt-8`} to="/">
        Return to your library
      </Link>
    </main>
  )
}

export default class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; reference?: string }
> {
  state: { failed: boolean; reference?: string } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  // The fallback renders before this runs, so the reference arrives as a rerender.
  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.setState({ reference: telemetry.captureError('app', 'render', error) })
  }

  render(): ReactNode {
    return this.state.failed ? (
      <AppErrorPage reference={this.state.reference} />
    ) : (
      this.props.children
    )
  }
}
