import { EpubCFI, type Contents, type NavItem } from 'epubjs'

export interface ChapterAnchor {
  label: string
  href: string
  /** CFI of the anchor element, used to compare against the reading position. */
  cfi?: string
}

const cfiComparator = new EpubCFI()

export function normalizeHref(href: string): string {
  return href.split('#')[0].replace(/^\.?\//, '')
}

export function sameDoc(a: string, b: string): boolean {
  return normalizeHref(a) === normalizeHref(b)
}

export function flattenToc(toc: NavItem[]): NavItem[] {
  const out: NavItem[] = []
  const walk = (items: NavItem[]) => {
    for (const item of items) {
      out.push(item)
      if (item.subitems?.length) walk(item.subitems)
    }
  }
  walk(toc)
  return out
}

/**
 * Builds the ordered list of TOC anchors inside one spine document.
 *
 * Many EPUBs (Project Gutenberg's especially) put the whole book in a single
 * XHTML file and split chapters with `#anchor` fragments, so matching the TOC on
 * document href alone would mark every chapter as current at once. Resolving
 * each anchor to a CFI lets the position be compared properly.
 */
export function buildAnchors(
  toc: NavItem[],
  href: string,
  contents: Contents,
): ChapterAnchor[] {
  const candidates = flattenToc(toc).filter(
    (item) => item.href && sameDoc(item.href, href),
  )

  return candidates.map((item) => {
    const anchor: ChapterAnchor = {
      label: item.label?.trim() || 'Untitled',
      href: item.href,
    }
    const hash = item.href.split('#')[1]
    if (!hash) return anchor
    try {
      const el =
        contents.document.getElementById(hash) ??
        contents.document.querySelector(`[name="${CSS.escape(hash)}"]`)
      if (el) anchor.cfi = contents.cfiFromNode(el)
    } catch {
      // Anchor missing or unaddressable; fall back to document-level matching.
    }
    return anchor
  })
}

/** Picks the last anchor at or before the current position. */
export function chapterAt(anchors: ChapterAnchor[], cfi: string): ChapterAnchor | undefined {
  if (anchors.length === 0) return undefined
  if (anchors.length === 1) return anchors[0]

  let current: ChapterAnchor | undefined
  for (const anchor of anchors) {
    if (!anchor.cfi) {
      // An anchorless entry represents the document as a whole.
      current ??= anchor
      continue
    }
    try {
      if (cfiComparator.compare(anchor.cfi, cfi) <= 0) current = anchor
      else break
    } catch {
      // Incomparable CFIs (different spine positions); keep what we have.
    }
  }
  return current ?? anchors[0]
}
