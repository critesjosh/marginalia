import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MarkdownReply from './MarkdownReply'

const render = (content: string) =>
  renderToStaticMarkup(createElement(MarkdownReply, null, content))

describe('MarkdownReply', () => {
  it('renders prose, emphasis, headings, lists, quotations, links and code', () => {
    const html = render(
      '# Reading\n\nA **bold** and *italic* thought with `code`.\n\n' +
        '- First\n- Second\n\n1. Ordered\n\n> Call me Ishmael.\n\n' +
        '```text\nconst whale = true\n```\n\n[Source](https://example.com)',
    )
    for (const tag of [
      'h1',
      'p',
      'strong',
      'em',
      'code',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'a',
    ]) {
      expect(html).toContain(`<${tag}`)
    }
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('keeps untrusted replies inert and does not load remote images', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://example.com/track" onerror="alert(1)">\n\n' +
        '[Bad](javascript:alert%281%29)\n\n![A whale](https://example.com/whale.png)',
    )
    expect(html).not.toMatch(/<script|<img|onerror|javascript:|https:\/\/example.com/)
    expect(html).toContain('A whale')
  })

  it('keeps single line breaks', () => {
    expect(render('Call me Ishmael.\nSome years ago')).toContain('Call me Ishmael.<br/>')
  })

  it('accepts unfinished Markdown chunks while streaming', () => {
    expect(render('A **growing')).toContain('A **growing')
    expect(render('A **growing thought**')).toContain('<strong>growing thought</strong>')
    expect(render('```text\nstill growing')).toContain('<pre><code')
  })
})
