import { useCallback, useEffect, useRef, useState } from 'react'
import type { Book as EpubBook, Rendition, NavItem, Contents } from 'epubjs'
import ePub from 'epubjs'
import type { ReaderTheme } from '../db/types'
import { db } from '../db/db'
import { epubThemeStyles } from './themes'
import { buildAnchors, chapterAt, normalizeHref, type ChapterAnchor } from './chapters'
import { longPressToSelect } from './touchSelect'
import {
  ReadingActivityTracker,
  recordReadingActivity,
  type ReadingIntent,
  type ReadingSnapshot,
} from '../sync/reading'

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
  /** Claims the in-flight tap so it does not also turn the page. */
  suppressTap: () => void
}

const THEME_NAME = 'marginalia'

/**
 * How long to let a burst of `resize` events finish before re-anchoring.
 * epub.js throttles its own resize handling to 50ms, and a phone's address bar
 * animating away produces a run of them.
 */
const RESIZE_SETTLE_MS = 150

/**
 * How long to keep ignoring relocations after re-anchoring, so the one caused
 * by the re-anchor itself is not mistaken for the reader turning a page.
 * epub.js reports a location from a `requestAnimationFrame` after the display
 * promise has already resolved.
 */
const REANCHOR_RELEASE_MS = 250

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
  const suppressTapUntil = useRef(0)

  // The position the reader actually chose, held across every reflow.
  const anchorCfi = useRef<string | undefined>(undefined)
  // Non-zero while a reflow is being re-anchored; see `relocated` below.
  const holds = useRef(0)
  // Bumped by every deliberate move. A pending re-anchor checks it and gives
  // up: a reader who turns a page while the layout is still settling means to
  // be on the new page, not to be put back on the old one.
  const navEpoch = useRef(0)
  const readingTracker = useRef<ReadingActivityTracker | undefined>(undefined)
  const latestReading = useRef<ReadingSnapshot | undefined>(undefined)
  const readingWrites = useRef<Promise<void>>(Promise.resolve())

  const persistReading = useCallback(
    (snapshot: ReadingSnapshot, intents: readonly ReadingIntent[], at: number) => {
      if (!bookId) return
      readingWrites.current = readingWrites.current
        .catch(() => {
          // Keep later positions writable after an isolated IndexedDB failure.
        })
        .then(() => recordReadingActivity(bookId, snapshot, intents, at))
    },
    [bookId],
  )

  const supersede = useCallback(() => {
    navEpoch.current += 1
    holds.current = 0
  }, [])

  useEffect(() => {
    // `container` is a state-held element, not a ref: the viewer div mounts a
    // render after the page first paints, and the effect must re-run when it does.
    if (!bookId || !container) return

    let cancelled = false
    let epubBook: EpubBook | undefined
    let rend: Rendition | undefined
    let releaseHold = 0
    const detachTouch = new Set<() => void>()
    setReady(false)
    setError(undefined)
    anchorCache.current.clear()
    anchorCfi.current = undefined
    holds.current = 0

    const start = async () => {
      try {
        const stored = await db.books.get(bookId)
        if (cancelled) return
        if (!stored) {
          setError('That book is no longer in your library.')
          return
        }
        // Removed but kept: the notes are still here, the EPUB is not.
        if (!stored.file) {
          setError('That book was removed from your library. Import the EPUB again to read it.')
          return
        }

        readingTracker.current = new ReadingActivityTracker({
          lastOpenedAt: stored.lastOpenedAt,
          progress: stored.progress,
        })
        latestReading.current = undefined

        // Claim the saved position before anything can render: a resize that
        // arrives while the book is still opening has to re-anchor to it too.
        anchorCfi.current = stored.lastCfi || undefined

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
          // Deliberately left off. epub.js turns this into
          // sandbox="allow-same-origin allow-scripts" on the content iframe,
          // which is the combination that voids the sandbox: a book's own
          // scripts would then run on this origin and could read the API key
          // and every highlight and conversation straight out of IndexedDB.
          // Scripted EPUBs lose interactivity; the text still renders.
          allowScriptedContent: false,
        })

        // Registered before the first display so section one gets it too.
        rend.hooks.content.register((contents: Contents) => {
          detachTouch.add(longPressToSelect(contents))
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
        // Hold the saved position for the whole wait, or the short landing that
        // the first paint reports would be written back over it.
        if (stored.lastCfi) {
          const target = stored.lastCfi
          const epoch = navEpoch.current
          holds.current += 1
          void waitForIdleLayout(rend)
            .then(() =>
              cancelled || navEpoch.current !== epoch ? undefined : rend?.display(target),
            )
            .finally(() => {
              // Released on a timer for the same reason as after a resize: the
              // relocation this re-display triggers reports a column boundary
              // at or before the saved position, and saving that would cost a
              // page every time the book is opened.
              releaseHold = window.setTimeout(() => {
                if (!cancelled) holds.current = Math.max(0, holds.current - 1)
              }, REANCHOR_RELEASE_MS)
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
      const snapshot = latestReading.current
      const tracker = readingTracker.current
      if (snapshot && tracker) {
        const at = Date.now()
        persistReading(snapshot, tracker.close(snapshot, at, 'navigated_away'), at)
      }
      readingTracker.current = undefined
      latestReading.current = undefined
      cancelled = true
      window.clearTimeout(releaseHold)
      setRendition(undefined)
      setEpub(undefined)
      setReady(false)
      for (const detach of detachTouch) detach()
      detachTouch.clear()
      try {
        rend?.destroy()
        epubBook?.destroy()
      } catch {
        // epub.js can throw if it is torn down mid-load; nothing to recover.
      }
    }
  }, [bookId, container, persistReading])

  // Track position and persist it.
  useEffect(() => {
    if (!rendition || !epub || !bookId) return

    const handler = (loc: {
      start?: { cfi: string; href: string; percentage?: number }
      end?: { cfi: string }
    }) => {
      snapToPage(container, rendition)

      const reported = loc?.start?.cfi
      const href = loc?.start?.href
      if (!reported || !href) return

      // While a reflow is being re-anchored, believe the anchor rather than the
      // report. epub.js answers a resize by rebuilding the view and displaying
      // into a layout that has not settled, and it resolves the CFI it is given
      // to a column with Math.floor, so what comes back is at or before where
      // the reader actually is. Recording it is what makes the loss permanent:
      // it becomes the anchor for the next reflow, and a handful of address-bar
      // collapses walk the book back to the start of the chapter. A CFI is a
      // position in the document, not a pixel offset, so the anchor stays true
      // across any number of reflows.
      const anchor = holds.current > 0 ? anchorCfi.current : undefined
      const holding = anchor !== undefined
      const cfi = anchor ?? reported
      if (!holding) anchorCfi.current = cfi

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
      //
      // From the report even while held, unlike the position above. The two
      // answer different questions: the position is where the reader is and has
      // to survive a reflow that has not settled, while the label names what is
      // on the screen, and the report is the only thing that describes that. The
      // anchor is a page *start*, so labelling from it breaks the rule above and
      // names the previous chapter — and it sticks, because once the hold
      // releases nothing relocates again until the reader turns a page.
      const chapter = chapterAt(anchors, loc.end?.cfi ?? cfi)
      const nextLocation = {
        cfi,
        href,
        chapter: chapter?.label,
        chapterHref: chapter?.href,
        progress,
      }
      setLocation(nextLocation)

      const snapshot: ReadingSnapshot = { cfi, progress, chapter: chapter?.label }
      latestReading.current = snapshot
      const at = Date.now()
      // No tracker means the book is being torn down and its session is already
      // closed: epub.js can still relocate on the way out. Keep the position,
      // emit nothing, so teardown never reopens what the cleanup just closed.
      const tracker = readingTracker.current
      const intents =
        tracker && document.visibilityState !== 'hidden' ? tracker.observe(snapshot, at) : []
      persistReading(snapshot, intents, at)
    }

    rendition.on('relocated', handler)
    return () => {
      rendition.off('relocated', handler)
    }
  }, [rendition, epub, bookId, container, persistReading])

  // Close a reading session while the page is backgrounded and reopen it when
  // the reader returns. pagehide covers browser teardown paths that do not
  // reliably dispatch visibilitychange first.
  useEffect(() => {
    if (!bookId) return

    const close = (reason: 'backgrounded' | 'navigated_away') => {
      const snapshot = latestReading.current
      const tracker = readingTracker.current
      if (!snapshot || !tracker) return
      const at = Date.now()
      persistReading(snapshot, tracker.close(snapshot, at, reason), at)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        close('backgrounded')
        return
      }
      const snapshot = latestReading.current
      const tracker = readingTracker.current
      if (!snapshot || !tracker) return
      const at = Date.now()
      persistReading(snapshot, tracker.open(snapshot, at), at)
    }

    const onPageHide = () => close('navigated_away')
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [bookId, persistReading])

  // Put the reader back on their page after the viewport changes size.
  useEffect(() => {
    if (!rendition) return

    let settleTimer = 0
    let releaseTimer = 0
    let held = false

    const release = () => {
      if (!held) return
      held = false
      holds.current = Math.max(0, holds.current - 1)
    }

    const onResized = () => {
      const target = anchorCfi.current
      if (!target) return

      // One hold for the whole burst. A phone's address bar sliding away fires
      // `resize` repeatedly, and epub.js re-displays on every one of them.
      if (!held) {
        held = true
        holds.current += 1
      }
      const epoch = navEpoch.current
      window.clearTimeout(settleTimer)
      window.clearTimeout(releaseTimer)
      settleTimer = window.setTimeout(() => {
        if (navEpoch.current !== epoch) {
          release()
          return
        }
        void goToSettled(rendition, target).finally(() => {
          // Stay held a moment longer, so the relocation our own re-display
          // triggers goes by unrecorded. epub.js resolves a CFI to a column
          // with Math.floor, so it reports back up to a page short of the CFI
          // it was handed; adopting that would concede a page on every resize,
          // and phones resize constantly. The anchor is a document position,
          // not a pixel offset, so it stays true across any number of reflows.
          releaseTimer = window.setTimeout(release, REANCHOR_RELEASE_MS)
        })
      }, RESIZE_SETTLE_MS)
    }

    rendition.on('resized', onResized)
    return () => {
      rendition.off('resized', onResized)
      window.clearTimeout(settleTimer)
      window.clearTimeout(releaseTimer)
      release()
    }
  }, [rendition])

  // Selection, taps, and keyboard navigation inside the book iframe.
  useEffect(() => {
    if (!rendition) return

    const onSelected = (cfiRange: string, contents: Contents) => {
      optionsRef.current.onSelected?.(cfiRange, contents)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        supersede()
        void rendition.next()
      }
      if (event.key === 'ArrowLeft') {
        supersede()
        void rendition.prev()
      }
    }

    const onClick = (event: MouseEvent) => {
      const scroller = container?.querySelector('.epub-container') as HTMLElement | null
      const width = scroller?.clientWidth || container?.clientWidth || window.innerWidth

      // epub.js re-emits clicks from inside the book iframe, and that iframe is
      // as wide as the whole paginated strip rather than the visible page. Its
      // clientX therefore counts from the start of the section, so on any page
      // but the first it is far larger than the viewport and every tap reads as
      // "right edge". Subtracting the scroll offset puts it back in page space.
      const x = event.clientX - (scroller?.scrollLeft ?? 0)

      // The click that finishes a drag-selection is not a page turn.
      const selection = (event.target as Node | null)?.ownerDocument?.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return

      // A tap on a highlight rides the same DOM event: marks-pane hand-proxies
      // mouse events to its annotations, so both handlers see this click and the
      // order between them is not guaranteed. Defer the turn by a task to let an
      // annotation callback claim the tap first.
      window.setTimeout(() => {
        if (Date.now() < suppressTapUntil.current) return
        if (x < width * 0.28) {
          supersede()
          void rendition.prev()
        } else if (x > width * 0.72) {
          supersede()
          void rendition.next()
        } else optionsRef.current.onTapCenter?.()
      }, 0)
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
  }, [rendition, container, supersede])

  // Theme and font size can change without rebuilding the rendition.
  useEffect(() => {
    if (!rendition) return
    rendition.themes.register(THEME_NAME, epubThemeStyles(options.theme))
    rendition.themes.select(THEME_NAME)
    rendition.themes.fontSize(`${options.fontSize}%`)
    // Re-selecting a theme does not always repaint the current page, and a font
    // size change repaginates the section under the reader. Both need the
    // position put back, and the held anchor is the one to put it back to:
    // `currentLocation` reports where the unchanged scroll offset lands in the
    // new pagination, which is not where the reader was.
    try {
      const current = rendition.currentLocation() as unknown as {
        start?: { cfi?: string }
      }
      const target = anchorCfi.current ?? current?.start?.cfi
      if (target) void rendition.display(target)
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
    next: () => {
      supersede()
      void rendition?.next()
    },
    prev: () => {
      supersede()
      void rendition?.prev()
    },
    goTo: (target: string) => {
      supersede()
      void goToSettled(rendition, target)
    },
    suppressTap: () => {
      suppressTapUntil.current = Date.now() + 400
    },
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

/** Single-spread paginated mode renders one section at a time. */
function currentContents(rendition: Rendition): Contents | undefined {
  const contents = rendition.getContents() as unknown as Contents[] | Contents
  if (!contents) return undefined
  return (Array.isArray(contents) ? contents : [contents]).find((c) => c?.document)
}

/**
 * Re-aligns the paginated strip to a column boundary.
 *
 * epub.js turns a page with `scrollLeft += layout.delta`, never with an absolute
 * position, and a phone's compositor rounds each of those writes to whole device
 * pixels. At a device pixel ratio of 2.625 that discards up to a third of a CSS
 * pixel per turn, and nothing re-anchors it, so a few hundred turns leave the
 * viewport straddling two columns: half of one page beside half of the next.
 * The same drift is why a table-of-contents jump lands short of its chapter --
 * epub.js resolves the anchor to `floor(x / delta) * delta`, which is only the
 * right column while `delta` still matches the pitch the browser laid out.
 *
 * Snapping after every relocation makes the error absolute rather than
 * cumulative, so it can never exceed a single turn.
 */
function snapToPage(container: HTMLElement | null, rendition: Rendition) {
  const scroller = container?.querySelector('.epub-container') as HTMLElement | null
  if (!scroller) return

  // The body box is one column plus its gap, which is exactly the scroll pitch.
  // Read it from the rendered document rather than from `layout.delta`, since
  // the drift being corrected is precisely the two disagreeing.
  const body = currentContents(rendition)?.document?.body
  const pitch = body?.getBoundingClientRect().width || scroller.clientWidth
  if (!pitch) return

  const snapped = Math.min(
    Math.round(scroller.scrollLeft / pitch) * pitch,
    scroller.scrollWidth - scroller.clientWidth,
  )
  if (Math.abs(snapped - scroller.scrollLeft) < 0.5) return
  scroller.scrollLeft = snapped
}

/** Longest we will wait on images before repositioning anyway. */
const LAYOUT_SETTLE_TIMEOUT_MS = 3000

async function waitForIdleLayout(rendition: Rendition) {
  const doc = currentContents(rendition)?.document
  if (!doc) return

  const pending = [...doc.images].filter((img) => !img.complete)

  // A stalled remote image would otherwise hold this promise open forever, and
  // with it the document and rendition, long after the reader has navigated
  // away. Settling late is better than never settling.
  await Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            const done = () => {
              img.removeEventListener('load', done)
              img.removeEventListener('error', done)
              resolve()
            }
            img.addEventListener('load', done, { once: true })
            img.addEventListener('error', done, { once: true })
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, LAYOUT_SETTLE_TIMEOUT_MS)),
  ])

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

  const current = currentContents(rendition)
  if (!current) return []

  const anchors = buildAnchors(toc, href, current)
  cache.set(key, anchors)
  return anchors
}
