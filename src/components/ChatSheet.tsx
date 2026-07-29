import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages?.length, streaming])

  useEffect(() => () => abortRef.current?.abort(), [])

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

      if (reply.trim()) {
        await db.messages.add({
          id: newId(),
          conversationId,
          role: 'assistant',
          content: reply,
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

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
          {messages?.length === 0 && !streaming && (
            <p className="mt-6 text-center text-sm opacity-50">
              Ask about this passage, or just say what you think.
            </p>
          )}

          {messages?.map((message) => (
            <Bubble key={message.id} role={message.role} theme={theme}>
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
  role,
  theme,
  children,
}: {
  role: string
  theme: ReaderTheme
  children: React.ReactNode
}) {
  const palette = THEMES[theme]
  const isUser = role === 'user'

  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser ? 'text-stone-950' : `border ${palette.border}`
        }`}
        style={isUser ? { background: palette.link } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
