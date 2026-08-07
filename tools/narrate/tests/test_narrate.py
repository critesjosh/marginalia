from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lxml import etree

from narrate.book import Epub, SpineDoc, TocEntry
from narrate.pipeline import Part, _cache_key, _still_valid, plan
from narrate.segment import Segment, SegmentOptions, segment_document


class SegmentTests(unittest.TestCase):
    def test_preserves_comments_processing_instructions_and_tail_text(self) -> None:
        tree = etree.ElementTree(
            etree.fromstring(
                b'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>'
                b'One sentence.<!-- marker --> Tail text.<?keep yes?>'
                b'</p></body></html>'
            )
        )

        segments, _ = segment_document(
            tree,
            'chapter.xhtml',
            0,
            SegmentOptions(min_chars=0),
            set(),
        )

        output = etree.tostring(tree).decode()
        self.assertIn('<!-- marker -->', output)
        self.assertIn('<?keep yes?>', output)
        self.assertIn('Tail text.', output)
        self.assertEqual(' '.join(segment.text for segment in segments), 'One sentence. Tail text.')

    def test_nested_toc_anchor_starts_with_its_containing_heading(self) -> None:
        path = 'text/book.xhtml'
        source = Epub(
            path='book.epub',
            files={
                path: (
                    b'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                    b'<p>Introduction.</p>'
                    b'<h2><a id="ch1"/>Chapter One.</h2><p>First body.</p>'
                    b'<h2><a id="ch2"/>Chapter Two.</h2><p>Second body.</p>'
                    b'</body></html>'
                )
            },
            opf_path='content.opf',
            spine=[SpineDoc(idref='book', path=path, href='text/book.xhtml')],
            toc=[
                TocEntry(label='Chapter One', path=path, fragment='ch1'),
                TocEntry(label='Chapter Two', path=path, fragment='ch2'),
            ],
        )

        parts, _ = plan(source, SegmentOptions(min_chars=0))

        self.assertEqual(
            [(part.label, [segment.text for segment in part.segments]) for part in parts],
            [
                ('book (opening)', ['Introduction.']),
                ('Chapter One', ['Chapter One.', 'First body.']),
                ('Chapter Two', ['Chapter Two.', 'Second body.']),
            ],
        )


class ResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.part = Part(
            id='p0001',
            label='Chapter',
            spine_path='chapter.xhtml',
            spine_href='chapter.xhtml',
            fragment=None,
            segments=[Segment('mg-000000', 'Original text.', 'chapter.xhtml', 0)],
        )

    def key(self, part: Part | None = None, **context) -> str:
        return _cache_key(
            part or self.part,
            backend_name='test',
            sample_rate=24000,
            fmt='opus',
            bitrate='24k',
            gap=0.35,
            context=context,
        )

    def test_cache_requires_matching_text_settings_and_file_size(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            audio_path = out_dir / 'audio' / 'part.opus'
            audio_path.parent.mkdir()
            audio_path.write_bytes(b'complete')
            record = {
                'file': 'audio/part.opus',
                'bytes': len(b'complete'),
                'cacheKey': self.key(voice='a'),
            }

            self.assertTrue(_still_valid(record, out_dir, self.key(voice='a')))

            changed = Part(
                **{
                    **self.part.__dict__,
                    'segments': [Segment('mg-000000', 'Changed text.', 'chapter.xhtml', 0)],
                }
            )
            self.assertFalse(_still_valid(record, out_dir, self.key(changed, voice='a')))
            self.assertFalse(_still_valid(record, out_dir, self.key(voice='b')))

            audio_path.write_bytes(b'partial')
            self.assertFalse(_still_valid(record, out_dir, self.key(voice='a')))

    def test_legacy_record_without_cache_key_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            audio_path = out_dir / 'audio' / 'part.opus'
            audio_path.parent.mkdir()
            audio_path.write_bytes(b'audio')
            record = {'file': 'audio/part.opus', 'bytes': 5, 'segments': [{'id': 'mg-000000'}]}

            self.assertFalse(_still_valid(record, out_dir, self.key()))


if __name__ == '__main__':
    unittest.main()
