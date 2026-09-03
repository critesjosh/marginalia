import type { IntelligenceEnv, UpstreamCaller } from './intelligence.ts'

/**
 * An authenticated, read-only MCP server over one reader's own intelligence.
 *
 * It lives in the Worker rather than in Databricks for the same reason the
 * Insights routes do: the Worker holds the only credential outside the
 * workspace that may call the App, and it already knows which reader it is
 * acting for. An MCP server anywhere else would need a second copy of that
 * credential and a second answer to the question of whose data it serves.
 *
 * Three rules the shape of this file exists to enforce.
 *
 * 1. No tool takes a user id. Not "ignores one", not "validates one": the
 *    schemas declare `additionalProperties: false` and there is no field to
 *    put one in, so a prompt that names another reader is a prompt that fails
 *    schema validation rather than one that quietly succeeds. The reader comes
 *    from the Worker's own secret.
 * 2. Read-only. There is no write path here at all, and the plan requires a
 *    separate approval, an audit row, a preview, a confirmation, and a
 *    compensating action before there is one.
 * 3. Every call is audited. Tool name, time, row count, and outcome; never the
 *    rows themselves, which are the reader's own material and are already
 *    subject to the same logging rules as everything else.
 *
 * What is deliberately absent: tools over highlights and conversations. The
 * plan's MCP section lists them, and nothing outside the workspace is granted
 * the tables that hold a reader's words. Adding them means a new grant on
 * Silver and a new decision about what may leave the workspace, which is the
 * kind of change the plan says to stop and revise for rather than slip in
 * behind a tool definition.
 */

export const MCP_PATH = '/api/mcp'

/** JSON-RPC 2.0, the subset MCP actually uses over streamable HTTP. */
interface Request_ {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export const PROTOCOL_VERSION = '2025-06-18'

const SERVER = { name: 'marginalia', version: '1.0.0' }

/** The most rows one call may return, however large a limit it asks for. */
export const MAX_PAGE = 100
export const DEFAULT_PAGE = 25

/**
 * The most messages one HTTP request may carry.
 *
 * Authentication and the rate limiter run once per request, so without this a
 * single authorised call could fan out into any number of reads of the App and
 * writes of the audit table. Ten is generous for a client that batches an
 * initialize and a tools/list, and far short of a useful amplifier.
 */
export const MAX_BATCH = 10

/** The most bytes a request body may be, before it is parsed. */
export const MAX_BODY_BYTES = 64 * 1024

const PAGINATION = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE,
    description: `Rows to return. Defaults to ${DEFAULT_PAGE}, capped at ${MAX_PAGE}.`,
  },
  cursor: {
    type: 'string',
    description: 'The nextCursor from a previous call. Omit for the first page.',
  },
} as const

interface ToolDefinition {
  name: string
  title: string
  description: string
  /** The Insights route this reads. Every one is a Gold projection. */
  route: string
  /** Sorting is the App's; this only says what a row is, for the description. */
  grain: string
}

/**
 * Every tool, and the route behind it.
 *
 * Each one reads a projection the App already serves, which is what keeps the
 * MCP surface from being a second, wider door into the same data: a tool here
 * can reach exactly what the Insights page can reach and nothing else.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_interests',
    title: 'Interest profile',
    description:
      'Concepts this reader has shown interest in, strongest first, with how much evidence ' +
      'stands behind each and how many books it came from. Scores are normalised within the ' +
      'reader and mean nothing compared across readers.',
    route: 'interest-profile',
    grain: 'one row per concept',
  },
  {
    name: 'list_book_engagement',
    title: 'Engagement per book',
    description:
      'How much time, attention, and marking each book in the library has had, with the ' +
      'components the engagement score is computed from.',
    route: 'book-engagement',
    grain: 'one row per book',
  },
  {
    name: 'list_recommendations',
    title: 'Recommended books',
    description:
      'Books to read next, ranked, each with the concepts it matched and a deterministic ' +
      'explanation of why it was suggested. The explanation is a stored column, not prose ' +
      'written about the score afterwards.',
    route: 'recommendations',
    grain: 'one row per candidate work',
  },
  {
    name: 'list_frontier',
    title: 'Intellectual frontier',
    description:
      'Concepts adjacent to what this reader has established but with no direct evidence of ' +
      'their own, and the works and established concepts that make them adjacent.',
    route: 'frontier',
    grain: 'one row per candidate concept',
  },
]

export function toolSchemas() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: `${tool.description} Grain: ${tool.grain}.`,
    inputSchema: {
      type: 'object',
      properties: { ...PAGINATION },
      // No user field, and none may be added by a caller. This is the whole of
      // the scope isolation: there is nowhere to put another reader's id.
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object' } },
        sourceUpdatedAt: {
          type: 'string',
          description: 'When the cloud last recomputed this, not when it was asked for.',
        },
        nextCursor: { type: 'string' },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }))
}

/**
 * A cursor is an offset, said out loud.
 *
 * Opaque to the caller because it is an implementation detail, and readable by
 * us because a debugging session over an encrypted cursor is a debugging
 * session about the cursor. It carries no reader id: it is a position in a
 * result set that is already scoped to one reader by the time it exists.
 */
