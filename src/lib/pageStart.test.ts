// @vitest-environment jsdom
import type { Contents } from 'epubjs'
import { describe, expect, it } from 'vitest'
import { pageStart } from './pageStart'

const BASE = '/6/4'

/** A stand-in for epub.js Contents: the CFI's offset into one paragraph's text. */
function contentsOf(text: string): Contents {
  const doc = new DOMParser().parseFromString(`<p>${text}</p>`, 'text/html')
  const node = doc.querySelector('p')!.firstChild!
  return {
    cfiBase: BASE,
    range: (cfi: string) => {
      const range = doc.createRange()
      range.setStart(node, Number(cfi.match(/:(\d+)\)$/)![1]))
      return range
    },
    cfiFromRange: (range: Range) => `epubcfi(${BASE}!/4/2/1:${range.startOffset})`,
  } as unknown as Contents
}

const at = (offset: number) => `epubcfi(${BASE}!/4/2/1:${offset})`

describe('pageStart', () => {
  it('moves past the line break and indentation that end the previous column', () => {
    const text = 'head of the boat,\n        threatening'
    expect(pageStart(contentsOf(text), at(17))).toBe(at(text.indexOf('threatening')))
  })

  it('leaves a CFI that already starts on a visible character', () => {
    expect(pageStart(contentsOf('Call me Ishmael.'), at(5))).toBe(at(5))
  })

  it('leaves trailing whitespace with nothing after it', () => {
    expect(pageStart(contentsOf('the end.   '), at(8))).toBe(at(8))
  })

  it('leaves a CFI in a section that is not rendered', () => {
    const elsewhere = 'epubcfi(/6/8!/4/2/1:0)'
    expect(pageStart(contentsOf(' text'), elsewhere)).toBe(elsewhere)
  })

  it('leaves the CFI when there is nothing rendered to measure', () => {
    expect(pageStart(undefined, at(3))).toBe(at(3))
  })
})
