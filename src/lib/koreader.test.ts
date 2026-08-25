import { describe, expect, it } from 'vitest'
import { HandoffError, parseHandoff } from './koreader'

/**
 * The handoff file comes off a device over USB. Nothing about it is trusted, so
 * these are mostly about what gets refused.
 */

const SHA = 'a'.repeat(64)

/**
 * Builds an export, with `book` overrides merged one level deep so a case can
 * replace `highlights` without silently dropping the fingerprint next to it.
 */
function file(overrides: Record<string, unknown> = {}): string {
  const { book: bookOverrides, ...rest } = overrides
  const book: Record<string, unknown> = {
    title: 'Twilight of Idols and Anti-Christ',
    authors: 'Friedrich Nietzsche',
    pages: 351,
    file: { name: 'twilight.epub', size: 100, sha256: SHA },
    highlights: [
      {
        externalId: 'koreader:9f1c000000000000',
        text: 'short chapter he devotes to Twilight',
        note: 'this is the first test note',
        chapter: 'INTRODUCTION',
        color: 'yellow',
        createdAt: '2026-08-23T19:39:35-05:00',
        createdAtLocal: '2026-08-23 19:39:35',
        pageno: 13,
        progress: 0.037,
        anchor: { engine: 'crengine', start: '/body/DocFragment[3]', end: '/body/x' },
      },
    ],
    threads: [
      {
        externalId: 'koreader:thread-1',
        highlightExternalId: 'koreader:9f1c000000000000',
        title: 'short chapter',
        seedText: 'short chapter he devotes to Twilight',
        createdAt: '2026-08-23T19:40:00-05:00',
        messages: [
          {
            externalId: 'koreader:m1',
            role: 'user',
            content: 'What is he getting at?',
            createdAt: '2026-08-23T19:40:00-05:00',
          },
          {
            externalId: 'koreader:m2',
            role: 'assistant',
            content: 'He is describing…',
            createdAt: '2026-08-23T19:40:12-05:00',
          },
        ],
      },
    ],
    ...(bookOverrides as object | undefined),
  }

  return JSON.stringify({
    format: 'marginalia-koreader',
    version: 1,
    exportedAt: '2026-08-23T20:00:00-05:00',
    source: { app: 'koreader', appVersion: 'v2026.07.1', plugin: '1.0.0' },
    book,
    ...rest,
  })
}

function rejects(text: string, fragment: string) {
  expect(() => parseHandoff(text)).toThrowError(HandoffError)
  expect(() => parseHandoff(text)).toThrowError(new RegExp(fragment, 'i'))
}

describe('parseHandoff', () => {
  it('reads a well-formed export', () => {
    const handoff = parseHandoff(file())

    expect(handoff.title).toBe('Twilight of Idols and Anti-Christ')
    expect(handoff.authors).toBe('Friedrich Nietzsche')
    expect(handoff.sha256).toBe(SHA)
    expect(handoff.highlights).toHaveLength(1)
    expect(handoff.threads).toHaveLength(1)

    const highlight = handoff.highlights[0]
    expect(highlight.externalId).toBe('koreader:9f1c000000000000')
    expect(highlight.note).toBe('this is the first test note')
    expect(highlight.chapter).toBe('INTRODUCTION')
    expect(highlight.color).toBe('yellow')
    expect(highlight.progress).toBeCloseTo(0.037)
  })

  it('reads the offset the device wrote rather than guessing a zone', () => {
    const handoff = parseHandoff(file())
    expect(handoff.highlights[0].createdAt).toBe(Date.parse('2026-08-24T00:39:35Z'))
    expect(handoff.threads[0].messages[1].createdAt).toBe(
      Date.parse('2026-08-24T00:40:12Z'),
    )
  })

  it('refuses anything that is not this format', () => {
    rejects('not json at all', 'valid JSON')
    rejects(JSON.stringify({ format: 'readwise', version: 1 }), 'not a Marginalia export')
    rejects(JSON.stringify([1, 2, 3]), 'object')
  })

  it('refuses a version it does not understand', () => {
    rejects(
      JSON.stringify({ format: 'marginalia-koreader', version: 99 }),
      'version 99',
    )
  })

  it('insists on a real fingerprint, because that is what picks the edition', () => {
    rejects(file({ book: { file: { sha256: 'not-a-hash' } } }), 'not a SHA-256')
    rejects(file({ book: { file: {} } }), 'fingerprint')
  })

  it('caps how much any one field may carry', () => {
    rejects(
      file({ book: { highlights: [{ externalId: 'x', text: 'y'.repeat(20001) }] } }),
      'too long',
    )
  })

  it('caps how many records there may be', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      externalId: `koreader:${i}`,
      text: 'passage',
    }))
    rejects(file({ book: { highlights: many } }), 'too many highlights')
  })

  it('refuses a file too large to be an export', () => {
    rejects(`{"padding":"${'x'.repeat(33 * 1024 * 1024)}"}`, 'too large')
  })

  it('keeps a colour it does not recognise inside the palette', () => {
    const handoff = parseHandoff(
      file({ book: { highlights: [{ externalId: 'k:1', text: 'passage', color: 'gray' }] } }),
    )
    expect(handoff.highlights[0].color).toBe('yellow')
  })

  it('drops a highlight with nothing in it', () => {
    const handoff = parseHandoff(
      file({ book: { highlights: [{ externalId: 'k:1', text: '   ' }] } }),
    )
    expect(handoff.highlights).toHaveLength(0)
  })

  it('drops a conversation with no usable turns', () => {
    const handoff = parseHandoff(
      file({
        book: {
          threads: [
            { externalId: 'k:t1', title: 'empty', messages: [] },
            {
              externalId: 'k:t2',
              title: 'system only',
              messages: [{ externalId: 'k:m', role: 'system', content: 'x' }],
            },
          ],
        },
      }),
    )
    expect(handoff.threads).toHaveLength(0)
  })

  it('treats missing lists as empty rather than failing', () => {
    const handoff = parseHandoff(
      JSON.stringify({
        format: 'marginalia-koreader',
        version: 1,
        book: { title: 'Bare', file: { sha256: SHA } },
      }),
    )
    expect(handoff.highlights).toEqual([])
    expect(handoff.threads).toEqual([])
    expect(handoff.authors).toBe('Unknown author')
  })

  it('refuses a list that is not a list', () => {
    rejects(file({ book: { highlights: 'lots' } }), 'list')
  })

  it('clamps a progress value from outside the book', () => {
    const handoff = parseHandoff(
      file({
        book: {
          highlights: [
            { externalId: 'k:1', text: 'a passage', progress: 12 },
            { externalId: 'k:2', text: 'another passage', progress: -3 },
            { externalId: 'k:3', text: 'a third passage', progress: 'soon' },
          ],
        },
      }),
    )
    expect(handoff.highlights[0].progress).toBe(1)
    expect(handoff.highlights[1].progress).toBe(0)
    expect(handoff.highlights[2].progress).toBeUndefined()
  })

  it('falls back to the passage for a conversation with no title', () => {
    const handoff = parseHandoff(
      file({
        book: {
          threads: [
            {
              externalId: 'k:t1',
              seedText: 'the passage itself',
              messages: [{ externalId: 'k:m', role: 'user', content: 'why?' }],
            },
          ],
        },
      }),
    )
    expect(handoff.threads[0].title).toBe('the passage itself')
  })
})
