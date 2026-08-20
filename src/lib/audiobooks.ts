export const AUDIOBOOK_WORKER_URL = 'https://marginalia-audiobooks.cloudflare-cdd.workers.dev'
export const AUDIOBOOK_POSITION_KEY = 'marginalia:audiobook-position'

export interface AudiobookChapter {
  id: string
  title: string
  startSeconds: number
  endSeconds: number
}

export interface AudiobookMetadata {
  version: number
  title: string
  author?: string
  audiobook: {
    audioId: string
    durationSeconds: number
  }
  chapters: AudiobookChapter[]
}

export interface AudiobookSession {
  audioUrl: string
  metadataUrl: string
  /** Absent on a deployment whose Worker predates the sync map. */
  syncUrl?: string
  expiresAt: number
}

/** One narrated sentence: where it is in the book, and when it is spoken. */
export interface AudiobookSyncSegment {
  /** Id of the `<span>` wrapping this sentence in the narrated EPUB. */
  spanId: string
  /** Spine href holding the span. `href#spanId` is a target `display` accepts. */
  href: string
  startSeconds: number
}

export interface AudiobookSync {
  audioId: string
  spanIdPrefix: string
  /** Reading order, which is also ascending by `startSeconds`. */
  segments: AudiobookSyncSegment[]
  bySpan: ReadonlyMap<string, AudiobookSyncSegment>
}

export interface StoredAudiobookPosition {
  audioId: string
  positionSeconds: number
  updatedAt: number
}

export function isTwilightOfTheIdols(title: string): boolean {
  return title.toLowerCase().includes('twilight of the idols')
}

