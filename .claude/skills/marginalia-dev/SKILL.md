---
name: marginalia-dev
description: Run, verify and debug Marginalia locally. Use when starting the dev server, driving the reader or chat in a browser to check a change, or scanning for secrets before a commit.
---

# Running and verifying Marginalia

Almost everything is client side. The one server piece is `/api/chat`, the inference
relay. There is no test suite, so "does it work" is answered by driving the real app in
a browser.

## Commands

```bash
npm install
npm run dev       # vite on http://localhost:5173
npm run build     # tsc -b && vite build, emits the service worker
npm run lint      # oxlint
npx tsc -b        # typecheck only, not a package script
```

`npm run lint` currently exits 0 with four `only-export-components` warnings in
`src/router.tsx`. That is pre-existing and expected; `router.tsx` exports the router
next to its `Deferred` wrapper. Only new warnings are worth acting on.

## Start the dev server detached

A dev server started in the foreground, or as a tracked background job, gets killed
between turns and the next browser call fails with a connection error. Detach it:

```bash
(npm run dev > /tmp/vite.log 2>&1 &)
sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
```

Confirm the 200 before touching the browser. If it is 000 the server is not up yet or
died, so read `/tmp/vite.log`.

## Get a test book

`public/books/moby-dick.epub` ships with the app and is imported automatically on a
first run, so an empty profile already has a book. It is Gutenberg's `.images` variant
deliberately, not `.noimages`: late-loading images are what reflow the paginated strip
and break navigation, so this is the build that exercises `goToSettled` in
`src/lib/useReader.ts`. Testing on `.noimages` hides that whole class of bug.

The auto-import is one-shot — `sampleBookSeeded` in settings stops it coming back after
a delete. To re-test seeding, clear the `marginalia` IndexedDB database.

To test the import path itself, use a different EPUB through the UI (Add EPUB) rather
than seeding IndexedDB, since import parses the OPF and extracts the cover.

## Reading the reader from a browser: the one real trap

epub.js paginates a section into a single horizontal strip and scrolls
`.epub-container` across it. On Moby Dick chapter 36 that strip is about 64,000 px
wide for a 780 px viewport, and **every block in the section is in the DOM at all
times**. Reading `document.body.textContent`, taking the first few paragraphs, or
using `elementFromPoint` will silently report a chapter far from the visible one.

Measured live at chapter 36: the correct probe returns "CHAPTER 36. The Quarter-Deck.",
matching the header. Reading the first DOM blocks instead returns "CHAPTER 22. Merry
Christmas.", fourteen chapters off, with no error to signal it.

The visible page is the container's scroll window. Element rects inside the iframe are
already in strip coordinates, because the iframe is as wide as the strip, so compare
them directly:

```js
() => {
  const c = document.querySelector('.epub-container');
  const doc = document.querySelector('.epub-view iframe').contentDocument;
  const left = c.scrollLeft, right = left + c.clientWidth;
  return [...doc.body.querySelectorAll('p, h1, h2, h3, h4')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= left - 2 && r.right <= right + 2;
    })
    .map(el => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
}
```

Two related notes. Navigation and rendering are async beyond one tick, so wait roughly
2s after a TOC jump before probing or the strip is still settling. And the header
subtitle (`header p + p`) is an independent read of the same position through
`chapterAt`, so agreeing with it is a genuine cross-check.

The same offset applies to synthetic input, in the other direction. A mouse event
dispatched from inside the book iframe carries a `clientX` in strip coordinates, so a
tap at screen x 620 arrives as 59120. Playwright's `page.mouse` works in screen
coordinates and is what you want; only convert when reading a rect back out. Assert
page turns on `.epub-container.scrollLeft` rather than on rendered text.

It moves by exactly one column pitch per turn, and the pitch is the *body box width* of
the rendered document, not `.epub-container.clientWidth`. The two agree at an integer
viewport width and diverge at a fractional one, which is the common case on a phone.
Take it from the frame:

```js
document.querySelector('.epub-view iframe').contentDocument.body.getBoundingClientRect().width
```

