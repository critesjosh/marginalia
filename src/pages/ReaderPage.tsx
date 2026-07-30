import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Contents } from 'epubjs'
import { db, getSettings, saveSettings } from '../db/db'
import {
  DEFAULT_SETTINGS,
  type Conversation,
  type Highlight,
  type HighlightColor,
  type ReaderTheme,
} from '../db/types'
import { useReader } from '../lib/useReader'
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
import { ensureBookIndex } from '../lib/bookIndex/build'
import TocDrawer from '../components/TocDrawer'
import DisplaySheet from '../components/DisplaySheet'
import SelectionBar from '../components/SelectionBar'
import ChatSheet from '../components/ChatSheet'
import { BackIcon, ChatIcon, ListIcon, TypeIcon } from '../components/Icons'

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
  const [viewer, setViewer] = useState<HTMLDivElement | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [panel, setPanel] = useState<'toc' | 'display' | null>(null)
  const [active, setActive] = useState<ActiveSelection>()
  const [chatId, setChatId] = useState<string>()
  const [searchParams, setSearchParams] = useSearchParams()

  const book = useLiveQuery(() => (bookId ? db.books.get(bookId) : undefined), [bookId])
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
    onTapCenter: toggleChrome,
    onSelected: handleSelected,
  })

  const palette = THEMES[settings.theme]
  const percent = Math.round((reader.location?.progress ?? book?.progress ?? 0) * 100)
  const isDark = settings.theme === 'dark'

  // Keep the painted annotations in sync with stored highlights. epub.js has no
  // "replace all", so track what we painted and repaint on any change.
  const painted = useRef<string[]>([])
  useEffect(() => {
    const rendition = reader.rendition
    if (!rendition || !highlights) return

    for (const cfiRange of painted.current) unpaintHighlight(rendition, cfiRange)
    painted.current = []

    for (const highlight of highlights) {
      paintHighlight(rendition, highlight.id, highlight.cfiRange, highlight.color, isDark, () =>
        openHighlight(highlight),
      )
      painted.current.push(highlight.cfiRange)
    }
    // `openHighlight` is stable enough for this effect; re-running on every
    // render would make highlights flicker on each page turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader.rendition, highlights, isDark, reader.ready])

  // Index the book once it is open and on screen. Deliberately after `ready`:
  // extraction parses every spine document on this thread, and doing that while
  // epub.js is still laying out the first page competes with the reader for it.
  useEffect(() => {
    if (!bookId || !reader.ready || !settings.bookIndex) return
    const started = window.setTimeout(() => void ensureBookIndex(bookId), 1500)
    return () => window.clearTimeout(started)
  }, [bookId, reader.ready, settings.bookIndex])

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
   * also where recolouring and deleting live.
   */
  function openHighlight(highlight: Highlight) {
    reader.suppressTap()

    void (async () => {
      const existing = await db.conversations
        .where('highlightId')
        .equals(highlight.id)
        .first()

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

  async function saveHighlight(color: HighlightColor): Promise<Highlight | undefined> {
    if (!active || !bookId) return undefined

    if (active.highlight) {
      await db.highlights.update(active.highlight.id, { color })
      setActive(undefined)
      return { ...active.highlight, color }
    }

    const highlight: Highlight = {
      id: newId(),
      bookId,
      cfiRange: active.cfiRange,
      text: active.text,
      sectionHref: reader.location?.href,
      context: active.contents ? contextAround(active.contents, active.cfiRange) : undefined,
      chapter: reader.location?.chapter,
      progress: reader.location?.progress,
      color,
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

    const highlight = active.highlight ?? (await saveHighlight('yellow'))
    if (!highlight) return

    const existing = await db.conversations
      .where('highlightId')
      .equals(highlight.id)
      .first()

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
      // Where this chat sits in the book, exactly. The index compares CFIs to
      // decide what the reader has already read, and a percentage cannot.
      seedCfi: highlight.cfiRange,
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
        <Link to="/" className="text-amber-500 underline">
          Back to library
        </Link>
      </CenteredNote>
    )
  }

  return (
    <div
      className="relative h-full overflow-hidden"
      style={{ background: palette.bg, color: palette.fg }}
    >
      <header
        className={`pt-safe no-select absolute inset-x-0 top-0 z-30 border-b transition-all duration-200 ${palette.chrome} ${palette.border} ${chromeClasses}`}
      >
        <div className="flex items-center gap-1 px-2 pb-2">
          <Link to="/" aria-label="Back to library" className="rounded-lg p-2.5 opacity-80">
            <BackIcon />
          </Link>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-sm font-medium">{book.title}</p>
            <p className="truncate text-xs opacity-55">
              {reader.location?.chapter ?? book.author}
            </p>
          </div>
          <Link
            to={`/book/${book.id}/chats`}
            aria-label="Conversations and highlights"
            className="rounded-lg p-2.5 opacity-80"
          >
            <ChatIcon />
          </Link>
          <button
            onClick={() => setPanel('toc')}
            aria-label="Table of contents"
            className="rounded-lg p-2.5 opacity-80"
          >
            <ListIcon />
          </button>
          <button
            onClick={() => setPanel('display')}
            aria-label="Display settings"
            className="rounded-lg p-2.5 opacity-80"
          >
            <TypeIcon />
          </button>
        </div>
      </header>

      {/* epub.js renders its iframe here; it owns all touch/selection inside. */}
      <div ref={setViewer} className="h-full w-full" />

      {!reader.ready && !reader.error && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ background: palette.bg }}
        >
          <p className="text-sm opacity-60">Opening “{book.title}”…</p>
        </div>
      )}

      {reader.error && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
          style={{ background: palette.bg }}
        >
          <p className="text-sm opacity-80">{reader.error}</p>
          <Link to="/" className="text-sm underline" style={{ color: palette.link }}>
            Back to library
          </Link>
        </div>
      )}

      <footer
        className={`pb-safe no-select absolute inset-x-0 bottom-0 z-30 transition-all duration-200 ${palette.chrome} ${
          chromeVisible ? 'opacity-100' : 'pointer-events-none translate-y-full opacity-0'
        }`}
      >
        <div className="h-0.5 w-full bg-current/10">
          <div
            className="h-full transition-[width] duration-300"
            style={{ width: `${percent}%`, background: palette.link }}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-2 text-xs opacity-60">
          <button onClick={reader.prev} className="-my-1 px-4 py-3">
            ‹ Prev
          </button>
          <span>{percent}%</span>
          <button onClick={reader.next} className="-my-1 px-4 py-3">
            Next ›
          </button>
        </div>
      </footer>

      {active && (
        <SelectionBar
          rect={active.rect}
          theme={settings.theme}
          existing={Boolean(active.highlight)}
          onHighlight={(color) => void saveHighlight(color)}
          onChat={() => void startChat()}
          onCopy={() => void copySelection()}
          onDelete={() => void deleteHighlight()}
          onDismiss={() => {
            clearSelection()
            setActive(undefined)
          }}
        />
      )}

      {panel === 'toc' && (
        <TocDrawer
          toc={reader.toc}
          theme={settings.theme}
          currentChapterHref={reader.location?.chapterHref}
          onSelect={(href) => {
            reader.goTo(href)
            setPanel(null)
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {chatId && (
        <ChatSheet
          conversationId={chatId}
          theme={settings.theme}
          onClose={() => setChatId(undefined)}
        />
      )}

      {panel === 'display' && (
        <DisplaySheet
          theme={settings.theme}
          fontSize={settings.fontSize}
          onChange={(patch) => void saveSettings(patch as { theme?: ReaderTheme; fontSize?: number })}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  )
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-stone-950 p-6 text-center text-sm text-stone-400">
      <p>{children}</p>
    </div>
  )
}
