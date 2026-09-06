// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { hasUnsupportedEncryption } from './epub'

const CHAPTER = 'OEBPS/text/chapter1.xhtml'
const FONT = 'OEBPS/fonts/book-font.otf'

const IDPF = 'http://www.idpf.org/2008/embedding'
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC'
const AES = 'http://www.w3.org/2001/04/xmlenc#aes256-cbc'

/** What book.resolve() hands back for a spine item: ZIP-root, leading slash. */
const SPINE = ['/OEBPS/text/chapter1.xhtml', '/OEBPS/text/chapter2.xhtml']

function encryptionXml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  ${entries}
</encryption>`
}

function encryptedData(uri: string, algorithm?: string): string {
  const method = algorithm
    ? `<enc:EncryptionMethod Algorithm="${algorithm}" />`
    : ''

  return `<enc:EncryptedData>
    ${method}
    <enc:CipherData>
      <enc:CipherReference URI="${uri}" />
    </enc:CipherData>
  </enc:EncryptedData>`
}

function check(xml: string, spine: string[] = SPINE): boolean {
  return hasUnsupportedEncryption(xml, spine)
}

describe('EPUB encryption detection', () => {
  it('rejects a spine document encrypted with an algorithm we cannot read', () => {
    expect(check(encryptionXml(encryptedData(CHAPTER, AES)))).toBe(true)
  })

  it('rejects an encrypted spine document that declares no algorithm', () => {
    expect(check(encryptionXml(encryptedData(CHAPTER)))).toBe(true)
  })

  it('rejects real-world Adobe ADEPT encryption', () => {
    const xml = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc" />
    <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
      <resource xmlns="http://ns.adobe.com/adept">urn:uuid:00000000-0000-0000-0000-000000000000</resource>
    </KeyInfo>
    <CipherData>
      <CipherReference URI="OEBPS/text/chapter1.xhtml" />
    </CipherData>
  </EncryptedData>
</encryption>`
    expect(check(xml)).toBe(true)
  })

  it('rejects a book that mixes font obfuscation with encrypted content', () => {
    const xml = encryptionXml(
      encryptedData(FONT, IDPF) + encryptedData(CHAPTER, AES),
    )
    expect(check(xml)).toBe(true)
  })

  it('reads the algorithm off the entry, not the wrapped key', () => {
    const xml = encryptionXml(`<enc:EncryptedData>
      <enc:KeyInfo>
        <enc:EncryptedKey>
          <enc:EncryptionMethod Algorithm="${IDPF}" />
        </enc:EncryptedKey>
      </enc:KeyInfo>
      <enc:EncryptionMethod Algorithm="${AES}" />
      <enc:CipherData>
        <enc:CipherReference URI="${CHAPTER}" />
      </enc:CipherData>
    </enc:EncryptedData>`)
    expect(check(xml)).toBe(true)
  })

  it('matches spine paths whichever side is percent-encoded', () => {
    const xml = encryptionXml(encryptedData('OEBPS/text/chapter%201.xhtml', AES))
    expect(check(xml, ['/OEBPS/text/chapter 1.xhtml'])).toBe(true)
  })

  it('accepts the standard IDPF font-obfuscation algorithm', () => {
    expect(check(encryptionXml(encryptedData(FONT, IDPF)))).toBe(false)
  })

  it('accepts the legacy Adobe font-obfuscation algorithm', () => {
    expect(check(encryptionXml(encryptedData(FONT, ADOBE)))).toBe(false)
  })

  it('accepts encryption on resources outside the spine', () => {
    const xml = encryptionXml(
      encryptedData(FONT, AES) + encryptedData('OEBPS/images/cover.jpg', AES),
    )
    expect(check(xml)).toBe(false)
  })

  it('accepts an encrypted document the book no longer uses', () => {
    const xml = encryptionXml(encryptedData('OEBPS/text/removed-sample.xhtml', AES))
    expect(check(xml)).toBe(false)
  })

  it('accepts an entry that names no resource', () => {
    const xml = encryptionXml(`<enc:EncryptedData>
      <enc:EncryptionMethod Algorithm="${AES}" />
    </enc:EncryptedData>`)
    expect(check(xml)).toBe(false)
  })

  it('accepts an encryption.xml with no encrypted resources', () => {
    expect(check(encryptionXml(''))).toBe(false)
  })

  it('accepts malformed encryption metadata rather than blocking the book', () => {
    expect(check('<encryption><EncryptedData>')).toBe(false)
    expect(check('\n  ')).toBe(false)
    expect(check('<!-- nothing here -->')).toBe(false)
  })

  it('accepts anything when the spine is unknown', () => {
    expect(check(encryptionXml(encryptedData(CHAPTER, AES)), [])).toBe(false)
  })
})
