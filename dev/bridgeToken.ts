/**
 * The bridge's pairing token (decision 0010): 256 random bits kept in
 * `$XDG_CONFIG_HOME/rami/agent-bridge.json`, readable only by the reader.
 *
 * The file is refused if it is a symlink or someone else's, tightened if its
 * mode is too open, and replaced by writing a new file and renaming it over
 * the old, so a crash never leaves a half-written token.
 */

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 32 bytes as unpadded base64url. The PWA checks the same shape. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'rami')
}

export interface LoadedToken {
  token: string
  /** True when this call made a new token, so the bridge shows it. */
  created: boolean
  file: string
}

export async function loadToken(dir: string, rotate = false): Promise<LoadedToken> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await checkPrivate(dir, 'directory')
  const file = join(dir, 'agent-bridge.json')

  if (!rotate) {
    const existing = await readToken(file)
    if (existing) return { token: existing, created: false, file }
  }

  const token = randomBytes(32).toString('base64url')
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // `wx` refuses to follow a link someone planted at the temporary name.
    await writeFile(temporary, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { token, created: true, file }
}

/** The stored token, or null if it is missing or damaged. Never creates one. */
export async function readToken(file: string): Promise<string | null> {
  try {
    await checkPrivate(file, 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const { token } = JSON.parse(await readFile(file, 'utf8')) as { token?: unknown }
    return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null
  } catch {
    // A damaged file is replaced, which unpairs the browser: safer than guessing.
    return null
  }
}

/** Throws unless `path` is a real file or directory of this user's; tightens its mode. */
async function checkPrivate(path: string, kind: 'file' | 'directory') {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to use it.`)
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`${path} is not a ${kind}.`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`${path} belongs to another user; refusing to use it.`)
  }
  if (stats.mode & 0o077) await chmod(path, kind === 'file' ? 0o600 : 0o700)
}
