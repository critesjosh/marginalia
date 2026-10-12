import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, type Page } from '@playwright/test'

export { expect } from '@playwright/test'

// An ephemeral WebKit context refuses Blobs in IndexedDB (as Private Browsing
// does) and the sample books never seed, so WebKit gets a persistent profile.
export const test = base.extend({
  context: async (
    {
      context,
      browserName,
      playwright,
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    provide,
  ) => {
    if (browserName !== 'webkit') return provide(context)
    const dir = await mkdtemp(join(tmpdir(), 'marginalia-webkit-'))
    const persistent = await playwright.webkit.launchPersistentContext(dir, {
      baseURL,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    })
    try {
      await provide(persistent)
    } finally {
      await persistent.close()
      await rm(dir, { recursive: true, force: true })
    }
  },
  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()))
  },
})

/** Shows the reader's bars, hidden while reading, and opens the contents. */
export async function openContents(page: Page) {
  await page.locator('.reader-inset-top').click()
  await page.getByRole('button', { name: 'Table of contents' }).click()
  return page.getByRole('dialog', { name: 'Table of contents' })
}
