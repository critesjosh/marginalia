import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generateDeclarationSource,
  generateValidatorSource,
} from '../tools/generate-event-validators.mjs'
import { validateEvent } from '../src/sync/validate'
import { PAYLOAD_VALIDATORS, validateSubmittedEvent } from '../shared/events/validate'
import { payloadValidators as browserPayloadValidators } from '../src/sync/validate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const fixtureFiles = [
  'nietzsche-phase-0.jsonl',
  'reading-sessions-phase-2.jsonl',
  'highlight-lifecycle-phase-2.jsonl',
  'library-lifecycle-phase-5.jsonl',
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

  it('declare exactly what they export', () => {
    // The declarations were once written by hand while claiming to be generated,
    // so a new contract compiled and then failed to typecheck against them.
    const declared = readFileSync(join(root, 'shared/events/validators.generated.d.ts'), 'utf8')
    expect(declared).toBe(generateDeclarationSource())
  })

  it('cover exactly the event types the manifest lists', () => {
    // One manifest, four consumers. This is the test that stops any of them
    // being the one nobody remembered to update.
    const manifest = JSON.parse(
      readFileSync(join(root, 'contracts/events/v1/payloads.json'), 'utf8'),
    ) as { payloads: Record<string, string> }
    const declared = Object.keys(manifest.payloads).sort()

    expect(Object.keys(PAYLOAD_VALIDATORS).sort()).toEqual(declared)
    expect(Object.keys(browserPayloadValidators).sort()).toEqual(declared)

    const envelope = JSON.parse(
      readFileSync(join(root, 'contracts/events/v1/envelope.schema.json'), 'utf8'),
    ) as { properties: { eventType: { enum: string[] } } }
    expect([...envelope.properties.eventType.enum].sort()).toEqual(declared)
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
