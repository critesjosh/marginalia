# EPUB Reader + AI Chat — Implementation Plan

## Goal
A mobile-friendly e-reader where the user loads EPUB files into a personal library, reads on their Android phone, highlights passages, and launches an OpenAI-powered conversation seeded with the highlighted text plus book context (title, author, chapter, position). Conversations persist per book, and a memory layer makes new chats aware of prior discussions about the same book.

## Recommendation: PWA, not native Android
Build this as a Progressive Web App:

- **epub.js** is a mature, browser-native EPUB renderer with built-in support for text selection, highlights, and CFI (Canonical Fragment Identifier) locations. There is no equally good off-the-shelf Kotlin equivalent — native would mean wrapping a WebView anyway.
- A PWA is installable on Android (Add to Home Screen), works offline via a service worker, and requires no Play Store review cycle.
- IndexedDB comfortably stores full EPUB files, highlights, and chat history locally.
- Same codebase later works on desktop/tablet for free.

Only go native if you later need deep OS integration (share-target for EPUBs, background sync, widgets). Even then, wrap the PWA with Capacitor or TWA rather than rewriting.

## Important assumption: OpenAI access = API key
There is no supported way to "log in with a ChatGPT account" and drive ChatGPT programmatically from a third-party app. The plan assumes the user pastes an **OpenAI API key** into a settings screen (stored locally, never sent anywhere except api.openai.com). Calls go to the Chat Completions / Responses API with a model like `gpt-4o`. If a backend is added later, the key could live server-side instead.

## Architecture (v1 — fully client-side, no backend)

```
┌──────────────────────────────────────────────┐
│ PWA (React + TypeScript + Vite)              │
│                                              │
│  Library page ── Reader (epub.js) ── Chat UI │
│        │              │                 │    │
│        └──────── IndexedDB (Dexie) ─────┘    │
│         books · highlights · chats ·         │
│         book-memory summaries · settings     │
│                                              │
│  Service worker (offline shell + book cache) │
└───────────────┬──────────────────────────────┘
                │ fetch (user's API key)
                ▼
        OpenAI API (chat + optional embeddings)
```

**Stack**
- React + TypeScript + Vite, Tailwind for styling
- `epubjs` for rendering/selection/CFI
- `dexie` for IndexedDB
- `vite-plugin-pwa` for manifest + service worker
- OpenAI calls via plain `fetch` (no SDK needed; keeps bundle small)

**Data model (IndexedDB tables)**
- `books`: id, title, author, cover blob, epub blob, metadata (from OPF), addedAt, lastOpenedCfi
- `highlights`: id, bookId, cfiRange, text, color, note?, createdAt
- `conversations`: id, bookId, highlightId?, title, createdAt, updatedAt
- `messages`: id, conversationId, role, content, createdAt
- `bookMemory`: bookId, summary (rolling digest of all conversations for that book), updatedAt
- `settings`: apiKey, model, theme, fontSize

## Core features

### 1. Library page
- Import EPUB via `<input type="file">` (and later PWA share-target so "Open with" works from a file manager)
- Parse OPF metadata on import: title, author, description, cover → store in `books`
- Grid of covers; tap to open reader; long-press for delete/details
- Per-book badge showing number of conversations

### 2. Reader
- epub.js rendition in paginated mode with swipe/tap navigation
- Persist reading position (CFI) per book
- Font size / theme (light, dark, sepia) settings
- Table of contents drawer
- Render saved highlights as annotations (epub.js `annotations` API); tapping a highlight reopens its conversation

### 3. Highlight → chat flow
- On text selection, show an action bar: **Highlight**, **Chat about this**, Copy
- "Chat about this" creates a highlight + a new conversation, opens the chat panel (bottom sheet on mobile)
- System prompt assembled per conversation:
  - Book title, author, publisher/year, description (from EPUB metadata)
  - Current chapter title and approximate position (e.g. "Chapter 7, ~54% through the book")
  - The highlighted passage, plus ~500 words of surrounding text for context
  - The book's `bookMemory` summary (see below)
  - Instruction: discuss the book knowledgeably, avoid spoiling content beyond the reader's current position unless asked
- Streaming responses (SSE) for responsive feel

### 4. Memory system
Two layers, cheap and effective:
- **Per-conversation**: full message history sent (with sliding-window truncation if it grows long)
- **Per-book rolling summary** (`bookMemory`): after each conversation ends (or every N messages), one extra API call summarizes "what the reader and AI have discussed so far about this book — themes explored, questions raised, opinions formed" and merges it into the existing summary (cap ~800 tokens). This summary is injected into every new conversation's system prompt.
- Optional v2: embed each conversation with the embeddings API and retrieve top-k relevant past exchanges instead of (or alongside) the summary.

### 5. Chats page (per book)
- List of conversations for the book, each showing its seed highlight
- Resume any conversation; delete; rename

## Milestones (hand-off units for agents)

**M1 — Skeleton + Library**: Vite/React/PWA scaffold, Dexie schema, EPUB import + metadata parsing, library grid. *Done when: import an EPUB and see it in the library offline after reload.*

**M2 — Reader**: epub.js integration, pagination, position persistence, TOC, themes. *Done when: read a book comfortably on a phone and resume where you left off.*

**M3 — Highlights**: selection action bar, create/render/delete highlights, highlights list per book. *Done when: highlights survive reloads and are tappable.*

**M4 — Chat**: settings screen for API key/model, context assembly, streaming chat UI, conversations persisted. *Done when: highlight → conversation with correct book context works end to end.*

**M5 — Memory**: rolling per-book summary generation and injection; conversations list per book. *Done when: a new chat demonstrably references a prior chat's topics.*

**M6 — Polish**: share-target import, spoiler-guard prompt tuning, export/backup of library + chats (JSON), error handling for bad EPUBs and API failures.

## Risks / notes
- **Large EPUBs**: parse lazily; don't unzip the whole book into memory at once (epub.js handles this from a Blob).
- **CFI fragility**: store the highlight text alongside the CFI so highlights can be re-anchored by text search if a CFI fails.
- **API key in browser**: acceptable for a personal tool; note in README that this is single-user. A tiny proxy (Cloudflare Worker) is the upgrade path if it's ever shared.
- **DRM'd EPUBs won't work** (Adobe DRM, Kindle formats) — DRM-free EPUBs only.
- **iOS Safari** caps IndexedDB storage more aggressively; fine for Android-first.

## Open questions
1. API key approach OK, or do you want a small backend (e.g. Cloudflare Worker) holding the key from day one?
2. Personal single-user tool, or might others use it (changes auth/storage decisions)?
3. Any preference on model (gpt-4o vs cheaper mini for chat, mini for summaries)?
