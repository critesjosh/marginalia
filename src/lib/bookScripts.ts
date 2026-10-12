const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/**
 * Blocks every script a book section could run, before epub.js renders it.
 *
 * The book frame has to allow scripts: WebKit, and so every iPad and iPhone
 * browser, never calls listeners the app adds to a frame sandboxed without
 * `allow-scripts`, so taps, long presses and selection all go dead. With
 * `allow-same-origin` beside it, a book script would run on this origin and
 * could read every note and conversation out of IndexedDB. This puts the
 * book's own code back out of reach.
 *
 * The policy is the guarantee; the rest is a second layer. Script elements are
 * kept with a type no browser runs, rather than removed, so element positions
 * and with them saved CFIs are unchanged.
 */
export function neutralizeScripts(doc: Document, section?: { contents?: Element }): void {
  // XML keeps the case of names, but the frame's HTML parser folds it, so
  // `<SCRIPT>` or `HTTP-EQUIV` must be caught here too.
  const named = (node: Element | Attr, name: string) => node.localName.toLowerCase() === name

  let root = doc.documentElement
  if (!root) return

  // Anything else, an SVG content document say, ends up inside the body the
  // frame's parser opens, with no head of its own to carry the policy.
  if (!named(root, 'html')) {
    const html = doc.createElementNS(XHTML_NS, 'html')
    const body = doc.createElementNS(XHTML_NS, 'body')
    doc.replaceChild(html, root)
    body.appendChild(root)
    html.appendChild(body)
    root = html
    // epub.js took this reference before the hooks ran and serializes it, not
    // the document, so it has to follow the new root.
    if (section) section.contents = html
  }

  // The policy only counts inside the head the frame's parser opens, which is
  // the first thing in the document. A head after the body is ignored, policy
  // and all, so it is not good enough.
  let head = root.firstElementChild
  if (!head || !named(head, 'head')) {
    // The frame's parser would open one here anyway, so CFIs agree.
    head = doc.createElementNS(XHTML_NS, 'head')
    root.insertBefore(head, root.firstChild)
  }

  // First in the head: a policy covers only what the parser meets after it.
  const policy = doc.createElementNS(XHTML_NS, 'meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'")
  head.insertBefore(policy, head.firstChild)

  for (const element of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    const script = named(element, 'script')
    for (const attribute of Array.from(element.attributes)) {
      const strip =
        // Every attribute of a script, or a leftover `TYPE` would win over ours.
        script ||
        /^on/i.test(attribute.localName) ||
        // A refresh would navigate the frame to a raw book file that skipped
        // this pass, and the frame keeps its sandbox, scripts and all.
        (named(attribute, 'http-equiv') && attribute.value.trim().toLowerCase() === 'refresh')
      if (strip) element.removeAttributeNode(attribute)
    }
    if (script) element.setAttribute('type', 'text/plain')
  }
}

/**
 * Keeps the book frame on the section it was given.
 *
 * epub.js follows HTML links itself, from their `onclick`, which still runs. Any
 * other link, an SVG `<a>` say, would navigate the frame to a book file or a
 * blob of one that never passed through `neutralizeScripts`, and the frame
 * would run its scripts on this origin.
 */
export function keepFrameInPlace(doc: Document): () => void {
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.('a, area')
    if (!link) return
    const href = link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? ''
    if (!href.trim().toLowerCase().startsWith('mailto:')) event.preventDefault()
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}
