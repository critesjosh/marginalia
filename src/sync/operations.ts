import { db } from '../db/db'
import type { Conversation, Highlight, Message } from '../db/types'
import type { PrivacyCategory, SyncConsentV1 } from './types'
import { enqueueEvent } from './outbox'

const EVENT_TABLES = [db.settings, db.syncState, db.eventOutbox] as const

function highlightContent(highlight: Highlight, consent: SyncConsentV1) {
  const included: PrivacyCategory[] = []
  const payload = {
    color: highlight.color,
    createdAt: new Date(highlight.createdAt).toISOString(),
    ...(highlight.chapter !== undefined ? { chapter: highlight.chapter } : {}),
    ...(highlight.progress !== undefined ? { progress: highlight.progress } : {}),
    ...(consent.shareHighlightText ? { text: highlight.text } : {}),
    ...(consent.shareHighlightNotes && highlight.note ? { note: highlight.note } : {}),
  }
  if (consent.shareHighlightText) included.push('highlightText')
  if (consent.shareHighlightNotes && highlight.note) included.push('highlightNotes')
  return { payload, included }
}

export async function addHighlight(highlight: Highlight): Promise<void> {
  await db.transaction('rw', [db.highlights, ...EVENT_TABLES], async () => {
    await db.highlights.add(highlight)
    await enqueueEvent({
      eventType: 'highlight_created',
      eventTime: highlight.createdAt,
      entities: { bookId: highlight.bookId, highlightId: highlight.id },
      content: (consent) => highlightContent(highlight, consent),
    })
  })
}

type HighlightChanges = Partial<Pick<Highlight, 'color' | 'chapter' | 'progress' | 'text' | 'note'>>

export async function updateHighlight(
  highlightId: string,
  changes: HighlightChanges,
  now = Date.now(),
): Promise<Highlight | undefined> {
  return db.transaction('rw', [db.highlights, ...EVENT_TABLES], async () => {
    const current = await db.highlights.get(highlightId)
    if (!current) return undefined
    const changedFields = (Object.keys(changes) as (keyof HighlightChanges)[]).filter(
      (key) => changes[key] !== current[key],
    )
    if (!changedFields.length) return current

    const next = { ...current, ...changes }
    await db.highlights.update(highlightId, changes)
    await enqueueEvent({
      eventType: 'highlight_updated',
      eventTime: now,
      entities: { bookId: next.bookId, highlightId },
      content: (consent) => {
        const snapshot = highlightContent(next, consent)
        return {
          ...snapshot,
          payload: { ...snapshot.payload, changedFields },
        }
      },
    })
    return next
  })
}

export async function removeHighlight(highlightId: string, now = Date.now()): Promise<void> {
  await db.transaction('rw', [db.highlights, ...EVENT_TABLES], async () => {
    const highlight = await db.highlights.get(highlightId)
    if (!highlight) return
    await db.highlights.delete(highlightId)
    await enqueueEvent({
      eventType: 'highlight_deleted',
      eventTime: now,
      entities: { bookId: highlight.bookId, highlightId },
      content: () => ({ payload: { deletedAt: new Date(now).toISOString() }, included: [] }),
    })
  })
}

export async function addConversation(conversation: Conversation): Promise<void> {
  await db.transaction('rw', [db.conversations, ...EVENT_TABLES], async () => {
    await db.conversations.add(conversation)
    await enqueueEvent({
      eventType: 'conversation_started',
      eventTime: conversation.createdAt,
      entities: {
        bookId: conversation.bookId,
        conversationId: conversation.id,
        ...(conversation.highlightId !== undefined
          ? { highlightId: conversation.highlightId }
          : {}),
      },
      content: (consent) => ({
        payload: {
          createdAt: new Date(conversation.createdAt).toISOString(),
          ...(conversation.chapter !== undefined ? { chapter: conversation.chapter } : {}),
          ...(conversation.progress !== undefined ? { progress: conversation.progress } : {}),
          ...(consent.shareConversationText
            ? {
                title: conversation.title,
                ...(conversation.seedText !== undefined
                  ? { seedText: conversation.seedText }
                  : {}),
              }
            : {}),
        },
        included: consent.shareConversationText ? ['conversationText'] : [],
      }),
    })
  })
}

export interface StagedQuestion {
  messageId: string
  eventId?: string
  previousConversationUpdatedAt: number
}

export async function stageQuestion(message: Message, conversation: Conversation): Promise<StagedQuestion> {
  return db.transaction(
    'rw',
    [db.messages, db.conversations, ...EVENT_TABLES],
    async () => {
      const currentConversation = (await db.conversations.get(conversation.id)) ?? conversation
      const previousConversationUpdatedAt = currentConversation.updatedAt
      await db.messages.add(message)
      await db.conversations.update(conversation.id, { updatedAt: message.createdAt })
      const event = await enqueueEvent({
        eventType: 'question_asked',
        eventTime: message.createdAt,
        entities: {
          bookId: conversation.bookId,
          conversationId: conversation.id,
          messageId: message.id,
        },
        status: 'held',
        content: (consent) => ({
          payload: {
            createdAt: new Date(message.createdAt).toISOString(),
            ...(conversation.chapter !== undefined ? { chapter: conversation.chapter } : {}),
            ...(conversation.progress !== undefined ? { progress: conversation.progress } : {}),
            ...(consent.shareConversationText ? { content: message.content } : {}),
          },
          included: consent.shareConversationText ? ['conversationText'] : [],
        }),
      })
      return {
        messageId: message.id,
        eventId: event?.eventId,
        previousConversationUpdatedAt,
      }
    },
  )
}

export async function commitQuestion(eventId: string | undefined, now = Date.now()): Promise<void> {
  if (!eventId) return
  await db.eventOutbox.update(eventId, { status: 'pending', nextAttemptAt: now })
}

export async function finalizeQuestion(
  eventId: string | undefined,
  conversationId: string,
  assistantMessage?: Message,
  now = Date.now(),
): Promise<void> {
  await db.transaction(
    'rw',
    [db.messages, db.conversations, db.eventOutbox],
    async () => {
      if (assistantMessage) {
        await db.messages.add(assistantMessage)
        await db.conversations.update(conversationId, { updatedAt: assistantMessage.createdAt })
      }
      if (eventId) {
        await db.eventOutbox.update(eventId, { status: 'pending', nextAttemptAt: now })
      }
    },
  )
}

export async function rollbackQuestion(
  staged: StagedQuestion,
  conversationId: string,
): Promise<void> {
  await db.transaction('rw', [db.messages, db.conversations, db.eventOutbox], async () => {
    const message = await db.messages.get(staged.messageId)
    await db.messages.delete(staged.messageId)
    const conversation = await db.conversations.get(conversationId)
    if (conversation?.updatedAt === message?.createdAt) {
      await db.conversations.update(conversationId, {
        updatedAt: staged.previousConversationUpdatedAt,
      })
    }
    if (staged.eventId) await db.eventOutbox.delete(staged.eventId)
  })
}
