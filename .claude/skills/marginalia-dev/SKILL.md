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
page turns on `.epub-container.scrollLeft`, which moves by exactly one `clientWidth`
per turn, rather than on rendered text.

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
