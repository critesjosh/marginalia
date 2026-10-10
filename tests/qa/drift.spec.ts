import type { Page } from '@playwright/test'
import { openChapterOne, settle } from './book.js'
import { expect, test } from './fixtures.js'

// Two ways the reading position used to bleed away a little at a time. Each
// looks fine after one step, so both are asserted over repetition.

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
  await context.route('**/api/chat', (route) => route.abort())
})

/** The strip's offset and its column pitch, the rendered body's box width. */
const strip = (page: Page) =>
  page.locator('.epub-view iframe').evaluate((element) => {
    const iframe = element as unknown as {
      contentDocument: { body: { getBoundingClientRect(): { width: number } } }
      closest(selector: string): { scrollLeft: number }
    }
    return {
      scrollLeft: iframe.closest('.epub-container').scrollLeft,
      pitch: iframe.contentDocument.body.getBoundingClientRect().width,
    }
  })

/** The saved position, read from the app's own database. */
const savedCfi = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/db/db.ts'
    const { db } = (await import(path)) as {
      db: { books: { get(id: string): Promise<{ lastCfi?: string } | undefined> } }
    }
    return (await db.books.get('sample-moby-dick'))?.lastCfi
  })

test('paging back and forth stays on whole pages', async ({ page }, testInfo) => {
  // The drift needs a fractional pitch on a fractional device pixel ratio,
  // which a phone usually has (1080 device pixels at 2.625 is 411.43 CSS px).
  // Of the QA projects only this one drifts with `snapToPage` removed: desktop
  // rounds to whole pixels, and WebKit and Firefox lay the zoomed page out on
  // a whole-pixel pitch.
  test.skip(testInfo.project.name !== 'mobile', 'needs a fractional pitch and pixel ratio')
  test.setTimeout(120_000)
  // Emulated viewports are whole CSS pixels, so zoom the page for a fractional
  // pitch. Init scripts run in every frame, and only the app's own document
  // should zoom. A string, since this file is type-checked without the DOM lib.
  await page.addInitScript(
    `if (window === window.top) document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.zoom = '1.05'
    })`,
  )
  const box = await openChapterOne(page)
  const { pitch } = await strip(page)
  expect(pitch % 1, 'a fractional pitch').not.toBe(0)
  const forward = { x: box.x + box.width * 0.9, y: box.y + box.height / 2 }
  const back = { x: box.x + box.width * 0.1, y: forward.y }

  // Off the section's first page, so a turn back stays in the section.
  await page.mouse.click(forward.x, forward.y)
  await settle(page, 300)
  const start = await strip(page)

  // Each turn rounds off a fraction of a pixel, which nothing re-anchors
  // unless the reader snaps back to the page; 200 turns walked 80px.
  const misalignment = async () => {
    const { scrollLeft, pitch } = await strip(page)
    const off = scrollLeft % pitch
    return Math.min(off, pitch - off)
  }
  for (let turn = 1; turn <= 100; turn++) {
    for (const tap of [forward, back]) {
      const before = (await strip(page)).scrollLeft
      await page.mouse.click(tap.x, tap.y)
      await expect.poll(async () => (await strip(page)).scrollLeft).not.toBe(before)
      await expect
        .poll(misalignment, { message: `aligned after ${turn * 2} turns`, timeout: 2000 })
        .toBeLessThan(1)
    }
  }
  expect((await strip(page)).scrollLeft).toBe(start.scrollLeft)
})

test('resizing the window keeps the reading position', async ({ page }) => {
  test.setTimeout(120_000)
  const box = await openChapterOne(page)
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
    await settle(page, 300)
  }
  const chapter = page.locator('header p + p')
  const label = await chapter.textContent()
  const { scrollLeft } = await strip(page)
  const cfi = await savedCfi(page)
  expect(cfi).toBeTruthy()

  // A phone's address bar does this all day; each round-trip lost a page.
  const { width, height } = page.viewportSize()!
  for (let trip = 1; trip <= 10; trip++) {
    await page.setViewportSize({ width, height: height - 90 })
    await settle(page)
    await page.setViewportSize({ width, height })
    await settle(page)
    expect((await strip(page)).scrollLeft, `page after ${trip} round-trips`).toBe(scrollLeft)
    expect(await savedCfi(page), `saved position after ${trip} round-trips`).toBe(cfi)
  }
  await expect(chapter).toHaveText(label!)
})
