import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getSettings } from '../db/db'
import { newId } from '../lib/id'
import { InferenceError, streamChat, type ChatActivity } from '../lib/inference'
import { buildMessages } from '../lib/prompt'
import { retireHint, useRetireOnceSeen, useUnseenHint } from '../lib/hints'
import { getBookMemory, updateBookMemory } from '../lib/memory'
import { mirrorThreads } from '../lib/threadMirror'
import { prefersShareSheet, shareContent, threadShare } from '../lib/share'
import { telemetry } from '../lib/telemetry'
import { durationBucket } from '../../shared/telemetrySchema'
import HintNote from './HintNote'
import ReaderPanel from './ReaderPanel'
import Passage from './Passage'
import Mark from './Mark'
import MarkdownReply from './MarkdownReply'
import { CopyIcon, LinkIcon, SendIcon, ShareIcon } from './Icons'
import PublishDialog from './PublishDialog'
import { button } from './ui'

/** Breathing room left above the pinned question, in pixels. */
const ANCHOR_GAP = 12

export default function ChatSheet({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  // A local agent's latest report, cleared whenever reply text arrives.
  const [activity, setActivity] = useState<ChatActivity | null>(null)
  const [started, setStarted] = useState(0)
  const [error, setError] = useState<string>()
  // The seed passage sits on one line until tapped, so the thread keeps the room.
  const [passageOpen, setPassageOpen] = useState(false)
  const [shareNote, setShareNote] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  // A desktop copies the thread rather than opening a share sheet.
  const sheet = prefersShareSheet()
  const abortRef = useRef<AbortController>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
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

  const conversation = useLiveQuery(() => db.conversations.get(conversationId), [conversationId])
  const messages = useLiveQuery(
    () => db.messages.where('conversationId').equals(conversationId).sortBy('createdAt'),
    [conversationId],
  )
  const book = useLiveQuery(
    () => (conversation ? db.books.get(conversation.bookId) : undefined),
    [conversation?.bookId],
  )

  const bookId = conversation?.bookId
  const hasMemory = useLiveQuery(
    async () => (bookId ? Boolean(await db.bookMemory.get(bookId)) : false),
    [bookId],
  )
  // Shown once Rami has written something down, which takes a few exchanges.
  const memoryHint = useUnseenHint('memory') && hasMemory === true

  // The hint gets one thread: closing the sheet it was seen in retires it.
  const memoryHintSeen = useRetireOnceSeen('memory', memoryHint)

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

  // The composer grows with its text until its max height, then scrolls. A
  // width change rewraps the text, so the panel resizing refits it too.
  useLayoutEffect(fitComposer, [draft])

  useEffect(() => {
    const box = composerRef.current
    if (!box) return
    let width = box.clientWidth
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return
      width = box.clientWidth
      fitComposer()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  function fitComposer() {
    const box = composerRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight}px`
  }

  /** Scrolls without tripping `handleScroll`, which watches for the reader. */
  function scrollList(list: HTMLDivElement, top: number) {
    list.scrollTop = top
    // Read back rather than storing `top`: the browser clamps to the content.
    setTopRef.current = list.scrollTop
  }

  // Any scroll this component did not perform is the reader taking over, and
  // the anchor gets out of the way for the rest of the turn and an opened
  // passage folds back to one line.
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const ours = setTopRef.current
    if (ours !== null && Math.abs(event.currentTarget.scrollTop - ours) <= 1) return
    pinnedRef.current = null
    setTopRef.current = null
    setPassageOpen(false)
  }

  // Built from what is already loaded, so the share sheet opens inside the tap.
  async function share() {
    if (!conversation || !messages || !book) return
    const content = threadShare(conversation, messages, book)
    const outcome = await shareContent(
      content,
      sheet ? undefined : { clipboard: navigator.clipboard },
    )
    if (outcome === 'copied') setShareNote('Copied to the clipboard.')
    else if (outcome === 'failed') setShareNote('Could not share this thread.')
    else setShareNote(undefined)
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || busy || !conversation) return

    setError(undefined)
    setBusy(true)
    setStarted(Date.now())

    const controller = new AbortController()
    abortRef.current = controller

    // Tracks how far we got, so a failure can put the reader back where they
    // were instead of stranding a question with no answer.
    let userMessageId: string | undefined
    const started = Date.now()
    let turn: 'first' | 'follow_up' = 'first'
    const track = (outcome: 'success' | 'failure' | 'canceled', err?: unknown) => {
      const failure = err === undefined ? undefined : telemetry.lastError()
      telemetry.capture('ai_message_sent', {
        outcome,
        turn,
        duration_bucket: durationBucket(Date.now() - started),
        error_category: failure?.category,
        http_status: failure?.status,
      })
    }

    try {
      const settings = await getSettings()

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
      if (history.some((message) => message.role === 'assistant')) turn = 'follow_up'

      let acc = ''
      const reply = await streamChat({
        signal: controller.signal,
        messages: buildMessages({ book, conversation, history, memory, settings }),
        onDelta: (delta) => {
          acc += delta
          setStreaming(acc)
          setActivity(null)
        },
        onActivity: setActivity,
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
        // Resolves even on failure, so a save problem can never undo the turn.
        void mirrorThreads([conversationId])
      }
      track('success')
    } catch (err) {
      // A canceled request keeps its question: the reader chose to stop, and
      // deleting what they typed would read as data loss. Any other failure
      // rolls the turn back so the transcript never shows a question that was
      // never actually asked, and hands the text back to the composer.
      if ((err as Error)?.name === 'AbortError') {
        track('canceled')
        return
      }
      telemetry.captureError('chat', 'send_message', err)
      track('failure', err)

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
      setActivity(null)
      setBusy(false)
      abortRef.current = null
    }
  }

  return (
    <ReaderPanel
      label={conversation?.title ?? 'Thread'}
      eyebrow={conversation?.chapter}
      title="Thread"
      closeLabel="Close thread"
      // Land on the composer: opening a chat to ask something and having to tab
      // past the close button first is the wrong default.
      initialFocus="textarea"
      compact
      wide
      zIndex="z-50"
      onClose={onClose}
    >
      {conversation?.seedText && (
        <Passage
          className="mx-5 mt-5 shrink-0"
          expanded={passageOpen}
          onToggle={() => setPassageOpen((open) => !open)}
          cite={
            conversation.progress !== undefined
              ? `${Math.round(conversation.progress * 100)}% through the book`
              : undefined
          }
        >
          {conversation.seedText}
        </Passage>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // Browser scroll anchoring would compete with the pin above, moving
        // the view on its own as the reply grows.
        style={{ overflowAnchor: 'none' }}
        className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-5"
      >
        {messages?.length === 0 && !streaming && (
          <p className="mt-6 text-center font-ui text-body text-ink-soft">
            Wonder aloud about this passage, or say what struck you.
          </p>
        )}

        {messages?.map((message) => (
          <Bubble key={message.id} id={message.id} role={message.role}>
            {message.content}
          </Bubble>
        ))}

        {streaming && <Bubble role="assistant">{streaming}</Bubble>}

        {memoryHint && bookId && (
          <HintNote
            label="Rami's memory"
            onDismiss={() => void retireHint('memory', 'dismissed')}
            onSeen={memoryHintSeen}
          >
            Rami has started a memory of this book from your threads and brings it into every
            thread.{' '}
            <Link
              to={`/book/${bookId}/chats?tab=memory`}
              onClick={() => {
                void retireHint('memory', 'link')
                // Closes the sheet too, for when it is already open on that page.
                onClose()
              }}
              className="text-moss underline underline-offset-2"
            >
              Read or edit it under Memory
            </Link>
            .
          </HintNote>
        )}

        {/* The stored reply can land a frame before `busy` clears. */}
        {busy && (!streaming || activity) && messages?.at(-1)?.role !== 'assistant' && (
          <ReplyProgress activity={activity} since={started} />
        )}

        {messages && messages.length > 0 && !busy && book && (
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <button onClick={() => void share()} className={button.quiet}>
              {sheet ? <ShareIcon /> : <CopyIcon />}
              {sheet ? 'Share thread' : 'Copy to clipboard'}
            </button>
            <button onClick={() => setPublishing(true)} className={button.quiet}>
              <LinkIcon />
              {conversation?.published ? 'Published link' : 'Publish link'}
            </button>
            <span aria-live="polite" className="font-ui text-meta text-ink-soft">
              {shareNote}
            </span>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-danger bg-paper p-3 font-ui text-meta text-danger">
            {error}
          </div>
        )}
      </div>

      <form
        className="mx-4 mb-[max(1rem,env(safe-area-inset-bottom))] flex shrink-0 items-end gap-2 rounded-lg border border-rule-strong bg-paper-leaf py-1.5 pr-1.5 pl-3.5 shadow-leaf focus-within:border-focus focus-within:ring-1 focus-within:ring-focus"
        onSubmit={(e) => {
          e.preventDefault()
          void send(draft)
        }}
      >
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(draft)
            }
          }}
          rows={1}
          placeholder={messages?.length ? 'Keep going…' : 'What caught your eye?'}
          aria-label="Your note"
          className="max-h-[40dvh] min-h-8 flex-1 resize-none bg-transparent py-2 font-ui text-control text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={!draft.trim() || busy}
          aria-label="Send"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-moss text-on-moss transition-colors duration-150 hover:bg-moss-deep disabled:opacity-45"
        >
          <SendIcon className="h-4.5 w-4.5" />
        </button>
      </form>

      {publishing && conversation && messages && book && (
        <PublishDialog
          conversation={conversation}
          messages={messages}
          book={book}
          onClose={() => setPublishing(false)}
        />
      )}
    </ReaderPanel>
  )
}

/** Seconds of waiting before the elapsed time is shown. */
const ELAPSED_AFTER_S = 3

function progressLabel(activity: ChatActivity | null): string {
  if (activity?.kind === 'tool') {
    return `Using ${activity.server}: ${activity.tool.replace(/[_-]+/g, ' ')}…`
  }
  if (activity?.kind === 'thinking') return 'Thinking…'
  return 'Following the thread…'
}

/** Shows the reply is still coming, and what a local agent is doing meanwhile. */
function ReplyProgress({ activity, since }: { activity: ChatActivity | null; since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.floor((now - since) / 1000)
  return (
    <p className="flex items-center gap-2 font-ui text-body text-ink-faint italic">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-moss" />
      <span role="status">{progressLabel(activity)}</span>
      {seconds >= ELAPSED_AFTER_S && (
        <span aria-hidden className="text-meta not-italic tabular-nums">
          {seconds}s
        </span>
      )}
    </p>
  )
}

function Bubble({ id, role, children }: { id?: string; role: string; children: string }) {
  if (role === 'user') {
    return (
      <div data-message={id} className="flex justify-end">
        <p className="max-w-[85%] rounded-[8px_8px_3px_8px] bg-moss px-3.5 py-2.5 font-ui text-[18px] leading-[26px] whitespace-pre-wrap text-on-moss">
          {children}
        </p>
      </div>
    )
  }

  // The conversation's voice, not in a bubble: a marginal note beside the mark.
  return (
    <div data-message={id} className="flex max-w-reading items-start gap-3">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-paper-sunk"
      >
        <Mark size={18} decorative />
      </span>
      <MarkdownReply>{children}</MarkdownReply>
    </div>
  )
}
