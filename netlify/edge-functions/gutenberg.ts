import type { Context } from '@netlify/edge-functions'
import { handleGutenbergRequest } from '../../shared/gutenberg.ts'

/**
 * Relays Project Gutenberg catalog searches and EPUB downloads same-origin,
 * because Gutenberg's responses do not reliably expose CORS headers. Declared
 * in netlify.toml; the shared handler holds the actual policy.
 */
export default async function handler(request: Request, context: Context): Promise<Response> {
  return handleGutenbergRequest(request, { ip: context.ip ?? '' })
}
