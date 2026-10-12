# Architecture

## Goal

A mobile-friendly EPUB reader where highlighting a passage starts an AI
conversation seeded with the book's metadata, the reader's chapter and
position, and the surrounding text. Conversations persist per book, and a
rolling per-book memory makes new chats aware of earlier ones.

## Requirements

- Reading, highlights, and stored conversations work offline.
- All reader data stays on the device in IndexedDB, except a thread or a book
  card the reader explicitly publishes as a link.
- Chat works for any visitor with no signup or API key.
- The KOReader plugin can ask about a selection on an e-reader and hand its
  highlights to the PWA.
- Product telemetry is consent-gated by region, allowlisted, and anonymous,
  and is off unless a build configures it (decision 0008).

## Constraints

- DRM-free EPUBs only. EPUB scripts stay disabled.
- Book text is untrusted and stays fenced in model prompts.
- Every hosted chat request is billed; the provider credit cap is the ceiling.
- iOS Safari limits IndexedDB storage more than Android Chrome.

## Non-goals

- A native app or app-store distribution.
- Accounts, or server-side storage of books and conversations beyond threads
  and book cards (title, author, Gutenberg id, cover) a reader explicitly
  publishes. EPUB files are never uploaded.
- Syncing memory between the PWA and KOReader.
- Telemetry that identifies readers or carries their content: no person
  profiles, persistent ids, session recording, or autocapture (decision 0008).

## Service and data boundaries

```mermaid
flowchart LR
  PWA[Reader PWA] --> IDB[(IndexedDB)]
  PWA --> Relay[Vite / App Worker]
  KO[KOReader plugin] --> Relay
  Relay --> OR[OpenRouter, billed]
  Relay --> PG[gutenberg.org]
  Relay --> OL[Open Library covers]
  Relay --> KV[(Workers KV: published threads and book links)]
  Relay --> TS[Turnstile siteverify]
  PWA -. opt-in, allowlisted events .-> PH[PostHog Cloud]
```

Deploy adapters share `shared/relay.ts`, `shared/gutenberg.ts` and
`shared/covers.ts`; they must not import browser modules.

## Local storage schema

`src/db/types.ts` defines records; `src/db/db.ts` owns Dexie versions 1–6.
Books own highlights, conversations, and memory. Conversations own messages.
Compound indexes group children by book/conversation plus creation/update time.
Version 2 repairs old digest delimiters, version 3 adds archives, and version 4
adds external-id indexes for idempotent KOReader import, and version 5 drops the
removed audiobook token and position from settings. Do not rewrite migration
history. Use transactions and bulk `anyOf` lookups instead of per-row queries.
Deletion cascades; archiving removes EPUB bytes but preserves notes and file hash.

HTTP contracts are `docs/api.openapi.yml`. Lua-to-reader handoff validation is
`src/lib/koreader.ts`, exercised with synthetic fixtures and the real Lua VM.

## External services

Chat sends the user-selected context to the chosen model provider. Offline
reading and normal tests need no external services.
When a build configures it and the reader's preference allows, the PWA sends
allowlisted product events to PostHog Cloud (`src/lib/telemetry.ts`,
[telemetry.md](telemetry.md)): event names, enum properties, the app version,
and a page-load id. Never book content, titles, notes, chats, or URLs. Worker
metrics are fixed operation names, status codes, and numeric durations. Publishing a thread sends its snapshot to
the Worker, and sharing a book sends its title, author, Gutenberg id and a
re-encoded cover. Both load Cloudflare Turnstile in their dialog only. A local storage-loss log is shared only
when the reader submits a prefilled GitHub issue from Settings.

## Decision index

Record consequential choices by copying [the template](decisions/TEMPLATE.md)
to `decisions/NNNN-short-title.md` and linking it here.

- [0001 Build a PWA on epub.js, not a native Android app](decisions/0001-pwa-with-epubjs.md)
- [0002 Route chat through a hosted relay that holds the key](decisions/0002-hosted-chat-relay.md)
- [0003 Match books by EPUB file hash, not title](decisions/0003-match-editions-by-file-hash.md)
- [0004 Keep a bounded rolling digest per book as chat memory](decisions/0004-rolling-book-memory.md)
- [0005 KOReader keeps its own digest and folds it lazily](decisions/0005-koreader-device-digest.md)
- [0006 Publish shared threads at unlisted links](decisions/0006-public-thread-links.md)
- [0007 Share books at links that add them for the recipient](decisions/0007-shared-book-links.md)
- [0008 Send privacy-first product telemetry to PostHog Cloud](decisions/0008-privacy-first-telemetry.md)
