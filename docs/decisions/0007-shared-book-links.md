# Share books at links that add them for the recipient

Date: 2026-10-12
Status: Accepted

## Context

Readers want to invite someone to read a book with them: a "Share book" item
in the library's book menu that sends a link, through the share sheet on a
phone or as a copied blurb on a desktop. Opening the link should show Rami and
add the book to the recipient's library. The link's preview card in chat apps
should show the cover the sharer currently uses, which may be the EPUB's own,
one picked from Open Library, or an image they uploaded.

Two facts shape this. Books live only on the device, so the recipient's copy
has to come from somewhere public. And a preview card is fetched by the chat
app's server, which cannot see the sharer's IndexedDB, so the cover has to be
hosted.

## Decision

- **Gutenberg books only.** The recipient's copy is downloaded from Project
  Gutenberg through the existing relay. The book's Gutenberg id is read from
  the `dc:identifier` Gutenberg writes into every EPUB it generates
  (`http://www.gutenberg.org/2701`), so no id has to be stored, and books
  imported before this change qualify too. A book added from a file without
  that identifier cannot be shared, and the dialog says why. The sharer's EPUB
  is never uploaded.
- **Published like a thread (0006).** `POST /api/books` stores the title,
  author, Gutenberg id and cover under an unguessable id, with the same
  Turnstile check, owner token kept only as a hash, one-year expiry, kill
  switch (`THREADS_ENABLED`) and same-origin check. `PUT` and `DELETE` take
  the owner token. Records go in the existing `THREADS` KV namespace under a
  `book:` prefix, so no new binding or deploy step is needed.
- **The cover is re-encoded before upload.** The PWA redraws it on a canvas as
  a JPEG of at most 900 px tall and 240 KB. That bounds the size and strips
  metadata such as a photo's location. The server accepts only a JPEG under
  256 KB and serves it at `/b/<id>/cover` as `image/jpeg` with `nosniff`.
- **The link is the app.** `/b/<id>` serves the PWA's own `index.html` with
  Open Graph tags for that book added by the Worker, so chat apps draw the
  card and a person lands in Rami, which reads `GET /api/books/<id>` and adds
  the book. A bundled sample is shelved from the app's own copy instead of
  downloaded, and a file already on the shelf is opened rather than
  duplicated.
- **One link per book.** The link and owner token are saved on the book record
  (`sharedLink`, not indexed, so no Dexie version). Sharing again reuses it,
  and when the cover changed since the last upload the dialog sends the new
  one first. Deleting the book removes the link; archiving keeps it, since the
  Gutenberg copy it points to is unaffected. Exports drop the owner token.
- **Two taps.** Creating the link needs the Turnstile pass and a network round
  trip, which spends the tap's user activation, so the dialog creates the link
  and then offers Share (touch devices) or Copy invitation (desktop).

## Alternatives and tradeoffs

- **`/add?gutenberg=<id>` with no server storage:** one tap and no hosted
  content, but the preview could only show Gutenberg's own cover, not the one
  the reader chose.
- **A separate KV namespace:** cleaner naming, but a new binding for Previews
  and production for what is a handful of small keys beside the threads.
- **A static viewer page like `/t/<id>`:** no app bundle needed to see it, but
  the recipient would need a second tap to reach Rami, and the goal is that
  opening the link adds the book.
- **Upload the EPUB itself:** would cover non-Gutenberg books, but means
  hosting arbitrary, possibly copyrighted, books.
- **Cost:** we now host images readers upload, under our domain, for a year.
  Defenses are those of 0006 plus the JPEG and size checks; pages are
  `noindex`, and owners or an operator can remove a link at any time.
