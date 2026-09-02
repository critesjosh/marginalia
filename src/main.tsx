import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './index.css'
import { router } from './router'
import { startDeliveryLoop } from './sync/scheduler'
import { recoverHeldQuestions } from './sync/delivery'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

// Outside the tree, so a re-render never restarts it and reading never waits
// on it. Recover a question whose answer was interrupted before delivery starts:
// a held head row otherwise blocks every later sequence indefinitely.
void recoverHeldQuestions()
  .catch(() => {
    // IndexedDB failures surface through the existing Settings diagnostics.
  })
  .finally(() => startDeliveryLoop())
