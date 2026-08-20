"""Restating per-part narration timings on one combined recording.

`narrate` renders a book as one audio file per chapter and records each
sentence's `[start, end)` *within its own file*. Publishing concatenates those
files into a single Opus stream, and that stream is what the reader seeks in, so
every timestamp has to be restated against the combined timeline before a
browser can act on it.

Two things stop this being a running total:

Parts are appended to `parts.jsonl` as they finish, and `--resume` appends again
on a later run, so line order is not reading order. Part ids are, and the
concatenation manifest is the authority on what actually went into the file.

A running total is also one long chain of additions over four hundred parts,
and its error only grows. The published `metadata.json` already carries chapter
boundaries measured on the combined file, so each chapter's run of parts is
anchored to them. Any disagreement then stays inside the chapter it came from
instead of shifting every later sentence by the same accumulated amount.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

#: Prefix `segment.py` gives every span it wraps a sentence in.
SPAN_ID_PREFIX = 'mg-'

#: How far a catalog chapter boundary may sit from the nearest part boundary
#: before the two are treated as describing different things. Chapters are cut
#: at part boundaries, so a real match is exact to within rounding; anything
#: larger means the grouping is being guessed at, which is worse than failing.
DEFAULT_TOLERANCE = 0.5


class TimelineError(RuntimeError):
    pass


@dataclass
class TimedPart:
    """One rendered audio file and the sentences inside it."""

    id: str
    file: str
    #: Spine href the part's text lives in, relative to the OPF.
    href: str
    duration: float
    #: `(span id, start within this file)`, in reading order.
    segments: list[tuple[str, float]] = field(default_factory=list)


def load_part_records(path: Path) -> dict[str, dict]:
    """Reads narrate's resume log, or its `sync.json`, keyed by part id.

    A part can appear in `parts.jsonl` more than once: the log is appended to as
    each part finishes, and a `--resume` run that re-renders a part appends a
    second record for it. The later line describes the audio that now exists.
    """
    text = path.read_text(encoding='utf-8')

    records: list[dict]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get('parts'), list):
        records = payload['parts']
    else:
        records = [json.loads(line) for line in text.splitlines() if line.strip()]

    by_id: dict[str, dict] = {}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('id'), str):
            raise TimelineError(f'{path}: every part record needs a string id.')
        by_id[record['id']] = record
    if not by_id:
        raise TimelineError(f'{path}: no part records found.')
    return by_id


_QUOTED = re.compile(r"^file\s+'(.*)'$")
_BARE = re.compile(r'^file\s+(\S+)$')


def read_concat_manifest(path: Path) -> list[str]:
    """Returns the audio files an ffmpeg concat manifest lists, in order."""
    files: list[str] = []
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        quoted = _QUOTED.match(line)
        if quoted:
            # ffmpeg escapes a single quote inside a quoted path as '\''.
            files.append(quoted.group(1).replace("'\\''", "'"))
            continue
        bare = _BARE.match(line)
        if bare:
            files.append(bare.group(1))
        elif line.startswith('file'):
            raise TimelineError(f'{path}: could not parse manifest line: {raw!r}')
    return files


def order_parts(
    records: dict[str, dict],
    manifest: list[str],
    span_prefix: str = SPAN_ID_PREFIX,
) -> list[TimedPart]:
    """Puts the part records in the order they were concatenated.

    With a manifest that order is the manifest's, which is the only record of
    what actually went into the combined file. Without one it falls back to part
    id, which `pipeline.plan` assigns densely in reading order.
    """
    if manifest:
        by_file = {Path(record.get('file', '')).name: record for record in records.values()}
        chosen = []
        for name in manifest:
            record = by_file.get(Path(name).name)
            if record is None:
                raise TimelineError(
                    f'The manifest lists {name!r}, which no part record describes. '
                    f'The timings and the audio would not be about the same book.'
                )
            chosen.append(record)
    else:
        chosen = [records[key] for key in sorted(records)]

    parts: list[TimedPart] = []
    for record in chosen:
        parts.append(_timed_part(record, span_prefix))
    return parts


def _timed_part(record: dict, span_prefix: str) -> TimedPart:
    part_id = record['id']
    duration = record.get('duration')
    href = record.get('spineHref')
    segments = record.get('segments')
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise TimelineError(f'{part_id}: missing or non-positive duration.')
    if not isinstance(href, str) or not href:
        raise TimelineError(f'{part_id}: missing spineHref.')
    if not isinstance(segments, list) or not segments:
        raise TimelineError(f'{part_id}: no segment timings. Re-render this part.')

    timed: list[tuple[str, float]] = []
    previous = -1.0
    for segment in segments:
        span_id = segment.get('id') if isinstance(segment, dict) else None
        start = segment.get('start') if isinstance(segment, dict) else None
        if not isinstance(span_id, str) or not span_id.startswith(span_prefix):
            raise TimelineError(f'{part_id}: segment id {span_id!r} is not a {span_prefix}* span.')
        if not isinstance(start, (int, float)) or not 0 <= start <= duration:
            raise TimelineError(f'{part_id}: segment {span_id} starts outside its own audio.')
        if start < previous:
            raise TimelineError(f'{part_id}: segment {span_id} runs backwards.')
        previous = start
        timed.append((span_id, float(start)))

    return TimedPart(
        id=part_id,
        file=str(record.get('file', '')),
        href=href,
        duration=float(duration),
        segments=timed,
    )


def _boundaries(parts: list[TimedPart]) -> list[float]:
    """Naive part start times, plus the end of the last part."""
    running = 0.0
    out = [0.0]
    for part in parts:
        running += part.duration
        out.append(running)
    return out


def _floor_ms(seconds: float) -> float:
    """Truncates to milliseconds, never rounding a start later than it really is.

    Rounding to the nearest millisecond can push a sentence half a millisecond
    past its own start, and the published catalog carries finer precision than
    that: a chapter beginning at 4308.0815s would have its first sentence at
    4308.082s, which lands *outside* the chapter, so asking what is being spoken
    at that boundary answers with the last sentence of the chapter before.
    Truncating biases the other way, where the cost is landing a hair early --
    inside the silent gap that precedes the sentence.
    """
    # The epsilon absorbs binary representation error, so a value that is
    # exactly 45.015 in decimal cannot truncate to 45.014.
    return math.floor(seconds * 1000 + 1e-6) / 1000


@dataclass
class ChapterRun:
    """The parts one published chapter was cut from, and where they land."""

    first: int
    last: int
    naive_start: float
    naive_end: float
    start: float
    end: float

    @property
    def scale(self) -> float:
        naive = self.naive_end - self.naive_start
        return (self.end - self.start) / naive if naive > 0 else 1.0

    def at(self, naive: float) -> float:
        return self.start + (naive - self.naive_start) * self.scale


def anchor_chapters(
    boundaries: list[float],
    chapters: list[dict],
    tolerance: float = DEFAULT_TOLERANCE,
) -> list[ChapterRun]:
    """Matches each published chapter to the run of parts that produced it.

    Chapters are cut at part boundaries, so each chapter should be exactly as
    long as some run of parts. A chapter whose length matches no run means the
    published catalog and these timings do not describe the same assembly, and
    stretching one onto the other anyway would silently misplace every sentence
    in it.

    Lengths, not positions. Comparing a chapter's absolute start against a
    running total of every part before it would fold each earlier chapter's
    disagreement into the comparison, so a fifth of a second per chapter becomes
    six tenths by the fourth and fails a tolerance that no single chapter
    exceeds -- the same accumulation the correction below exists to prevent.
    Measuring each chapter from the boundary already anchored keeps every match
    answerable by the parts inside that one chapter.
    """
    if not chapters:
        raise TimelineError('The published metadata lists no chapters.')
    if abs(chapters[0]['startSeconds']) > tolerance:
        raise TimelineError('The published chapters do not begin at the start of the recording.')

    # The parts *are* the recording, so the first chapter opens the first part.
    edges = [0]
    for position in range(1, len(chapters)):
        cursor = edges[-1]
        if cursor + 1 >= len(boundaries):
            raise TimelineError(
                f'Chapter {chapters[position]["id"]!r} has no parts left to cover it.'
            )
        length = chapters[position]['startSeconds'] - chapters[position - 1]['startSeconds']
        index = min(
            range(cursor + 1, len(boundaries)),
            key=lambda i: abs((boundaries[i] - boundaries[cursor]) - length),
        )
        residual = abs((boundaries[index] - boundaries[cursor]) - length)
        if residual > tolerance:
            raise TimelineError(
                f'Chapter {chapters[position - 1]["id"]!r} runs {length:.3f}s in the published '
                f'catalog, which is {residual:.3f}s from any run of parts. These timings are not '
                f'from the audio the published catalog describes.'
            )
        edges.append(index)

    last = chapters[-1]
    tail = boundaries[-1] - boundaries[edges[-1]]
    end_residual = abs(tail - (last['endSeconds'] - last['startSeconds']))
    if end_residual > tolerance:
        raise TimelineError(
            f'Chapter {last["id"]!r} ends the recording after '
            f'{last["endSeconds"] - last["startSeconds"]:.3f}s but its parts run {tail:.3f}s, '
            f'a gap of {end_residual:.3f}s.'
        )

    edges = [*edges, len(boundaries) - 1]
    runs: list[ChapterRun] = []
    for position, chapter in enumerate(chapters):
        first, last = edges[position], edges[position + 1]
        runs.append(
            ChapterRun(
                first=first,
                last=last,
                naive_start=boundaries[first],
                naive_end=boundaries[last],
                start=float(chapter['startSeconds']),
                end=float(chapter['endSeconds']),
            )
        )
    return runs


def _unanchored_run(boundaries: list[float], duration: float) -> list[ChapterRun]:
    """One run over the whole book, with no correction applied."""
    return [
        ChapterRun(
            first=0,
            last=len(boundaries) - 1,
            naive_start=0.0,
            naive_end=boundaries[-1],
            start=0.0,
            end=boundaries[-1] or duration,
        )
    ]


def build_sync(
    parts: list[TimedPart],
    *,
    audio_id: str,
    duration: float,
    chapters: list[dict] | None,
    tolerance: float = DEFAULT_TOLERANCE,
    span_prefix: str = SPAN_ID_PREFIX,
    log=print,
) -> dict:
    """Builds the published sync map: every span id, at its time in the stream."""
    if not parts:
        raise TimelineError('No parts to place on the timeline.')

    boundaries = _boundaries(parts)
    runs = (
        anchor_chapters(boundaries, chapters, tolerance)
        if chapters
        else _unanchored_run(boundaries, duration)
    )

    # One run per part, resolved up front: a part outside every run would
    # otherwise be a lookup failure in the middle of the walk.
    run_of_part: list[ChapterRun] = []
    for index in range(len(parts)):
        match = next((run for run in runs if run.first <= index < run.last), None)
        if match is None:
            raise TimelineError(f'Part {parts[index].id} falls outside every chapter.')
        run_of_part.append(match)

    documents: list[dict] = []
    seen: set[str] = set()
    previous_start = -1.0

    for index, part in enumerate(parts):
        run = run_of_part[index]
        if not documents or documents[-1]['href'] != part.href:
            documents.append({'href': part.href, 'spans': [], 'starts': []})
        document = documents[-1]

        for span_id, start in part.segments:
            if span_id in seen:
                raise TimelineError(f'Span {span_id} appears in more than one part.')
            seen.add(span_id)

            absolute = _floor_ms(run.at(boundaries[index] + start))
            if absolute < previous_start:
                raise TimelineError(
                    f'Span {span_id} lands at {absolute:.3f}s, before the span before it. '
                    f'The parts are out of order.'
                )
            if absolute > duration + tolerance:
                raise TimelineError(
                    f'Span {span_id} lands at {absolute:.3f}s, past the end of a '
                    f'{duration:.3f}s recording.'
                )
            previous_start = absolute
            document['spans'].append(span_id)
            document['starts'].append(min(absolute, duration))

    drift = max((abs(run.scale - 1.0) for run in runs), default=0.0)
    log(
        f'{len(seen):,} spans across {len(documents)} documents; '
        f'largest chapter correction {drift * 100:.4f}%'
    )

    return {
        'version': 1,
        'generator': 'marginalia narrate timeline',
        'audioId': audio_id,
        'durationSeconds': duration,
        'spanIdPrefix': span_prefix,
        'documents': documents,
    }


def _load_metadata(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding='utf-8'))
    audiobook = payload.get('audiobook')
    if not isinstance(audiobook, dict):
        raise TimelineError(f'{path}: no audiobook block.')

    sha256 = audiobook.get('sha256')
    audio_id = audiobook.get('audioId') or (f'sha256:{sha256}' if isinstance(sha256, str) else None)
    duration = audiobook.get('durationSeconds')
    if not isinstance(audio_id, str) or not audio_id:
        raise TimelineError(f'{path}: no audioId, and no sha256 to build one from.')
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise TimelineError(f'{path}: no durationSeconds.')

    chapters = payload.get('chapters')
    if not isinstance(chapters, list):
        raise TimelineError(f'{path}: no chapters.')
    return {'audioId': audio_id, 'durationSeconds': float(duration), 'chapters': chapters}


def write_sync(payload: dict, path: Path) -> None:
    """Writes the map compactly: it is fetched by a phone, not read by a person."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8',
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog='narrate.timeline',
        description=(
            "Restate narrate's per-part sentence timings on the combined recording, "
            'so the reader can seek to a sentence and follow the audio through the text.'
        ),
    )
    parser.add_argument(
        '--parts',
        required=True,
        type=Path,
        help="narrate's parts.jsonl resume log, or its sync.json.",
    )
    parser.add_argument(
        '--metadata',
        required=True,
        type=Path,
        help='The published metadata.json for the combined recording.',
    )
    parser.add_argument(
        '--concat',
        type=Path,
        help=(
            'The ffmpeg concat manifest used to build the combined file. '
            'Without it the parts are ordered by id.'
        ),
    )
    parser.add_argument('-o', '--out', required=True, type=Path, help='Where to write sync.json.')
    parser.add_argument(
        '--no-anchor',
        action='store_true',
        help='Sum part durations instead of anchoring each chapter to the published catalog.',
    )
    parser.add_argument(
        '--tolerance',
        type=float,
        default=DEFAULT_TOLERANCE,
        help=f'Seconds a chapter boundary may miss a part boundary by (default: {DEFAULT_TOLERANCE}).',
    )
    args = parser.parse_args(argv)

    try:
        metadata = _load_metadata(args.metadata)
        records = load_part_records(args.parts)
        manifest = read_concat_manifest(args.concat) if args.concat else []
        parts = order_parts(records, manifest)

        if manifest:
            print(f'{len(parts)} parts, ordered by the concat manifest')
        else:
            print(f'{len(parts)} parts, ordered by id (no manifest given)')

        payload = build_sync(
            parts,
            audio_id=metadata['audioId'],
            duration=metadata['durationSeconds'],
            chapters=None if args.no_anchor else metadata['chapters'],
            tolerance=args.tolerance,
        )
    except TimelineError as error:
        print(f'error: {error}', file=sys.stderr)
        return 1

    write_sync(payload, args.out)
    print(f'Wrote {args.out} ({args.out.stat().st_size / 1000:.0f} kB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
