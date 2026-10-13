import type { Page } from '@playwright/test'
import { expect, openContents, test } from './fixtures.js'

// iOS Safari can lose the file behind a Blob stored in IndexedDB while keeping
// the row (issue #106). Chromium never does, so this stands in for it: a Blob
// read back from IndexedDB with one of the marked sizes rejects with WebKit's
// error, and its object URL does not render. The marked sizes are tiny, so the
// real EPUBs and covers a recovery writes back are never mistaken for lost.
const LOST_SIZES = [7, 5]

// Runs in the page. This file is type-checked without the DOM library, so the
// IndexedDB classes are reached by name.
function loseBlobsReadFromStorage(sizes: number[]) {
  type Proto = Record<string, unknown>
  const scope = globalThis as unknown as Record<string, { prototype: Proto }>
  const lost = new WeakSet<Blob>()
  function blobsIn(value: unknown): Blob[] {
    if (value instanceof Blob) return [value]
    if (value && typeof value === 'object') return Object.values(value).flatMap(blobsIn)
    return []
  }

  // What IndexedDB hands back is marked on the way out.
  for (const [name, key] of [
    ['IDBRequest', 'result'],
    ['IDBCursorWithValue', 'value'],
  ]) {
    const proto = scope[name].prototype
    const { get } = Object.getOwnPropertyDescriptor(proto, key)!
    Object.defineProperty(proto, key, {
      get() {
        const value: unknown = get!.call(this)
        for (const blob of blobsIn(value)) if (sizes.includes(blob.size)) lost.add(blob)
        return value
      },
    })
  }

  // WebKit will not store a row that still holds a lost Blob.
  for (const [name, method] of [
    ['IDBObjectStore', 'put'],
    ['IDBCursor', 'update'],
  ]) {
    const proto = scope[name].prototype
    const original = proto[method] as (...args: unknown[]) => unknown
    proto[method] = function (this: unknown, ...args: unknown[]) {
      if (blobsIn(args[0]).some((blob) => lost.has(blob))) {
        throw new DOMException('Error preparing Blob/File data', 'UnknownError')
      }
      return original.apply(this, args)
    }
  }

  const { arrayBuffer, slice } = Blob.prototype
  Blob.prototype.arrayBuffer = function () {
    return lost.has(this)
      ? Promise.reject(new DOMException('The object can not be found here.', 'NotFoundError'))
      : arrayBuffer.call(this)
  }
  Blob.prototype.slice = function (...args) {
    const part = slice.apply(this, args)
    if (lost.has(this)) lost.add(part)
    return part
  }
  const createObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob: Blob) =>
    createObjectURL(lost.has(blob) ? new Blob([], { type: 'image/jpeg' }) : blob)
}

type Lost = 'file' | 'cover'

/** Copies `fromId` to `toId`, with the named Blobs replaced by lost ones. */
async function storeLostCopy(page: Page, fromId: string, toId: string, lose: Lost[]) {
  await page.evaluate(
    async ({ fromId, toId, lose, sizes }) => {
      // The app's own Dexie instance, through the dev server's module graph.
      const path = '/src/db/db.ts'
      const { db } = (await import(path)) as {
        db: { books: { get(id: string): Promise<object>; put(row: object): Promise<unknown> } }
      }
      await db.books.put({
        ...(await db.books.get(fromId)),
        id: toId,
        ...(lose.includes('file') && { file: new Blob(['x'.repeat(sizes[0])]) }),
        ...(lose.includes('cover') && { cover: new Blob(['x'.repeat(sizes[1])]) }),
      })
    },
    { fromId, toId, lose, sizes: LOST_SIZES },
  )
}

