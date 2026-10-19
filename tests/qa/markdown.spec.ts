import { expect, test } from './fixtures.js'

test('assistant Markdown renders from a synthetic stream and survives reopening', async ({
  page,
  context,
}) => {
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
  const reply =
    '## A reading\n\n**Ishmael** is *introducing* himself.\n\n' +
    '- A name\n- A voice\n\n> Call me Ishmael.\n\n' +
    '[Source](https://example.com) and `a note`.\n\n' +
    '```text\na very long line ' +
    'about the whale '.repeat(60) +
    '\n```\n\n![A whale](https://example.com/whale.png)'
  await page.route('**/api/chat', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n` +
        'data: [DONE]\n\n',
    }),
  )
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Moby Dick/ })).toBeVisible()
  await page.evaluate(async () => {
    const path = '/src/db/db.ts'
    const { db } = (await import(path)) as {
      db: { conversations: { add(row: object): Promise<unknown> } }
    }
    await db.conversations.add({
      id: 'markdown-thread',
      bookId: 'sample-moby-dick',
      title: 'Markdown discussion',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
  await page.goto('/book/sample-moby-dick/chats')
  await page
    .getByRole('button', { name: 'Follow this thread: Markdown discussion', exact: true })
    .click()
  const composer = page.getByRole('textbox')
  await composer.fill('Explain **this** passage')
  await composer.press('Enter')
  const markdown = page.locator('.markdown-reply')
  await expect(markdown.locator('strong')).toHaveText('Ishmael')
  await expect(markdown.locator('em')).toHaveText('introducing')
  await expect(markdown.locator('li')).toHaveCount(2)
  await expect(markdown.locator('blockquote')).toContainText('Call me Ishmael.')
  await expect(markdown.locator('a')).toHaveAttribute('href', 'https://example.com')
  await expect(markdown.locator('img')).toHaveCount(0)
  await expect(page.getByText('Explain **this** passage', { exact: true })).toBeVisible()
  expect(await markdown.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.reload()
  await page
    .getByRole('button', { name: 'Follow this thread: Markdown discussion', exact: true })
    .click()
  await expect(markdown.locator('strong')).toHaveText('Ishmael')
})
