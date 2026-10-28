/**
 * The pure half of the local agent chat backend (decision 0009): reading its
 * settings, turning a Rami conversation into one CLI prompt, building each
 * CLI's arguments, and translating the JSONL events it prints. `agentChat.ts`
 * runs the process. Node-only, used by the Vite dev server and never by the app
 * or a Worker.
 *
 * Book text is untrusted and an agent with tools can act on it, so every
 * built-in tool is switched off and MCP servers are allowed only by name,
 * optionally narrowed to named tools (decision 0013). The translators also
 * fail closed: a built-in tool, a file change, or a call to a server or tool
 * outside the allowlist ends the run.
 */

import type { RelayMessage } from '../shared/relay.ts'

type AgentName = 'claude' | 'codex'

/** Servers the agent may call only some tools of, keyed by server name. */
export type McpTools = Record<string, string[]>

/** A server's tool list, if narrowed. Own keys only: a server may be named `toString`. */
export function narrowedTools(
  mcpTools: McpTools | undefined,
  server: string,
): string[] | undefined {
  return mcpTools && Object.hasOwn(mcpTools, server) ? mcpTools[server] : undefined
}

export interface AgentConfig {
  agent: AgentName
  /** MCP servers the agent may call during chat, or 'all'. Empty allows none. */
  mcp: string[] | 'all'
  /** Servers in `mcp` limited to these tools; any other server allows every tool. */
  mcpTools?: McpTools
  model?: string
  reasoningEffort?: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_SECONDS = 300

/** The tool names MCP clients accept, which are also safe in a flag or TOML array. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Reads `server:tool` entries. Server names can contain colons (Claude's
 * `plugin:x:y`), tool names cannot, so the tool is whatever follows the last.
 */
function readMcpTools(value: string | undefined, mcp: string[] | 'all'): McpTools {
  const tools = new Map<string, string[]>()
  for (const entry of (value ?? '').split(',').map((part) => part.trim())) {
    if (!entry) continue
    const at = entry.lastIndexOf(':')
    const server = entry.slice(0, at).trim()
    const tool = entry.slice(at + 1).trim()
    if (at < 1 || !server || !TOOL_NAME.test(tool)) {
      throw new Error(`CHAT_AGENT_MCP_TOOLS entries are server:tool, not "${entry}".`)
    }
    const list = tools.get(server) ?? []
    if (!list.includes(tool)) tools.set(server, [...list, tool])
  }
  const servers = [...tools.keys()]
  if (servers.length && mcp === 'all') {
    throw new Error('CHAT_AGENT_MCP_TOOLS cannot narrow the * wildcard; name the servers instead.')
  }
  const both = mcp === 'all' ? undefined : servers.find((server) => mcp.includes(server))
  if (both !== undefined) {
    throw new Error(`"${both}" is in both CHAT_AGENT_MCP and CHAT_AGENT_MCP_TOOLS; list it once.`)
  }
  // fromEntries defines own properties, so even `__proto__` stays a plain key.
  return Object.fromEntries(tools)
}

/** Reads `CHAT_AGENT*` from the dev server's env. Null means use OpenRouter. */
export function readAgentConfig(env: Record<string, string | undefined>): AgentConfig | null {
  const agent = env.CHAT_AGENT?.trim().toLowerCase()
  if (!agent) return null
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`CHAT_AGENT must be "claude" or "codex", not "${agent}".`)
  }
  const servers = (env.CHAT_AGENT_MCP ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const seconds = Number(env.CHAT_AGENT_TIMEOUT_SECONDS)
  const reasoningEffort = env.CHAT_AGENT_REASONING_EFFORT?.trim() || undefined
  if (
    reasoningEffort &&
    !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)
  ) {
    throw new Error('CHAT_AGENT_REASONING_EFFORT must be low, medium, high, xhigh, max, or ultra.')
  }
  const mcp = servers.includes('*') ? 'all' : servers
  const mcpTools = readMcpTools(env.CHAT_AGENT_MCP_TOOLS, mcp)
  const narrowed = Object.keys(mcpTools)
  return {
    agent,
    mcp: mcp === 'all' ? mcp : [...mcp, ...narrowed],
    ...(narrowed.length ? { mcpTools } : {}),
    model: env.CHAT_AGENT_MODEL?.trim() || undefined,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    timeoutMs: (seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000,
  }
}

export interface AgentPrompt {
  system: string
  prompt: string
}

/**
 * Splits a conversation into a system prompt and one prompt for a headless
 * run. Rami's system message already fences book text. Earlier turns are
 * replayed as JSON so no message can pass itself off as a turn boundary.
 * Returns null unless the conversation ends with the reader's message.
 */
