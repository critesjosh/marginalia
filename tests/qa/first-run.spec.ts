import { expect, test } from './fixtures.js'

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
})

test('the first-run card opens Chapter 1, where the tap zones show once', async ({ page }) => {
  await page.goto('/')
  const card = page.getByRole('region', { name: 'How Rami works' })
  await expect(card.getByRole('listitem')).toHaveCount(3)
  await card.getByRole('link', { name: 'Try it with Moby Dick' }).click()

  await expect(page.frameLocator('iframe').first().locator('body')).toContainText('Call me Ishmael')
  const zones = page.getByText('Next ›')
  await expect(zones).toBeVisible()
  // Showing the toolbar is enough to retire the map, for good.
  await page.locator('.reader-inset-top').click()
  await expect(zones).toHaveCount(0)

  await page.reload()
  await expect(page.frameLocator('iframe').first().locator('body')).toContainText('Call me Ishmael')
  await expect(page.locator('.epub-view iframe')).toBeVisible()
  await expect(zones).toHaveCount(0)
})

test('the ⋯ note waits for a visit after the card, and shows once', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Dismiss how Rami works' }).click()
  await expect(page.getByRole('region', { name: 'How Rami works' })).toHaveCount(0)
  const note = page.getByRole('complementary', { name: 'The book menu' })
  await expect(page.getByRole('heading', { name: 'All books' })).toBeVisible()
  await expect(note).toHaveCount(0)

  await page.reload()
  await expect(note).toBeVisible()
  // On a phone the note can start below the fold; only a note seen retires.
  await note.scrollIntoViewIfNeeded()
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('link', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'All books' })).toBeVisible()
  await expect(note).toHaveCount(0)
})

test('the guide is reachable from the card and from Settings', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'More about Rami' }).click()
  const guide = page.getByRole('heading', { level: 1, name: 'How Rami works' })
  await expect(guide).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'All books' })).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('link', { name: 'Read the guide' }).click()
  await expect(guide).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})
