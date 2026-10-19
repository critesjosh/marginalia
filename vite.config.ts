import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { Readable } from 'node:stream'
import { handleRelayRequest } from './shared/relay.ts'
import { createAgentChat } from './dev/agentChat.ts'
import { readAgentConfig } from './dev/agentCli.ts'
import { handleGutenbergRequest } from './shared/gutenberg.ts'
import { handleCoverRequest } from './shared/covers.ts'
import { handleThreadPage } from './shared/threadPage.ts'
import { handleThreadsRequest } from './shared/threads.ts'
import { handleBookCover, handleBooksRequest } from './shared/books.ts'
import { handleTelemetryRequest, type TelemetryRelayOptions } from './shared/telemetryRelay.ts'
import { memoryLinkStore, type PublishOptions } from './shared/publishing.ts'
import { visualizer } from 'rollup-plugin-visualizer'
import { execFileSync } from 'node:child_process'

type ChatHandler = (
  request: Request,
  context: { ip: string; signal: AbortSignal },
) => Promise<Response>

/**
 * Serves /api/chat in dev. By default that is the handler the Cloudflare
 * Worker uses, so local runs exercise the real relay instead of a stand-in; it
 * reads OPENROUTER_API_KEY from .env.local, and the deployed Worker has it as a
 * secret. CHAT_AGENT swaps in a local agent CLI instead (decision 0009).
 */
function chatRelay(handle: ChatHandler): Plugin {
  return {
    name: 'marginalia-chat-relay',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += (chunk as Buffer).length
          if (bytes > 600_000) {
            res.statusCode = 413
            res.end('Request body too large.')
            return
          }
          chunks.push(chunk as Buffer)
        }

        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }

        const origin = `http://${req.headers.host ?? 'localhost'}`
        const request = new Request(new URL('/api/chat', origin), {
          method: req.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        })

        // Stops a local agent run when the reader closes the reply.
        const closed = new AbortController()
        res.on('close', () => closed.abort())
        const response = await handle(request, {
          ip: req.socket.remoteAddress ?? '',
          signal: closed.signal,
        })

        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        if (response.body) {
          Readable.fromWeb(response.body).pipe(res)
        } else {
          res.end()
        }
      })
    },
  }
}

/**
 * Serves a GET-only relay in dev with its production handler, URL validation
 * included. Used for the Gutenberg catalog and the cover search.
 */
function getRelay(
  path: string,
  handle: (request: Request, options: { ip: string }) => Promise<Response>,
): Plugin {
  return {
    name: `marginalia-relay${path.replaceAll('/', '-')}`,
    configureServer(server) {
      server.middlewares.use(path, async (req, res) => {
        const origin = `http://${req.headers.host ?? 'localhost'}`
        const requestUrl = new URL(req.url ?? '', new URL(path, origin))
        requestUrl.pathname = path

        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }

        const response = await handle(new Request(requestUrl, { method: req.method, headers }), {
          ip: req.socket.remoteAddress ?? '',
        })

        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        if (response.body) Readable.fromWeb(response.body).pipe(res)
        else res.end()
      })
    },
  }
}

/**
 * Serves published threads and book links in dev with the production handlers
 * and an in-memory store, so links last until the dev server restarts.
 * Turnstile defaults to Cloudflare's always-pass test keys. A `/b/<id>` page
 * falls through to the app; only the Worker adds its preview tags.
 */
