/**
 * Sends threads to the paired bridge, which keeps a Markdown copy of each in
 * the folder the reader gave it as `--save-dir` (decision 0011). A one-way
 * mirror: nothing here reads back from disk or touches the database.
 *
 * Saving never interrupts chat. Every call resolves, and the last outcome is
 * kept for Settings to show.
 */

import { db } from '../db/db'
import { bridgeFetch, checkBridge, localAgentState } from './localAgent'

export type MirrorStatus =
  | { kind: 'idle' }
  | { kind: 'saving'; done: number; total: number }
  | { kind: 'saved'; at: number; count: number }
  | { kind: 'failed'; at: number; message: string }

/** Only these fields leave the browser; never whole rows or publishing tokens. */
interface ThreadExport {
  book: { id: string; title: string; author: string }
  thread: {
    id: string
    title: string
    chapter?: string
    progress?: number
    passage?: string
    createdAt: number
    updatedAt: number
  }
  turns: { role: 'user' | 'assistant'; content: string; createdAt: number }[]
}

const SAVE_TIMEOUT_MS = 15_000
/** How long a status check's answer about the save folder is trusted. */
const FOLDER_CHECK_MS = 60_000

let status: MirrorStatus = { kind: 'idle' }
const listeners = new Set<() => void>()

export function mirrorStatus(): MirrorStatus {
  return status
}

export function subscribeMirror(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function report(next: MirrorStatus) {
  status = next
  for (const listener of listeners) listener()
}

let folder: { token: string; saveDir: string | null; at: number } | null = null

/**
 * Whether the paired bridge saves threads, asked at most once a minute. A
 * bridge that cannot be reached is an error, not a "no", so Settings says so.
 */
async function bridgeSaves(token: string): Promise<boolean | { error: string }> {
  if (folder?.token === token && Date.now() - folder.at < FOLDER_CHECK_MS) {
    return folder.saveDir !== null
  }
  const check = await checkBridge(token, AbortSignal.timeout(SAVE_TIMEOUT_MS))
  if (!check.ok) return { error: check.message }
  folder = { token, saveDir: check.status.saveDir ?? null, at: Date.now() }
  return folder.saveDir !== null
}

async function exportThread(conversationId: string): Promise<ThreadExport | null> {
  const conversation = await db.conversations.get(conversationId)
  if (!conversation) return null
  const [book, messages] = await Promise.all([
    db.books.get(conversation.bookId),
    db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
  ])
  if (!book) return null
  return {
    book: { id: book.id, title: book.title, author: book.author },
    thread: {
      id: conversation.id,
      title: conversation.title,
      chapter: conversation.chapter,
      progress: conversation.progress,
      passage: conversation.seedText,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    turns: messages.flatMap(({ role, content, createdAt }) =>
      role === 'user' || role === 'assistant' ? [{ role, content, createdAt }] : [],
    ),
  }
}

/** Saves one thread. A newer copy already on disk is fine; any other refusal is not. */
async function saveOne(token: string, conversationId: string): Promise<string | null> {
  const thread = await exportThread(conversationId)
  if (!thread) return null
  const response = await bridgeFetch(`/v1/threads/${encodeURIComponent(conversationId)}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(thread),
    signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
  })
  if (response.ok) return null
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; code?: string }
  } | null
  if (response.status === 409 && body?.error?.code === 'stale') return null
  return body?.error?.message ?? `The bridge could not save a thread (${response.status}).`
}

/**
 * Saves these threads one at a time, if the reader is paired with a bridge
 * that has a save folder. Resolves either way; Settings shows the outcome.
 */
export async function mirrorThreads(conversationIds: string[]): Promise<MirrorStatus> {
  const agent = localAgentState()
  if (agent.kind !== 'paired' || conversationIds.length === 0) return status
  try {
    const saves = await bridgeSaves(agent.token)
    if (typeof saves === 'object') {
      report({ kind: 'failed', at: Date.now(), message: saves.error })
      return status
    }
    if (!saves) return status
    const total = conversationIds.length
    for (const [done, id] of conversationIds.entries()) {
      if (total > 1) report({ kind: 'saving', done, total })
      const failure = await saveOne(agent.token, id)
      if (failure) {
        report({ kind: 'failed', at: Date.now(), message: failure })
        return status
      }
    }
    report({ kind: 'saved', at: Date.now(), count: total })
  } catch {
    folder = null
    report({
      kind: 'failed',
      at: Date.now(),
      message: "Rami couldn't reach the bridge to save threads. Is it still running?",
    })
  }
  return status
}

/** Copies every thread, oldest first, so the folder catches up after pairing. */
export async function saveAllThreads(): Promise<MirrorStatus> {
  const conversations = await db.conversations.orderBy('updatedAt').primaryKeys()
  folder = null
  return mirrorThreads(conversations)
}
