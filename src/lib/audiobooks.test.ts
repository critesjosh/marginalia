import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  absoluteChapterTime,
  chapterIndexAtTime,
  chapterRelativeTime,
  parseAudiobookMetadata,
  parseAudiobookSync,
  parseStoredAudiobookPosition,
  segmentAtTime,
  segmentForSpan,
} from './audiobooks'

const fixturePath = fileURLToPath(
  new URL('../../workers/audiobooks/catalog/twilight-of-the-idols.json', import.meta.url),
)
const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))

/**
 * The sync fixtures are the narrator's own output, checked in beside its tests,
 * so this file parses exactly what `narrate.timeline` publishes rather than a
 * hand-written idea of it.
 */
function narratorFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../tools/narrate/tests/fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('audiobook metadata', () => {
  it('accepts the published chapter catalog', () => {
    const metadata = parseAudiobookMetadata(fixture)
    expect(metadata.chapters).toHaveLength(19)
    expect(metadata.chapters[0]).toMatchObject({ id: 'introduction', startSeconds: 0 })
    expect(metadata.chapters.at(-1)?.endSeconds).toBe(metadata.audiobook.durationSeconds)
    expect(metadata.audiobook.audioId).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects chapter gaps, overlaps, and a mismatched final duration', () => {
    for (const offset of [-1, 1]) {
      const changed = structuredClone(fixture) as { chapters: { startSeconds: number }[] }
      changed.chapters[1].startSeconds += offset
      expect(() => parseAudiobookMetadata(changed)).toThrow('ordered and contiguous')
    }

    const changed = structuredClone(fixture) as {
      audiobook: { durationSeconds: number }
    }
    changed.audiobook.durationSeconds += 5
    expect(() => parseAudiobookMetadata(changed)).toThrow('do not match')
  })
})

describe('chapter navigation', () => {
  const metadata = parseAudiobookMetadata(fixture)
  const first = metadata.chapters[0]
  const second = metadata.chapters[1]

  it('uses half-open chapter boundaries', () => {
    expect(chapterIndexAtTime(metadata.chapters, first.endSeconds - 0.001)).toBe(0)
    expect(chapterIndexAtTime(metadata.chapters, second.startSeconds)).toBe(1)
    expect(chapterIndexAtTime(metadata.chapters, metadata.audiobook.durationSeconds)).toBe(18)
  })

  it('is total and monotonic across the complete recording', () => {
    let previous = 0
    for (let time = 0; time <= metadata.audiobook.durationSeconds; time += 10) {
      const current = chapterIndexAtTime(metadata.chapters, time)
      expect(current).toBeGreaterThanOrEqual(previous)
      expect(current).toBeLessThan(metadata.chapters.length)
      previous = current
    }
  })

  it('round-trips chapter-relative and absolute positions', () => {
    const absolute = first.startSeconds + 123.5
    const relative = chapterRelativeTime(first, absolute)
    expect(relative).toBe(123.5)
    expect(absoluteChapterTime(first, relative)).toBe(absolute)
    expect(absoluteChapterTime(first, Number.POSITIVE_INFINITY)).toBe(first.startSeconds)
  })
})

describe('resume position', () => {
  const metadata = parseAudiobookMetadata(fixture)
  const position = {
    audioId: metadata.audiobook.audioId,
    positionSeconds: 1234.5,
    updatedAt: 1_786_120_000_000,
  }

  it('accepts a valid position for this exact audio file', () => {
    expect(parseStoredAudiobookPosition(JSON.stringify(position), metadata)).toEqual(position)
  })

  it('rejects stale, malformed, and out-of-range positions', () => {
    expect(parseStoredAudiobookPosition('{', metadata)).toBeUndefined()
    expect(
      parseStoredAudiobookPosition(JSON.stringify({ ...position, audioId: 'sha256:old' }), metadata),
    ).toBeUndefined()
    expect(
      parseStoredAudiobookPosition(
        JSON.stringify({ ...position, positionSeconds: metadata.audiobook.durationSeconds + 1 }),
        metadata,
      ),
    ).toBeUndefined()
    expect(
      parseStoredAudiobookPosition(JSON.stringify({ ...position, positionSeconds: -1 }), metadata),
    ).toBeUndefined()
  })
})