function publishing(options: Omit<PublishOptions, 'store'>): Plugin {
  const store = memoryLinkStore()
  return {
    name: 'marginalia-publishing',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        const threadsApi = path === '/api/threads' || path.startsWith('/api/threads/')
        const booksApi = path === '/api/books' || path.startsWith('/api/books/')
        const cover = /^\/b\/[^/]+\/cover$/.test(path)
        if (!threadsApi && !booksApi && !cover && !path.startsWith('/t/')) return next()

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }
        const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host}`), {
          method: req.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        })

        const ip = req.socket.remoteAddress ?? ''
        let response: Response
        if (threadsApi)
          response = await handleThreadsRequest(request, { ...options, store }, { ip })
        else if (booksApi)
          response = await handleBooksRequest(request, { ...options, store }, { ip })
        else if (cover) response = await handleBookCover(request, store)
        else response = await handleThreadPage(request, store)

        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}

/**
 * Serves /api/telemetry/* in dev with the production relay. Dev has no
 * Cloudflare country, so TELEMETRY_DEV_COUNTRY stands in for it.
 */
function telemetryRelay(options: TelemetryRelayOptions, country: string | undefined): Plugin {
  return {
    name: 'marginalia-telemetry-relay',
    configureServer(server) {
      server.middlewares.use('/api/telemetry', async (req, res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += (chunk as Buffer).length
          // Same limit as the relay's own, which then sees only bounded bodies.
          if (bytes > 64 * 1024) {
            res.statusCode = 413
            res.end('Request body too large.')
            return
          }
          chunks.push(chunk as Buffer)
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }
        const request = new Request(new URL(req.originalUrl ?? '/', `http://${req.headers.host}`), {
          method: req.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        })

        const response = await handleTelemetryRequest(request, options, {
          ip: req.socket.remoteAddress ?? '',
          country,
        })
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/**
 * Names the commit a build came from, so a cached PWA can show which version
 * it is running. Falls back to Workers Builds' variable when there is no .git,
 * and marks builds with uncommitted changes as dirty.
 */
function buildCommit(): string {
  try {
    const sha = git('rev-parse', '--short', 'HEAD')
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 7) ?? ''
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const agent = readAgentConfig(env)
  const remoteRelay = agent ? undefined : env.CHAT_RELAY_URL?.trim()
  const apiKey = env.OPENROUTER_API_KEY ?? ''
  const chatEnabled = env.CHAT_ENABLED !== 'false'
  if (agent && mode === 'development') {
    const mcp = agent.mcp === 'all' ? 'every MCP server' : agent.mcp.join(', ') || 'no MCP servers'
    console.info(`Chat answered by the local ${agent.agent} CLI with ${mcp}.`)
  }

  const openRouterRelay: ChatHandler = (request, { ip }) =>
    handleRelayRequest(
      request,
      { apiKey, siteUrl: new URL(request.url).origin, enabled: chatEnabled },
      { ip },
    )
  const chatHandler =
    agent && chatEnabled
      ? createAgentChat({ config: agent, debugLog: env.CHAT_AGENT_DEBUG_LOG })
      : openRouterRelay

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(remoteRelay ? [] : [chatRelay(chatHandler)]),
      getRelay('/api/gutenberg', handleGutenbergRequest),
      getRelay('/api/covers', handleCoverRequest),
      telemetryRelay(
        {
          apiKey: env.TELEMETRY_KEY,
          host: env.TELEMETRY_HOST,
          defaultMode: env.TELEMETRY_DEFAULT,
        },
        env.TELEMETRY_DEV_COUNTRY,
      ),
      publishing({
        enabled: env.THREADS_ENABLED !== 'false',
        turnstileSecret: env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA',
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
      }),
      visualizer({
        filename: 'reports/bundle.html',
        gzipSize: true,
        brotliSize: true,
        open: false,
      }),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Rami',
          short_name: 'Rami',
          description:
            'Follow a book beyond the page: select a passage and see where your questions lead.',
          theme_color: '#f4ecda',
          background_color: '#f4ecda',
          display: 'standalone',
          start_url: '/',
          // Lets the reader share a Gutenberg book page straight out of their
          // browser into Rami instead of copying the link across. Android
          // share sheets vary in which field they fill, so /add reads them all.
          share_target: {
            action: '/add',
            method: 'GET',
            params: { title: 'title', text: 'text', url: 'url' },
          },
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Books live in IndexedDB, not the SW cache, so the precache stays
          // small — including the sample EPUB, which is fetched once on first run.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // Relays must never be served from the SPA fallback or a cache.
          // Published threads are server-rendered pages, not routes of the app.
          navigateFallbackDenylist: [/^\/api\//, /^\/t\//],
        },
      }),
    ],
    // epub.js references `global` in a few places.
    define: {
      global: 'globalThis',
      'import.meta.env.APP_COMMIT': JSON.stringify(buildCommit()),
      'import.meta.env.APP_BUILT_AT': JSON.stringify(new Date().toISOString()),
    },
    build: { chunkSizeWarningLimit: 450 },
    server: {
      host: '127.0.0.1',
      // Forward chat to a deployed relay instead of using a local key. The relay
      // rejects cross-origin browsers, so drop Origin like a non-browser client.
      proxy: remoteRelay
        ? {
            '/api/chat': {
              target: remoteRelay,
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
              },
            },
          }
        : undefined,
    },
  }
})
