import { useCallback, useEffect, useRef, useState } from 'react'
import type { Book as EpubBook, Rendition, NavItem, Contents } from 'epubjs'
import ePub from 'epubjs'
import type { ReaderFont, ReaderTheme } from '../db/types'
import { db } from '../db/db'
import { epubThemeStyles } from './themes'
import { buildAnchors, chapterAt, normalizeHref, type ChapterAnchor } from './chapters'
import { LONG_PRESS_MS, MOVE_TOLERANCE_PX, longPressToSelect } from './touchSelect'
import { TAP_TURN_ZONE, mouseEdgeTurn, type TurnPage } from './selectionEdge'
import { keepFrameInPlace, neutralizeScripts } from './bookScripts'
import { readBookFile } from './storedFile'
import { telemetry } from './telemetry'

interface ReaderLocation {
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
  font: ReaderFont
  /** Fires when the user selects text inside the book iframe. */
  onSelected?: (cfiRange: string, contents: Contents) => void
  /** Fires on a tap in the middle of the page (used to toggle chrome). */
  onTapCenter?: () => void
  /** Fires on Escape, in the book or around it, when no dialog claims it first. */
  onEscape?: () => void
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

/** How long after a touch a click is the browser's echo of it, not a new tap. */
const GHOST_CLICK_MS = 800

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

  const supersede = useCallback(() => {
    navEpoch.current += 1
    holds.current = 0
  }, [])

  // Takes a hold and returns its release. A move zeroes the count, so a hold
  // taken before it must not decrement one taken after it.
  const hold = useCallback(() => {
    const epoch = navEpoch.current
    let held = true
    holds.current += 1
    return () => {
      if (!held) return
      held = false
      if (navEpoch.current === epoch) holds.current = Math.max(0, holds.current - 1)
    }
  }, [])

  useEffect(() => {
    // `container` is a state-held element, not a ref: the viewer div mounts a
    // render after the page first paints, and the effect must re-run when it does.
    if (!bookId || !container) return

    let canceled = false
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
        if (canceled) return
        if (!stored) {
          setError('That book is no longer in your library.')
          return
        }
        // Removed but kept: the notes are still here, the EPUB is not.
        if (!stored.file) {
          setError('That book was removed from your library. Import the EPUB again to read it.')
          return
        }

        // Claim the saved position before anything can render: a resize that
        // arrives while the book is still opening has to re-anchor to it too.
        anchorCfi.current = stored.lastCfi || undefined

        const buffer = await readBookFile(stored, stored.file)
        if (canceled) return

        epubBook = ePub(buffer)
        await epubBook.ready
        if (canceled) return

        const nav = await epubBook.loaded.navigation
        if (canceled) return
        setToc(nav.toc ?? [])

        // Before any section loads, so every one is disarmed before it renders.
        epubBook.spine.hooks.content.register(neutralizeScripts)

        rend = epubBook.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
          manager: 'default',
          // sandbox="allow-same-origin allow-scripts", which on its own voids
          // the sandbox. WebKit needs it to deliver the frame's events to our
          // listeners at all; the book's own scripts are blocked by
          // `neutralizeScripts` instead, registered above.
          allowScriptedContent: true,
        })

        // In-book links (footnotes and their back-links) are ours to follow.
        // epub.js's own handler displays the target once, measured before a
        // newly loaded section has settled, which landed a footnote in another
        // file five pages short; and the tap also reached the page-turn
        // handler, costing another page when the link sat near an edge.
        const ownsLinks = takeOverLinks(rend)
        const book = epubBook
        const view = rend
        const turnPage: TurnPage = (direction) => {
          supersede()
          return direction === 'next' ? view.next() : view.prev()
        }

