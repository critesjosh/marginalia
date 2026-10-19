import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createThreadStore,
  literal,
  openSaveDir,
  parseThreadExport,
  renderThread,
  slug,
  type ThreadExport,
} from './threadStore.ts'

const BOOK = 'sample-moby-dick'
const THREAD = '0b7e5d3c-1f2a-4b6c-9d8e-7f6a5b4c3d2e'

function thread(overrides: Partial<ThreadExport['thread']> = {}, turns = 2): ThreadExport {
  return {
    book: { id: BOOK, title: 'Moby Dick; or, The Whale', author: 'Herman Melville' },
    thread: {
      id: THREAD,
      title: 'Call me Ishmael',
      chapter: 'Chapter 1. Loomings.',
      progress: 0.0123,
      passage: 'Call me Ishmael.\nSome years ago',
      createdAt: Date.UTC(2026, 9, 18, 12),
      updatedAt: Date.UTC(2026, 9, 18, 12, 5),
      ...overrides,
    },
    turns: [
      { role: 'user' as const, content: 'Who is speaking?', createdAt: 1 },
      { role: 'assistant' as const, content: 'Ishmael, the narrator.', createdAt: 2 },
    ].slice(0, turns),
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thread-store-test-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const files = () =>
  readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(dir, name)))

describe('literal text', () => {
  it('escapes HTML, neutralizes images and headings, and drops control characters', () => {
    const hostile =
      '<img src=x onerror=alert(1)>\n# Reader\n![t](https://x/p.png) [a](https://x)\u0007'
    expect(literal(hostile)).toBe(
      '&lt;img src=x onerror=alert(1)&gt;\n\\# Reader\n!\\[t](https://x/p.png) [a](https://x)',
    )
  })

  it('neutralizes underlines that would make a heading', () => {
    expect(literal('Reader\n------\nRami\n  ===  ')).toBe('Reader\n\\------\nRami\n  \\===  ')
  })

  it('makes short, ASCII, single-hyphen slugs', () => {
    expect(slug('Moby Dick; or, The Whale')).toBe('moby-dick-or-the-whale')
    expect(slug('Ça--ira ../../etc')).toBe('ca-ira-etc')
    expect(slug('CON')).toBe('con')
    expect(slug('!!!')).toBe('untitled')
    expect(slug('a'.repeat(80))).toHaveLength(50)
  })
})

describe('renderThread', () => {
  it('writes front matter as JSON strings, the passage quoted, and each turn', () => {
    const text = renderThread(thread({ title: 'Ahab: "the whale"\n---' }))
    expect(text.startsWith('---\nrami_thread: "' + THREAD + '"\n')).toBe(true)
    expect(text).toContain('title: "Ahab: \\"the whale\\"\\n---"')
    expect(text).toContain('rami_messages: 2\n')
    expect(text).toContain(
      '\n*Moby Dick; or, The Whale* by Herman Melville, Chapter 1. Loomings.\n',
    )
    expect(text).toContain('> Call me Ishmael.\n> Some years ago\n')
    expect(text).toContain('## Reader\n\nWho is speaking?\n\n## Rami\n\nIshmael, the narrator.\n')
    // The front matter closes exactly once, before the body.
    expect(text.split('\n---\n')).toHaveLength(2)
  })
})

describe('parseThreadExport', () => {
  it('accepts the export shape and only what it names', () => {
    const body = { ...thread(), published: { ownerToken: 'secret' } }
    expect(parseThreadExport(body, THREAD)).toEqual(thread())
  })

  it('refuses mismatched ids, odd roles, and oversized fields', () => {
    expect(() => parseThreadExport(thread(), 'other-thread-id')).toThrow(/does not match/)
    const system = { ...thread(), turns: [{ role: 'system', content: 'x', createdAt: 1 }] }
    expect(() => parseThreadExport(system, THREAD)).toThrow(/role/)
    const long = thread({ title: 'x'.repeat(501) })
    expect(() => parseThreadExport(long, THREAD)).toThrow(/title/)
    const badBook = { ...thread(), book: { ...thread().book, id: '../..' } }
    expect(() => parseThreadExport(badBook, THREAD)).toThrow(/book id/)
    const upper = { ...thread(), book: { ...thread().book, id: 'Sample-Moby-Dick' } }
    expect(() => parseThreadExport(upper, THREAD)).toThrow(/book id/)
    expect(() => parseThreadExport(thread({ updatedAt: 1e100 }), THREAD)).toThrow(/updated/)
  })
})

