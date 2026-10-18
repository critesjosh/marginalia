import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridgeServer } from './agentBridge.ts'

const TOKEN = 'a'.repeat(43)
const APP = 'https://rami.agenticpossible.com'

/** Prints a canned Claude reply. */
const FAKE_CLI = `
process.stdin.resume()
process.stdin.on('end', () => {
  const line = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
  line({ type: 'system', subtype: 'init', tools: [] })
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ahoy.' } } })
  line({ type: 'result', subtype: 'success', is_error: false })
})
`

let server: Server
let port: number
let dir: string
let spawned: number

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  const script = join(dir, 'fake-cli.cjs')
  writeFileSync(script, FAKE_CLI)
  spawned = 0
  server = createBridgeServer({
    config: { agent: 'claude', mcp: ['tavily'], timeoutMs: 10_000 },
    pairing: { token: TOKEN, origins: [APP] },
    port: 0,
    spawn: (_command: string, args: string[], options: SpawnOptions) => {
      spawned++
      return spawn(process.execPath, [script, ...args], options)
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** node:http, because fetch will not let a test set Host. */
function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const auth = { Authorization: `Bearer ${TOKEN}` }
const fromApp = { Origin: APP, 'Sec-Fetch-Site': 'cross-site' }
const chatBody = JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], stream: true })
const json = { 'Content-Type': 'application/json' }

describe('preflight', () => {
  const ask = (origin: string, method = 'POST', headers = 'authorization,content-type') =>
    call('OPTIONS', '/v1/chat', {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': headers,
      'Access-Control-Request-Private-Network': 'true',
    })

  it('lets the paired app send its token and JSON', async () => {
    const reply = await ask(APP)
    expect(reply.status).toBe(204)
    expect(reply.headers['access-control-allow-origin']).toBe(APP)
    expect(reply.headers['access-control-allow-headers']).toMatch(/Authorization/)
    expect(reply.headers['access-control-allow-private-network']).toBe('true')
    expect(reply.headers.vary).toBe('Origin')
  })

  it('refuses other sites, opaque origins, and other methods or headers', async () => {
    for (const reply of [
      await ask('https://evil.example'),
      await ask('null'),
      await ask(APP, 'DELETE'),
      await ask(APP, 'POST', 'authorization,x-other'),
    ]) {
      expect(reply.status).toBe(403)
    }
    expect((await ask('https://evil.example')).headers['access-control-allow-origin']).toBe(
      undefined,
    )
  })
})

describe('status', () => {
  it('reports the agent and its servers to the paired app', async () => {
    const reply = await call('GET', '/v1/status', { ...auth, ...fromApp })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ agent: 'claude', mcp: ['tavily'] })
    expect(reply.headers['access-control-allow-origin']).toBe(APP)
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('needs the token, even from the app, and accepts it from a non-browser client', async () => {
    expect((await call('GET', '/v1/status', fromApp)).status).toBe(401)
    const wrong = { Authorization: `Bearer ${'b'.repeat(43)}`, ...fromApp }
    expect((await call('GET', '/v1/status', wrong)).status).toBe(401)
    expect((await call('GET', '/v1/status', auth)).status).toBe(200)
  })

  it('refuses another site holding the token, and a rebinding or wrong-port Host', async () => {
    const evil = await call('GET', '/v1/status', { ...auth, Origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect(evil.headers['access-control-allow-origin']).toBe(undefined)
    expect((await call('GET', '/v1/status', { ...auth, Origin: 'null' })).status).toBe(403)
    expect(
      (await call('GET', '/v1/status', { ...auth, Host: `rebind.example:${port}` })).status,
    ).toBe(403)
    expect((await call('GET', '/v1/status', { ...auth, Host: '127.0.0.1:1' })).status).toBe(403)
    expect((await call('GET', '/v1/other', auth)).status).toBe(404)
  })
})

describe('chat', () => {
  it('answers the paired app in the SSE the PWA reads', async () => {
    const reply = await call('POST', '/v1/chat', { ...auth, ...fromApp, ...json }, chatBody)
    expect(reply.status).toBe(200)
    expect(reply.headers['access-control-allow-origin']).toBe(APP)
    expect(reply.body).toContain('"content":"Ahoy."')
    expect(reply.body.trim().endsWith('data: [DONE]')).toBe(true)
    expect(spawned).toBe(1)
  })

  it('never starts the agent for a refused request', async () => {
    await call('POST', '/v1/chat', { ...fromApp, ...json }, chatBody)
    await call('POST', '/v1/chat', { ...auth, Origin: 'https://evil.example', ...json }, chatBody)
    await call('POST', '/v1/chat', { ...auth, ...fromApp, 'Content-Type': 'text/plain' }, chatBody)
    await call('GET', '/v1/chat', { ...auth, ...fromApp })
    expect(spawned).toBe(0)
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

describe('command line', () => {
  /** Runs the bridge CLI until it prints `until`, or exits. */
  function run(args: string[], env: Record<string, string>, until: RegExp) {
    return new Promise<{ output: string; exitCode: number | null }>((resolve) => {
      const child = spawn(process.execPath, ['dev/agentBridge.ts', ...args], {
        env: { ...process.env, ...env },
      })
      let output = ''
      const collect = (chunk: Buffer) => {
        output += chunk
        if (until.test(output)) child.kill()
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('exit', (exitCode) => resolve({ output, exitCode }))
    })
  }

  it('revokes the old token in a bridge running on another port', async () => {
    const env = { XDG_CONFIG_HOME: dir }
    const other = await freePort()
    const running = spawn(
      process.execPath,
      ['dev/agentBridge.ts', '--agent', 'claude', '--port', String(other)],
      {
        env: { ...process.env, ...env },
      },
    )
    try {
      await new Promise<void>((resolve) =>
        running.stdout.on('data', (chunk: Buffer) => {
          if (/Rami agent bridge/.test(String(chunk))) resolve()
        }),
      )
      const file = join(dir, 'rami', 'agent-bridge.json')
      const old = JSON.parse(readFileSync(file, 'utf8')).token as string
      await run(
        ['--agent', 'claude', '--port', String(await freePort()), '--new-token'],
        env,
        /Rami agent bridge/,
      )
      const fresh = JSON.parse(readFileSync(file, 'utf8')).token as string
      expect(fresh).not.toBe(old)

      const status = (token: string) =>
        new Promise<number>((resolve, reject) => {
          httpRequest(
            {
              host: '127.0.0.1',
              port: other,
              path: '/v1/status',
              headers: { Authorization: `Bearer ${token}` },
            },
            (res) => {
              res.resume()
              resolve(res.statusCode ?? 0)
            },
          )
            .on('error', reject)
            .end()
        })
      await vi.waitFor(async () => expect(await status(fresh)).toBe(200), { timeout: 5000 })
      expect(await status(old)).toBe(401)
    } finally {
      running.kill()
    }
  })

  it('leaves the token alone when another bridge holds the port', async () => {
    const env = { XDG_CONFIG_HOME: dir }
    const file = join(dir, 'rami', 'agent-bridge.json')
    const args = ['--agent', 'claude', '--port', String(port)]
    // `port` is taken by the server this file starts in beforeEach.
    const first = await run([...args, '--new-token'], env, /Rami agent bridge/)
    expect(first.output).toMatch(/in use.*token is unchanged/)
    expect(first.exitCode).toBe(1)
    const before = readFileSync(file, 'utf8')

    const again = await run([...args, '--new-token'], env, /Rami agent bridge/)
    expect(again.exitCode).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
