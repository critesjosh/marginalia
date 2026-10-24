import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configDir, loadToken, TOKEN_PATTERN } from './bridgeToken.ts'

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-token-test-'))
  dir = join(root, 'rami')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const mode = (path: string) => statSync(path).mode & 0o777

describe('loadToken', () => {
  it('creates a private token once and then reuses it', async () => {
    const first = await loadToken(dir)
    expect(first.created).toBe(true)
    expect(first.token).toMatch(TOKEN_PATTERN)
    expect(mode(dir)).toBe(0o700)
    expect(mode(first.file)).toBe(0o600)

    const again = await loadToken(dir)
    expect(again).toMatchObject({ token: first.token, created: false })
  })

  it('replaces the token on request, leaving no temporary files', async () => {
    const first = await loadToken(dir)
    const rotated = await loadToken(dir, true)
    expect(rotated.created).toBe(true)
    expect(rotated.token).not.toBe(first.token)
    expect(readdirSync(dir)).toEqual(['agent-bridge.json'])
  })

  it('tightens a file or directory others can read', async () => {
    const { file } = await loadToken(dir)
    chmodSync(file, 0o644)
    chmodSync(dir, 0o755)
    await loadToken(dir)
    expect(mode(file)).toBe(0o600)
    expect(mode(dir)).toBe(0o700)
  })

  it('replaces a damaged file instead of trusting it', async () => {
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, 'agent-bridge.json'), '{"token":"short"}', { mode: 0o600 })
    expect((await loadToken(dir)).created).toBe(true)
  })

  it('refuses a symlinked file or directory', async () => {
    mkdirSync(dir, { mode: 0o700 })
    const elsewhere = join(root, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify({ token: 'c'.repeat(43) }), { mode: 0o600 })
    symlinkSync(elsewhere, join(dir, 'agent-bridge.json'))
    await expect(loadToken(dir)).rejects.toThrow(/symlink/)

    const linked = join(root, 'linked')
    symlinkSync(dir, linked)
    await expect(loadToken(linked)).rejects.toThrow(/symlink/)
  })
})

describe('configDir', () => {
  it('follows XDG_CONFIG_HOME, falling back to ~/.config', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/x' })).toBe('/x/rami')
    expect(configDir({})).toMatch(/\.config\/rami$/)
  })
})
