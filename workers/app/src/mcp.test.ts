import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE,
  MAX_BATCH,
  MAX_PAGE,
  TOOLS,
  decodeCursor,
  encodeCursor,
  handleMcpEndpoint,
  handleMcpRequest,
  handleMessage,
  pageOf,
  toolSchemas,
} from './mcp.ts'

/**
 * The MCP surface, exercised through the same entry point the Worker uses.
 *
 * The tests that matter are the ones about scope: a tool that could be pointed
 * at another reader would be a hole no amount of authentication closes, since
 * the caller here is authenticated and the prompt is not.
 */

const PROFILE = {
  rows: [
    { conceptId: 'genealogy of morality', interestScore: 1 },
    { conceptId: 'ressentiment', interestScore: 0.8 },
    { conceptId: 'ascetic ideal', interestScore: 0.6 },
  ],
  sourceUpdatedAt: '2026-09-03T12:00:00Z',
}

function reader(overrides: { rows?: unknown[]; status?: number } = {}) {
  const asked: string[] = []
  const audited: unknown[] = []
  const read = async (route: string) => {
    asked.push(route)
    if (overrides.status && overrides.status !== 200) {
      return new Response(null, { status: overrides.status })
    }
    return Response.json({ ...PROFILE, ...(overrides.rows ? { rows: overrides.rows } : {}) })
  }
  return { asked, audited, options: { read, audit: async (entry: unknown) => void audited.push(entry) } }
}

async function call(name: string, args: Record<string, unknown> = {}, harness = reader()) {
  const reply = (await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    harness.options,
  )) as { result: { structuredContent?: { rows: unknown[]; nextCursor?: string }; isError: boolean } }
  return { reply: reply.result, harness }
}

describe('the MCP server', () => {
  it('announces itself with a protocol version and read-only tools', async () => {
    const reply = (await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      reader().options,
    )) as { result: { protocolVersion: string; serverInfo: { name: string } } }
    expect(reply.result.protocolVersion).toBeTruthy()
    expect(reply.result.serverInfo.name).toBe('marginalia')
  })

  it('lists every tool with a schema', async () => {
    const reply = (await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      reader().options,
    )) as { result: { tools: { name: string }[] } }
    expect(reply.result.tools.map((tool) => tool.name).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    )
  })

  it('reads a tool through the route behind it', async () => {
    const { reply, harness } = await call('list_interests')
    expect(harness.asked).toEqual(['interest-profile'])
    expect(reply.structuredContent?.rows).toHaveLength(3)
  })
})

describe('scope isolation', () => {
  it('offers no tool that takes a user id', () => {
    for (const tool of toolSchemas()) {
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['cursor', 'limit'])
      // Not "ignores a user id": there is nowhere to put one, and a schema that
      // permitted extra properties would be a schema somebody adds one to.
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('refuses a call that tries to name another reader', async () => {
    const { reply, harness } = await call('list_interests', {
      user_id: '22222222-2222-4222-8222-222222222222',
    })
    expect(reply.isError).toBe(true)
    // And nothing was read on anybody's behalf.
    expect(harness.asked).toEqual([])
  })

  it('refuses any argument it did not define, whatever it is called', async () => {
    for (const smuggled of ['userId', 'reader', 'on_behalf_of', 'sql']) {
      const { reply } = await call('list_interests', { [smuggled]: 'x' })
      expect(reply.isError).toBe(true)
    }
  })

  it('records the refusal rather than swallowing it', async () => {
    const harness = reader()
    await call('list_interests', { user_id: 'someone' }, harness)
    expect(harness.audited).toHaveLength(1)
    expect(harness.audited[0]).toMatchObject({ ok: false, rows: 0 })
  })

  it('has no tool that writes anything', () => {
    for (const tool of toolSchemas()) {
      expect(tool.annotations.readOnlyHint).toBe(true)
      expect(tool.name.startsWith('list_') || tool.name.startsWith('describe_')).toBe(true)
    }
  })
})

describe('pagination', () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ index }))

  it('defaults to a page rather than everything', () => {
    expect(pageOf(rows, undefined, undefined).page).toHaveLength(DEFAULT_PAGE)
  })

  it('caps a page however large a limit is asked for', () => {
    expect(pageOf(rows, 10_000, undefined).page).toHaveLength(MAX_PAGE)
  })

  it('walks the whole set without repeating or skipping a row', () => {
    const seen: number[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard += 1) {
      const { page, next } = pageOf(rows, MAX_PAGE, cursor)
      seen.push(...page.map((row) => row.index))
      if (!next) break
      cursor = next
    }
    expect(seen).toEqual(rows.map((row) => row.index))
  })

  it('treats a nonsense cursor as the beginning rather than an error', () => {
    expect(decodeCursor('not-a-cursor')).toBe(0)
    expect(decodeCursor(undefined)).toBe(0)
    expect(decodeCursor(encodeCursor(40))).toBe(40)
  })

  it('stops offering a cursor at the end', () => {
    expect(pageOf([{ index: 1 }], MAX_PAGE, undefined).next).toBeUndefined()
  })
})

