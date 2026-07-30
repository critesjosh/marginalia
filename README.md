# Marginalia

A mobile-friendly EPUB reader that lets you highlight a passage and start an AI conversation about it, seeded with the book's metadata, your chapter and position, and the surrounding text. Conversations persist per book, and a rolling per-book memory makes new chats aware of what you've already discussed.

Built as a PWA: installable on Android, works offline, stores everything locally in IndexedDB.

Chat works for every visitor with no signup and no API key: requests go through a Netlify edge function that holds an OpenRouter key server-side. A public-domain copy of Moby Dick ships with the app, so a first-time visitor has something to read immediately.

## Status

Milestones M1 to M5 from `epub-chat-reader-plan.md` are implemented and verified end to end against Project Gutenberg's Moby Dick.

| Milestone | What works |
| --- | --- |
| M1 Library | EPUB import, OPF metadata + cover extraction, library grid, delete with cascade |
| M2 Reader | Paginated epub.js rendition, position persistence, TOC, themes, font size |
| M3 Highlights | Selection action bar, four colours, painted annotations, tap a highlight to reopen its chat, per-book list |
| M4 Chat | Hosted relay or own OpenAI key, context assembly, streaming replies, persisted conversations |
| M5 Memory | Rolling per-book digest injected into every new conversation, readable and editable under the reader's Memory tab |
| M7a Book index | Every book indexed on the device as it is read, so a chat carries matching passages from earlier in the book — and the spoiler guard becomes a filter rather than a request |

Not yet done (M6): PWA share-target import, re-anchoring highlights by text when a CFI breaks, JSON import to match the existing export.

`local-agent-plan.md` is the review behind M7. The rest of it — a small model running on the phone to summarise what the index only quotes — is still proposal.

## Running it

```bash
npm install
npm run dev
```

For chat to work locally, put an OpenRouter key in `.env.local` (gitignored):

```
OPENROUTER_API_KEY=<a key from openrouter.ai/keys>
```

A Vite plugin serves `/api/chat` in dev using the same handler the deployed edge function runs, so `npm run dev` exercises the real relay — no Netlify CLI needed.

```bash
npm run build     # production build + service worker
npm run lint      # oxlint
npx tsc -b        # typecheck
```

## Inference

Two providers, chosen in **Settings**:

**Built-in (default).** The browser POSTs to `/api/chat`, a Netlify edge function that adds the OpenRouter key and forwards to OpenRouter. Visitors need no account, and the key never reaches the client.

| | Model | Provider routing |
| --- | --- | --- |
| Primary | `google/gemma-4-26b-a4b-it:free` | Google AI Studio, no OpenRouter fallback |
| Fallback | `google/gemma-4-26b-a4b-it` | Cloudflare first (fastest endpoint for this model), others allowed |

The free tier draws on a shared upstream pool that is regularly exhausted, so the paid model is used more often than the word "fallback" suggests. When the free tier returns 429 the relay stops trying it for a minute, so readers don't each pay the latency of a request that will be refused.

**Own OpenAI key.** Stored in IndexedDB, sent only to `api.openai.com`, billed to the reader. Defaults to `gpt-4o-mini` for chat and the digest. Anyone with access to the browser profile can read it, so don't use that option on a shared device.

### Deploying

Set `OPENROUTER_API_KEY` in the Netlify site's environment variables. Nothing else is required — `netlify.toml` declares the edge function, which runs before the SPA redirect so `/api/chat` never falls through to `index.html`.

Because the relay is open to anyone who loads the site, `shared/relay.ts` pins the model and provider server-side and caps message count, payload size and output tokens. It also rejects cross-origin requests and throttles per IP, but both are best-effort — an Origin header can be forged, and edge isolates don't share the throttle state. **Set a credit limit on the OpenRouter key**; that is the only hard ceiling on spend.

### Untrusted book content

Book content is treated as untrusted. EPUB scripts are not allowed to run: epub.js turns `allowScriptedContent` into `sandbox="allow-same-origin allow-scripts"`, and that pair voids the sandbox, so a book's own scripts would run on this origin and could read any stored key and every note out of IndexedDB. The cost is that scripted or interactive EPUBs lose their interactivity; the text still renders. Text drawn from a book is also fenced with a per-request delimiter before it reaches the model, so a passage cannot pose as an instruction. A CSP in `netlify.toml` is the second layer: `connect-src` allows only this origin — which covers `/api/chat`, since the relay is same-origin — and `api.openai.com` for readers using their own key.

## How it works

```
Library ──> Reader (epub.js) ──> Selection bar ──> Chat sheet
   │            │                    │                 │
   │            └─> Book index ──> Retrieval ──────────┤
   │                                                   │
   └──────── IndexedDB (Dexie) ───────────────────────┘
     books · highlights · conversations · messages
     bookMemory · bookChunks · bookIndexState · settings
                                                  │ fetch
                                                  ▼
                                   /api/chat (Netlify edge function)
                                                  │
                                                  ▼
                                       OpenRouter ──> Gemma 4 26B
```

Each conversation's system prompt carries the book metadata, the current chapter and percentage, the highlighted passage, roughly 2,400 characters of surrounding prose, the book's memory digest, an outline of the chapters reached, up to four matching passages from earlier in the book, and an optional spoiler guard.

