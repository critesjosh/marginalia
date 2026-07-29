---
name: marginalia-dev
description: Run, verify and debug Marginalia locally. Use when starting the dev server, driving the reader or chat in a browser to check a change, or scanning for secrets before a commit.
---

# Running and verifying Marginalia

Everything is client side. There is no backend, no test suite and no fixtures in the
repo, so "does it work" is answered by driving the real app in a browser.

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

`test-books/` is gitignored, so a fresh clone has no EPUB. Fetch Moby Dick:

```bash
mkdir -p test-books
curl -sL https://www.gutenberg.org/ebooks/2701.epub3.images -o test-books/moby-dick.epub
```

Use the `.images` variant deliberately, not `.noimages`. Late-loading images are what
reflow the paginated strip and break navigation, so the images build is the one that
exercises `goToSettled` in `src/lib/useReader.ts`. Testing on `.noimages` hides that
whole class of bug.

Import it through the UI (Add EPUB, or Choose a file on the empty library) rather than
seeding IndexedDB, since import parses the OPF and extracts the cover.

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

## Testing chat

Chat needs a real OpenAI key, entered in Settings and stored in IndexedDB. A key for
local runs lives in gitignored `.env.local` as `OPENAI_TEST_KEY`; paste the value into
Settings and press Test and save. Keep both models on `gpt-4o-mini`, which is the
default, since every exchange also triggers a background digest call.

Memory digests fire every 4 messages (`MESSAGES_PER_UPDATE` in `src/lib/memory.ts`) and
all summariser failures are swallowed by design, so a broken digest is invisible in the
UI. Check `db.bookMemory` directly when testing that path.

## Before committing

`.env.local` holds a live API key. Recursive `grep -r` in this repo silently skips
gitignored files, so a clean result from it proves nothing. Use find instead:

```bash
find . -type f -not -path "./node_modules/*" -not -path "./.git/*" \
  -exec grep -lE "sk-(proj|ant|live)" {} +
```

The pattern is split so this file does not match itself; searching for the joined
literal instead makes every scan report this doc and bury the real hit.

That should list `./.env.local` and nothing else. Scan staged content the same way, and
include a positive control (grep for a word you know is in the diff) to prove the
search actually matched the file. Never commit `.env.local`, `test-books/`, or the
`.playwright-mcp` screenshots.
