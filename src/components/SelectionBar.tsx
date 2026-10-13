import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { SelectionRect } from '../lib/highlights'
import { TAP_TURN_ZONE, type PageDirection } from '../lib/selectionEdge'
import type { ShareOutcome } from '../lib/share'
import { ChatIcon, ShareIcon, TrashIcon } from './Icons'
import { button, iconButton } from './ui'

const BAR_HEIGHT = 70
/** How long "Copied" shows before the bar closes. */
const COPIED_MS = 1200

export default function SelectionBar({
  rect,
  existing,
  onChat,
  onShare,
  onDelete,
  onDismiss,
  onTurn,
  page,
}: {
  rect: SelectionRect
  /** Set when the bar was opened by tapping an existing highlight. */
  existing?: boolean
  onChat: () => void
  /** Shares the passage; the bar closes once it has gone somewhere. */
  onShare: () => Promise<ShareOutcome>
  onDelete?: () => void
  onDismiss: () => void
  /** Turns the page from a tap at a page edge, keeping the selection while any of it shows. */
  onTurn?: (direction: PageDirection) => void
  /** The reader's page, which edge taps are measured against; it is centered and capped on wide screens. */
  page?: HTMLElement | null
}) {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  async function share() {
    const outcome = await onShare()
    if (outcome === 'shared') onDismiss()
    if (outcome !== 'copied') return
    setCopied(true)
    copiedTimer.current = setTimeout(onDismiss, COPIED_MS)
  }

  // Prefer sitting above the selection; drop below when it would clip the top.
  const above = rect.top > BAR_HEIGHT + 60
  const top = above ? rect.top - BAR_HEIGHT - 8 : rect.bottom + 12
  // A selection filling the page leaves no room either side; stay on screen.
  const clamped = Math.min(Math.max(8, top), window.innerHeight - BAR_HEIGHT - 8)

  // A bar opened by a tap on a highlight appears under the finger before the
  // touch ends, and the browser then sends that touch's click to the backdrop
  // (#145). Only a press that began on the backdrop may answer it.
  const pressedBackdrop = useRef(false)

  // The backdrop covers the book, so it answers the page-edge taps the book
  // would, keeping a selection that runs onto the new page. It still blocks
  // gestures on the book, so a selection is extended across a page by
  // dragging it to the edge instead.
  const onBackdrop = (event: MouseEvent) => {
    const pressed = pressedBackdrop.current
    pressedBackdrop.current = false
    if (!pressed) return
    const bounds = page?.getBoundingClientRect() ?? { left: 0, width: window.innerWidth }
    const x = (event.clientX - bounds.left) / bounds.width
    if (onTurn && x < TAP_TURN_ZONE) onTurn('prev')
    else if (onTurn && x > 1 - TAP_TURN_ZONE) onTurn('next')
    else onDismiss()
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onPointerDown={() => {
          pressedBackdrop.current = true
        }}
        onClick={onBackdrop}
        aria-hidden
      />
      <div
        role="toolbar"
        aria-label="Selection actions"
        style={{ top: clamped }}
        className="no-select fixed inset-x-3 z-50 mx-auto flex max-w-[420px] items-center gap-2 rounded-lg border border-rule bg-paper-leaf p-3 text-ink shadow-sheet"
      >
        {existing && onDelete && (
          <button
            onClick={onDelete}
            aria-label="Delete highlight"
            className={`${iconButton} border border-rule-strong`}
          >
            <TrashIcon />
          </button>
        )}
        <button onClick={onChat} className={`${button.primary} flex-1`}>
          <ChatIcon />
          Ask about this
        </button>
        <button onClick={() => void share()} className={button.secondary}>
          <ShareIcon />
          <span aria-live="polite">{copied ? 'Copied' : 'Share'}</span>
        </button>
      </div>
    </>
  )
}
