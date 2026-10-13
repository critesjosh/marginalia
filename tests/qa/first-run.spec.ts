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

test('a thread note that never came into view is kept for next time', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Moby Dick/ })).toBeVisible()
  await page.evaluate(async () => {
    // The app's own Dexie instance, through the dev server's module graph.
    const path = '/src/db/db.ts'
    const { db } = (await import(path)) as {
      db: Record<'conversations' | 'messages', { add(row: object): Promise<unknown> }>
    }
    const now = Date.now()
    await db.conversations.add({
      id: 'long-thread',
      bookId: 'sample-moby-dick',
      title: 'Call me Ishmael',
      seedText: 'Call me Ishmael.',
      createdAt: now,
      updatedAt: now,
    })
    for (let i = 0; i < 8; i++) {
      await db.messages.add({
        id: `long-${i}`,
        conversationId: 'long-thread',
        role: i % 2 ? 'assistant' : 'user',
        content: 'A long turn about the whale. '.repeat(60),
        createdAt: now + i,
      })
    }
  })

  // A long thread opens on its latest message, far below the note at its top.
  await page.goto('/book/sample-moby-dick/chats')
  const thread = page.getByRole('button', { name: /Call me Ishmael/ }).first()
  const note = page.getByRole('complementary', { name: 'What Rami sees' })
  await thread.click()
  await expect(note).toHaveCount(1)
  await expect(note).not.toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)

  await thread.click()
  await expect(note).toHaveCount(1)
  await note.scrollIntoViewIfNeeded()
  await expect(note).toBeInViewport({ ratio: 0.5 })
  await page.keyboard.press('Escape')
  await thread.click()
  await expect(note).toHaveCount(0)
})
