import type { Role, Settings } from '../db/types'

export interface ChatMessage {
  role: Role
  content: string
}

export class InferenceError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/** Raised when the reader picked their own OpenAI key but has not entered one. */
export class MissingKeyError extends InferenceError {}

/**
 * Where a request goes. `hosted` is this site's own relay, which holds an
 * OpenRouter key server-side and pins the model, so visitors need no setup.
 */
export type Target =
  | { provider: 'hosted' }
  | { provider: 'openai'; apiKey: string; model: string }

const HOSTED_ENDPOINT = '/api/chat'
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'

/** Model shown in the UI; the relay pins the real value server-side. */
export const HOSTED_MODEL_LABEL = 'Gemma 4 26B (via OpenRouter)'

export function targetFor(settings: Settings, kind: 'chat' | 'summary' = 'chat'): Target {
  if (settings.provider !== 'openai') return { provider: 'hosted' }

  if (!settings.apiKey) {
    throw new MissingKeyError('Add your OpenAI API key in Settings, or switch back to the built-in model.')
  }
  return {
    provider: 'openai',
    apiKey: settings.apiKey,
    model: kind === 'summary' ? settings.summaryModel || settings.model : settings.model,
  }
}

interface RequestOptions {
  target: Target
  messages: ChatMessage[]
  signal?: AbortSignal
}

function post({ target, messages, signal }: RequestOptions, stream: boolean): Promise<Response> {
  if (target.provider === 'hosted') {
    return fetch(HOSTED_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream }),
      signal,
    })
  }

  return fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({ model: target.model, messages, stream }),
    signal,
  })
}

/** Streams a chat completion, calling `onDelta` for each token chunk. */
export async function streamChat({
  onDelta,
  ...options
}: RequestOptions & { onDelta: (text: string) => void }): Promise<string> {
  const response = await post(options, true)

  if (!response.ok || !response.body) {
    throw new InferenceError(await errorMessage(response), response.status)
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

      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        // Ignore keep-alives and any non-JSON frames.
        continue
      }

      // A failure after the response headers are committed cannot come back as
      // an HTTP status, so it arrives in-band: a frame carrying a top-level
      // `error` and an empty delta. Left unhandled it reads as a turn that
      // produced nothing, and any text streamed before it would be stored as a
      // complete answer.
      if (parsed?.error) {
        throw new InferenceError(
          parsed.error.message || 'The model provider failed part-way through the reply.',
          parsed.error.code,
        )
      }

      const delta: string = parsed?.choices?.[0]?.delta?.content ?? ''
      if (delta) {
        full += delta
        onDelta(delta)
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

  // Both OpenAI and OpenRouter close the stream with [DONE]. Reaching EOF
  // without it means the connection dropped mid-answer, so `full` is a
  // fragment. Returning it would store a truncated reply that looks complete.
  if (!complete) {
    throw new InferenceError(
      'The reply was cut off before it finished. Check your connection and try again.',
    )
  }

  return full
}

/** Non-streaming call, used for background summaries. */
export async function completeChat(options: RequestOptions): Promise<string> {
  const response = await post(options, false)

  if (!response.ok) throw new InferenceError(await errorMessage(response), response.status)
  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

export async function verifyKey(apiKey: string, model: string): Promise<void> {
  await completeChat({
    target: { provider: 'openai', apiKey, model },
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
  return detail || `The chat request failed (${response.status}).`
}