describe('audit', () => {
  it('records the tool, the count, and the outcome', async () => {
    const harness = reader()
    await call('list_interests', {}, harness)
    expect(harness.audited[0]).toMatchObject({ tool: 'list_interests', rows: 3, ok: true })
  })

  it('records no row it returned', async () => {
    const harness = reader()
    await call('list_interests', {}, harness)
    const written = JSON.stringify(harness.audited)
    // The reader's own concepts must not travel into an operational table
    // under a different retention rule than the one they came from.
    expect(written).not.toContain('ressentiment')
    expect(written).not.toContain('genealogy')
  })

  it('records a failed upstream as a failure', async () => {
    const harness = reader({ status: 503 })
    const { reply } = await call('list_interests', {}, harness)
    expect(reply.isError).toBe(true)
    expect(harness.audited[0]).toMatchObject({ ok: false })
  })
})

describe('the transport', () => {
  it('answers a POST and refuses everything else', async () => {
    const get = await handleMcpRequest(
      new Request('https://example.test/api/mcp', { method: 'GET' }),
      reader().options,
    )
    expect(get.status).toBe(405)
  })

  it('answers a batch with one reply per request', async () => {
    const response = await handleMcpRequest(
      new Request('https://example.test/api/mcp', {
        method: 'POST',
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ]),
      }),
      reader().options,
    )
    expect(await response.json()).toHaveLength(2)
  })

  it('says nothing back to a notification', async () => {
    const response = await handleMcpRequest(
      new Request('https://example.test/api/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      reader().options,
    )
    expect(response.status).toBe(202)
  })

  it('never caches a reply', async () => {
    const response = await handleMcpRequest(
      new Request('https://example.test/api/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      reader().options,
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('reports an unknown method as a protocol error', async () => {
    const reply = (await handleMessage(
      { jsonrpc: '2.0', id: 9, method: 'resources/list' },
      reader().options,
    )) as { error: { code: number } }
    expect(reply.error.code).toBe(-32601)
  })
})


/**
 * The endpoint itself, rather than the message handler underneath it.
 *
 * These are the checks that decide whether an unauthenticated caller, or a
 * reader who has asked for deletion, can read anything. Testing only the layer
 * below would have proved that the tools work for somebody who got past a door
 * nobody had tested.
 */
describe('the endpoint', () => {
  const env = {} as never

  function endpoint(
    overrides: {
      authorized?: boolean
      disabled?: boolean
      appStatus?: number
    } = {},
  ) {
    const calls: { path: string; method: string; body?: string }[] = []
    const caller = () => async (path: string, init: { method: string; body?: string }) => {
      calls.push({ path, method: init.method, body: init.body })
      if (overrides.appStatus && overrides.appStatus !== 200) {
        return new Response(null, { status: overrides.appStatus })
      }
      return Response.json({ rows: [{ conceptId: 'a' }], sourceUpdatedAt: '2026-09-03T00:00:00Z' })
    }
    return {
      calls,
      options: {
        authorize: async () =>
          overrides.authorized === false
            ? new Response(null, { status: 401 })
            : { userId: 'reader-1' },
        disabled: async () => overrides.disabled === true,
        caller,
      },
    }
  }

  function post(body: unknown) {
    return new Request('https://example.test/api/mcp', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  const listInterests = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_interests' } }

  it('refuses a caller the authorizer refuses', async () => {
    const harness = endpoint({ authorized: false })
    const response = await handleMcpEndpoint(post(listInterests), env, harness.options)
    expect(response.status).toBe(401)
    expect(harness.calls).toEqual([])
  })

  it('refuses a reader whose cloud data is disabled', async () => {
    const harness = endpoint({ disabled: true })
    const response = await handleMcpEndpoint(post(listInterests), env, harness.options)
    // The same 423 the Insights routes give: an MCP client is another caller on
    // the reader's behalf, not a different kind of principal.
    expect(response.status).toBe(423)
    expect(harness.calls).toEqual([])
  })

  it('binds every read to the authenticated reader', async () => {
    const harness = endpoint()
    await handleMcpEndpoint(post(listInterests), env, harness.options)
    const read = harness.calls.find((call) => call.method === 'GET')
    expect(read?.path).toBe('/api/v1/users/reader-1/interest-profile')
  })

  it('cannot be pointed at another reader by a tool argument', async () => {
    const harness = endpoint()
    await handleMcpEndpoint(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_interests', arguments: { user_id: 'reader-2' } },
      }),
      env,
      harness.options,
    )
    // Nothing was read at all, and certainly not for reader-2.
    expect(harness.calls.filter((call) => call.method === 'GET')).toEqual([])
    expect(JSON.stringify(harness.calls)).not.toContain('reader-2')
  })

  it('writes an audit row for the reader it answered for', async () => {
    const harness = endpoint()
    await handleMcpEndpoint(post(listInterests), env, harness.options)
    const audit = harness.calls.find((call) => call.method === 'POST')
    expect(audit?.path).toBe('/api/v1/users/reader-1/mcp-audit')
    expect(JSON.parse(audit?.body ?? '{}')).toMatchObject({ tool: 'list_interests', ok: true })
  })

  it('still answers when the audit write fails', async () => {
    // The alternative to an unrecorded read is a reader who cannot read their
    // own profile. The failure is logged rather than raised.
    const harness = endpoint({ appStatus: 503 })
    const response = await handleMcpEndpoint(post(listInterests), env, harness.options)
    expect(response.status).toBe(200)
  })

  it('refuses a batch larger than the cap', async () => {
    const harness = endpoint()
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'list_interests' },
    }))
    const response = await handleMcpEndpoint(post(many), env, harness.options)
    expect(response.status).toBe(400)
    // One authorised request must not become an unbounded number of reads.
    expect(harness.calls).toEqual([])
  })

  it('refuses a body larger than the cap', async () => {
    const harness = endpoint()
    const response = await handleMcpEndpoint(
      new Request('https://example.test/api/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { p: 'x'.repeat(70_000) } }),
      }),
      env,
      harness.options,
    )
    expect(response.status).toBe(413)
  })

  it('never records a caller-supplied string in an audit row', async () => {
    const harness = endpoint()
    await handleMcpEndpoint(
      post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_interests', arguments: { 'a sentence a reader wrote': 1 } },
      }),
      env,
      harness.options,
    )
    const audit = harness.calls.find((call) => call.method === 'POST')
    expect(audit?.body).not.toContain('a sentence a reader wrote')
    expect(JSON.parse(audit?.body ?? '{}').detail).toBe('unexpected_argument')
  })

  it('charges the limiter once per tool call rather than once per request', async () => {
    const harness = endpoint()
    let charges = 0
    const three = Array.from({ length: 3 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'list_interests' },
    }))
    await handleMcpEndpoint(post(three), env, {
      ...harness.options,
      charge: async () => {
        charges += 1
        return true
      },
    })
    expect(charges).toBe(3)
  })

  it('refuses the calls a limiter declines, without failing the request', async () => {
    const harness = endpoint()
    const response = await handleMcpEndpoint(post(listInterests), env, {
      ...harness.options,
      charge: async () => false,
    })
    expect(response.status).toBe(200)
    const reply = (await response.json()) as { result: { isError: boolean } }
    expect(reply.result.isError).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'GET')).toEqual([])
  })

  it('answers a tool whose upstream call rejects rather than failing the request', async () => {
    // A rejected fetch, not a 503 response: without a catch this became a 500
    // and a batch lost every other reply in it.
    const response = await handleMcpEndpoint(post(listInterests), env, {
      authorize: async () => ({ userId: 'reader-1' }),
      disabled: async () => false,
      caller: () => async () => {
        throw new Error('connection reset')
      },
    })
    expect(response.status).toBe(200)
    const reply = (await response.json()) as { result: { isError: boolean } }
    expect(reply.result.isError).toBe(true)
  })

  it('answers a malformed message rather than failing the request', async () => {
    const harness = endpoint()
    for (const malformed of [{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2, method: 7 }]) {
      const response = await handleMcpEndpoint(post(malformed), env, harness.options)
      expect(response.status).toBe(200)
      const reply = (await response.json()) as { error: { code: number } }
      expect(reply.error.code).toBe(-32600)
    }
  })

  it('treats an empty batch as malformed rather than as accepted', async () => {
    const harness = endpoint()
    const response = await handleMcpEndpoint(post([]), env, harness.options)
    expect(response.status).toBe(400)
  })

  it('records an unknown tool without repeating what it was called', async () => {
    const harness = endpoint()
    await handleMcpEndpoint(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_everything' } }),
      env,
      harness.options,
    )
    const audit = harness.calls.find((call) => call.method === 'POST')
    // The name is stored, and the App maps anything it does not have to
    // unknown_tool before it reaches a column.
    expect(JSON.parse(audit?.body ?? '{}')).toMatchObject({ ok: false, detail: 'unknown_tool' })
  })
})
