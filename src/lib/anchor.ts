import { EpubCFI, type Book as EpubBook } from 'epubjs'

/**
 * Finding a passage of prose in an EPUB and turning it into a CFI range.
 *
 * KOReader anchors a highlight with a crengine xpointer
 * (`/body/DocFragment[3]/body/p[1]/text()[3].38`); this reader anchors one with
 * an epub.js CFI. They are different coordinate systems over different parse
 * trees, and there is no conversion between them. What both agree on is the
 * text, so that is what an imported highlight is re-anchored by.
 *
 * epub.js has `section.search`, but it matches with a case-folded `indexOf` on
 * raw `textContent`. A KOReader highlight has been through a different
 * renderer: it joins across line breaks, carries soft hyphens from justified
 * text, and may hold typographic quotes where the file has straight ones. Raw
 * matching misses those, so this normalises both sides and keeps a map back to
 * the DOM.
 *
 * Two rules make the result trustworthy rather than merely likely:
 *
 * - **Uniqueness is judged across the whole book.** A sentence that appears in
 *   chapter 2 and again in chapter 10 is ambiguous, and accepting whichever
 *   section happened to be searched first would silently anchor half the
 *   import to the wrong place.
 * - **A match must survive a round trip.** The CFI is resolved back to a range
 *   and its text compared with the query. A locator that cannot prove its own
 *   answer declines instead.
 */

/** Why a passage could not be anchored, in words the import summary can use. */
export type AnchorFailure =
  | 'not-found'
  | 'ambiguous'
  | 'unverified'
  | 'section-failed'
  | 'incomplete-book'

export interface AnchorMatch {
  cfiRange: string
  sectionHref: string
}

export type AnchorResult = AnchorMatch | { failure: AnchorFailure }

export function isMatch(result: AnchorResult): result is AnchorMatch {
  return 'cfiRange' in result
}

/**
 * Folds a single code point to zero or more comparison characters.
 *
 * Deliberately per-code-point and never context-dependent, because every
 * output character has to be attributable to the source characters it came
 * from — that map is what turns a string offset back into a DOM range. A fold
 * may produce more than one character (a ligature, or a locale-uppercase
 * letter), and those simply share a source span.
 *
 * Unicode normalisation is *not* applied. NFC can merge a base letter and a
 * combining mark into one character, which would break the correspondence this
 * relies on, and both sides of the comparison come from the same EPUB file, so
 * they are already in whatever form that file uses.
 */
function fold(codePoint: string): string {
  switch (codePoint) {
    // Invisible characters that justification and hyphenation leave behind.
    case '­': // soft hyphen
    case '​': // zero-width space
    case '‌': // zero-width non-joiner
    case '‍': // zero-width joiner
    case '﻿': // zero-width no-break space
      return ''
    // Spaces that are not the space key.
    case ' ':
    case ' ':
    case ' ':
      return ' '
    case '‘':
    case '’':
    case '‛':
    case '′':
      return "'"
    case '“':
    case '”':
    case '‟':
    case '″':
      return '"'
    case '‐':
    case '‑':
    case '‒':
    case '–':
    case '—':
    case '―':
      return '-'
    default:
      return codePoint.toLowerCase()
  }
}

const WHITESPACE = /\s/

/** A block boundary, so adjacent paragraphs cannot fuse into `lastwordFirstword`. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'div', 'dd',
  'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'td', 'th', 'tr', 'ul',
])

/** Never part of the prose. */
const SKIPPED_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript'])

/**
 * Where one normalised character came from.
 *
 * `start` and `end` are separate because a fold is not one-to-one: two output
 * characters can share one source character, and one output character can
 * cover several. A range takes the start of its first character and the end of
 * its last.
 */
interface CharSource {
  node: Text
  start: number
  end: number
}

interface SectionText {
  /** Normalised, whitespace-collapsed, lowercased prose. */
  text: string
  /** Parallel to `text`; absent when only the text was wanted. */
  sources?: CharSource[]
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  const style = element.getAttribute('style')
  if (!style) return false
  // Only the element's own inline style can be read here: a section loaded
  // outside a rendition has no stylesheets applied, so `getComputedStyle`
  // would confidently report every element as visible.
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)
}

