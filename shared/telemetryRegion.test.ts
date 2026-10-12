import { describe, expect, it } from 'vitest'
import { consentForCountry, handleTelemetryRegionRequest } from './telemetryRegion.ts'

describe('consentForCountry', () => {
  it('asks for consent in the EU, EEA and Switzerland', () => {
    for (const country of ['DE', 'FR', 'IE', 'NO', 'IS', 'LI', 'CH', 'de']) {
      expect(consentForCountry(country)).toBe('opt_in')
    }
  })

  it('uses opt-out with notice in the UK and US', () => {
    expect(consentForCountry('GB')).toBe('opt_out')
    expect(consentForCountry('US')).toBe('opt_out')
  })

  it('treats an unknown or hidden country as opt-in', () => {
    for (const country of [undefined, null, '', 'XX', 'T1', 'EUR', '1A']) {
      expect(consentForCountry(country)).toBe('opt_in')
    }
  })
})

describe('handleTelemetryRegionRequest', () => {
  it('answers with the consent mode only, uncached', async () => {
    const response = handleTelemetryRegionRequest(
      new Request('https://rami.test/api/telemetry/region'),
      'GB',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ consent: 'opt_out' })
  })

  it('rejects anything but GET', () => {
    const request = new Request('https://rami.test/api/telemetry/region', { method: 'POST' })
    expect(handleTelemetryRegionRequest(request, 'US').status).toBe(405)
  })
})
