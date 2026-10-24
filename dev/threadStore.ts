/**
 * Keeps a Markdown copy of each thread under the folder the reader passed to
 * the bridge as `--save-dir` (decision 0011). A one-way mirror: the browser
 * stays the source of truth, and nothing here is read back into it.
 *
 * Every path component is built here from slugs and validated ids, never taken
 * from the request. Book text and replies are untrusted, so they are written
 * as literal text that a Markdown viewer will not turn into HTML or remote
 * loads.
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Lowercase only, so ids cannot collide on a case-insensitive disk. Rami's are. */
const ID = /^[a-z0-9_-]{8,64}$/
/** The latest time `Date` can represent. */
const MAX_TIME = 8.64e15
const MAX_TURNS = 1000
const MAX_TEXT = 100_000
const MAX_FIELD = 500
const MAX_PASSAGE = 20_000

export interface ThreadExport {
  book: { id: string; title: string; author: string }
  thread: {
    id: string
    title: string
    chapter?: string
    progress?: number
    passage?: string
    createdAt: number
    updatedAt: number
  }
  turns: { role: 'user' | 'assistant'; content: string; createdAt: number }[]
}

export class SaveError extends Error {
  readonly status: number
  /** `stale` is the one refusal the app treats as fine: a newer copy is saved. */
  readonly code?: 'stale'

  constructor(status: number, message: string, code?: 'stale') {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Resolves `~`, creates the folder if missing, and refuses anything unsafe. */
export async function openSaveDir(path: string): Promise<string> {
  const root = resolve(path.replace(/^~(?=$|\/)/, homedir()))
  // Checked before creating, so a symlink is refused rather than followed.
  const exists = await lstat(root).then(
    () => true,
    () => false,
  )
  if (!exists) await mkdir(root, { recursive: true, mode: 0o700 })
  await checkFolder(root)
  return root
}

async function checkFolder(path: string) {
  let stats
  try {
    stats = await lstat(path)
  } catch {
    throw new SaveError(503, 'The save folder is missing. Is its disk connected?')
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SaveError(503, `${path} is not a plain folder; refusing to write there.`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new SaveError(503, `${path} belongs to another user; refusing to write there.`)
  }
}

/** Checks the request against the export shape, field by field. */
export function parseThreadExport(payload: unknown, id: string): ThreadExport {
  const fail = (why: string): never => {
    throw new SaveError(400, why)
  }
  const object = (value: unknown, name: string) =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : fail(`Expected ${name}.`)
  const text = (value: unknown, name: string, max: number, optional = false) => {
    if (optional && (value === undefined || value === null)) return undefined
    if (typeof value !== 'string' || value.length > max) return fail(`Bad ${name}.`)
    return value
  }
  const time = (value: unknown, name: string) =>
    typeof value === 'number' && value >= 0 && value <= MAX_TIME ? value : fail(`Bad ${name}.`)

  const body = object(payload, 'a thread')
  const book = object(body.book, 'book')
  const thread = object(body.thread, 'thread')
  if (!Array.isArray(body.turns) || body.turns.length > MAX_TURNS) fail('Bad turns.')
  if (thread.id !== id || !ID.test(id)) fail('The thread id does not match.')
  if (typeof book.id !== 'string' || !ID.test(book.id)) fail('Bad book id.')
  const progress = thread.progress
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 1)) {
    fail('Bad position.')
  }

  return {
    book: {
      id: book.id as string,
      title: text(book.title, 'book title', MAX_FIELD) as string,
      author: text(book.author, 'author', MAX_FIELD) as string,
    },
    thread: {
      id,
      title: text(thread.title, 'title', MAX_FIELD) as string,
      chapter: text(thread.chapter, 'chapter', MAX_FIELD, true),
      progress: progress as number | undefined,
      passage: text(thread.passage, 'passage', MAX_PASSAGE, true),
      createdAt: time(thread.createdAt, 'created time'),
      updatedAt: time(thread.updatedAt, 'updated time'),
    },
    turns: (body.turns as unknown[]).map((raw) => {
      const turn = object(raw, 'a turn')
      if (turn.role !== 'user' && turn.role !== 'assistant') fail('Bad turn role.')
      return {
        role: turn.role as 'user' | 'assistant',
        content: text(turn.content, 'turn', MAX_TEXT) as string,
        createdAt: time(turn.createdAt, 'turn time'),
      }
    }),
  }
}

/** ASCII, lowercase, single hyphens (never `--`), at most 50 characters, never empty. */
export function slug(value: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '')
  return ascii || 'untitled'
}

