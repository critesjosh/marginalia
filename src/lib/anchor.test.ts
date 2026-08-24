// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findInDocument, normalizeQuery } from './anchor'

/**
 * The map from normalised text back to DOM positions is the part of the import
 * that can be wrong without looking wrong: a range one character off still
 * produces a plausible CFI and paints a highlight in roughly the right place.
 * So these assert on the exact text a produced range covers.
 */

function documentOf(body: string): Document {
  return new DOMParser().parseFromString(
    `<html><body>${body}</body></html>`,
    'text/html',
  )
}

function find(body: string, query: string): string | undefined {
  return findInDocument(documentOf(body), query)?.toString()
}

describe('normalizeQuery', () => {
  it('collapses every kind of whitespace to single spaces', () => {
    expect(normalizeQuery('  the   whale \n\t was  ')).toBe('the whale was')
  })

  it('drops the invisible characters that justification leaves behind', () => {
    expect(normalizeQuery('un­be​liev﻿able')).toBe('unbelievable')
  })

  it('treats a non-breaking space as a space', () => {
    expect(normalizeQuery('Moby Dick')).toBe('moby dick')
  })

  it('folds typographic punctuation to its ASCII equivalent', () => {
    expect(normalizeQuery('“whale’s”—yes')).toBe('"whale\'s"-yes')
  })

  it('folds case', () => {
    expect(normalizeQuery('Call Me ISHMAEL')).toBe('call me ishmael')
  })

  it('is empty for input with nothing in it', () => {
    expect(normalizeQuery('   \n  ')).toBe('')
  })
})

describe('findInDocument', () => {
  it('finds a passage and covers exactly it', () => {
    expect(find('<p>Call me Ishmael. Some years ago.</p>', 'me Ishmael')).toBe('me Ishmael')
  })

  it('matches across the line breaks a highlight is stored without', () => {
    const body = '<p>Call me\n   Ishmael. Some\nyears ago.</p>'
    expect(find(body, 'Call me Ishmael.')).toBe('Call me\n   Ishmael.')
  })

  it('matches a query whose case and punctuation differ from the file', () => {
    const body = '<p>“Call me Ishmael”</p>'
    expect(find(body, '"call me ishmael"')).toBe('“Call me Ishmael”')
  })

  it('matches through a soft hyphen in the file', () => {
    expect(find('<p>un­believable whale</p>', 'unbelievable')).toBe('un­believable')
  })

  it('spans inline elements', () => {
    const body = '<p>a very <em>large</em> whale indeed</p>'
    expect(find(body, 'very large whale')).toBe('very <em>large</em> whale'.replace(/<[^>]+>/g, ''))
  })

  it('refuses to run two paragraphs together', () => {
    // Without a block boundary the haystack would read "…seaBut…", and a
    // highlight that spans the two paragraphs would have to be written that way
    // to match. The boundary is what makes the natural form the one that works.
    const body = '<p>He went to sea</p><p>But not today</p>'
    expect(find(body, 'seaBut')).toBeUndefined()
    expect(find(body, 'sea But')).toBe('seaBut')
  })

  it('does not read script or style content as prose', () => {
    const body = '<style>p { color: whale }</style><p>the real whale</p>'
    expect(find(body, 'whale')).toBe('whale')
  })

  it('ignores text hidden by an inline style or the hidden attribute', () => {
    const body = '<p style="display:none">a hidden whale</p><p>a visible whale</p>'
    expect(find(body, 'a visible whale')).toBe('a visible whale')
    expect(find(body, 'a hidden whale')).toBeUndefined()

    const attribute = '<p hidden>ghost text</p><p>real text</p>'
    expect(find(attribute, 'ghost text')).toBeUndefined()
  })

  it('declines a passage that appears twice', () => {
    const body = '<p>the whale</p><p>something else</p><p>the whale</p>'
    expect(find(body, 'the whale')).toBeUndefined()
  })

  it('declines a passage that is not there', () => {
    expect(find('<p>Call me Ishmael.</p>', 'call me Fedallah')).toBeUndefined()
  })

  it('handles a passage that starts a block', () => {
    const body = '<p>first para</p><p>Ishmael speaks here</p>'
    expect(find(body, 'Ishmael speaks')).toBe('Ishmael speaks')
  })

  it('handles a passage that ends a block', () => {
    const body = '<p>Ishmael speaks here</p><p>next para</p>'
    expect(find(body, 'speaks here')).toBe('speaks here')
  })

  it('keeps its bearings past astral characters', () => {
    const body = '<p>a 🐋 whale of a passage</p>'
    expect(find(body, 'whale of a passage')).toBe('whale of a passage')
  })

  it('keeps its bearings past a character whose lowercase is longer', () => {
    // İ lowercases to two code units, so the map is not one-to-one here.
    const body = '<p>İstanbul and the whale</p>'
    expect(find(body, 'and the whale')).toBe('and the whale')
  })
})
