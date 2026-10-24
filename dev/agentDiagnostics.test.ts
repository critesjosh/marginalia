import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiagnostics, errorCategory } from './agentDiagnostics.ts'

let dir: string
let output: string[]
const config = {
  agent: 'codex' as const,
  mcp: ['tavily'],
  model: 'gpt-6.1-sol',
  reasoningEffort: 'low',
  timeoutMs: 1000,
}
const SECRET = 'private passage bearer secret-key https://private.example/?token=secret'
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-diagnostics-'))
  output = []
  vi.spyOn(console, 'info').mockImplementation((value) => output.push(String(value)))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})
const records = () => output.map((value) => JSON.parse(value))

describe('local agent diagnostics', () => {
  it('classifies failures without retaining free text or forged fields', async () => {
    const diagnostic = createDiagnostics(config, true, Promise.resolve('0.163.0'))
    for (const type of ['error', 'turn.failed']) {
      diagnostic.observe(
        JSON.stringify({ type, error: { message: `rate limit ${SECRET}` }, message: SECRET }),
      )
    }
    diagnostic.observe(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'error', message: `unauthorized ${SECRET}` },
      }),
    )
    diagnostic.log('process', 'failed', { exitCode: 17, signal: null })
    const message = diagnostic.fail('The local agent stopped.')
    await Promise.resolve()
    expect(message).toContain(`Reference: ${diagnostic.requestId}`)
    expect(records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'model', outcome: 'failed', reason: 'rate_limit' }),
        expect.objectContaining({ stage: 'model', outcome: 'warning', reason: 'authentication' }),
        expect.objectContaining({ stage: 'process', exitCode: 17 }),
        expect.objectContaining({
          event: 'agent_configuration',
          model: config.model,
          reasoningEffort: 'low',
          cliVersion: '0.163.0',
        }),
      ]),
    )
    expect(output.join('')).not.toContain(SECRET)
    expect(new Set(records().map((record) => record.requestId)).size).toBe(1)
  })

  it('logs tool names, outcomes and timing without arguments or results', () => {
    const diagnostic = createDiagnostics(config, true, Promise.resolve('test'))
    diagnostic.observe(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'tool1',
          type: 'mcp_tool_call',
          server: 'tavily',
          tool: 'search',
          arguments: SECRET,
        },
      }),
    )
    diagnostic.observe(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'tool1',
          type: 'mcp_tool_call',
          result: SECRET,
          error: { message: `connection reset ${SECRET}` },
        },
      }),
    )
    expect(records()).toContainEqual(
      expect.objectContaining({
        stage: 'tool',
        server: 'tavily',
        tool: 'search',
        outcome: 'failed',
        reason: 'connection',
        toolDurationMs: expect.any(Number),
      }),
    )
    expect(output.join('')).not.toContain(SECRET)
  })

  it('logs Claude tool outcomes and ignores their content', () => {
    const diagnostic = createDiagnostics(
      { ...config, agent: 'claude' },
      true,
      Promise.resolve('test'),
    )
    diagnostic.observe(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'call1',
            name: 'mcp__tavily__search',
            input: SECRET,
          },
        },
      }),
    )
    diagnostic.observe(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call1', is_error: true, content: SECRET }],
        },
      }),
    )
    expect(records()).toContainEqual(
      expect.objectContaining({
        stage: 'tool',
        server: 'tavily',
        tool: 'search',
        outcome: 'failed',
      }),
    )
    expect(output.join('')).not.toContain(SECRET)
  })

  it('records the final reply outcome once, separately from process termination', () => {
    const diagnostic = createDiagnostics(config, false, Promise.resolve('test'))
    diagnostic.finish('success')
    diagnostic.finish('canceled')
    diagnostic.close(null, 'SIGTERM')
    expect(records().filter((record) => record.stage === 'reply')).toEqual([
      expect.objectContaining({ outcome: 'success' }),
    ])
    expect(records()).toContainEqual(
      expect.objectContaining({ stage: 'process', signal: 'SIGTERM' }),
    )
  })

  it('writes only a classified stderr tail to an owner-only, bounded debug file', () => {
    const file = join(dir, 'debug.jsonl')
    const diagnostic = createDiagnostics(config, true, Promise.resolve('test'), file)
    diagnostic.stderr(Buffer.from(`${SECRET}\n${'x'.repeat(9000)}\nconnection reset ${SECRET}`))
    diagnostic.close(1, null)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text)).toMatchObject({
      event: 'agent_stderr',
      reasons: ['unknown', 'connection'],
      redacted: true,
    })
    writeFileSync(file, 'x'.repeat(1024 * 1024))
    diagnostic.close(1, null)
    expect(statSync(file).size).toBe(1024 * 1024)
  })

  it('refuses symlinked debug files and does not let logging failure break chat', () => {
    const target = join(dir, 'target')
    const link = join(dir, 'link')
    writeFileSync(target, 'unchanged')
    symlinkSync(target, link)
    const diagnostic = createDiagnostics(config, true, Promise.resolve('test'), link)
    diagnostic.stderr(Buffer.from('authentication failed'))
    expect(() => diagnostic.close(1, null)).not.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('unchanged')
    expect(records()).toContainEqual(
      expect.objectContaining({ stage: 'process', outcome: 'warning' }),
    )
  })

  it('classifies common actionable errors and drops unknown text', () => {
    expect(errorCategory('model is not supported')).toBe('model_unavailable')
    expect(errorCategory('ENOENT')).toBe('cli_missing')
    expect(errorCategory(SECRET)).toBe('unknown')
  })
})
