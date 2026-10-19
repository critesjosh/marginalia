/**
 * Serves `/api/chat` in dev from a local Claude Code or Codex CLI instead of
 * OpenRouter (decision 0009). Each request runs the CLI once, headless, in an
 * empty temporary directory, and answers in the same OpenAI-style SSE the PWA
 * already reads, so the client does not know which backend replied.
 *
 * The CLI acts as the reader with whatever MCP servers they allow, so only this
 * machine may call it: loopback peers with a loopback Host, and JSON bodies,
 * which a cross-site form cannot send. Under the dev server the caller must be
 * the page itself; behind the bridge (decision 0010) it must be a paired app.
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
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
import {
  cliVersion,
  createDiagnostics,
  errorCategory,
  type Diagnostics,
} from './agentDiagnostics.ts'

export interface AgentChatOptions {
  config: AgentConfig
  /** Starts the CLI. Tests substitute a fake one. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Names of the MCP servers Codex has configured. */
  codexServers?: () => Promise<string[]>
  /** Accept paired cross-origin apps instead of same-origin pages (the bridge). */
  pairing?: Pairing
  /** Opt-in private file containing classified (never raw) stderr diagnostics. */
  debugLog?: string
}

export interface Pairing {
  /** Sent by the app as `Authorization: Bearer <token>`. */
  token: string
  /** Exact origins whose browser requests are accepted. */
  origins: string[]
  /** Also accept origins matching this, such as the app's preview builds. */
  originPattern?: RegExp
}

export function isPairedOrigin(pairing: Pairing, origin: string): boolean {
  return pairing.origins.includes(origin) || pairing.originPattern?.test(origin) === true
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

export function isLoopbackPeer(ip: string): boolean {
  return ip === '::1' || /^(::ffff:)?127\./.test(ip)
}

/** Whether a URL hostname names this machine. A rebinding attack uses its own. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

export function createAgentChat(options: AgentChatOptions): Handler {
  let running = 0
  let version: Promise<string> | undefined
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
    const refusal = refuse(request, context.ip, options.pairing)
    if (refusal) return refusal
    const conversation = await readConversation(request)
    if ('error' in conversation) return conversation.error
    if (running >= MAX_CONCURRENT_RUNS) {
      return errorResponse(429, 'The local agent is already answering. Wait for that reply.')
    }

    running++
    version ??= options.spawn ? Promise.resolve('test-cli') : cliVersion(options.config.agent)
    const diagnostics = createDiagnostics(
      options.config,
      conversation.stream,
      version,
      options.debugLog,
    )
    let released = false
    const release = () => {
      if (!released) running--
      released = true
    }
    try {
      // Background summaries never get tools; only the reader's thread does.
      const { prompt, stream } = conversation
      const run = await startRun(options, prompt, stream, context.signal, release, diagnostics)
      if ('error' in run) {
        release()
        return run.error
      }
      return stream ? await streamReply(run) : await completeReply(run)
    } catch (error) {
      release()
      diagnostics.log('setup', 'failed', {
        reason: errorCategory((error as NodeJS.ErrnoException)?.code),
      })
      return errorResponse(500, diagnostics.fail('The local agent could not start.'))
    }
  }
}

function refuse(request: Request, ip: string, pairing: Pairing | undefined): Response | null {
  if (request.method !== 'POST') return errorResponse(405, 'Use POST.')
  const caller = refuseCaller(request, ip, pairing)
  if (caller) return caller
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'Expected a JSON body.')
  }
  return null
}

/**
 * Checks who is calling, whatever the route. The URL must be built from the
 * request's own Host, which a rebinding attack sets to its own hostname.
 */
export function refuseCaller(
  request: Request,
  ip: string,
  pairing: Pairing | undefined,
): Response | null {
  if (!isLoopbackPeer(ip)) return errorResponse(403, 'The local agent answers only this machine.')
  const authority = new URL(request.url)
  if (!isLoopbackHost(authority.hostname)) {
    return errorResponse(403, 'The local agent answers only localhost.')
  }

  const origin = request.headers.get('origin')
  if (!pairing) {
    const site = request.headers.get('sec-fetch-site')
    if ((origin !== null && origin !== authority.origin) || (site && site !== 'same-origin')) {
      return errorResponse(403, 'Cross-origin requests are not allowed.')
    }
    return null
  }
  // No Origin means a non-browser client, which still needs the token.
  if (origin !== null && !isPairedOrigin(pairing, origin)) {
    return errorResponse(403, 'This site is not paired with the local agent.')
  }
  if (!tokenMatches(request.headers.get('authorization'), pairing.token)) {
    return errorResponse(401, 'The pairing token was rejected. Pair again in Settings.')
  }
  return null
}

/** Compares digests, so neither the length nor the content leaks through timing. */
function tokenMatches(header: string | null, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return presented !== '' && timingSafeEqual(digest(presented), digest(token))
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
  diagnostics: Diagnostics,
): Promise<Run | { error: Response }> {
  const { config } = options
  const dir = await mkdtemp(join(tmpdir(), 'rami-agent-'))
  let child: ChildProcess
  let parser: AgentParser
  try {
    const setup = await prepare(options, dir, prompt, tools, diagnostics)
    if ('error' in setup) {
      await rm(dir, { recursive: true, force: true })
      const body = (await setup.error.json()) as { error: { message: string } }
      return {
        error: errorResponse(setup.error.status, diagnostics.fail(body.error.message)),
      }
    }
    parser = setup.parser
    diagnostics.log('cli_start', 'started')
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
  const exit = watchExit(child, diagnostics)

  let stopped = false
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    diagnostics.finish('timeout')
    stop()
  }, config.timeoutMs)
  function stop() {
    if (stopped) return
    stopped = true
    diagnostics.finish('canceled')
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    killGroup(child)
    release()
    void rm(dir, { recursive: true, force: true })
  }
  signal?.addEventListener('abort', stop)
  if (signal?.aborted) stop()

  // Only a bounded, classified tail may reach the opt-in local debug file.
  child.stderr?.on('data', (chunk: Buffer) => diagnostics.stderr(chunk))
  child.stdin?.on('error', () => {})
  child.stdin?.end(prompt.prompt)

  return { events: agentEvents(child, parser, exit, () => timedOut, diagnostics), stop }
}

