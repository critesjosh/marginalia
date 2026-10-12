/**
 * What published threads (`threads.ts`) and published book links (`books.ts`)
 * have in common: unguessable ids, owner tokens kept only as hashes, the
 * Turnstile check on create, and the store both write to. See
 * `docs/decisions/0006-public-thread-links.md` and
 * `docs/decisions/0007-shared-book-links.md`.
 */

import { fetchUpstream, json } from './http-guards.ts'

/** A link lives for a year after its last publish. */
export const LINK_TTL_SECONDS = 365 * 24 * 60 * 60

const ID_BYTES = 16
const TOKEN_BYTES = 32
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** The subset of Workers KV this needs. */
export interface LinkStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
}

export interface PublishOptions {
  /** Absent when the deployment has no storage bound. */
  store?: LinkStore
  turnstileSecret?: string
  /** Public; handed to the PWA so it can render the challenge. */
  turnstileSiteKey?: string
  enabled?: boolean
  fetcher?: typeof fetch
  now?: () => number
}

export interface PublishRequestContext {
  /** Client address, used for throttling and passed to Turnstile. */
  ip: string
}

/** The dev server's and tests' stand-in for Workers KV, expiry included. */
export function memoryLinkStore(): LinkStore & { size(): number } {
  const items = new Map<string, { value: string; expiresAt: number }>()
  return {
    async get(key) {
      const item = items.get(key)
      if (!item || item.expiresAt <= Date.now()) return null
      return item.value
    },
    async put(key, value, ttlSeconds) {
      items.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
    },
    async delete(key) {
      items.delete(key)
    },
    size: () => items.size,
  }
}

/** A fresh link id and owner token, and the hash of the token to store. */
export async function newLink(): Promise<{ id: string; ownerToken: string; ownerHash: string }> {
  const ownerToken = randomToken(TOKEN_BYTES)
  return { id: randomToken(ID_BYTES), ownerToken, ownerHash: await sha256(ownerToken) }
}

/**
 * The stored record when the request's bearer token owns it, otherwise the
 * error to send. A wrong token and a missing record get the same 404, so ids
 * cannot be probed.
 */
export async function authorizeOwner<T extends { ownerHash: string }>(
  request: Request,
  load: () => Promise<T | null>,
  missing: string,
): Promise<T | Response> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return errorResponse(401, 'Missing owner token.')
  const existing = await load()
  if (!existing || !sameHex(existing.ownerHash, await sha256(token))) {
    return errorResponse(404, missing)
  }
  return existing
}

export async function verifyTurnstile(
  { turnstileSecret = '', fetcher = fetch }: PublishOptions,
  token: string,
  ip: string,
): Promise<boolean> {
  if (!token) return false
  const form = new FormData()
  form.set('secret', turnstileSecret.trim())
  form.set('response', token)
  if (ip) form.set('remoteip', ip)

  const response = await fetchUpstream(fetcher, SITEVERIFY_URL, { method: 'POST', body: form })
  if (!response?.ok) return false
  const result = (await response.json().catch(() => null)) as { success?: unknown } | null
  return result?.success === true
}

/** Whether create requests can be accepted: storage, the switch and both Turnstile keys. */
export function canPublish({ enabled = true, turnstileSecret, turnstileSiteKey }: PublishOptions) {
  return enabled && Boolean(turnstileSecret?.trim()) && Boolean(turnstileSiteKey?.trim())
}

export function now(options: PublishOptions): number {
  return options.now?.() ?? Date.now()
}

export function expiresAt(publishedAt: number): number {
  return publishedAt + LINK_TTL_SECONDS * 1000
}

function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Compares without stopping at the first difference. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: { message } }, status)
}
