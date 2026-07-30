import { db } from '../../db/db'
import type { BookChunk } from '../../db/types'
import { compareCfi } from '../chapters'

/**
 * Picks what the index should contribute to one conversation.
 *
 * Keyword retrieval, deliberately: it needs no model, runs in milliseconds on a
 * phone, and is honest about what it is. What it is good at is the question the
 * ±1,200 characters around a passage cannot answer -- "where has this name come
 * up before?" -- because a proper noun is exactly the kind of term that scores
 * well and cannot be guessed from context.
 *
 * Everything it returns is filtered against the reading position first, so the
 * spoiler guard stops being a request to the model and becomes arithmetic.
 */

/** Excerpts to send. Four is about 3,000 characters, well inside any budget. */
const MAX_EXCERPTS = 4
const EXCERPT_CHARS = 700
const MAX_CHAPTERS = 30

/**
 * How distinctive a chunk's overlap with the query has to be to be worth sending.
 *
 * The weighted inverse document frequencies of the terms a chunk shares with the
 * query, summed. 2.2 is one term in an eighth of the book, or a couple of
 * moderately common ones together. Measured against the bundled Moby Dick,
 * "Bulkington" (in 1% of chunks) scores 9.1 and "Queequeg" (30%) 2.9, while
 * "whale" (85%) reaches 1.6 and "day" plus "men" 1.9 -- so a passage is quoted
 * for sharing a name or a rare word, and never for sharing ordinary English.
 *
 * A floor rather than a cutoff on frequency: the main characters of a novel land
 * either side of any such line arbitrarily, and Ahab appears in 46% of this book.
 */
const MIN_MATCH_WEIGHT = 2.2

/**
 * Words a reader uses to ask *about* a text, which are not what they are asking
 * about.
 *
 * These are rare in prose and so score as highly distinctive, which inverts the
 * ranking of exactly the question retrieval exists to answer: "where has
 * Queequeg been mentioned before?" ranked chapters containing "mentioned" over
 * chapters containing Queequeg, because Melville writes "mentioned" far less
 * often than he writes his own harpooneer.
 */
const META_WORDS = [
  'author', 'book', 'chapter', 'chapters', 'character', 'characters', 'describe', 'described',
  'describes', 'explain', 'explained', 'explains', 'happen', 'happened', 'happens', 'introduce',
  'introduced', 'introduces', 'line', 'lines', 'mean', 'meaning', 'means', 'mention', 'mentioned',
  'mentions', 'narrator', 'page', 'pages', 'paragraph', 'passage', 'passages', 'plot', 'quote',
  'quoted', 'quotes', 'reader', 'refer', 'referred', 'refers', 'scene', 'section', 'sentence',
  'story', 'symbol', 'symbolism', 'symbolises', 'symbolizes', 'tell', 'tells', 'text', 'theme',
  'themes', 'told', 'word', 'words',
]

const STOPWORDS = new Set([
  ...META_WORDS,
  'about', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are', 'because', 'been',
  'before', 'being', 'but', 'came', 'can', 'come', 'could', 'did', 'does', 'down', 'each',
  'even', 'ever', 'every', 'for', 'from', 'get', 'had', 'has', 'have', 'her', 'here', 'him',
  'his', 'how', 'into', 'its', 'just', 'like', 'made', 'make', 'many', 'may', 'might', 'more',
  'most', 'much', 'must', 'never', 'not', 'now', 'off', 'one', 'only', 'other', 'our', 'out',
  'over', 'own', 'said', 'same', 'saw', 'say', 'see', 'she', 'should', 'some', 'still', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think',
  'this', 'those', 'though', 'through', 'thus', 'too', 'upon', 'very', 'was', 'way', 'well',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
])

export interface BookExcerpt {
  chapter?: string
  /** 0..100, where in the book this came from. */
  percent: number
  text: string
}

export interface BookContext {
  /** Chapter labels up to the reading position, in order. */
  chapters: string[]
  /** True when the middle of a long chapter list was dropped. */
  chaptersElided: boolean
  excerpts: BookExcerpt[]
}

