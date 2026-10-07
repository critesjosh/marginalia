import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { Readable } from 'node:stream'
import { handleRelayRequest } from './shared/relay.ts'
import { visualizer } from 'rollup-plugin-visualizer'
import { sentryVitePlugin } from '@sentry/vite-plugin'

/**
 * Serves /api/chat in dev with the same handler the Netlify edge function uses,
 * so local runs exercise the real relay instead of a stand-in. Reads
 * OPENROUTER_API_KEY from .env.local; the deployed site gets it from Netlify.
 */
function chatRelay(apiKey: string, enabled: boolean): Plugin {
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

        const response = await handleRelayRequest(
          request,
          { apiKey, siteUrl: origin, enabled },
          { ip: req.socket.remoteAddress ?? '' },
        )

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const remoteRelay = env.CHAT_RELAY_URL?.trim()

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(remoteRelay
        ? []
        : [chatRelay(env.OPENROUTER_API_KEY ?? '', env.CHAT_ENABLED !== 'false')]),
      visualizer({
        filename: 'reports/bundle.html',
        gzipSize: true,
        brotliSize: true,
        open: false,
      }),
      ...(process.env.SENTRY_UPLOAD_SOURCE_MAPS === 'true'
        ? [
            sentryVitePlugin({
              authToken: process.env.SENTRY_AUTH_TOKEN,
              org: process.env.SENTRY_ORG,
              project: process.env.SENTRY_PROJECT,
              telemetry: false,
              sourcemaps: { assets: './dist/assets/**' },
            }),
          ]
        : []),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Marginalia — EPUB Reader + AI Chat',
          short_name: 'Marginalia',
          description: 'Read EPUBs and chat with AI about what you highlight.',
          theme_color: '#1c1917',
          background_color: '#1c1917',
          display: 'standalone',
          start_url: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Books live in IndexedDB, not the SW cache, so the precache stays
          // small — including the sample EPUB, which is fetched once on first run.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // The relay must never be served from the SPA fallback or a cache.
          navigateFallbackDenylist: [/^\/api\//],
        },
      }),
    ],
    // epub.js references `global` in a few places.
    define: { global: 'globalThis', __SENTRY_TRACING__: false, __SENTRY_DEBUG__: false },
    build: { sourcemap: 'hidden', chunkSizeWarningLimit: 450 },
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
