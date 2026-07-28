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

/**
 * Merges recent conversation turns into the book's rolling digest.
 *
 * Runs in the background after an assistant reply; failures are swallowed so a
 * summariser problem never breaks the chat itself.
 */
export async function updateBookMemory(bookId: string, conversationId: string): Promise<void> {
  try {
    const settings = await getSettings()
    if (!settings.apiKey) return

    const [book, existing, messages] = await Promise.all([
      db.books.get(bookId),
      db.bookMemory.get(bookId),
      db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
    ])
    if (!book) return

    const alreadySummarized = existing?.messagesSummarized ?? 0
    const fresh = messages.slice(alreadySummarized)
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

    await db.bookMemory.put({
      bookId,
      summary: summary.trim(),
      messagesSummarized: messages.length,
      updatedAt: Date.now(),
    })
  } catch {
    // The digest is an enhancement; a failure must not surface to the reader.
  }
}

function asTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'Reader' : 'Companion'}: ${m.content}`)
    .join('\n\n')
}
