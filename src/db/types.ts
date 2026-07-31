export interface Book {
  id: string
  title: string
  author: string
  publisher?: string
  published?: string
  description?: string
  language?: string
  cover?: Blob
  file: Blob
  addedAt: number
  lastOpenedAt?: number
  lastCfi?: string
  /** 0..1, epub.js locations-based progress at lastCfi. */
  progress?: number
  /** Serialized epub.js locations, so progress isn't recomputed on every open. */
  locations?: string
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface Highlight {
  id: string
  bookId: string
  cfiRange: string
  /** Stored so a highlight can be re-anchored by text search if its CFI breaks. */
  text: string
  /** Spine href the highlight lives in, used for re-anchoring. */
  sectionHref?: string
  /** Prose surrounding the passage, captured while the page was rendered. */
  context?: string
  chapter?: string
  progress?: number
  color: HighlightColor
  note?: string
  createdAt: number
}

export interface Conversation {
  id: string
  bookId: string
  highlightId?: string
  title: string
  /** Snapshot of the reading context when the chat was started. */
  seedText?: string
  /** Prose surrounding the seed passage, captured while the page was rendered. */
  context?: string
  chapter?: string
  progress?: number
  /**
   * How many of this conversation's messages are already in the book digest.
   *
   * Belongs to the conversation, not the book: a single book-wide counter gets
   * indexed into one conversation's message list and silently starves the others.
   */
  summarizedCount?: number
  createdAt: number
  updatedAt: number
}

export type Role = 'system' | 'user' | 'assistant'

/** A page the companion read to answer, from its web search tool. */
export interface Citation {
  url: string
  title?: string
}

export interface Message {
  id: string
  conversationId: string
  role: Role
  content: string
  /**
   * Sources behind this reply, present only on turns where the model searched.
   *
   * Stored with the message rather than derived later: the reply is written
   * against what those pages said at the time, and a link the reader can check
   * is the only way to tell a grounded answer from a confident guess.
   */
  citations?: Citation[]
  createdAt: number
}

export interface BookMemory {
  bookId: string
  summary: string
  updatedAt: number
}

export type ReaderTheme = 'light' | 'sepia' | 'dark'

/**
 * `hosted` routes through this site's relay, which holds an OpenRouter key
 * server-side. `openai` sends the reader's own key straight to OpenAI.
 */
export type Provider = 'hosted' | 'openai'

export interface Settings {
  id: 'settings'
  provider: Provider
  apiKey?: string
  model: string
  summaryModel: string
  theme: ReaderTheme
  fontSize: number
  /** Ask the model to avoid spoiling content past the reader's position. */
  spoilerGuard: boolean
  /** Set once the bundled sample book has been offered, so deleting it sticks. */
  sampleBookSeeded?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  provider: 'hosted',
  model: 'gpt-4o-mini',
  summaryModel: 'gpt-4o-mini',
  theme: 'dark',
  fontSize: 100,
  spoilerGuard: true,
}
