"""Turning a book into parts: segment, group by chapter, synthesize, package."""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

from . import audio as audio_io
from . import book as book_io
from .segment import Segment, SegmentOptions, segment_document
from .synth import CHARS_PER_SECOND, Backend


@dataclass
class Part:
    """One audio file: a chapter, or a whole spine document if it has no anchors."""

    id: str
    label: str
    spine_path: str
    spine_href: str
    fragment: str | None
    segments: list[Segment] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return sum(len(segment.text) for segment in self.segments)

    @property
    def estimated_seconds(self) -> float:
        return self.chars / CHARS_PER_SECOND


def plan(source: book_io.Epub, options: SegmentOptions) -> tuple[list[Part], dict[str, bytes]]:
    """Segments every spine document, returning the parts and the rewritten XHTML.

    The rewrite is held rather than applied so a dry run can report on a book
    without producing one.
    """
    parts: list[Part] = []
    rewritten: dict[str, bytes] = {}
    counter = 0

    for doc in source.spine:
        tree = book_io.parse_xml(source.files[doc.path])
        entries = [entry for entry in source.toc if entry.path == doc.path]
        fragments = {entry.fragment for entry in entries if entry.fragment}

        segments, positions = segment_document(tree, doc.path, counter, options, fragments)
        counter += len(segments)
        if not segments:
            continue

        rewritten[doc.path] = etree.tostring(
            tree,
            xml_declaration=True,
            encoding='utf-8',
            doctype=tree.docinfo.doctype or None,
        )
        parts.extend(_split_into_parts(doc, entries, positions, segments))

    # Numbered only once the empty parts are gone, so ids stay dense and unique.
    for index, part in enumerate(parts, start=1):
        part.id = f'p{index:04d}'
    return parts, rewritten


def _split_into_parts(doc, entries, positions, segments: list[Segment]) -> list[Part]:
    """Cuts a document's segments at its table-of-contents anchors.

    Gutenberg puts dozens of chapters in one XHTML file and separates them with
    `#anchor` fragments, so a spine document is the wrong unit for an audio file:
    it would be a two-hour download to hear ten minutes. Chapters are.
    """
    anchors = sorted(
        (
            (positions.get(entry.fragment, 0) if entry.fragment else 0, entry)
            for entry in entries
            if not entry.fragment or entry.fragment in positions
        ),
        key=lambda pair: pair[0],
    )

    parts: list[Part] = []

    def new_part(label: str, fragment: str | None) -> Part:
        part = Part(
            id='',
            label=label,
            spine_path=doc.path,
            spine_href=doc.href,
            fragment=fragment,
        )
        parts.append(part)
        return part

    if not anchors:
        current = new_part(Path(doc.path).stem, None)
        current.segments = list(segments)
        return parts

    # Anything before the first anchor is front matter of the document; it only
    # gets its own part when the first anchor is not at the very top.
    current = None
    index = 0
    for order, entry in anchors:
        while index < len(segments) and segments[index].order < order:
            if current is None:
                current = new_part(f'{Path(doc.path).stem} (opening)', None)
            current.segments.append(segments[index])
            index += 1
        current = new_part(entry.label, entry.fragment)

    while index < len(segments):
        current.segments.append(segments[index])
        index += 1

    return [part for part in parts if part.segments]


def build_epub(source: book_io.Epub, rewritten: dict[str, bytes], out_path: Path) -> None:
    source.files.update(rewritten)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    source.save(str(out_path))


