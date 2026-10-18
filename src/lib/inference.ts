import type { Role } from '../db/types'
import { BRIDGE_UNREACHABLE, bridgeFetch, localAgentState } from './localAgent'

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

const HOSTED_ENDPOINT = '/api/chat'

interface RequestOptions {
  messages: ChatMessage[]
  signal?: AbortSignal
}

/**
 * Requests go to this site's own relay, which holds an OpenRouter key
 * server-side and pins the model, so visitors need no setup. A reader paired
 * with a local agent (decision 0010) is answered by it instead, and never falls
 * back to the relay: their passages would go somewhere they chose not to send them.
 */
async function post({ messages, signal }: RequestOptions, stream: boolean): Promise<Response> {
  const body = JSON.stringify({ messages, stream })
  const headers = { 'Content-Type': 'application/json' }
  const agent = localAgentState()

  if (agent.kind === 'unreadable') {
    throw new InferenceError(
      "Rami can't read its local agent setting in this browser, so it sent nothing. Check that " +
        'this site may store data, then pair again in Settings.',
    )
  }
  if (agent.kind === 'off') {
    return fetch(HOSTED_ENDPOINT, { method: 'POST', headers, body, signal })
  }
  try {
    return await bridgeFetch('/v1/chat', agent.token, { method: 'POST', headers, body, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new InferenceError(BRIDGE_UNREACHABLE)
  }
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
        // Ignore keepalives and any non-JSON frames.
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

  // OpenRouter closes the stream with [DONE]. Reaching EOF
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
  // A 5xx without a JSON body did not come from the relay — it is the platform
  // reporting that the relay itself fell over. A bare status code tells the
  // reader nothing they can act on, so say what it means instead.
  if (response.status >= 500) {
    return detail || 'The model provider is unavailable right now. Try again in a moment.'
  }
  return detail || `The chat request failed (${response.status}).`
}