describe('saving', () => {
  it('writes a private file named from slugs and ids, and finds it again', async () => {
    const save = createThreadStore(await openSaveDir(root))
    const first = await save(thread())
    expect(first).toBe(
      join(root, `moby-dick-or-the-whale--${BOOK}`, `2026-10-18-call-me-ishmael--${THREAD}.md`),
    )
    expect(statSync(first).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, `moby-dick-or-the-whale--${BOOK}`)).mode & 0o777).toBe(0o700)

    // A retitled thread and book keep their file and folder.
    const renamed = await save({
      ...thread({ title: 'Renamed', updatedAt: Date.UTC(2026, 9, 18, 13) }, 2),
      book: { ...thread().book, title: 'Moby-Dick' },
    })
    expect(renamed).toBe(first)
    expect(readFileSync(first, 'utf8')).toContain('title: "Renamed"')
    expect(files()).toHaveLength(1)
  })

  it('refuses to roll a thread back to an older copy', async () => {
    const save = createThreadStore(await openSaveDir(root))
    await save(thread())
    await expect(save(thread({}, 1))).rejects.toMatchObject({ status: 409 })
    await expect(save(thread({ updatedAt: Date.UTC(2026, 9, 18, 11) }))).rejects.toMatchObject({
      status: 409,
    })
  })

  it('lets two new threads of one book create its folder at once', async () => {
    const save = createThreadStore(await openSaveDir(root))
    const other = {
      ...thread(),
      thread: { ...thread().thread, id: 'a1b2c3d4-0000-4000-8000-000000000000' },
    }
    const results = await Promise.allSettled([save(thread()), save(other)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(files()).toHaveLength(2)
  })

  it('marks only an older copy as stale', async () => {
    const save = createThreadStore(await openSaveDir(root))
    await save(thread())
    await expect(save(thread({}, 1))).rejects.toMatchObject({ status: 409, code: 'stale' })
  })

  it('runs saves of one thread in order', async () => {
    const save = createThreadStore(await openSaveDir(root))
    const results = await Promise.allSettled([
      save(thread({}, 1)),
      save(thread({ updatedAt: Date.UTC(2026, 9, 18, 14) })),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(readFileSync(files().map((f) => join(root, f))[0], 'utf8')).toContain('rami_messages: 2')
    expect(files()).toHaveLength(1)
  })

  it('refuses a symlinked folder or file, and a vanished save folder', async () => {
    const save = createThreadStore(await openSaveDir(root))
    const elsewhere = mkdtempSync(join(tmpdir(), 'thread-store-elsewhere-'))
    try {
      symlinkSync(elsewhere, join(root, `moby-dick--${BOOK}`))
      await expect(save(thread())).rejects.toMatchObject({ status: 503 })
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }

    unlinkSync(join(root, `moby-dick--${BOOK}`))
    const bookDir = join(root, `moby-dick--${BOOK}`)
    mkdirSync(bookDir, { mode: 0o700 })
    const target = join(tmpdir(), `thread-store-target-${process.pid}.md`)
    writeFileSync(target, 'keep me')
    try {
      symlinkSync(target, join(bookDir, `2026-10-18-x--${THREAD}.md`))
      await expect(save(thread())).rejects.toMatchObject({ status: 409 })
      expect(readFileSync(target, 'utf8')).toBe('keep me')
    } finally {
      rmSync(target, { force: true })
    }

    rmSync(root, { recursive: true, force: true })
    await expect(save(thread())).rejects.toMatchObject({ status: 503 })
  })

  it('refuses to open a symlink as the save folder, and tolerates an existing one', async () => {
    const link = join(tmpdir(), `thread-store-link-${process.pid}`)
    symlinkSync(root, link)
    try {
      await expect(openSaveDir(link)).rejects.toThrow(/not a plain folder/)
    } finally {
      unlinkSync(link)
    }
    chmodSync(root, 0o755)
    expect(await openSaveDir(root)).toBe(root)
  })
})