export function agentPrompt(messages: RelayMessage[]): AgentPrompt | null {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const turns = messages.filter((message) => message.role !== 'system')
  const last = turns.pop()
  if (!last || last.role !== 'user') return null
  if (turns.length === 0) return { system, prompt: last.content }

  const earlier = JSON.stringify(turns.map(({ role, content }) => ({ role, content })))
  return {
    system,
    prompt:
      `The conversation so far, oldest first, as a JSON array:\n${earlier}\n\n` +
      `The reader's new message:\n${last.content}`,
  }
}

/**
 * Claude Code names a server's tools `mcp__<name>__<tool>`, with anything
 * outside [A-Za-z0-9_-] in the name replaced, so "claude.ai Context7" becomes
 * `mcp__claude_ai_Context7`.
 */
export function claudeToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** What every tool of a server starts with. */
const claudeServerPrefix = (server: string) => `${claudeToolPrefix(server)}__`
const claudeToolName = (server: string, tool: string) => claudeServerPrefix(server) + tool

/** Tools a run may call: any starting with one of `prefixes`, or exactly one of `names`. */
export interface ClaudeAllowlist {
  prefixes: string[]
  names: string[]
}

export function claudeAllowlist(mcp: string[] | 'all', mcpTools: McpTools = {}): ClaudeAllowlist {
  if (mcp === 'all') return { prefixes: ['mcp__'], names: [] }
  const prefixes: string[] = []
  const names: string[] = []
  for (const server of mcp) {
    const tools = narrowedTools(mcpTools, server)
    if (tools) names.push(...tools.map((tool) => claudeToolName(server, tool)))
    else prefixes.push(claudeServerPrefix(server))
  }
  return { prefixes, names }
}

/**
 * Claude joins server and tool with `__`, so `a` and `a__b` (or `a.b` and
 * `a_b`, once normalized) can produce the same tool name. Returns an allowed
 * server whose tools Claude could confuse with another loaded server's.
 */
function claudeAmbiguousServer(allowed: string[], loaded: string[]): string | undefined {
  return allowed.find((server) => {
    const own = claudeServerPrefix(server)
    return loaded.some((other) => {
      const theirs = claudeServerPrefix(other)
      return other !== server && (own.startsWith(theirs) || theirs.startsWith(own))
    })
  })
}

const claudeToolAllowed = ({ prefixes, names }: ClaudeAllowlist, tool: string) =>
  names.includes(tool) || prefixes.some((prefix) => tool.startsWith(prefix))

/**
 * Claude cannot hide some of a server's tools, so a narrowed server's others
 * stay visible. This tells the model which it may use; the rest are refused.
 */
export function claudeToolNote(mcpTools: McpTools = {}): string {
  const lines = Object.entries(mcpTools).map(
    ([server, tools]) => `- ${server}: ${tools.join(', ')}`,
  )
  if (!lines.length) return ''
  return `\n\nFrom these MCP servers, use only the tools listed; any other is refused:\n${lines.join('\n')}`
}

/**
 * A PreToolUse hook that refuses any tool outside the `allowed.json` beside
 * it. Allow rules in the reader's own settings would otherwise still let a
 * pre-approved server through, and a hook's refusal overrides them before the
 * call is made.
 */
export const CLAUDE_GUARD_SCRIPT = `
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => {
  let tool = ''
  try {
    tool = String(JSON.parse(input).tool_name ?? '')
    const { prefixes, names } = JSON.parse(readFileSync(join(__dirname, 'allowed.json'), 'utf8'))
    if (tool && (names.includes(tool) || prefixes.some((prefix) => tool.startsWith(prefix)))) {
      process.exit(0)
    }
  } catch {}
  process.stderr.write(tool + ' is not allowed in Rami chat (CHAT_AGENT_MCP, CHAT_AGENT_MCP_TOOLS).')
  process.exit(2)
})
`

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Settings that install the guard hook for every tool call. */
export function claudeGuardSettings(node: string, guardScript: string): string {
  const command = `${shellQuote(node)} ${shellQuote(guardScript)}`
  return JSON.stringify({
    // A guard that crashes or times out would otherwise let the call through.
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, onFailure: 'block' }] }],
    },
  })
}

