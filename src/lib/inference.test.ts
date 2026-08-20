import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from './inference'

/** An SSE body shaped like the relay's, delivered in one read. */
function stream(frames: string[], headers: Record<string, string> = {}): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  })
}

function chunk(content: string, provider?: string): string {
  return JSON.stringify({
    ...(provider ? { provider } : {}),
    choices: [{ delta: { content } }],
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function run() {
  return streamChat({
    target: { provider: 'hosted' },
    messages: [{ role: 'user', content: 'why does he say that?' }],
    onDelta: () => {},
  })
}

describe('reply attribution', () => {
  it('records the route and the provider that produced the answer', async () => {
    fetchMock.mockResolvedValue(
      stream([chunk('Because ', 'Cloudflare'), chunk('he means it.')], {
        'X-Marginalia-Route': 'paid',
      }),
    )

    const reply = await run()

    expect(reply.text).toBe('Because he means it.')
    // Without this, a reply discussing `[PERSON_NAME]` gives no clue which of
    // the providers behind one model rewrote the prompt to produce it.
    expect(reply.source).toBe('paid · Cloudflare')
  })

  it('reports whichever half the reply actually carried', async () => {
    // A provider that names itself on no chunk still leaves the route known.
    fetchMock.mockResolvedValueOnce(stream([chunk('Yes.')], { 'X-Marginalia-Route': 'free' }))
    expect((await run()).source).toBe('free')

    // A reader's own key does not go through the relay, so neither is present.
    fetchMock.mockResolvedValueOnce(stream([chunk('Yes.')]))
    expect((await run()).source).toBeUndefined()
  })

  it('keeps the first provider it is told, not the last', async () => {
    fetchMock.mockResolvedValue(
      stream([chunk('a', 'Google AI Studio'), chunk('b', 'Google AI Studio')]),
    )

    expect((await run()).source).toBe('Google AI Studio')
  })
})
