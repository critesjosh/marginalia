import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarginaliaDB, db } from '../db/db'
import { DEFAULT_SETTINGS, type Conversation, type Highlight, type Message } from '../db/types'
import { runCoordinatedDelivery } from './coordinator'
import {
  deliverPendingEvents,
  discardOutboxEvent,
  HELD_RECOVERY_AGE_MS,
  MAX_CONFIGURATION_ATTEMPTS,
  nextHeadOfLineBatch,
  recoverHeldQuestions,
  releaseHeldEvent,
  retryRejectedEvent,
} from './delivery'
import {
  addConversation,
  addHighlight,
  commitQuestion,
  finalizeQuestion,
  removeHighlight,
  rollbackQuestion,
  stageQuestion,
  updateHighlight,
} from './operations'
import { updateSyncPreferences } from './preferences'
import type { DeliveryTransport, EventOutboxRow } from './types'
import { validateEvent } from './validate'

const NOW = Date.UTC(2026, 8, 1, 14, 30)

function highlight(id: string, text = 'A judgment of value'): Highlight {
  return {
    id,
    bookId: 'sample-genealogy-of-morals',
    cfiRange: 'epubcfi(/6/2!/4/2/2:0)',
    text,
    note: 'A private note',
    chapter: 'First Essay',
    progress: 0.18,
    color: 'yellow',
    createdAt: NOW,
  }
}

async function settings(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  await db.settings.put({
    ...DEFAULT_SETTINGS,
    consentUpdatedAt: new Date(NOW).toISOString(),
    ...overrides,
  })
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
  await db.open()
})

