/**
 * The pure half of the local agent chat backend (decision 0009): reading its
 * settings, turning a Rami conversation into one CLI prompt, building each
 * CLI's arguments, and translating the JSONL events it prints. `agentChat.ts`
 * runs the process. Node-only, used by the Vite dev server and never by the app
 * or a Worker.
 *
 * Book text is untrusted and an agent with tools can act on it, so every
 * built-in tool is switched off and MCP servers are allowed only by name. The
 * translators also fail closed: a built-in tool, a file change, or a call to a
 * server outside the allowlist ends the run.
 */

import type { RelayMessage } from '../shared/relay.ts'

type AgentName = 'claude' | 'codex'

export interface AgentConfig {
  agent: AgentName
  /** MCP servers the agent may call during chat, or 'all'. Empty allows none. */
  mcp: string[] | 'all'
  model?: string
  reasoningEffort?: string
  timeoutMs: number
}

const DEFAULT_TIMEOUT_SECONDS = 300

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
  return {
    agent,
    mcp: servers.includes('*') ? 'all' : servers,
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

/** Tool name prefixes a run may call. */
export function claudeAllowedPrefixes(mcp: string[] | 'all'): string[] {
  return mcp === 'all' ? ['mcp__'] : mcp.map((name) => `${claudeToolPrefix(name)}__`)
}

/**
 * A PreToolUse hook that refuses any tool outside the prefixes in the
 * `allowed.json` beside it. Allow rules in the reader's own settings would
 * otherwise still let a pre-approved server through, and a hook's refusal
 * overrides them before the call is made.
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
    const allowed = JSON.parse(readFileSync(join(__dirname, 'allowed.json'), 'utf8'))
    if (tool && allowed.some((prefix) => tool.startsWith(prefix))) process.exit(0)
  } catch {}
  process.stderr.write(tool + ' is not allowed in Rami chat (CHAT_AGENT_MCP).')
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
    args.push('--permission-mode', 'dontAsk', '--allowedTools', mcp.map(claudeToolPrefix).join(','))
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
  args.push('-')
  return args
}

/** What one line of CLI output means for the reply. */
export type AgentEvent = { text: string } | { fail: string } | { done: true }

export type AgentParser = (line: string) => AgentEvent[]

const DISALLOWED = (name: string) =>
  `The agent tried to use ${name}, which CHAT_AGENT_MCP does not allow, so the reply was stopped.`
const FAILED =
  'The local agent stopped with an error. Check the agent bridge tool logs for details.'

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
export function claudeParser(mcp: string[] | 'all'): AgentParser {
  const joiner = textJoiner()
  const prefixes = claudeAllowedPrefixes(mcp)
  const allowed = (tool: string) => prefixes.some((prefix) => tool.startsWith(prefix))

  return (line) => {
    const event = parseLine(line)
    if (!event) return []

    if (event.type === 'system' && event.subtype === 'init') {
      const tools = Array.isArray(event.tools) ? event.tools.map(String) : []
      const builtIn = tools.find((tool) => !tool.startsWith('mcp__'))
      return builtIn ? [{ fail: DISALLOWED(builtIn) }] : []
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
    if (stream.type === 'content_block_start') {
      const block = stream.content_block
      if (block?.type === 'tool_use' && !allowed(String(block.name))) {
        return [{ fail: DISALLOWED(String(block.name)) }]
      }
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
export function codexParser(mcp: string[] | 'all'): AgentParser {
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
    }
    if (item.type === 'mcp_tool_call') {
      const server = String(item.server)
      return mcp === 'all' || mcp.includes(server) ? [] : [{ fail: DISALLOWED(server) }]
    }
    if (item.type === 'command_execution' || item.type === 'file_change') {
      return [{ fail: DISALLOWED(item.type) }]
    }
    if (item.type !== 'agent_message' || event.type !== 'item.completed') return []

    const id = String(item.id)
    if (seen.has(id)) return []
    seen.add(id)
    joiner.block()
    return joiner.text(item.text ?? '')
  }
}
