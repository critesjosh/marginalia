import { Link } from 'react-router-dom'
import { CloseIcon } from './Icons'
import { button, iconButton } from './ui'

// Only the core idea: everything else is shown where it applies, and all of
// it is on the help page.
const STEPS = [
  'Open any book on your shelf.',
  'Select a line that catches your eye.',
  'Choose “Ask about this” and follow the thread.',
]

/**
 * Shown on the library until the reader starts a first thread, follows one of
 * its links or dismisses it, since the selection bar is the whole idea and nothing else points to it.
 */
export default function FirstRunHint({
  tryLink,
  onDismiss,
  onFollow,
}: {
  /** Where “Try it with Moby Dick” goes, if the book is still on the shelf. */
  tryLink?: string
  onDismiss: () => void
  /** Following either link retires the card too: the reader has taken it up. */
  onFollow: () => void
}) {
  return (
    <section
      aria-labelledby="first-run-hint"
      className="relative mb-8 max-w-[640px] rounded-lg border border-rule bg-paper-leaf p-6 pr-14 min-[560px]:px-8"
    >
      <button
        onClick={onDismiss}
        aria-label="Dismiss how Rami works"
        className={`${iconButton} absolute top-2 right-2`}
      >
        <CloseIcon />
      </button>
      <p id="first-run-hint" className="eyebrow">
        How Rami works
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 font-ui text-body text-ink-soft marker:text-rubric">
        {STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {tryLink && (
          <Link to={tryLink} onClick={onFollow} className={button.secondary}>
            Try it with Moby Dick
          </Link>
        )}
        <Link to="/help" onClick={onFollow} className={button.quiet}>
          More about Rami
        </Link>
      </div>
    </section>
  )
}
