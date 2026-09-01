import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './index.css'
import { router } from './router'
import { startDeliveryLoop } from './sync/scheduler'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

// Outside the tree, so a re-render never restarts it and reading never waits
// on it. It does nothing at all until the reader turns sync on.
startDeliveryLoop()
