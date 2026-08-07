const BOOK_PREFIX = 'twilight-of-the-idols'
const AUDIO_KEY = `${BOOK_PREFIX}/audiobook.opus`
const METADATA_KEY = `${BOOK_PREFIX}/metadata.json`
const PUBLIC_OBJECTS = new Set([AUDIO_KEY, METADATA_KEY])
const encoder = new TextEncoder()

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS)

    try {
      const url = new URL(request.url)

      if (origin && !cors) return errorResponse('Origin not allowed.', 403)
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors ?? undefined })
      }

      if (url.pathname === '/session') {
        if (!origin) return errorResponse('Origin required.', 403)
        if (request.method !== 'POST') return methodNotAllowed('POST', cors)
        return await createSession(request, env, cors)
      }

      if (url.pathname.startsWith('/objects/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return methodNotAllowed('GET, HEAD', cors)
        }
        return await serveObject(request, env, url, cors)
      }

      return errorResponse('Not found.', 404, cors)
    } catch {
      return errorResponse('Internal server error.', 500, cors)
    }
  },
} satisfies ExportedHandler<Env>

async function createSession(
  request: Request,
  env: Env,
  cors: Headers | null,
): Promise<Response> {
  const rateLimit = await env.SESSION_RATE_LIMITER.limit({ key: 'personal-session' })
  if (!rateLimit.success) return errorResponse('Too many attempts.', 429, cors)

  const authorization = request.headers.get('Authorization')
  const prefix = 'Bearer '
  const supplied = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : ''

  if (!supplied || !(await constantTimeEqual(supplied, env.ACCESS_TOKEN))) {
    return errorResponse('Invalid access token.', 401, cors)
  }

  const ttl = Number.parseInt(env.SIGNED_URL_TTL_SECONDS, 10)
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 172800) {
    return errorResponse('Server configuration error.', 500, cors)
  }

  const requestUrl = new URL(request.url)
  const expires = Math.floor(Date.now() / 1000) + ttl
  const audioUrl = await signedObjectUrl(requestUrl.origin, AUDIO_KEY, expires, env.SIGNING_KEY)
  const metadataUrl = await signedObjectUrl(
    requestUrl.origin,
    METADATA_KEY,
    expires,
    env.SIGNING_KEY,
  )

  const headers = new Headers(cors ?? undefined)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return Response.json({ audioUrl, metadataUrl, expiresAt: expires * 1000 }, { headers })
}

async function serveObject(
  request: Request,
  env: Env,
  url: URL,
  cors: Headers | null,
): Promise<Response> {
  let key: string
  try {
    key = decodeURIComponent(url.pathname.slice('/objects/'.length))
  } catch {
    return errorResponse('Invalid object path.', 400, cors)
  }
  if (!PUBLIC_OBJECTS.has(key)) return errorResponse('Not found.', 404, cors)

  const expires = Number.parseInt(url.searchParams.get('expires') ?? '', 10)
  const signature = url.searchParams.get('signature') ?? ''
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(expires) || expires <= now || !signature) {
    return errorResponse('Link expired or invalid.', 401, cors)
  }

  const expected = await sign(key, expires, env.SIGNING_KEY)
  if (!(await constantTimeEqual(signature, expected))) {
    return errorResponse('Link expired or invalid.', 401, cors)
  }

  if (request.method === 'HEAD') {
    const object = await env.AUDIOBOOKS.head(key)
    if (!object) return errorResponse('Not found.', 404, cors)
    return objectResponse(object, null, 200, cors)
  }

  const rangeHeader = request.headers.get('Range')
  if (rangeHeader) {
    const head = await env.AUDIOBOOKS.head(key)
    if (!head) return errorResponse('Not found.', 404, cors)
    const range = parseByteRange(rangeHeader, head.size)
    if (!range) return rangeNotSatisfiable(head.size, cors)

    const object = await env.AUDIOBOOKS.get(key, { range })
    if (!object) return rangeNotSatisfiable(head.size, cors)
    return objectResponse(object, object.body, 206, cors, range)
  }

  const object = await env.AUDIOBOOKS.get(key)
  if (!object) return errorResponse('Not found.', 404, cors)
  return objectResponse(object, object.body, 200, cors)
}

function objectResponse(
  object: R2Object,
  body: ReadableStream | null,
  status: number,
  cors: Headers | null,
  range?: { offset: number; length: number },
): Response {
  const headers = new Headers(cors ?? undefined)
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', 'private, max-age=3600')

  if (status === 206 && range) {
    headers.set('Content-Length', String(range.length))
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    )
  } else {
    headers.set('Content-Length', String(object.size))
  }

  return new Response(body, { status, headers })
}

function parseByteRange(header: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  if (!match[1]) {
    if (size === 0) return null
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }

  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return null
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return null
  const end = Math.min(requestedEnd, size - 1)
  return { offset, length: end - offset + 1 }
}

function rangeNotSatisfiable(size: number, cors: Headers | null): Response {
  const headers = new Headers(cors ?? undefined)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Range', `bytes */${size}`)
  headers.set('Cache-Control', 'no-store')
  return new Response(null, { status: 416, headers })
}

async function signedObjectUrl(
  workerOrigin: string,
  key: string,
  expires: number,
  signingKey: string,
): Promise<string> {
  const url = new URL(`/objects/${key}`, workerOrigin)
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('signature', await sign(key, expires, signingKey))
  return url.toString()
}

async function sign(key: string, expires: number, secret: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`${key}\n${expires}`))
  return base64Url(signature)
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  return crypto.subtle.timingSafeEqual(leftHash, rightHash)
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function corsHeaders(origin: string | null, allowed: string): Headers | null {
  if (!origin) return new Headers({ Vary: 'Origin' })
  const allowedOrigins = new Set(allowed.split(',').map((value) => value.trim()))
  if (!allowedOrigins.has(origin)) return null

  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    Vary: 'Origin',
  })
}

function errorResponse(message: string, status: number, headers?: Headers | null): Response {
  const responseHeaders = new Headers(headers ?? undefined)
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8')
  responseHeaders.set('Cache-Control', 'no-store')
  return Response.json({ error: message }, { status, headers: responseHeaders })
}

function methodNotAllowed(allow: string, cors: Headers | null): Response {
  const headers = new Headers(cors ?? undefined)
  headers.set('Allow', allow)
  return errorResponse('Method not allowed.', 405, headers)
}