export interface RetrieveRequest {
  bookId: string
  /** The highlighted passage, and the reader's latest question if there is one. */
  seedText?: string
  question?: string
  /** Where the conversation is anchored. The CFI is exact; progress is a fallback. */
  cfi?: string
  progress?: number
  /** When set, nothing past the reading position is returned. */
  spoilerGuard: boolean
}

export async function retrieveBookContext(
  request: RetrieveRequest,
): Promise<BookContext | undefined> {
  const chunks = await db.bookChunks.where('bookId').equals(request.bookId).sortBy('index')
  if (chunks.length === 0) return undefined

  const cursor = readingCursor(chunks, request)
  // A conversation we cannot place, with spoilers guarded, is the one case where
  // the honest answer is to send nothing: any excerpt might be from the ending.
  if (cursor === undefined) return undefined

  const visible = chunks.slice(0, cursor + 1)
  const chapters = chapterOutline(visible)

  return {
    chapters: chapters.labels,
    chaptersElided: chapters.elided,
    excerpts: bestExcerpts(
      // The two chunks at the cursor are the passage and its surroundings, which
      // the conversation already carries verbatim.
      visible.slice(0, Math.max(0, cursor - 1)),
      // How rare a word is, is a fact about the book, not about how far in the
      // reader has got. Counting only what they have read makes a name that
      // saturates the early chapters look like furniture: at 29% of Moby Dick,
      // "Queequeg" is in over half of what has been read and scores below the
      // floor, so "where has Queequeg been mentioned?" -- which answers well from
      // the last page -- returned nothing at all from chapter 36.
      chunks,
      request,
    ),
  }
}

/**
 * Index of the last chunk the reader has reached.
 *
 * Returns the whole book when spoilers are not guarded -- the reader has said
 * they want the model to use everything -- and undefined when the position is
 * unknown and they are.
 */
function readingCursor(chunks: BookChunk[], request: RetrieveRequest): number | undefined {
  if (!request.spoilerGuard) return chunks.length - 1

  if (request.cfi) {
    let cursor: number | undefined
    for (const chunk of chunks) {
      const order = compareCfi(chunk.cfiStart, request.cfi)
      if (order === undefined) continue
      if (order <= 0) cursor = chunk.index
      else break
    }
    if (cursor !== undefined) return cursor
  }

  if (typeof request.progress === 'number') {
    // Character-offset progress against epub.js's locations-based figure. The two
    // measures agree closely but not exactly, so a chat started before CFIs were
    // stored can be placed a chunk or so out.
    let cursor: number | undefined
    for (const chunk of chunks) {
      if (chunk.progress <= request.progress) cursor = chunk.index
      else break
    }
    if (cursor !== undefined) return cursor
  }

  return undefined
}

function chapterOutline(chunks: BookChunk[]): { labels: string[]; elided: boolean } {
  const labels: string[] = []
  const push = (label?: string) => {
    const clean = label?.trim()
    if (clean && clean !== labels[labels.length - 1]) labels.push(clean)
  }

  // The chapter the first chunk opens in began before it, so it is not in any
  // chunk's `chapterStarts`; every later one is.
  push(chunks[0]?.chapter)
  for (const chunk of chunks) {
    for (const label of chunk.chapterStarts ?? []) push(label)
  }

  if (labels.length <= MAX_CHAPTERS) return { labels, elided: false }

  // Keep the opening for shape and the recent chapters for relevance; a
  // 135-chapter book would otherwise spend the whole budget on a list.
  const head = labels.slice(0, 5)
  const tail = labels.slice(-(MAX_CHAPTERS - 5))
  return { labels: [...head, ...tail], elided: true }
}

interface ScoredChunk {
  chunk: BookChunk
  score: number
  /** Highest-weight query term found in this chunk, used to centre the excerpt. */
  anchor: string
}

