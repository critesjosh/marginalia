# Changelog

## Unreleased

- Dev-only option to answer chat with a local Claude Code or Codex CLI and the
  MCP servers the reader allows (`CHAT_AGENT`, decision 0009).
- Pair the hosted app with a local agent bridge (`npm run agent-bridge`) from
  Settings, Local agent, to answer chat with your own Claude Code or Codex on a
  desktop browser (decision 0010).
- Keep a Markdown copy of every thread in a folder on your computer by starting
  the bridge with `--save-dir` (decision 0011).
- One-time hints for new readers, each where its feature first applies: a
  three-step library card, the reader's tap zones on a first book, notes on a
  first thread and a first memory, and a later note on the book menu. A
  "How Rami works" guide at `/help` keeps all of it, linked from Settings.
- Privacy-first product telemetry to PostHog Cloud through a same-origin relay,
  off until configured, with a usage-data setting and Report a problem
  (decision 0008).
- Removed audiobook playback, the audiobook Worker, and the narrator tool.
- Reproducible validation, strict typing, coverage gates and isolated audiobook QA.
- Privacy-safe optional diagnostics and usage counters, off until configured.
- Dependency security fixes and Lua test-runtime migration.
- Quality/security CI, setup helpers, contracts, and operator runbooks.
