# Mirror threads to Markdown files through the bridge

Date: 2026-10-18
Status: Proposed

## Context

Threads live only in the browser's IndexedDB (decision 0001). A reader who
already runs the local agent bridge (decision 0010) may want their
conversations about a book as ordinary files on their computer, next to their
other notes, where an editor, a backup or a search tool can reach them. A web
page cannot write to a path of the reader's choosing, but the bridge can.

## Decision

When the bridge is started with `--save-dir <path>`, it keeps a Markdown copy
of each thread under that folder, and the paired app sends it each thread
after every completed reply.

- **The path is set only on the bridge's command line.** Settings shows it but
  cannot change it, so no web page can choose where files are written. The
  bridge creates the folder at startup if it is missing, refuses a symlink, a
  non-directory or another user's folder, and checks again before every write:
  if the folder has gone (an unmounted disk), saving fails visibly instead of
  recreating it somewhere else.
- **One-way mirror.** IndexedDB stays the source of truth. Each write replaces
  the whole file; edits made on disk are not read back, and the next save of
  that thread overwrites them. Deleting a thread in Rami leaves its file, so
  nothing the reader keeps on disk is removed by the app.
- **Layout, with no index.**
  `<save-dir>/<book slug>--<book id>/<date>-<title slug>--<thread id>.md`.
  The bridge builds every component itself, never from a path in the request:
  slugs are lowercase ASCII with single hyphens and at most 50 characters, and
  ids must be lowercase `[a-z0-9_-]`, 8 to 64 characters, so traversal,
  reserved device names and case-only collisions cannot arise. Because a slug
  never contains `--`, the id is exactly what follows the first `--`, and the
  bridge finds a book's folder and a thread's file by comparing that id. The
  titles are fixed at the first save, so renaming a thread or book changes its
  front matter, not its path, and nothing needs a separate index.
- **Writes.** Saves run one at a time per book, so two threads never race to find or create its folder. The bridge reads the saved
  message count and update time from the existing file and refuses an older
  copy (409 with the code `stale`, which the app treats as done), so a slow tab
  or "Save all" cannot roll a thread back. Any other refusal is a failure. A file is
  written to an exclusive temporary name beside it, then renamed over the old
  one; an existing symlink or non-file in its place is refused. New folders
  are 0700 and files 0600.
- **Format.** YAML front matter with fixed keys whose values are JSON strings
  or numbers: book, author, chapter, position, created and updated times, the
  thread id and its message count. Then the title, the highlighted passage as
  a blockquote with every line prefixed, and each turn under a "Reader" or
  "Rami" heading. Book text and replies are untrusted, so all of it is written
  as literal text: control characters are dropped, `&`, `<` and `>` are
  escaped so no HTML runs in a viewer, image syntax is neutralized so nothing
  loads remotely, and a leading `#` or an underline of `=` or `-` is escaped
  so text cannot forge a turn heading. Links stay clickable. System prompts are not saved.
- **Endpoint.** `PUT /v1/threads/:id` with an explicit thread object (the book's
  id, title and author; the thread's id, title, chapter, position, passage and
  times; reader and Rami turns only), up to 2 MB and 1,000 turns, behind the
  same pairing, origin and loopback checks as chat. `GET /v1/status` adds
  `saveDir`, the path or null.
- **Client.** `src/lib/threadMirror.ts` saves a thread after each completed
  reply is stored and, after a KOReader import commits, every thread it added
  or extended. Settings offers "Save all threads now" for existing threads,
  one at a time with a timeout each. A failed save never touches chat or the
  database; Settings shows the last result. Only allowlisted fields are sent,
  never publishing tokens or whole database rows, and nothing is sent unless
  the bridge reports a save folder. Paths and content stay out of telemetry.

Anything else that reads the folder, such as a backup or a search indexer,
gets the files too; the reader chose the folder knowing that. As in decision
0010, a process already running as the reader can tamper with the folder;
the checks above stop mistakes and the app, not such a process.

## Alternatives and tradeoffs

- The browser's File System Access API: no bridge, but Chrome and Edge only,
  and the reader picks a folder in a dialog rather than naming a path.
- A path typed in Settings: handier, but the page would then tell the
  reader's machine where to write, which needs its own allowlist.
- Two-way sync: edits on disk would flow back, at the cost of conflict
  handling and a Dexie change. A mirror can grow into it later.
- JSON files: easier for tools, harder to read. Markdown with front matter
  serves both reasonably.
- Titles in file names kept in sync through an index file: names would track
  renames, but the index is one more thing to corrupt, race and validate.
- Mirroring deletions: keeps the folder exact, but would let the app remove
  files the reader may have annotated. Leaving them is the safer default.
