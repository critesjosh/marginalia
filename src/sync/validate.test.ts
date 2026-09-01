import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateEvent } from './validate'

const fixturePath = fileURLToPath(
  new URL('../../contracts/fixtures/nietzsche-phase-0.jsonl', import.meta.url),
)
const fixtures = readFileSync(fixturePath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as unknown)

describe('event contract v1', () => {
  it('accepts the realistic Nietzsche stream', () => {
    const typescript = fixtures.map((event) => validateEvent(event).valid)
    expect(typescript).toEqual([true, true, true, true])
  })

  it('rejects unknown envelope and payload fields', () => {
    const unknownEnvelope = { ...(fixtures[0] as object), userId: 'browser-must-not-send-this' }
    const event = structuredClone(fixtures[3]) as { payload: Record<string, unknown> }
    event.payload.surroundingContext = 'not consented and not in this payload contract'
    const values = [unknownEnvelope, event]
    const typescript = values.map((value) => validateEvent(value).valid)
    expect(typescript).toEqual([false, false])
  })

  it('rejects an unknown schema version identically', () => {
    const event = { ...(fixtures[0] as object), schemaVersion: 2 }
    expect(validateEvent(event).valid).toBe(false)
  })

  it('requires event-specific entities and privacy categories', () => {
    const missingEntity = structuredClone(fixtures[3]) as {
      entities: Record<string, unknown>
    }
    delete missingEntity.entities.messageId
    const wrongPrivacy = structuredClone(fixtures[0]) as {
      privacy: { included: string[] }
    }
    wrongPrivacy.privacy.included = ['conversationText']
    expect([missingEntity, wrongPrivacy].map((event) => validateEvent(event).valid)).toEqual([
      false,
      false,
    ])
  })

  it('keeps consent snapshots and optional text fields in lockstep', () => {
    const undisclosedText = structuredClone(fixtures[0]) as {
      privacy: { included: string[] }
    }
    undisclosedText.privacy.included = ['highlightNotes']
    const missingConsentedText = structuredClone(fixtures[3]) as {
      payload: Record<string, unknown>
    }
    delete missingConsentedText.payload.content
    expect(
      [undisclosedText, missingConsentedText].map((event) => validateEvent(event).valid),
    ).toEqual([false, false])
  })
})
