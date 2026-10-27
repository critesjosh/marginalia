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
   * The EPUB itself. Absent once the book has been archived, which reclaims
   * the space while keeping its highlights, conversations and memory, or once
   * the browser lost its bytes (`missingFileAt`).
   */
  file?: Blob
  /**
   * SHA-256 of the EPUB bytes, kept after the file itself is dropped.
   *
   * This is what an archived book is recognized by when its EPUB is imported
   * again, so its highlights and reading position are only ever handed back to
   * the edition they were recorded against.
   */
  fileHash?: string
  addedAt: number
  /** Set when the reader removed the book but kept the notes anchored to it. */
  archivedAt?: number
  /** Set when the browser lost the stored EPUB; the book stays on the shelf until it is imported again. */
  missingFileAt?: number
  lastOpenedAt?: number
  lastCfi?: string
  /** 0..1, epub.js locations-based progress at lastCfi. */
  progress?: number
  /** Serialized epub.js locations, so progress isn't recomputed on every open. */
  locations?: string
  /**
   * The reader's own instructions for this book, sent unfenced with its chats.
   * Set only from the Memory tab, never from an import.
   */
  instructions?: string
  /** Set while the book is shared at a link (`src/lib/bookLink.ts`). */
  sharedLink?: PublishedBookLink
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
  /** Set while the thread is published at a link (`src/lib/publish.ts`). */
  published?: PublishedLink
}

/**
 * A thread's or book's public link. Not indexed, so adding it needed no Dexie version.
 * The owner token is what lets this device update or remove the link; it is
 * left out of exports.
 */
export interface PublishedLink {
  id: string
  url: string
  ownerToken: string
  publishedAt: number
  expiresAt: number
}

/** A shared book's link, and which cover it was last sent with. */
export interface PublishedBookLink extends PublishedLink {
  /** Fingerprint of the cover the link shows, or `none`. */
  coverHash: string
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

/** Typeface for the book's text inside the reader. */
export type ReaderFont = 'literata' | 'garamond' | 'charis'

export interface Settings {
  id: 'settings'
  theme: ReaderTheme
  fontSize: number
  readerFont: ReaderFont
  /** One color for every highlight; the per-highlight `color` is kept for imports. */
  highlightColor: HighlightColor
  /** Ask the model to avoid spoiling content past the reader's position. */
  spoilerGuard: boolean
  /** Ask the model for a few sentences rather than a few paragraphs. */
  briefReplies?: boolean
  /** The reader's own standing instructions, sent unfenced with every chat. */
  instructions?: string
  /** Set once every bundled book has been offered, so deleting them sticks. */
  sampleBookSeeded?: boolean
  /**
   * Which bundled books have been offered, while some still have not been.
   * A first run that seeds three of four and fails on the last leaves the books
   * it did add on the shelf, and the reader may delete one before the retry
   * succeeds; without this the retry cannot tell that row from one that never
   * arrived, and puts the deleted book back.
   *
   * Only meaningful while `sampleBookSeeded` is unset, which is the whole
   * reason it is separate from it.
   */
  seededSampleIds?: string[]
  /** One-time hints the reader has already been shown, so each appears once. */
  seenHints?: Hint[]
}

/**
 * The library's “How Rami works” card, the retired note on a first thread
 * (kept so stored lists still parse), the note
 * when Rami first writes a book's memory, the reader's tap zones on a first
 * book, and the library's later note on the ⋯ menu.
 */
export type Hint = 'library' | 'thread' | 'memory' | 'reader' | 'shelf'

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  theme: 'light',
  fontSize: 100,
  readerFont: 'literata',
  highlightColor: 'yellow',
  spoilerGuard: true,
}
