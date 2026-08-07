import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  absoluteChapterTime,
  chapterIndexAtTime,
  chapterRelativeTime,
  parseAudiobookMetadata,
  parseStoredAudiobookPosition,
} from './audiobooks'

const fixturePath = fileURLToPath(
  new URL('../../workers/audiobooks/catalog/twilight-of-the-idols.json', import.meta.url),
)
const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))

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
