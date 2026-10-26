# rami-agent-bridge

Lets the hosted [Rami](https://rami.agenticpossible.com) reader answer chat
with your own Claude Code or Codex CLI, and the MCP servers you allow it. It
runs on your computer and accepts only paired requests from this machine.

You need Node.js 24.2 or later and Claude Code or Codex installed and signed
in. Run an exact version:

```bash
npx rami-agent-bridge@0.1.0 --agent claude --mcp tavily
```

The first run prints a pairing token. In Rami, open Settings, Local agent,
paste it and choose Connect. Run with `--help` for every option, and see
[the bridge documentation](https://github.com/critesjosh/marginalia/blob/main/docs/agent-bridge.md)
for setup, security and troubleshooting.
