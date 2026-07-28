import { useEffect, useRef, useState } from 'react'
import type { Book as EpubBook, Rendition, NavItem, Contents } from 'epubjs'
import ePub from 'epubjs'
import type { ReaderTheme } from '../db/types'
import { db } from '../db/db'
import { epubThemeStyles } from './themes'
import { buildAnchors, chapterAt, normalizeHref, type ChapterAnchor } from './chapters'

export interface ReaderLocation {
  cfi: string
  href: string
  chapter?: string
  /** TOC href of the current chapter, including its `#anchor` if it has one. */
  chapterHref?: string
  progress: number
}

export interface UseReaderOptions {
  theme: ReaderTheme
  fontSize: number
  /** Fires when the user selects text inside the book iframe. */
  onSelected?: (cfiRange: string, contents: Contents) => void
  /** Fires on a tap in the middle of the page (used to toggle chrome). */
  onTapCenter?: () => void
}

export interface ReaderApi {
  rendition?: Rendition
  epub?: EpubBook
  toc: NavItem[]
  location?: ReaderLocation
  ready: boolean
  error?: string
  next: () => void
  prev: () => void
  goTo: (target: string) => void
}

const THEME_NAME = 'marginalia'

/**
 * Owns the epub.js Book + Rendition lifecycle for one book id.
 *
 * It deliberately takes an id rather than a Book record: the record is read
 * through useLiveQuery, which hands back a new object (and a new file Blob
 * reference) after every write. Since this hook writes the reading position on
 * every relocate, depending on the record would rebuild the rendition in a loop.
 */