describe('sentence sync map', () => {
  const metadata = parseAudiobookMetadata(narratorFixture('metadata.json'))
  const payload = narratorFixture('sync.json') as Record<string, unknown>
  const sync = parseAudiobookSync(payload, metadata)

  it('parses what the narrator publishes', () => {
    expect(sync.segments).toHaveLength(11)
    expect(sync.spanIdPrefix).toBe('mg-')
    expect(sync.segments[0]).toEqual({
      spanId: 'mg-000001',
      href: 'text/part0001.xhtml',
      startSeconds: 0,
    })
    expect(sync.segments.at(-1)).toEqual({
      spanId: 'mg-000011',
      href: 'text/part0002.xhtml',
      startSeconds: 72.005,
    })
  })

  it('refuses a map built against different audio', () => {
    expect(() => parseAudiobookSync({ ...payload, audioId: 'sha256:other' }, metadata)).toThrow(
      'different recording',
    )
    expect(() => parseAudiobookSync({ ...payload, durationSeconds: 900 }, metadata)).toThrow(
      'different recording',
    )
  })

  it('refuses spans that are duplicated, backwards, or off the end', () => {
    const documents = structuredClone(payload.documents) as {
      spans: string[]
      starts: number[]
    }[]

    const duplicated = structuredClone(documents)
    duplicated[1].spans[0] = 'mg-000001'
    expect(() => parseAudiobookSync({ ...payload, documents: duplicated }, metadata)).toThrow(
      'appears twice',
    )

    const backwards = structuredClone(documents)
    backwards[1].starts[1] = 1
    expect(() => parseAudiobookSync({ ...payload, documents: backwards }, metadata)).toThrow(
      'runs backwards',
    )

    const past = structuredClone(documents)
    past[1].starts[5] = metadata.audiobook.durationSeconds + 0.5
    expect(() => parseAudiobookSync({ ...payload, documents: past }, metadata)).toThrow(
      'outside the recording',
    )

    const ragged = structuredClone(documents)
    ragged[0].starts.pop()
    expect(() => parseAudiobookSync({ ...payload, documents: ragged }, metadata)).toThrow(
      'sync document at index 0',
    )
  })

  it('finds the sentence being spoken, on half-open boundaries', () => {
    expect(segmentAtTime(sync, 0)?.spanId).toBe('mg-000001')
    expect(segmentAtTime(sync, 4.499)?.spanId).toBe('mg-000001')
    expect(segmentAtTime(sync, 4.5)?.spanId).toBe('mg-000002')
    expect(segmentAtTime(sync, metadata.audiobook.durationSeconds)?.spanId).toBe('mg-000011')
  })

  it('has no sentence before the narration starts', () => {
    // Front matter a recording skips leaves the first minutes unnarrated.
    const started = parseAudiobookSync(
      {
        ...payload,
        documents: [{ href: 'text/part0001.xhtml', spans: ['mg-000001'], starts: [12] }],
      },
      metadata,
    )
    expect(segmentAtTime(started, 11.9)).toBeUndefined()
    expect(segmentAtTime(started, 12)?.spanId).toBe('mg-000001')
  })

  it('round-trips a span on the page to the time it is spoken', () => {
    for (const segment of sync.segments) {
      const found = segmentForSpan(sync, segment.spanId)
      expect(found).toBe(segment)
      expect(segmentAtTime(sync, found!.startSeconds)?.spanId).toBe(segment.spanId)
    }
    expect(segmentForSpan(sync, 'mg-999999')).toBeUndefined()
  })

  it('is monotonic across the whole recording', () => {
    let previous = -1
    for (let time = 0; time <= metadata.audiobook.durationSeconds; time += 0.25) {
      const index = sync.segments.indexOf(segmentAtTime(sync, time) ?? sync.segments[0])
      expect(index).toBeGreaterThanOrEqual(previous)
      previous = index
    }
  })
})
