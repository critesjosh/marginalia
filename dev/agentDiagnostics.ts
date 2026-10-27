/** Local-only diagnostics. Never retain raw CLI text, arguments, or tool results. */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs'
import type { AgentConfig, McpTools } from './agentCli.ts'

type Stage = 'setup' | 'mcp_discovery' | 'cli_start' | 'model' | 'tool' | 'process' | 'reply'
type Outcome = 'started' | 'success' | 'failed' | 'canceled' | 'timeout' | 'warning'
type Reason = ReturnType<typeof errorCategory>

/** Reduce arbitrary, possibly private error text to a fixed diagnostic vocabulary. */
export function errorCategory(value: unknown) {
  const text = typeof value === 'string' ? value.slice(0, 8192).toLowerCase() : ''
  if (/unauthoriz|authentication|invalid.api.key|not.logged.in|token.expired|\b401\b/.test(text))
    return 'authentication'
  if (/rate.limit|too.many.requests|\b429\b/.test(text)) return 'rate_limit'
  if (/quota|credit|billing/.test(text)) return 'quota'
  if (/\b50[0234]\b|service.unavailable|overloaded/.test(text)) return 'provider_unavailable'
  if (/model.*(?:not.found|not.supported|unavailable|does.not.exist)/.test(text))
    return 'model_unavailable'
  if (/context.*(?:length|window)|too.many.tokens/.test(text)) return 'context_limit'
  if (/timed?.out|timeout/.test(text)) return 'timeout'
  if (/permission.denied|\beacces\b|\beperm\b|sandbox/.test(text)) return 'permission'
  if (/\benoent\b|command.not.found/.test(text)) return 'cli_missing'
  if (/connect|network|dns|socket|stream.*disconnect|transport/.test(text)) return 'connection'
  if (/invalid.*config|unknown.*(?:option|argument|feature)|unrecognized/.test(text))
    return 'configuration'
  return 'unknown'
}

function label(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'redacted'
}

/** Allowed tools per server, as labels, for the configuration record. */
function toolLabels(mcpTools: McpTools): McpTools {
  return Object.fromEntries(
    Object.entries(mcpTools)
      .slice(0, 32)
      .map(([server, tools]) => [label(server), tools.slice(0, 32).map(label)]),
  )
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** A private, bounded log: refuse symlinks/foreign files and stop at 1 MiB. */
function debugWrite(path: string, record: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    )
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
      return false
    fchmodSync(fd, 0o600)
    if (stat.size + Buffer.byteLength(record) > 1024 * 1024) return false
    writeSync(fd, record)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function cliVersion(agent: AgentConfig['agent']): Promise<string> {
  return new Promise((resolve) => {
    execFile(agent, ['--version'], { timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
      resolve(
        error
          ? 'unknown'
          : (stdout.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0] ?? 'unknown'),
      )
    })
  })
}

