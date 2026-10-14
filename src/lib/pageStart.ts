import type { Contents } from 'epubjs'

/**
 * Moves a page-start CFI off leading whitespace onto the first character the
 * page shows.
 *
 * epub.js reports a page's start as the first text offset in its column, which
 * is often the newline or space that ends the previous column's last line. To
 * display a CFI it measures the text from that offset to the next space and
 * floors its left edge to a column. Whitespace that ends a line sits at the
 * right edge of the previous column, so re-displaying the reader's own saved
 * position lands a page short. Closing a chat thread re-anchors after the
 * keyboard resizes the reader, and lost that page every time.
 */
export function pageStart(contents: Contents | undefined, cfi: string): string {
  // Only the rendered section can be measured; others re-anchor once loaded.
  if (!contents?.cfiBase || !cfi.startsWith(`epubcfi(${contents.cfiBase}!`)) return cfi
  try {
    const range = contents.range(cfi)
    const node = range?.startContainer
    if (!node || node.nodeType !== Node.TEXT_NODE) return cfi
    const text = node.textContent ?? ''
    let offset = range.startOffset
    while (offset < text.length && /\s/.test(text[offset])) offset++
    if (offset === range.startOffset || offset === text.length) return cfi
    range.setStart(node, offset)
    range.collapse(true)
    return contents.cfiFromRange(range)
  } catch {
    return cfi
  }
}
