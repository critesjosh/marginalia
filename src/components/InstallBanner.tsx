import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  currentInstallContext,
  dismissInstall,
  installOffer,
  promptInstall,
  subscribeInstallPrompt,
} from '../lib/install'
import { telemetry } from '../lib/telemetry'
import Mark from './Mark'
import { CloseIcon } from './Icons'
import { button, iconButton } from './ui'

/** A quiet bar at the foot of the library offering to keep Rami on the home screen. */
export default function InstallBanner() {
  const [offer, setOffer] = useState(() => installOffer(currentInstallContext()))

  useEffect(() => {
    const refresh = () => setOffer(installOffer(currentInstallContext()))
    const unsubscribe = subscribeInstallPrompt(refresh)
    // The prompt may have arrived between the first render and subscribing.
    refresh()
    return unsubscribe
  }, [])

  // The usage-data notice takes the same spot; one bar at a time.
  const notice = useSyncExternalStore(telemetry.subscribe, telemetry.notice)
  if (!offer || notice) return null

  return (
    <>
      {/* Room to scroll the footer out from under the bar. */}
      <div aria-hidden className="h-28" />
      <aside aria-label="Install Rami" className="pb-safe fixed inset-x-0 bottom-0 z-10 px-4">
        <div className="mx-auto mb-4 flex max-w-[560px] items-center gap-3 rounded-lg border border-rule bg-paper-leaf py-3 pr-2 pl-4 shadow-sheet">
          <Mark size={24} decorative />
          <div className="min-w-0 flex-1 font-ui">
            <p className="text-label font-medium text-ink">Keep Rami on your home screen</p>
            <p className="text-meta text-ink-soft">
              {offer === 'ios'
                ? 'Tap Share, then “Add to Home Screen.”'
                : 'It opens like an app and reads offline.'}
            </p>
          </div>
          {offer === 'prompt' && (
            <button onClick={() => void promptInstall()} className={button.secondary}>
              Install
            </button>
          )}
          <button onClick={() => dismissInstall()} aria-label="Not now" className={iconButton}>
            <CloseIcon />
          </button>
        </div>
      </aside>
    </>
  )
}
