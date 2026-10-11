import type { BrowserContext, Page } from '@playwright/test'
import { openChapterOne } from './book.js'
import { expect, test } from './fixtures.js'

// A passage can be selected across a page break (issue #111). epub.js shows a
// page-sized window of one wide strip of columns, so the text past the break is
// in the same document, only scrolled out of reach.

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
  await context.route('**/api/chat', (route) => route.abort())
})

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
}

// What the probes need of the frame; QA code is typed without the DOM lib.
interface BookFrame {
  contentDocument: {
    querySelectorAll(selector: string): Iterable<{ getBoundingClientRect(): Rect }>
    createRange(): { selectNodeContents(node: object): void; getClientRects(): Iterable<Rect> }
    getSelection(): {
      isCollapsed: boolean
      rangeCount: number
      toString(): string
      getRangeAt(index: number): { getClientRects(): Iterable<Rect> }
    } | null
  }
  getBoundingClientRect(): Rect
  closest(selector: string): { scrollLeft: number; clientWidth: number } | null
}

const frame = (page: Page) => page.locator('.epub-view iframe').first()
const scrollLeft = (page: Page) =>
  page.locator('.epub-container').evaluate((element) => element.scrollLeft)

async function openChapterOneClear(page: Page) {
  const box = await openChapterOne(page)

  // Off the section's first page, then hide the toolbars, which sit over the
  // page's first and last lines.
  const start = await scrollLeft(page)
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(start)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('footer')).toHaveCSS('opacity', '0')
  return box
}

/** The last line of text on the visible page, in screen coordinates. */
function lastLine(page: Page) {
  return frame(page).evaluate((element) => {
    const iframe = element as unknown as BookFrame
    const doc = iframe.contentDocument
    const page = iframe.closest('.epub-container')!
    const offset = iframe.getBoundingClientRect()
    const left = page.scrollLeft
    const right = left + page.clientWidth
    let best: Rect | undefined
    for (const p of doc.querySelectorAll('p')) {
      const range = doc.createRange()
      range.selectNodeContents(p)
      for (const line of range.getClientRects()) {
        if (line.width < 40 || line.left < left - 2 || line.right > right + 2) continue
        if (!best || line.bottom > best.bottom) best = line
      }
    }
    if (!best) throw new Error('no text on the visible page')
    return {
      x: best.left + offset.left + best.width / 2,
      y: best.top + offset.top + (best.bottom - best.top) / 2,
      end: best.right + offset.left,
    }
  })
}

/** Where the selection starts and ends, relative to the visible page. */
function selectionSpan(page: Page) {
  return frame(page).evaluate((element) => {
    const iframe = element as unknown as BookFrame
    const page = iframe.closest('.epub-container')!
    const selection = iframe.contentDocument.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined
    const rects = [...selection.getRangeAt(0).getClientRects()].filter((r) => r.width > 0)
    // Touch selections are drawn by the app (iOS paints none); count the marks
    // on the page now showing.
    const marks = [...iframe.contentDocument.querySelectorAll('.marginalia-selection-mark')]
    const right = page.scrollLeft + page.clientWidth
    return {
      startsBefore: rects[0].left < page.scrollLeft,
      endsOnPage: rects[rects.length - 1].left >= page.scrollLeft,
      marksOnPage: marks
        .map((mark) => mark.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.left >= page.scrollLeft && r.right <= right).length,
      text: selection.toString(),
    }
  })
}

async function expectBarOnScreen(page: Page) {
  const bar = page.getByRole('toolbar', { name: 'Selection actions' })
  await expect(bar).toBeVisible()
  const box = (await bar.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
}

// What a hand-made touch needs of the frame.
interface TouchFrame {
  contentDocument: {
    body: EventTarget
    elementFromPoint(x: number, y: number): EventTarget | null
  }
  getBoundingClientRect(): Rect
}

// WebKit will not construct a TouchEvent with touches, so on a WebKit phone the
// touch is dispatched by hand to the book frame, as in ipad.spec.ts.
function frameTouch(page: Page) {
  let at = { x: 0, y: 0 }
  const fire = (type: string, x: number, y: number) =>
    frame(page).evaluate(
      (element, { type, x, y }) => {
        const iframe = element as unknown as TouchFrame
        const doc = iframe.contentDocument
        const box = iframe.getBoundingClientRect()
        const point = { clientX: x - box.left, clientY: y - box.top }
        const target = doc.elementFromPoint(point.clientX, point.clientY) ?? doc.body
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] })
        Object.defineProperty(event, 'changedTouches', { value: [point] })
        target.dispatchEvent(event)
      },
      { type, x, y },
    )
  return {
    down: (x: number, y: number) => ((at = { x, y }), fire('touchstart', x, y)),
    move: (x: number, y: number) => ((at = { x, y }), fire('touchmove', x, y)),
    up: () => fire('touchend', at.x, at.y),
  }
}

