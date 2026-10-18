/**
 * Serves `/api/chat` in dev from a local Claude Code or Codex CLI instead of
 * OpenRouter (decision 0009). Each request runs the CLI once, headless, in an
 * empty temporary directory, and answers in the same OpenAI-style SSE the PWA
 * already reads, so the client does not know which backend replied.
 *
 * The CLI acts as the reader with whatever MCP servers they allow, so only this
 * machine may call it: loopback peers with a loopback Host, same-origin
 * browsers, and JSON bodies, which a cross-site form cannot send.
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { parseChatBody } from '../shared/relay.ts'
import { boundedText } from '../shared/resilience.ts'
import { operationMetric } from '../shared/telemetry.ts'
import {
  agentPrompt,
  CLAUDE_GUARD_SCRIPT,
  claudeAllowedPrefixes,
  claudeArgs,
  claudeGuardSettings,
  claudeParser,
  CODEX_PLUGIN_FLAGS,
  codexArgs,
  codexParser,
  codexServerProblem,
  type AgentConfig,
  type AgentEvent,
  type AgentParser,
  type AgentPrompt,
} from './agentCli.ts'

export interface AgentChatOptions {
  config: AgentConfig
  /** Starts the CLI. Tests substitute a fake one. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Names of the MCP servers Codex has configured. */
  codexServers?: () => Promise<string[]>
}

interface AgentRequestContext {
  /** The socket peer, not a forwarded header. */
  ip: string
  /** Aborts when the reader's connection closes. */
  signal?: AbortSignal
}

type Handler = (request: Request, context: AgentRequestContext) => Promise<Response>

/** Each run holds a CLI and its MCP servers in memory. */
const MAX_CONCURRENT_RUNS = 2
const KILL_GRACE_MS = 2000
/** Linux caps one argument at 128 KiB; Codex takes its instructions as one. */
const MAX_ARG_BYTES = 120_000

/** The dev server's own secrets, which the agent has no use for. */
const PRIVATE_ENV = [
  'OPENROUTER_API_KEY',
  'TELEMETRY_KEY',
  'TURNSTILE_SECRET_KEY',
  'CHAT_RELAY_URL',
]

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackPeer(ip: string): boolean {
  return ip === '::1' || /^(::ffff:)?127\./.test(ip)
}

export function createAgentChat(options: AgentChatOptions): Handler {
  let running = 0
  return async (request, context) => {
    const started = performance.now()
    const response = await respond(request, context)
    console.info(
      JSON.stringify({
        ...operationMetric('relay', response.status, performance.now() - started),
        backend: options.config.agent,
      }),
    )
    return response
  }

  async function respond(request: Request, context: AgentRequestContext): Promise<Response> {
    const refusal = refuse(request, context.ip)
    if (refusal) return refusal
    const conversation = await readConversation(request)
    if ('error' in conversation) return conversation.error
    if (running >= MAX_CONCURRENT_RUNS) {
      return errorResponse(429, 'The local agent is already answering. Wait for that reply.')
    }

    running++
    let released = false
    const release = () => {
      if (!released) running--
      released = true
    }
    try {
      // Background summaries never get tools; only the reader's thread does.
      const { prompt, stream } = conversation
      const run = await startRun(options, prompt, stream, context.signal, release)
      if ('error' in run) {
        release()
        return run.error
      }
      return stream ? await streamReply(run) : await completeReply(run)
    } catch {
      release()
      return errorResponse(500, 'The local agent could not start.')
    }
  }
}

function refuse(request: Request, ip: string): Response | null {
  if (request.method !== 'POST') return errorResponse(405, 'Use POST.')
  if (!isLoopbackPeer(ip)) return errorResponse(403, 'The local agent answers only this machine.')

  // The dev server builds the URL from Host, which a rebinding attack sets to
  // its own hostname.
  const authority = new URL(request.url)
  if (!LOOPBACK_HOSTS.has(authority.hostname)) {
    return errorResponse(403, 'The local agent answers only localhost.')
  }

  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  if ((origin !== null && origin !== authority.origin) || (site && site !== 'same-origin')) {
    return errorResponse(403, 'Cross-origin requests are not allowed.')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'Expected a JSON body.')
  }
  return null
}

