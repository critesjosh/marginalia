import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Contents } from 'epubjs'
import { archiveBook, db, deleteBook, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS, type Conversation, type Highlight, type ReaderTheme } from '../db/types'
import { retireHint, useUnseenHint } from '../lib/hints'
import { useReader } from '../lib/useReader'
import { useThemeColor } from '../lib/useThemeColor'
import { THEMES } from '../lib/themes'
import { newId } from '../lib/id'
import { isSampleBookId } from '../lib/sampleBook'
import { telemetry } from '../lib/telemetry'
import { lengthBucket } from '../../shared/telemetrySchema'
import {
  contextAround,
  paintHighlight,
  selectionRect,
  selectionText,
  unpaintHighlight,
  type SelectionRect,
} from '../lib/highlights'
import { titleFromSeed } from '../lib/prompt'
import { highlightShare, shareContent } from '../lib/share'
import TocDrawer from '../components/TocDrawer'
import DisplaySheet from '../components/DisplaySheet'
import SelectionBar from '../components/SelectionBar'
import ChatSheet from '../components/ChatSheet'
import RemoveBookDialog from '../components/RemoveBookDialog'
import Ribbon from '../components/Ribbon'
import TapZonesHint from '../components/TapZonesHint'
import { BackIcon, ChatIcon, ListIcon, TypeIcon } from '../components/Icons'
import { iconButton } from '../components/ui'

/** A pending selection, or an existing highlight the reader tapped. */
interface ActiveSelection {
  cfiRange: string
  text: string
  rect: SelectionRect
  contents?: Contents
  highlight?: Highlight
}

