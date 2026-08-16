/**
 * Bounds on the per-book digest.
 *
 * Separate from both `prompt.ts` and `memory.ts` because the database layer
 * needs these to migrate rows written before the limits existed, and importing
 * either of those from `db.ts` would close an import cycle.
 */

/** Prefix of every quoting delimiter. `fenceToken` in `prompt.ts` builds on it. */
export const FENCE_PREFIX = 'BOOKDATA_'

/** Matches any token `fenceToken` can produce, from either branch of `newId`. */
const FENCE_PATTERN = new RegExp(`${FENCE_PREFIX}[0-9A-Z]{16}`, 'g')

/** A line carrying nothing but delimiters, which is how `fenced` writes them. */
const FENCE_LINE = new RegExp(`^\\s*(?:${FENCE_PREFIX}[0-9A-Z]{16}\\s*)+$`)

/**
 * Hard ceiling on a stored digest.
 *
 * The summariser is asked for 250 words, which lands around 1,800 characters,
 * so this is roughly double what a well-behaved update produces and should
 * never fire on one. It exists because nothing else bounds the digest: each
 * update feeds the previous one back in and replaces it with whatever comes
 * out, so a model that pads instead of condensing ratchets upward with no step
 * that ever shrinks it again. The digest rides in the system prompt of every
 * message, so unbounded growth eventually costs the reader their chat, not
 * just their summaries.
 */
export const MAX_SUMMARY_CHARS = 4000

/**
 * Removes delimiters a model copied out of its own prompt.
 *
 * Summarisers routinely echo the fence lines wrapping their input into their
 * output, and the digest that gets stored then carries them. Because each
 * update feeds the stored digest back in to be re-fenced, the markers stack up
 * a pair per round and never come off. They are inert -- a fence from a past
 * request cannot close the fresh one wrapping it, which is the point of
 * generating a new token per request -- but they crowd out the notes they
 * surround, so strip them before anything is written.
 */
export function stripFenceTokens(text: string): string {
  // Whole lines go first. Blanking them in place would leave the empty line
  // behind, and a delimiter echoed mid-digest would then part the notes around
  // it -- invisible while the markers sit at the very edges, as they do today,
  // but not once one lands in the middle.
  const lines = text.split('\n').filter((line) => !FENCE_LINE.test(line))

  return lines
    .join('\n')
    .replace(FENCE_PATTERN, '')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Labels a PII scrubber leaves behind, as literal bracketed text.
 *
 * Drawn from the entity names the common scrubbers emit, rather than matched by
 * shape: a pattern for "bracketed capitals" would also claim editorial marks a
 * reader might legitimately write, and the cost of a false positive here is a
 * digest that stops updating for that book.
 */
const REDACTION_LABELS = [
  'PERSON_NAME',
  'PERSON',
  'ADDRESS',
  'STREET_ADDRESS',
  'LOCATION',
  'ORGANIZATION',
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'DATE_TIME',
  'DATE_OF_BIRTH',
  'CREDIT_CARD',
  'CREDIT_CARD_NUMBER',
  'IP_ADDRESS',
  'IBAN_CODE',
  'US_SSN',
  'PASSPORT',
  'DRIVER_LICENSE',
]

const REDACTION_PATTERN = new RegExp(`\\[(?:${REDACTION_LABELS.join('|')})\\]`)

/**
 * Whether a model's reply came back with its subject scrubbed out.
 *
 * Some inference providers run the prompt through a PII filter before the model
 * sees it, so a passage about Nietzsche and Germany arrives as one about
 * `[PERSON_NAME]` and `[ADDRESS]`, and the reply discusses those. The relay
 * routes around such providers, but a reply is worth checking anyway where it
 * would be *stored*: the digest rides in the system prompt of every later
 * message about that book, so one scrubbed round folded in teaches every
 * following answer to talk that way, long after the routing has moved on.
 *
 * Discarding the update costs one round of notes -- the same turns are folded
 * in on the next reply instead -- against a book whose memory is poisoned until
 * the reader notices and clears it by hand.
 */
export function looksRedacted(text: string): boolean {
  return REDACTION_PATTERN.test(text)
}

/** Last paragraph break, then line, sentence, and word, in preference order. */
const BOUNDARIES = [
  /\n\n(?![\s\S]*\n\n)/,
  /\n(?![\s\S]*\n)/,
  /[.!?](?![\s\S]*[.!?])/,
  / (?![\s\S]* )/,
]

/**
 * What actually gets stored: no echoed delimiters, never over the ceiling.
 *
 * Truncation prefers the latest structural boundary that still uses most of
 * the allowance, so a clipped digest reads as notes rather than stopping
 * mid-word. That matters beyond tidiness: the result is fed back to the
 * summariser as prior context, and a severed clause invites it to invent the
 * rest of the thought.
 */
export function normalizeSummary(text: string): string {
  const clean = stripFenceTokens(text)
  if (clean.length <= MAX_SUMMARY_CHARS) return clean

  const head = clean.slice(0, MAX_SUMMARY_CHARS)
  for (const boundary of BOUNDARIES) {
    const at = head.search(boundary)
    if (at > MAX_SUMMARY_CHARS / 2) return `${head.slice(0, at + 1).trim()}…`
  }
  return `${head.trim()}…`
}
