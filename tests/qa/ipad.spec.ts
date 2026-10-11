import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { openChapterOne } from './book.js'
import { expectBookScriptsBlocked } from './hostileBook.js'

// Every iPad browser is WebKit, and WebKit never runs listeners the app adds to
// a book frame sandboxed without `allow-scripts`. Chromium does, so only this
// project can catch a regression.

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
})

// What the long press needs of the frame; QA code is typed without the DOM lib.
interface BookFrame {
  contentDocument: {
    body: EventTarget
    elementFromPoint(x: number, y: number): EventTarget | null
    getSelection(): { toString(): string } | null
  } | null
  getBoundingClientRect(): { left: number; top: number }
}

const scrollLeft = (page: Page) =>
  page.locator('.epub-container').evaluate((element) => element.scrollLeft)

test('a tap on the book turns the page and toggles the toolbars', async ({ page }) => {
  const box = await openChapterOne(page)
  const y = box.y + box.height / 2

  const start = await scrollLeft(page)
  await page.touchscreen.tap(box.x + box.width * 0.9, y)
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(start)

  const footer = page.locator('footer')
  await expect(footer).toHaveCSS('opacity', '1')
  await page.touchscreen.tap(box.x + box.width / 2, y)
  await expect(footer).toHaveCSS('opacity', '0')
})

// Playwright's touchscreen only taps, and this WebKit build will not construct a
// TouchEvent with touches, so the press is dispatched by hand. It still has to
// reach the app's listeners, which is what failed.
// With `dragTo`, the finger then moves there before lifting.
async function longPress(
  page: Page,
  point: { x: number; y: number },
  dragTo?: { x: number; y: number },
) {
  return page
    .locator('.epub-view iframe')
    .first()
    .evaluate(
      async (element, { point, dragTo }) => {
        const iframe = element as unknown as BookFrame
        const doc = iframe.contentDocument!
        const frameBox = iframe.getBoundingClientRect()
        const x = point.x - frameBox.left
        const y = point.y - frameBox.top
        const target = doc.elementFromPoint(x, y) ?? doc.body
        const fire = (type: string, touches: object[]) => {
          const event = new Event(type, { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'touches', { value: touches })
          Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] })
          target.dispatchEvent(event)
        }
        fire('touchstart', [{ clientX: x, clientY: y }])
        await new Promise((resolve) => setTimeout(resolve, 900))
        if (dragTo) {
          const to = { clientX: dragTo.x - frameBox.left, clientY: dragTo.y - frameBox.top }
          fire('touchmove', [to])
        }
        fire('touchend', [])
        return doc.getSelection()?.toString() ?? ''
      },
      { point, dragTo },
    )
}

test('a long press selects the word under the finger', async ({ page }) => {
  const box = await openChapterOne(page)
  const word = await longPress(page, { x: box.x + box.width / 2, y: box.y + box.height * 0.4 })

  expect(word.trim()).not.toBe('')
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toBeVisible()
})

// iOS paints no selection made through the Selection API, so the app draws it.
test('a touch selection is drawn over the text it covers', async ({ page }) => {
  const box = await openChapterOne(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height * 0.4
  // Drag a few lines down, so the selection spans several.
  const text = await longPress(page, { x, y }, { x, y: y + 100 })
  expect(text.trim().split(/\s+/).length).toBeGreaterThan(5)

  const frame = page.frameLocator('.epub-view iframe').first()
  const marks = frame.locator('.marginalia-selection-mark')
  const { boxes, range } = await frame.locator('html').evaluate((html) => {
    const doc = (html as unknown as { ownerDocument: SelectionDoc }).ownerDocument
    const plain = ({ left, top, right, bottom }: Box) => ({ left, top, right, bottom })
    return {
      boxes: Array.from(doc.querySelectorAll('.marginalia-selection-mark'), (mark) =>
        plain(mark.getBoundingClientRect()),
      ),
      range: plain(doc.getSelection()!.getRangeAt(0).getBoundingClientRect()),
    }
  })
  expect(boxes.length).toBeGreaterThan(1)
  // One box per line, together covering exactly the selection.
  expect(Math.min(...boxes.map((b) => b.left))).toBeCloseTo(range.left)
  expect(Math.min(...boxes.map((b) => b.top))).toBeCloseTo(range.top)
  expect(Math.max(...boxes.map((b) => b.right))).toBeCloseTo(range.right)
  expect(Math.max(...boxes.map((b) => b.bottom))).toBeCloseTo(range.bottom)

  await page.getByRole('button', { name: 'Copy' }).click()
  await expect(marks).toHaveCount(0)
})

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

interface SelectionDoc {
  querySelectorAll(selector: string): ArrayLike<{ getBoundingClientRect(): Box }>
  getSelection(): { getRangeAt(index: number): { getBoundingClientRect(): Box } } | null
}

interface HostWindow {
  document: { elementFromPoint(x: number, y: number): EventTarget | null }
  MouseEvent: new (type: string, init: object) => Event
}

test('a tap on a highlight opens its thread and keeps it open', async ({ page }) => {
  const box = await openChapterOne(page)
  await longPress(page, { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 })
  await page.getByRole('button', { name: 'Ask about this' }).click()
  const thread = page.getByRole('dialog').filter({ hasText: 'Thread' })
  await page.getByRole('button', { name: 'Close thread' }).click()
  await expect(thread).not.toBeVisible()

  const mark = (await page.locator('.epub-view svg g').first().boundingBox())!
  const x = mark.x + mark.width / 2
  const y = mark.y + mark.height / 2
  await page.touchscreen.tap(x, y)
  await expect(thread).toBeVisible()

  // iOS follows the tap with a click hit-tested where the finger was, which is
  // now the thread's scrim. This WebKit build sends none, so send it by hand.
  await page.evaluate(
    ({ x, y }) => {
      const host = globalThis as unknown as HostWindow
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y }
      const target = host.document.elementFromPoint(x, y)!
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new host.MouseEvent(type, init))
      }
    },
    { x, y },
  )
  await page.waitForTimeout(300)
  await expect(thread).toBeVisible()

  // A press that begins on the scrim still closes the thread.
  await page.mouse.click(x, y)
  await expect(thread).not.toBeVisible()
})

test("a book's own scripts never run", async ({ page }) => {
  await expectBookScriptsBlocked(page)
})