/**
 * Untrusted text as literal Markdown: no control characters, no HTML, no
 * images that load on their own, and no line that reads as a heading.
 */
export function literal(value: string): string {
  return (
    withoutControls(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('![', '!\\[')
      .replace(/^(\s*)#/gm, '$1\\#')
      // An underline of = or - would make the line above it a heading.
      .replace(/^(\s*)([=-]+\s*)$/gm, '$1\\$2')
  )
}

/** Keeps newlines and tabs; drops every other C0 control character and DEL. */
function withoutControls(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char === '\n' || char === '\t' || (code > 0x1f && code !== 0x7f)) out += char
  }
  return out
}

const ISO = (ms: number) => new Date(ms).toISOString()

export function renderThread({ book, thread, turns }: ThreadExport): string {
  const front: [string, string | number | undefined][] = [
    ['rami_thread', thread.id],
    ['title', thread.title],
    ['book', book.title],
    ['author', book.author],
    ['chapter', thread.chapter],
    [
      'position',
      thread.progress === undefined ? undefined : Math.round(thread.progress * 100) / 100,
    ],
    ['created', ISO(thread.createdAt)],
    ['updated', ISO(thread.updatedAt)],
    ['rami_messages', turns.length],
    ['rami_updated', thread.updatedAt],
  ]
  const lines = ['---']
  for (const [key, value] of front) {
    // A JSON string is a valid YAML double-quoted scalar.
    if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('---', '', `# ${literal(thread.title).replace(/\n/g, ' ')}`, '')
  const source = `*${literal(book.title)}* by ${literal(book.author)}`
  const where = thread.chapter ? `${source}, ${literal(thread.chapter)}` : source
  lines.push(where.replace(/\n/g, ' '), '')
  if (thread.passage) {
    lines.push(
      ...literal(thread.passage)
        .split('\n')
        .map((line) => `> ${line}`),
      '',
    )
  }
  for (const turn of turns) {
    lines.push(`## ${turn.role === 'user' ? 'Reader' : 'Rami'}`, '', literal(turn.content), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Saves one thread, refusing an older copy than the one on disk. Saves run one
 * at a time per book, so finding or creating the book's folder never races
 * another thread of the same book.
 */
export function createThreadStore(root: string) {
  const queues = new Map<string, Promise<unknown>>()

  return function save(thread: ThreadExport): Promise<string> {
    const key = thread.book.id
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => write(root, thread))
    queues.set(key, next)
    const forget = () => {
      if (queues.get(key) === next) queues.delete(key)
    }
    // The caller handles the rejection; this only tidies the queue.
    next.then(forget, forget)
    return next
  }
}

async function write(root: string, data: ThreadExport): Promise<string> {
  await checkFolder(root)
  const bookDir = await bookFolder(root, data.book)
  const existing = (await readdir(bookDir)).find(
    (name) => name.endsWith('.md') && idOf(name.slice(0, -3)) === data.thread.id,
  )
  const name =
    existing ??
    `${ISO(data.thread.createdAt).slice(0, 10)}-${slug(data.thread.title)}--${data.thread.id}.md`
  const file = join(bookDir, name)

  if (existing) {
    const stats = await lstat(file)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new SaveError(409, `${name} is not a plain file; refusing to replace it.`)
    }
    if (isNewer(await readFile(file, 'utf8'), data)) {
      throw new SaveError(409, 'A newer copy of this thread is already saved.', 'stale')
    }
  }

  const temporary = join(bookDir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, renderThread(data), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return file
}

/**
 * Names are `<slug>--<id>`. A slug never contains `--`, so the id is exactly
 * what follows the first one.
 */
function idOf(name: string): string | null {
  const at = name.indexOf('--')
  return at < 0 ? null : name.slice(at + 2)
}

/** The book's folder, found by its id so a retitled book keeps it. */
async function bookFolder(root: string, book: ThreadExport['book']): Promise<string> {
  const existing = (await readdir(root)).find((name) => idOf(name) === book.id)
  const dir = join(root, existing ?? `${slug(book.title)}--${book.id}`)
  if (existing) await checkFolder(dir)
  else {
    // Another thread of the same book may create it at the same moment.
    await mkdir(dir, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
      await checkFolder(dir)
    })
  }
  return dir
}

function isNewer(saved: string, incoming: ThreadExport): boolean {
  const count = Number(/^rami_messages: (\d+)$/m.exec(saved)?.[1] ?? -1)
  const updated = Number(/^rami_updated: (\d+(?:\.\d+)?)$/m.exec(saved)?.[1] ?? -1)
  if (count !== incoming.turns.length) return count > incoming.turns.length
  return updated > incoming.thread.updatedAt
}
