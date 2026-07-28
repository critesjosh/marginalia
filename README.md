# Marginalia

A mobile-friendly EPUB reader that lets you highlight a passage and start an AI conversation about it, seeded with the book's metadata, your chapter and position, and the surrounding text. Conversations persist per book, and a rolling per-book memory makes new chats aware of what you've already discussed.

Built as a PWA: installable on Android, works offline, stores everything locally in IndexedDB.

## Status

Milestones M1 to M5 from `epub-chat-reader-plan.md` are implemented and verified end to end against Project Gutenberg's Moby Dick.

| Milestone | What works |
| --- | --- |
| M1 Library | EPUB import, OPF metadata + cover extraction, library grid, delete with cascade |
| M2 Reader | Paginated epub.js rendition, position persistence, TOC, themes, font size |
| M3 Highlights | Selection action bar, four colours, painted annotations, per-book list |
| M4 Chat | API key settings, context assembly, streaming replies, persisted conversations |
| M5 Memory | Rolling per-book digest injected into every new conversation |

Not yet done (M6): PWA share-target import, re-anchoring highlights by text when a CFI breaks, JSON import to match the existing export.

## Running it

```bash
npm install
npm run dev
```

Then open the app, go to **Settings**, and paste an OpenAI API key.

```bash
npm run build     # production build + service worker
npm run lint      # oxlint
npx tsc -b        # typecheck
```

## Configuration

The OpenAI key is stored in IndexedDB in your browser and is sent only to `api.openai.com`. **This is a single-user personal tool** — there is no backend, so anyone with access to the browser profile can read the key. Don't use it on a shared device. If this is ever shared, move the key behind a small proxy (a Cloudflare Worker) instead.

Defaults to `gpt-4o-mini` for both chat and the memory digest; both are configurable in Settings.

## How it works

```
Library ──> Reader (epub.js) ──> Selection bar ──> Chat sheet
   │            │                                      │
   └──────── IndexedDB (Dexie) ───────────────────────┘
     books · highlights · conversations · messages
     bookMemory · settings
                                                  │ fetch
                                                  ▼
                                            OpenAI API
```

Each conversation's system prompt carries the book metadata, the current chapter and percentage, the highlighted passage, roughly 2,400 characters of surrounding prose, the book's memory digest, and an optional spoiler guard.

After every few messages, a cheap background call folds the exchange into that book's digest (capped around 250 words), which is then injected into every future conversation for the book. Failures there are swallowed so the summariser can never break the chat.

## Notes on the tricky parts

Two behaviours are worth knowing about, because both were bugs found during testing:

**Single-file books.** Project Gutenberg puts an entire book in one XHTML file and splits chapters with `#anchor` fragments. Matching the table of contents on document href alone marks *every* chapter as current at once, so chapter detection resolves each anchor to a CFI and compares it against the reading position (`src/lib/chapters.ts`). Anchors are memoised per document — a 135-chapter book would otherwise re-measure the DOM on every page turn.

**Layout drift.** epub.js paginates such a file into a single strip tens of thousands of pixels wide. Images that finish loading after a jump reflow that strip and drag the target anchor several chapters off-screen, so navigation displays the target, waits for images and one animation frame, then displays it again (`goToSettled` in `src/lib/useReader.ts`).

Chapter titles are matched against the page's **end** CFI, not its start: when a chapter heading appears partway down a page, the reader can see the new chapter even though the page still opens with the tail of the previous one.

`useReader` takes a book *id* rather than a book record, because `useLiveQuery` returns a fresh object after every write and the hook writes the reading position on every relocate — depending on the record rebuilt the rendition in a loop.

## Limitations

- DRM-protected EPUBs (Adobe, Kindle formats) are rejected on import. DRM-free only.
- Highlights are anchored by CFI. The passage text is stored alongside for future re-anchoring, but the text-search fallback is not implemented yet.
- Export produces a JSON backup of highlights and conversations; book files are not included, and there is no import yet.
- iOS Safari caps IndexedDB more aggressively than Android. This is Android-first.
