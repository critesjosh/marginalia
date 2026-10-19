/**
 * The local agent bridge (decision 0010): lets the hosted Rami app answer chat
 * with the reader's own Claude Code or Codex CLI. It serves the decision 0009
 * handler at http://127.0.0.1:47615 to paired apps only.
 *
 *   npm run agent-bridge -- --agent claude --mcp tavily
 *
 * Every request must come from this machine, name this machine in its Host,
 * carry the pairing token, and, from a browser, come from an allowed origin.
 * The bridge cannot defend against software already running as the reader,
 * such as a browser extension that reads pages or a process that reads the
 * token file; those are outside its threat model.
 */

import { randomBytes } from 'node:crypto'
import { watch } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { parseArgs } from 'node:util'
import {
  createAgentChat,
  errorResponse,
  isLoopbackHost,
  isLoopbackPeer,
  isPairedOrigin,
  refuseCaller,
  type AgentChatOptions,
  type Pairing,
} from './agentChat.ts'
import { readAgentConfig, type AgentConfig } from './agentCli.ts'
import { configDir, loadToken, readToken } from './bridgeToken.ts'
import { createThreadStore, openSaveDir, parseThreadExport, SaveError } from './threadStore.ts'

/** The only port the hosted app's CSP lets it reach. */
export const BRIDGE_PORT = 47615
/** The app's production hosts (both routes in wrangler.jsonc). */
export const DEFAULT_ORIGINS = [
  'https://rami.agenticpossible.com',
  'https://marginalia.adjacentpossible.dev',
]

/**
 * Workers Builds previews of the app: `<branch or version>-marginalia` on the
 * account's workers.dev subdomain. A hostname cannot tell these apart from a
 * Worker in the same Cloudflare account whose own name ends in `-marginalia`,
 * so this trusts the account: whoever can deploy there or push a branch here
 * can already ship the production app.
 */
export const PREVIEW_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-marginalia\.cloudflare-cdd\.workers\.dev$/

/** Chat bodies; a saved thread may be larger (decision 0011). */
const MAX_BODY_BYTES = 600_000
const MAX_THREAD_BYTES = 2_000_000
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT'])
const THREAD_PATH = /^\/v1\/threads\/([A-Za-z0-9_-]{1,64})$/
const ALLOWED_HEADERS = new Set(['authorization', 'content-type'])

export interface BridgeOptions extends Pick<AgentChatOptions, 'spawn' | 'codexServers'> {
  config: AgentConfig
  /** Shared, so the CLI can rotate the token once it owns the port. */
  pairing: Pairing
  /** 0 takes a free port. */
  port: number
  /** The `--save-dir` folder, already opened, or undefined when not saving. */
  saveDir?: string
}