// In Chromium, `page.mouse.move` takes the browser down on the reader page, so
// drags and holds go through CDP there (see the marginalia-dev skill).
async function pointer(context: BrowserContext, page: Page, browserName: string, touch: boolean) {
  if (browserName === 'webkit' && touch) return frameTouch(page)
  if (browserName !== 'chromium') {
    return {
      down: async (x: number, y: number) => {
        await page.mouse.move(x, y)
        await page.mouse.down()
      },
      move: (x: number, y: number) => page.mouse.move(x, y),
      up: () => page.mouse.up(),
    }
  }
  const cdp = await context.newCDPSession(page)
  if (touch) {
    const send = (type: string, x = 0, y = 0) =>
      cdp.send('Input.dispatchTouchEvent', {
        type: type as 'touchStart',
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
      })
    return {
      down: (x: number, y: number) => send('touchStart', x, y),
      move: (x: number, y: number) => send('touchMove', x, y),
      up: () => send('touchEnd'),
    }
  }
  let at = { x: 0, y: 0 }
  const send = (type: string, x: number, y: number, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: type as 'mousePressed',
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
    })
  return {
    down: (x: number, y: number) => ((at = { x, y }), send('mousePressed', x, y, 1)),
    move: (x: number, y: number) => ((at = { x, y }), send('mouseMoved', x, y, 1)),
    up: () => send('mouseReleased', at.x, at.y, 0),
  }
}

test('a selection dragged to the page edge runs onto the next page', async ({
  context,
  page,
  browserName,
  isMobile,
}) => {
  const box = await openChapterOneClear(page)
  const line = await lastLine(page)
  const input = await pointer(context, page, browserName, isMobile)
  const start = await scrollLeft(page)

  await input.down(line.x, line.y)
  // A touch selects on a long press; a mouse drags out its own selection.
  await page.waitForTimeout(isMobile ? 900 : 100)
  // Resting on the end of the line, however close to the edge, does not turn
  // the page.
  await input.move(line.end - 2, line.y)
  await page.waitForTimeout(1000)
  expect(await scrollLeft(page)).toBe(start)

  // Past the end of the line, into the margin.
  await input.move(box.x + box.width - 4, line.y)
  await expect.poll(() => scrollLeft(page), { timeout: 5000 }).toBeGreaterThan(start)
  await input.up()

  const span = await selectionSpan(page)
  expect(span?.startsBefore, 'the selection starts on the earlier page').toBe(true)
  expect(span?.endsOnPage, 'the selection reaches the page now showing').toBe(true)
  if (isMobile) expect(span?.marksOnPage, 'the drawn selection follows it').toBeGreaterThan(0)
  await expectBarOnScreen(page)
})

test('a tap at the page edge carries a selection to the next page', async ({
  context,
  page,
  browserName,
  isMobile,
}) => {
  const box = await openChapterOneClear(page)
  const line = await lastLine(page)
  const input = await pointer(context, page, browserName, isMobile)

  await input.down(line.x, line.y)
  await page.waitForTimeout(isMobile ? 900 : 100)
  await input.move(line.x + 30, line.y)
  await input.up()
  await expectBarOnScreen(page)
  const selected = (await selectionSpan(page))?.text
  expect(selected?.trim()).toBeTruthy()

  const start = await scrollLeft(page)
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(start)
  expect((await selectionSpan(page))?.text).toBe(selected)
  await expectBarOnScreen(page)

  // And back. The zones are the reader's, which is centered and capped on a
  // wide screen, not the window's.
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2)
  await expect.poll(() => scrollLeft(page)).toBe(start)
  expect((await selectionSpan(page))?.text).toBe(selected)

  // A tap in the middle still dismisses it.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).not.toBeVisible()
})