export async function createAudiobookSession(token: string): Promise<AudiobookSession> {
  const response = await fetch(`${AUDIOBOOK_WORKER_URL}/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  const body = (await response.json().catch(() => undefined)) as
    | Partial<AudiobookSession> & { error?: string }
    | undefined
  if (!response.ok) throw new Error(body?.error ?? 'Could not unlock the audiobook.')
  if (
    typeof body?.audioUrl !== 'string' ||
    typeof body.metadataUrl !== 'string' ||
    typeof body.expiresAt !== 'number' ||
    (body.syncUrl !== undefined && typeof body.syncUrl !== 'string')
  ) {
    throw new Error('The audiobook service returned an invalid response.')
  }
  return body as AudiobookSession
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseAudiobookMetadata(body: unknown): AudiobookMetadata {
  if (!isRecord(body) || !isRecord(body.audiobook) || !Array.isArray(body.chapters)) {
    throw new Error('Invalid audiobook metadata.')
  }

  const { audiobook } = body
  const durationSeconds = audiobook.durationSeconds
  const sha256 = audiobook.sha256
  const audioId = audiobook.audioId ?? (typeof sha256 === 'string' ? `sha256:${sha256}` : undefined)
  if (
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    !finiteNumber(durationSeconds) ||
    durationSeconds <= 0 ||
    typeof audioId !== 'string' ||
    !audioId
  ) {
    throw new Error('Invalid audiobook metadata.')
  }

  const chapters: AudiobookChapter[] = body.chapters.map((chapter, index) => {
    if (
      !isRecord(chapter) ||
      typeof chapter.id !== 'string' ||
      !chapter.id ||
      typeof chapter.title !== 'string' ||
      !chapter.title.trim() ||
      !finiteNumber(chapter.startSeconds) ||
      !finiteNumber(chapter.endSeconds) ||
      chapter.startSeconds < 0 ||
      chapter.endSeconds <= chapter.startSeconds
    ) {
      throw new Error(`Invalid audiobook chapter at index ${index}.`)
    }
    return {
      id: chapter.id,
      title: chapter.title,
      startSeconds: chapter.startSeconds,
      endSeconds: chapter.endSeconds,
    }
  })

  if (!chapters.length || Math.abs(chapters[0].startSeconds) > 0.05) {
    throw new Error('Audiobook chapters must begin at zero.')
  }
  if (new Set(chapters.map((chapter) => chapter.id)).size !== chapters.length) {
    throw new Error('Audiobook chapter IDs must be unique.')
  }
  for (let index = 1; index < chapters.length; index += 1) {
    if (Math.abs(chapters[index].startSeconds - chapters[index - 1].endSeconds) > 0.05) {
      throw new Error('Audiobook chapters must be ordered and contiguous.')
    }
  }
  if (Math.abs(chapters.at(-1)!.endSeconds - durationSeconds) > 1) {
    throw new Error('Audiobook chapters do not match the audio duration.')
  }

  return {
    version: finiteNumber(body.version) ? body.version : 1,
    title: body.title,
    author: typeof body.author === 'string' ? body.author : undefined,
    audiobook: { audioId, durationSeconds },
    chapters,
  }
}

export async function loadAudiobookMetadata(url: string): Promise<AudiobookMetadata> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not load audiobook metadata.')
  return parseAudiobookMetadata(await response.json())
}

/**
 * Parses the sentence sync map produced by `narrate.timeline`.
 *
 * Held to the same identity check as a resume position: a map built against a
 * different recording would place every sentence somewhere plausible and wrong,
 * which is worse than having no sync at all.
 */
export function parseAudiobookSync(body: unknown, metadata: AudiobookMetadata): AudiobookSync {
  if (!isRecord(body) || !Array.isArray(body.documents)) {
    throw new Error('Invalid audiobook sync map.')
  }
  if (body.audioId !== metadata.audiobook.audioId) {
    throw new Error('The audiobook sync map describes a different recording.')
  }
  if (
    finiteNumber(body.durationSeconds) &&
    Math.abs(body.durationSeconds - metadata.audiobook.durationSeconds) > 1
  ) {
    throw new Error('The audiobook sync map describes a different recording.')
  }

  const spanIdPrefix =
    typeof body.spanIdPrefix === 'string' && body.spanIdPrefix ? body.spanIdPrefix : 'mg-'
  const segments: AudiobookSyncSegment[] = []
  const bySpan = new Map<string, AudiobookSyncSegment>()

  for (const [index, document] of body.documents.entries()) {
    if (
      !isRecord(document) ||
      typeof document.href !== 'string' ||
      !document.href ||
      !Array.isArray(document.spans) ||
      !Array.isArray(document.starts) ||
      document.spans.length !== document.starts.length
    ) {
      throw new Error(`Invalid audiobook sync document at index ${index}.`)
    }

    for (const [position, spanId] of document.spans.entries()) {
      const startSeconds = document.starts[position]
      if (typeof spanId !== 'string' || !spanId.startsWith(spanIdPrefix)) {
        throw new Error(`Invalid audiobook sync span at index ${position}.`)
      }
      if (
        !finiteNumber(startSeconds) ||
        startSeconds < 0 ||
        startSeconds > metadata.audiobook.durationSeconds
      ) {
        throw new Error(`Audiobook sync span ${spanId} falls outside the recording.`)
      }
      // Binary search by time and lookup by span id both depend on this, and a
      // map assembled from parts rendered out of order would break it silently.
      if (startSeconds < (segments.at(-1)?.startSeconds ?? 0)) {
        throw new Error(`Audiobook sync span ${spanId} runs backwards.`)
      }
      if (bySpan.has(spanId)) {
        throw new Error(`Audiobook sync span ${spanId} appears twice.`)
      }

      const segment: AudiobookSyncSegment = { spanId, href: document.href, startSeconds }
      segments.push(segment)
      bySpan.set(spanId, segment)
    }
  }

  if (!segments.length) throw new Error('The audiobook sync map has no sentences.')
  return { audioId: body.audioId, spanIdPrefix, segments, bySpan }
}

/**
 * Loads the sync map for a session, or `undefined` when the recording has none.
 *
 * A missing map costs sentence-level sync and nothing else, so it must never
 * stop a book playing. A malformed one is a packaging bug and does throw.
 */
export async function loadAudiobookSync(
  url: string,
  metadata: AudiobookMetadata,
): Promise<AudiobookSync | undefined> {
  const response = await fetch(url)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error('Could not load the audiobook sync map.')
  return parseAudiobookSync(await response.json(), metadata)
}

/** Index of the sentence being spoken at `timeSeconds`, or -1 before the first. */
export function segmentIndexAtTime(sync: AudiobookSync, timeSeconds: number): number {
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0
  let low = 0
  let high = sync.segments.length - 1
  let found = -1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (sync.segments[middle].startSeconds <= time) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/** The sentence being spoken at `timeSeconds`, if the recording has reached one. */
export function segmentAtTime(
  sync: AudiobookSync,
  timeSeconds: number,
): AudiobookSyncSegment | undefined {
  const index = segmentIndexAtTime(sync, timeSeconds)
  return index < 0 ? undefined : sync.segments[index]
}

/** Where a sentence on the page is spoken. Undefined for unnarrated markup. */
export function segmentForSpan(
  sync: AudiobookSync,
  spanId: string,
): AudiobookSyncSegment | undefined {
  return sync.bySpan.get(spanId)
}

export function chapterIndexAtTime(chapters: AudiobookChapter[], timeSeconds: number): number {
  if (!chapters.length) return -1
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0
  let low = 0
  let high = chapters.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const chapter = chapters[middle]
    if (time < chapter.startSeconds) high = middle - 1
    else if (time >= chapter.endSeconds && middle < chapters.length - 1) low = middle + 1
    else return middle
  }

  return time < chapters[0].startSeconds ? 0 : chapters.length - 1
}

export function clampPlaybackTime(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) return 0
  return Math.min(Math.max(timeSeconds, 0), durationSeconds)
}

export function chapterRelativeTime(chapter: AudiobookChapter, absoluteSeconds: number): number {
  return clampPlaybackTime(absoluteSeconds - chapter.startSeconds, chapter.endSeconds - chapter.startSeconds)
}

export function absoluteChapterTime(chapter: AudiobookChapter, relativeSeconds: number): number {
  return chapter.startSeconds + clampPlaybackTime(relativeSeconds, chapter.endSeconds - chapter.startSeconds)
}

export function parseStoredAudiobookPosition(
  serialized: string | null,
  metadata: AudiobookMetadata,
): StoredAudiobookPosition | undefined {
  if (!serialized) return undefined
  try {
    const value: unknown = JSON.parse(serialized)
    if (
      !isRecord(value) ||
      value.audioId !== metadata.audiobook.audioId ||
      !finiteNumber(value.positionSeconds) ||
      value.positionSeconds < 0 ||
      value.positionSeconds > metadata.audiobook.durationSeconds ||
      !finiteNumber(value.updatedAt)
    ) {
      return undefined
    }
    return {
      audioId: value.audioId,
      positionSeconds: value.positionSeconds,
      updatedAt: value.updatedAt,
    }
  } catch {
    return undefined
  }
}