export function createDiagnostics(
  config: AgentConfig,
  tools: boolean,
  version: Promise<string>,
  debugLog?: string,
) {
  const requestId = randomBytes(8).toString('hex')
  const started = performance.now()
  let finished = false
  let stderrTail: Buffer = Buffer.alloc(0)
  let stderrSeen = false
  const calls = new Map<string, { server: string; tool: string; at: number }>()
  let count = 0
  function toolStarted(id: unknown, server: unknown, tool: unknown) {
    if (typeof id !== 'string' || calls.has(id) || calls.size >= 100) return
    calls.set(id, { server: label(server), tool: label(tool), at: performance.now() })
    log('tool', 'started', { server: label(server), tool: label(tool) })
  }
  function toolCompleted(
    id: unknown,
    failed: boolean,
    server?: unknown,
    tool?: unknown,
    error?: unknown,
  ) {
    if (typeof id !== 'string') return
    const call = calls.get(id)
    calls.delete(id)
    log('tool', failed ? 'failed' : 'success', {
      server: call?.server ?? label(server),
      tool: call?.tool ?? label(tool),
      toolDurationMs: call ? Math.round(performance.now() - call.at) : undefined,
      ...(failed ? { reason: errorCategory(error) } : {}),
    })
  }
  function log(
    stage: Stage,
    outcome: Outcome,
    details: {
      reason?: Reason
      exitCode?: number | null
      signal?: string | null
      server?: string
      tool?: string
      toolDurationMs?: number
      cliVersion?: string
      cliEvent?: 'error' | 'turn.failed' | 'result' | 'item.error'
    } = {},
  ) {
    // Bound event floods while always preserving the final outcome and exit.
    if (++count > 200 && stage !== 'reply' && stage !== 'process') return
    console.info(
      JSON.stringify({
        event: 'agent_diagnostic',
        requestId,
        backend: config.agent,
        stage,
        outcome,
        durationMs: Math.round(performance.now() - started),
        ...details,
      }),
    )
  }
  log('setup', 'started')
  void version.then((value) => {
    console.info(
      JSON.stringify({
        event: 'agent_configuration',
        requestId,
        backend: config.agent,
        model: config.model ? label(config.model) : 'inherited',
        reasoningEffort: config.reasoningEffort ?? 'inherited',
        mcp: tools ? (config.mcp === 'all' ? 'all' : config.mcp.slice(0, 32).map(label)) : [],
        ...(tools && config.mcpTools ? { mcpTools: toolLabels(config.mcpTools) } : {}),
        cliVersion: value,
      }),
    )
  })
  return {
    requestId,
    log,
    fail(message: string) {
      this.finish('failed')
      return `${message} Reference: ${requestId}.`
    },
    finish(outcome: Outcome) {
      if (finished) return
      finished = true
      log('reply', outcome)
    },
    stderr(chunk: Buffer) {
      if (!debugLog) return
      stderrSeen = true
      stderrTail = Buffer.from(Buffer.concat([stderrTail, chunk]).subarray(-8192))
    },
    close(code: number | null, signal: NodeJS.Signals | null) {
      log('process', code === 0 ? 'success' : 'failed', { exitCode: code, signal })
      if (debugLog && stderrSeen) {
        // Classification is deliberate redaction: unknown prose is never persisted.
        const reasons = [
          ...new Set(stderrTail.toString('utf8').split('\n').slice(-32).map(errorCategory)),
        ]
        const record =
          JSON.stringify({ event: 'agent_stderr', requestId, reasons, redacted: true }) + '\n'
        if (!debugWrite(debugLog, record)) log('process', 'warning', { reason: 'permission' })
      }
    },
    observe(line: string) {
      let event: Record<string, unknown>
      try {
        event = object(JSON.parse(line) as unknown)
      } catch {
        return
      }
      const error = object(event.error)
      if (
        event.type === 'error' ||
        event.type === 'turn.failed' ||
        (event.type === 'result' && (event.is_error || event.subtype !== 'success'))
      ) {
        log('model', 'failed', {
          cliEvent: event.type as 'error' | 'turn.failed' | 'result',
          reason: errorCategory(
            error.message ??
              error.code ??
              event.message ??
              (Array.isArray(event.errors)
                ? event.errors.find((value: unknown) => typeof value === 'string')
                : undefined) ??
              event.subtype,
          ),
        })
      }
      const stream = object(event.event)
      const block = object(stream.content_block)
      if (
        event.type === 'stream_event' &&
        stream.type === 'content_block_start' &&
        block?.type === 'tool_use'
      ) {
        const match = typeof block.name === 'string' ? /^mcp__(.*?)__(.*)$/.exec(block.name) : null
        toolStarted(block.id, match?.[1], match?.[2])
      }
      const content = object(event.message).content
      if (event.type === 'user' && Array.isArray(content)) {
        for (const value of content.slice(0, 100)) {
          const result = object(value)
          if (result?.type === 'tool_result')
            toolCompleted(result.tool_use_id, result.is_error === true)
        }
      }
      const item = object(event.item)
      if (item?.type === 'error')
        log('model', 'warning', { cliEvent: 'item.error', reason: errorCategory(item.message) })
      if (item?.type !== 'mcp_tool_call' || typeof item.id !== 'string') return
      if (event.type === 'item.started' && calls.size < 100) {
        toolStarted(item.id, item.server, item.tool)
      } else if (event.type === 'item.completed') {
        toolCompleted(
          item.id,
          Boolean(item.error) || item.status === 'failed',
          item.server,
          item.tool,
          object(item.error).message,
        )
      }
    },
  }
}

export type Diagnostics = ReturnType<typeof createDiagnostics>
