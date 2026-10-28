# Allow named tools of an MCP server, not only whole servers

Date: 2026-10-27
Status: Proposed

## Context

Decision 0009 allows MCP servers by name: Rami's chat can call every tool a
listed server exposes. Some servers mix read and write tools. A notes server
such as Miyo offers search and file reading alongside file creation and
editing, so a reader who wants the agent to look things up in their notes
must also let any book's text steer it toward writing them. Some servers can
limit access per client app, but the bridge's Claude runs appear as the same
client as the reader's own Claude Code sessions, so restricting it there
restricts those too.

## Decision

`CHAT_AGENT_MCP_TOOLS` (bridge `--mcp-tools`) takes `server:tool` entries,
such as `miyo:search,miyo:read_file`. A server named there is allowed with
only those tools. The tool is whatever follows the last colon, since Claude
server names can contain colons (`plugin:x:y`) and MCP tool names cannot.
Tool names must match `[A-Za-z0-9_-]{1,64}`. A server cannot be listed in
both variables, and the list cannot narrow the `*` wildcard, so every entry
has one meaning.

- Claude: `--allowedTools` names the exact tools (`mcp__miyo__search`)
  instead of the server, so `dontAsk` refuses the rest, and the guard hook's
  `allowed.json` becomes `{ prefixes, names }`, with names matched exactly.
  Claude cannot hide some of a server's tools, so the others stay visible to
  the model. The system prompt lists the tools it may use. If it still calls
  another, `dontAsk` and the guard hook refuse it before it runs and the
  refusal goes back to the model, so the reply carries on. A tool of a server
  that is not allowed at all still ends the run, as before.
- Claude joins server and tool names with `__` and replaces characters
  outside `[A-Za-z0-9_-]`, so servers `a` and `a__b`, or `a.b` and `a_b`, can
  produce the same tool name. Before the model runs, the translator checks
  the servers listed in Claude's start-up event, listed in Rami or not, and
  ends the run if an allowed server's prefix overlaps another's either way.
  This also closes the same gap for whole-server allowlists from decision 0009. A start-up event without the server list ends the run too.
- Codex: the server gets `enabled_tools=[...]`, which hides the rest from the
  model. The translator still ends the run if Codex reports a call to another
  tool of that server.
- `/v1/status` adds `mcpTools` when set, and Settings shows the narrowed
  server with its tools. The configuration diagnostic records the tool names.

## Alternatives and tradeoffs

- Per-client limits in the MCP server (Miyo's read-only folder sharing):
  needs nothing from Rami, but applies to every session of the same client,
  and not every server has it.
- Ending the Claude run on any refused tool, as for other servers: keeps a
  third layer that stops the CLI before the call. Because the model can see
  the narrowed server's other tools, it would sometimes try one and lose the
  whole reply. Refusing the call and letting the model continue relies on
  two layers (the permission mode, and the guard hook, which blocks if it
  fails) for those tools.
- Hiding the other tools from Claude with `--disallowedTools`: needs their
  names before the run. They appear only in the CLI's start-up event, so
  this would need a discovery run or a cache that can go stale.
- A proxy MCP server that filters the tool list: hides tools from both CLIs
  but adds a process between the agent and every server, and its own
  configuration.
- Narrowing reads does not stop exfiltration. An agent that can read notes
  and also search the web can still be steered into sending note text in a
  query. The allowlist limits what the agent can change, not what it can
  disclose.
