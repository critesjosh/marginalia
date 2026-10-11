import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Contents } from 'epubjs'
import { archiveBook, db, deleteBook, getSettings, saveSettings } from '../db/db'
import { DEFAULT_SETTINGS, type Conversation, type Highlight, type ReaderTheme } from '../db/types'
import { useReader } from '../lib/useReader'
import { useThemeColor } from '../lib/useThemeColor'
import { THEMES } from '../lib/themes'
import { newId } from '../lib/id'
import {
  contextAround,
  paintHighlight,
  selectionRect,
  selectionText,
  unpaintHighlight,
  type SelectionRect,
} from '../lib/highlights'
import { titleFromSeed } from '../lib/prompt'
import TocDrawer from '../components/TocDrawer'
import DisplaySheet from '../components/DisplaySheet'
import SelectionBar from '../components/SelectionBar'
import ChatSheet from '../components/ChatSheet'
import RemoveBookDialog from '../components/RemoveBookDialog'
import Ribbon from '../components/Ribbon'
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
  const [chromeVisible, setChromeVisible] = useState(true)
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

  const toggleChrome = useCallback(() => {
    setActive(undefined)
    setChromeVisible((v) => !v)
  }, [])

  const handleSelected = useCallback((cfiRange: string, contents: Contents) => {
    const rect = selectionRect(contents, cfiRange)
    const text = selectionText(contents, cfiRange)
    if (!rect || !text) return
    setActive({ cfiRange, text, rect, contents })
  }, [])

  const reader = useReader(bookId, viewer, {
    theme: settings.theme,
    fontSize: settings.fontSize,
    font: settings.readerFont,
    onTapCenter: toggleChrome,
    onSelected: handleSelected,
  })

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
  // let it go if the turn left its section (and so its document) behind.
  const locationCfi = reader.location?.cfi
  useEffect(() => {
    setActive((current) => {
      if (!current?.contents) return current
      const rect = selectionRect(current.contents, current.cfiRange)
      return rect ? { ...current, rect } : undefined
    })
  }, [locationCfi])

  // Deep link from the highlights list: jump once, then drop the param so a
  // later page turn isn't undone by a re-render.
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
    await db.highlights.add(highlight)
    clearSelection()
    setActive(undefined)
    return highlight
  }

  async function deleteHighlight() {
    if (!active?.highlight || !reader.rendition) return
    unpaintHighlight(reader.rendition, active.highlight.cfiRange)
    await db.highlights.delete(active.highlight.id)
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

  async function copySelection() {
    if (!active) return
    try {
      await navigator.clipboard.writeText(active.text)
    } catch {
      // Clipboard blocked; nothing useful to show for a copy failure.
    }
    clearSelection()
    setActive(undefined)
  }

  const chromeClasses = useMemo(
    () =>
      chromeVisible
        ? 'translate-y-0 opacity-100'
        : 'pointer-events-none -translate-y-full opacity-0',
    [chromeVisible],
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

  return (
    <div
      data-theme={palette.dataTheme}
      className="relative h-full overflow-hidden bg-paper text-ink"
    >
      <header
        className={`pt-safe no-select absolute inset-x-0 top-0 z-30 border-b border-rule bg-paper transition-all duration-300 ease-out motion-reduce:translate-y-0 ${chromeClasses}`}
      >
        <div className="grid h-14 grid-cols-[1fr_auto] items-center gap-2 px-2.5 sm:h-[70px] sm:grid-cols-[1fr_auto_1fr] sm:px-6">
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

      {/* epub.js renders its iframe here; it owns all touch/selection inside. */}
      <div ref={setViewer} className="mx-auto h-full w-full max-w-[760px]" />

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
        className={`pb-safe no-select absolute inset-x-0 bottom-0 z-30 border-t border-rule bg-paper transition-all duration-300 ease-out motion-reduce:translate-y-0 ${
          chromeVisible ? 'opacity-100' : 'pointer-events-none translate-y-full opacity-0'
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
          onCopy={() => void copySelection()}
          onDelete={() => void deleteHighlight()}
          onDismiss={() => {
            clearSelection()
            setActive(undefined)
          }}
          onTurn={(direction) => (direction === 'next' ? reader.next() : reader.prev())}
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

const pageTurn =
  'grid h-11 w-14 place-items-center rounded-full text-ink-soft transition-colors duration-150 hover:bg-paper-sunk hover:text-ink'

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-paper p-6 text-center font-ui text-body text-ink-soft">
      <p>{children}</p>
    </div>
  )
}