/** Built-in tools are off (`--tools ""`), so only MCP tools can exist. */
export function claudeArgs(
  config: AgentConfig,
  files: { systemPrompt: string; settings: string },
  tools: boolean,
) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--tools',
    '',
    '--system-prompt-file',
    files.systemPrompt,
    '--settings',
    files.settings,
  ]
  if (config.model) args.push('--model', config.model)

  const mcp = tools ? config.mcp : []
  // Claude has no wildcard for every MCP tool. Bypass is safe to use only
  // because built-ins are off and the init event is checked for them.
  if (mcp === 'all') args.push('--permission-mode', 'bypassPermissions')
  else if (mcp.length === 0) args.push('--strict-mcp-config', '--permission-mode', 'dontAsk')
  else {
    // dontAsk denies anything not allowed here instead of waiting for a prompt.
    const allowed = mcp.flatMap(
      (server) =>
        narrowedTools(config.mcpTools, server)?.map((tool) => claudeToolName(server, tool)) ?? [
          claudeToolPrefix(server),
        ],
    )
    args.push('--permission-mode', 'dontAsk', '--allowedTools', allowed.join(','))
  }
  return args
}

/**
 * Codex features that reach past MCP: the shell, code execution, plugins
 * (which bring their own MCP servers), hooks, memories, browser and desktop
 * control, sub-agents, and image tools. An unknown name is a startup error, so
 * a Codex release that renames one fails closed rather than silently.
 */
const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'memories',
  'browser_use',
  'in_app_browser',
  'computer_use',
  'multi_agent',
  'goals',
  'image_generation',
  'view_image',
  'skill_mcp_dependency_install',
  'guardian_approval',
]

/** Flags shared by the server listing and the run, so both see the same servers. */
export const CODEX_PLUGIN_FLAGS = ['--disable', 'plugins', '--disable', 'remote_plugin']

/** A server name that is also a bare TOML key, so it can be overridden with `-c`. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/

/** Explains why Codex cannot run with this allowlist, or returns null. */
export function codexServerProblem(config: AgentConfig, configured: string[]): string | null {
  const unsafe = configured.find((name) => !BARE_KEY.test(name))
  if (unsafe !== undefined) {
    return `Codex MCP server "${unsafe}" cannot be switched off from the command line; rename it.`
  }
  if (config.mcp === 'all') return null
  const unknown = config.mcp.find((name) => !configured.includes(name))
  return unknown === undefined
    ? null
    : `CHAT_AGENT_MCP names "${unknown}", which Codex does not have.`
}

/** TOML basic strings take JSON's escapes but also forbid a raw DEL. */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll('\x7f', '\\u007f')
}

/**
 * Writes are refused by the read-only sandbox with approvals set to never,
 * which also overrides an automatic reviewer that would approve them.
 */
export function codexArgs(
  config: AgentConfig,
  system: string,
  configured: string[],
  tools: boolean,
): string[] {
  const args = [
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '-c',
    'approval_policy="never"',
    '-c',
    'approvals_reviewer="user"',
    '-c',
    'web_search="disabled"',
    '-c',
    `developer_instructions=${tomlString(system)}`,
  ]
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature)
  if (config.model) args.push('--model', config.model)
  if (config.reasoningEffort)
    args.push('-c', `model_reasoning_effort=${tomlString(config.reasoningEffort)}`)

  const mcp = tools ? config.mcp : []
  for (const name of configured) {
    if (mcp !== 'all' && !mcp.includes(name)) args.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  // Server names are bare keys (codexServerProblem) and tool names match
  // TOOL_NAME, so the JSON array is also a valid TOML one.
  for (const name of mcp === 'all' ? [] : mcp) {
    const tools = narrowedTools(config.mcpTools, name)
    if (tools) args.push('-c', `mcp_servers.${name}.enabled_tools=${JSON.stringify(tools)}`)
  }
  args.push('-')
  return args
}

/** What the agent is doing between bursts of reply text, shown in the thread. */
type AgentActivity = { kind: 'thinking' } | { kind: 'tool'; server: string; tool: string }

/** What one line of CLI output means for the reply. */
export type AgentEvent =
  { text: string } | { activity: AgentActivity } | { fail: string } | { done: true }

export type AgentParser = (line: string) => AgentEvent[]

const AMBIGUOUS = (server: string) =>
  `Claude names the tools of MCP server "${server}" like another server's, so Rami cannot keep them apart. Rename one of them.`
const DISALLOWED = (name: string) =>
  `The agent tried to use ${name}, which CHAT_AGENT_MCP does not allow, so the reply was stopped.`
const FAILED =
  'The local agent stopped with an error. Check the agent bridge tool logs for details.'

const THINKING: AgentEvent = { activity: { kind: 'thinking' } }

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Separates text blocks the agent wrote either side of a tool call. */
function textJoiner() {
  let written = false
  let pendingBreak = false
  return {
    block() {
      if (written) pendingBreak = true
    },
    text(text: string): AgentEvent[] {
      if (!text) return []
      const prefix = pendingBreak ? '\n\n' : ''
      written = true
      pendingBreak = false
      return [{ text: prefix + text }]
    },
  }
}

