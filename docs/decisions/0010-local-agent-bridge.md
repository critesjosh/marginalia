# Let the hosted app reach a local agent through a paired bridge

Date: 2026-10-18
Status: Proposed

## Context

This extends decision 0009, which stays as the dev-server route. Decision 0009
lets `npm run dev` answer chat with the reader's own Claude Code or Codex CLI
and the MCP servers they allow. Most readers use the deployed
app, not a checkout. The CLI has to stay on the reader's computer, because
that is where their sign-in, MCP configuration and local tools are; the Worker
cannot start processes, and holding readers' agent credentials on the server
would contradict the no-accounts goal.

A page on `https://rami.agenticpossible.com` can call `http://127.0.0.1`, but
only if the CSP allows it, the local server answers CORS, and the browser lets
a public site reach the device. Any other site could make the same request,
so the local server needs its own proof that a request comes from the
reader's Rami.

## Decision

A local bridge, `npm run agent-bridge` (`dev/agentBridge.ts`), serves the
0009 agent handler at `http://127.0.0.1:47615` to the hosted app.

- **Pairing.** The bridge keeps a random 256-bit token in
  `$XDG_CONFIG_HOME/rami/agent-bridge.json` (mode 0600) and prints it only
  when it creates one, or with `--show-token`. The reader pastes it once
  into Settings, Local agent. Every request needs `Authorization: Bearer
  <token>`, compared as digests in constant time. The file is refused if it is
  a symlink or another user's, tightened if its mode is too open, and replaced
  atomically. `--new-token` rotates it only once that bridge owns its port,
  and every running bridge follows the file, so rotation revokes the old
  token everywhere; disconnecting in Settings forgets only the browser's copy.
- **Origins.** Every request from a browser `Origin` outside the allowlist is
  refused outright, not just left without CORS headers. By default the
  allowlist is the production hosts and the app's Workers Builds previews
  (`<branch or version>-marginalia.cloudflare-cdd.workers.dev`), plus any
  `--origin` the reader adds (for a dev server); `--no-previews` drops the
  previews. The preview hostname also matches any Worker in the same
  Cloudflare account named `*-marginalia`, so this trusts the account: anyone
  who can deploy there can already ship production. `Origin: null` is refused. A request
  without `Origin` is a non-browser client and still needs the token. The raw
  `Host` must be `127.0.0.1` or `localhost` on the bridge's port and the peer
  must be loopback, checked before anything else, which stops DNS rebinding.
  Preflights carry no token, so they check the peer, Host, origin, method and
  headers instead.
- **Endpoints.** `GET /v1/status` returns the agent name and the MCP allowlist
  for the Settings check. `POST /v1/chat` takes the `/api/chat` body and
  returns the same SSE or JSON. Both are documented in `docs/agent-bridge.md`.
- **Client.** While a token is saved, `src/lib/inference.ts` sends chat and
  background summaries to the bridge instead of `/api/chat`, so Rami's relay
  does not receive them; the agent's provider and the MCP servers the reader
  allows do. When the bridge is unreachable the reader gets an error naming
  it, never a fallback to the relay, and storage that cannot be read counts as
  unknown rather than unpaired, so chat stops instead of going to the relay.
  Bridge calls omit credentials, refuse redirects and skip the HTTP cache. The
  token lives in `localStorage`, so it is not in IndexedDB, the JSON export, a
  published thread, diagnostics or telemetry. There is no Dexie change.
  Disconnecting sends later requests, including earlier messages in a thread
  the agent answered, through the relay again.
- **CSP.** `connect-src` gains exactly `http://127.0.0.1:47615`: one loopback
  port, fixed, rather than a wildcard. This is a deliberate, narrow exception
  to the rule against widening the CSP, as storing the pairing token in the
  browser is to keeping secrets server-side: the token only unlocks the
  reader's own machine. `--port` exists for development; the hosted app can
  reach only 47615.
- The bridge reuses 0009's isolation (no built-in tools, MCP allowlist and
  guard hook, empty temporary directory, process-group kill).

Desktop only. A phone cannot reach the computer's loopback address, so the
Settings section says so, and the KOReader plugin keeps using the relay.

**Threat model.** The bridge stops other websites, other machines and
rebinding attacks from running the reader's agent. It does not defend against
software already running as the reader: a browser extension that can read
Rami's pages or storage, or a local process that reads the token file or
listens on port 47615 while the bridge is stopped and so receives the
browser's token and passages. Those already have the reader's access. Allowed
MCP servers can act on what they receive, so 0009's advice to allow only
servers the reader would let any book use applies unchanged.

## Alternatives and tradeoffs

- No pairing, origin check only: simpler, but anything that can send a
  request without `Origin`, such as a script another site gets the reader to
  run, would reach the agent. The token costs one paste.
- A pairing link (`/settings#agent-token=…`) instead of pasting: one click,
  but the token would sit in browser history. Pasting can come first; a link
  can follow.
- `http://127.0.0.1:*` in the CSP so the port can change: more flexible, but
  it opens every local port to any script that runs in the app. One fixed
  port keeps the change narrow.
- Publishing the bridge to npm (`npx rami-agent-bridge`): no checkout needed,
  but a release and supply-chain commitment. A script in this repository
  comes first.
- Falling back to OpenRouter when the bridge is down: chat keeps working, but
  the reader's passages would go somewhere they had chosen not to send them.
- Browsers: Chrome and Firefox let an HTTPS page reach `http://127.0.0.1`,
  and may ask the reader first (Chrome's local network access, Firefox's
  device permission); a reader who declines gets the bridge error. WebKit
  blocks it as mixed content, so Safari is unsupported unless the bridge
  serves HTTPS with a certificate the reader installs, which is a larger
  change. `docs/agent-bridge.md` records what was tested.
