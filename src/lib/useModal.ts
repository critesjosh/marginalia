import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal behaviour for a sheet, drawer or confirmation.
 *
 * Escape closes, focus moves inside on open, Tab stays within, and focus returns
 * to whatever opened it. Without this a keyboard or screen-reader user tabs
 * straight out of the visible surface and into the obscured page behind it,
 * including the book iframe, with nothing announcing that they left.
 */
export function useModal<T extends HTMLElement>(
  onClose: () => void,
  /** Selector for the control that should take focus, if not the first one. */
  initialFocus?: string,
) {
  const ref = useRef<T>(null)

  // Read through a ref so a caller passing an inline arrow does not re-run the
  // effect on every render and steal focus back mid-interaction.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const container = ref.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusable = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]

    const preferred = initialFocus
      ? container.querySelector<HTMLElement>(initialFocus)
      : undefined
    const first = preferred ?? focusable()[0]
    if (first) {
      first.focus()
    } else {
      container.tabIndex = -1
      container.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const items = focusable()
      if (items.length === 0) return

      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === firstItem || !container.contains(active))) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Restore focus unless it has genuinely moved somewhere else. By the time
      // this runs the focused child is usually already detached, so the browser
      // has reset activeElement to <body>; that still counts as "nothing else
      // claimed it" and must not be mistaken for the user moving on.
      const active = document.activeElement
      const stranded = !active || active === document.body || container.contains(active)
      if (stranded) previouslyFocused?.focus?.()
    }
    // `initialFocus` is a literal at every call site, so this never re-runs and
    // never steals focus back mid-interaction.
  }, [initialFocus])

  return ref
}
