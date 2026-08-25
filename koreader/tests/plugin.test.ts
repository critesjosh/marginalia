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

  it('decides where questions may go', () => {
    expect(runSpec('endpoint_spec')).toContain('endpoint_spec ok')
  })

  it('renders saved conversations back', () => {
    expect(runSpec('view_spec')).toContain('view_spec ok')
  })

  it('keeps the rolling digest bounded and unfenced', () => {
    expect(runSpec('digest_spec')).toContain('digest_spec ok')
  })

  it('decides what to fold into the digest', () => {
    expect(runSpec('memory_spec')).toContain('memory_spec ok')
  })
})
