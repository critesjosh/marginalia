import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings } from '../db/db'
import type { ReaderTheme } from '../db/types'
import { newId } from '../lib/id'
import { InferenceError, streamChat, targetFor } from '../lib/inference'
import { buildMessages } from '../lib/prompt'
import { getBookMemory, updateBookMemory } from '../lib/memory'
import { THEMES } from '../lib/themes'
import { useModal } from '../lib/useModal'
import { CloseIcon, SendIcon } from './Icons'

/** Breathing room left above the pinned question, in pixels. */
const ANCHOR_GAP = 12

export default function ChatSheet({
  conversationId,
  theme,
  onClose,
}: {
  conversationId: string
  theme: ReaderTheme
  onClose: () => void
}) {
  const palette = THEMES[theme]
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const abortRef = useRef<AbortController>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The message the view is anchored to, or null when the reader is in charge.
  // A turn pins the question that started it just under the top edge, so the
  // answer fills the space below it instead of hauling the viewport down behind
  // every token — chasing the newest word makes the top of a long reply
  // unreadable, which is the whole point of the anchor.
  const pinnedRef = useRef<string | null>(null)
  // The last offset this component set, so `handleScroll` can tell its own work
  // apart from the reader scrolling away.
  const setTopRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  // Land on the composer: opening a chat to ask something and having to tab
  // past the close button first is the wrong default.
  const sheetRef = useModal<HTMLElement>(onClose, 'textarea')

  const conversation = useLiveQuery(
    () => db.conversations.get(conversationId),
    [conversationId],
  )
  const messages = useLiveQuery(
    () => db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
    [conversationId],
  )

  // Opening a conversation lands on its most recent message. Only once: every
  // later move is either the anchor below or the reader's own scrolling.
  useLayoutEffect(() => {
    const list = scrollRef.current
    if (!messages || !list || openedRef.current) return
    openedRef.current = true
    scrollList(list, list.scrollHeight)
  }, [messages])

  // Hold the pinned question in place as the answer grows under it. Before the
  // reply is long enough to fill the sheet this can only scroll as far as the
  // content allows, so the question rises to the top over the first few tokens
  // and then stays put for the rest of the turn. Runs before paint so the text
  // never appears at one offset and jumps to another.
  useLayoutEffect(() => {
    const list = scrollRef.current
    if (!list || !pinnedRef.current) return

    const anchor = list.querySelector<HTMLElement>(`[data-message="${pinnedRef.current}"]`)
    if (!anchor) return

    const offset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top
    scrollList(list, list.scrollTop + offset - ANCHOR_GAP)
  }, [messages, streaming, busy, error])

  // The stored reply and the streaming buffer hold the same text. Dropping the
  // buffer in the frame the message lands keeps the answer from being painted
  // twice, which would shove everything above it down half a sheet.
  useLayoutEffect(() => {
    if (messages?.at(-1)?.role === 'assistant') setStreaming('')
  }, [messages])

  useEffect(() => () => abortRef.current?.abort(), [])

  /** Scrolls without tripping `handleScroll`, which watches for the reader. */
  function scrollList(list: HTMLDivElement, top: number) {
    list.scrollTop = top
    // Read back rather than storing `top`: the browser clamps to the content.
    setTopRef.current = list.scrollTop
  }

  // Any scroll this component did not perform is the reader taking over, and
  // the anchor gets out of the way for the rest of the turn.
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const ours = setTopRef.current
    if (ours !== null && Math.abs(event.currentTarget.scrollTop - ours) <= 1) return
    pinnedRef.current = null
    setTopRef.current = null
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || busy || !conversation) return

    setError(undefined)
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    // Tracks how far we got, so a failure can put the reader back where they
    // were instead of stranding a question with no answer.
    let userMessageId: string | undefined

    try {
      const settings = await getSettings()
      // Throws only when the reader chose their own key and has not entered
      // one; the built-in provider needs nothing. Thrown here rather than
      // before the try so a missing key rolls the turn back like any other
      // failure, keeping the question in the composer.
      const target = targetFor(settings)

      // Only clear the composer once the message is safely stored. Clearing it
      // first loses the text outright if IndexedDB rejects the write.
      userMessageId = newId()
      await db.messages.add({
        id: userMessageId,
        conversationId,
        role: 'user',
        content,
        createdAt: Date.now(),
      })
      await db.conversations.update(conversationId, { updatedAt: Date.now() })
      // Anchor on the question rather than the reply: it is the last thing that
      // stops growing, and reading an answer starts from what was asked.
      pinnedRef.current = userMessageId
      setDraft('')

      const [book, history, memory] = await Promise.all([
        db.books.get(conversation.bookId),
        db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
        getBookMemory(conversation.bookId),
      ])
      if (!book) throw new Error('This book is no longer in your library.')

      let acc = ''
      const reply = await streamChat({
        target,
        signal: controller.signal,
        messages: buildMessages({ book, conversation, history, memory, settings }),
        onDelta: (delta) => {
          acc += delta
          setStreaming(acc)
        },
      })

      if (reply.text.trim()) {
        await db.messages.add({
          id: newId(),
          conversationId,
          role: 'assistant',
          content: reply.text,
          source: reply.source,
          createdAt: Date.now(),
        })
        await db.conversations.update(conversationId, { updatedAt: Date.now() })
        void updateBookMemory(conversation.bookId, conversationId)
      }
    } catch (err) {
      // A cancelled request keeps its question: the reader chose to stop, and
      // deleting what they typed would read as data loss. Any other failure
      // rolls the turn back so the transcript never shows a question that was
      // never actually asked, and hands the text back to the composer.
      if ((err as Error)?.name === 'AbortError') return

      if (userMessageId) {
        await db.messages.delete(userMessageId).catch(() => {})
      }
      setDraft((current) => (current.trim() ? current : content))
      setError(
        err instanceof InferenceError || err instanceof Error
          ? err.message
          : 'Something went wrong talking to the model.',
      )
    } finally {
      // The anchor deliberately outlives the turn. Storing the reply, dropping
      // the buffer and clearing `busy` land in whatever order Dexie's live
      // query and this continuation happen to interleave, and holding the
      // question through all of them is what keeps that settling invisible.
      // The reader's next scroll releases it.
      setStreaming('')
      setBusy(false)
      abortRef.current = null
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />

      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={conversation?.title ?? 'Conversation'}
        className={`relative flex h-[85%] flex-col rounded-t-2xl border-t ${palette.chrome} ${palette.chromeText} ${palette.border} shadow-2xl`}
      >
        <header className={`flex items-start gap-2 border-b px-4 py-3 ${palette.border}`}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {conversation?.title ?? 'Conversation'}
            </p>
            {conversation?.chapter && (
              <p className="truncate text-xs opacity-55">{conversation.chapter}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close chat"
            className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center opacity-70"
          >
            <CloseIcon />
          </button>
        </header>

        {conversation?.seedText && (
          <blockquote
            className={`mx-4 mt-3 shrink-0 border-l-2 py-1 pl-3 text-xs leading-relaxed opacity-70`}
            style={{ borderColor: palette.link }}
          >
            <span className="line-clamp-3">{conversation.seedText}</span>
          </blockquote>
        )}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          // Browser scroll anchoring would compete with the pin above, moving
          // the view on its own as the reply grows.
          style={{ overflowAnchor: 'none' }}
          className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4"
        >
          {messages?.length === 0 && !streaming && (
            <p className="mt-6 text-center text-sm opacity-50">
              Ask about this passage, or just say what you think.
            </p>
          )}

          {messages?.map((message) => (
            <Bubble
              key={message.id}
              id={message.id}
              role={message.role}
              source={message.source}
              theme={theme}
            >
              {message.content}
            </Bubble>
          ))}

          {streaming && (
            <Bubble role="assistant" theme={theme}>
              {streaming}
            </Bubble>
          )}

          {busy && !streaming && <p className="text-sm opacity-50">Thinking…</p>}

          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">
              {error}
              {error.includes('Settings') && (
                <>
                  {' '}
                  <Link to="/settings" className="underline">
                    Open settings
                  </Link>
                </>
              )}
            </div>
          )}
        </div>

        <form
          className={`pb-safe flex shrink-0 items-end gap-2 border-t px-3 pt-3 ${palette.border}`}
          onSubmit={(e) => {
            e.preventDefault()
            void send(draft)
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(draft)
              }
            }}
            rows={1}
            placeholder="Ask about this passage…"
            className={`max-h-32 min-h-11 flex-1 resize-none rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none ${palette.border}`}
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            aria-label="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-stone-950 disabled:opacity-40"
          >
            <SendIcon className="h-4.5 w-4.5" />
          </button>
        </form>
      </section>
    </div>
  )
}

function Bubble({
  id,
  role,
  source,
  theme,
  children,
}: {
  id?: string
  role: string
  source?: string
  theme: ReaderTheme
  children: React.ReactNode
}) {
  const palette = THEMES[theme]
  const isUser = role === 'user'

  return (
    <div
      data-message={id}
      className={isUser ? 'flex justify-end' : 'flex flex-col items-start'}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser ? 'text-stone-950' : `border ${palette.border}`
        }`}
        style={isUser ? { background: palette.link } : undefined}
      >
        {children}
      </div>
      {/* Small enough to read past, there when an answer needs explaining. */}
      {source && <p className="mt-1 pl-1 text-[11px] opacity-40">{source}</p>}
    </div>
  )
}
