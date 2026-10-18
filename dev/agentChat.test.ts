import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeChat, InferenceError, streamChat } from '../src/lib/inference.ts'
import { createAgentChat, type AgentChatOptions } from './agentChat.ts'
import type { AgentConfig } from './agentCli.ts'

/**
 * Stands in for the agent CLI: records what it was given, prints the canned
 * lines in FAKE_LINES, and can hang or start a grandchild the way a stdio MCP
 * server would.
 */
const FAKE_CLI = `
const fs = require('node:fs')
const { spawn } = require('node:child_process')
let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', async () => {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.'), input,
    leaked: process.env.OPENROUTER_API_KEY ?? null,
  }))
  if (process.env.FAKE_GRANDCHILD) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(child.pid))
  }
  for (const line of JSON.parse(process.env.FAKE_LINES || '[]')) {
    process.stdout.write(line + '\\n')
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY || 0)))
  }
  if (process.env.FAKE_HANG) setInterval(() => {}, 1000)
})
`

const line = (value: unknown) => JSON.stringify(value)
const delta = (text: string) =>
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })
const INIT = line({ type: 'system', subtype: 'init', tools: ['mcp__tavily__tavily_search'] })
const SUCCESS = line({ type: 'result', subtype: 'success', is_error: false })

let dir: string
let record: string
let script: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-chat-test-'))
  record = join(dir, 'record.json')
  script = join(dir, 'fake-cli.cjs')
  writeFileSync(script, FAKE_CLI)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  // The PWA reads its pairing from localStorage; unpaired, it uses /api/chat.
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
  process.env.OPENROUTER_API_KEY = 'relay-key-placeholder'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.OPENROUTER_API_KEY
  rmSync(dir, { recursive: true, force: true })
})

function fakeSpawn(lines: string[], extra: Record<string, string> = {}) {
  const commands: string[] = []
  const run = (command: string, args: string[], options: SpawnOptions) => {
    commands.push(command)
    return spawn(process.execPath, [script, ...args], {
      ...options,
      env: { ...options.env, FAKE_RECORD: record, FAKE_LINES: JSON.stringify(lines), ...extra },
    })
  }
  return { run, commands }
}

function handler(lines: string[], config: Partial<AgentConfig> = {}, extra = {}) {
  const fake = fakeSpawn(lines, extra)
  const options: AgentChatOptions = {
    config: { agent: 'claude', mcp: ['tavily'], timeoutMs: 10_000, ...config },
    spawn: fake.run,
    codexServers: async () => ['tavily', 'gmail'],
  }
  return { handle: createAgentChat(options), commands: fake.commands }
}

const MESSAGES = [
  { role: 'system' as const, content: 'You are a reading companion.' },
  { role: 'user' as const, content: 'Who is Ahab?' },
]

function chatRequest(
  init: { headers?: Record<string, string>; body?: unknown; url?: string; method?: string } = {},
) {
  return new Request(init.url ?? 'http://127.0.0.1:5173/api/chat', {
    method: init.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body:
      (init.method ?? 'POST') === 'POST'
        ? JSON.stringify(init.body ?? { messages: MESSAGES, stream: true })
        : undefined,
  })
}

/** Answers the PWA's fetch from the handler, as the dev middleware would. */
function serveFetch(handle: ReturnType<typeof createAgentChat>, signal?: AbortSignal) {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    handle(new Request(new URL(url, 'http://127.0.0.1:5173'), init), { ip: '127.0.0.1', signal }),
  )
}

const recorded = () =>
  JSON.parse(readFileSync(record, 'utf8')) as {
    args: string[]
    cwd: string
    files: string[]
    input: string
    leaked: string | null
  }

