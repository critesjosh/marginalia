/**
 * Content identity for an imported file.
 *
 * Title and author do not identify a book: two editions share them while
 * numbering their sections differently, and a CFI, a highlight or a saved
 * position from one lands somewhere arbitrary in the other. Notes are only
 * ever reattached to the exact bytes they were taken against.
 */
export async function fingerprint(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
