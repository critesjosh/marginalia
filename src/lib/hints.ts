import { useCallback, useEffect, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSettings, markHintSeen } from '../db/db'
import type { Hint } from '../db/types'

/** The hints already shown, or undefined until settings load. */
export function useSeenHints(): Hint[] | undefined {
  return useLiveQuery(() => getSettings().then((settings) => settings.seenHints ?? []), [])
}

/**
 * Whether the reader has yet to see `hint`. False until settings load, so a
 * returning reader never sees one flash past.
 */
export function useUnseenHint(hint: Hint): boolean {
  const seen = useSeenHints()
  return seen !== undefined && !seen.includes(hint)
}

/**
 * Gives a shown note one appearance: once it has been on screen, leaving the
 * place it appeared retires it. A note that stayed below the fold is kept for
 * next time. Pass the returned callback to the note's `onSeen`.
 */
export function useRetireOnceSeen(hint: Hint, shown: boolean): () => void {
  const seen = useRef(false)
  useEffect(() => {
    if (!shown) return
    const flag = seen
    return () => {
      if (flag.current) void markHintSeen(hint)
    }
  }, [hint, shown])
  return useCallback(() => {
    seen.current = true
  }, [])
}