`scrollLeft % pitch` is the alignment invariant and should always be 0. `snapToPage` in
`src/lib/useReader.ts` re-establishes it after every relocation, because epub.js turns
pages with a relative `scrollLeft += layout.delta` that the compositor rounds to whole
device pixels, losing a fraction of a CSS pixel per turn with nothing to re-anchor it.
Left alone the error accumulates without bound: paging back and forth inside one section
reached 80px after 200 turns and kept climbing, until the viewport straddled two columns
and showed half of each page. Any change near navigation should assert that remainder
over a few hundred turns, since a handful of turns looks perfectly fine.

## Checking a reader interaction

Interaction bugs here hide behind plausible-looking screenshots, so assert on numbers:

```js
// scrollLeft before/after, in screen coordinates
await page.mouse.click(80, 300);   // left third  -> back one page
await page.mouse.click(700, 300);  // right third -> forward one page
await page.mouse.click(390, 300);  // centre      -> toggles chrome, must not move
```

A tap that should not move the page and a tap that should are different assertions;
check both, because the original bug turned the page on *every* tap and a test that
only checked "forward works" passed happily. To click a painted highlight, take the
mark's rect from the parent document and aim at its middle. The marks are short, around
17px tall, so a click a couple of pixels off silently misses and reads as a page turn:

```js
const g = document.querySelector('svg g');
const b = g.getBoundingClientRect();       // already parent-viewport coords
// click at (b.left + b.width * 0.9, b.top + b.height / 2)
```

Two things that will waste an hour before they look like anything but a broken fix.

**The book opens on the cover.** A fresh profile lands on `wrap0000.xhtml`, an image with
no text and a spine section only one page wide. Page-turn assertions there read 0 to 0,
because `next()` moves to the next section rather than scrolling, and anything that
selects text finds an `image` element and quietly gives up. Neither reports an error. Jump
to real prose first and wait for it to settle:

```js
await page.click('button[aria-label="Table of contents"]');
await new Promise(r => setTimeout(r, 600));
await page.evaluate(() => document.querySelectorAll('nav button')[6].click()); // CHAPTER 1
await new Promise(r => setTimeout(r, 6000));
```

Aim presses at a line box rather than a guessed point, and stay clear of the chrome: the
header and footer are `absolute` overlays *on top of* the page, so a y of 60 hits the
header and never reaches the book. Take rects from `range.getClientRects()` on a
paragraph, not `getBoundingClientRect()`, or the point lands in the gap between lines.

**`page.mouse.move` kills the browser on the reader page.** Both the headless shell and
`channel: 'chromium'` die with "Target page, context or browser has been closed", or hang
forever mid-drag. `page.mouse.click` survives — a hundred of them in a row is fine — so
it is specifically the move-and-hold that goes. Drive anything that needs a press
duration, a drag, or touch through CDP instead:

```js
const cdp = await context.newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
await new Promise(r => setTimeout(r, 700));         // the hold is the point
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
```

CDP coordinates are screen coordinates and the browser routes them into the iframe
itself, so the strip offset described above does not apply on the way in — only when you
read a rect back out.

## Testing touch behaviour

Selection inside the book is touch-specific: `src/lib/touchSelect.ts` only arms on
`(pointer: coarse)` and is a no-op with a mouse, so the desktop browser proves nothing
about it either way. Use a phone context with a fractional device pixel ratio, which is
also what surfaces pagination drift:

```js
const context = await browser.newContext({
  ...devices['Galaxy S9+'],
  viewport: { width: 360, height: 740 },
  deviceScaleFactor: 2.625,
  hasTouch: true,
  isMobile: true,
});
```

Assert both directions of the threshold, not just one. A tap held 400ms, 500ms and 600ms
must turn the page and leave `getSelection()` collapsed; a press held past 650ms must
select a word and *not* turn the page. Checking only the long press passes happily while
every ordinary tap is still selecting, which was the original bug.

The book frame is sandboxed without `allow-scripts`. Timers scheduled on its window never
fire, so a handler that looks correct will simply never run — schedule on the host window.
And a programmatic selection is collapsed again by the mouse events the browser
synthesises at `touchend` unless that event is cancelled, which reads as "the selection
never happened" a full second after it did.