export function createBridgeServer(options: BridgeOptions): Server {
  const { pairing } = options
  const chat = createAgentChat({ ...options, pairing })
  const saveThread = options.saveDir ? createThreadStore(options.saveDir) : null

  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) send(res, errorResponse(500, 'The bridge failed.'), null)
      else res.destroy()
    })
  })
  return server

  async function route(req: IncomingMessage, res: ServerResponse) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    // CORS headers go only to an allowed origin, so others cannot read replies.
    const cors = origin && isPairedOrigin(pairing, origin) ? origin : null

    // Checked before anything else, on every route: a rebinding attack reaches
    // this port under its own hostname.
    const host = req.headers.host ?? ''
    // Port 0 lets tests take any free port; Host must then name the real one.
    const port = options.port || (server.address() as AddressInfo).port
    if (!isBridgeHost(host, port) || !isLoopbackPeer(req.socket.remoteAddress ?? '')) {
      return send(res, errorResponse(403, 'The local agent answers only this machine.'), null)
    }

    const path = (req.url ?? '').split('?')[0]
    const threadId = THREAD_PATH.exec(path)?.[1]
    if (path !== '/v1/status' && path !== '/v1/chat' && !threadId) {
      return send(res, errorResponse(404, 'Not found.'), cors)
    }
    if (req.method === 'OPTIONS') return send(res, preflight(req, origin, cors), cors)

    const request = await webRequest(req, host, threadId ? MAX_THREAD_BYTES : MAX_BODY_BYTES)
    if (!request) return send(res, errorResponse(413, 'Request body too large.'), cors)
    const ip = req.socket.remoteAddress ?? ''

    if (path === '/v1/status') {
      if (req.method !== 'GET') return send(res, errorResponse(405, 'Use GET.'), cors)
      const refusal = refuseCaller(request, ip, pairing)
      const { agent, mcp } = options.config
      const saveDir = options.saveDir ?? null
      return send(res, refusal ?? Response.json({ agent, mcp, saveDir }), cors)
    }
    if (threadId) return send(res, await putThread(request, ip, threadId), cors)

    // Stops the agent when the reader closes the reply.
    const closed = new AbortController()
    res.on('close', () => closed.abort())
    const response = await chat(request, {
      ip: req.socket.remoteAddress ?? '',
      signal: closed.signal,
    })
    return send(res, response, cors)
  }

  /** Saves one thread under `--save-dir` (decision 0011). */
  async function putThread(request: Request, ip: string, id: string): Promise<Response> {
    if (request.method !== 'PUT') return errorResponse(405, 'Use PUT.')
    const refusal = refuseCaller(request, ip, pairing)
    if (refusal) return refusal
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return errorResponse(415, 'Expected a JSON body.')
    }
    if (!saveThread) return errorResponse(404, 'This bridge was not started with --save-dir.')
    try {
      await saveThread(parseThreadExport(await request.json(), id))
      return new Response(null, { status: 204 })
    } catch (error) {
      if (error instanceof SaveError) {
        const response = errorResponse(error.status, error.message)
        if (!error.code) return response
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status, headers: response.headers },
        )
      }
      if (error instanceof SyntaxError) return errorResponse(400, 'Expected a JSON body.')
      return errorResponse(500, 'The thread could not be saved. Check the save folder.')
    }
  }
}

/** `127.0.0.1:47615` or `localhost:47615`, and nothing else. */
function isBridgeHost(host: string, port: number): boolean {
  try {
    const url = new URL(`http://${host}`)
    return isLoopbackHost(url.hostname) && url.port === String(port)
  } catch {
    return false
  }
}

/** Answers a CORS preflight, which carries no token, so it checks everything else. */
function preflight(req: IncomingMessage, origin: string | null, cors: string | null): Response {
  if (!origin || !cors) return errorResponse(403, 'This site is not paired with the local agent.')
  const method = String(req.headers['access-control-request-method'] ?? '')
  const headers = String(req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  if (!ALLOWED_METHODS.has(method) || !headers.every((name) => ALLOWED_HEADERS.has(name))) {
    return errorResponse(403, 'That request is not allowed.')
  }

  const response = new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': [...ALLOWED_METHODS].join(', '),
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    },
  })
  // Chrome's older private network access preflight. Its replacement, local
  // network access, asks the reader instead.
  if (req.headers['access-control-request-private-network'] === 'true') {
    response.headers.set('Access-Control-Allow-Private-Network', 'true')
  }
  return response
}

async function webRequest(
  req: IncomingMessage,
  host: string,
  limit: number,
): Promise<Request | null> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length
    if (bytes > limit) return null
    chunks.push(chunk as Buffer)
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
  }
  return new Request(new URL(req.url ?? '/', `http://${host}`), {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  })
}

function send(res: ServerResponse, response: Response, cors: string | null) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Origin')
  if (cors) res.setHeader('Access-Control-Allow-Origin', cors)
  // The DOM and Node typings name the same stream differently.
  if (response.body) Readable.fromWeb(response.body as NodeReadableStream).pipe(res)
  else res.end()
}

const USAGE = `Usage: npm run agent-bridge -- [options]

  --agent claude|codex   The CLI that answers (or CHAT_AGENT)
  --mcp <names>          MCP servers it may call, comma-separated, or * (or CHAT_AGENT_MCP)
  --model <name>         Model for the agent (or CHAT_AGENT_MODEL)
  --origin <url>         Another app origin to accept, e.g. http://localhost:5173 (repeatable)
  --no-previews          Refuse the app's preview builds (*-marginalia.cloudflare-cdd.workers.dev)
  --save-dir <path>      Keep a Markdown copy of each thread in this folder
  --port <n>             Port to listen on (default ${BRIDGE_PORT}; the hosted app reaches only that one)
  --show-token           Print the pairing token again
  --new-token            Replace the pairing token, unpairing every browser
`

