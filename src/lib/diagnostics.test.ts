import { describe, expect, it } from 'vitest'
import {
  describeClientHints,
  idleDays,
  issueBody,
  issueUrl,
  logDiagnostic,
  noteBuild,
  readDiagnostics,
  type DiagnosticContext,
} from './diagnostics'

function memoryStore() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

const NOW = new Date('2026-10-11T15:00:00.000Z')
const BUILD = 'a1b2c3d built 2026-10-11T12:00:00.000Z'

const CONTEXT: DiagnosticContext = {
  build: BUILD,
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X)',
  standalone: true,
  persisted: false,
  usageMb: 42,
  quotaMb: 2048,
  books: { total: 6, removed: 1, missing: 2 },
}

describe('diagnostic log', () => {
  it('stamps each entry with its time and the build that wrote it', () => {
    const store = memoryStore()
    logDiagnostic({ type: 'lost-cover', book: 'imported', idleDays: 3 }, store, NOW, BUILD)
    expect(readDiagnostics(store)).toEqual([
      { type: 'lost-cover', book: 'imported', idleDays: 3, at: NOW.toISOString(), build: BUILD },
    ])
  })

  it('keeps only the most recent fifty entries', () => {
    const store = memoryStore()
    for (let i = 0; i < 60; i++) {
      logDiagnostic({ type: 'lost-cover', book: 'bundled', idleDays: i }, store, NOW, BUILD)
    }
    const entries = readDiagnostics(store)
    expect(entries).toHaveLength(50)
    expect(entries[0]).toMatchObject({ idleDays: 10 })
  })

  it('survives unreadable and blocked storage', () => {
    const corrupt = memoryStore()
    corrupt.setItem('marginalia.diagnostics', '{not json')
    expect(readDiagnostics(corrupt)).toEqual([])

    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() =>
      logDiagnostic({ type: 'lost-cover', book: 'bundled', idleDays: 0 }, blocked),
    ).not.toThrow()
    expect(() => noteBuild(BUILD, blocked)).not.toThrow()
  })
})

describe('noteBuild', () => {
  it('logs an update only when the build changes after a first launch', () => {
    const store = memoryStore()
    noteBuild('old built 2026-10-01T00:00:00.000Z', store, NOW)
    noteBuild('old built 2026-10-01T00:00:00.000Z', store, NOW)
    expect(readDiagnostics(store)).toEqual([])

    noteBuild(BUILD, store, NOW)
    expect(readDiagnostics(store)).toEqual([
      {
        type: 'app-updated',
        from: 'old built 2026-10-01T00:00:00.000Z',
        to: BUILD,
        at: NOW.toISOString(),
        build: BUILD,
      },
    ])
  })
})

describe('idleDays', () => {
  it('counts from the last open, or from when the book was added', () => {
    const day = 86_400_000
    expect(idleDays({ addedAt: 0, lastOpenedAt: day }, 3.25 * day)).toBe(2.3)
    expect(idleDays({ addedAt: 0 }, 1.5 * day)).toBe(1.5)
  })
})

describe('describeClientHints', () => {
  it('skips the GREASE brand and prefers the named browser over Chromium', () => {
    expect(
      describeClientHints({
        platform: 'Android',
        platformVersion: '15.0.0',
        fullVersionList: [
          { brand: 'Not)A;Brand', version: '99.0.0.0' },
          { brand: 'Chromium', version: '155.0.7339.81' },
          { brand: 'Google Chrome', version: '155.0.7339.81' },
        ],
      }),
    ).toBe('Google Chrome 155.0.7339.81 on Android 15.0.0')
  })

  it('names the Windows release rather than its API contract version', () => {
    const fullVersionList = [{ brand: 'Microsoft Edge', version: '150.0.1.2' }]
    expect(
      describeClientHints({ platform: 'Windows', platformVersion: '19.0.0', fullVersionList }),
    ).toBe('Microsoft Edge 150.0.1.2 on Windows 11')
    expect(
      describeClientHints({ platform: 'Windows', platformVersion: '10.0.0', fullVersionList }),
    ).toBe('Microsoft Edge 150.0.1.2 on Windows 10')
  })

  it('gives up without a browser or platform', () => {
    expect(describeClientHints({ platform: 'Linux' })).toBeUndefined()
    expect(
      describeClientHints({ fullVersionList: [{ brand: 'Chromium', version: '1' }] }),
    ).toBeUndefined()
  })
})

describe('issue report', () => {
  it('lists the exact running build and each entry with its own build', () => {
    const store = memoryStore()
    logDiagnostic(
      {
        type: 'lost-file',
        book: 'imported',
        outcome: 'unrecoverable',
        coverLost: true,
        idleDays: 2.1,
      },
      store,
      NOW,
      'old built 2026-10-01T00:00:00.000Z',
    )
    const body = issueBody(CONTEXT, readDiagnostics(store))
    expect(body).toContain(`- Version: ${BUILD}`)
    expect(body).toContain('- Opened from: home screen')
    expect(body).toContain('- Storage: persistent no, 42 MB used of 2048 MB')
    expect(body).toContain('- Books: 5 on the shelf (2 missing their EPUB), 1 removed')
    expect(body).toContain('- User agent: Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X)')
    expect(body).not.toContain('- Browser:')
    expect(body).toContain(
      '2026-10-11T15:00:00.000Z [old built 2026-10-01T00:00:00.000Z] lost EPUB, imported, unrecoverable, cover lost too, idle 2.1d',
    )
  })

  it('names the real browser and OS versions when client hints give them', () => {
    const body = issueBody(
      { ...CONTEXT, browser: 'Google Chrome 155.0.7339.81 on Android 15.0.0' },
      [],
    )
    expect(body).toContain('- Browser: Google Chrome 155.0.7339.81 on Android 15.0.0')
    expect(body).toContain('No lost files or app updates recorded.')
  })

  it('drops the oldest entries until the link fits', () => {
    const store = memoryStore()
    for (let i = 0; i < 50; i++) {
      logDiagnostic(
        { type: 'app-updated', from: 'x'.repeat(200), to: BUILD },
        store,
        new Date(NOW.getTime() + i * 1000),
        BUILD,
      )
    }
    const entries = readDiagnostics(store)
    const url = issueUrl('https://github.com/o/r/issues', CONTEXT, entries)
    expect(url.length).toBeLessThanOrEqual(8000)
    expect(url.startsWith('https://github.com/o/r/issues/new?body=')).toBe(true)
    const body = decodeURIComponent(url.split('body=')[1])
    expect(body).toContain(entries.at(-1)!.at)
    expect(body).not.toContain(entries[0].at)
  })
})