describe('request guards', () => {
  const { handle } = handler([INIT, delta('Hi'), SUCCESS])
  const status = async (request: Request, ip = '127.0.0.1') => {
    const response = await handle(request, { ip })
    await response.text()
    return response.status
  }

  it('answers only loopback peers at a loopback host', async () => {
    expect(await status(chatRequest(), '192.168.1.20')).toBe(403)
    expect(await status(chatRequest(), '::ffff:10.0.0.2')).toBe(403)
    expect(await status(chatRequest({ url: 'http://rebind.example:5173/api/chat' }))).toBe(403)
    expect(await status(chatRequest({ method: 'GET' }))).toBe(405)
  })

  it('refuses other origins, opaque origins and non-JSON bodies', async () => {
    const other = { headers: { Origin: 'http://localhost:3000' } }
    expect(await status(chatRequest(other))).toBe(403)
    expect(await status(chatRequest({ headers: { Origin: 'null' } }))).toBe(403)
    expect(await status(chatRequest({ headers: { 'Sec-Fetch-Site': 'same-site' } }))).toBe(403)
    expect(await status(chatRequest({ headers: { 'Content-Type': 'text/plain' } }))).toBe(415)
  })

  it('accepts the app itself and IPv6 or mapped loopback peers', async () => {
    const same = {
      headers: { Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'same-origin' },
    }
    expect(await status(chatRequest(same))).toBe(200)
    expect(await status(chatRequest(), '::1')).toBe(200)
    expect(await status(chatRequest(), '::ffff:127.0.0.1')).toBe(200)
  })

  it('rejects malformed conversations before starting anything', async () => {
    expect(await status(chatRequest({ body: { messages: [] } }))).toBe(400)
    const endsWithAnswer = [...MESSAGES, { role: 'assistant', content: 'A captain.' }]
    expect(await status(chatRequest({ body: { messages: endsWithAnswer } }))).toBe(400)
    expect(existsSync(record)).toBe(false)
  })
})

describe('streaming replies', () => {
  it('streams text the PWA reads, from a run with no workspace or secrets', async () => {
    const { handle, commands } = handler([
      INIT,
      delta('Captain'),
      delta(' of the Pequod.'),
      SUCCESS,
    ])
    serveFetch(handle)
    const deltas: string[] = []
    const reply = await streamChat({ messages: MESSAGES, onDelta: (text) => deltas.push(text) })

    expect(reply).toBe('Captain of the Pequod.')
    expect(deltas).toEqual(['Captain', ' of the Pequod.'])
    expect(commands).toEqual(['claude'])

    const run = recorded()
    expect(run.input).toBe('Who is Ahab?')
    expect(run.files).toEqual([])
    expect(run.leaked).toBeNull()
    expect(run.args[run.args.indexOf('--allowedTools') + 1]).toBe('mcp__tavily')
    const systemFile = run.args[run.args.indexOf('--system-prompt-file') + 1]
    expect(systemFile.startsWith(run.cwd)).toBe(false)
    await vi.waitFor(() => expect(existsSync(run.cwd)).toBe(false))
  })

  it('returns an error status when the run fails before writing anything', async () => {
    const failing = line({ type: 'result', subtype: 'error_during_execution', is_error: true })
    const { handle } = handler([INIT, failing])
    serveFetch(handle)
    await expect(streamChat({ messages: MESSAGES, onDelta: () => {} })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('stopped with an error'),
    })
  })

  it('reports a failure after the first text in-band, so the fragment is not kept', async () => {
    const tool = line({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'mcp__gmail__send' },
      },
    })
    const { handle } = handler([INIT, delta('Let me email that.'), tool, SUCCESS])
    serveFetch(handle)
    await expect(streamChat({ messages: MESSAGES, onDelta: () => {} })).rejects.toThrow(
      /mcp__gmail__send/,
    )
  })

  it('treats an exit without a result as a cut-off reply', async () => {
    const { handle } = handler([INIT, delta('Half an')])
    serveFetch(handle)
    await expect(streamChat({ messages: MESSAGES, onDelta: () => {} })).rejects.toThrow(
      /ended before it finished/,
    )
  })

  it('says when the CLI is not installed', async () => {
    const handle = createAgentChat({
      config: { agent: 'claude', mcp: [], timeoutMs: 10_000 },
      spawn: (_command, args, options) => spawn('/nonexistent/claude', args, options),
    })
    const response = await handle(chatRequest(), { ip: '127.0.0.1' })
    expect(response.status).toBe(502)
    expect((await response.json()).error.message).toMatch(/Could not start/)
  })
})

describe('setup failures', () => {
  const agentDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('rami-agent-'))

  it('removes the temporary directory when the CLI cannot be spawned', async () => {
    const before = agentDirs()
    const handle = createAgentChat({
      config: { agent: 'claude', mcp: [], timeoutMs: 10_000 },
      spawn: () => {
        throw new Error('spawn failed')
      },
    })
    const response = await handle(chatRequest(), { ip: '127.0.0.1' })
    expect(response.status).toBe(500)
    expect(agentDirs().filter((name) => !before.includes(name))).toEqual([])
  })

  it('installs the guard hook for the allowed servers', async () => {
    const { handle } = handler([INIT, delta('Hi'), SUCCESS])
    const response = await handle(chatRequest(), { ip: '127.0.0.1' })
    await response.text()
    const { args, cwd } = recorded()
    const settings = args[args.indexOf('--settings') + 1]
    expect(settings.startsWith(join(cwd, '..'))).toBe(true)
  })
})

