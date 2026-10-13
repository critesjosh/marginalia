import { useLiveQuery } from 'dexie-react-hooks'
import { getSettings } from '../db/db'
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
