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
| Web search | The companion looks things up mid-answer when the book cannot answer them, and cites what it read |

Not yet done (M6): PWA share-target import, re-anchoring highlights by text when a CFI breaks, JSON import to match the existing export.

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

### Web search

Questions about a book routinely leave it — who the author was, what the period was like, how a translator chose a word. The companion can search the web for those, and decides for itself when a question needs it.

This is `openrouter:web_search`, an OpenRouter *server tool*: the relay lists it on the request, the model asks for a search mid-answer, and OpenRouter runs the query and feeds the results back before the reply finishes. Nothing in this repo issues a search, so there is no second API key to provision — the existing `OPENROUTER_API_KEY` pays for it. Sources come back as `url_citation` annotations, which are stored on the message and shown under the reply.

Searches are billed per result, so the relay is deliberately stingy about offering the tool:

- `max_results` is 3.
- Only streamed turns get it. The background digest calls come through the same endpoint non-streamed, and re-summarising a conversation that already happened never needs the live web.
- If a provider refuses the tool, the relay retries the same route without it and stops offering it for ten minutes, so a reply is never lost to an enhancement and readers don't each pay a round trip to rediscover the same refusal. Tool support belongs to the provider serving the model, not the model name, so the paid route's `allow_fallbacks` can land somewhere that has none.

Search is a property of the relay, so it applies to the built-in provider only. A reader on their own key talks to OpenAI directly, where nothing is listening for a tool call, and the system prompt drops the section rather than promising a lookup that cannot happen.

### Deploying

Set `OPENROUTER_API_KEY` in the Netlify site's environment variables. Nothing else is required — `netlify.toml` declares the edge function, which runs before the SPA redirect so `/api/chat` never falls through to `index.html`.

Because the relay is open to anyone who loads the site, `shared/relay.ts` pins the model and provider server-side and caps message count, payload size and output tokens. It also rejects cross-origin requests and throttles per IP, but both are best-effort — an Origin header can be forged, and edge isolates don't share the throttle state. **Set a credit limit on the OpenRouter key**; that is the only hard ceiling on spend.

### Untrusted book content

Book content is treated as untrusted. EPUB scripts are not allowed to run: epub.js turns `allowScriptedContent` into `sandbox="allow-same-origin allow-scripts"`, and that pair voids the sandbox, so a book's own scripts would run on this origin and could read any stored key and every note out of IndexedDB. The cost is that scripted or interactive EPUBs lose their interactivity; the text still renders. Text drawn from a book is also fenced with a per-request delimiter before it reaches the model, so a passage cannot pose as an instruction. Web search widens what a successful injection would be worth — a book that could talk the companion into a lookup could aim it at a URL of the book's choosing — so the prompt says outright that only the reader can send it searching, and that a URL written into the text is material to discuss rather than somewhere to go. A CSP in `netlify.toml` is the second layer: `connect-src` allows only this origin — which covers `/api/chat`, since the relay is same-origin — and `api.openai.com` for readers using their own key.

## How it works

```
Library ──> Reader (epub.js) ──> Selection bar ──> Chat sheet
   │            │                                      │
   └──────── IndexedDB (Dexie) ───────────────────────┘
     books · highlights · conversations · messages
     bookMemory · settings
                                                  │ fetch
                                                  ▼
                                   /api/chat (Netlify edge function)
                                                  │
                                                  ▼
                                       OpenRouter ──> Gemma 4 26B
                                            │
                                            └──> web search ──> url_citation
```

Each conversation's system prompt carries the book metadata, the current chapter and percentage, the highlighted passage, roughly 2,400 characters of surrounding prose, the book's memory digest, an optional spoiler guard, and — on the built-in provider — when to reach for a web search.

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

## Limitations

- DRM-protected EPUBs (Adobe, Kindle formats) are rejected on import. DRM-free only.
- Highlights are anchored by CFI. The passage text is stored alongside for future re-anchoring, but the text-search fallback is not implemented yet.
- Export produces a JSON backup of highlights and conversations; book files are not included, and there is no import yet.
- iOS Safari caps IndexedDB more aggressively than Android. This is Android-first.