/** Writes the run's files and builds its command line. */
async function prepare(
  options: AgentChatOptions,
  dir: string,
  prompt: AgentPrompt,
  tools: boolean,
  diagnostics: Diagnostics,
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

  diagnostics.log('mcp_discovery', 'started')
  const configured = await (options.codexServers ?? listCodexServers)().catch(() => null)
  const problem = configured
    ? codexServerProblem(config, configured)
    : 'Could not list Codex MCP servers. Check that `codex mcp list` works.'
  diagnostics.log(
    'mcp_discovery',
    problem ? 'failed' : 'success',
    problem ? { reason: 'configuration' } : {},
  )
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
function watchExit(child: ChildProcess, diagnostics: Diagnostics) {
  let spawnFailed = false
  child.once('error', (error: NodeJS.ErrnoException) => {
    spawnFailed = true
    diagnostics.log('cli_start', 'failed', { reason: errorCategory(error.code) })
  })
  const closed = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      diagnostics.close(code, signal)
      resolve()
    }),
  )
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
  diagnostics: Diagnostics,
): AsyncGenerator<AgentEvent> {
  if (child.stdout) {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      diagnostics.observe(line)
      for (const event of parse(line)) {
        if ('done' in event) diagnostics.finish('success')
        yield 'fail' in event ? { fail: diagnostics.fail(event.fail) } : event
        if (!('text' in event)) return
      }
    }
  }
  await Promise.race([exit.closed, new Promise((resolve) => setTimeout(resolve, 1000))])
  if (timedOut()) yield { fail: diagnostics.fail('The local agent took too long and was stopped.') }
  else if (exit.spawnFailed()) {
    yield {
      fail: diagnostics.fail('Could not start the local agent. Check that its CLI is installed.'),
    }
  } else yield { fail: diagnostics.fail(CUT_SHORT) }
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

export function errorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}