## The book index

Opening a book cuts it into roughly 6,000-character chunks, each addressed by a CFI and labelled with its chapter, and stores them in IndexedDB (`src/lib/bookIndex/`). Moby Dick becomes 191 chunks in about 250 ms. Nothing is uploaded and no model is involved: when a chat starts, chunks are scored by IDF-weighted term overlap against the highlighted passage and the reader's question, and the best few are quoted into the prompt. Names score highest, which is the point — "who was Bulkington?" finds the two chapters that name him, and no amount of surrounding prose would have.

A relevance floor keeps ordinary English out. A chunk is quoted only when the terms it shares with the query are distinctive enough: measured against this book, "Bulkington" scores 9.1 and "Queequeg" 2.9 against a bar of 2.2, while "whale" reaches 1.6 and "day" plus "men" 1.9. The vocabulary of asking about books — *mentioned*, *describes*, *chapter* — is stoplisted, because Melville writes "mentioned" far less often than he writes his own harpooneer, and without that "where has Queequeg been mentioned?" ranks on the wrong word.

Because every chunk knows where it is, the spoiler guard stops being a request. Chunks past the reader's position are not sent at all, the cursor found by comparing CFIs rather than percentages. A conversation that cannot be placed gets no excerpts, since any of them might be the ending. The Memory tab shows what was found and the whole prompt it lands in; **Search the whole book** in Settings turns it off.

After every few messages, a cheap background call folds the exchange into that book's digest (capped around 250 words), which is then injected into every future conversation for the book. Failures there are swallowed so the summariser can never break the chat.

The digest is the only thing carried between conversations, so it is also the only thing a reader cannot reconstruct from the transcripts. The Memory tab on a book's chats screen shows it verbatim, lets the reader rewrite or clear it, and renders the whole system message it ends up inside. Later automatic updates merge into whatever is stored, so an edit carries forward rather than being summarised away.

## Notes on the tricky parts

These all came out of bugs found by driving the real UI, and they share one root
cause: epub.js lays a spine section out as a single strip far wider than the screen,
so anything measured against the viewport needs the scroll offset applied first.

**Tap coordinates.** epub.js re-emits iframe clicks with a `clientX` measured from the
start of that strip, not the visible page. Comparing it against the viewport width made
every tap past the first page read as "right edge", so the reader turned forward on
every tap and both tap-back and tap-to-toggle-chrome were unreachable. The click handler
in `src/lib/useReader.ts` subtracts `.epub-container`'s `scrollLeft` before deciding.
Two related rules live there too: a click that finishes a drag-selection is not a page
turn, and a tap on a highlight is claimed by the annotation callback, which needs the
turn deferred by a task because marks-pane hand-proxies the same DOM event and the
handler order is not guaranteed.

**Single-file books.** Project Gutenberg puts an entire book in one XHTML file and splits chapters with `#anchor` fragments. Matching the table of contents on document href alone marks *every* chapter as current at once, so chapter detection resolves each anchor to a CFI and compares it against the reading position (`src/lib/chapters.ts`). Anchors are memoised per document — a 135-chapter book would otherwise re-measure the DOM on every page turn.

**Layout drift.** epub.js paginates such a file into a single strip tens of thousands of pixels wide. Images that finish loading after a jump reflow that strip and drag the target anchor several chapters off-screen, so navigation displays the target, waits for images and one animation frame, then displays it again (`goToSettled` in `src/lib/useReader.ts`).

Chapter titles are matched against the page's **end** CFI, not its start: when a chapter heading appears partway down a page, the reader can see the new chapter even though the page still opens with the tail of the previous one.

`useReader` takes a book *id* rather than a book record, because `useLiveQuery` returns a fresh object after every write and the hook writes the reading position on every relocate — depending on the record rebuilt the rendition in a loop.

**CFIs from element ranges do not compare.** The index addresses each chunk with `section.cfiFromElement(firstBlock)`, never with a range over the chunk's blocks, and this is not a style preference. A range built with `setStartBefore(block)` has the block's *parent* as its container and the child index as its offset, and epub.js encodes that offset as a character position in the parent's first text node — so every chunk in a section comes out as something like `/4,/1:20,/1:31`, which compares as the very start of the document. The failure is silent: the CFIs are well-formed and resolve fine, only their ordering is wrong. All 191 chunks of Moby Dick collapsed onto their section's first chapter, and the index reported 12 chapters for a 135-chapter book. `cfiFromRange` is right for a text selection, where the boundaries really are text nodes with offsets, which is why highlights use it.

**Chunk boundaries are not chapter boundaries.** A chunk is a fixed length of prose, so several short chapters can start inside one. Labelling each chunk only with the chapter it opens in dropped 24 of this book's 141 table-of-contents entries from the outline, and named the chapter *before* the one the reader could see in the header. Each chunk therefore also records the chapters that begin inside it.

## Limitations

- DRM-protected EPUBs (Adobe, Kindle formats) are rejected on import. DRM-free only.
- Highlights are anchored by CFI. The passage text is stored alongside for future re-anchoring, but the text-search fallback is not implemented yet.
- Export produces a JSON backup of highlights and conversations; book files are not included, and there is no import yet.
- iOS Safari caps IndexedDB more aggressively than Android. This is Android-first.