function bestExcerpts(
  candidates: BookChunk[],
  corpus: BookChunk[],
  request: RetrieveRequest,
): BookExcerpt[] {
  if (candidates.length === 0) return []

  const query = queryTerms(`${request.seedText ?? ''} ${request.question ?? ''}`)
  if (query.size === 0) return []

  const counted = candidates.map((chunk) => ({ chunk, terms: countTerms(chunk.text) }))

  // Document frequency across the whole book, so a name that appears twice
  // outranks a word that appears in every chapter.
  const docFrequency = new Map<string, number>()
  for (const term of query.keys()) {
    let count = 0
    for (const chunk of corpus) if (hasTerm(chunk.text, term)) count += 1
    if (count > 0) docFrequency.set(term, count)
  }
  if (docFrequency.size === 0) return []

  const scored: ScoredChunk[] = []
  for (const { chunk, terms } of counted) {
    let score = 0
    let matchWeight = 0
    let anchor: string | undefined
    let anchorWeight = 0

    for (const [term, df] of docFrequency) {
      const tf = terms.get(term)
      if (!tf) continue

      const idf = Math.log(1 + corpus.length / df)
      const weight = idf * (query.get(term) ?? 1)

      // Rarity counts once towards qualifying, and repetition only towards rank:
      // otherwise a chunk saying "day" nine times looks as distinctive as one
      // naming a character.
      matchWeight += weight
      score += weight * (1 + Math.log(tf))

      if (weight > anchorWeight) {
        anchorWeight = weight
        anchor = term
      }
    }

    // Without a distinctive term in common, a high score is just two passages of
    // English prose. Quoting those makes the prompt worse, not better.
    if (anchor && matchWeight >= MIN_MATCH_WEIGHT) scored.push({ chunk, score, anchor })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EXCERPTS)
    .sort((a, b) => a.chunk.index - b.chunk.index)
    .map(({ chunk, anchor }) => ({
      chapter: chunk.chapter,
      percent: Math.round(chunk.progress * 100),
      text: excerptAround(chunk.text, anchor),
    }))
}

/** Query terms mapped to a weight: capitalised words are the ones worth finding. */
function queryTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  for (const match of text.matchAll(/[\p{L}][\p{L}']{2,}/gu)) {
    const raw = match[0]
    const term = raw.toLowerCase().replace(/'s$/, '')
    if (term.length < 3 || STOPWORDS.has(term)) continue

    // A capitalised occurrence is a name, a place or a ship far more often than
    // it is the first word of a sentence, and those are what retrieval is for.
    const weight = raw[0] === raw[0].toUpperCase() ? 2 : 1
    terms.set(term, Math.max(terms.get(term) ?? 0, weight))
  }
  return terms
}

/** Whether a chunk contains a term, for counting document frequency. */
function hasTerm(text: string, term: string): boolean {
  // Tokenised the same way the query and the term counts are, so "whale" cannot
  // be found inside "whalemen" and inflate its own document frequency.
  for (const match of text.toLowerCase().matchAll(/[\p{L}][\p{L}']{2,}/gu)) {
    if (match[0].replace(/'s$/, '') === term) return true
  }
  return false
}

function countTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  for (const match of text.toLowerCase().matchAll(/[\p{L}][\p{L}']{2,}/gu)) {
    const term = match[0].replace(/'s$/, '')
    if (term.length < 3) continue
    terms.set(term, (terms.get(term) ?? 0) + 1)
  }
  return terms
}

/** A window of the chunk centred on the term that made it match. */
function excerptAround(text: string, term: string): string {
  if (text.length <= EXCERPT_CHARS) return text

  const at = text.toLowerCase().indexOf(term)
  const centre = at === -1 ? 0 : at
  let start = Math.max(0, centre - Math.floor(EXCERPT_CHARS / 2))
  let end = Math.min(text.length, start + EXCERPT_CHARS)
  start = Math.max(0, end - EXCERPT_CHARS)

  // Snap to word boundaries so an excerpt never opens or closes mid-word.
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space !== -1 && space < centre) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > centre) end = space
  }

  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}
