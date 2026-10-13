import { useEffect, useRef } from 'react'
import { CloseIcon } from './Icons'
import { iconButton } from './ui'

/** How much of a note must be on screen for it to count as seen. */
const SEEN_RATIO = 0.5

/** A one-time aside inside a panel, set apart from the conversation it sits in. */
export default function HintNote({
  label,
  onDismiss,
  onSeen,
  children,
}: {
  /** Names the note for the dismiss button. */
  label: string
  onDismiss: () => void
  /** Called once, when at least half the note has been on screen. */
  onSeen?: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const note = ref.current
    if (!note || !onSeen) return
    // A null root still clips by every scrolling ancestor, so a note below a
    // sheet's fold does not count.
    const observer = new IntersectionObserver(
      ([entry]) => {
        // The first entry is delivered whatever the ratio, so check it here.
        if (!entry?.isIntersecting || entry.intersectionRatio < SEEN_RATIO) return
        onSeen()
        observer.disconnect()
      },
      { threshold: SEEN_RATIO },
    )
    observer.observe(note)
    return () => observer.disconnect()
  }, [onSeen])

  return (
    <aside
      ref={ref}
      aria-label={label}
      className="flex items-start gap-1 rounded-md border border-rule py-1 pr-1 pl-3.5 font-ui text-meta text-ink-soft"
    >
      <div className="min-w-0 flex-1 py-2">{children}</div>
      <button onClick={onDismiss} aria-label={`Dismiss: ${label}`} className={iconButton}>
        <CloseIcon />
      </button>
    </aside>
  )
}
