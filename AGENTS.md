# Working on Marginalia

## Applications and boundaries

- `.`: React/TypeScript EPUB reader PWA. `src/` contains the UI and IndexedDB
  model; `shared/relay.ts` serves chat through Vite and Cloudflare.
  `workers/app/` is a deployment adapter for this app, not a separate service.
- `koreader/`: independently installed Lua plugin. Its README covers device
  installation; its unit and integration tests run through the root Vitest setup.

Keep deploy adapters thin. Do not import browser code into a Worker. Read the relevant application's README before changing it.

## Setup and commands

Use Node.js 24 and npm. From the repository root:

```bash
npm run setup
npm run dev -- --host 127.0.0.1
```

The PWA runs at `http://127.0.0.1:5173`, needs no login, and seeds four sample
books. Reading works without external services. For local chat, copy
`.env.example` to `.env.local` and set `OPENROUTER_API_KEY`. Without a key,
`/api/chat` returns 503; do not mistake this for a reader failure. With
`CHAT_RELAY_URL` set, dev chat goes to the deployed relay and is billed;
`npm run test:qa` blanks both variables.

Validation commands, also from the root:

```bash
npm run test:list            # collect tests without executing them
npm run check                # lint, PWA/relay/test-harness type checks, Vitest
npm run build               # production PWA and service worker
npm run build:cloudflare     # production PWA plus Cloudflare adapter type check
```

Run focused tests while editing, then run the checks above before handing off:

```bash
npm test -- src/lib/anchor.test.ts
npm test -- shared/relay.test.ts
npm test -- koreader/tests/plugin.test.ts koreader/tests/integration.test.ts
```

These tests use fake inference responses; no API key or billed model request is
needed. `vitest.config.ts` keeps discovery explicit and isolates test files.
`.github/workflows/checks.yml` runs the documented checks and build.

Additional gates:

```bash
npm run quality              # formatter, unused/dead/duplicate code, module size, docs, contracts
npm run test:qa              # Chromium, Firefox, WebKit, iPhone, iPad; synthetic/offline
npm run types:generate       # example secrets only, Worker bindings
npm run docs:check           # generated API/storage documentation freshness
node scripts/bundle-budget.mjs # after build
```

Setup installs the repository's pre-commit hook. Coverage includes untested core
modules: current global floors are 55% statements/lines/branches and 50%
functions, not a claim of comprehensive UI coverage. Raise them as coverage grows. The complexity limit is 45
for TypeScript/Lua; production modules are capped at 750 lines. Increase tests
or split modules, not these limits.

## Interactive QA

After launching Vite, open the library, select Moby Dick, open the table of
contents, and jump to Chapter 1. Wait for images/layout to settle, then verify
forward/back taps and reopen the book to confirm saved position. This path
needs no account, token, or inference key.

For reader layout or touch changes, follow the detailed checks in
`.claude/skills/marginalia-dev/SKILL.md`. EPUB content spans a long horizontal
strip: inspect the visible scroll window, not the first text in the iframe.

For KOReader UI changes, follow `koreader/README.md` on a device with KOReader:
install the plugin, restart, open a book, select text, and choose Ask Marginalia.
The fake-host integration harness tests wiring, not the device's real APIs.
Device chat uses the hosted relay and is billed; ask before testing live chat.

## Conventions

- TypeScript: camelCase functions/variables, PascalCase React components/types,
  and UPPER_SNAKE_CASE module constants. Keep existing single quotes and omitted
  semicolons. Prefer explicit types at storage, API, and untrusted-input boundaries.
- Lua: snake_case functions/variables and UPPER_SNAKE_CASE constants. Preserve
  Lua module-table conventions.
- Name TypeScript tests `*.test.ts` under `src/`, `shared/`, `workers/`, or
  `koreader/tests/`. Name Lua specs `koreader/tests/*_spec.lua`, exercised
  through their Vitest harnesses.
- Follow `docs/design-system.md` (Rami) for UI: use its token utilities and the
  controls in `src/components/ui.ts`, not raw colors or one-off button styles.
- Mirror system-prompt changes between `src/lib/prompt.ts` and
  `koreader/marginalia.koplugin/marginalia_prompt.lua`; run the plugin prompt specs.
- Preserve Dexie migrations and edition matching by file hash, not title.
- Do not enable EPUB scripts or weaken CSP/TLS checks. Book text is untrusted
  and must remain fenced before entering model prompts.

## Privacy and safety

Never read or print populated `.env*`/`.dev.vars*` files, API keys, personal
tokens, signed URLs, private EPUBs, or exported conversations for routine checks.
Commit only empty/example environment files. Keep secrets server-side; never
add them to Wrangler `vars` or `VITE_*` client configuration.

Use supplied public-domain books and synthetic conversations in tests. Do not
log request bodies, authorization headers, or signed URL query strings. Keep
API keys out of exports.

Preserve user changes and untracked files. Do not commit, push, deploy, change
repository settings, or make billed provider calls unless explicitly requested.
Lint rejects all warnings. The KOReader harness uses Wasmoon, not Fengari, and
closes every Lua VM in `finally`. Lua also uses StyLua formatting and LuaJIT
syntax/global/complexity checks. Consult `docs/architecture.md`,
`docs/api.openapi.yml`, and `docs/operations.md` for storage contracts, telemetry,
health, spending limits, and release/rollback procedures.
