import type { Book as EpubBook, NavItem } from 'epubjs'
import { buildAnchors, chapterAt, compareCfi, type ChapterAnchor } from '../chapters'

/**
 * Cuts a whole book into addressable chunks of prose, without rendering it.
 *
 * Everything the app sent to a model before this file came out of the rendered
 * iframe -- one spine section, laid out, with the reader looking at it. That
 * cannot see the rest of the book. epub.js can load a spine document on its own
 * and address nodes inside it (`Section.cfiFromRange`), which is all an index
 * needs, so the crawl never touches the rendition.
 *
 * It runs on the main thread by necessity: a Worker has no `DOMParser`, and
 * epub.js parses each spine document into one. Sections are yielded between, so
 * the reader gets the thread back rather than losing a frame per chapter.
 */

/** Roughly 1,500 tokens. Blocks are never split, so chunks overshoot slightly. */
const CHUNK_CHARS = 6000

/**
 * Blocks worth indexing. Only the innermost match is kept, so a `blockquote`
 * wrapping a `p` contributes its text once rather than twice.
 */
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, pre, dd, dt, figcaption'

export interface ExtractedChunk {
  index: number
  href: string
  cfiStart: string
  chapter?: string
  /**
   * Chapters that begin inside this chunk, in order.
   *
   * A chunk is a fixed length of prose, so several short chapters can start
   * inside one, and `chapter` only names the one it opens in. Without this, an
   * outline built from the index quietly omits every chapter shorter than a
   * chunk -- 24 of Moby Dick's 141 entries.
   */
  chapterStarts: string[]
  /** Character offset of this chunk's start within the whole book. */
  charOffset: number
  text: string
}

export interface ExtractOptions {
  toc: NavItem[]
  /** Called between spine documents so a long book cannot freeze the reader. */
  yieldToUi?: () => Promise<void>
  /** Checked between spine documents; true abandons the crawl. */
  cancelled?: () => boolean
}

/** Minimal shape of an epub.js Section, which its own types describe loosely. */
interface LoadableSection {
  href: string
  document?: Document
  load(request?: unknown): Promise<unknown>
  unload(): void
  cfiFromElement(el: Element): string
}

interface SpineWithItems {
  spineItems?: LoadableSection[]
}

export async function extractChunks(
  book: EpubBook,
  { toc, yieldToUi, cancelled }: ExtractOptions,
): Promise<ExtractedChunk[]> {
  // Same request method epub.js passes internally, and the one that reads out of
  // the archive rather than the network for a book opened from a Blob.
  const request = book.load.bind(book)
  const sections = (book.spine as unknown as SpineWithItems).spineItems ?? []

  const chunks: ExtractedChunk[] = []
  let charOffset = 0

  for (const section of sections) {
    if (cancelled?.()) return chunks
    // Sequentially, and not through `spine.each`: that is `Array.forEach`, which
    // does not await, so every section would load at once and hold the whole
    // book in memory.
    try {
      await section.load(request)
      const doc = section.document
      if (!doc?.body) continue

      const anchors = buildAnchors(toc, section.href, {
        document: doc,
        cfiFromNode: (node: Node) => section.cfiFromElement(node as Element),
      })

      for (const chunk of chunksInSection(section, doc, anchors)) {
        chunks.push({ ...chunk, index: chunks.length, charOffset })
        charOffset += chunk.text.length
      }
    } catch {
      // A section that will not load or address is skipped: an index missing a
      // chapter is worth more than no index at all.
    } finally {
      // Or a 135-chapter book ends the crawl with every document still resident.
      section.unload()
    }

    await yieldToUi?.()
  }

  return chunks
}

type SectionChunk = Omit<ExtractedChunk, 'index' | 'charOffset'>

function chunksInSection(
  section: LoadableSection,
  doc: Document,
  anchors: ChapterAnchor[],
): SectionChunk[] {
  const blocks = leafBlocks(doc)
  if (blocks.length === 0) return []

  const chunks: SectionChunk[] = []
  let batch: Element[] = []
  let length = 0

  const flush = () => {
    if (batch.length === 0) return
    const chunk = buildChunk(section, batch, anchors)
    if (chunk) chunks.push(chunk)
    batch = []
    length = 0
  }

  for (const block of blocks) {
    const text = normalize(block.textContent ?? '')
    if (!text) continue

    batch.push(block)
    length += text.length
    if (length >= CHUNK_CHARS) flush()
  }
  flush()

  assignChapterStarts(chunks, anchors)
  return chunks
}

/**
 * Hands each chapter heading to the chunk it falls inside.
 *
 * Done after chunking rather than during: a chapter belongs to the last chunk
 * that starts at or before it, which is only known once the next chunk's start
 * exists.
 */
function assignChapterStarts(chunks: SectionChunk[], anchors: ChapterAnchor[]): void {
  if (chunks.length === 0) return

  for (const anchor of anchors) {
    if (!anchor.cfi) continue

    let target = 0
    for (let i = 1; i < chunks.length; i += 1) {
      const order = compareCfi(chunks[i].cfiStart, anchor.cfi)
      if (order === undefined) break
      if (order <= 0) target = i
      else break
    }

    const starts = chunks[target].chapterStarts
    if (starts[starts.length - 1] !== anchor.label) starts.push(anchor.label)
  }
}

function buildChunk(
  section: LoadableSection,
  blocks: Element[],
  anchors: ChapterAnchor[],
): SectionChunk | undefined {
  const text = blocks
    .map((block) => normalize(block.textContent ?? ''))
    .filter(Boolean)
    .join('\n\n')
  if (!text) return undefined

  let cfiStart: string
  try {
    // The first block's element path, deliberately, and never a range over the
    // batch. epub.js builds a range CFI from the range's containers and offsets,
    // and a boundary set with `setStartBefore` has the *parent* as its container
    // -- so the child index comes back as a character offset into the parent's
    // first text node. Every chunk in a section then produces something like
    // `/4,/1:20,/1:31`, which compares as the very start of the document, and the
    // whole section collapses onto its first chapter. An element CFI orders
    // correctly against a reading position, which is all the index needs.
    cfiStart = section.cfiFromElement(blocks[0])
  } catch {
    return undefined
  }

  return {
    href: section.href,
    cfiStart,
    chapter: chapterAt(anchors, cfiStart)?.label,
    chapterStarts: [],
    text,
  }
}

/**
 * Blocks with no block descendant, in document order.
 *
 * `querySelectorAll` returns a `blockquote` and the `p` inside it, and joining
 * both would duplicate that passage in the chunk text and in every excerpt drawn
 * from it. Keeping only the innermost match reads each passage once.
 */
function leafBlocks(doc: Document): Element[] {
  const all = [...doc.body.querySelectorAll(BLOCK_SELECTOR)]
  return all.filter((el) => !el.querySelector(BLOCK_SELECTOR))
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
