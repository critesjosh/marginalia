// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { hasUnsupportedEncryption } from './epub'

const FONT = 'OEBPS/fonts/book-font.otf'
const CHAPTER = 'OEBPS/text/chapter1.xhtml'

const IDPF = 'http://www.idpf.org/2008/embedding'
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC'
const AES = 'http://www.w3.org/2001/04/xmlenc#aes256-cbc'

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

describe('EPUB encryption detection', () => {
  it('rejects content encrypted with an algorithm we cannot read', () => {
    expect(hasUnsupportedEncryption(encryptionXml(encryptedData(CHAPTER, AES)))).toBe(
      true,
    )
  })

  it('rejects encrypted content that declares no algorithm', () => {
    expect(hasUnsupportedEncryption(encryptionXml(encryptedData(CHAPTER)))).toBe(true)
  })

  it('rejects a book whose package document is encrypted', () => {
    const xml = encryptionXml(encryptedData('OEBPS/content.opf', AES))
    expect(hasUnsupportedEncryption(xml)).toBe(true)
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
    expect(hasUnsupportedEncryption(xml)).toBe(true)
  })

  it('rejects a book that mixes font obfuscation with encrypted content', () => {
    const xml = encryptionXml(
      encryptedData(FONT, IDPF) + encryptedData(CHAPTER, AES),
    )
    expect(hasUnsupportedEncryption(xml)).toBe(true)
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
    expect(hasUnsupportedEncryption(xml)).toBe(true)
  })

  it('accepts the standard IDPF font-obfuscation algorithm', () => {
    expect(hasUnsupportedEncryption(encryptionXml(encryptedData(FONT, IDPF)))).toBe(
      false,
    )
  })

  it('accepts the legacy Adobe font-obfuscation algorithm', () => {
    expect(hasUnsupportedEncryption(encryptionXml(encryptedData(FONT, ADOBE)))).toBe(
      false,
    )
  })

  it('accepts encryption applied to resources other than the content', () => {
    const xml = encryptionXml(
      encryptedData(FONT, AES) + encryptedData('OEBPS/images/cover.jpg', AES),
    )
    expect(hasUnsupportedEncryption(xml)).toBe(false)
  })

  it('matches percent-encoded resource paths', () => {
    const xml = encryptionXml(encryptedData('OEBPS/text/chapter%201.xhtml', AES))
    expect(hasUnsupportedEncryption(xml)).toBe(true)
  })

  it('accepts an entry that names no resource', () => {
    const xml = encryptionXml(`<enc:EncryptedData>
      <enc:EncryptionMethod Algorithm="${AES}" />
    </enc:EncryptedData>`)
    expect(hasUnsupportedEncryption(xml)).toBe(false)
  })

  it('accepts an encryption.xml with no encrypted resources', () => {
    expect(hasUnsupportedEncryption(encryptionXml(''))).toBe(false)
  })

  it('accepts malformed encryption metadata rather than blocking the book', () => {
    expect(hasUnsupportedEncryption('<encryption><EncryptedData>')).toBe(false)
    expect(hasUnsupportedEncryption('\n  ')).toBe(false)
    expect(hasUnsupportedEncryption('<!-- nothing here -->')).toBe(false)
  })
})
