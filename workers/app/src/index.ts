import {
  handleBookCover,
  handleBooksRequest,
  loadBookLink,
  withBookPreview,
} from '../../../shared/books.ts'
import { handleCoverRequest } from '../../../shared/covers.ts'
import { handleGutenbergRequest } from '../../../shared/gutenberg.ts'
import { isCrossOrigin } from '../../../shared/http-guards.ts'
import type { LinkStore, PublishOptions } from '../../../shared/publishing.ts'
import { handleRelayRequest } from '../../../shared/relay.ts'
import { operationMetric } from '../../../shared/telemetry.ts'
import { handleTelemetryRegionRequest } from '../../../shared/telemetryRegion.ts'
import { handleThreadPage } from '../../../shared/threadPage.ts'
import { handleThreadsRequest } from '../../../shared/threads.ts'

/** Turnstile's challenge for publishing a thread (docs/decisions/0006). */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * The PostHog ingestion origin the PWA may send telemetry to (decision 0008).
 * Unset, the CSP blocks it even if a build was configured to send.
 */
function telemetryOrigin(value: string | undefined): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '')
      ? ` ${url.origin}`
      : ''
  } catch {
    return ''
  }
}

function contentSecurityPolicy(env: Env): string {
  return (
    `default-src 'self'; script-src 'self' ${TURNSTILE_ORIGIN}; style-src 'self' 'unsafe-inline' blob:; ` +
    "img-src 'self' data: blob: https://www.gutenberg.org; font-src 'self' data: blob:; " +
    `connect-src 'self'${telemetryOrigin(env.TELEMETRY_ORIGIN)}; ` +
    `frame-src 'self' blob: data: ${TURNSTILE_ORIGIN}; object-src 'none'; base-uri 'self'; form-action 'self'`
  )
}

function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', contentSecurityPolicy(env))
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function apiError(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Serves repeat Gutenberg searches from the edge cache, so a query anyone ran
 * recently never waits on upstream. Downloads are left alone: they are large
 * and rarely repeat. Cross-origin requests skip the cache so the relay's own
 * check still turns them away.
 */
async function gutenbergWithCache(request: Request, ctx: ExecutionContext): Promise<Response> {
  const relay = () =>
    handleGutenbergRequest(request, { ip: request.headers.get('CF-Connecting-IP') ?? '' })
  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim().toLowerCase()
  if (request.method !== 'GET' || !search || isCrossOrigin(request)) return relay()

  const key = new Request(`${url.origin}/api/gutenberg?search=${encodeURIComponent(search)}`)
  const cache = await caches.open('gutenberg-search')
  const cached = await cache.match(key)
  if (cached) return cached

  const response = await relay()
  if (response.ok) ctx.waitUntil(cache.put(key, response.clone()))
  return response
}

/**
 * Serves repeat cover searches and images from the edge cache. A cover id
 * always names the same image, and opening the picker for a book fetches the
 * same handful of thumbnails every time.
 */
async function coversWithCache(request: Request, ctx: ExecutionContext): Promise<Response> {
  const relay = () =>
    handleCoverRequest(request, { ip: request.headers.get('CF-Connecting-IP') ?? '' })
  const url = new URL(request.url)
  if (request.method !== 'GET' || isCrossOrigin(request)) return relay()

  // Rebuilt from the known parameters only, so junk ones cannot fan out the cache.
  const key = new URL('/api/covers', url.origin)
  for (const name of ['title', 'author', 'id', 'size']) {
    const value = url.searchParams.get(name)?.trim().toLowerCase()
    if (value) key.searchParams.set(name, value)
  }
  const cache = await caches.open('covers')
  const cached = await cache.match(key)
  if (cached) return cached

  const response = await relay()
  if (response.ok) ctx.waitUntil(cache.put(key, response.clone()))
  return response
}

/** Published threads and book links in Workers KV; see `shared/publishing.ts`. */
function linkStore(env: Env): LinkStore | undefined {
  const kv = env.THREADS
  if (!kv) return undefined
  return {
    get: (id) => kv.get(id),
    put: (id, value, ttlSeconds) => kv.put(id, value, { expirationTtl: ttlSeconds }),
    delete: (id) => kv.delete(id),
  }
}

function publishOptions(env: Env): PublishOptions {
  return {
    store: linkStore(env),
    enabled: env.THREADS_ENABLED !== 'false',
    turnstileSecret: env.TURNSTILE_SECRET_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  }
}

/**
 * `/b/<id>`: the app itself, with the shared book's preview tags added so
 * chat apps can draw a card. The app route then adds the book.
 */
async function bookPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const app = await env.ASSETS.fetch(new Request(new URL('/', url.origin)))
  const id = url.pathname.replace(/^\/b\//, '').replace(/\/$/, '')
  const stored = await loadBookLink(linkStore(env), id)
  if (!stored || !app.ok) return app

  const headers = new Headers(app.headers)
  headers.delete('Content-Length')
  headers.delete('ETag')
  headers.set('Cache-Control', 'no-store')
  return new Response(withBookPreview(await app.text(), stored, url.origin, id), { headers })
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const started = performance.now()

    try {
      if (url.pathname === '/health') {
        return Response.json(
          { status: 'ok', service: 'app' },
          {
            headers: { 'Cache-Control': 'no-store' },
          },
        )
      }
      if (url.pathname === '/api/chat') {
        return await handleRelayRequest(
          request,
          {
            apiKey: env.OPENROUTER_API_KEY,
            siteUrl: url.origin,
            enabled: env.CHAT_ENABLED !== 'false',
          },
          { ip: request.headers.get('CF-Connecting-IP') ?? '' },
        )
      }

      if (url.pathname === '/api/telemetry/region') {
        return handleTelemetryRegionRequest(request, request.cf?.country as string | undefined)
      }

      if (url.pathname === '/api/gutenberg') {
        return await gutenbergWithCache(request, ctx)
      }

      if (url.pathname === '/api/covers') {
        return await coversWithCache(request, ctx)
      }

      if (url.pathname === '/api/threads' || url.pathname.startsWith('/api/threads/')) {
        return await handleThreadsRequest(request, publishOptions(env), {
          ip: request.headers.get('CF-Connecting-IP') ?? '',
        })
      }

      if (url.pathname === '/api/books' || url.pathname.startsWith('/api/books/')) {
        return await handleBooksRequest(request, publishOptions(env), {
          ip: request.headers.get('CF-Connecting-IP') ?? '',
        })
      }

      if (url.pathname.startsWith('/t/')) {
        return withSecurityHeaders(await handleThreadPage(request, linkStore(env)), env)
      }

      if (/^\/b\/[^/]+\/cover$/.test(url.pathname)) {
        return withSecurityHeaders(await handleBookCover(request, linkStore(env)), env)
      }

      if (url.pathname.startsWith('/b/')) {
        return withSecurityHeaders(await bookPage(request, env), env)
      }

      if (url.pathname.startsWith('/api/')) {
        return apiError(404, 'API route not found.')
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request), env)
    } catch {
      console.error(JSON.stringify(operationMetric('app', 500, performance.now() - started)))

      return url.pathname.startsWith('/api/')
        ? apiError(500, 'Internal server error.')
        : withSecurityHeaders(new Response('Internal server error.', { status: 500 }), env)
    }
  },
} satisfies ExportedHandler<Env>

export default worker
