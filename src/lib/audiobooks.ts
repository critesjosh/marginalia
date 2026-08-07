export const AUDIOBOOK_WORKER_URL = 'https://marginalia-audiobooks.cloudflare-cdd.workers.dev'

export interface AudiobookMetadata {
  title?: string
}

export interface AudiobookSession {
  audioUrl: string
  metadataUrl: string
  expiresAt: number
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

export async function loadAudiobookMetadata(url: string): Promise<AudiobookMetadata> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not load audiobook metadata.')
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('Invalid audiobook metadata.')
  const title = 'title' in body && typeof body.title === 'string' ? body.title : undefined
  return { title }
}