/**
 * Reads `claude -p --output-format stream-json --include-partial-messages`.
 * Text comes only from partial deltas; the full assistant and result messages
 * repeat it and are ignored.
 */
export function claudeParser(mcp: string[] | 'all', mcpTools: McpTools = {}): AgentParser {
  const joiner = textJoiner()
  const allowlist = claudeAllowlist(mcp, mcpTools)
  const allowed = (tool: string) => claudeToolAllowed(allowlist, tool)
  const narrowed = Object.keys(mcpTools).map(claudeServerPrefix)

  return (line) => {
    const event = parseLine(line)
    if (!event) return []

    if (event.type === 'system' && event.subtype === 'init') {
      const tools = Array.isArray(event.tools) ? event.tools.map(String) : []
      const builtIn = tools.find((tool) => !tool.startsWith('mcp__'))
      if (builtIn) return [{ fail: DISALLOWED(builtIn) }]
      if (mcp === 'all' || mcp.length === 0) return []
      // Checked against every loaded server, listed or not, before the model runs.
      const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : null
      if (!servers) return [{ fail: FAILED }]
      const loaded = servers.map((server) => String((server as { name?: unknown })?.name))
      const ambiguous = claudeAmbiguousServer(mcp, loaded)
      return ambiguous === undefined ? [] : [{ fail: AMBIGUOUS(ambiguous) }]
    }
    if (event.type === 'result') {
      return event.subtype === 'success' && event.is_error !== true
        ? [{ done: true }]
        : [{ fail: FAILED }]
    }
    if (event.type !== 'stream_event') return []

    const stream = (event.event ?? {}) as {
      type?: string
      content_block?: { type?: string; name?: string }
      delta?: { type?: string; text?: string }
    }
    // A new message starts once the model is working, including after a tool returns.
    if (stream.type === 'message_start') return [THINKING]
    if (stream.type === 'content_block_start') {
      const block = stream.content_block
      if (block?.type === 'tool_use') {
        const name = String(block.name)
        if (!allowed(name)) {
          // A narrowed server's other tools are visible but refused by
          // dontAsk and the guard hook before they run, and the model is told,
          // so it can carry on. Any other server's tool still ends the run.
          if (narrowed.some((prefix) => name.startsWith(prefix))) return [THINKING]
          return [{ fail: DISALLOWED(name) }]
        }
        const [, server = name, tool = name] = /^mcp__(.+?)__(.+)$/.exec(name) ?? []
        return [{ activity: { kind: 'tool', server, tool } }]
      }
      if (block?.type === 'thinking') return [THINKING]
      if (block?.type === 'text') joiner.block()
      return []
    }
    if (stream.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
      return joiner.text(stream.delta.text ?? '')
    }
    return []
  }
}

/**
 * Reads `codex exec --json`, which reports each agent message once it is
 * complete rather than token by token. `error` items are warnings, such as
 * unrecognized config keys; a failed turn or a top-level error ends the run.
 */
export function codexParser(mcp: string[] | 'all', mcpTools: McpTools = {}): AgentParser {
  const joiner = textJoiner()
  const seen = new Set<string>()

  return (line) => {
    const event = parseLine(line)
    if (!event) return []
    if (event.type === 'turn.completed') return [{ done: true }]
    if (event.type === 'turn.failed' || event.type === 'error') return [{ fail: FAILED }]
    if (event.type !== 'item.started' && event.type !== 'item.completed') return []

    const item = (event.item ?? {}) as {
      id?: string
      type?: string
      text?: string
      server?: string
      tool?: string
    }
    if (item.type === 'mcp_tool_call') {
      const server = String(item.server)
      if (mcp !== 'all' && !mcp.includes(server)) return [{ fail: DISALLOWED(server) }]
      // A completed item may omit the tool; the started one must name an allowed one.
      const tools = narrowedTools(mcpTools, server)
      const named = event.type === 'item.started' || item.tool !== undefined
      if (tools && named && !tools.includes(String(item.tool))) {
        return [{ fail: DISALLOWED(`${server} ${String(item.tool)}`) }]
      }
      if (event.type === 'item.completed') return [THINKING]
      return [{ activity: { kind: 'tool', server, tool: String(item.tool ?? server) } }]
    }
    if (item.type === 'reasoning' && event.type === 'item.started') return [THINKING]
    if (item.type === 'command_execution' || item.type === 'file_change') {
      return [{ fail: DISALLOWED(item.type) }]
    }
    if (item.type !== 'agent_message' || event.type !== 'item.completed') return []

    const id = String(item.id)
    if (seen.has(id)) return []
    seen.add(id)
    joiner.block()
    // Codex sends whole messages, so it is still working until the turn completes.
    return [...joiner.text(item.text ?? ''), THINKING]
  }
}
