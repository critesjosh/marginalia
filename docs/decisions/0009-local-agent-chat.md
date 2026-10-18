# Let the dev server answer chat with a local agent CLI

Date: 2026-10-18
Status: Proposed

## Context

Chat goes to `/api/chat`, which sends a pinned OpenRouter model a fenced
system prompt and the thread (decision 0002). Some readers already run Claude
Code or Codex CLI with MCP servers attached (search, notes, documentation)
and want highlight threads answered by that agent, with those tools and their
own subscription.

A browser page cannot start processes, so something on the reader's machine
has to run the CLI. Book text is untrusted. Today an injected instruction can
at worst spoil an answer. With tools attached, it could ask an agent to read
files or send data through an MCP server.

## Decision

The Vite dev server can back `/api/chat` with a local agent CLI. Setting
`CHAT_AGENT=claude` or `CHAT_AGENT=codex` in `.env.local` swaps the OpenRouter
relay (and any `CHAT_RELAY_URL` proxy) for `dev/agentChat.ts`, a Node-only
handler that runs the CLI headless once per request and translates its JSON
events into the OpenAI-style SSE the PWA already reads. The client, the
Worker, the HTTP contract and the KOReader plugin do not change, and
production keeps OpenRouter.

- Rami's system message becomes the agent's system prompt (Claude
  `--system-prompt-file`, Codex `developer_instructions`). Earlier turns are
  replayed as a JSON array, so each request stays stateless, as it is with
  OpenRouter, and no message can forge a turn boundary.
- MCP access is opt-in through `CHAT_AGENT_MCP`: unset allows none, a
  comma-separated list allows those servers, and `*` allows every configured
  server. Background summaries (non-streaming requests) never get tools.
- Claude runs with `--tools ""`, so only MCP tools exist. A named list uses
  `--permission-mode dontAsk` with `--allowedTools`, which denies other tools
  rather than prompting; `*` uses `bypassPermissions`, since Claude has no
  wildcard for MCP tools. No servers means `--strict-mcp-config`. Allow rules
  in the reader's own settings would still pass a pre-approved server, so a
  PreToolUse hook passed with `--settings` refuses every tool outside the
  allowlist before it runs. The reader's own Claude hooks still run, since
  they are the reader's code.
- Codex runs in the read-only sandbox with `approval_policy="never"` and
  `approvals_reviewer="user"`. Without that, a configured automatic reviewer
  approved `apply_patch` writes outside the sandbox in testing. Shell,
  plugins (which bring their own MCP servers), hooks, memories, browser and
  desktop control, sub-agents, image tools and web search are disabled, and
  each configured server outside the allowlist is set to `enabled=false`.
  An unknown feature or server name stops the run instead of being skipped.
- The handler fails closed. It ends a run when Claude reports a built-in tool
  at startup, when either agent starts a call to a server outside the
  allowlist, or when Codex reports a command or file change. A reply counts as
  complete only after the CLI's own success event.
- The CLI runs in an empty temporary directory, so it loads no project
  instructions or project MCP config. It gets the dev server's environment
  without Rami's own secrets. Its stderr is discarded, and errors returned to
  the PWA are fixed messages, since CLI diagnostics can carry config values.
- The handler serves only loopback peers with a loopback `Host`, rejects
  cross-origin or cross-site browser requests and non-JSON bodies, allows two
  runs at a time, and stops the CLI's whole process group (stdio MCP servers
  included) when the reader closes the reply or a turn overruns its limit.

## Alternatives and tradeoffs

- A standalone bridge the hosted PWA calls on `127.0.0.1`: works from the
  deployed site, but needs a CSP change, a client endpoint setting, pairing
  tokens, and browser private-network handling. That can follow if the dev
  version proves useful.
- Claude Agent SDK or `codex app-server` as long-lived processes: these avoid
  starting the CLI and its MCP servers on every turn. They add a dependency and
  session state; the CLIs are already installed and authenticated, so they
  are the smaller first step.
- Resuming CLI sessions per conversation: replies would draw on the agent's
  own memory of tool results, but Rami would have to map conversations to
  sessions and keep both histories consistent. Replaying the thread matches
  how the relay works today.
- Allowing all MCP tools by default: matches the request, but an EPUB could
  then steer tools such as mail or file servers without the reader choosing
  them. Opt-in keeps that a deliberate choice. Fencing book text is a model
  instruction, not a security boundary, so an allowed server should be one the
  reader would let any book use.
- Isolation depends on CLI flags that change between releases. It was checked
  against Claude Code 2.1.302 and codex-cli 0.162.1; the fail-closed checks
  cover a renamed feature or a stray tool, not every possible change.
- Cost and latency: answers bill the reader's own Claude or OpenAI plan, not
  the site's credit. Each turn pays for CLI and MCP startup (seconds), Codex
  sends each message whole rather than token by token, and tool calls are not
  shown in the thread.
