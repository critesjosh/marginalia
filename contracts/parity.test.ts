import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateValidatorSource } from '../tools/generate-event-validators.mjs'
import { validateEvent } from '../src/sync/validate'
import { validateSubmittedEvent } from '../shared/events/validate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureFiles = [
  'nietzsche-phase-0.jsonl',
  'reading-sessions-phase-2.jsonl',
  'highlight-lifecycle-phase-2.jsonl',
]
const fixtures = fixtureFiles.flatMap((file) =>
  readFileSync(join(root, 'contracts/fixtures', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>),
)

describe('the generated validators', () => {
  it('are current with the contracts they were built from', () => {
    const generated = readFileSync(join(root, 'shared/events/validators.generated.js'), 'utf8')
    expect(generated).toBe(generateValidatorSource())
  })

  it('agree with the browser-side Ajv validators on every fixture', () => {
    for (const fixture of fixtures) {
      expect(validateSubmittedEvent(fixture).valid).toBe(validateEvent(fixture).valid)
      expect(validateSubmittedEvent(fixture).valid).toBe(true)
    }
  })

  it('agree on rejection too', () => {
    const broken = [
      { ...fixtures[0], sequence: 0 },
      { ...fixtures[0], eventTime: 'not-a-timestamp' },
      { ...fixtures[0], payload: { ...(fixtures[0].payload as object), unexpected: 1 } },
    ]
    for (const event of broken) {
      expect(validateSubmittedEvent(event).valid).toBe(false)
      expect(validateEvent(event).valid).toBe(false)
    }
  })
})
