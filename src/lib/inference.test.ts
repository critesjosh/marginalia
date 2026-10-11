import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../db/types'
import { completeChat, InferenceError, streamChat, targetFor, type Target } from './inference'

const HOSTED: Target = { provider: 'hosted' }
const messages = [{ role: 'user' as const, content: 'Synthetic question' }]

/** Serves `chunks` as one SSE body, split exactly where the strings split. */
function sse(...chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

function respondWith(response: Response) {
  const fetch = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function stream(response: Response) {
  respondWith(response)
  const deltas: string[] = []
  const full = await streamChat({ target: HOSTED, messages, onDelta: (d) => deltas.push(d) })
  return { full, deltas }
}

afterEach(() => vi.unstubAllGlobals())

describe('streamChat', () => {
  it('joins deltas, including frames split across chunks', async () => {
    const frames = delta('Call me ') + ': keepalive\n\n' + delta('Ishmael.')
    const cut = frames.indexOf('Ishmael') - 3
    const { full, deltas } = await stream(
      sse(frames.slice(0, cut), frames.slice(cut), 'data: [DONE]\n\n'),
    )
    expect(full).toBe('Call me Ishmael.')
    expect(deltas).toEqual(['Call me ', 'Ishmael.'])
  })

  it('keeps a last frame that arrives without its blank line', async () => {
    const { full } = await stream(sse(delta('Done'), 'data: [DONE]'))
    expect(full).toBe('Done')
  })

  it('rejects a stream that ends without [DONE] rather than storing a fragment', async () => {
    await expect(stream(sse(delta('Half an ans')))).rejects.toThrow(/cut off/)
  })

  it('surfaces an error sent in-band after the headers', async () => {
    const failure = `data: ${JSON.stringify({ error: { message: 'Provider fell over', code: 502 } })}\n\n`
    await expect(stream(sse(delta('Partial'), failure))).rejects.toMatchObject({
      message: 'Provider fell over',
      status: 502,
    })
  })

  it('posts to the hosted relay without a key', async () => {
    const fetch = respondWith(sse('data: [DONE]\n\n'))
    await streamChat({ target: HOSTED, messages, onDelta: () => {} })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/chat')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(init.body as string)).toEqual({ messages, stream: true })
  })
})

describe('error messages', () => {
  const failWith = (status: number, body?: object) =>
    respondWith(new Response(body ? JSON.stringify(body) : 'gateway', { status }))

  it.each([
    [401, /key was rejected/],
    [429, /Rate limited/],
    [502, /unavailable right now/],
    [418, /failed \(418\)/],
  ])('explains a bare %i', async (status, message) => {
    failWith(status)
    const error = await completeChat({ target: HOSTED, messages }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InferenceError)
    expect(error).toMatchObject({ status, message: expect.stringMatching(message) })
  })

  it("prefers the relay's own message", async () => {
    failWith(503, { error: { message: 'This deployment has no inference key configured.' } })
    await expect(completeChat({ target: HOSTED, messages })).rejects.toThrow(/no inference key/)
  })
})

describe('targetFor', () => {
  it('uses the hosted relay unless the reader chose OpenAI', () => {
    expect(targetFor(DEFAULT_SETTINGS)).toEqual(HOSTED)
  })

  it('asks for a key before an OpenAI request', () => {
    expect(() => targetFor({ ...DEFAULT_SETTINGS, provider: 'openai' })).toThrow(/Add your OpenAI/)
  })

  it('uses the summary model for digests, falling back to the chat model', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      apiKey: 'sk-synthetic',
      model: 'chat-model',
      summaryModel: 'summary-model',
    }
    expect(targetFor(settings, 'summary')).toMatchObject({ model: 'summary-model' })
    expect(targetFor({ ...settings, summaryModel: '' }, 'summary')).toMatchObject({
      model: 'chat-model',
    })
  })
})
