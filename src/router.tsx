import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'

// epub.js and JSZip account for most of the bundle and are only needed once a
// book is open, so everything past the library loads on demand.
const ReaderPage = lazy(() => import('./pages/ReaderPage'))
const ChatsPage = lazy(() => import('./pages/ChatsPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const InsightsPage = lazy(() => import('./pages/InsightsPage'))

function Deferred({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-stone-950 text-sm text-stone-500">
          Loading…
        </div>
      }
    >
      {children}
    </Suspense>
  )
}

export const router = createBrowserRouter([
  { path: '/', element: <LibraryPage /> },
  {
    path: '/book/:bookId',
    element: (
      <Deferred>
        <ReaderPage />
      </Deferred>
    ),
  },
  {
    path: '/book/:bookId/chats',
    element: (
      <Deferred>
        <ChatsPage />
      </Deferred>
    ),
  },
  {
    path: '/insights',
    element: (
      <Deferred>
        <InsightsPage />
      </Deferred>
    ),
  },
  {
    path: '/settings',
    element: (
      <Deferred>
        <SettingsPage />
      </Deferred>
    ),
  },
])
