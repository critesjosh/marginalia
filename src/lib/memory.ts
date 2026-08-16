import { db, getSettings } from '../db/db'
import type { Message } from '../db/types'
import { looksRedacted, normalizeSummary } from './digest'
import { completeChat, targetFor } from './inference'
import { buildSummaryMessages } from './prompt'

/** Fold a conversation into the book's digest after this many new messages. */
const MESSAGES_PER_UPDATE = 4

/**
 * Ceiling on the transcript handed to the summariser in one update.
 *
 * `summarizedCount` only advances when an update completes, and every failure
 * is swallowed, so without this the messages waiting to be folded in grow by
 * two per reply for as long as the summariser is down. That is not merely
 * wasteful: once the accumulated transcript passes what the relay accepts, the
 * request fails *on size*, and since the backlog only ever grows it can never
 * succeed again. The digest for that conversation would be dead from then on,
 * silently.
 *
 * Bounding the window is what makes a failure temporary. Measured in
 * characters rather than messages because one pasted passage can outweigh
 * twenty short turns.
 */
const MAX_TRANSCRIPT_CHARS = 24_000

export async function getBookMemory(bookId: string): Promise<string | undefined> {
  const row = await db.bookMemory.get(bookId)
  return row?.summary
}

/**
 * Replaces the digest with the reader's own wording.
 *
 * Later automatic updates merge into whatever is stored here rather than
 * starting over, so an edit carries forward instead of being summarised away.
 * Saving an empty digest deletes it, which is how the screen's clear works.
 */
export async function saveBookMemory(bookId: string, summary: string): Promise<void> {
  const normalized = normalizeSummary(summary)
  if (!normalized) {
    await db.bookMemory.delete(bookId)
    return
  }
  await db.bookMemory.put({ bookId, summary: normalized, updatedAt: Date.now() })
}

/** One digest update at a time per book, so concurrent replies cannot overwrite each other. */
const inFlight = new Map<string, Promise<void>>()

/**
 * Merges recent conversation turns into the book's rolling digest.
 *
 * Runs in the background after an assistant reply; failures are swallowed so a
 * summariser problem never breaks the chat itself. Updates for one book are
 * queued rather than run in parallel: each one reads the existing summary and
 * writes a replacement, so overlapping calls would drop whichever finished first.
 */
export function updateBookMemory(bookId: string, conversationId: string): Promise<void> {
  const queued = (inFlight.get(bookId) ?? Promise.resolve())
    .then(() => runUpdate(bookId, conversationId))
    .catch(() => {
      // The digest is an enhancement; a failure must not surface to the reader.
    })
    .finally(() => {
      if (inFlight.get(bookId) === queued) inFlight.delete(bookId)
    })

  inFlight.set(bookId, queued)
  return queued
}

async function runUpdate(bookId: string, conversationId: string): Promise<void> {
  const settings = await getSettings()
  const target = targetFor(settings, 'summary')

  const [book, conversation, existing, messages] = await Promise.all([
    db.books.get(bookId),
    db.conversations.get(conversationId),
    db.bookMemory.get(bookId),
    db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
  ])
  if (!book || !conversation) return

  const usable = summarisable(messages.slice(conversation.summarizedCount ?? 0))
  if (usable.length < MESSAGES_PER_UPDATE) return
  const fresh = withinBudget(usable)

  const generated = await completeChat({
    target,
    messages: buildSummaryMessages({
      book,
      existingSummary: existing?.summary,
      transcript: asTranscript(fresh),
    }),
  })

  // A reply that is nothing but echoed delimiters normalises to empty, and
  // storing that would wipe a digest the reader may have written by hand.
  const summary = normalizeSummary(generated)
  if (!summary) return

  // The transcript went out clean, so placeholders here were introduced by the
  // summariser's own provider rather than carried in: a transient routing
  // problem, worth retrying. Leaving `summarizedCount` alone folds these same
  // turns in on the next reply, which `summarisable` keeps from looping.
  if (looksRedacted(summary)) return

  await db.transaction('rw', [db.bookMemory, db.conversations], async () => {
    // The digest this was merged from can have been rewritten by the reader
    // while the model was working, and the result would put their wording back
    // to what it replaced. Theirs wins. Leaving `summarizedCount` alone as well
    // means these messages fold into the edited digest on the next reply rather
    // than being dropped.
    const current = await db.bookMemory.get(bookId)
    if (current?.updatedAt !== existing?.updatedAt) return

    await db.bookMemory.put({ bookId, summary, updatedAt: Date.now() })
    await db.conversations.update(conversationId, { summarizedCount: messages.length })
  })
}

/**
 * Drops replies that came back with their subject scrubbed out.
 *
 * A scrubbed reply is stored like any other -- it is on screen, and deleting
 * what the reader has already read would be worse than leaving it -- so it
 * stays in `pending` until something folds it in. Summarising it would put the
 * placeholders in the digest by a second route, since a provider that never
 * scrubbed anything will faithfully summarise `[PERSON_NAME]` as
 * `[PERSON_NAME]`, and the output guard below would then reject the result.
 *
 * That is the loop this exists to prevent: the guard leaves `summarizedCount`
 * where it is, so the same contaminated turn returns on the next attempt and is
 * rejected again, and the digest stops updating for as long as the reply sits
 * inside the transcript window -- thousands of characters of conversation, and
 * an inference call burned on each try. Dropping it from the transcript instead
 * lets the update succeed, and `summarizedCount` then advances past it for good.
 *
 * Only assistant turns are checked. The reader's own words are theirs, and the
 * turns around a bad reply are usually the ones worth keeping.
 */
function summarisable(pending: Message[]): Message[] {
  return pending.filter((m) => m.role !== 'assistant' || !looksRedacted(m.content))
}

/**
 * The newest turns that fit in `MAX_TRANSCRIPT_CHARS`.
 *
 * Walks back from the latest message, so what survives a backlog is the part
 * of the conversation closest to where the reader actually is. Turns older
 * than the window are dropped rather than deferred: `summarizedCount` jumps
 * past them on success, and they are never folded in. That loses the oldest
 * few exchanges after an outage, which beats the alternative of a summariser
 * that can never run again.
 *
 * The newest `MESSAGES_PER_UPDATE` turns go out even when they exceed the
 * budget on their own, so an update always carries something. A single
 * enormous message can still overrun, but it falls out of that window within
 * an exchange or two, so the failure clears itself.
 */
function withinBudget(pending: Message[]): Message[] {
  let chars = 0
  let start = pending.length
  while (start > 0) {
    const total = chars + pending[start - 1].content.length
    if (total > MAX_TRANSCRIPT_CHARS) break
    chars = total
    start--
  }

  return pending.slice(Math.min(start, pending.length - MESSAGES_PER_UPDATE))
}

function asTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'Reader' : 'Companion'}: ${m.content}`)
    .join('\n\n')
}
