import type { Context } from '@netlify/edge-functions'
import { handleGutenbergRequest } from '../../shared/gutenberg.ts'

export default async function handler(request: Request, _context: Context): Promise<Response> {
  return handleGutenbergRequest(request)
}
