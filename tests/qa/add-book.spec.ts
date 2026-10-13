import { expect, test } from './fixtures.js'

/** Synthetic catalog records shaped like the relay's `?details=` answers. */
const DETAILS: Record<string, object> = {
  '1342': {
    id: 1342,
    title: 'Pride and Prejudice',
    people: [{ role: 'Author', name: 'Jane Austen', dates: '1775-1817' }],
    notes: [],
    released: 'Jun 1, 1998',
    downloads: 191399,
    language: 'English',
    subjects: ['Love stories'],
    otherEditions: [42671],
  },
  '42671': {
    id: 42671,
    title: 'Pride and Prejudice',
    people: [
      { role: 'Author', name: 'Jane Austen', dates: '1775-1817' },
      { role: 'Editor', name: 'R. W. Chapman', dates: '1881-1960' },
    ],
    summary: 'A synthetic summary of an edited edition.',
    notes: [],
    released: 'May 9, 2013',
    downloads: 14621,
    language: 'English',
    subjects: ['Love stories'],
    otherEditions: [1342],
  },
}

test.beforeEach(async ({ context }) => {
  // QA must never contact hosted services, Gutenberg's cover images included.
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
  await context.route('**/api/gutenberg?*', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const details = params.get('details')
    if (details) return route.fulfill({ json: DETAILS[details] })
    return route.fulfill({
      json: {
        results: [
          { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
          { id: 42671, title: 'Pride and Prejudice', author: 'Jane Austen' },
        ],
      },
    })
  })
})

test('a search result opens its details, and other editions are one tap away', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add book' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a book' })
  await dialog.getByRole('searchbox').fill('pride')

  const titles = dialog.getByRole('button', { name: 'Pride and Prejudice' })
  await expect(titles).toHaveCount(2)
  // By keyboard: the title unmounts, so focus must land in the details.
  await titles.nth(1).focus()
  await page.keyboard.press('Enter')
  const back = dialog.getByRole('button', { name: 'Back to results' })
  await expect(back).toBeFocused()

  const details = dialog.getByRole('article', { name: 'Pride and Prejudice' })
  await expect(details).toContainText('Editor: R. W. Chapman (1881-1960)')
  await expect(details).toContainText('#42671 · Released May 9, 2013 · English')
  await expect(details.getByRole('button', { name: 'Add to library' })).toBeEnabled()

  await details.getByRole('button', { name: '#1342' }).click()
  await expect(back).toBeFocused()
  await expect(details).toContainText('#1342 · Released Jun 1, 1998')
  await expect(details).not.toContainText('R. W. Chapman')

  // Back retraces the editions, then returns to the results it left.
  await back.click()
  await expect(details).toContainText('#42671')
  await back.click()
  await expect(titles.nth(1)).toBeFocused()
  await expect(dialog.getByRole('searchbox')).toHaveValue('pride')
})
