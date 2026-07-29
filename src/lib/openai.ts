import type { Role } from '../db/types'

export interface ChatMessage {
  role: Role
  content: string
}

export class OpenAIError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

interface StreamOptions {
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onDelta: (text: string) => void
}

/** Streams a chat completion, calling `onDelta` for each token chunk. */
export async function streamChat({
  apiKey,
  model,
  messages,
  signal,
  onDelta,
}: StreamOptions): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

  if (!response.ok || !response.body) {
    throw new OpenAIError(await errorMessage(response), response.status)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let complete = false

  const consume = (frame: string) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        complete = true
        continue
      }
      try {
        const parsed = JSON.parse(payload)
        const delta: string = parsed.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // Ignore keep-alives and any non-JSON frames.
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line; keep any partial tail buffered.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) consume(frame)
  }

  // A final frame arriving without its trailing blank line is still a whole
  // frame; flush it rather than dropping the last of the answer.
  if (buffer.trim()) consume(buffer)

  // OpenAI closes the stream with [DONE]. Reaching EOF without it means the
  // connection dropped mid-answer, so `full` is a fragment. Returning it would
  // store a truncated reply that looks complete.
  if (!complete) {
    throw new OpenAIError(
      'The reply was cut off before it finished. Check your connection and try again.',
    )
  }

  return full
}

/** Non-streaming call, used for background summaries. */
export async function completeChat({
  apiKey,
  model,
  messages,
  signal,
}: Omit<StreamOptions, 'onDelta'>): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
    signal,
  })

  if (!response.ok) throw new OpenAIError(await errorMessage(response), response.status)
  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

export async function verifyKey(apiKey: string, model: string): Promise<void> {
  await completeChat({
    apiKey,
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  })
}

async function errorMessage(response: Response): Promise<string> {
  let detail = ''
  try {
    const body = await response.json()
    detail = body?.error?.message ?? ''
  } catch {
    // Non-JSON error body.
  }
  if (response.status === 401) {
    return detail || 'That API key was rejected. Check it in Settings.'
  }
  if (response.status === 429) {
    return detail || 'Rate limited or out of quota. Try again shortly.'
  }
  return detail || `OpenAI request failed (${response.status}).`
}
