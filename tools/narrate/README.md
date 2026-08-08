# narrate

Turns an EPUB into per-chapter audio plus a **sync map** that Marginalia can follow,
using a local text-to-speech model. Offline batch tool: run it once per book on a
machine with a GPU, copy the output to wherever the reader can fetch it.

This is deliberately not part of the app. Marginalia is a client-side PWA with one
edge function; a CUDA/PyTorch pipeline has no home in it. What crosses the boundary
is the artifact, not the model.

## Why not just make an MP3

Because a bare audio file cannot answer "where am I in the book". The reader tracks
position by CFI, so the audio has to be addressable in the same terms. This tool
therefore emits three things:

1. **A derived EPUB** in which every sentence is wrapped in `<span id="mg-000123">`.
2. **One audio file per chapter**, not per spine document.
3. **`sync.json`**, mapping each span id to a `[start, end)` window in its file.

The browser resolves a span id to a `Range` and then to a CFI with
`contents.cfiFromRange` — the same move `src/lib/chapters.ts` already makes for
table-of-contents anchors. Position then flows through the machinery that exists:
audio drives `rendition.next()`, and the `relocated` handler in `src/lib/useReader.ts`
persists `lastCfi` exactly as it does when you turn a page by hand.

Anchoring on ids rather than character offsets is not fussiness. Offsets would need
this tool's HTML parse and the browser's DOM to agree on whitespace normalisation,
entity expansion and implied elements, and they do not. An id survives reflow, font
changes and theme switches, which is why EPUB 3 Media Overlays anchors the same way.

Chapters rather than spine documents matters just as much for Project Gutenberg
books, which put dozens of chapters in one XHTML file: a spine document of Moby Dick
is a two-hour download to hear ten minutes.

## Install

```bash
pip install -r requirements.txt          # lxml + numpy: enough for --dry-run
pip install kokoro soundfile             # the model; pulls in torch
sudo apt install espeak-ng ffmpeg        # G2P fallback, and Opus encoding
```

Install the CUDA build of torch first if you do not already have one, or Kokoro will
quietly run on the CPU. `--device cuda` pins it.

## Use

Start with a dry run. It segments the whole book and reports what a real run would
produce, without loading a model or writing anything:

```bash
python -m narrate ../../public/books/moby-dick.epub --dry-run
```

```
parts          145
segments       9,340
characters     1,200,557
estimated      23h 54m 26s of audio
at 24k          ~258 MB as Opus
```

Then the real thing:

```bash
python -m narrate ../../public/books/moby-dick.epub -o out/ \
    --voice af_heart --device cuda --resume
```

Output:

```
out/
  moby-dick.narrated.epub     # import this, not the original
  audio/p0007-chapter-1-loomings.opus
  sync.json
  parts.jsonl                 # resume log, appended as each part finishes
```

### Publishing to one combined file

Marginalia streams a single Opus file with byte-range requests rather than one
file per chapter, so the timings in `sync.json` — each measured inside its own
part — have to be restated against the combined recording before a browser can
use them:

```bash
python -m narrate.timeline \
    --parts out/parts.jsonl \
    --concat out/audiobook.concat.txt \
    --metadata ../../workers/audiobooks/catalog/twilight-of-the-idols.json \
    -o out/sync.json
```

Upload the result next to `audiobook.opus` and `metadata.json` as
`<book>/sync.json`; the Worker serves it under the same signed URLs.

Two things make this more than a running total. Parts are appended to
`parts.jsonl` as they finish and appended again by a `--resume` run, so line
order is not reading order — part ids are, and the concat manifest is the record
of what actually went into the file. And a running total over four hundred parts
only accumulates error, so each chapter's run of parts is anchored to the
boundaries the published `metadata.json` already measured on the combined file.
Any disagreement then stays inside the chapter it came from. A chapter boundary
that lands nowhere near a part boundary aborts the run: the two artifacts are
not describing the same assembly, and stretching one onto the other would
misplace every sentence in the chapter rather than fail.

The published map is flat, and grouped by spine document so a span carries the
href it lives in:

```json
{"version":1,"audioId":"sha256:…","durationSeconds":28258.668,"spanIdPrefix":"mg-",
 "documents":[{"href":"text/part0006.xhtml","spans":["mg-000001"],"starts":[0.0]}]}
```

`href#spanId` is a target `rendition.display` accepts, which is the same form
the table of contents already navigates by. *Twilight of the Idols* comes to
3,249 sentences over 421 parts: 100 kB, 27 kB gzipped.

### Resuming

`--resume` reuses a part only when its audio file is complete and its source text,
segment ids, backend, voice, speed, gap and encoding settings still match. A full book
is hours of GPU time; losing it to a crash in the last chapter would be this tool's
fault, not the machine's. Changing the book, segmentation, synthesis or encoding
options invalidates affected parts automatically — the stored audio would no longer
say what the sync map claims.

To smoke-test the whole pipeline with no GPU and no weights:

```bash
python -m narrate book.epub -o /tmp/out --backend silence --format wav --parts 3
```

### Options worth knowing

| Flag | Default | |
| --- | --- | --- |
| `--voice` | `af_heart` | Kokoro voice id. |
| `--device` | autodetect | `cuda` to pin the GPU. |
| `--bitrate` | `24k` | Opus is roughly a tenth of WAV at speech bitrates. |
| `--gap` | `0.35` | Seconds of silence after each utterance. |
| `--max-chars` | `320` | Melville writes 1,000-character sentences; left whole they make segments too coarse to resume from. |
| `--min-chars` | `40` | Merges fragments into the previous utterance. |
| `--skip-class` | `pg-boilerplate,toc` | Left unspoken. These two are Gutenberg's licence header/footer and its inline contents list. |

## Choosing a model

Kokoro-82M (Apache 2.0) is the default because it is **non-autoregressive**: it does
not drift, repeat or trail off on long input. That matters more than raw quality when
a run is ten thousand utterances long and nobody is listening to it. On an RTX 3060
it renders far faster than realtime, so a 24-hour book is well under an hour of GPU
time.

The `Backend` protocol in `synth.py` is one method wide, so swapping in Piper
(faster, more robotic), Chatterbox or F5-TTS (more natural, autoregressive, roughly
realtime and in need of per-utterance retry logic) touches nothing else.

## Limitations

- **The derived EPUB is a different book.** Adding spans changes the DOM, so CFIs
  from the original do not carry over: highlights and conversations made against the
  original will not resolve against the narrated copy. Narrate first, then read.
- **Timestamps assume the encoder preserves duration.** Opus adds a few milliseconds
  of pre-skip, which players handle; segment boundaries are accurate to well under
  the `--gap`.
- **The reader loads `sync.json` but does not yet follow it.** `src/lib/audiobooks.ts`
  fetches and validates the map and can look a sentence up by time or by span id;
  turning pages from the audio is a separate change.
- **Sentence splitting is heuristic.** Abbreviations and initials are handled from a
  list, and a boundary falling inside an inline element is pushed to that element's
  end rather than splitting the markup — a slightly coarser anchor, never a broken
  document. Every rewritten document's text is compared against the source and the
  run aborts if it differs.
