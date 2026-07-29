import type { ReaderTheme } from '../db/types'
import { THEMES } from '../lib/themes'
import { useModal } from '../lib/useModal'

const THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
]

const MIN_FONT = 80
const MAX_FONT = 180

export default function DisplaySheet({
  theme,
  fontSize,
  onChange,
  onClose,
}: {
  theme: ReaderTheme
  fontSize: number
  onChange: (patch: { theme?: ReaderTheme; fontSize?: number }) => void
  onClose: () => void
}) {
  const palette = THEMES[theme]
  const ref = useModal<HTMLDivElement>(onClose)

  return (
    <div className="fixed inset-0 z-40 flex items-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Display settings"
        className={`pb-safe relative w-full rounded-t-2xl border-t px-5 pt-5 ${palette.chrome} ${palette.chromeText} ${palette.border} shadow-2xl`}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-current opacity-20" />

        <p className="mb-2 text-xs font-semibold tracking-wide uppercase opacity-50">Theme</p>
        <div className="mb-5 grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => onChange({ theme: option.value })}
              style={{
                background: THEMES[option.value].bg,
                color: THEMES[option.value].fg,
                borderColor: option.value === theme ? palette.link : 'transparent',
              }}
              className="rounded-lg border-2 py-3 text-sm font-medium"
            >
              {option.label}
            </button>
          ))}
        </div>

        <p className="mb-2 text-xs font-semibold tracking-wide uppercase opacity-50">
          Text size
        </p>
        <div className="mb-5 flex items-center gap-3">
          <button
            onClick={() => onChange({ fontSize: Math.max(MIN_FONT, fontSize - 10) })}
            disabled={fontSize <= MIN_FONT}
            aria-label="Smaller text"
            className={`h-11 w-11 shrink-0 rounded-lg border text-sm ${palette.border} disabled:opacity-30`}
          >
            A
          </button>
          <input
            type="range"
            min={MIN_FONT}
            max={MAX_FONT}
            step={10}
            value={fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            className="flex-1 accent-amber-500"
            aria-label="Text size"
          />
          <button
            onClick={() => onChange({ fontSize: Math.min(MAX_FONT, fontSize + 10) })}
            disabled={fontSize >= MAX_FONT}
            aria-label="Larger text"
            className={`h-11 w-11 shrink-0 rounded-lg border text-lg font-semibold ${palette.border} disabled:opacity-30`}
          >
            A
          </button>
        </div>

        <button
          onClick={onClose}
          className={`mb-2 w-full rounded-lg border py-2.5 text-sm font-medium ${palette.border}`}
        >
          Done
        </button>
      </div>
    </div>
  )
}
