import type { Book } from '../db/types'
import { enqueueEvent } from './outbox'
import type { EventPayloadByType } from './types'

/**
 * Library and conversation lifecycle events.
 *
 * Every one is enqueued inside the same transaction as the product write it
 * describes, so a book cannot be archived without the event or the other way
 * round. The caller opens that transaction and must include settings, syncState,
 * and eventOutbox alongside the product tables it changes.
 *
 * Nothing here imports the database. db.ts imports this module, and a module
 * that reached back for a table at import time would deadlock the cycle.
 */

function timestamp(at: number): string {
  return new Date(at).toISOString()
}

/** Consent-filtered book metadata. Nothing here is book text. */
function metadata(book: Book): Partial<EventPayloadByType['book_added']> {
  const fields = {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    published: book.published,
    language: book.language,
    description: book.description,
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.length > 0),
  )
}

export async function recordBookAdded(
  book: Book,
  origin: EventPayloadByType['book_added']['origin'],
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'book_added',
    eventTime: at,
    entities: { bookId: book.id },
    // Without consent for metadata the event still records that a book was
    // added, which is usage, and carries no title or author.
    content: (consent) =>
      consent.shareBookMetadata
        ? {
            payload: { addedAt: timestamp(at), origin, ...metadata(book) },
            included: ['bookMetadata'],
          }
        : { payload: { addedAt: timestamp(at), origin }, included: [] },
  })
}

export async function recordBookArchived(
  bookId: string,
  progress: number | undefined,
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'book_archived',
    eventTime: at,
    entities: { bookId },
    content: () => ({
      payload: { archivedAt: timestamp(at), ...(progress === undefined ? {} : { progress }) },
      included: [],
    }),
  })
}

export async function recordBookRestored(
  bookId: string,
  progress: number | undefined,
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'book_restored',
    eventTime: at,
    entities: { bookId },
    content: () => ({
      payload: { restoredAt: timestamp(at), ...(progress === undefined ? {} : { progress }) },
      included: [],
    }),
  })
}

export async function recordBookRemoved(
  bookId: string,
  counts: { highlightsRemoved: number; conversationsRemoved: number },
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'book_removed',
    eventTime: at,
    entities: { bookId },
    content: () => ({ payload: { removedAt: timestamp(at), ...counts }, included: [] }),
  })
}

export async function recordConversationDeleted(
  bookId: string,
  conversationId: string,
  messagesRemoved: number,
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'conversation_deleted',
    eventTime: at,
    entities: { bookId, conversationId },
    content: () => ({ payload: { deletedAt: timestamp(at), messagesRemoved }, included: [] }),
  })
}

export async function recordBookMemoryUpdated(
  bookId: string,
  summary: string,
  at = Date.now(),
): Promise<void> {
  await enqueueEvent({
    eventType: 'book_memory_updated',
    eventTime: at,
    entities: { bookId },
    // The memory changing is usage even when its text is not shared.
    content: (consent) =>
      consent.shareBookMemory
        ? { payload: { updatedAt: timestamp(at), summary }, included: ['bookMemory'] }
        : { payload: { updatedAt: timestamp(at) }, included: [] },
  })
}
