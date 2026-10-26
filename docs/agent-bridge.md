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

To choose a model, check which MCP servers your agent has, then start the
bridge from the repository root:

```bash
claude mcp list
npm run agent-bridge -- --agent claude --model claude-sonnet-5-5 --mcp tavily
```

The names after `--mcp` must match the names in `claude mcp list` (or
`codex mcp list`). This is an allowlist by server, not by individual tool:
Rami's chat can call any tool those servers expose, and some servers offer
file creation and editing tools alongside search. The bridge passes `--model`
to the CLI for each chat. Starting the bridge does not make a model request or
confirm that your account can use that model. If the bridge stops, paired chat
shows an error instead of switching to Rami's hosted relay.

| Option                       | Meaning                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent claude\|codex`      | The CLI that answers (or `CHAT_AGENT`)                                                                                                |
| `--mcp <names>`              | MCP servers it may call, comma-separated, or `*` (or `CHAT_AGENT_MCP`). Empty allows none.                                            |
| `--model <name>`             | Model for the agent (or `CHAT_AGENT_MODEL`)                                                                                           |
| `--reasoning-effort <level>` | Codex effort: `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` (or `CHAT_AGENT_REASONING_EFFORT`). Unset inherits the CLI setting. |
| `--debug-log <path>`         | Opt-in local classified stderr log (or `CHAT_AGENT_DEBUG_LOG`); see diagnostics below.                                                |
| `--origin <url>`             | Another app origin to accept, such as `http://localhost:5173` for a dev server. Repeatable.                                           |
| `--no-previews`              | Refuse the app's preview builds (see below)                                                                                           |
| `--save-dir <path>`          | Keep a Markdown copy of each thread in this folder (see below)                                                                        |
| `--port <n>`                 | Port to listen on. The hosted app can reach only 47615.                                                                               |
| `--show-token`               | Print the pairing token again                                                                                                         |
| `--new-token`                | Replace the token, unpairing every browser                                                                                            |

The token is kept in `$XDG_CONFIG_HOME/rami/agent-bridge.json` (by default
`~/.config/rami/`), readable only by you. Disconnecting in Settings forgets the
browser's copy; `--new-token` is what stops an old copy from working. A
running bridge picks up a rotated token, and refuses everything if the file
disappears. A bridge started with `--new-token` while another holds its port
exits without changing the token.

## Saving threads to your computer

Start the bridge with `--save-dir ~/Notes/Rami` and it keeps a Markdown file
for each thread in that folder ([decision 0011](decisions/0011-mirror-threads-to-disk.md)):

```
~/Notes/Rami/
  moby-dick-or-the-whale--<book id>/
    2026-10-18-call-me-ishmael--<thread id>.md
```

Each file has YAML front matter (book, author, chapter, position, dates), the
passage you highlighted, and every turn under **Reader** and **Rami**
headings. The bridge rewrites a thread's file after each reply. In Settings,
Local agent, "Save all threads now" copies the threads you already have.

It is a one-way copy: Rami never reads these files back, edits you make there
are overwritten by the next reply in that thread, and deleting a thread in
Rami leaves its file. The file name keeps the title the thread had when it was
first saved. Only the bridge's command line sets the folder; the app can see
it but never change it. Passages and replies are written as literal text, so
a viewer shows HTML and image links from a book as text rather than running
or loading them.

## Browsers

| Browser      | Works | Notes                                                                                                                        |
| ------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| Chrome, Edge | Yes   | May ask to let Rami reach other apps and services on this device. Allow it; if you declined, change it in the site settings. |
| Firefox      | Yes   | May ask for local network or device access in the same way.                                                                  |
| Safari       | No    | WebKit blocks an HTTPS page from reaching `http://127.0.0.1`.                                                                |
| Phones       | No    | A phone cannot reach your computer's `127.0.0.1`.                                                                            |

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

## Diagnosing agent errors

The bridge terminal emits local JSON diagnostics with a random `requestId`.
An agent failure shows that same value as `Reference: ...` in the browser.
Find it in the bridge's terminal output to see setup/MCP discovery, CLI start,
model errors, tool calls, process exit code/signal and the final reply outcome.
The existing HTTP metric may say 200 when a stream later fails; the
`agent_diagnostic` record with `stage: "reply"` is the final outcome. A CLI
can be terminated by the bridge after its success event; a process signal
does not override a successful reply.

Configuration records show the model, explicit Codex reasoning effort, MCP
names and CLI version. `inherited` means Rami did not override the CLI setting,
not that it inspected your user configuration. Tool records include the MCP
server/tool names and elapsed time, never arguments, queries or results.
Error events are reduced to fixed categories such as `authentication`,
`rate_limit`, `model_unavailable`, `connection` and `unknown`; raw error text,
book text, prompts, replies, URLs and credentials are never logged.

For stderr diagnostics, start with `--debug-log /path/to/agent-debug.jsonl`.
The parent folder must already exist. Only the last 8 KiB/32 lines per process
are considered, and only their error categories are written, with the request
reference. Unknown prose is discarded rather than guessed safe. The file is
owner-only (0600), symlinks and multiply linked/foreign files are refused, and
logging stops at 1 MiB. A refusal emits a warning without interrupting chat.
Remove or rename the debug file to start a fresh one. Leave the option unset
to discard stderr. These logs stay on your machine and are never telemetry.

## Endpoints

Both require the token. Errors are `{ "error": { "message": string } }`.

`GET /v1/status` returns `{ "agent": "claude" | "codex", "mcp": string[] | "all", "saveDir": string | null }`.

`PUT /v1/threads/:id` saves one thread when the bridge has `--save-dir`, and
answers 204. The body is
`{ "book": { "id", "title", "author" }, "thread": { "id", "title", "chapter"?, "progress"?, "passage"?, "createdAt", "updatedAt" }, "turns": [{ "role": "user" | "assistant", "content", "createdAt" }] }`,
up to 2 MB and 1,000 turns. 409 means a newer copy is already saved; 404 means
the bridge is not saving; 503 means the folder is missing or unsafe.

`POST /v1/chat` takes the same body as the relay's `/api/chat`
(`docs/api.openapi.yml`): `{ "messages": [{ "role", "content" }], "stream"?: boolean }`,
ending with a user message. With `stream: true` it answers
`text/event-stream` frames `data: {"choices":[{"delta":{"content":…}}]}`,
ending with `data: [DONE]`. Between them, `data: {"activity":{"kind":"thinking"}}`
or `data: {"activity":{"kind":"tool","server":…,"tool":…}}` says what the agent
is doing, which the thread shows until more text arrives. A failure after the
first frame arrives in-band as `data: {"error":{"message":…}}`. Without it, it answers
`{ "choices": [{ "message": { "role": "assistant", "content": string } }] }`.

| Status | Meaning                                                                                   |
| ------ | ----------------------------------------------------------------------------------------- |
| 400    | Malformed conversation or thread                                                          |
| 401    | Missing or wrong token                                                                    |
| 403    | Not from this machine, a foreign `Host`, or an origin that is not paired                  |
| 409    | A newer copy of that thread is already saved, or its file is not a plain file             |
| 413    | Body or book context too large                                                            |
| 415    | Body is not JSON                                                                          |
| 429    | Two replies are already running                                                           |
| 502    | The agent failed, timed out or was not installed                                          |
| 503    | The MCP allowlist names a server the agent lacks, or the save folder is missing or unsafe |