/**
 * Normalises a section document, optionally recording where each character came from.
 *
 * The same routine serves both passes so the index built for searching and the
 * map built for resolving can never drift apart.
 */
function normalizeDocument(doc: Document, withSources: boolean): SectionText {
  const out: string[] = []
  const sources: CharSource[] | undefined = withSources ? [] : undefined

  /** True when the last character emitted was a space, or nothing has been. */
  let atBoundary = true

  /**
   * Emits folded output for one source character.
   *
   * One source entry per UTF-16 unit, not per character: `text.indexOf` returns
   * a unit offset, so a map indexed by anything else silently slides out of
   * step after the first astral character in the book.
   */
  const push = (chars: string, node: Text, start: number, end: number) => {
    out.push(chars)
    if (sources) {
      for (let i = 0; i < chars.length; i += 1) sources.push({ node, start, end })
    }
  }

  /** Emits a single separating space, unless one is already pending. */
  const breakBlock = () => {
    if (out.length > 0) atBoundary = true
  }

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      const data = text.data
      let index = 0
      while (index < data.length) {
        const codePoint = String.fromCodePoint(data.codePointAt(index) as number)
        const start = index
        index += codePoint.length
        const end = index

        // The fold runs first because some characters JavaScript calls
        // whitespace are ones this drops outright — U+FEFF among them — and
        // treating those as a word boundary would insert a space that the
        // highlight being matched does not have.
        const folded = fold(codePoint)
        if (!folded) continue

        if (folded === ' ' || WHITESPACE.test(folded)) {
          atBoundary = true
          continue
        }

        if (atBoundary && out.length > 0) {
          // The separator belongs to the character that follows it, so a range
          // starting here never begins on the space.
          push(' ', text, start, start)
        }
        atBoundary = false

        push(folded, text, start, end)
      }
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (SKIPPED_TAGS.has(tag) || isHidden(element)) return

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock) breakBlock()
    for (let child = element.firstChild; child; child = child.nextSibling) walk(child)
    if (isBlock) breakBlock()
  }

  if (doc.body) walk(doc.body)
  else if (doc.documentElement) walk(doc.documentElement)

  return { text: out.join(''), sources }
}

/** Normalises a query the same way the book is normalised. */
export function normalizeQuery(query: string): string {
  const out: string[] = []
  let atBoundary = true

  for (const codePoint of query) {
    // Same order as the document pass, for the same reason.
    const folded = fold(codePoint)
    if (!folded) continue
    if (folded === ' ' || WHITESPACE.test(folded)) {
      atBoundary = true
      continue
    }
    if (atBoundary && out.length > 0) out.push(' ')
    atBoundary = false
    out.push(folded)
  }

  return out.join('')
}

/**
 * Builds a DOM range covering `length` normalised characters from `offset`.
 *
 * `expected`, when given, is the normalised text the caller indexed earlier;
 * a mismatch means this document is not the one those offsets were measured
 * against, and no range from it can be trusted.
 */
export function rangeAt(
  doc: Document,
  offset: number,
  length: number,
  expected?: string,
): Range | undefined {
  const { text, sources } = normalizeDocument(doc, true)
  if (!sources) return undefined
  if (expected !== undefined && text !== expected) return undefined

  const first = sources[offset]
  const last = sources[offset + length - 1]
  if (!first || !last) return undefined

  const range = doc.createRange()
  range.setStart(first.node, first.start)
  range.setEnd(last.node, last.end)
  return range
}

/**
 * Finds a passage in one document and returns the range covering it.
 *
 * The whole-book locator judges uniqueness across the spine and uses `rangeAt`
 * directly; this is the same machinery over a single document, which is what
 * makes the normalisation and the character map testable on their own.
 */
export function findInDocument(doc: Document, query: string): Range | undefined {
  const needle = normalizeQuery(query)
  if (!needle) return undefined

  const { text } = normalizeDocument(doc, false)
  const found = occurrences(text, needle)
  if (found.length !== 1) return undefined

  return rangeAt(doc, found[0], needle.length, text)
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return found
    found.push(at)
    // Overlapping occurrences still count as separate places in the book.
    from = at + 1
  }
}

/**
 * The part of an epub.js `Section` this uses.
 *
 * epub.js does not export the class from its type definitions, and the shape
 * below is all that matters here.
 */