test.beforeEach(async ({ context }) => {
  await context.route(/https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
  await context.addInitScript(loseBlobsReadFromStorage, LOST_SIZES)
})

test('a lost file is logged for the issue link in Settings', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^The Genealogy of Morals/ })).toBeVisible()
  await storeLostCopy(page, 'sample-genealogy-of-morals', 'imported-genealogy-of-morals', ['file'])
  // Either outcome for the book is fine here; this checks only the log.
  await page.goto('/book/imported-genealogy-of-morals')
  await expect(page.getByText(/removed from your library|lost the EPUB/)).toBeVisible()

  await page.goto('/settings')
  const link = page.getByRole('link', { name: /Open an issue/ })
  await expect(link).toHaveAttribute('href', /lost%20EPUB/)
  const body = new URL((await link.getAttribute('href'))!).searchParams.get('body')!
  expect(body).toMatch(/- Version: \S+ built \d{4}-\d{2}-\d{2}T[\d:.]+Z/)
  expect(body).toMatch(/\] lost EPUB, imported, unrecoverable, idle [\d.]+d/)
  expect(body).toContain('1 missing their EPUB')
  expect(body).not.toContain('The Genealogy of Morals')
})

test('a bundled book that lost its files is fetched again', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Moby Dick/ })).toBeVisible()
  await storeLostCopy(page, 'sample-moby-dick', 'sample-moby-dick', ['file', 'cover'])
  await page.reload()

  // The broken cover sets off the repair from the library itself.
  const card = page.getByRole('button', { name: /^Moby Dick/ })
  await card.scrollIntoViewIfNeeded()
  await expect(card.locator('img')).toBeVisible()

  await card.click()
  await (await openContents(page)).getByRole('button', { name: /Loomings/i }).click()
  await expect(page.frameLocator('iframe').first().locator('body')).toContainText('Call me Ishmael')
})

test('an imported book that lost its EPUB waits for it again', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^The Genealogy of Morals/ })).toBeVisible()
  await storeLostCopy(page, 'sample-genealogy-of-morals', 'imported-genealogy-of-morals', ['file'])

  // Opening it finds the file gone and keeps the book on the shelf with its notes.
  await page.goto('/book/imported-genealogy-of-morals')
  await expect(page.getByText(/lost the EPUB/)).toBeVisible()

  await page.goto('/')
  const missing = page.getByRole('listitem').filter({ hasText: 'EPUB missing' })
  await expect(missing).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Removed books' })).toHaveCount(0)

  await page
    .locator('input[type="file"][accept^=".epub"]')
    .setInputFiles('public/books/genealogy-of-morals.epub')
  await expect(missing).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^The Genealogy of Morals/ })).toHaveCount(2)

  await page.goto('/book/imported-genealogy-of-morals')
  await expect(page.getByRole('button', { name: 'Table of contents' })).toBeVisible()
  await expect(page.getByText(/lost the EPUB/)).toHaveCount(0)
})

test("an imported book that lost its cover gets the EPUB's own back", async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^The Genealogy of Morals/ })).toBeVisible()
  await storeLostCopy(page, 'sample-genealogy-of-morals', 'imported-genealogy-of-morals', ['cover'])
  await page.reload()

  const cards = page.getByRole('button', { name: /^The Genealogy of Morals/ })
  const covers = cards.locator('img')
  // Covers load lazily, and on a phone the first-run card can push one below the
  // fold. Scroll the cards: a recovered cover replaces its <img> mid-scroll.
  await expect(cards).toHaveCount(2)
  for (const card of await cards.all()) await card.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      covers.evaluateAll((imgs) => imgs.map((img) => Reflect.get(img, 'naturalWidth') > 0)),
    )
    .toEqual([true, true])
})

test('browsing the library keeps an imported book whose files were lost (#122)', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^The Genealogy of Morals/ })).toBeVisible()
  await storeLostCopy(page, 'sample-genealogy-of-morals', 'imported-genealogy-of-morals', [
    'file',
    'cover',
  ])
  await page.reload()

  // The broken cover sets off the repair, which finds the EPUB gone too.
  const cards = page.getByRole('button', { name: /^The Genealogy of Morals/ })
  await expect(page.getByRole('listitem').filter({ hasText: 'EPUB missing' })).toHaveCount(1)
  await page.reload()
  await expect(cards).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Removed books' })).toHaveCount(0)
})
