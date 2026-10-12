/**
 * Sharing a highlight, a thread or a book out of the app: through the system share
 * sheet where there is one, otherwise to the clipboard. Every share carries
 * the book it came from and a line naming the app, so it leads back here.
 */

import type { Book, Conversation, Message } from '../db/types'

const APP_NAME = 'Rami'
export const APP_URL = 'https://rami.agenticpossible.com'

const SIGNATURE = `Read with ${APP_NAME}: ${APP_URL}`

type BookInfo = Pick<Book, 'title' | 'author'>

export interface ShareContent {
  /** Used by targets that take a subject, such as email. */
  title: string
  text: string
  /** What the clipboard gets when there is no share sheet, if not `text`. */
  copyText?: string
}

/** `shared` went to the share sheet, `copied` to the clipboard. */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed'

type ShareHost = {
  share?: (data: ShareData) => Promise<void>
  canShare?: (data: ShareData) => boolean
  clipboard?: Pick<Clipboard, 'writeText'>
}

/** "Moby Dick by Herman Melville, Chapter 1. Loomings" */
function source(book: BookInfo, chapter?: string): string {
  const byline = book.author ? `${book.title} by ${book.author}` : book.title
  // Table-of-contents labels often end in a period, which reads badly mid-sentence.
  const label = chapter?.trim().replace(/[.,;:]+$/, '')
  return label ? `${byline}, ${label}` : byline
}

/** Wraps a passage in quotes, unless it already opens with one of its own. */
function quote(passage: string): string {
  const text = passage.trim()
  return /^[“"‘']/.test(text) ? text : `“${text}”`
}

export function highlightShare(passage: string, book: BookInfo, chapter?: string): ShareContent {
  return {
    title: `From ${book.title}`,
    text: `${quote(passage)}\n\n${source(book, chapter)}\n\n${SIGNATURE}`,
  }
}

export function threadShare(
  conversation: Pick<Conversation, 'title' | 'seedText' | 'chapter'>,
  messages: Pick<Message, 'role' | 'content'>[],
  book: BookInfo,
): ShareContent {
  const parts = [`A conversation about ${source(book, conversation.chapter)}`]
  if (conversation.seedText) parts.push(quote(conversation.seedText))
  for (const message of messages) {
    if (message.role === 'system') continue
    const speaker = message.role === 'user' ? 'Me' : APP_NAME
    parts.push(`${speaker}: ${message.content.trim()}`)
  }
  parts.push(SIGNATURE)
  return { title: conversation.title, text: parts.join('\n\n') }
}

/** A published thread's link, introduced by what it is about. */
export function linkShare(
  conversation: Pick<Conversation, 'title' | 'chapter'>,
  book: BookInfo,
  url: string,
): ShareContent {
  return {
    title: conversation.title,
    text: `A conversation about ${source(book, conversation.chapter)}, on ${APP_NAME}: ${url}`,
    // Copying is for pasting the link, so it gets the bare URL.
    copyText: url,
  }
}

/** An invitation to read a book, with the link that adds it. */
export function bookShare(book: BookInfo, url: string): ShareContent {
  return {
    title: book.title,
    text: `I’m reading ${source(book)} on ${APP_NAME}. Read it with me: ${url}`,
  }
}

/**
 * Whether to offer the system share sheet. Phones and tablets get one; on a
 * desktop, where a link is pasted into an email or a chat, copying is quicker
 * than a sheet, even in browsers that have one.
 */
export function prefersShareSheet(host: Pick<Window, 'matchMedia'> = globalThis): boolean {
  return host.matchMedia?.('(pointer: coarse)').matches ?? false
}

/**
 * Opens the share sheet, or copies when there is none. Call it straight from
 * the click handler: browsers refuse `share()` once the tap's activation has
 * been spent on an earlier await.
 */
export async function shareContent(
  content: ShareContent,
  host: ShareHost = globalThis.navigator,
): Promise<ShareOutcome> {
  if (host.share && (host.canShare?.(content) ?? true)) {
    try {
      await host.share(content)
      return 'shared'
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return 'cancelled'
      // Anything else (no activation, a blocked target): copy instead.
    }
  }
  if (!host.clipboard) return 'failed'
  try {
    await host.clipboard.writeText(content.copyText ?? content.text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
