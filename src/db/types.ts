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
   * CFI the chat is anchored to, so the book index can place it exactly.
   *
   * Duplicated from the seed highlight for the same reason `chapter` and
   * `progress` are: the conversation carries where it was started, and the
   * highlight it came from can be deleted. Chats made before the index existed
   * have no CFI and fall back to `progress`, which is close but not exact.
   */
  seedCfi?: string
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
  updatedAt: number
}

/**
 * One addressable slice of a book's prose, cut on block boundaries.
 *
 * The unit the index is built from and the unit retrieval selects. Text is
 * stored rather than re-derived at read time: re-parsing a spine document to
 * quote from it would put an XHTML parse on the path of sending a message, and
 * a book's plain text is roughly the size of its EPUB.
 */
export interface BookChunk {
  id: string
  bookId: string
  /** Position in the book, 0-based, in reading order. */
  index: number
  /** Spine href this chunk lives in. */
  href: string
  /** CFI of the chunk's first block, comparable against a reading position. */
  cfiStart: string
  /** Chapter this chunk opens in, resolved from the table of contents. */
  chapter?: string
  /**
   * Chapters that begin inside this chunk, in order. Several short chapters can
   * fall inside one chunk, and an outline built from `chapter` alone would omit
   * them.
   */
  chapterStarts?: string[]
  /** 0..1, from the character offset of the chunk's start within the book. */
  progress: number
  text: string
}

/** Whether a book has an index, and what built it. */
export interface BookIndexState {
  bookId: string
  /** Bumped when chunking changes, so stale indexes are rebuilt not reused. */
  version: number
  chunkCount: number
  charCount: number
  builtAt: number
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
  /**
   * Index books on this device, and send passages from earlier in the book that
   * match what the reader highlighted. Costs a few seconds of work the first
   * time each book is opened.
   */
  bookIndex: boolean
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
  bookIndex: true,
}