interface SpineSection {
  href: string
  document?: Document
  load(request: unknown): Promise<unknown>
  unload(): void
  cfiFromRange(range: Range): string
}

interface IndexedSection {
  section: SpineSection
  href: string
  text: string
}

/**
 * A book's prose, normalised once, so many passages can be located against it.
 *
 * Only the text is kept: the character map for a section is rebuilt on demand
 * when a match actually needs turning into a range. Keeping every map would
 * cost tens of megabytes on a long book for something used a few dozen times.
 */
export class BookAnchors {
  private readonly book: EpubBook
  private readonly sections: IndexedSection[]
  private readonly unreadable: number

  private constructor(book: EpubBook, sections: IndexedSection[], unreadable: number) {
    this.book = book
    this.sections = sections
    this.unreadable = unreadable
  }

  static async build(
    book: EpubBook,
    onProgress?: (done: number, total: number) => void,
  ): Promise<BookAnchors> {
    const spine = book.spine as unknown as { spineItems: SpineSection[] }
    const items = spine.spineItems ?? []
    const sections: IndexedSection[] = []
    let unreadable = 0

    for (let i = 0; i < items.length; i += 1) {
      const section = items[i]
      try {
        await section.load(book.load.bind(book))
        if (section.document) {
          sections.push({
            section,
            href: section.href,
            text: normalizeDocument(section.document, false).text,
          })
        } else {
          unreadable += 1
        }
      } catch {
        unreadable += 1
      } finally {
        try {
          section.unload()
        } catch {
          // Already gone.
        }
      }
      onProgress?.(i + 1, items.length)
    }

    return new BookAnchors(book, sections, unreadable)
  }

  /** How many spine sections were readable. Zero means nothing can be located. */
  get sectionCount(): number {
    return this.sections.length
  }

  /**
   * How many spine sections could not be read.
   *
   * Any at all and nothing can be anchored, because uniqueness is a claim about
   * the whole book: a passage found once among the sections that did load might
   * appear again in one that did not, and there is no way to know.
   */
  get unreadableCount(): number {
    return this.unreadable
  }

  /**
   * Anchors one passage, or explains why it could not be.
   */
  async locate(query: string): Promise<AnchorResult> {
    // Uniqueness is a claim about the whole book. If part of the spine never
    // indexed, that claim cannot be made about anything, so nothing is placed
    // rather than everything being placed on incomplete evidence.
    if (this.unreadable > 0) return { failure: 'incomplete-book' }

    const needle = normalizeQuery(query)
    if (!needle) return { failure: 'not-found' }

    let hit: { indexed: IndexedSection; offset: number } | undefined
    for (const indexed of this.sections) {
      const found = occurrences(indexed.text, needle)
      if (found.length === 0) continue
      // More than one place in this section, or a second section carrying it at
      // all, and there is no single answer to give.
      if (found.length > 1 || hit) return { failure: 'ambiguous' }
      hit = { indexed, offset: found[0] }
    }

    if (!hit) return { failure: 'not-found' }
    return this.resolve(hit.indexed, hit.offset, needle)
  }

  /** Turns a located offset into a verified CFI range. */
  private async resolve(
    indexed: IndexedSection,
    offset: number,
    needle: string,
  ): Promise<AnchorResult> {
    const { section } = indexed
    try {
      await section.load(this.book.load.bind(this.book))
      const doc = section.document
      if (!doc) return { failure: 'section-failed' }

      const range = rangeAt(doc, offset, needle.length, indexed.text)
      if (!range) return { failure: 'section-failed' }

      const cfiRange = section.cfiFromRange(range)
      if (!cfiRange) return { failure: 'section-failed' }

      // Prove it: resolve the CFI we just produced and check it still reads as
      // the passage we were asked for.
      const resolved = new EpubCFI(cfiRange).toRange(doc)
      if (!resolved || normalizeQuery(resolved.toString()) !== needle) {
        return { failure: 'unverified' }
      }

      return { cfiRange, sectionHref: indexed.href }
    } catch {
      return { failure: 'section-failed' }
    } finally {
      try {
        section.unload()
      } catch {
        // Already gone.
      }
    }
  }
}