## Testing chat

Chat defaults to the built-in provider, which POSTs to `/api/chat`. In dev that route is
served by the `marginalia-chat-relay` Vite plugin in `vite.config.ts`, running the same
`shared/relay.ts` handler the Netlify edge function runs in production. It needs
`OPENROUTER_API_KEY` in gitignored `.env.local`; without it the relay answers 503 and
the chat sheet shows the message.

Vite restarts when `vite.config.ts` or `shared/relay.ts` changes, so relay edits take a
second to land. Check the relay directly before blaming the UI:

```bash
curl -s -X POST http://localhost:5173/api/chat \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"messages":[{"role":"user","content":"Say ok"}]}' | head -c 300
```

The `model` and `provider` fields in that response tell you which route answered. Seeing
`google/gemma-4-26b-a4b-it` (no `:free`) means the free tier was rate limited upstream
and the paid fallback took over — normal, not a bug. The Origin header matters: the relay
rejects cross-origin requests, and curl without one is treated as same-origin.

The other provider is the reader's own OpenAI key, entered in Settings. Keep both models
on `gpt-4o-mini` when testing it, since every exchange also triggers a background digest
call.

Memory digests fire every 4 messages (`MESSAGES_PER_UPDATE` in `src/lib/memory.ts`) and
all summariser failures are swallowed by design, so a broken digest is invisible in the
UI. Check `db.bookMemory` directly when testing that path.

## Testing the book index

The index and retrieval are pure functions over IndexedDB, so they are the one part of this app
that can be tested without pretending to be a reader. In dev, Vite serves the app's own modules,
so a page can import them and call them directly:

```js
await page.evaluate(async () => {
  const { db } = await import('/src/db/db.ts')
  const { retrieveBookContext } = await import('/src/lib/bookIndex/retrieve.ts')
  const book = (await db.books.toArray())[0]
  const chunks = await db.bookChunks.where('bookId').equals(book.id).sortBy('index')
  return retrieveBookContext({ bookId: book.id, seedText: 'Queequeg', cfi: chunks[80].cfiStart, spoilerGuard: true })
})
```

epub.js is CommonJS, so `import('epubjs')` fails in the page. Vite's pre-bundled copy at
`/node_modules/.vite/deps/epubjs.js` works, and is how to exercise `extract.ts` against a real
spine without the reader.

Three things to know before believing a result:

`page.waitForFunction` treats an **async** predicate's Promise as truthy and resolves
immediately, so `waitForFunction(async () => (await db.books.count()) > 0)` passes against an
empty database. Poll from Node with a loop of `page.evaluate` instead.

Indexing starts 1.5 s after the rendition is ready, so a book opened and immediately queried has
no index. Each Playwright launch is a fresh profile, so it always rebuilds.

To see what a chat really sends, stub the relay and read the request rather than inferring from
the UI:

```js
await page.route('**/api/chat', async (route) => {
  captured = route.request().postDataJSON()
  await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"stub"}}' })
})
```

That is the only assertion that proves the prompt, since `buildSystemPrompt` is assembled from
four sources and the Memory tab renders it through a second code path.

## Before committing

`.env.local` holds a live API key. Recursive `grep -r` in this repo silently skips
gitignored files, so a clean result from it proves nothing. Use find instead:

```bash
find . -type f -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./dist/*" \
  -exec grep -lE "sk-(proj|ant|live|or)" {} +
```

The `or` branch catches OpenRouter keys, which is what `.env.local` now holds and what
the deployed relay reads from Netlify's environment. Keep placeholder keys out of docs
for the same reason the pattern above is split: a placeholder that matches the scan
buries the real hit.

The pattern is split so this file does not match itself; searching for the joined
literal instead makes every scan report this doc and bury the real hit.

That should list `./.env.local` and nothing else. Scan staged content the same way, and
include a positive control (grep for a word you know is in the diff) to prove the
search actually matched the file. Never commit `.env.local`, `test-books/`, or the
`.playwright-mcp` screenshots.
