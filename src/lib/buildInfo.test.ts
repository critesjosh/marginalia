import { describe, expect, it } from 'vitest'
import { buildId, describeBuild } from './buildInfo'

describe('describeBuild', () => {
  it('shows the commit and build date with a link to the commit', () => {
    expect(describeBuild('a1b2c3d', '2026-10-09T12:00:00.000Z')).toEqual({
      label: 'a1b2c3d · 2026-10-09',
      url: 'https://github.com/critesjosh/marginalia/commit/a1b2c3d',
    })
  })

  it('keeps the dirty marker in the label but not the link', () => {
    expect(describeBuild('a1b2c3d-dirty', undefined)).toEqual({
      label: 'a1b2c3d-dirty',
      url: 'https://github.com/critesjosh/marginalia/commit/a1b2c3d',
    })
  })

  it('falls back to dev without a commit', () => {
    expect(describeBuild(undefined, undefined)).toEqual({ label: 'dev' })
    expect(describeBuild('', '2026-10-09T12:00:00.000Z')).toEqual({ label: 'dev · 2026-10-09' })
  })
})

describe('buildId', () => {
  it('names the exact commit and build time', () => {
    expect(buildId('a1b2c3d-dirty', '2026-10-09T12:00:00.000Z')).toBe(
      'a1b2c3d-dirty built 2026-10-09T12:00:00.000Z',
    )
    expect(buildId(undefined, undefined)).toBe('dev built unknown')
  })
})