async function readConversation(
  request: Request,
): Promise<{ prompt: AgentPrompt; stream: boolean } | { error: Response }> {
  let payload: unknown
  try {
    payload = JSON.parse(await boundedText(request, 600_000))
  } catch {
    return { error: errorResponse(400, 'Expected a JSON body.') }
  }
  const parsed = parseChatBody(payload)
  if ('error' in parsed) return { error: errorResponse(400, parsed.error) }
  const prompt = agentPrompt(parsed.messages)
  if (!prompt) {
    return { error: errorResponse(400, 'The conversation must end with a user message.') }
  }
  return { prompt, stream: parsed.stream }
}

interface Run {
  events: AsyncIterator<AgentEvent>
  /** Ends the process group and removes the temporary directory. Idempotent. */
  stop: () => void
}

async function startRun(
  options: AgentChatOptions,
  prompt: AgentPrompt,
  tools: boolean,
  signal: AbortSignal | undefined,
  release: () => void,
): Promise<Run | { error: Response }> {
  const { config } = options
  const dir = await mkdtemp(join(tmpdir(), 'rami-agent-'))
  let child: ChildProcess
  let parser: AgentParser
  try {
    const setup = await prepare(options, dir, prompt, tools)
    if ('error' in setup) {
      await rm(dir, { recursive: true, force: true })
      return setup
    }
    parser = setup.parser
    child = (options.spawn ?? spawn)(config.agent, setup.args, {
      cwd: join(dir, 'work'),
      env: agentEnv(),
      // Its own process group, so stopping it also stops stdio MCP servers.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    // Until the process owns it, the directory (and the book context in it) is ours to remove.
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  const exit = watchExit(child)

  let stopped = false
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, config.timeoutMs)
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    killGroup(child)
    release()
    void rm(dir, { recursive: true, force: true })
  }
  signal?.addEventListener('abort', stop)
  if (signal?.aborted) stop()

  // The CLI's own diagnostics can carry config values, so they are discarded.
  child.stderr?.resume()
  child.stdin?.on('error', () => {})
  child.stdin?.end(prompt.prompt)

  return { events: agentEvents(child, parser, exit, () => timedOut), stop }
}

/** Writes the run's files and builds its command line. */
async function prepare(
  options: AgentChatOptions,
  dir: string,
  prompt: AgentPrompt,
  tools: boolean,
): Promise<{ args: string[]; parser: AgentParser } | { error: Response }> {
  const { config } = options
  await mkdir(join(dir, 'work'))
  const mcp = tools ? config.mcp : []

  if (config.agent === 'claude') {
    const files = {
      systemPrompt: join(dir, 'system.md'),
      settings: join(dir, 'settings.json'),
    }
    const guard = join(dir, 'guard.cjs')
    await writeFile(files.systemPrompt, prompt.system, { mode: 0o600 })
    await writeFile(guard, CLAUDE_GUARD_SCRIPT, { mode: 0o600 })
    await writeFile(join(dir, 'allowed.json'), JSON.stringify(claudeAllowedPrefixes(mcp)))
    await writeFile(files.settings, claudeGuardSettings(process.execPath, guard), { mode: 0o600 })
    return { args: claudeArgs(config, files, tools), parser: claudeParser(mcp) }
  }

  const configured = await (options.codexServers ?? listCodexServers)().catch(() => null)
  const problem = configured
    ? codexServerProblem(config, configured)
    : 'Could not list Codex MCP servers. Check that `codex mcp list` works.'
  if (problem) return { error: errorResponse(503, problem) }
  const args = codexArgs(config, prompt.system, configured ?? [], tools)
  if (args.some((arg) => Buffer.byteLength(arg) > MAX_ARG_BYTES)) {
    return { error: errorResponse(413, 'The book context is too long for Codex.') }
  }
  return { args, parser: codexParser(mcp) }
}

function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of PRIVATE_ENV) delete env[name]
  return env
}