def synthesize(
    parts: list[Part],
    backend: Backend,
    out_dir: Path,
    *,
    fmt: str,
    bitrate: str,
    gap: float,
    resume: bool,
    cache_context: dict | None = None,
    log=print,
) -> list[dict]:
    """Renders each part to an audio file, returning its sync record.

    Completed parts are appended to `parts.jsonl` as they finish. A full book is
    hours of GPU time; losing all of it to a crash in the last chapter would be
    the tool's own fault, not the machine's.
    """
    audio_dir = out_dir / 'audio'
    audio_dir.mkdir(parents=True, exist_ok=True)
    progress_path = out_dir / 'parts.jsonl'

    done = _load_progress(progress_path) if resume else {}
    records: list[dict] = []
    total_segments = sum(len(part.segments) for part in parts)
    spoken = 0
    started = time.monotonic()

    for position, part in enumerate(parts, start=1):
        cache_key = _cache_key(
            part,
            backend_name=backend.name,
            sample_rate=backend.sample_rate,
            fmt=fmt,
            bitrate=bitrate,
            gap=gap,
            context=cache_context or {},
        )
        cached = done.get(part.id)
        if cached and _still_valid(cached, out_dir, cache_key):
            log(f'[{position}/{len(parts)}] {part.label} — already done, skipping')
            records.append(cached)
            spoken += len(part.segments)
            continue

        log(f'[{position}/{len(parts)}] {part.label} — {len(part.segments)} segments')
        clips = []
        for segment in part.segments:
            clips.append(backend.synth(segment.text))
            spoken += 1
            if spoken % 200 == 0:
                log(f'    {spoken}/{total_segments} segments, {_rate(started, spoken)}')

        samples, bounds = audio_io.concatenate(clips, backend.sample_rate, gap)
        name = f'{part.id}-{_slug(part.label)}'
        wav_path = audio_dir / f'{name}.wav'
        audio_io.write_wav(wav_path, samples, backend.sample_rate)

        if fmt == 'opus':
            final_path = audio_dir / f'{name}.opus'
            audio_io.encode_opus(wav_path, final_path, bitrate)
            wav_path.unlink()
        else:
            final_path = wav_path

        record = {
            'id': part.id,
            'label': part.label,
            'file': f'audio/{final_path.name}',
            'spineHref': part.spine_href,
            'spinePath': part.spine_path,
            'fragment': part.fragment,
            'duration': round(len(samples) / backend.sample_rate, 3),
            'bytes': final_path.stat().st_size,
            'cacheKey': cache_key,
            'segments': [
                {'id': segment.id, 'start': round(start, 3), 'end': round(end, 3)}
                for segment, (start, end) in zip(part.segments, bounds)
            ],
        }
        records.append(record)
        with progress_path.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(record) + '\n')

    return records


def _load_progress(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    done: dict[str, dict] = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            record = json.loads(line)
            done[record['id']] = record
    return done


def _cache_key(
    part: Part,
    *,
    backend_name: str,
    sample_rate: int,
    fmt: str,
    bitrate: str,
    gap: float,
    context: dict,
) -> str:
    """Content-addresses everything that can change a part's rendered audio."""
    payload = {
        'version': 1,
        'segments': [{'id': segment.id, 'text': segment.text} for segment in part.segments],
        'backend': backend_name,
        'sampleRate': sample_rate,
        'format': fmt,
        'bitrate': bitrate if fmt == 'opus' else None,
        'gap': gap,
        'context': context,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _still_valid(record: dict, out_dir: Path, cache_key: str) -> bool:
    """A cached part is reusable only if its complete file and inputs survive."""
    file_value = record.get('file')
    if not isinstance(file_value, str):
        return False
    path = out_dir / file_value
    if not path.is_file():
        return False
    if record.get('bytes') != path.stat().st_size:
        return False
    return record.get('cacheKey') == cache_key


def write_sync(
    source: book_io.Epub,
    records: list[dict],
    out_dir: Path,
    *,
    backend_name: str,
    voice: str,
    sample_rate: int,
    epub_name: str,
    id_prefix: str,
) -> Path:
    payload = {
        'version': 1,
        'generator': 'marginalia narrate',
        'book': {
            'title': source.title,
            'author': source.author,
            'language': source.language,
        },
        'epub': epub_name,
        'voice': voice,
        'backend': backend_name,
        'sampleRate': sample_rate,
        'spanIdPrefix': id_prefix,
        'duration': round(sum(record['duration'] for record in records), 3),
        'parts': records,
    }
    path = out_dir / 'sync.json'
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')
    return path


def _slug(label: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')
    return (slug or 'part')[:48]


def _rate(started: float, done: int) -> str:
    elapsed = time.monotonic() - started
    if elapsed <= 0 or not done:
        return ''
    return f'{done / elapsed:.1f} segments/s'


def format_duration(seconds: float) -> str:
    hours, rest = divmod(int(seconds), 3600)
    minutes, secs = divmod(rest, 60)
    return f'{hours}h {minutes:02d}m {secs:02d}s' if hours else f'{minutes}m {secs:02d}s'