export function useReader(
  bookId: string | undefined,
  container: HTMLElement | null,
  options: UseReaderOptions,
): ReaderApi {
  const [rendition, setRendition] = useState<Rendition>()
  const [epub, setEpub] = useState<EpubBook>()
  const [toc, setToc] = useState<NavItem[]>([])
  const [location, setLocation] = useState<ReaderLocation>()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()

  // Keep callbacks and the TOC in refs so re-renders don't tear down the rendition.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const tocRef = useRef<NavItem[]>([])
  tocRef.current = toc
  const anchorCache = useRef(new Map<string, ChapterAnchor[]>())

  useEffect(() => {
    // `container` is a state-held element, not a ref: the viewer div mounts a
    // render after the page first paints, and the effect must re-run when it does.
    if (!bookId || !container) return

    let cancelled = false
    let epubBook: EpubBook | undefined
    let rend: Rendition | undefined
    setReady(false)
    setError(undefined)
    anchorCache.current.clear()

    const start = async () => {
      try {
        const stored = await db.books.get(bookId)
        if (cancelled) return
        if (!stored) {
          setError('That book is no longer in your library.')
          return
        }

        const buffer = await stored.file.arrayBuffer()
        if (cancelled) return

        epubBook = ePub(buffer)
        await epubBook.ready
        if (cancelled) return

        const nav = await epubBook.loaded.navigation
        if (cancelled) return
        setToc(nav.toc ?? [])

        rend = epubBook.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
          manager: 'default',
          allowScriptedContent: true,
        })

        const opts = optionsRef.current
        rend.themes.register(THEME_NAME, epubThemeStyles(opts.theme))
        rend.themes.select(THEME_NAME)
        rend.themes.fontSize(`${opts.fontSize}%`)

        await rend.display(stored.lastCfi || undefined)
        if (cancelled) return

        setEpub(epubBook)
        setRendition(rend)
        setReady(true)

        // The first paint can drift as images load; re-anchor once it settles.
        if (stored.lastCfi) {
          const target = stored.lastCfi
          void waitForIdleLayout(rend).then(() => {
            if (!cancelled) return rend?.display(target)
          })
        }

        // Locations power the progress percentage. Generating them walks the
        // whole book, so reuse the cached copy whenever we have one.
        void loadLocations(epubBook, bookId, stored.locations, () => cancelled)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not open this book.')
      }
    }

    void start()

    return () => {
      cancelled = true
      setRendition(undefined)
      setEpub(undefined)
      setReady(false)
      try {
        rend?.destroy()
        epubBook?.destroy()
      } catch {
        // epub.js can throw if it is torn down mid-load; nothing to recover.
      }
    }
  }, [bookId, container])

  // Track position and persist it.
  useEffect(() => {
    if (!rendition || !epub || !bookId) return

    const handler = (loc: {
      start?: { cfi: string; href: string; percentage?: number }
      end?: { cfi: string }
    }) => {
      const cfi = loc?.start?.cfi
      const href = loc?.start?.href
      if (!cfi || !href) return

      let progress = 0
      try {
        progress = epub.locations?.length()
          ? epub.locations.percentageFromCfi(cfi)
          : (loc.start?.percentage ?? 0)
      } catch {
        progress = loc.start?.percentage ?? 0
      }

      const anchors = anchorsForHref(rendition, tocRef.current, href, anchorCache.current)
      // Match on the end of the page, not the start: when a chapter heading sits
      // partway down the page, the reader sees the new chapter even though the
      // page still opens with the tail of the previous one.
      const chapter = chapterAt(anchors, loc.end?.cfi ?? cfi)
      setLocation({ cfi, href, chapter: chapter?.label, chapterHref: chapter?.href, progress })
      void db.books.update(bookId, { lastCfi: cfi, progress, lastOpenedAt: Date.now() })
    }

    rendition.on('relocated', handler)
    return () => {
      rendition.off('relocated', handler)
    }
  }, [rendition, epub, bookId])

  // Selection, taps, and keyboard navigation inside the book iframe.
  useEffect(() => {
    if (!rendition) return

    const onSelected = (cfiRange: string, contents: Contents) => {
      optionsRef.current.onSelected?.(cfiRange, contents)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') void rendition.next()
      if (event.key === 'ArrowLeft') void rendition.prev()
    }

    // epub.js re-emits clicks from inside the iframe with page coordinates.
    const onClick = (event: MouseEvent) => {
      const width = container?.clientWidth ?? window.innerWidth
      const x = event.clientX
      if (x < width * 0.28) void rendition.prev()
      else if (x > width * 0.72) void rendition.next()
      else optionsRef.current.onTapCenter?.()
    }

    rendition.on('selected', onSelected)
    rendition.on('keyup', onKeyUp)
    rendition.on('click', onClick)
    document.addEventListener('keyup', onKeyUp)

    return () => {
      rendition.off('selected', onSelected)
      rendition.off('keyup', onKeyUp)
      rendition.off('click', onClick)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [rendition, container])

  // Theme and font size can change without rebuilding the rendition.
  useEffect(() => {
    if (!rendition) return
    rendition.themes.register(THEME_NAME, epubThemeStyles(options.theme))
    rendition.themes.select(THEME_NAME)
    rendition.themes.fontSize(`${options.fontSize}%`)
    // Re-selecting a theme does not always repaint the current page.
    try {
      const current = rendition.currentLocation() as unknown as {
        start?: { cfi?: string }
      }
      if (current?.start?.cfi) void rendition.display(current.start.cfi)
    } catch {
      // Ignore: the rendition may not have a location yet.
    }
  }, [rendition, options.theme, options.fontSize])

  return {
    rendition,
    epub,
    toc,
    location,
    ready,
    error,
    next: () => void rendition?.next(),
    prev: () => void rendition?.prev(),
    goTo: (target: string) => void goToSettled(rendition, target),
  }
}

/**
 * Displays a target, then displays it again once layout settles.
 *
 * Books that put every chapter in one large XHTML file (Gutenberg's do) are
 * paginated into thousands of columns. Images and fonts that finish loading
 * after the first display reflow those columns, which drifts the requested
 * anchor several chapters off-screen. Re-displaying against the settled layout
 * lands on the right page.
 */
async function goToSettled(rendition: Rendition | undefined, target: string) {
  if (!rendition) return
  try {
    await rendition.display(target)
    await waitForIdleLayout(rendition)
    await rendition.display(target)
  } catch {
    // Unresolvable target (stale href or broken CFI); leave the view as-is.
  }
}

async function waitForIdleLayout(rendition: Rendition) {
  const contents = rendition.getContents() as unknown as Contents[] | Contents
  const current = (Array.isArray(contents) ? contents : [contents]).find((c) => c?.document)
  const doc = current?.document
  if (!doc) return

  const pending = [...doc.images].filter((img) => !img.complete)
  await Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = () => resolve()
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        }),
    ),
  )
  // Let the renderer finish its own reflow pass before measuring again.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)))
}

async function loadLocations(
  epubBook: EpubBook,
  bookId: string,
  cached: string | undefined,
  isCancelled: () => boolean,
) {
  try {
    if (cached) {
      epubBook.locations.load(cached)
      return
    }
    await epubBook.locations.generate(1024)
    if (isCancelled()) return
    await db.books.update(bookId, { locations: epubBook.locations.save() })
  } catch {
    // Progress falls back to the per-section percentage.
  }
}

/**
 * Resolves the TOC anchors for the currently rendered document, memoized per
 * href. Resolving anchors to CFIs touches the DOM once per chapter, which is
 * too expensive to redo on every page turn in a 135-chapter single-file book.
 */
function anchorsForHref(
  rendition: Rendition,
  toc: NavItem[],
  href: string,
  cache: Map<string, ChapterAnchor[]>,
): ChapterAnchor[] {
  const key = normalizeHref(href)
  const cached = cache.get(key)
  if (cached) return cached

  // Single-spread paginated mode renders one section at a time.
  const contents = rendition.getContents() as unknown as Contents[] | Contents
  const current = (Array.isArray(contents) ? contents : [contents]).find((c) => c?.document)
  if (!current) return []

  const anchors = buildAnchors(toc, href, current)
  cache.set(key, anchors)
  return anchors
}
