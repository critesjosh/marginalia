import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { Readable } from 'node:stream'
import { handleRelayRequest } from './shared/relay.ts'
import { handleGutenbergRequest } from './shared/gutenberg.ts'

/**
 * Serves /api/chat in dev with the same handler the Netlify edge function uses,
 * so local runs exercise the real relay instead of a stand-in. Reads
 * OPENROUTER_API_KEY from .env.local; the deployed site gets it from Netlify.
 */
function chatRelay(apiKey: string): Plugin {
  return {
    name: 'marginalia-chat-relay',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)

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
          { apiKey, siteUrl: origin },
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

/** Uses the production Gutenberg handler in dev too, including its URL validation. */
function gutenbergRelay(): Plugin {
  return {
    name: 'marginalia-gutenberg-relay',
    configureServer(server) {
      server.middlewares.use('/api/gutenberg', async (req, res) => {
        const origin = `http://${req.headers.host ?? 'localhost'}`
        const requestUrl = new URL(req.url ?? '', new URL('/api/gutenberg', origin))
        requestUrl.pathname = '/api/gutenberg'
        const response = await handleGutenbergRequest(
          new Request(requestUrl, { method: req.method, headers: req.headers as HeadersInit }),
        )

        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        if (response.body) Readable.fromWeb(response.body).pipe(res)
        else res.end()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      tailwindcss(),
      chatRelay(env.OPENROUTER_API_KEY ?? ''),
      gutenbergRelay(),
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
          // Relays must never be served from the SPA fallback or a cache.
          navigateFallbackDenylist: [/^\/api\//],
        },
      }),
    ],
    // epub.js references `global` in a few places.
    define: { global: 'globalThis' },
    server: { host: true },
  }
})
