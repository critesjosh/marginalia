import type { Contents, Rendition } from 'epubjs'
import type { HighlightColor } from '../db/types'

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#f59e0b',
  green: '#22c55e',
  blue: '#3b82f6',
  pink: '#ec4899',
}

/** Position of a selection in the reader's own coordinate space. */
export interface SelectionRect {
  top: number
  bottom: number
  left: number
  width: number
}

/**
 * Converts a CFI range's rect into coordinates relative to the reader viewport.
 *
 * epub.js lays a whole spine section out as one very wide strip of columns and
 * scrolls `.epub-container` across it, so rects from inside the iframe are
 * offset by that scroll position. A selection that runs across a page break
 * is measured by its part on the visible page: its overall box spans both
 * columns, from the top of one to the bottom of the other.
 */
export function selectionRect(contents: Contents, cfiRange: string): SelectionRect | undefined {
  try {
    const range = contents.range(cfiRange)
    if (!range) return undefined

    const frame = contents.document.defaultView?.frameElement
    const container = frame?.closest('.epub-container') as HTMLElement | null
    // Rects are frame coordinates; the page sits below the reader's top margin.
    const frameTop = frame?.getBoundingClientRect().top ?? 0
    const scrollLeft = container?.scrollLeft ?? 0
    const scrollRight = scrollLeft + (container?.clientWidth ?? Infinity)

    const visible = [...range.getClientRects()].filter(
      (r) => r.width > 0 && r.right > scrollLeft && r.left < scrollRight,
    )
    const rect = visible.length ? unionOf(visible) : range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.bottom === rect.top)) return undefined

    return {
      top: rect.top + frameTop,
      bottom: rect.bottom + frameTop,
      left: rect.left - scrollLeft,
      width: rect.width,
    }
  } catch {
    return undefined
  }
}

function unionOf(rects: DOMRect[]): SelectionRect {
  const left = Math.min(...rects.map((r) => r.left))
  const right = Math.max(...rects.map((r) => r.right))
  return {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left,
    width: right - left,
  }
}

/** Text of the selection, whitespace-normalized. */
export function selectionText(contents: Contents, cfiRange: string): string {
  try {
    return normalize(contents.range(cfiRange)?.toString() ?? '')
  } catch {
    return ''
  }
}

/**
 * Pulls the prose surrounding a selection so the model can see its context.
 *
 * Walks outward from the selection's block element through sibling blocks
 * rather than reading the whole document: single-file books put the entire text
 * in one body, which would be megabytes.
 */
export function contextAround(contents: Contents, cfiRange: string, charsEachSide = 1200): string {
  try {
    const range = contents.range(cfiRange)
    if (!range) return ''

    const block = nearestBlock(range.startContainer)
    if (!block) return ''

    const before: string[] = []
    for (let el = block.previousElementSibling; el; el = el.previousElementSibling) {
      const text = normalize(el.textContent ?? '')
      if (text) before.unshift(text)
      if (before.join(' ').length > charsEachSide) break
    }

    const after: string[] = []
    for (let el = block.nextElementSibling; el; el = el.nextElementSibling) {
      const text = normalize(el.textContent ?? '')
      if (text) after.push(text)
      if (after.join(' ').length > charsEachSide) break
    }

    const head = tail(before.join('\n\n'), charsEachSide)
    const body = normalize(block.textContent ?? '')
    const foot = head1(after.join('\n\n'), charsEachSide)

    return [head, body, foot].filter(Boolean).join('\n\n')
  } catch {
    return ''
  }
}

function nearestBlock(node: Node): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return el?.closest('p, li, blockquote, div, section, td, h1, h2, h3, h4, h5, h6') ?? el
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`
}

function head1(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Paints a highlight into the rendition. Safe to call repeatedly. */
export function paintHighlight(
  rendition: Rendition,
  id: string,
  cfiRange: string,
  color: HighlightColor,
  isDark: boolean,
  onClick: () => void,
) {
  try {
    rendition.annotations.add('highlight', cfiRange, { id }, onClick, `hl-${id}`, {
      fill: HIGHLIGHT_COLORS[color],
      'fill-opacity': isDark ? '0.32' : '0.28',
      // Multiply keeps dark text legible on light pages; on a dark page it
      // would erase the highlight, so leave the fill to composite normally.
      ...(isDark ? {} : { 'mix-blend-mode': 'multiply' }),
    })
  } catch {
    // A CFI that no longer resolves simply renders nothing.
  }
}

export function unpaintHighlight(rendition: Rendition, cfiRange: string) {
  try {
    rendition.annotations.remove(cfiRange, 'highlight')
  } catch {
    // Already gone.
  }
}
