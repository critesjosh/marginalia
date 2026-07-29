import { db, getSettings } from '../db/db'
import type { Message } from '../db/types'
import { completeChat } from './openai'
import { buildSummaryMessages } from './prompt'

/** Fold a conversation into the book's digest after this many new messages. */
const MESSAGES_PER_UPDATE = 4

export async function getBookMemory(bookId: string): Promise<string | undefined> {
  const row = await db.bookMemory.get(bookId)
  return row?.summary
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
  if (!settings.apiKey) return

  const [book, conversation, existing, messages] = await Promise.all([
    db.books.get(bookId),
    db.conversations.get(conversationId),
    db.bookMemory.get(bookId),
    db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
  ])
  if (!book || !conversation) return

  const fresh = messages.slice(conversation.summarizedCount ?? 0)
  if (fresh.length < MESSAGES_PER_UPDATE) return

  const summary = await completeChat({
    apiKey: settings.apiKey,
    model: settings.summaryModel || settings.model,
    messages: buildSummaryMessages({
      book,
      existingSummary: existing?.summary,
      transcript: asTranscript(fresh),
    }),
  })
  if (!summary.trim()) return

  await db.transaction('rw', [db.bookMemory, db.conversations], async () => {
    await db.bookMemory.put({ bookId, summary: summary.trim(), updatedAt: Date.now() })
    await db.conversations.update(conversationId, { summarizedCount: messages.length })
  })
}

function asTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'Reader' : 'Companion'}: ${m.content}`)
    .join('\n\n')
}