        // Registered before the first display so section one gets it too.
        rend.hooks.content.register((contents: Contents) => {
          // A press on a highlight opens it; it must not also select a word.
          detachTouch.add(
            longPressToSelect(contents, turnPage, (since) => suppressTapUntil.current > since),
          )
          detachTouch.add(mouseEdgeTurn(contents, turnPage))
          detachTouch.add(keepFrameInPlace(contents.document))
          if (!ownsLinks) return
          contents.on('linkClicked', (href: string) => {
            // Runs from the link's onclick, before the click bubbles to the
            // page-turn handler, so the claim is in place when it looks.
            suppressTapUntil.current = Date.now() + 400
            supersede()
            const epoch = navEpoch.current
            void goToSettled(rend, book.path.relative(href), () => navEpoch.current === epoch)
          })
        })

        const opts = optionsRef.current
        rend.themes.register(THEME_NAME, epubThemeStyles(opts.theme, opts.font))
        rend.themes.select(THEME_NAME)
        rend.themes.fontSize(`${opts.fontSize}%`)

        await rend.display(stored.lastCfi || undefined)
        if (canceled) return

        setEpub(epubBook)
        setRendition(rend)
        setReady(true)

        // The first paint can drift as images load; re-anchor once it settles.
        // Hold the saved position for the whole wait, or the short landing that
        // the first paint reports would be written back over it.
        if (stored.lastCfi) {
          const target = stored.lastCfi
          const epoch = navEpoch.current
          const release = hold()
          void waitForIdleLayout(rend)
            .then(() =>
              canceled || navEpoch.current !== epoch ? undefined : rend?.display(target),
            )
            .finally(() => {
              // Released on a timer for the same reason as after a resize: the
              // relocation this re-display triggers reports a column boundary
              // at or before the saved position, and saving that would cost a
              // page every time the book is opened.
              releaseHold = window.setTimeout(() => {
                if (!canceled) release()
              }, REANCHOR_RELEASE_MS)
            })
        }

