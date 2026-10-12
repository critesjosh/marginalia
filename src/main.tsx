import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './index.css'
import AppErrorBoundary from './components/AppErrorBoundary'
import UsageDataNotice from './components/UsageDataNotice'
import { noteBuild } from './lib/diagnostics'
import { listenForInstallPrompt } from './lib/install'
import { shouldReloadForPreloadError } from './lib/preloadRecovery'
import { installTelemetry } from './lib/telemetry'
import { router } from './router'

listenForInstallPrompt()
noteBuild()
installTelemetry()

window.addEventListener('vite:preloadError', (event) => {
  if (!navigator.onLine) return
  const error = (event as Event & { payload?: unknown }).payload
  let storage: Storage
  try {
    storage = window.sessionStorage
  } catch {
    return
  }
  if (!shouldReloadForPreloadError(error, storage, import.meta.env.APP_BUILT_AT as string)) return
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <RouterProvider router={router} />
      {/* Outside the routes, so a visitor who lands on any page sees it. */}
      <UsageDataNotice />
    </AppErrorBoundary>
  </StrictMode>,
)