describe('background summaries', () => {
  it('answers without streaming and without MCP servers', async () => {
    const { handle } = handler([INIT, delta('A summary.'), SUCCESS], { mcp: 'all' })
    serveFetch(handle)
    expect(await completeChat({ messages: MESSAGES })).toBe('A summary.')
    const { args } = recorded()
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('bypassPermissions')
  })

  it('returns an error status instead of an empty summary', async () => {
    const { handle } = handler([INIT, delta('Part')])
    serveFetch(handle)
    await expect(completeChat({ messages: MESSAGES })).rejects.toBeInstanceOf(InferenceError)
  })
})

describe('stopping runs', () => {
  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('stops the whole process group when the reader closes the reply', async () => {
    const grandchild = join(dir, 'grandchild.pid')
    const { handle } = handler(
      [INIT, delta('Thinking')],
      {},
      { FAKE_HANG: '1', FAKE_GRANDCHILD: grandchild },
    )
    const closed = new AbortController()
    const response = await handle(chatRequest(), { ip: '127.0.0.1', signal: closed.signal })
    expect(response.status).toBe(200)
    const pid = Number(readFileSync(grandchild, 'utf8'))
    expect(pidAlive(pid)).toBe(true)

    closed.abort()
    await vi.waitFor(() => expect(pidAlive(pid)).toBe(false), { timeout: 5000 })
  })

  it('stops a run that overruns its time limit', async () => {
    const { handle } = handler([INIT], { timeoutMs: 200 }, { FAKE_HANG: '1' })
    const response = await handle(chatRequest(), { ip: '127.0.0.1' })
    expect(response.status).toBe(502)
    expect((await response.json()).error.message).toMatch(/took too long/)
  })

  it('limits concurrent runs and frees the slot afterwards', async () => {
    const { handle } = handler([INIT, delta('Busy')], {}, { FAKE_HANG: '1' })
    const first = new AbortController()
    const second = new AbortController()
    await handle(chatRequest(), { ip: '127.0.0.1', signal: first.signal })
    await handle(chatRequest(), { ip: '127.0.0.1', signal: second.signal })
    expect((await handle(chatRequest(), { ip: '127.0.0.1' })).status).toBe(429)

    first.abort()
    const third = new AbortController()
    expect((await handle(chatRequest(), { ip: '127.0.0.1', signal: third.signal })).status).toBe(
      200,
    )
    second.abort()
    third.abort()
  })
})

describe('codex', () => {
  const message = (id: string, text: string) =>
    line({ type: 'item.completed', item: { id, type: 'agent_message', text } })

  it('runs codex with unlisted servers switched off and the prompt on stdin', async () => {
    const { handle, commands } = handler(
      [message('item_1', 'Ahab captains the Pequod.'), line({ type: 'turn.completed' })],
      { agent: 'codex' },
    )
    serveFetch(handle)
    expect(await streamChat({ messages: MESSAGES, onDelta: () => {} })).toBe(
      'Ahab captains the Pequod.',
    )
    expect(commands).toEqual(['codex'])
    const { args, input } = recorded()
    expect(input).toBe('Who is Ahab?')
    expect(args).toContain('mcp_servers.gmail.enabled=false')
    expect(args).not.toContain('mcp_servers.tavily.enabled=false')
    expect(args).toContain('developer_instructions="You are a reading companion."')
  })

  it('refuses book context too long for one command-line argument', async () => {
    const { handle } = handler([], { agent: 'codex', mcp: [] })
    const messages = [{ role: 'system', content: '鯨'.repeat(50_000) }, MESSAGES[1]]
    const response = await handle(chatRequest({ body: { messages, stream: true } }), {
      ip: '127.0.0.1',
    })
    expect(response.status).toBe(413)
    expect(existsSync(record)).toBe(false)
  })

  it('refuses to start when the allowlist names a server codex lacks', async () => {
    const { handle } = handler([], { agent: 'codex', mcp: ['notes'] })
    const response = await handle(chatRequest(), { ip: '127.0.0.1' })
    expect(response.status).toBe(503)
    expect((await response.json()).error.message).toMatch(/notes/)
    expect(existsSync(record)).toBe(false)
  })
})