async function main() {
  const { values } = parseArgs({
    options: {
      agent: { type: 'string' },
      mcp: { type: 'string' },
      model: { type: 'string' },
      origin: { type: 'string', multiple: true },
      port: { type: 'string' },
      'show-token': { type: 'boolean' },
      'new-token': { type: 'boolean' },
      'no-previews': { type: 'boolean' },
      'save-dir': { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }

  const config = readAgentConfig({
    ...process.env,
    CHAT_AGENT: values.agent ?? process.env.CHAT_AGENT,
    CHAT_AGENT_MCP: values.mcp ?? process.env.CHAT_AGENT_MCP,
    CHAT_AGENT_MODEL: values.model ?? process.env.CHAT_AGENT_MODEL,
  })
  if (!config) {
    console.error(`Choose an agent with --agent claude or --agent codex.\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  const port = values.port ? Number(values.port) : BRIDGE_PORT
  const origins = [...DEFAULT_ORIGINS, ...(values.origin ?? [])].map((url) => new URL(url).origin)
  const dir = configDir()
  let loaded = await loadToken(dir)
  const previews = !values['no-previews']
  const pairing: Pairing = {
    token: loaded.token,
    origins,
    originPattern: previews ? PREVIEW_ORIGIN : undefined,
  }
  let saveDir: string | undefined
  if (values['save-dir']) {
    try {
      saveDir = await openSaveDir(values['save-dir'])
    } catch (error) {
      console.error(`Cannot save threads there: ${(error as Error).message}`)
      process.exitCode = 1
      return
    }
  }
  const server = createBridgeServer({ config, pairing, port, saveDir })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
    console.error(
      busy
        ? `Port ${port} is in use, probably by another bridge. Stop it first; the token is unchanged.`
        : `Could not listen on port ${port}.`,
    )
    process.exitCode = 1
    return
  }
  // Rotated only once this process owns the port, so no older bridge goes on
  // accepting the old token.
  if (values['new-token']) {
    loaded = await loadToken(dir, true)
    pairing.token = loaded.token
  }
  followToken(loaded.file, pairing)

  const mcp = config.mcp === 'all' ? 'every MCP server' : config.mcp.join(', ') || 'no MCP servers'
  console.log(`Rami agent bridge: ${config.agent} with ${mcp}, on http://127.0.0.1:${port}`)
  console.log(`Accepting: ${origins.join(', ')}`)
  if (saveDir) console.log(`Saving threads to ${saveDir}`)
  if (previews) console.log('and preview builds at https://*-marginalia.cloudflare-cdd.workers.dev')
  if (port !== BRIDGE_PORT) console.log(`The hosted app can reach only port ${BRIDGE_PORT}.`)
  if (loaded.created || values['show-token']) {
    console.log(
      `\nIn Rami, open Settings, Local agent, and paste this pairing token:\n\n  ${loaded.token}\n`,
    )
    console.log(`It is saved in ${loaded.file}. Run with --new-token to replace it.`)
  } else {
    console.log('Already paired. Run with --show-token to print the token again.')
  }
}

/**
 * Picks up a token another bridge rotated, so `--new-token` on any port
 * revokes the old one everywhere. A missing or damaged file revokes it too.
 *
 * Reads run one at a time, and an event during a read queues one more, so a
 * slow read of the old file can never land after a newer one.
 */
function followToken(file: string, pairing: Pairing) {
  let reading = false
  let stale = false

  function apply(token: string | null) {
    if (token === pairing.token) return
    if (token) {
      pairing.token = token
      console.log('The pairing token changed; using the new one.')
    } else {
      // An unguessable token nobody holds: every request is refused until a restart.
      pairing.token = randomBytes(32).toString('base64url')
      console.log('The token file is gone; refusing requests. Restart the bridge to pair again.')
    }
  }

  async function reload() {
    if (reading) {
      stale = true
      return
    }
    reading = true
    try {
      do {
        stale = false
        apply(await readToken(file).catch(() => null))
      } while (stale)
    } finally {
      reading = false
    }
  }

  watch(dirname(file), { persistent: false }, () => void reload())
  // Catches a rotation between loading the token and starting to watch.
  void reload()
}

if (import.meta.main) await main()