export function encodeCursor(offset: number): string {
  return btoa(`offset:${offset}`)
}

export function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return 0
  try {
    const decoded = atob(cursor)
    const match = /^offset:(\d+)$/.exec(decoded)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

export function pageOf<T>(rows: T[], limit: unknown, cursor: unknown) {
  const size = Math.min(
    Math.max(1, Math.trunc(typeof limit === 'number' ? limit : DEFAULT_PAGE)),
    MAX_PAGE,
  )
  const offset = decodeCursor(cursor)
  const page = rows.slice(offset, offset + size)
  const next = offset + size < rows.length ? encodeCursor(offset + size) : undefined
  return { page, next }
}

function rpcError(id: Request_['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

function rpcResult(id: Request_['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

export interface AuditEntry {
  tool: string
  at: string
  rows: number
  ok: boolean
  detail?: string
}

/**
 * One tool call, against the App route behind it.
 *
 * Errors come back as tool results with `isError` rather than as JSON-RPC
 * errors, which is what the protocol asks for: a model that asked for
 * something unavailable should be told so in a form it can reason about, not
 * handed a transport failure.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  read: (route: string) => Promise<Response>,
): Promise<{ result: unknown; audit: Omit<AuditEntry, 'at'> }> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) {
    return {
      result: { content: [{ type: 'text', text: `No tool named ${name}.` }], isError: true },
      audit: { tool: name, rows: 0, ok: false, detail: 'unknown_tool' },
    }
  }

  for (const key of Object.keys(args)) {
    if (key !== 'limit' && key !== 'cursor') {
      // The key is not echoed anywhere it could be stored. A caller who put a
      // reader's sentence in an argument name would otherwise have found a
      // free-text column in an operational table.
      // Including, and especially, anything that looks like a reader id.
      return {
        result: {
          content: [
            {
              type: 'text',
              text:
                `This tool takes only limit and cursor. It always answers for the reader ` +
                `this server is authenticated as, and cannot be pointed at another.`,
            },
          ],
          isError: true,
        },
        audit: { tool: name, rows: 0, ok: false, detail: 'unexpected_argument' },
      }
    }
  }

  let response: Response
  try {
    response = await read(tool.route)
  } catch (error) {
    // A rejected fetch, a timeout, a DNS failure. Without this the whole
    // request becomes a 500 and a batch loses every other reply in it, which
    // is a transport failure standing in for one tool being unavailable.
    return {
      result: {
        content: [{ type: 'text', text: 'That is not reachable right now.' }],
        isError: true,
      },
      audit: {
        tool: name,
        rows: 0,
        ok: false,
        detail: `upstream_unreachable`,
      },
    }
  }
  if (!response.ok) {
    return {
      result: {
        content: [{ type: 'text', text: `That is not available right now (${response.status}).` }],
        isError: true,
      },
      audit: { tool: name, rows: 0, ok: false, detail: `upstream_${response.status}` },
    }
  }

  const body = (await response.json()) as { rows?: unknown[]; sourceUpdatedAt?: string }
  const rows = Array.isArray(body.rows) ? body.rows : []
  const { page, next } = pageOf(rows, args.limit, args.cursor)

  const structured = {
    rows: page,
    ...(body.sourceUpdatedAt ? { sourceUpdatedAt: body.sourceUpdatedAt } : {}),
    ...(next ? { nextCursor: next } : {}),
  }
  return {
    result: {
      // Both forms. structuredContent is what a client should read; the text is
      // for one that cannot, and is the same data rather than a summary of it.
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: false,
    },
    audit: { tool: name, rows: page.length, ok: true },
  }
}

export interface McpOptions {
  read: (route: string) => Promise<Response>
  audit?: (entry: AuditEntry) => Promise<void>
  /** Charges the rate limiter for one tool call. False means refused. */
  charge?: () => Promise<boolean>
  now?: () => Date
}

/** One JSON-RPC message. Returns null for a notification, which has no reply. */
export async function handleMessage(
  message: Request_,
  options: McpOptions,
): Promise<object | null> {
  const { id } = message
  const method = message.method
  // Every field here came off the wire. A missing or non-string method used to
  // throw on startsWith, which turned a malformed message into a 500 for the
  // whole request.
  if (typeof method !== 'string' || !method) {
    return rpcError(id ?? null, -32600, 'A JSON-RPC method is required.')
  }
  const now = options.now ?? (() => new Date())

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions:
        'Read-only access to one reader’s own reading intelligence. Every tool answers ' +
        'for the reader this server is authenticated as; none accepts a user id, and there ' +
        'is no way to ask about anybody else. Nothing here returns the text of highlights, ' +
        'notes, or conversations.',
    })
  }

  // Notifications carry no id and expect no reply.
  if (method.startsWith('notifications/')) return null
  if (method === 'ping') return rpcResult(id, {})

  if (method === 'tools/list') return rpcResult(id, { tools: toolSchemas() })

  if (method === 'tools/call') {
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof params.name !== 'string') return rpcError(id, -32602, 'A tool name is required.')
    const args =
      params.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {}

    // One charge per tool call, not per HTTP request. Authentication and the
    // limiter run once at the door; a batch of ten reads would otherwise cost
    // one charge and ten reads of the App.
    if (options.charge && !(await options.charge())) {
      return rpcResult(id, {
        content: [{ type: 'text', text: 'Too many calls. Try again shortly.' }],
        isError: true,
      })
    }

    const { result, audit } = await callTool(params.name, args, options.read)
    if (options.audit) {
      try {
        // Never the rows. Which tool, when, how many, and whether it worked.
        await options.audit({ ...audit, at: now().toISOString() })
      } catch (error) {
        // An audit that could not be written is worth knowing about and is not
        // worth failing the reader's own read over. Logged by the caller; here
        // it must simply not become a 500.
        console.error(
          JSON.stringify({
            message: 'MCP audit threw',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
    return rpcResult(id, result)
  }

  return rpcError(id, -32601, `Unsupported method ${method}.`)
}

export async function handleMcpRequest(
  request: Request,
  options: McpOptions,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: { message: 'This endpoint speaks JSON-RPC over POST.' } },
      { status: 405, headers: { 'Cache-Control': 'no-store', allow: 'POST' } },
    )
  }

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    return Response.json(rpcError(null, -32600, 'That request is too large.'), {
      status: 413,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  let body: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      // Checked again after reading: a missing or lying content-length is not
      // a reason to parse an unbounded body.
      return Response.json(rpcError(null, -32600, 'That request is too large.'), {
        status: 413,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    body = JSON.parse(text)
  } catch {
    return Response.json(rpcError(null, -32700, 'Invalid JSON.'), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  // A batch is an array. Notifications inside it produce no reply, and a batch
  // of only notifications produces no response body at all.
  const messages = Array.isArray(body) ? body : [body]
  if (messages.length === 0) {
    // An empty array is a malformed batch, not a batch of notifications, and
    // answering 202 would tell the client its messages were accepted.
    return Response.json(rpcError(null, -32600, 'A batch carries at least one message.'), {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (messages.length > MAX_BATCH) {
    return Response.json(
      rpcError(null, -32600, `A batch may carry at most ${MAX_BATCH} messages.`),
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const replies: object[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      replies.push(rpcError(null, -32600, 'Not a JSON-RPC message.'))
      continue
    }
    const reply = await handleMessage(message as Request_, options)
    if (reply) replies.push(reply)
  }

  if (replies.length === 0) return new Response(null, { status: 202 })
  return Response.json(Array.isArray(body) ? replies : replies[0], {
    headers: { 'Cache-Control': 'no-store' },
  })
}

/**
 * The MCP endpoint, authenticated exactly as the Insights routes are.
 *
 * The same token, the same rate limiter, and the same disabled check: an MCP
 * client is another caller on the reader's behalf, not a second kind of
 * principal, and a reader who has asked for deletion is not readable through a
 * different door.
 */
export async function handleMcpEndpoint(
  request: Request,
  env: IntelligenceEnv,
  options: {
    authorize: (request: Request, env: IntelligenceEnv) => Promise<{ userId: string } | Response>
    disabled: (env: IntelligenceEnv, userId: string) => Promise<boolean>
    caller: (env: IntelligenceEnv, now: number) => UpstreamCaller
    /** Charges the rate limiter once per tool call. */
    charge?: () => Promise<boolean>
    now?: number
  },
): Promise<Response> {
  const now = options.now ?? Date.now()

  const authorized = await options.authorize(request, env)
  if (authorized instanceof Response) return authorized
  const { userId } = authorized

  if (await options.disabled(env, userId)) {
    return Response.json(
      { error: { message: 'This reader’s cloud data is disabled.' } },
      { status: 423, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const upstream = options.caller(env, now)
  const base = `/api/v1/users/${encodeURIComponent(userId)}`

  return await handleMcpRequest(request, {
    // One charge per tool call. Authentication and the door's own limit run
    // once per request, and a batch is many reads behind one of them.
    charge:
      options.charge ??
      (async () => {
        if (!env.INTELLIGENCE_RATE_LIMITER) return true
        const address = request.headers.get('CF-Connecting-IP') ?? 'unknown'
        const { success } = await env.INTELLIGENCE_RATE_LIMITER.limit({ key: `mcp:${address}` })
        return success
      }),
    // The reader is closed over here, before any tool runs. Nothing a tool
    // receives can change which path this builds.
    read: (route) => upstream(`${base}/${route}`, { method: 'GET' }),
    audit: async (entry) => {
      const response = await upstream(`${base}/mcp-audit`, {
        method: 'POST',
        body: JSON.stringify(entry),
      })
      if (!response.ok) {
        // An audit that cannot be written is worth knowing about, and is not
        // worth failing the reader's own request over: the alternative to an
        // unrecorded read is a reader who cannot read their own profile.
        console.error(
          JSON.stringify({ message: 'MCP audit write failed', status: response.status }),
        )
      }
    },
  })
}

export type { IntelligenceEnv, UpstreamCaller }
