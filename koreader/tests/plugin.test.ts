/**
 * Runs the KOReader plugin's Lua specs under a Lua VM.
 *
 * Each spec asserts in Lua and ends by printing its own name; a failed
 * assertion raises, which `runSpec` rethrows with the Lua file and line.
 */
import { describe, expect, it } from 'vitest'
import { runSpec } from './harness'

describe('koreader plugin', () => {
  it('builds the system prompt and holds the injection fence', () => {
    expect(runSpec('prompt_spec')).toContain('prompt_spec ok')
  })

  it('builds the handoff document with stable identities', () => {
    expect(runSpec('payload_spec')).toContain('payload_spec ok')
  })

  it('verifies certificate hostnames', () => {
    expect(runSpec('tls_spec')).toContain('tls_spec ok')
  })
})