export default function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [viewer, setViewer] = useState<HTMLDivElement | null>(null)
  const [chromeVisible, setChromeVisible] = useState(false)
  // A mouse resting on the margin above or below the page shows the bars until
  // it leaves them; a tap or click still pins them open. The rest is a short
  // dwell, so a click on the margin reaches it before a bar slides over it.
  const [peeking, setPeeking] = useState(false)
  const peekTimer = useRef<number>(undefined)
  const barsVisible = chromeVisible || peeking
  const [panel, setPanel] = useState<'toc' | 'display' | null>(null)
  const [active, setActive] = useState<ActiveSelection>()
  const [chatId, setChatId] = useState<string>()
  const [removing, setRemoving] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  const book = useLiveQuery(
    () => (bookId ? db.books.get(bookId).then((found) => found ?? null) : null),
    [bookId],
  )
  const settings = useLiveQuery(() => getSettings(), []) ?? DEFAULT_SETTINGS
  const highlights = useLiveQuery(
    () => (bookId ? db.highlights.where('bookId').equals(bookId).toArray() : []),
    [bookId],
  )

  const stopPeeking = useCallback(() => {
    window.clearTimeout(peekTimer.current)
    setPeeking(false)
  }, [])
  const toggleChrome = useCallback(() => {
    setActive(undefined)
    stopPeeking()
    setChromeVisible((v) => !v)
  }, [stopPeeking])
  const peek = useCallback((event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    window.clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(() => setPeeking(true), PEEK_DELAY_MS)
  }, [])
  // Moving from a margin onto the bar sliding over it keeps them up.
  const unpeek = useCallback(
    (event: React.PointerEvent) => {
      const to = event.relatedTarget
      if (to instanceof Element && to.closest('[data-reader-bar]')) return
      stopPeeking()
    },
    [stopPeeking],
  )
  // A click on a bar that came up under the mouse keeps it up, as a margin click would.
  const pinChrome = useCallback(() => setChromeVisible(true), [])
  useEffect(() => () => window.clearTimeout(peekTimer.current), [])

  const handleSelected = useCallback((cfiRange: string, contents: Contents) => {
    const rect = selectionRect(contents, cfiRange)
    const text = selectionText(contents, cfiRange)
    if (!rect || !text) return
    telemetry.capture('text_selected', { length_bucket: lengthBucket(text.length) })
    setActive({ cfiRange, text, rect, contents })
  }, [])

  const reader = useReader(bookId, viewer, {
    theme: settings.theme,
    fontSize: settings.fontSize,
    font: settings.readerFont,
    onTapCenter: toggleChrome,
    onEscape: toggleChrome,
    onSelected: handleSelected,
  })

  // The first book opened maps its tap zones, once. Anything the reader does
  // retires the map, as does leaving the book or a few seconds' reading.
  const tapHint = useUnseenHint('reader') && reader.ready
  useEffect(() => {
    if (!tapHint) return
    const timer = window.setTimeout(() => void retireHint('reader', 'seen'), TAP_HINT_MS)
    return () => {
      window.clearTimeout(timer)
      void retireHint('reader', 'seen')
    }
  }, [tapHint])
  const interacted = barsVisible || Boolean(active || chatId || panel)
  useEffect(() => {
    if (tapHint && interacted) void retireHint('reader', 'seen')
  }, [tapHint, interacted])

  // Once per book open: the first time it renders, or the first time it fails.
  const openReported = useRef<string>(undefined)
  useEffect(() => {
    if (!bookId || openReported.current === bookId) return
    // A failure waits for the book record, which says whether it is just missing.
    if (!reader.ready && (!reader.error || book === undefined)) return
    openReported.current = bookId
    const book_kind = isSampleBookId(bookId) ? 'bundled' : 'imported'
    if (reader.ready) {
      telemetry.capture('reader_opened', { book_kind, outcome: 'success' })
      return
    }
    // A missing or removed book is not an error; anything else was captured as one.
    const missing = !book?.file
    telemetry.capture('reader_opened', {
      book_kind,
      outcome: 'failure',
      error_category: missing ? 'not_found' : (telemetry.lastError()?.category ?? 'unknown'),
    })
  }, [bookId, book, reader.ready, reader.error])

  const palette = THEMES[settings.theme]
  useThemeColor(palette.bg)
  const percent = Math.round((reader.location?.progress ?? book?.progress ?? 0) * 100)
  const isDark = settings.theme === 'dark'
  const highlightColor = settings.highlightColor
  const activeClass = 'bg-paper-sunk text-ink'
  const chatCount =
    useLiveQuery(
      () => (bookId ? db.conversations.where('bookId').equals(bookId).count() : 0),
      [bookId],
    ) ?? 0

  // Keep the painted annotations in sync with stored highlights. epub.js has no
  // "replace all", so track what we painted and repaint on any change.
  const painted = useRef<string[]>([])
  useEffect(() => {
    const rendition = reader.rendition
    if (!rendition || !highlights) return

    for (const cfiRange of painted.current) unpaintHighlight(rendition, cfiRange)
    painted.current = []

    for (const highlight of highlights) {
      paintHighlight(rendition, highlight.id, highlight.cfiRange, highlightColor, isDark, () =>
        openHighlight(highlight),
      )
      painted.current.push(highlight.cfiRange)
    }
    // `openHighlight` is stable enough for this effect; re-running on every
    // render would make highlights flicker on each page turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader.rendition, highlights, highlightColor, isDark, reader.ready])

  // A page turn under a live selection moves it; follow its visible part, and
  // close its bar once none of it is on the page. A tap that turned away from
  // it lets it go; a drag to the page edge goes on to extend it, reopening the bar.
  const locationCfi = reader.location?.cfi
  const tappedAway = useRef(false)
  useEffect(() => {
    const tapped = tappedAway.current
    tappedAway.current = false
    setActive((current) => {
      if (!current?.contents) return current
      const rect = selectionRect(current.contents, current.cfiRange)
      if (rect?.onPage) return { ...current, rect }
      if (tapped) current.contents.window?.getSelection()?.removeAllRanges()
      return undefined
    })
  }, [locationCfi])

  // Deep link from the highlights list (a CFI) or the library's first-run hint
  // (a TOC href): jump once, then drop the param so a later page turn isn't
  // undone by a re-render.
  const requestedCfi = searchParams.get('cfi')
  useEffect(() => {
    if (!requestedCfi || !reader.ready) return
    reader.goTo(requestedCfi)
    setSearchParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedCfi, reader.ready])

  function currentContents(): Contents | undefined {
    const contents = reader.rendition?.getContents() as unknown as Contents[] | Contents
    if (!contents) return undefined
    return (Array.isArray(contents) ? contents : [contents]).find((c) => c?.document)
  }

  /**
   * Tapping a highlight reopens the conversation it started, if there is one.
   * Highlights with no conversation fall back to the selection bar, which is
   * also where recoloring and deleting live.
   */
  function openHighlight(highlight: Highlight) {
    reader.suppressTap()

    void (async () => {
      const existing = await db.conversations.where('highlightId').equals(highlight.id).first()

      if (existing) {
        setActive(undefined)
        setChatId(existing.id)
        return
      }

      const contents = currentContents()
      const rect = contents && selectionRect(contents, highlight.cfiRange)
      if (!rect) return
      setActive({ cfiRange: highlight.cfiRange, text: highlight.text, rect, contents, highlight })
    })()
  }

  async function saveHighlight(): Promise<Highlight | undefined> {
    if (!active || !bookId) return undefined
    if (active.highlight) return active.highlight

    const highlight = await addHighlight('ask')
    clearSelection()
    setActive(undefined)
    return highlight
  }

  /** Saves the selection as a highlight, leaving the selection bar open. */
  async function keepHighlight() {
    const highlight = await addHighlight('highlight')
    if (!highlight) return
    // The reader may have moved on to another selection during the write.
    setActive((current) =>
      current?.cfiRange === highlight.cfiRange ? { ...current, highlight } : current,
    )
  }

  async function addHighlight(trigger: 'highlight' | 'ask'): Promise<Highlight | undefined> {
    if (!active || !bookId) return undefined
    const highlight: Highlight = {
      id: newId(),
      bookId,
      cfiRange: active.cfiRange,
      text: active.text,
      sectionHref: reader.location?.href,
      context: active.contents ? contextAround(active.contents, active.cfiRange) : undefined,
      chapter: reader.location?.chapter,
      progress: reader.location?.progress,
      color: highlightColor,
      createdAt: Date.now(),
    }
    try {
      await db.highlights.add(highlight)
    } catch (err) {
      telemetry.captureError('annotations', 'save_highlight', err)
      throw err
    }
    telemetry.capture('annotation_created', { trigger })
    return highlight
  }

  async function deleteHighlight() {
    if (!active?.highlight || !reader.rendition) return
    unpaintHighlight(reader.rendition, active.highlight.cfiRange)
    try {
      await db.highlights.delete(active.highlight.id)
    } catch (err) {
      telemetry.captureError('annotations', 'delete_highlight', err)
      throw err
    }
    telemetry.capture('annotation_deleted')
    setActive(undefined)
  }

  function clearSelection() {
    try {
      currentContents()?.window?.getSelection()?.removeAllRanges()
    } catch {
      // Selection already collapsed.
    }
  }

  /** Seeds a conversation from the current selection (creating the highlight). */
  async function startChat() {
    if (!active || !bookId) return

    const highlight = active.highlight ?? (await saveHighlight())
    if (!highlight) return

    const existing = await db.conversations.where('highlightId').equals(highlight.id).first()

    if (existing) {
      setActive(undefined)
      setChatId(existing.id)
      return
    }

    const conversation: Conversation = {
      id: newId(),
      bookId,
      highlightId: highlight.id,
      title: titleFromSeed(highlight.text),
      seedText: highlight.text,
      context: highlight.context,
      chapter: highlight.chapter ?? reader.location?.chapter,
      progress: highlight.progress ?? reader.location?.progress,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await db.conversations.add(conversation)
    setActive(undefined)
    setChatId(conversation.id)
  }

  /** Shares the passage and keeps it highlighted, as asking about it does. */
  function shareSelection() {
    if (!active || !book) return Promise.resolve('failed' as const)
    const chapter = active.highlight?.chapter ?? reader.location?.chapter
    // Started before any await, so the share sheet still has the tap's activation.
    const outcome = shareContent(highlightShare(active.text, book, chapter))
    if (!active.highlight) void keepHighlight()
    return outcome
  }

  const chromeClasses = useMemo(
    () =>
      barsVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0',
    [barsVisible],
  )

  if (bookId && book === undefined) {
    return <CenteredNote>Loading book…</CenteredNote>
  }
  if (!book) {
    return (
      <CenteredNote>
        That book is not in your library.{' '}
        <Link to="/" className="text-rubric underline underline-offset-2">
          Back to library
        </Link>
      </CenteredNote>
    )
  }
  if (book.archivedAt) {
    return (
      <CenteredNote>
        “{book.title}” was removed from your library. Import the EPUB again to keep reading, or open
        its{' '}
        <Link to={`/book/${book.id}/chats`} className="text-rubric underline underline-offset-2">
          conversations and memory
        </Link>
        .{' '}
        <Link to="/" className="text-rubric underline underline-offset-2">
          Back to library
        </Link>
        .
      </CenteredNote>
    )
  }
  if (book.missingFileAt) {
    return (
      <CenteredNote>
        This device lost the EPUB for “{book.title}”. Add the same EPUB again to keep reading. Your{' '}
        <Link to={`/book/${book.id}/chats`} className="text-rubric underline underline-offset-2">
          conversations and memory
        </Link>{' '}
        are still here.{' '}
        <Link to="/" className="text-rubric underline underline-offset-2">
          Back to library
        </Link>
        .
      </CenteredNote>
    )
  }

  return (
    <div
      data-theme={palette.dataTheme}
      className="relative h-full overflow-hidden bg-paper text-ink"
    >
      <header
        data-reader-bar
        onPointerLeave={unpeek}
        onClick={pinChrome}
        className={`pt-safe no-select absolute inset-x-0 top-0 z-30 border-b border-rule bg-paper transition-all duration-300 ease-out motion-reduce:translate-y-0 ${chromeClasses}`}
      >
        <div className="grid h-12 grid-cols-[1fr_auto] items-center gap-2 px-2.5 sm:h-14 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
          <div className="flex min-w-0 items-center gap-1">
            <Link to="/" aria-label="Back to library" className={iconButton}>
              <BackIcon />
            </Link>
            <div className="ml-1 min-w-0">
              <p className="truncate font-book text-[17px] leading-[22px] font-medium">
                {book.title}
              </p>
              <p className="truncate font-ui text-meta text-ink-soft">{book.author}</p>
            </div>
          </div>
          {reader.location?.chapter && (
            <p className="eyebrow hidden max-w-[28vw] truncate sm:block">
              {reader.location.chapter}
            </p>
          )}
          <div className="col-start-2 flex items-center justify-end gap-0.5 sm:col-start-3">
            <button
              onClick={() => setPanel('display')}
              aria-label="Reader settings"
              className={`${iconButton} ${panel === 'display' ? activeClass : ''}`}
            >
              <TypeIcon />
            </button>
            <button
              onClick={() => setPanel('toc')}
              aria-label="Table of contents"
              className={`${iconButton} ${panel === 'toc' ? activeClass : ''}`}
            >
              <ListIcon />
            </button>
            <Link
              to={`/book/${book.id}/chats`}
              aria-label="Threads and highlights"
              className="relative ml-1 flex min-h-tap items-center gap-2 rounded-md font-ui text-label font-medium text-ink transition-colors duration-150 hover:bg-paper-sunk sm:border sm:border-rule-strong sm:px-3.5"
            >
              <span className="grid h-11 w-11 place-items-center text-ink-soft sm:contents">
                <ChatIcon className="h-5 w-5" />
              </span>
              <span className="hidden sm:inline">Threads</span>
              {chatCount > 0 && (
                <span className="absolute top-0.5 right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-sm bg-rubric px-1 font-ui text-caption font-medium text-paper-leaf sm:static">
                  {chatCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </header>

      {/* Blank margins the bars cover, so they never hide text. A tap shows the bars. */}
      <div className="mx-auto flex h-full w-full max-w-[760px] flex-col">
        <button
          onClick={toggleChrome}
          onPointerEnter={peek}
          onPointerLeave={unpeek}
          tabIndex={-1}
          aria-hidden
          className="reader-inset-top no-select"
        />
        {/* epub.js renders its iframe here; it owns all touch/selection inside. */}
        <div ref={setViewer} className="min-h-0 w-full flex-1" />
        <button
          onClick={toggleChrome}
          onPointerEnter={peek}
          onPointerLeave={unpeek}
          tabIndex={-1}
          aria-hidden
          className="reader-inset-bottom no-select"
        />
      </div>

      {/* Wide screens leave gutters beside the capped column; they turn pages
          like the edges of the book itself. The footer has the labeled controls. */}
      {(['prev', 'next'] as const).map((side) => (
        <button
          key={side}
          onClick={side === 'prev' ? reader.prev : reader.next}
          tabIndex={-1}
          aria-hidden
          className={`no-select absolute inset-y-0 z-20 hidden w-[calc((100%-760px)/2)] items-center font-book text-[32px] text-ink-faint transition-colors duration-150 hover:text-ink-soft min-[761px]:flex ${
            side === 'prev' ? 'left-0 justify-end pr-6' : 'right-0 justify-start pl-6'
          }`}
        >
          {side === 'prev' ? '‹' : '›'}
        </button>
      ))}

      {tapHint && <TapZonesHint />}

      {!reader.ready && !reader.error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-paper">
          <p className="font-ui text-body text-ink-soft italic">Opening “{book.title}”…</p>
        </div>
      )}

      {reader.error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
          <p className="max-w-reading font-ui text-body text-danger">{reader.error}</p>
          <Link to="/" className="font-ui text-label text-moss underline underline-offset-2">
            Back to library
          </Link>
        </div>
      )}

      <footer
        data-reader-bar
        onPointerLeave={unpeek}
        onClick={pinChrome}
        className={`pb-safe no-select absolute inset-x-0 bottom-0 z-30 border-t border-rule bg-paper transition-all duration-300 ease-out motion-reduce:translate-y-0 ${
          barsVisible ? 'opacity-100' : 'pointer-events-none translate-y-full opacity-0'
        }`}
      >
        <div className="flex items-center justify-center gap-3 px-2">
          <button onClick={reader.prev} aria-label="Previous page" className={pageTurn}>
            <BackIcon className="h-[18px] w-[18px]" />
          </button>
          <Ribbon progress={percent} className="w-40 sm:w-56" />
          <button onClick={reader.next} aria-label="Next page" className={pageTurn}>
            <BackIcon className="h-[18px] w-[18px] rotate-180" />
          </button>
        </div>
      </footer>

      {active && (
        <SelectionBar
          rect={active.rect}
          existing={Boolean(active.highlight)}
          onChat={() => void startChat()}
          onShare={shareSelection}
          onDelete={() => void deleteHighlight()}
          onDismiss={() => {
            clearSelection()
            setActive(undefined)
          }}
          onTurn={(direction) => {
            tappedAway.current = true
            if (direction === 'next') reader.next()
            else reader.prev()
          }}
          page={viewer}
        />
      )}

      {panel === 'toc' && (
        <TocDrawer
          toc={reader.toc}
          bookTitle={book.title}
          currentChapterHref={reader.location?.chapterHref}
          onSelect={(href) => {
            reader.goTo(href)
            setPanel(null)
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {chatId && <ChatSheet conversationId={chatId} onClose={() => setChatId(undefined)} />}

      {panel === 'display' && (
        <DisplaySheet
          theme={settings.theme}
          fontSize={settings.fontSize}
          progress={percent}
          onChange={(patch) =>
            void saveSettings(patch as { theme?: ReaderTheme; fontSize?: number })
          }
          onRemoveBook={() => {
            setPanel(null)
            setRemoving(true)
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {removing && (
        <RemoveBookDialog
          book={book}
          onCancel={() => setRemoving(false)}
          onRemove={async (choice) => {
            if (choice === 'keep') await archiveBook(book.id)
            else await deleteBook(book.id)
            // The book being read is gone either way, so there is nothing left
            // on this route to return to.
            navigate('/', { replace: true })
          }}
        />
      )}
    </div>
  )
}

const TAP_HINT_MS = 6000
const PEEK_DELAY_MS = 150

const pageTurn =
  'grid h-11 w-14 place-items-center rounded-full text-ink-soft transition-colors duration-150 hover:bg-paper-sunk hover:text-ink'

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-paper p-6 text-center font-ui text-body text-ink-soft">
      <p>{children}</p>
    </div>
  )
}
