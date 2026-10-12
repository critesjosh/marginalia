/**
 * Rami controls as class strings, so a `<button>` and a `<Link>` can share
 * them. One primary per screen; text buttons are never pills.
 */
const BUTTON =
  'inline-flex min-h-tap items-center justify-center gap-2 rounded-md border px-[18px] font-ui text-label font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-45 [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:shrink-0'

export const button = {
  primary: `${BUTTON} border-transparent bg-moss text-on-moss hover:bg-moss-deep disabled:bg-moss`,
  secondary: `${BUTTON} border-rule-strong text-ink hover:bg-paper-sunk disabled:bg-transparent`,
  quiet: `${BUTTON} border-transparent !px-3 text-moss hover:bg-paper-sunk disabled:bg-transparent`,
  danger: `${BUTTON} border-danger text-danger hover:bg-paper-sunk disabled:bg-transparent`,
}

/** Round, icon-only: header chrome. Always give it an aria-label. */
export const iconButton =
  'grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-soft transition-colors duration-150 hover:bg-paper-sunk hover:text-ink [&_svg]:h-5 [&_svg]:w-5'

/** A settings group: a raised leaf on the page. */
export const card = 'rounded-lg border border-rule bg-paper-leaf p-6'
