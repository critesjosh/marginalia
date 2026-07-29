import type { HighlightColor, ReaderTheme } from '../db/types'
import { HIGHLIGHT_COLORS, type SelectionRect } from '../lib/highlights'
import { THEMES } from '../lib/themes'
import { ChatIcon, TrashIcon } from './Icons'

const BAR_HEIGHT = 92

export default function SelectionBar({
  rect,
  theme,
  existing,
  onHighlight,
  onChat,
  onCopy,
  onDelete,
  onDismiss,
}: {
  rect: SelectionRect
  theme: ReaderTheme
  /** Set when the bar was opened by tapping an existing highlight. */
  existing?: boolean
  onHighlight: (color: HighlightColor) => void
  onChat: () => void
  onCopy: () => void
  onDelete?: () => void
  onDismiss: () => void
}) {
  const palette = THEMES[theme]

  // Prefer sitting above the selection; drop below when it would clip the top.
  const above = rect.top > BAR_HEIGHT + 60
  const top = above ? rect.top - BAR_HEIGHT - 8 : rect.bottom + 12

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onDismiss} aria-hidden />
      <div
        role="toolbar"
        aria-label="Selection actions"
        style={{ top: Math.max(8, top) }}
        className={`no-select fixed inset-x-3 z-50 rounded-xl border shadow-2xl shadow-black/40 ${palette.chrome} ${palette.chromeText} ${palette.border}`}
      >
        <div className="flex items-center gap-1.5 px-3 pt-3">
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((color) => (
            <button
              key={color}
              onClick={() => onHighlight(color)}
              aria-label={`Highlight ${color}`}
              className="flex h-11 w-11 items-center justify-center rounded-full"
            >
              {/* The swatch stays 32px; the button around it meets the 44px
                  minimum touch target. */}
              <span
                style={{ background: HIGHLIGHT_COLORS[color] }}
                className="block h-8 w-8 rounded-full ring-1 ring-black/20"
              />
            </button>
          ))}
          <div className="flex-1" />
          {existing && onDelete && (
            <button
              onClick={onDelete}
              aria-label="Delete highlight"
              className="flex h-11 w-11 items-center justify-center rounded-lg opacity-70"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 p-3">
          <button
            onClick={onChat}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-500 py-2.5 text-sm font-medium text-stone-950"
          >
            <ChatIcon className="h-4 w-4" />
            Chat about this
          </button>
          <button
            onClick={onCopy}
            className={`rounded-lg border px-3.5 py-2.5 text-sm font-medium ${palette.border}`}
          >
            Copy
          </button>
        </div>
      </div>
    </>
  )
}
