import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'

/**
 * Waits until the page strip stops moving and resizing.
 *
 * Images load and reflow the strip after the first paint, and a reflow can
 * re-display the reading position on a delay, so a fixed sleep is either too
 * short on a slow runner or wasted on a fast one.
 */
export async function settle(page: Page, quietMs = 1000) {
  const container = page.locator('.epub-container')
  await expect(container).toBeVisible()

  // `goToSettled` re-displays once the frame's images and fonts are in, so
  // wait for those before the quiet window starts. A resize rebuilds the view,
  // leaving a frame with no document for a moment.
  await expect
    .poll(
      () =>
        page.locator('.epub-view iframe').evaluate((element) => {
          const doc = (
            element as unknown as {
              contentDocument: {
                images: Iterable<{ complete: boolean }>
                fonts: { status: string }
              } | null
            }
          ).contentDocument
          if (!doc) return false
          return [...doc.images].every((img) => img.complete) && doc.fonts.status === 'loaded'
        }),
      { message: "the book's images and fonts load", timeout: 20_000 },
    )
    .toBe(true)

  let last = ''
  let since = Date.now()
  await expect
    .poll(
      async () => {
        const now = await container.evaluate((el) => `${el.scrollLeft}:${el.scrollWidth}`)
        if (now !== last) {
          last = now
          since = Date.now()
        }
        return Date.now() - since >= quietMs
      },
      { message: 'the page strip settles', timeout: 20_000, intervals: [100] },
    )
    .toBe(true)
}

/** Opens Moby Dick at its first chapter and waits for the layout to settle. */
export async function openChapterOne(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /^Moby Dick/ }).click()
  await page.getByRole('button', { name: 'Table of contents' }).click()
  const contents = page.getByRole('dialog', { name: 'Table of contents' })
  await contents.getByRole('button', { name: /Loomings/i }).click()
  await expect(contents).not.toBeVisible()
  await expect(page.frameLocator('.epub-view iframe').first().locator('body')).toContainText(
    'Call me Ishmael',
  )
  await settle(page)
  return (await page.locator('.epub-container').boundingBox())!
}