describe('Dexie v5 migration', () => {
  it('keeps existing product data and defaults migrated consent to off', async () => {
    const name = `marginalia-migration-${crypto.randomUUID()}`
    const old = new Dexie(name)
    old.version(4).stores({
      books: 'id, title, author, addedAt, lastOpenedAt, archivedAt',
      highlights: 'id, bookId, createdAt, [bookId+createdAt], [bookId+externalId]',
      conversations:
        'id, bookId, highlightId, updatedAt, [bookId+updatedAt], [bookId+externalId]',
      messages:
        'id, conversationId, createdAt, [conversationId+createdAt], [conversationId+externalId]',
      bookMemory: 'bookId, updatedAt',
      settings: 'id',
    })
    await old.table('books').add({
      id: 'existing',
      title: 'Existing book',
      author: 'Author',
      addedAt: NOW,
    })
    await old.table('highlights').add(highlight('existing-highlight'))
    await old.table('conversations').add({
      id: 'existing-conversation',
      bookId: 'existing',
      title: 'Existing conversation',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await old.table('messages').add({
      id: 'existing-message',
      conversationId: 'existing-conversation',
      role: 'user',
      content: 'Existing question',
      createdAt: NOW,
    })
    await old.table('bookMemory').add({
      bookId: 'existing',
      summary: 'Existing memory',
      updatedAt: NOW,
    })
    await old.table('settings').add({
      id: 'settings',
      theme: 'sepia',
      fontSize: 110,
      audiobookAccessToken: 'existing-audiobook-token',
      audiobookPositionSeconds: 42,
    })
    old.close()

    const migrated = new MarginaliaDB(name)
    await migrated.open()
    expect(await migrated.books.get('existing')).toMatchObject({ title: 'Existing book' })
    const stored = await migrated.settings.get('settings')
    expect({ ...DEFAULT_SETTINGS, ...stored }).toMatchObject({
      theme: 'sepia',
      fontSize: 110,
      syncEnabled: false,
      shareHighlightText: false,
      audiobookAccessToken: 'existing-audiobook-token',
      audiobookPositionSeconds: 42,
    })
    expect(await migrated.highlights.count()).toBe(1)
    expect(await migrated.conversations.count()).toBe(1)
    expect(await migrated.messages.count()).toBe(1)
    expect(await migrated.bookMemory.get('existing')).toMatchObject({
      summary: 'Existing memory',
    })
    expect(await migrated.eventOutbox.count()).toBe(0)
    migrated.close()
    await Dexie.delete(name)
  })
})

describe('atomic product events', () => {
  it('does not queue while sync is disabled', async () => {
    await settings()
    await addHighlight(highlight('highlight-off'))
    expect(await db.highlights.count()).toBe(1)
    expect(await db.eventOutbox.count()).toBe(0)
  })

  it('allocates unique installation-local sequences across concurrent writes', async () => {
    await settings({ syncEnabled: true, shareHighlightText: true })
    await Promise.all([
      addHighlight(highlight('highlight-one')),
      addHighlight(highlight('highlight-two')),
    ])
    const rows = await db.eventOutbox.orderBy('sequence').toArray()
    expect(rows.map((row) => row.sequence)).toEqual([1, 2])
    expect(new Set(rows.map((row) => row.payload.installationId)).size).toBe(1)
  })

  it('rolls back the product write when the event transaction fails', async () => {
    await settings({ syncEnabled: true })
    await db.eventOutbox.add({
      eventId: '10000000-0000-4000-8000-000000000099',
      sequence: 1,
      eventType: 'highlight_created',
      eventTime: new Date(NOW).toISOString(),
      payload: {} as EventOutboxRow['payload'],
      privacySnapshot: { consentVersion: 1, included: [] },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      createdAt: NOW,
    })
    await db.syncState.put({
      id: 'sync',
      installationId: crypto.randomUUID(),
      nextSequence: 1,
    })
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000099')

    await expect(addHighlight(highlight('must-roll-back'))).rejects.toThrow()
    expect(await db.highlights.get('must-roll-back')).toBeUndefined()
  })

  it('emits consent-filtered create, update, and delete snapshots', async () => {
    await settings({ syncEnabled: true, shareHighlightText: true, shareHighlightNotes: false })
    await addHighlight(highlight('highlight-events'))
    await updateHighlight('highlight-events', { color: 'green', note: 'still private' }, NOW + 1)
    await removeHighlight('highlight-events', NOW + 2)

    const rows = await db.eventOutbox.orderBy('sequence').toArray()
    expect(rows.map((row) => row.eventType)).toEqual([
      'highlight_created',
      'highlight_updated',
      'highlight_deleted',
    ])
    expect(rows[0].payload.payload).toMatchObject({ text: 'A judgment of value' })
    expect(rows[0].payload.payload).not.toHaveProperty('note')
    expect(rows[1].payload.payload).toMatchObject({ color: 'green', changedFields: ['color', 'note'] })
    expect(rows[2].payload.payload).toEqual({ deletedAt: new Date(NOW + 2).toISOString() })
    expect(rows.every((row) => validateEvent(row.payload).valid)).toBe(true)
  })

  it('stages and commits a conversation question without exposing unconsented text', async () => {
    await settings({ syncEnabled: true, shareConversationText: false })
    const conversation: Conversation = {
      id: 'conversation-1',
      bookId: 'book-1',
      title: 'Private title',
      seedText: 'Private seed',
      chapter: 'One',
      progress: 0.2,
      createdAt: NOW,
      updatedAt: NOW,
    }
    await addConversation(conversation)
    const message: Message = {
      id: 'message-1',
      conversationId: conversation.id,
      role: 'user',
      content: 'Private question',
      createdAt: NOW + 1,
    }
    const staged = await stageQuestion(message, conversation)
    expect((await db.eventOutbox.get(staged.eventId!))?.status).toBe('held')
    expect((await db.eventOutbox.get(staged.eventId!))?.payload.payload).not.toHaveProperty('content')
    await commitQuestion(staged.eventId, NOW + 2)
    expect((await db.eventOutbox.get(staged.eventId!))?.status).toBe('pending')
  })

  it('atomically finalizes the question event with its assistant reply', async () => {
    await settings({ syncEnabled: true, shareConversationText: true })
    const conversation: Conversation = {
      id: 'conversation-finalize',
      bookId: 'book-1',
      title: 'Title',
      createdAt: NOW,
      updatedAt: NOW,
    }
    await db.conversations.add(conversation)
    const staged = await stageQuestion(
      {
        id: 'message-question',
        conversationId: conversation.id,
        role: 'user',
        content: 'Why?',
        createdAt: NOW + 1,
      },
      conversation,
    )
    await finalizeQuestion(
      staged.eventId,
      conversation.id,
      {
        id: 'message-answer',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Because.',
        createdAt: NOW + 2,
      },
      undefined,
      NOW + 2,
    )
    expect(await db.messages.get('message-answer')).toMatchObject({ content: 'Because.' })
    expect(await db.eventOutbox.get(staged.eventId!)).toMatchObject({ status: 'pending' })
    expect((await db.conversations.get(conversation.id))?.updatedAt).toBe(NOW + 2)
  })

  it('rolls a failed provisional question and its event back together', async () => {
    await settings({ syncEnabled: true, shareConversationText: true })
    const conversation: Conversation = {
      id: 'conversation-rollback',
      bookId: 'book-1',
      title: 'Title',
      createdAt: NOW,
      updatedAt: NOW,
    }
    await db.conversations.add(conversation)
    const staged = await stageQuestion(
      {
        id: 'message-rollback',
        conversationId: conversation.id,
        role: 'user',
        content: 'Will this remain?',
        createdAt: NOW + 1,
      },
      conversation,
    )
    await rollbackQuestion(staged, conversation.id)
    expect(await db.messages.get(staged.messageId)).toBeUndefined()
    expect(await db.eventOutbox.get(staged.eventId!)).toBeUndefined()
    expect((await db.conversations.get(conversation.id))?.updatedAt).toBe(NOW)
  })

  it('does not overwrite a newer conversation timestamp during rollback', async () => {
    await settings({ syncEnabled: true })
    const conversation: Conversation = {
      id: 'conversation-newer',
      bookId: 'book-1',
      title: 'Title',
      createdAt: NOW,
      updatedAt: NOW,
    }
    await db.conversations.add(conversation)
    const staged = await stageQuestion(
      {
        id: 'message-newer',
        conversationId: conversation.id,
        role: 'user',
        content: 'Question',
        createdAt: NOW + 1,
      },
      conversation,
    )
    await db.conversations.update(conversation.id, { updatedAt: NOW + 10 })
    await rollbackQuestion(staged, conversation.id)
    expect((await db.conversations.get(conversation.id))?.updatedAt).toBe(NOW + 10)
  })
})

describe('privacy changes', () => {
  it('purges revoked queued content and emits only a metadata consent event', async () => {
    await settings({ syncEnabled: true, shareHighlightText: true })
    await addHighlight(highlight('highlight-revoke'))
    await updateSyncPreferences({ shareHighlightText: false }, NOW + 10)

    const rows = await db.eventOutbox.orderBy('sequence').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].eventType).toBe('privacy_consent_changed')
    expect(rows[0].privacySnapshot.included).toEqual([])
  })

  it('turning sync off clears every queued event', async () => {
    await settings({ syncEnabled: true, shareHighlightText: true })
    await addHighlight(highlight('highlight-disable'))
    await updateSyncPreferences({ syncEnabled: false }, NOW + 10)
    expect(await db.eventOutbox.count()).toBe(0)
    expect((await db.settings.get('settings'))?.syncEnabled).toBe(false)
  })

  it('records a denied persistent-storage request without blocking enablement', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: vi.fn().mockResolvedValue(false) },
    })
    await settings()
    const next = await updateSyncPreferences({ syncEnabled: true }, NOW)
    expect(next.syncEnabled).toBe(true)
    expect(next.storagePersistence).toBe('denied')
  })

  it('coalesces duplicate concurrent consent transitions', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: vi.fn().mockResolvedValue(false) },
    })
    await settings()
    await Promise.all([
      updateSyncPreferences({ syncEnabled: true }, NOW),
      updateSyncPreferences({ syncEnabled: true }, NOW + 1),
    ])
    const rows = await db.eventOutbox.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.payload).toMatchObject({
      changed: [{ category: 'usageMetadata', enabled: true }],
    })
  })
})

