import { TAP_TURN_ZONE } from '../lib/selectionEdge'

const SIDE = `${TAP_TURN_ZONE * 100}%`

/**
 * The page's tap zones, drawn over a first book. Taps pass through it, so
 * trying a zone works while the map is up. Purely visual: the toolbar's
 * labeled buttons and the arrow keys do the same without it.
 */
export default function TapZonesHint() {
  return (
    <div
      aria-hidden
      className="no-select pointer-events-none absolute inset-0 z-20 mx-auto flex max-w-[760px] font-ui text-label font-medium text-ink"
    >
      <Zone width={SIDE} label="‹ Back" />
      <Zone label="Toolbar" middle />
      <Zone width={SIDE} label="Next ›" />
    </div>
  )
}

function Zone({ label, width, middle }: { label: string; width?: string; middle?: boolean }) {
  return (
    <div
      style={width ? { width } : undefined}
      className={`grid place-items-center bg-paper-sunk/60 p-2 ${
        middle ? 'flex-1 border-x border-dashed border-rule-strong' : 'shrink-0'
      }`}
    >
      <span className="rounded-md border border-rule bg-paper-leaf px-3 py-2 text-center whitespace-nowrap shadow-leaf">
        {label}
      </span>
    </div>
  )
}
