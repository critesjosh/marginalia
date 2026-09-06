import { handleRelayRequest } from '../../../shared/relay.ts'
import { EVENTS_PATH, handleEventBatchRequest } from './events.ts'
import { syncDisabled } from './events.ts'
import {
  INTELLIGENCE_PREFIX,
  appCaller,
  authorize,
  handleIntelligenceRequest,
} from './intelligence.ts'
import { MCP_PATH, handleMcpEndpoint } from './mcp.ts'

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; " +
  "img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' " +
  'https://api.openai.com https://marginalia-audiobooks.cloudflare-cdd.workers.dev; ' +
  "media-src 'self' blob: https://marginalia-audiobooks.cloudflare-cdd.workers.dev; " +
  "frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'"

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function apiError(status: number, message: string): Response {
  return Response.json(
    { error: { message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/api/chat') {
        return await handleRelayRequest(
          request,
          { apiKey: env.OPENROUTER_API_KEY, siteUrl: url.origin },
          { ip: request.headers.get('CF-Connecting-IP') ?? '' },
        )
      }

      if (url.pathname === EVENTS_PATH) {
        return await handleEventBatchRequest(request, env)
      }

      if (url.pathname.startsWith(INTELLIGENCE_PREFIX)) {
        return await handleIntelligenceRequest(request, env)
      }

      if (url.pathname === MCP_PATH) {
        return await handleMcpEndpoint(request, env, {
          authorize,
          disabled: syncDisabled,
          caller: appCaller,
        })
      }

      if (url.pathname.startsWith('/api/')) {
        return apiError(404, 'API route not found.')
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request))
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Unhandled application Worker error',
          error: error instanceof Error ? error.message : String(error),
          method: request.method,
          path: url.pathname,
        }),
      )

      return url.pathname.startsWith('/api/')
        ? apiError(500, 'Internal server error.')
        : withSecurityHeaders(new Response('Internal server error.', { status: 500 }))
    }
  },
} satisfies ExportedHandler<Env>
