import { createBrowserRouter } from 'react-router-dom'
import { AppNotFoundPage, RouteErrorPage } from './components/AppErrorBoundary'
import Deferred from './components/Deferred'
import LibraryPage from './pages/LibraryPage'
import { AddSharedPage, ChatsPage, ReaderPage, SettingsPage } from './pages/LazyPages'

// epub.js and JSZip account for most of the bundle and are only needed once a
// book is open, so everything past the library loads on demand.
export const router = createBrowserRouter([
  { path: '/', element: <LibraryPage />, errorElement: <RouteErrorPage /> },
  {
    path: '/add',
    element: (
      <Deferred>
        <AddSharedPage />
      </Deferred>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/b/:linkId',
    element: (
      <Deferred>
        <AddSharedPage />
      </Deferred>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/book/:bookId',
    element: (
      <Deferred>
        <ReaderPage />
      </Deferred>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/book/:bookId/chats',
    element: (
      <Deferred>
        <ChatsPage />
      </Deferred>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/settings',
    element: (
      <Deferred>
        <SettingsPage />
      </Deferred>
    ),
    errorElement: <RouteErrorPage />,
  },
  { path: '*', element: <AppNotFoundPage /> },
])
