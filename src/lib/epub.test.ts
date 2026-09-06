// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { hasUnsupportedEncryption } from './epub'

function encryptionXml(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  ${entries}
</encryption>`
}

function encryptedData(algorithm?: string): string {
  const method = algorithm
    ? `<enc:EncryptionMethod Algorithm="${algorithm}" />`
    : ''

  return `<enc:EncryptedData>
    ${method}
    <enc:CipherData>
      <enc:CipherReference URI="OEBPS/fonts/book-font.otf" />
    </enc:CipherData>
  </enc:EncryptedData>`
}

describe('EPUB encryption detection', () => {
  it('accepts the standard IDPF font-obfuscation algorithm', () => {
    const xml = encryptionXml(encryptedData('http://www.idpf.org/2008/embedding'))
    expect(hasUnsupportedEncryption(xml)).toBe(false)
  })

  it('accepts the legacy Adobe font-obfuscation algorithm', () => {
    const xml = encryptionXml(encryptedData('http://ns.adobe.com/pdf/enc#RC'))
    expect(hasUnsupportedEncryption(xml)).toBe(false)
  })

  it('rejects other encryption algorithms', () => {
    const xml = encryptionXml(
      encryptedData('http://www.w3.org/2001/04/xmlenc#aes256-cbc'),
    )
    expect(hasUnsupportedEncryption(xml)).toBe(true)
  })

  it('rejects encrypted data with no declared algorithm', () => {
    expect(hasUnsupportedEncryption(encryptionXml(encryptedData()))).toBe(true)
  })

  it('rejects mixed font obfuscation and content encryption', () => {
    const xml = encryptionXml(
      encryptedData('http://www.idpf.org/2008/embedding') +
        encryptedData('http://www.w3.org/2001/04/xmlenc#aes128-cbc'),
    )
    expect(hasUnsupportedEncryption(xml)).toBe(true)
  })

  it('ignores an encryption.xml with no encrypted resources', () => {
    expect(hasUnsupportedEncryption(encryptionXml(''))).toBe(false)
  })

  it('treats malformed encryption metadata conservatively', () => {
    expect(hasUnsupportedEncryption('<encryption><EncryptedData>')).toBe(true)
  })
})
