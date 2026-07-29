import type { Context } from '@netlify/edge-functions'
import { handleRelayRequest } from '../../shared/relay.ts'

/**
 * Relays chat requests to OpenRouter so the API key stays on the server.
 * Declared in netlify.toml; the shared handler holds the actual policy.
 */
export default async function handler(request: Request, context: Context): Promise<Response> {
  return handleRelayRequest(
    request,
    {
      apiKey: Netlify.env.get('OPENROUTER_API_KEY') ?? '',
      siteUrl: Netlify.env.get('URL') ?? new URL(request.url).origin,
    },
    { ip: context.ip ?? '' },
  )
}
