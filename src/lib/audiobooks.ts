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
  expiresAt: number
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
    typeof body.expiresAt !== 'number'
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
