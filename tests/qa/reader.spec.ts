import { settle } from './book.js'
import { expect, test } from './fixtures.js'
import { expectBookScriptsBlocked } from './hostileBook.js'

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
})

test('public-domain book renders and survives reopening', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^Moby Dick/ }).click()
  await expect(page.getByRole('button', { name: 'Table of contents' })).toBeVisible()
  await page.getByRole('button', { name: 'Table of contents' }).click()
  const contents = page.getByRole('dialog', { name: 'Table of contents' })
  await contents.getByRole('button', { name: /Loomings/i }).click()
  await expect(contents).not.toBeVisible()
  await expect(page.locator('iframe').first()).toBeVisible()
  await expect(page.frameLocator('iframe').first().locator('body')).toContainText('Call me Ishmael')
  await page.reload()
  await expect(page.frameLocator('iframe').first().locator('body')).toContainText('Call me Ishmael')
})

test('an in-book link lands on the page that holds its target', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^Meditations/ }).click()
  await page.getByRole('button', { name: 'Table of contents' }).click()
  const contents = page.getByRole('dialog', { name: 'Table of contents' })
  await contents.getByRole('button', { name: 'Paragraphs with First Lines' }).click()
  await expect(contents).not.toBeVisible()
  await settle(page)

  // A link into another section, on the visible page. The book is one wide
  // strip of columns, so most links in the frame are off screen; Playwright's
  // boxes are in page coordinates, which tells the two apart.
  const width = page.viewportSize()!.width
  const book = page.frameLocator('.epub-view iframe')
  const links = book.locator('a[href*=".xhtml#"]')
  let target: string | undefined
  for (const link of await links.all()) {
    const box = await link.boundingBox()
    if (!box || box.width === 0 || box.x < 0 || box.x + box.width > width) continue
    target = (await link.getAttribute('href'))!.split('#')[1]
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    break
  }
  expect(target, 'a cross-section link on the visible page').toBeDefined()
  await settle(page)

  // The target is an empty anchor opening its paragraph; the paragraph's box
  // starts in the column that holds it.
  const paragraph = book.locator(`[id="${target}"]`).locator('xpath=..')
  await expect(paragraph, 'the target section is still on screen').toHaveCount(1)
  const box = (await paragraph.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x).toBeLessThan(width)
})

test("a book's own scripts never run", async ({ page }) => {
  await expectBookScriptsBlocked(page)
})

test('an unconfigured relay fails safely', async ({ request }) => {
  // No messages: the key check comes first, so the unkeyed local relay still
  // answers 503, while a keyed or proxied relay rejects the body before any
  // billed model call.
  const response = await request.post('/api/chat', { data: { messages: [] } })
  const body = await response.json()
  expect(body.error?.message, 'answered by the unkeyed local relay').toBe(
    'This deployment has no inference key configured.',
  )
  expect(response.status()).toBe(503)
  expect(JSON.stringify(body)).not.toContain('apiKey')
})
