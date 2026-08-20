import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookMemory, Conversation, Message, Settings } from '../db/types'

/**
 * Dexie needs IndexedDB, which vitest does not have, so the tables `runUpdate`
 * touches are faked here. Only the handful of calls it makes are modelled.
 */
const store = {
  book: { id: 'book-1', title: 'Twilight of the Idols', author: 'Nietzsche' } as Book,
  conversation: { id: 'chat-1', bookId: 'book-1', summarizedCount: 0 } as Conversation,
  memory: undefined as BookMemory | undefined,
  messages: [] as Message[],
}

vi.mock('../db/db', () => ({
  getSettings: async () => ({ provider: 'hosted' }) as Settings,
  db: {
    books: { get: async () => store.book },
    conversations: {
      get: async () => store.conversation,
      update: async (_id: string, patch: Partial<Conversation>) => {
        store.conversation = { ...store.conversation, ...patch }
      },
    },
    bookMemory: {
      get: async () => store.memory,
      put: async (row: BookMemory) => {
        store.memory = row
      },
      delete: async () => {
        store.memory = undefined
      },
    },
    messages: {
      where: () => ({ equals: () => ({ sortBy: async () => store.messages }) }),
    },
    transaction: async (_mode: string, _tables: unknown, body: () => Promise<void>) => body(),
  },
}))

const completeChat = vi.fn()
vi.mock('./inference', () => ({
  completeChat: (options: unknown) => completeChat(options),
  targetFor: () => ({ provider: 'hosted' }),
}))

const { updateBookMemory } = await import('./memory')

let clock = 0

function say(role: Message['role'], content: string): Message {
  clock += 1
  return { id: `m${clock}`, conversationId: 'chat-1', role, content, createdAt: clock }
}

/** The transcript handed to the summariser on the most recent call. */
function lastTranscript(): string {
  const { messages } = completeChat.mock.calls.at(-1)![0] as { messages: { content: string }[] }
  return messages.at(-1)!.content
}

beforeEach(() => {
  clock = 0
  store.conversation = { id: 'chat-1', bookId: 'book-1', summarizedCount: 0 } as Conversation
  store.memory = undefined
  store.messages = []
  completeChat.mockReset()
})

describe('a reply that came back scrubbed', () => {
  const SCRUBBED =
    'When applying this to [ADDRESS] specifically, we have to look at the shift in ' +
    'emphasis [PERSON_NAME] identifies.'

  it('never reaches the summariser, so the digest keeps updating around it', async () => {
    completeChat.mockResolvedValue('Themes: rising political power, waning cultural nerve.')

    store.messages = [
      say('user', 'What does he mean by a cultural power?'),
      say('assistant', SCRUBBED),
      say('user', 'Say more about the shift in emphasis.'),
      say('assistant', 'He means the coarsening that comes with political success.'),
      say('user', 'Does he blame the empire for it?'),
      say('assistant', 'He blames the appetite the empire fed.'),
    ]

    await updateBookMemory('book-1', 'chat-1')

    // The corrupted turn is the one thing left out; the reader's own words
    // around it still make it into the notes.
    expect(lastTranscript()).not.toContain('[PERSON_NAME]')
    expect(lastTranscript()).not.toContain('[ADDRESS]')
    expect(lastTranscript()).toContain('What does he mean by a cultural power?')

    expect(store.memory?.summary).toBe('Themes: rising political power, waning cultural nerve.')
    // Advanced past the scrubbed reply too, so it is behind us for good.
    expect(store.conversation.summarizedCount).toBe(6)
  })

  it('does not stall the digest the way rejecting the summary alone would', async () => {
    // Feeding the stored reply back in makes even a clean provider return the
    // placeholders, which the output guard rejects without advancing
    // `summarizedCount` -- so the same turn returns on the next attempt, and
    // the digest never updates again. Filtering it out is what breaks that.
    completeChat.mockImplementation(({ messages }: { messages: { content: string }[] }) =>
      Promise.resolve(
        looksScrubbed(messages.at(-1)!.content)
          ? 'Reader asked about [PERSON_NAME] and [ADDRESS].'
          : 'Notes on the passage.',
      ),
    )

    store.messages = [
      say('assistant', SCRUBBED),
      say('user', 'Go on.'),
      say('assistant', 'The point is the cost of victory.'),
      say('user', 'I think that is too neat.'),
      say('assistant', 'Fair -- he is not arguing it, he is asserting it.'),
    ]

    await updateBookMemory('book-1', 'chat-1')

    expect(store.memory?.summary).toBe('Notes on the passage.')
    expect(store.conversation.summarizedCount).toBe(5)
  })

  it('waits for enough clean turns rather than summarising the scrubbed one', async () => {
    completeChat.mockResolvedValue('Notes on the passage.')

    store.messages = [say('user', 'Why that word?'), say('assistant', SCRUBBED)]

    await updateBookMemory('book-1', 'chat-1')

    expect(completeChat).not.toHaveBeenCalled()
    expect(store.conversation.summarizedCount).toBe(0)
  })
})

function looksScrubbed(text: string): boolean {
  return text.includes('[PERSON_NAME]') || text.includes('[ADDRESS]')
}
