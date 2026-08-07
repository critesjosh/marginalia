"""Command line entry point."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import audio as audio_io
from . import book as book_io
from . import pipeline, synth
from .segment import SegmentOptions


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    source = book_io.load(args.epub)
    options = SegmentOptions(
        max_chars=args.max_chars,
        min_chars=args.min_chars,
        skip_classes=frozenset(c for c in args.skip_class.split(',') if c),
    )

    print(f'{source.title or Path(args.epub).name} — {source.author or "unknown author"}')
    print(f'{len(source.spine)} spine documents, {len(source.toc)} table-of-contents entries')

    parts, rewritten = pipeline.plan(source, options)
    if not parts:
        print('No speakable text found. Check --skip-class.', file=sys.stderr)
        return 1
    if args.parts:
        parts = parts[: args.parts]

    if args.dry_run:
        _report(parts, args)
        return 0

    if not audio_io.encode_available(args.format):
        print('ffmpeg is not on PATH. Install it, or pass --format wav.', file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    epub_name = f'{Path(args.epub).stem}.narrated.epub'
    pipeline.build_epub(source, rewritten, out_dir / epub_name)
    print(f'Wrote {out_dir / epub_name}')

    backend = synth.build(args.backend, args.voice, args.lang, args.speed, args.device)
    records = pipeline.synthesize(
        parts,
        backend,
        out_dir,
        fmt=args.format,
        bitrate=args.bitrate,
        gap=args.gap,
        resume=args.resume,
    )

    sync_path = pipeline.write_sync(
        source,
        records,
        out_dir,
        backend_name=backend.name,
        voice=args.voice,
        sample_rate=backend.sample_rate,
        epub_name=epub_name,
        id_prefix=options.id_prefix,
    )

    total_seconds = sum(record['duration'] for record in records)
    total_bytes = sum(record['bytes'] for record in records)
    print(f'Wrote {sync_path}')
    print(
        f'{len(records)} parts, {pipeline.format_duration(total_seconds)} of audio, '
        f'{total_bytes / 1e6:.1f} MB'
    )
    return 0


def _report(parts, args) -> None:
    """Dry run: what this book would cost to narrate, before spending the GPU time."""
    print()
    print(f'{"part":<6}{"segments":>10}{"chars":>10}  label')
    for part in parts[: args.show]:
        print(f'{part.id:<6}{len(part.segments):>10}{part.chars:>10}  {part.label[:52]}')
    if len(parts) > args.show:
        print(f'... and {len(parts) - args.show} more (raise --show to list them)')

    chars = sum(part.chars for part in parts)
    segments = sum(len(part.segments) for part in parts)
    seconds = sum(part.estimated_seconds for part in parts) + segments * args.gap
    kbps = float(args.bitrate.rstrip('kK'))

    print()
    print(f'parts          {len(parts):,}')
    print(f'segments       {segments:,}')
    print(f'characters     {chars:,}')
    print(f'estimated      {pipeline.format_duration(seconds)} of audio')
    print(f'at {args.bitrate:<12} ~{seconds * kbps * 1000 / 8 / 1e6:.0f} MB as Opus')
    print()
    print('For comparison, a hosted API at $15 per million characters would be '
          f'about ${chars / 1e6 * 15:.2f} for this book.')


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog='narrate',
        description='Turn an EPUB into per-chapter audio plus a sync map Marginalia can follow.',
    )
    parser.add_argument('epub', help='Path to the source EPUB.')
    parser.add_argument('-o', '--out', default='out', help='Output directory (default: out).')
    parser.add_argument(
        '--backend',
        default='kokoro',
        choices=['kokoro', 'silence'],
        help='TTS backend. `silence` renders timed silence, for testing the pipeline.',
    )
    parser.add_argument('--voice', default='af_heart', help='Backend voice id.')
    parser.add_argument('--lang', default='a', help="Kokoro language code ('a' = US English).")
    parser.add_argument('--speed', type=float, default=1.0, help='Speaking rate multiplier.')
    parser.add_argument(
        '--device',
        default=None,
        help="Torch device for the model, e.g. 'cuda'. Autodetected when unset.",
    )
    parser.add_argument('--format', default='opus', choices=['opus', 'wav'])
    parser.add_argument('--bitrate', default='24k', help='Opus bitrate (default: 24k).')
    parser.add_argument('--gap', type=float, default=0.35, help='Seconds between segments.')
    parser.add_argument('--max-chars', type=int, default=320, help='Longest utterance.')
    parser.add_argument('--min-chars', type=int, default=40, help='Shortest utterance.')
    parser.add_argument(
        '--skip-class',
        default='pg-boilerplate,toc',
        help='Comma-separated class names to leave unspoken.',
    )
    parser.add_argument('--parts', type=int, default=0, help='Only process the first N parts.')
    parser.add_argument(
        '--resume',
        action='store_true',
        help='Reuse parts already recorded in parts.jsonl.',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Segment and report, without synthesizing or writing anything.',
    )
    parser.add_argument('--show', type=int, default=20, help='Parts to list in a dry run.')
    return parser.parse_args(argv)
