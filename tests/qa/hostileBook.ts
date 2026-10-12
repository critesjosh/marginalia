import { crc32 } from 'node:zlib'
import { expect, type Page } from '@playwright/test'
import { openContents } from './fixtures.js'

// Each vector tries to mark the app's own window. The book frame shares the
// app's origin, so any script that ran could as easily read IndexedDB.
const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<title>Chapter</title>
<script>top.pwned = 'inline script'</script>
<script src="evil.js"></script>
<meta HTTP-EQUIV="Refresh" content="0;url=evil.xhtml" />
</head>
<body>
<h1>Hostile chapter</h1>
<SCRIPT TYPE="text/javascript">top.pwned = 'uppercase script'</SCRIPT>
<p>Plain prose follows the attempts below.</p>
<img src="missing.png" alt="" onerror="top.pwned = 'onerror attribute'" />
<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>top.pwned = 'svg script'</script></svg>
<iframe src="evil.xhtml" title="frame"></iframe>
<object data="evil.xhtml" type="application/xhtml+xml"></object>
<form action="evil.svg"><button id="submit-form">Submit form</button></form>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="40"><a id="svg-link" xlink:href="evil.svg"><rect width="120" height="40" fill="gray" /></a></svg>
</body>
</html>`

// A section whose root is not html. epub.js keeps a reference to that root
// from before the content hooks run, so it must still carry the policy.
const DRAWING = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" onload="top.pwned = 'svg root onload'">
<text x="10" y="40">Plain drawing text</text>
</svg>`

// An asset epub.js swaps for a same-origin blob URL. It never passes through
// the section hooks, so the frame must not be able to navigate to it.
const EVIL_SVG = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg"><script>top.pwned = 'navigated to an asset'</script></svg>`

const EVIL_PAGE = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Evil</title></head>
<body><script>top.pwned = 'framed book file'</script></body></html>`

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:00000000-0000-4000-8000-000000000101</dc:identifier>
<dc:title>Hostile Scripts</dc:title>
<dc:creator>Synthetic Fixture</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" properties="scripted svg" />
<item id="drawing" href="drawing.xhtml" media-type="application/xhtml+xml" properties="scripted svg" />
<item id="evil-page" href="evil.xhtml" media-type="application/xhtml+xml" properties="scripted" />
<item id="evil-svg" href="evil.svg" media-type="image/svg+xml" />
<item id="evil-script" href="evil.js" media-type="application/javascript" />
</manifest>
<spine><itemref idref="chapter" /><itemref idref="drawing" /></spine>
</package>`

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Hostile chapter</a></li><li><a href="drawing.xhtml">Drawing</a></li></ol></nav></body>
</html>`

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`

/** A synthetic EPUB whose only content is attempts to run script. */
function hostileBook() {
  return {
    name: 'hostile-scripts.epub',
    mimeType: 'application/epub+zip',
    buffer: storedZip([
      ['mimetype', 'application/epub+zip'],
      ['META-INF/container.xml', CONTAINER],
      ['OEBPS/content.opf', OPF],
      ['OEBPS/nav.xhtml', NAV],
      ['OEBPS/chapter.xhtml', CHAPTER],
      ['OEBPS/drawing.xhtml', DRAWING],
      ['OEBPS/evil.xhtml', EVIL_PAGE],
      ['OEBPS/evil.svg', EVIL_SVG],
      ['OEBPS/evil.js', "top.pwned = 'script file'"],
    ]),
  }
}

/** Imports the hostile book, opens it, and checks that none of it ran. */
export async function expectBookScriptsBlocked(page: Page) {
  await page.goto('/')
  await page.locator('input[type="file"]').setInputFiles(hostileBook())
  await page.getByRole('button', { name: /^Hostile Scripts/ }).click()
  // Long enough for the section to render, and for a refresh, a failed image
  // and nested frames to fire.
  await page.waitForTimeout(3000)
  expect(await page.evaluate(() => (globalThis as { pwned?: string }).pwned)).toBeUndefined()
  // Still the chapter: nothing navigated the frame away.
  const book = page.frameLocator('.epub-view iframe').first()
  await expect(book.locator('body')).toContainText('Plain prose follows')
  await expectPolicy(page)

  // Navigations a reader can trigger. HTML links are epub.js's to follow.
  for (const id of ['submit-form', 'svg-link']) {
    await book.locator(`[id="${id}"]`).click({ force: true })
    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => (globalThis as { pwned?: string }).pwned), id).toBeUndefined()
    await expect(book.locator('body'), id).toContainText('Plain prose follows')
  }

  const contents = await openContents(page)
  await contents.getByRole('button', { name: 'Drawing' }).click()
  await expect(book.locator('body')).toContainText('Plain drawing text')
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => (globalThis as { pwned?: string }).pwned)).toBeUndefined()
  await expectPolicy(page)
}

/** The rendered frame, not just the parsed section, carries the policy. */
async function expectPolicy(page: Page) {
  const policy = page
    .frameLocator('.epub-view iframe')
    .first()
    .locator('head > meta[http-equiv="Content-Security-Policy"]')
  await expect(policy).toHaveCount(1)
}

/** A zip with every entry stored uncompressed, which is all an EPUB needs. */
function storedZip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const path = Buffer.from(name)
    const data = Buffer.from(text)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(path.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, path, data)
    centrals.push(central, path)
    offset += local.length + path.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
