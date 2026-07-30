# A local agent for whole-book context — feasibility review

Research for [issue #6](https://github.com/critesjosh/marginalia/issues/6): can a small model
running on the reader's phone crawl large sections of a book and feed summaries, position
information and other distilled notes to the remote model over the API? And what would that
require of this application's architecture?

Nothing here is implemented. This document is the review; the milestones at the end are the
proposal.

## Verdict

Yes, and the runtime to do it exists as a plain npm dependency — no native shell, no store
listing. Google publishes [`@litert-lm/core`](https://www.npmjs.com/package/@litert-lm/core),
a WebGPU LLM runtime whose supported model list is exactly two entries: `gemma-4-E2B-it-web`
and `gemma-4-E4B-it-web`. E2B is the one that fits a phone.

Three things make this a bigger change than "add a dependency":

1. **Marginalia cannot currently read a book.** Every character of text the app has ever sent
   to a model came out of the rendered iframe — `selectionText` and `contextAround` in
   `src/lib/highlights.ts` walk the live DOM of the one spine section on screen. Crawling needs
   a headless path over the whole spine, which does not exist yet.
2. **The crawl is an hour of sustained GPU work per book, not a request.** It has to be a
   resumable background job with a battery policy, which is a subsystem the app has no
   equivalent of.
3. **A local model's output is untrusted book-derived text.** It has read the book; it is as
   injectable as the book is. It has to arrive at the remote prompt inside the same fence the
   passage does, and the local model must never be given a tool that can do anything but read.

The honest summary of the value: what the local model buys is *free, private, offline bulk
compute* over text the app already has on disk. It does not buy better literary judgement
than the remote 26B, and should not be asked for any.

## Why bother — the gap this closes

A conversation today shows the model about 0.2% of the book:

| What the prompt carries | Size |
| --- | --- |
| Highlighted passage | usually a sentence or two |
| Surrounding prose (`contextAround`, 1,200 chars each side) | ~2,400 chars |
| Rolling digest (`src/lib/memory.ts`) | ≤250 words, and only of *chats*, not of the book |
| Chapter label + percentage | two lines |

Measured on the copy of Moby Dick that ships in `public/books`: 12 spine documents, 11 of them
prose, holding 1,234,116 characters and 216,402 words — roughly 309,000 tokens. So the model
answers questions about a 309k-token book from a 600-token window plus whatever it remembers of
Melville from pre-training. That works surprisingly well for canon and fails completely for anything else —
ask about a self-published novel and the reply is fluent guesswork.

The digest does not close the gap: it summarises *conversations*, so a book you have not
discussed yet contributes nothing.

Could the remote model do the crawl instead? Not through this relay, by its own design.
`shared/relay.ts` caps a request at 120,000 characters and an IP at 40 requests per 5 minutes,
so one book is over 150 requests and at least 20 minutes of hammering the endpoint that exists
to be free for strangers. The local model's advantage is not quality. It is that its compute is
not metered.

## What can actually run on the phone

| Option | Verdict for Marginalia |
| --- | --- |
| **LiteRT-LM JS API** (`@litert-lm/core`) + `gemma-4-E2B-it-web.litertlm` | **The candidate.** Stays a PWA, WebGPU, tool calling included, Apache-2.0. Early preview, text-in/text-out. |
| Chrome's built-in Prompt API (`LanguageModel`, Gemini Nano) | Zero download, but [not available in Chrome for Android](https://developer.chrome.com/docs/ai/prompt-api) — desktop and Chromebook Plus only. Wrong platform for an Android-first reader. |
| [ML Kit GenAI Prompt API](https://developers.google.com/ml-kit/genai/prompt/android) (AICore, Gemini Nano) | Best on-device story on Android, and the model is already on the device — but it is a Kotlin API. Needs a Capacitor/TWA shell, which the original plan deliberately deferred. |
| WebLLM / Transformers.js | Also WebGPU, wider model choice, no Gemma 4 E2B web build. Fallback if LiteRT-LM's preview proves unusable. |
| Native LiteRT-LM in a Capacitor shell | Fastest path (NPU/OpenCL rather than WebGPU) and the only way to run while the screen is off. The upgrade, not the experiment. |

### What the LiteRT-LM JS API gives us

Verified by inspecting `@litert-lm/core@0.14.0` from the registry, not from the docs:

```ts
import { Engine } from '@litert-lm/core'

const engine = await Engine.create({
  model: blobOrUrlOrStream,                 // string | Blob | ReadableStream<Uint8Array>
  mainExecutorSettings: { maxNumTokens: 4096 },
})

const chat = await engine.createConversation({
  preface: { messages: [{ role: 'system', content: '…' }], tools: [/* FunctionDeclaration */] },
  enableConstrainedDecoding: true,
})

for await (const chunk of chat.sendMessageStreaming(text)) { /* chunk.content[0].text */ }
chat.cancel()
await engine.delete()
```

Points that matter to the design:

- **Streaming and cancellation are first class.** `sendMessageStreaming` returns a
  `ReadableStream`, and breaking out of the `for await` cancels the generation. A crawl can be
  abandoned the instant the reader turns a page.
- **Tool calling is real, not prompt-engineered.** `Preface.tools` takes JSON-Schema
  `FunctionDeclaration`s, `enableConstrainedDecoding` constrains the output, and
  `AutoToolChat` executes declared tools (in parallel, with a `recurringToolCallLimit` and an
  `onToolProgress` callback) and feeds results back. It also accepts WebMCP-shaped tools.
- **Nothing in `dist/` touches `document` or `window`** — the only browser global it reaches
  for is `navigator.gpu.requestAdapter`. So it should run in a Web Worker, which is where it
  has to run. Worth confirming in the spike, because it is load-bearing.
- **There is no built-in model cache.** `model` takes a URL, a `Blob` or a stream; persistence
  is ours to build.
- **The WASM runtime is 20 MB (JSPI build) or 31 MB (asyncify build)**, feature-detected at
  load. `DEFAULT_WASM_PATH` points at jsDelivr, which our CSP forbids, so we self-host.

## The numbers that decide the design

| Quantity | Value | Source |
| --- | --- | --- |
| `gemma-4-E2B-it-web.litertlm` | ~2.0 GB (reports range to 2.9 GB) | model card / community |
| E2B with QAT, text-only | [~1 GB](https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/) — but no `-web` build listed yet | Google |
| WASM runtime, self-hosted | 20 MB or 31 MB | package inspection |
| Browser storage quota | up to [60% of device disk](https://developer.chrome.com/docs/workbox/understanding-storage-quota); Chrome recommends the [Cache API](https://developer.chrome.com/docs/ai/cache-models) for model files | Chrome |
| WebGPU decode, desktop | up to 76 tok/s on a MacBook Pro | Google AI Edge |
| Native GPU decode, Android | ~52 tok/s (OpenCL, flagship) | LiteRT-LM benchmarks |
| Native CPU decode, Android | 2–5 tok/s — the floor if WebGPU is unavailable | community |
| Sample book | 309k tokens ⇒ 154 chunks at 2k tokens | measured here |

**No published browser-on-Android throughput number for these models exists that I could
find.** Extrapolating between the desktop-WebGPU and native-Android figures, and assuming
~200 tokens of notes per chunk:

| Device class (assumed prefill / decode) | Prefill 309k | Notes 31k | Total |
| --- | --- | --- | --- |
| Desktop Chrome (900 / 76) | 6 min | 7 min | ~13 min |
| Flagship Android (300 / 20) | 17 min | 26 min | ~45 min |
| Mid-range Android (100 / 8) | 52 min | 65 min | ~2 h |

Before thermal throttling, which on a phone under sustained GPU load is not a rounding error.
**Measuring one real chunk on one real phone is the first task of any spike**, because every
design decision below follows from which column is true.

The design consequence is firm regardless: **a full-book crawl cannot be something the reader
waits for.** It has to run ahead of the reading position, a few chapters at a time, and
survive being killed mid-book. Which also means the useful unit of work is a chunk, and the
index has to be queryable while half-built.

### Availability is not guaranteed

- WebGPU on Android needs Android 12+ and a Qualcomm or ARM GPU; coverage is [narrower than
  desktop](https://developer.chrome.com/blog/new-in-webgpu-121).
- Gemma 4 `-web` builds are GPU-compiled, so no WebGPU means no local model at all. There is no
  CPU fallback worth having anyway at 2–5 tok/s.
- Android's Advanced Protection mode [can switch WebGPU off in
  Chrome](https://www.androidauthority.com/android-advanced-protection-mode-disable-chrome-webgpu-apk-teardown-3647502/).
  A reader can therefore lose the local model to an OS security setting.
- Mobile GPUs expose `maxStorageBufferBindingSize` as low as 128 MB, which is why `-web`
  builds exist at all.

So the local agent is strictly an enhancement on capable hardware. Every feature it powers
must degrade to today's behaviour, the way a failed digest already does.

## Division of labour

The local model does the reading. The remote model does the talking. The reader never sees a
token the local model generated.

```
                    ┌─────────────────── on device, free, offline ────────────────────┐
EPUB in IndexedDB ─▶│ headless spine crawl ─▶ chunks + CFIs ─▶ Gemma 4 E2B ─▶ notes   │
                    │                            (WebGPU, in a Worker)          │     │
                    └────────────────────────────────────────────────────────────│─────┘
                                                                                 ▼
      highlight ─▶ retrieval (position-filtered) ─▶ system prompt ─▶ /api/chat ─▶ Gemma 4 26B
```

Three jobs, in order of value per unit of work:

1. **Index the book.** Per chunk: a 2–3 sentence summary, named entities with the position
   they appear at, and the questions the chunk raises. Stored with a CFI range, so every note
   is addressable and comparable against the reading position.
2. **Retrieve at chat time.** Select the notes worth spending prompt budget on: the ones near
   the reader, the ones matching entities named in the highlighted passage, the chapter
   summaries before this point.
3. **Answer lookups on demand.** "Where was Bulkington introduced?" is a tool call over the
   index, not a question for either model. This is where `AutoToolChat` earns its place.

Job 2 is worth building **first and separately**, because a chunk index with plain lexical
retrieval improves the prompt with zero ML on the device, and it is the prerequisite for
everything else regardless of which local runtime wins.

## Architecture changes

### 1. Headless spine extraction — new

The missing primitive. epub.js can do it without a rendition:

```ts
// src/lib/bookIndex/extract.ts
const request = book.load.bind(book)          // what locations.js passes to section.load
// Sequentially: spine.each is Array.forEach, so an async callback there would load
// every section at once and hold the whole book in memory.
for (const section of book.spine.spineItems) {
  await section.load(request)                 // resolves to documentElement; the .d.ts claims a Document
  const doc = section.document
  // accumulate block elements to a ~2,000-token budget, then:
  const range = doc.createRange()
  range.setStartBefore(firstBlock)
  range.setEndAfter(lastBlock)
  const cfi = section.cfiFromRange(range)     // addressable without ever rendering
  section.unload()                            // or a 135-chapter book stays resident
}
```

Requirements this has that the reader does not:

- **Chunk on block boundaries with a token budget**, carrying the chapter label from
  `buildAnchors` (`src/lib/chapters.ts`) and the progress fraction from `book.locations`, which
  the reader already generates and caches in `books.locations`.
- **Run off the main thread.** The parse is cheap next to inference but a 160 KB XHTML
  document per section is not free, and the reader is mid-page-turn.
- **Never touch the rendition.** Loading a section the reader is on would fight `useReader`
  for `section.contents`; extraction gets its own `ePub(buffer)` instance inside the worker.

### 2. Schema — new tables, Dexie v2

```ts
this.version(2).stores({
  bookChunks: 'id, bookId, [bookId+index], [bookId+progress]',
  chunkNotes: 'chunkId, bookId, [bookId+progress]',
  bookEntities: 'id, bookId, [bookId+name], [bookId+firstProgress]',
  bookIndexState: 'bookId',                    // cursor, model id, prompt version, counts
})
```

- `bookChunks` — `cfiStart`/`cfiEnd`, `href`, `chapter`, `progress`, token count. Text is *not*
  stored: it is re-derivable from the EPUB and would roughly double the storage a book costs.
- `chunkNotes` — the local model's output, plus which model and prompt version produced it, so
  a model upgrade can invalidate rather than silently mix vintages.
- `bookEntities` — name, kind, aliases, `firstProgress`, chunk references. This is what makes
  "who is this?" answerable without spoilers.
- `bookIndexState` — the resumable cursor. `deleteBook` in `src/db/db.ts` must cascade to all
  four.

### 3. Local runtime — new, and in a Worker

`src/workers/localModel.ts` owns the `Engine`; `src/lib/local/client.ts` is the typed
`postMessage` bridge. What the wrapper has to handle beyond `Engine.create`:

- **Capability probe** before offering the feature: `navigator.gpu?.requestAdapter()`,
  adapter limits, `navigator.storage.estimate()` against the ~2 GB the model needs.
- **Model acquisition** as an explicit, cancellable, resumable download with visible progress
  — 2 GB on a phone is a decision the reader makes, not a side effect of opening Settings.
  Store via the Cache API (Chrome's recommendation for model files; IndexedDB serialises and
  OPFS is slower to hand back), then pass the cached `Response.blob()` to `Engine.create`.
  Call `navigator.storage.persist()` so eviction does not silently cost the reader 2 GB of
  data twice.
- **Lifecycle**. One engine, created on demand, `delete()`d on idle, on `visibilitychange`, and
  on a failed allocation. A phone will reclaim a WebGPU device; recreating the engine has to
  be routine rather than an error path.
- **Where the model comes from.** Serving 2 GB per install from Netlify is not viable — the
  free tier's whole monthly bandwidth is ~50 installs. Fetch from the Hugging Face URL (CORS
  allowed, CDN-backed) or an object store we control, and pin an expected size and revision.

### 4. Crawl scheduler — new

The part most likely to be got wrong. It is a background job on a battery-powered device that
the reader is actively using.

- **Position-led, not front-to-back.** Index the reader's current chapter and the next two,
  then idle. A reader who abandons a book at 10% never pays for the other 90%.
- **Yield to the reader.** Cancel the in-flight generation on `relocated`, on selection, on
  chat open. `sendMessageStreaming` makes this a `break`.
- **Policy gates.** Foreground and visible, charging or above a battery threshold
  (`navigator.getBattery()`), and not on a metered connection for the download
  (`navigator.connection.saveData`). A PWA cannot run this with the screen off at all — which
  is the strongest argument for the eventual native shell.
- **Chunk-at-a-time commits**, so a killed tab loses one chunk of work.
- **Visible and stoppable.** A line in the reader's Memory tab: *indexed 41 of 154 chunks,
  paused (battery)*, with a stop control and a delete-index control.

### 5. Retrieval and prompt assembly — changed

`src/lib/prompt.ts` gains one section, and the selection logic lives in
`src/lib/bookIndex/retrieve.ts`:

```
## Notes from earlier in the book (compiled on your device)
<fence>
[12% · Ch. 3 Etc.] …
</fence>
```

- **Selection**: chapter summaries up to the reader's position, notes for entities named in
  the seed passage, notes for the surrounding chunks. Lexical scoring (BM25 over note text) is
  enough to start; local embeddings are a later question and the JS API does not offer them.
- **Budget it explicitly.** Something like 6,000 characters of notes, chosen to leave the relay's
  120,000-character cap far away.
- **The spoiler guard stops being a request and becomes a filter.** Today
  `buildSystemPrompt` *asks* the model not to spoil. With `progress` on every note, notes past
  the reader's position are simply not sent. That is the single clearest win in this document
  and it does not require the local model to be good at anything.
- **The fence is non-negotiable.** Notes are book-derived text and go inside `fenced()` with
  the per-request `fenceToken()`, exactly like the passage and the digest.

Untouched: `shared/relay.ts`, `src/lib/inference.ts`, streaming, and the digest in
`src/lib/memory.ts`. The remote path does not learn that a local model exists — it just
receives a richer system prompt.

### 6. Settings and UI — changed

`Settings` gains `localAssist`, `localModelId`, `crawlPolicy`. `SettingsPage` gains a section
that states the download size before anything is fetched, shows storage used, and offers
delete-model and delete-all-indexes. `MemoryPanel` is the natural home for per-book index
state, since it is already the screen that shows the reader what the model has been told.

### 7. Deployment — changed

- **CSP** (`netlify.toml`) needs `'wasm-unsafe-eval'` in `script-src` to compile the runtime,
  `worker-src 'self' blob:`, and `connect-src` extended to the model host. That last one is a
  real widening of the rule that currently says "this origin and OpenAI only", and it should be
  pinned to one host.
- **Cross-origin isolation only if we take the threaded WASM build.** COOP/COEP would then be
  required, which affects how the model is fetched cross-origin. The single-threaded build
  avoids the whole question; start there.
- **Service worker** (`vite.config.ts`): keep the WASM out of `globPatterns` (the 5 MB cap
  already excludes the `.wasm` but not the ~300 KB loaders), and keep the model fetch out of
  the SW's hands entirely.
- **Bundle**: `@litert-lm/core` must be dynamically imported, like epub.js already is, or every
  first paint pays for a runtime most visitors will never use.

## Tool calling: where it actually helps

The issue notes Gemma's basic tool calling, and `AutoToolChat` makes it usable. But bulk
crawling should *not* be agentic: 154 chunks of "summarise this" is a pipeline, and letting a
2B model decide what to read next is slower, less predictable, and harder to resume.

Tools earn their place on the interactive path, where the question is a lookup:

| Tool | Reads |
| --- | --- |
| `search_book(query)` | chunk notes and entities, lexically |
| `read_chunk(chunkId)` | one chunk's text, from the EPUB |
| `chapter_outline()` | chapter list with positions |
| `where_am_i()` | current chapter, progress, CFI |

All read-only, all local, all bounded. With `enableConstrainedDecoding` and a
`recurringToolCallLimit`, "when was the Pequod first described?" resolves on-device in a couple
of turns, and its *answer* — not its reasoning — goes into the remote prompt as one more fenced
note.

## Security

The existing threat model is written down in the README and holds up; a local model extends it
rather than changing it.

- **Local output is untrusted.** The local model has read the book, so its notes inherit the
  book's untrustworthiness. They go inside the fence. Nothing derived from a book ever reaches
  the remote model as instruction.
- **The local model is itself a target.** A book can contain text aimed at whatever summarises
  it. Mitigations: constrain the output schema, cap note length hard, keep the crawl prompt
  free of anything worth hijacking, and strip any `BOOKDATA_[A-Z0-9]{16}`-shaped string from
  notes before storage — the per-request token cannot be pre-authored, but defence in depth is
  cheap here.
- **Tools stay read-only.** No network, no writes outside the notes tables, no access to
  `settings` (which may hold the reader's OpenAI key) and no access to `messages`. A tool
  registry, not a dynamic dispatch.
- **The model file is 2 GB of binary handed straight to a runtime.** Pin the host, the revision
  and the expected size; treat a mismatch as a failure rather than loading it anyway.
- **No new data leaves the device** — but more book text leaves it in distilled form, which is
  worth saying plainly in the README when this ships. Readers who want nothing to leave should
  get the local-only path eventually, and today's local-only path is silence.

## What it buys, what it costs

Buys: whole-book awareness instead of a 2,400-character window; a spoiler guard that is a
filter rather than a polite request; entity lookups that work on books no model has memorised;
smaller and cheaper remote requests; something useful to do while offline.

Costs: a 2 GB download; 45 minutes to 2 hours of GPU time per book; battery and heat; two new
subsystems (extraction/index and a scheduled local runtime) roughly doubling the app's moving
parts; a feature that only exists on capable Android hardware and can be revoked by an OS
setting; a dependency on an early-preview API.

## Recommended path

Staged so each step ships something and the risky step is last.

**M7a — Book index, no ML.** Headless extraction, chunking with CFIs, `bookChunks` +
`bookIndexState`, lexical retrieval, prompt section, position filtering for the spoiler guard.
Runs everywhere, needs no model, and delivers the spoiler-guard win on its own. Note that
without a local model there is nothing to summarise with, so what it retrieves is an outline
plus verbatim excerpts. *Done when: a chat about chapter 40 carries the chapter outline up to
that point and excerpts from the chunks around the passage, and nothing from chapter 41.*

**M7b — Local runtime spike, behind a flag.** `@litert-lm/core` in a worker, capability probe,
model download and Cache API storage, one chunk summarised end to end on a real Android phone,
with prefill and decode measured. *Done when: the throughput table above is replaced with
numbers.* If they land in the mid-range column, stop and reconsider — the honest outcome of
this milestone may be "wrap it natively instead".

**M7c — The crawl.** Scheduler, policy gates, resumable cursor, `chunkNotes` and
`bookEntities`, UI in the Memory tab, notes joining the retrieval pool.

**M7d — Tool-driven lookups.** `AutoToolChat` with the four read-only tools, for lookups the
index can answer better than either model can guess.

## Open questions for the repo owner

1. **Does the PWA line hold?** The strongest local-agent story on Android is the native ML Kit
   Prompt API against a Gemini Nano that is *already on the device* — no 2 GB download at all.
   Taking it means a Capacitor or TWA shell. The original plan deferred that; is it still
   deferred?
2. **Who pays for 2 GB?** Hugging Face directly, or an object store we control (and pay egress
   on)?
3. **Whole book or just ahead of the reader?** This review assumes crawl-ahead. Whole-book-on-import
   is simpler to reason about and much worse to experience.
4. **Is E2B good enough at the actual task?** Chunk summarisation and entity extraction are
   what small models do well, which is encouraging, but "good enough that the 26B's answers
   improve" is an empirical question. M7b should evaluate a handful of chunks by hand before
   M7c builds a scheduler around it.
5. **Does the QAT text-only E2B get a `-web` build?** ~1 GB instead of ~2 GB would change the
   download question materially.

## Sources

- [`@litert-lm/core` on npm](https://www.npmjs.com/package/@litert-lm/core) — API and WASM
  sizes verified by inspecting version 0.14.0 directly
- [LiteRT-LM Web API](https://developers.google.com/edge/litert-lm/js) ·
  [LiteRT-LM overview](https://developers.google.com/edge/litert-lm/overview)
- [`litert-community/gemma-4-E2B-it-litert-lm`](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
- [Gemma 4 with quantization-aware training](https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/)
- [Blazing fast on-device GenAI with LiteRT-LM](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
- [The Prompt API](https://developer.chrome.com/docs/ai/prompt-api) — platform support ·
  [ML Kit GenAI Prompt API](https://developers.google.com/ml-kit/genai/prompt/android)
- [Cache models in the browser](https://developer.chrome.com/docs/ai/cache-models) ·
  [Understanding storage quota](https://developer.chrome.com/docs/workbox/understanding-storage-quota)
- [What's new in WebGPU (Chrome 121)](https://developer.chrome.com/blog/new-in-webgpu-121) ·
  [Advanced Protection and WebGPU](https://www.androidauthority.com/android-advanced-protection-mode-disable-chrome-webgpu-apk-teardown-3647502/)
