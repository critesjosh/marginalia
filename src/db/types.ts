export interface Book {
  id: string
  title: string
  author: string
  publisher?: string
  published?: string
  description?: string
  language?: string
  cover?: Blob
  /**
   * The EPUB itself. Absent once the book has been archived: the file is the
   * only large part of the record, and dropping it is the point of removing a
   * book while keeping its highlights, conversations and memory.
   */
  file?: Blob
  /**
   * SHA-256 of the EPUB bytes, kept after the file itself is dropped.
   *
   * This is what an archived book is recognised by when its EPUB is imported
   * again, so its highlights and reading position are only ever handed back to
   * the edition they were recorded against.
   */
  fileHash?: string
  addedAt: number
  /** Set when the reader removed the book but kept the notes anchored to it. */
  archivedAt?: number
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
  /** Set when the highlight was made somewhere else and imported. */
  source?: 'koreader'
  /**
   * That source's own id for it, so importing the same export twice adds
   * nothing the second time. Namespaced by the source, so it cannot collide
   * with an id this reader minted.
   */
  externalId?: string
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
  /** Set when the conversation was held somewhere else and imported. */
  source?: 'koreader'
  /** That source's own id for it. See `Highlight.externalId`. */
  externalId?: string
}

export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  id: string
  conversationId: string
  role: Role
  content: string
  createdAt: number
  /**
   * The id this turn had where it was written, when it was imported.
   *
   * Imported turns are never rewritten, only skipped if already present: a
   * conversation held on an e-reader is finished by the time it is exported.
   */
  externalId?: string
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
  /** Set once every bundled book has been offered, so deleting them sticks. */
  sampleBookSeeded?: boolean
  /**
   * Which bundled books have been offered, while some still have not been.
   * A first run that seeds two of three and fails on the last leaves the books
   * it did add on the shelf, and the reader may delete one before the retry
   * succeeds; without this the retry cannot tell that row from one that never
   * arrived, and puts the deleted book back.
   *
   * Only meaningful while `sampleBookSeeded` is unset, which is the whole
   * reason it is separate from it.
   */
  seededSampleIds?: string[]
  /** Personal R2 streaming token. Stored only in this browser's IndexedDB. */
  audiobookAccessToken?: string
  /** Playback position for the personal Twilight of the Idols audiobook. */
  audiobookPositionSeconds?: number
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
