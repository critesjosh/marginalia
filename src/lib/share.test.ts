import { describe, expect, it, vi } from 'vitest'
import {
  APP_URL,
  bookShare,
  highlightShare,
  linkShare,
  prefersShareSheet,
  shareContent,
  threadShare,
} from './share'

const BOOK = { title: 'Moby Dick', author: 'Herman Melville' }

describe('highlightShare', () => {
  it('quotes the passage, cites the book and names the app', () => {
    const { title, text } = highlightShare(' Call me Ishmael. ', BOOK, 'Chapter 1. Loomings')
    expect(title).toBe('From Moby Dick')
    expect(text).toBe(
      `“Call me Ishmael.”\n\nMoby Dick by Herman Melville, Chapter 1. Loomings\n\nRead with Rami: ${APP_URL}`,
    )
  })

  it('does not double a quote the passage already opens with', () => {
    const { text } = highlightShare('“Oh, the rare old Whale,', BOOK)
    expect(text.startsWith('“Oh, the rare old Whale,\n\n')).toBe(true)
  })

  it('leaves out a missing author or chapter', () => {
    const { text } = highlightShare('Call me Ishmael.', { title: 'Moby Dick', author: '' })
    expect(text).toContain('\n\nMoby Dick\n\n')
  })
})

describe('threadShare', () => {
  it('lays out the passage and each turn, skipping system messages', () => {
    const { title, text } = threadShare(
      { title: 'Ishmael', seedText: 'Call me Ishmael.', chapter: 'Chapter 1' },
      [
        { role: 'system', content: 'hidden' },
        { role: 'user', content: 'Who is he?' },
        { role: 'assistant', content: 'The narrator.' },
      ],
      BOOK,
    )
    expect(title).toBe('Ishmael')
    expect(text.split('\n\n')).toEqual([
      'A conversation about Moby Dick by Herman Melville, Chapter 1',
      '“Call me Ishmael.”',
      'Me: Who is he?',
      'Rami: The narrator.',
      `Read with Rami: ${APP_URL}`,
    ])
  })
})

describe('linkShare', () => {
  it('drops a chapter label’s trailing period', () => {
    const { text } = linkShare({ title: 't', chapter: 'CHAPTER 1. Loomings.' }, BOOK, 'u')
    expect(text).toContain('CHAPTER 1. Loomings, on Rami')
  })

  it('introduces the link with its book', () => {
    expect(
      linkShare({ title: 'Ishmael', chapter: 'Chapter 1' }, BOOK, 'https://x.test/t/a'),
    ).toEqual({
      title: 'Ishmael',
      text: 'A conversation about Moby Dick by Herman Melville, Chapter 1, on Rami: https://x.test/t/a',
      copyText: 'https://x.test/t/a',
    })
  })

  it('copies only the link when there is no share sheet', async () => {
    const writeText = vi.fn(async () => {})
    const content = linkShare({ title: 't' }, BOOK, 'https://x.test/t/a')
    expect(await shareContent(content, { clipboard: { writeText } })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://x.test/t/a')
  })
})

describe('bookShare', () => {
  it('invites the recipient to read along, and copies the whole invitation', () => {
    const url = `${APP_URL}/b/abc`
    const content = bookShare({ title: 'Moby Dick', author: 'Herman Melville' }, url)
    expect(content.title).toBe('Moby Dick')
    expect(content.text).toBe(
      `I’m reading Moby Dick by Herman Melville on Rami. Read it with me: ${url}`,
    )
    expect(content.copyText).toBeUndefined()
  })
})

describe('prefersShareSheet', () => {
  const host = (coarse: boolean) =>
    ({ matchMedia: () => ({ matches: coarse }) }) as unknown as Pick<Window, 'matchMedia'>

  it('offers the sheet to touch devices and copies on a desktop', () => {
    expect(prefersShareSheet(host(true))).toBe(true)
    expect(prefersShareSheet(host(false))).toBe(false)
    expect(prefersShareSheet({} as Pick<Window, 'matchMedia'>)).toBe(false)
  })
})

describe('shareContent', () => {
  const content = { title: 't', text: 'body' }

  it('prefers the share sheet', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn()
    expect(await shareContent(content, { share, clipboard: { writeText } })).toBe('shared')
    expect(share).toHaveBeenCalledWith(content)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('treats dismissing the sheet as a cancel, not a failure', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('', 'AbortError'))
    const writeText = vi.fn()
    expect(await shareContent(content, { share, clipboard: { writeText } })).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('copies when there is no share sheet or it refuses', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    expect(await shareContent(content, { clipboard: { writeText } })).toBe('copied')

    const share = vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError'))
    expect(await shareContent(content, { share, clipboard: { writeText } })).toBe('copied')

    const canShare = () => false
    expect(await shareContent(content, { share, canShare, clipboard: { writeText } })).toBe(
      'copied',
    )
    expect(writeText).toHaveBeenCalledTimes(3)
    expect(writeText).toHaveBeenCalledWith('body')
  })

  it('reports a blocked clipboard', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    expect(await shareContent(content, { clipboard: { writeText } })).toBe('failed')
    expect(await shareContent(content, {})).toBe('failed')
  })
})
