/**
 * The read-only page a published thread is served at, `/t/<id>`. Static HTML
 * with every stored value escaped and no scripts, so the recipient needs
 * neither the PWA bundle nor IndexedDB, and chat apps can read the preview
 * tags. Text stays plain: URLs in it are never turned into links, which keeps
 * the page worthless for link spam.
 */

import type { LinkStore } from './publishing.ts'
import { loadThread, type StoredThread } from './threads.ts'

const APP_NAME = 'Rami'

export async function handleThreadPage(
  request: Request,
  store: LinkStore | undefined,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Use GET.', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const url = new URL(request.url)
  const id = url.pathname.replace(/^\/t\//, '')
  const stored = await loadThread(store, id)
  return stored ? page(200, renderThread(stored, url.origin)) : page(404, renderMissing(url.origin))
}

function page(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // No HTTP caching on top of KV, whose deletes already take up to a minute to
      // reach every location.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export function renderThread({ thread, publishedAt }: StoredThread, origin: string): string {
  const { book, chapter, passage, messages } = thread
  const source = book.author ? `${book.title} by ${book.author}` : book.title
  const title = `A conversation about ${book.title}`
  const summary = passage ?? messages[0]?.content ?? ''
  const published = new Date(publishedAt).toISOString().slice(0, 10)

  const turns = messages
    .map((message) =>
      message.role === 'user'
        ? `<div class="you"><p class="who">Reader</p><p class="bubble">${escape(message.content)}</p></div>`
        : `<div class="rami"><span class="mark" aria-hidden="true">R</span><div><p class="who">${APP_NAME} (AI)</p><p>${escape(message.content)}</p></div></div>`,
    )
    .join('\n')

  return document({
    title,
    description: excerpt(summary, 200),
    origin,
    body: `
<header>
  <p class="eyebrow">${escape(chapter ?? 'A shared thread')}</p>
  <h1>${escape(source)}</h1>
  <p class="intro">A reader’s questions${passage ? ' about a passage' : ''}, answered by ${APP_NAME}, an AI reading companion.</p>
</header>
${passage ? `<figure><figcaption class="who">From the book</figcaption><blockquote>${escape(passage)}</blockquote></figure>` : ''}
<section aria-label="Conversation">
${turns}
</section>
<footer>
  <p>Shared from ${APP_NAME} on <time datetime="${published}">${published}</time>.</p>
  <a class="cta" href="${origin}/">Read with ${APP_NAME}</a>
</footer>`,
  })
}

function renderMissing(origin: string): string {
  return document({
    title: 'This link is no longer available',
    description: `A thread shared from ${APP_NAME}.`,
    origin,
    body: `
<header><h1>This link is no longer available</h1></header>
<p>It expired or its owner removed it.</p>
<footer><a class="cta" href="${origin}/">Read with ${APP_NAME}</a></footer>`,
  })
}

function document({
  title,
  description,
  origin,
  body,
}: {
  title: string
  description: string
  origin: string
  body: string
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} · ${APP_NAME}</title>
<meta name="description" content="${escape(description)}">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:image" content="${origin}/icon-512.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

/** Collapses whitespace and cuts at a word boundary. */
function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const space = flat.lastIndexOf(' ', max - 1)
  return `${flat.slice(0, space > 0 ? space : max - 1)}…`
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

// Rami's paper and ink tokens from `src/index.css`, light and Lamplight.
const STYLE = `
:root { --paper:#f4ecda; --leaf:#faf5e9; --sunk:#ebe0c8; --rule:#ddd0b3; --ink:#2b2219;
  --soft:#5c4d3c; --moss:#4b5c3c; --on-moss:#faf5e9; --rubric:#8e3626; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --paper:#1d1813; --leaf:#27201a; --sunk:#15110d;
  --rule:#3b3128; --ink:#eee2c9; --soft:#c4b497; --moss:#a7b78c; --on-moss:#1d1813; --rubric:#e0937a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 18px/1.55 Georgia, 'Iowan Old Style', 'Palatino Linotype', serif; }
main { max-width: 680px; margin: 0 auto; padding: 32px 16px 48px; }
.eyebrow { margin: 0; color: var(--rubric); font-size: 13px; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 4px 0 8px; font-size: 28px; line-height: 1.2; font-weight: 500; }
.intro { margin-bottom: 24px; color: var(--soft); font-size: 16px; }
.who { margin-bottom: 4px; color: var(--soft); font: 600 12px/1.4 system-ui, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; }
figure { margin: 0 0 28px; }
blockquote { margin: 0; padding: 16px 20px; background: var(--sunk); border-radius: 8px;
  font-style: italic; white-space: pre-wrap; overflow-wrap: anywhere; }
section { display: grid; gap: 18px; }
p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.you { justify-self: end; max-width: 85%; text-align: right; }
.bubble { padding: 10px 14px; border-radius: 8px 8px 3px 8px; text-align: left;
  background: var(--moss); color: var(--on-moss); }
.rami { display: flex; gap: 12px; align-items: flex-start; }
.mark { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  background: var(--sunk); color: var(--rubric); font-size: 15px; }
footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--soft);
  display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; justify-content: space-between; font-size: 15px; }
.cta { display: inline-flex; min-height: 44px; align-items: center; padding: 0 18px; border-radius: 6px;
  background: var(--moss); color: var(--on-moss); text-decoration: none; font-weight: 600; }
`
