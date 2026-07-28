import type { Book, Conversation, Message, Settings } from '../db/types'
import type { ChatMessage } from './openai'

/** Keeps the request bounded on long conversations. */
const MAX_HISTORY_MESSAGES = 30

export function buildSystemPrompt({
  book,
  conversation,
  memory,
  spoilerGuard,
}: {
  book: Book
  conversation: Conversation
  memory?: string
  spoilerGuard: boolean
}): string {
  const lines: string[] = [
    'You are a well-read reading companion discussing a book with the person reading it.',
    'Be concrete and specific about the text. Answer in a few short paragraphs unless asked for more.',
    '',
    '## The book',
    `Title: ${book.title}`,
    `Author: ${book.author}`,
  ]

  if (book.publisher) lines.push(`Publisher: ${book.publisher}`)
  if (book.published) lines.push(`Published: ${book.published}`)
  if (book.description) lines.push(`Publisher description: ${book.description}`)

  lines.push('', '## Where the reader is')
  if (conversation.chapter) lines.push(`Current chapter: ${conversation.chapter}`)
  if (typeof conversation.progress === 'number') {
    lines.push(`Position: roughly ${Math.round(conversation.progress * 100)}% through the book`)
  }

  if (conversation.seedText) {
    lines.push('', '## The passage they highlighted', `"""${conversation.seedText}"""`)
  }

  if (conversation.context) {
    lines.push(
      '',
      '## Surrounding text (for context, not necessarily the subject)',
      `"""${conversation.context}"""`,
    )
  }

  if (memory?.trim()) {
    lines.push(
      '',
      '## What you and this reader have discussed about this book before',
      memory.trim(),
      'Refer back to these earlier threads when relevant.',
    )
  }

  if (spoilerGuard) {
    lines.push(
      '',
      '## Spoilers',
      "The reader is partway through. Do not reveal plot developments beyond their current position unless they explicitly ask. If answering well requires going further, say so and ask first.",
    )
  }

  return lines.join('\n')
}

export function buildMessages({
  book,
  conversation,
  history,
  memory,
  settings,
}: {
  book: Book
  conversation: Conversation
  history: Message[]
  memory?: string
  settings: Settings
}): ChatMessage[] {
  const system = buildSystemPrompt({
    book,
    conversation,
    memory,
    spoilerGuard: settings.spoilerGuard,
  })

  // Drop the oldest turns first; the system prompt carries the durable context.
  const recent = history.slice(-MAX_HISTORY_MESSAGES)

  return [
    { role: 'system', content: system },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
  ]
}

export function buildSummaryMessages({
  book,
  existingSummary,
  transcript,
}: {
  book: Book
  existingSummary?: string
  transcript: string
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You maintain a running digest of what a reader and their AI companion have discussed about one book. ' +
        'Merge the new exchange into the existing digest. Keep it under 250 words. ' +
        'Record themes explored, questions raised, interpretations formed, and the reader\'s stated opinions. ' +
        'Write terse notes, not prose. Do not invent anything that was not discussed.',
    },
    {
      role: 'user',
      content: [
        `Book: ${book.title} by ${book.author}`,
        '',
        'Existing digest:',
        existingSummary?.trim() || '(none yet)',
        '',
        'New exchange to fold in:',
        transcript,
        '',
        'Return only the updated digest.',
      ].join('\n'),
    },
  ]
}

/** Short, human-readable title for a new conversation. */
export function titleFromSeed(seed: string): string {
  const clean = seed.replace(/\s+/g, ' ').trim()
  if (clean.length <= 60) return clean
  return `${clean.slice(0, 57)}…`
}