        // Locations power the progress percentage. Generating them walks the
        // whole book, so reuse the cached copy whenever we have one.
        void loadLocations(epubBook, bookId, stored.locations, () => canceled)
      } catch (err) {
        if (canceled) return
        telemetry.captureError('reader', 'open_book', err)
        setError(err instanceof Error ? err.message : 'Could not open this book.')
      }
    }

    void start()

    return () => {
      canceled = true
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
  }, [bookId, container, hold, supersede])

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
      // anchor is a page *start*, so labeling from it breaks the rule above and
      // names the previous chapter — and it sticks, because once the hold
      // releases nothing relocates again until the reader turns a page.
      const chapter = chapterAt(anchors, loc.end?.cfi ?? cfi)
      setLocation({ cfi, href, chapter: chapter?.label, chapterHref: chapter?.href, progress })
      void db.books.update(bookId, { lastCfi: cfi, progress, lastOpenedAt: Date.now() })
    }

    rendition.on('relocated', handler)
    return () => {
      rendition.off('relocated', handler)
    }
  }, [rendition, epub, bookId, container])

  // Put the reader back on their page after the viewport changes size.
  useEffect(() => {
    if (!rendition) return

    let settleTimer = 0
    let releaseTimer = 0
    let burst = 0
    let releaseHold: (() => void) | undefined
    const release = () => {
      releaseHold?.()
      releaseHold = undefined
    }

    const onResized = () => {
      const target = anchorCfi.current
      if (!target) return

      // One hold for the whole burst. A phone's address bar sliding away fires
      // `resize` repeatedly, and epub.js re-displays on every one of them.
      // Swapped rather than kept, so a page turn mid-burst cannot leave the
      // rest of the burst re-anchoring unheld.
      release()
      releaseHold = hold()
      const epoch = navEpoch.current
      const current = ++burst
      window.clearTimeout(settleTimer)
      window.clearTimeout(releaseTimer)
      settleTimer = window.setTimeout(() => {
        if (navEpoch.current !== epoch) {
          release()
          return
        }
        // A keyboard opening in stages starts a re-anchor per stage. One that a
        // later burst has replaced must leave the newest hold alone: releasing
        // it lets that burst's re-display be recorded, a page short of the
        // anchor, once per keyboard open or close (#148).
        const latest = () => burst === current && navEpoch.current === epoch
        void goToSettled(rendition, target, latest).finally(() => {
          if (burst !== current) return
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
  }, [rendition, hold])

  // Selection, taps, and keyboard navigation inside the book iframe.
  useEffect(() => {
    if (!rendition) return

    const onSelected = (cfiRange: string, contents: Contents) => {
      optionsRef.current.onSelected?.(cfiRange, contents)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      // Arrows in a sheet's slider or text box belong to that control, not to
      // the book behind it.
      const target = event.target as Element | null
      if (target?.closest?.('input, textarea, select, [contenteditable]')) return
      if (event.key === 'ArrowRight') {
        supersede()
        void rendition.next()
      }
      if (event.key === 'ArrowLeft') {
        supersede()
        void rendition.prev()
      }
    }

    // Keydown, so a dialog's own Escape handler (`useModal`) stops it first.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') optionsRef.current.onEscape?.()
    }

    const tap = (target: EventTarget | null, clientX: number, since: number) => {
      const scroller = container?.querySelector('.epub-container') as HTMLElement | null
      const width = scroller?.clientWidth || container?.clientWidth || window.innerWidth

      // epub.js re-emits events from inside the book iframe, and that iframe is
      // as wide as the whole paginated strip rather than the visible page. Its
      // clientX therefore counts from the start of the section, so on any page
      // but the first it is far larger than the viewport and every tap reads as
      // "right edge". Subtracting the scroll offset puts it back in page space.
      const x = clientX - (scroller?.scrollLeft ?? 0)

      // The tap that finishes a drag-selection is not a page turn.
      const selection = (target as Node | null)?.ownerDocument?.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return

      // A tap on a highlight rides the same DOM event: marks-pane hand-proxies
      // events to its annotations, so both handlers see this tap and the order
      // between them is not guaranteed. Defer the turn by a task to let an
      // annotation callback claim the tap first.
      window.setTimeout(() => {
        if (suppressTapUntil.current > since) return
        if (x < width * TAP_TURN_ZONE) {
          supersede()
          void rendition.prev()
        } else if (x > width * (1 - TAP_TURN_ZONE)) {
          supersede()
          void rendition.next()
        } else optionsRef.current.onTapCenter?.()
      }, 0)
    }

    // iOS fires no click for a tap on plain text, so touch taps are read from
    // the touches themselves, and the click a browser may add after is ignored.
    let touch: { x: number; y: number; at: number } | undefined
    let touchEndedAt = 0

    const onTouchStart = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : undefined
      touch = point && { x: point.clientX, y: point.clientY, at: Date.now() }
    }

    const onTouchEnd = (event: TouchEvent) => {
      touchEndedAt = Date.now()
      const start = touch
      touch = undefined
      const point = event.changedTouches[0]
      if (!start || !point || event.touches.length) return
      if (touchEndedAt - start.at >= LONG_PRESS_MS) return
      const moved = Math.max(Math.abs(point.clientX - start.x), Math.abs(point.clientY - start.y))
      if (moved > MOVE_TOLERANCE_PX) return
      // A link is followed through its own click.
      if ((event.target as Element | null)?.closest?.('a[href]')) return
      tap(event.target, point.clientX, start.at)
    }

    const onClick = (event: MouseEvent) => {
      if (Date.now() - touchEndedAt < GHOST_CLICK_MS) return
      tap(event.target, event.clientX, Date.now())
    }

    rendition.on('selected', onSelected)
    rendition.on('keyup', onKeyUp)
    rendition.on('keydown', onKeyDown)
    rendition.on('click', onClick)
    rendition.on('touchstart', onTouchStart)
    rendition.on('touchend', onTouchEnd)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      rendition.off('selected', onSelected)
      rendition.off('keyup', onKeyUp)
      rendition.off('keydown', onKeyDown)
      rendition.off('click', onClick)
      rendition.off('touchstart', onTouchStart)
      rendition.off('touchend', onTouchEnd)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [rendition, container, supersede])

  // Theme, font and font size can change without rebuilding the rendition.
  useEffect(() => {
    if (!rendition) return
    rendition.themes.register(THEME_NAME, epubThemeStyles(options.theme, options.font))
    rendition.themes.select(THEME_NAME)
    rendition.themes.fontSize(`${options.fontSize}%`)
    // Re-selecting a theme does not always repaint the current page, and a font
    // or size change repaginates the section under the reader. Both need the
    // position put back, and the held anchor is the one to put it back to:
    // `currentLocation` reports where the unchanged scroll offset lands in the
    // new pagination, which is not where the reader was.
    let target = anchorCfi.current
    try {
      const current = rendition.currentLocation() as unknown as {
        start?: { cfi?: string }
      }
      target ??= current?.start?.cfi
    } catch {
      // Ignore: the rendition may not have a location yet.
    }
    if (!target) return

    // Held like a resize. The re-display reports the start of the page that
    // holds the anchor, which after repagination is earlier text; adopting it
    // cost a page on every size change and was saved as the reading position.
    let releaseTimer = 0
    const release = hold()
    const epoch = navEpoch.current
    void goToSettled(rendition, target, () => navEpoch.current === epoch).finally(() => {
      releaseTimer = window.setTimeout(release, REANCHOR_RELEASE_MS)
    })
    return () => {
      window.clearTimeout(releaseTimer)
      release()
    }
  }, [rendition, options.theme, options.font, options.fontSize, hold])

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
async function goToSettled(
  rendition: Rendition | undefined,
  target: string,
  /** Checked before the second display, so a page turn meanwhile wins. */
  stillWanted: () => boolean = () => true,
) {
  if (!rendition) return
  try {
    await rendition.display(target)
    await waitForIdleLayout(rendition)
    if (stillWanted()) await rendition.display(target)
  } catch {
    // Unresolvable target (stale href or broken CFI); leave the view as-is.
  }
}

/**
 * Removes epub.js's built-in link handler so the caller can follow links
 * itself. It is the content hook epub.js registers first, as a bound method.
 * Returns false, leaving epub.js in charge, if it cannot be found.
 */
function takeOverLinks(rendition: Rendition): boolean {
  const hooks = rendition.hooks.content
  const builtIn = (hooks.list() as Function[]).find((hook) => hook.name === 'bound handleLinks')
  if (!builtIn) return false
  hooks.deregister(builtIn)
  return true
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
  const contents = currentContents(rendition)
  const doc = contents?.document
  if (!contents || !doc) return

  const pending = [...doc.images].filter((img) => !img.complete)

  // A stalled remote image would otherwise hold this promise open forever, and
  // with it the document and rendition, long after the reader has navigated
  // away. Settling late is better than never settling.
  await Promise.race([
    Promise.all([
      // The reader's own font loads into each chapter's document; pagination
      // measured before it arrives reflows once it does.
      doc.fonts.ready,
      ...pending.map(
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
    ]),
    new Promise((resolve) => setTimeout(resolve, LAYOUT_SETTLE_TIMEOUT_MS)),
  ])

  // Let the renderer finish its own reflow pass before measuring again.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)))

  // Widen the strip to the reflowed text. epub.js re-measures only when the
  // document's box changes size, and a font reflow adds columns without
  // changing it, so the strip can stay short of its text indefinitely. A
  // display into it is clamped to its end, pages short of a heading near the
  // end of the section. The view expands synchronously on this event.
  contents.emit('expand')
}

async function loadLocations(
  epubBook: EpubBook,
  bookId: string,
  cached: string | undefined,
  isCanceled: () => boolean,
) {
  try {
    if (cached) {
      epubBook.locations.load(cached)
      return
    }
    await epubBook.locations.generate(1024)
    if (isCanceled()) return
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

  const spine = rendition.book.spine
  const anchors = buildAnchors(
    toc,
    href,
    current,
    // epub.js keys the spine by the manifest href as written, `./` and all.
    (target) => (spine.get(target) ?? spine.get(normalizeHref(target)))?.index,
  )
  cache.set(key, anchors)
  return anchors
}
