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
  createdAt: number
  updatedAt: number
}

export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  id: string
  conversationId: string
  role: Role
  content: string
  createdAt: number
}

export interface BookMemory {
  bookId: string
  summary: string
  /** Number of messages already folded into the summary, to avoid redundant calls. */
  messagesSummarized: number
  updatedAt: number
}

export type ReaderTheme = 'light' | 'sepia' | 'dark'

export interface Settings {
  id: 'settings'
  apiKey?: string
  model: string
  summaryModel: string
  theme: ReaderTheme
  fontSize: number
  /** Ask the model to avoid spoiling content past the reader's position. */
  spoilerGuard: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  model: 'gpt-4o-mini',
  summaryModel: 'gpt-4o-mini',
  theme: 'dark',
  fontSize: 100,
  spoilerGuard: true,
}