function killGroup(child: ChildProcess) {
  const pid = child.pid
  if (pid === undefined) return
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      // Already gone.
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref()
}

/** Watches for the exit, attached right after spawn so no `error` goes unheard. */
function watchExit(child: ChildProcess) {
  let spawnFailed = false
  child.once('error', () => {
    spawnFailed = true
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return { closed, spawnFailed: () => spawnFailed }
}

/**
 * Yields what the CLI's output means, ending with exactly one `done` or
 * `fail`. A CLI that exits without a terminal event was cut short, so its text
 * is not a complete answer.
 */
async function* agentEvents(
  child: ChildProcess,
  parse: AgentParser,
  exit: ReturnType<typeof watchExit>,
  timedOut: () => boolean,
): AsyncGenerator<AgentEvent> {
  if (child.stdout) {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      for (const event of parse(line)) {
        yield event
        if (!('text' in event)) return
      }
    }
  }
  await Promise.race([exit.closed, new Promise((resolve) => setTimeout(resolve, 1000))])
  if (timedOut()) yield { fail: 'The local agent took too long and was stopped.' }
  else if (exit.spawnFailed()) {
    yield { fail: 'Could not start the local agent. Check that its CLI is installed.' }
  } else yield { fail: CUT_SHORT }
}

const CUT_SHORT = 'The local agent ended before it finished the reply.'

async function completeReply({ events, stop }: Run): Promise<Response> {
  let text = ''
  try {
    for (let next = await events.next(); !next.done; next = await events.next()) {
      const event = next.value
      if ('text' in event) text += event.text
      else if ('fail' in event) return errorResponse(502, event.fail)
      else break
    }
  } finally {
    stop()
  }
  return Response.json(
    { choices: [{ message: { role: 'assistant', content: text } }] },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

const encoder = new TextEncoder()
const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
const textFrame = (text: string) => frame({ choices: [{ delta: { content: text } }] })
const DONE_FRAME = encoder.encode('data: [DONE]\n\n')

function failure(next: IteratorResult<AgentEvent>): string | null {
  if (next.done) return CUT_SHORT
  return 'fail' in next.value ? next.value.fail : null
}

/**
 * Holds the response headers until the first text arrives, so a run that fails
 * before writing anything returns a real error status instead of a 200.
 */
async function streamReply({ events, stop }: Run): Promise<Response> {
  const first = await events.next()
  const failed = failure(first)
  if (failed !== null || first.done) {
    stop()
    return errorResponse(502, failed ?? CUT_SHORT)
  }

  const opening = first.value
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue('text' in opening ? textFrame(opening.text) : DONE_FRAME)
      if (!('text' in opening)) {
        stop()
        controller.close()
      }
    },
    async pull(controller) {
      const next = await events.next()
      if (!next.done && 'text' in next.value) {
        controller.enqueue(textFrame(next.value.text))
        return
      }
      // A failure after the headers goes in-band, the way OpenRouter sends it.
      const failed = failure(next)
      controller.enqueue(failed ? frame({ error: { message: failed } }) : DONE_FRAME)
      stop()
      controller.close()
    },
    cancel() {
      stop()
    },
  })
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  })
}

/** Reads server names only; the listing also holds their URLs and env. */
async function listCodexServers(): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    'codex',
    [...CODEX_PLUGIN_FLAGS, 'mcp', 'list', '--json'],
    { env: agentEnv(), maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  )
  const servers: unknown = JSON.parse(stdout)
  if (!Array.isArray(servers)) throw new Error('Unexpected codex mcp list output')
  return servers.map((server) => String((server as { name?: unknown }).name))
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}
