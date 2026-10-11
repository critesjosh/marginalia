import { Component, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Wordmark from './Wordmark'
import { button } from './ui'

export function AppErrorPage() {
  return (
    <main className="paper-grain flex min-h-full flex-col items-center justify-center bg-paper px-6 text-center text-ink">
      <Wordmark size={28} />
      <h1 className="mt-8 font-book text-title">Rami couldn’t open this page</h1>
      <p className="mt-3 max-w-md font-ui text-body text-ink-soft">
        The app may have updated while it was open, or lost its connection. Check your connection,
        then reload.
      </p>
      <button className={`${button.primary} mt-8`} onClick={() => window.location.reload()}>
        Reload Rami
      </button>
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
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? <AppErrorPage /> : this.props.children
  }
}
