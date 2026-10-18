# Local agent bridge

The bridge lets the hosted Rami app answer chat with your own Claude Code or
Codex CLI, and the MCP servers you allow it, instead of Rami's relay
([decision 0010](decisions/0010-local-agent-bridge.md)). It runs on your
computer; nothing about it is hosted.

## Setup

You need Node.js 24, a checkout of this repository, and Claude Code or Codex
installed and signed in.

```bash
npm ci
npm run agent-bridge -- --agent claude --mcp tavily
```

The first run prints a pairing token. In Rami, open Settings, Local agent,
paste it and choose Connect. Settings then shows which agent and servers the
bridge is using. Keep the terminal open while you read.

| Option | Meaning |
| --- | --- |
| `--agent claude\|codex` | The CLI that answers (or `CHAT_AGENT`) |
| `--mcp <names>` | MCP servers it may call, comma-separated, or `*` (or `CHAT_AGENT_MCP`). Empty allows none. |
| `--model <name>` | Model for the agent (or `CHAT_AGENT_MODEL`) |
| `--origin <url>` | Another app origin to accept, such as `http://localhost:5173` for a dev server. Repeatable. |
| `--no-previews` | Refuse the app's preview builds (see below) |
| `--port <n>` | Port to listen on. The hosted app can reach only 47615. |
| `--show-token` | Print the pairing token again |
| `--new-token` | Replace the token, unpairing every browser |

The token is kept in `$XDG_CONFIG_HOME/rami/agent-bridge.json` (by default
`~/.config/rami/`), readable only by you. Disconnecting in Settings forgets the
browser's copy; `--new-token` is what stops an old copy from working. A
running bridge picks up a rotated token, and refuses everything if the file
disappears. A bridge started with `--new-token` while another holds its port
exits without changing the token.

## Browsers

| Browser | Works | Notes |
| --- | --- | --- |
| Chrome, Edge | Yes | May ask to let Rami reach other apps and services on this device. Allow it; if you declined, change it in the site settings. |
| Firefox | Yes | May ask for local network or device access in the same way. |
| Safari | No | WebKit blocks an HTTPS page from reaching `http://127.0.0.1`. |
| Phones | No | A phone cannot reach your computer's `127.0.0.1`. |

Tested with Playwright's Chromium, Firefox and WebKit builds against an
HTTPS page with the production CSP; shipping browsers' permission prompts
were not exercised.

## What goes where

While paired, Rami sends each chat and its background book notes to the
bridge, and the bridge passes them to your CLI. Rami's relay does not receive
them. Your agent's provider (Anthropic or OpenAI) and the MCP servers you
allow do, under their terms and your accounts. If the bridge is down, chat
shows an error rather than falling back to the relay. Disconnecting sends
later chats through the relay again, including the earlier messages of a
thread the agent answered.

Book text is untrusted. The bridge runs the CLI in an empty temporary
directory with its built-in tools off, and only the servers you list can be
called (decision 0009). An allowed server can still act on what it receives,
so allow only servers you would let any book use: search and documentation,
not mail or files.

## Security

The bridge answers only:

- connections from this machine, whose `Host` is `127.0.0.1` or `localhost` on
  the bridge's port, which stops DNS rebinding;
- requests carrying `Authorization: Bearer <token>`;
- browser requests whose `Origin` is the hosted app (`rami.agenticpossible.com`
  or `marginalia.adjacentpossible.dev`), one of its Workers Builds previews
  (`https://<branch or version>-marginalia.cloudflare-cdd.workers.dev`), or one
  you added with `--origin`. Others are refused before anything runs.

Previews are built from branches of this repository. The hostname cannot
distinguish them from another Worker in the same Cloudflare account whose name
ends in `-marginalia`, so in effect the bridge trusts that account: anyone who
can deploy there or push a branch here can already ship the production app.
`--no-previews` turns them off. A preview
has its own storage, so pair it separately in its own Settings.

It cannot protect you from software already running as you, such as a browser
extension that reads Rami's pages, or a program that reads the token file or
takes port 47615 while the bridge is stopped.

## Endpoints

Both require the token. Errors are `{ "error": { "message": string } }`.

`GET /v1/status` returns `{ "agent": "claude" | "codex", "mcp": string[] | "all" }`.

`POST /v1/chat` takes the same body as the relay's `/api/chat`
(`docs/api.openapi.yml`): `{ "messages": [{ "role", "content" }], "stream"?: boolean }`,
ending with a user message. With `stream: true` it answers
`text/event-stream` frames `data: {"choices":[{"delta":{"content":…}}]}`,
ending with `data: [DONE]`; a failure after the first frame arrives in-band as
`data: {"error":{"message":…}}`. Without it, it answers
`{ "choices": [{ "message": { "role": "assistant", "content": string } }] }`.

| Status | Meaning |
| --- | --- |
| 400 | Malformed conversation |
| 401 | Missing or wrong token |
| 403 | Not from this machine, a foreign `Host`, or an origin that is not paired |
| 413 | Body or book context too large |
| 415 | Body is not JSON |
| 429 | Two replies are already running |
| 502 | The agent failed, timed out or was not installed |
| 503 | The MCP allowlist names a server the agent lacks |
