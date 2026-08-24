# Marginalia for KOReader

A [KOReader](https://koreader.rocks/) plugin that brings the two halves of
Marginalia to an e-reader:

- **Ask Marginalia** — long-press a passage, ask a question, get an answer on the
  device. The reply is seeded with the book's metadata, your chapter, roughly
  where you are, and the prose around the passage, exactly as it is in the
  browser. Follow-ups continue the same thread, and threads are kept in the
  book's sidecar so they survive a restart.
- **Marginalia conversations** — a list of everything you have asked, most
  recently active first; pick one to read it and carry it on. In the navigation
  menu, next to the bookmarks.
- **Notes on this book** — a running summary of what you and Marginalia have
  worked out, sent with every question so a later one can build on an earlier one.
- **Export highlights for Marginalia** — writes a JSON file that the web reader
  imports, turning KOReader's highlights and threads into real Marginalia
  highlights and conversations.

No account, no API key. Questions go to the same relay the web app uses, which
holds the inference key server-side and pins the model.

## Installing

Copy the plugin directory onto the device:

```
cp -r marginalia.koplugin <KOReader>/plugins/
```

`<KOReader>` is `/mnt/us/koreader` on a Kindle, `.adds/koreader` on a Kobo, and
`koreader/` in internal storage on Android. Restart KOReader. The plugin appears
under **☰ → More tools → Marginalia**, its conversation list under **☰ →
Marginalia conversations**, and **Ask Marginalia** joins the popup that appears
when you select text.

## Asking a question

Long-press a passage, choose **Ask Marginalia**, type a question. The passage is
highlighted when — and only when — you actually ask something, so opening the
dialog and changing your mind leaves no mark.

The request runs in a subprocess, so the screen stays responsive and tapping
dismisses it if a model is taking too long. The whole conversation is shown, not
just the newest reply — a follow-up is asked because of what was said before.
From there you can ask another, or **Save to note**, which writes the exchange
into that highlight's KOReader note where the bookmark list and every other
exporter can see it.

## Going back to a conversation

Three ways, depending on what you have in front of you.

**Tap a highlight you have asked about.** You get **Continue conversation**,
with **Highlight options** next to it for everything KOReader normally offers
there. A highlight with no conversation behaves exactly as it always did.

**Long-press the passage again.** The button in the selection menu reads
*Continue conversation* rather than *Ask Marginalia* when there is one, and
opens it instead of a question box.

**☰ → Marginalia conversations.** A list of every conversation, most recently
active first, each row showing the chapter, how far through, and how many turns.
Choosing one opens it with **Ask a follow-up** on it. This is the only one of the
three that does not need you to find the passage first, and it is the way back to
a conversation whose highlight you have since deleted — a conversation outlives
its mark.

It sits in the navigation menu — the first tab, and the one ☰ opens on unless you
left it on another, below the table of contents, the bookmarks and the book map —
because it belongs with them: it is a list of places in this book you meant to
come back to. The same row is under **More tools
→ Marginalia** with the rest of the plugin. If you would rather not go through the
menu at all, *Marginalia conversations* is a dispatcher action, so it can be bound
to a gesture or put in a profile under **Taps and gestures**.

Conversations live in the book's sidecar, so they travel with the book, and the
export carries them to the web reader. Nothing comes the other way yet — chats
and the rolling digest made in the browser are not visible here.

## Notes on this book

The point of the notes is that a question asked in chapter thirty can build on
one asked in chapter three: the summary is fenced into the system prompt of every
question, so the companion is not meeting the book fresh each time.

They are folded in as you go — after a conversation has four turns in it, the
next question you ask in that conversation updates the notes first, then goes out
with them. That is a deliberate choice about *when*: KOReader is single-threaded,
so summarising after an answer either makes you wait twice for one question or is
cancelled by your next tap. Doing it just before the notes are needed puts the
wait where you had already accepted one, and dismissing it simply asks with the
notes as they were.

A conversation you never go back to is therefore not folded in automatically.

**Notes on this book** shows them, with **Edit** (later updates merge into
whatever you write, so an edit carries forward), **Clear**, and **Undo last
change** — a bad summary feeds itself into every later one, so one previous
version is always kept. Clearing can be put back the same way.

**Update notes now** folds in every conversation with anything unfolded, down to
a single exchange — the threshold of four turns exists to avoid spending time you
are giving to a question, and this is the path where you asked for the work.

These notes are the device's own. They are not exported and not synchronised with
the browser's, which keeps its own summary of the same book. Both are built the
same way from the same kind of material; they are two notebooks, not one.

## Exporting to the web reader

**More tools → Marginalia → Export highlights for Marginalia** writes a file to
`<KOReader>/marginalia/`, and tells you the full path. On a Kindle that folder
is visible when the device is plugged in over USB.

In Marginalia, open **Settings → Import from KOReader** and choose that file.

The import needs **the same EPUB file** that is on the e-reader — not another
copy of the same book. Marginalia identifies an edition by the SHA-256 of its
bytes and refuses to match on title and author, because two editions share those
while numbering their sections differently, and a highlight given to the wrong
one lands on unrelated text.

Each passage is then found again by searching the book for its text, since
KOReader's crengine xpointers and the web reader's epub.js CFIs are different
coordinate systems with no conversion between them. A passage is accepted only
if it occurs exactly once in the whole book and the position it produces reads
back as the same words. Anything that fails is listed in the import summary with
the reason, and stays in the export file, which remains the record of it.

Importing the same file twice adds nothing the second time: every record carries
the id it had on the device.

## What travels, and what does not

Exported: the book's title, author and fingerprint, every highlight with its
note, chapter, colour, time and the prose around it, and every thread you asked
on the device. The crengine xpointers ride along as provenance; nothing in the
web app reads them.

Not exported: the book file itself, and the notes — the web app builds its own
from the conversations it receives.

Nothing goes to the web reader over the network — the file is the whole
transport. Marginalia has no accounts and keeps everything in the browser's own
storage, so there is no server to sync through.

## Settings

**More tools → Marginalia**:

- **Avoid spoilers** — on by default. Asks the model not to reveal anything past
  where you are.
- **Relay** — where questions are sent, `https://lexici.netlify.app/api/chat` by
  default. Change it only if you host your own. It must be `https://`.

## Connections

Questions and passages are personal, so unlike most KOReader plugins this one
does not accept whatever certificate the other end offers. LuaSec ships
configured with `verify = "none"`, which encrypts the connection to *whoever
answers*; this plugin overrides that with the device's own trusted-roots bundle
(`<KOReader>/data/ca-bundle.crt`) and additionally checks the certificate is for
the host that was actually asked for, which LuaSec does not do on its own.

Two consequences worth knowing:

- **A device with a badly wrong clock cannot verify anything.** If asking fails
  with a certificate error, check the date first — KOReader's Time sync plugin
  will set it.
- **A TLS-inspecting proxy will be refused.** Install its certificate authority
  on the device rather than looking for a switch to turn verification off; there
  isn't one.

## Development

The parts worth testing are pure Lua — no `require` of KOReader — and run under
a Lua VM from the repository root:

```bash
npm test          # includes koreader/tests via fengari
```

`marginalia_prompt.lua`, `marginalia_payload.lua`, `marginalia_view.lua`,
`marginalia_digest.lua` and the arithmetic half of `marginalia_memory.lua` are
the pure ones. `marginalia_prompt.lua` mirrors `src/lib/prompt.ts` section for
section: if one changes the other has to, and `koreader/tests/prompt_spec.lua`
is what notices.
The delimiter that fences book text out of the instructions is the reason that
file has tests at all: it only works because the token cannot be guessed from
the book, so it is drawn from `/dev/urandom` and checked against the text it is
about to wrap.