describe('head-of-line delivery and coordination', () => {
  function row(sequence: number, overrides: Partial<EventOutboxRow> = {}): EventOutboxRow {
    return {
      eventId: `event-${sequence}`,
      sequence,
      eventType: 'highlight_created',
      eventTime: new Date(NOW).toISOString(),
      payload: { eventId: `event-${sequence}` } as EventOutboxRow['payload'],
      privacySnapshot: { consentVersion: 1, included: [] },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      createdAt: NOW,
      ...overrides,
    }
  }

  it('allows numeric gaps but blocks behind held, rejected, or backed-off heads', () => {
    expect(nextHeadOfLineBatch([row(1), row(3)], NOW).map((item) => item.sequence)).toEqual([1, 3])
    expect(nextHeadOfLineBatch([row(1, { status: 'held' }), row(2)], NOW)).toEqual([])
    expect(nextHeadOfLineBatch([row(1, { nextAttemptAt: NOW + 1 }), row(2)], NOW)).toEqual([])
  })

  it('retries the same event id and blocks later results after a failure', async () => {
    await settings({ syncEnabled: true })
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 3 })
    await db.eventOutbox.bulkAdd([row(1), row(2)])
    const sent: string[][] = []
    const transport: DeliveryTransport = {
      async send(events) {
        sent.push(events.map((event) => event.eventId))
        return [{ eventId: events[0].eventId, status: 'retry', code: 'offline' }]
      },
    }
    await deliverPendingEvents(transport, { now: NOW, random: () => 0 })
    expect(sent).toEqual([['event-1', 'event-2']])
    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      eventId: 'event-1',
      attempts: 1,
      lastErrorCode: 'offline',
    })
    expect(await db.eventOutbox.get('event-2')).toMatchObject({
      attempts: 0,
      lastErrorCode: 'blocked_by_prior_event',
    })
  })

  it('rejects a permanent upstream configuration failure instead of retrying forever', async () => {
    // Delivery is head-of-line, so an endlessly retried misconfiguration would
    // stop sync silently. The reader has to be told.
    await settings({ syncEnabled: true })
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 2 })
    await db.eventOutbox.add(row(1, { attempts: MAX_CONFIGURATION_ATTEMPTS - 1 }))
    const transport: DeliveryTransport = {
      async send(events) {
        return [{ eventId: events[0].eventId, status: 'retry', code: 'upstream_configuration' }]
      },
    }
    await deliverPendingEvents(transport, { now: NOW, random: () => 0 })

    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      status: 'rejected',
      attempts: MAX_CONFIGURATION_ATTEMPTS,
      lastErrorCode: 'upstream_configuration',
    })
    expect(await db.syncState.get('sync')).toMatchObject({ pausedReason: 'rejected_event' })
  })

  it('keeps retrying a configuration failure until it has given the operator time', async () => {
    await settings({ syncEnabled: true })
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 2 })
    await db.eventOutbox.add(row(1, { attempts: MAX_CONFIGURATION_ATTEMPTS - 2 }))
    const transport: DeliveryTransport = {
      async send(events) {
        return [{ eventId: events[0].eventId, status: 'retry', code: 'upstream_configuration' }]
      },
    }
    await deliverPendingEvents(transport, { now: NOW, random: () => 0 })

    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      status: 'pending',
      attempts: MAX_CONFIGURATION_ATTEMPTS - 1,
    })
  })

  it('records a rejection reported after an earlier failure in the same batch', async () => {
    // The Worker validates the whole batch before producing anything, so a valid
    // event and an invalid one come back together. Synthesising a retry for the
    // second row would discard its verdict and leave both rows pending with no
    // backoff, re-sending the identical batch on every tick forever.
    await settings({ syncEnabled: true })
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 3 })
    await db.eventOutbox.bulkAdd([row(1), row(2)])
    const transport: DeliveryTransport = {
      async send(events) {
        return [
          { eventId: events[0].eventId, status: 'retry', code: 'batch_not_produced' },
          { eventId: events[1].eventId, status: 'rejected', code: 'schema_invalid' },
        ]
      },
    }

    await deliverPendingEvents(transport, { now: NOW, random: () => 0 })

    expect(await db.eventOutbox.get('event-2')).toMatchObject({
      status: 'rejected',
      lastErrorCode: 'schema_invalid',
    })
    expect(await db.syncState.get('sync')).toMatchObject({ pausedReason: 'rejected_event' })
    // The valid event backs off rather than retrying for free.
    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      attempts: 1,
      lastErrorCode: 'batch_not_produced',
    })
    expect((await db.eventOutbox.get('event-1'))!.nextAttemptAt).toBeGreaterThan(NOW)
  })

  it('keeps rejected diagnostics retryable or discardable', async () => {
    await settings({ syncEnabled: true })
    await db.syncState.put({ id: 'sync', installationId: crypto.randomUUID(), nextSequence: 2 })
    await db.eventOutbox.add(row(1, { status: 'rejected', lastErrorCode: 'invalid' }))
    await retryRejectedEvent('event-1', NOW)
    expect(await db.eventOutbox.get('event-1')).toMatchObject({ status: 'pending', attempts: 0 })
    await discardOutboxEvent('event-1')
    expect(await db.eventOutbox.count()).toBe(0)
  })

  it('recovers interrupted held questions and discards orphaned ones', async () => {
    await db.messages.add({
      id: 'message-kept',
      conversationId: 'conversation-1',
      role: 'user',
      content: 'A persisted question',
      createdAt: NOW,
    })
    await db.eventOutbox.bulkAdd([
      row(1, {
        status: 'held',
        eventType: 'question_asked',
        payload: { entities: { messageId: 'message-kept' } } as EventOutboxRow['payload'],
      }),
      row(2, {
        status: 'held',
        eventType: 'question_asked',
        payload: { entities: { messageId: 'message-missing' } } as EventOutboxRow['payload'],
      }),
    ])

    expect(await recoverHeldQuestions(NOW + HELD_RECOVERY_AGE_MS - 1)).toEqual({
      released: 0,
      discarded: 1,
    })
    expect(await db.eventOutbox.get('event-1')).toMatchObject({ status: 'held' })

    expect(await recoverHeldQuestions(NOW + HELD_RECOVERY_AGE_MS)).toEqual({
      released: 1,
      discarded: 0,
    })
    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      status: 'pending',
      nextAttemptAt: NOW + HELD_RECOVERY_AGE_MS,
    })
    expect(await db.eventOutbox.get('event-2')).toBeUndefined()
  })

  it('lets diagnostics release a held event explicitly', async () => {
    await db.eventOutbox.add(row(1, { status: 'held' }))
    await releaseHeldEvent('event-1', NOW + 1)
    expect(await db.eventOutbox.get('event-1')).toMatchObject({
      status: 'pending',
      nextAttemptAt: NOW + 1,
    })
  })

  it('allows only one fallback lease holder at a time and recovers after release', async () => {
    await settings({ syncEnabled: true })
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runCoordinatedDelivery(() => wait, {
      forceLease: true,
      owner: 'tab-one',
      now: NOW,
    })
    await vi.waitFor(async () => {
      expect((await db.syncState.get('sync'))?.leaseOwner).toBe('tab-one')
    })
    expect(
      await runCoordinatedDelivery(async () => {}, {
        forceLease: true,
        owner: 'tab-two',
        now: NOW,
      }),
    ).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(
      await runCoordinatedDelivery(async () => {}, {
        forceLease: true,
        owner: 'tab-two',
        now: NOW + 1,
      }),
    ).toBe(true)
  })

  it('recovers a fallback lease after its owner goes stale', async () => {
    await settings({ syncEnabled: true })
    await db.syncState.put({
      id: 'sync',
      installationId: crypto.randomUUID(),
      nextSequence: 1,
      leaseOwner: 'stale-tab',
      leaseExpiresAt: NOW - 1,
    })
    expect(
      await runCoordinatedDelivery(async () => {}, {
        forceLease: true,
        owner: 'new-tab',
        now: NOW,
      }),
    ).toBe(true)
    expect((await db.syncState.get('sync'))?.leaseOwner).toBeUndefined()
  })
})
