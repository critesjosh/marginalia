from __future__ import annotations

import json
import unittest
from pathlib import Path

from narrate.timeline import (
    TimelineError,
    anchor_chapters,
    build_sync,
    load_part_records,
    order_parts,
    read_concat_manifest,
)

FIXTURES = Path(__file__).parent / 'fixtures'


def _fixture_parts():
    records = load_part_records(FIXTURES / 'parts.jsonl')
    manifest = read_concat_manifest(FIXTURES / 'audiobook.concat.txt')
    return order_parts(records, manifest)


def _fixture_metadata() -> dict:
    return json.loads((FIXTURES / 'metadata.json').read_text(encoding='utf-8'))


def _build(parts=None, metadata=None, **kwargs) -> dict:
    metadata = metadata or _fixture_metadata()
    return build_sync(
        parts if parts is not None else _fixture_parts(),
        audio_id=metadata['audiobook']['audioId'],
        duration=metadata['audiobook']['durationSeconds'],
        chapters=metadata['chapters'],
        log=lambda *_: None,
        **kwargs,
    )


class PartOrderingTests(unittest.TestCase):
    def test_resume_log_keeps_the_last_record_for_a_part(self) -> None:
        records = load_part_records(FIXTURES / 'parts.jsonl')
        # p0003 appears twice: an abandoned 99 second render, then the real one.
        self.assertEqual(records['p0003']['duration'], 15.0)
        self.assertEqual(len(records), 5)

    def test_manifest_order_beats_the_order_lines_were_appended(self) -> None:
        parts = _fixture_parts()
        # The log has p0005 before p0004, because a resume run re-rendered p0004.
        self.assertEqual([part.id for part in parts], ['p0001', 'p0002', 'p0003', 'p0004', 'p0005'])

    def test_parts_fall_back_to_id_order_without_a_manifest(self) -> None:
        parts = order_parts(load_part_records(FIXTURES / 'parts.jsonl'), [])
        self.assertEqual([part.id for part in parts], ['p0001', 'p0002', 'p0003', 'p0004', 'p0005'])

    def test_manifest_unquotes_an_escaped_quote(self) -> None:
        path = FIXTURES / 'quoted.concat.txt'
        path.write_text("file 'audio/o'\\''clock.opus'\n", encoding='utf-8')
        try:
            self.assertEqual(read_concat_manifest(path), ["audio/o'clock.opus"])
        finally:
            path.unlink()

    def test_a_manifest_entry_with_no_timings_is_refused(self) -> None:
        records = load_part_records(FIXTURES / 'parts.jsonl')
        with self.assertRaisesRegex(TimelineError, 'no part record describes'):
            order_parts(records, ['audio/p0009-missing.opus'])

    def test_a_part_rendered_before_timings_existed_is_refused(self) -> None:
        records = load_part_records(FIXTURES / 'parts.jsonl')
        del records['p0002']['segments']
        with self.assertRaisesRegex(TimelineError, 'no segment timings'):
            order_parts(records, [])


class AnchoringTests(unittest.TestCase):
    def test_chapter_starts_land_exactly_on_the_published_boundaries(self) -> None:
        payload = _build()
        starts = [start for document in payload['documents'] for start in document['starts']]
        for chapter in _fixture_metadata()['chapters']:
            self.assertIn(chapter['startSeconds'], starts)

    def test_a_chapter_measured_longer_than_its_parts_is_stretched_not_shifted(self) -> None:
        payload = _build()
        second = payload['documents'][1]
        # The published second chapter runs 20.02s where its parts sum to 20.00s.
        # Spans inside it stretch to fit; the chapter after it still starts on time.
        self.assertEqual(second['starts'][0], 30.0)
        self.assertAlmostEqual(second['starts'][1], 38.508, places=3)
        self.assertAlmostEqual(second['starts'][2], 45.015, places=3)
        self.assertEqual(second['starts'][3], 50.02)

    def test_a_sentence_never_starts_later_than_it_really_does(self) -> None:
        """The published catalog is finer than milliseconds; truncation must not
        push a chapter's opening sentence past the boundary it opens."""
        metadata = _fixture_metadata()
        metadata['chapters'][0]['endSeconds'] = 30.0004
        metadata['chapters'][1]['startSeconds'] = 30.0004
        payload = _build(metadata=metadata)

        opening = payload['documents'][1]['starts'][0]
        self.assertEqual(opening, 30.0)
        self.assertLessEqual(opening, 30.0004)

    def test_every_span_is_ordered_and_inside_the_recording(self) -> None:
        payload = _build()
        starts = [start for document in payload['documents'] for start in document['starts']]
        self.assertEqual(starts, sorted(starts))
        self.assertLessEqual(starts[-1], payload['durationSeconds'])
        self.assertEqual(len(starts), 11)

    def test_documents_stay_in_reading_order_and_carry_their_spine_href(self) -> None:
        payload = _build()
        self.assertEqual(
            [document['href'] for document in payload['documents']],
            ['text/part0001.xhtml', 'text/part0002.xhtml'],
        )

    def test_a_chapter_boundary_that_matches_no_part_boundary_is_refused(self) -> None:
        metadata = _fixture_metadata()
        metadata['chapters'][1]['startSeconds'] = 33.0
        with self.assertRaisesRegex(TimelineError, 'not from the audio'):
            _build(metadata=metadata)

    def test_parts_that_do_not_add_up_to_the_recording_are_refused(self) -> None:
        metadata = _fixture_metadata()
        metadata['chapters'][-1]['endSeconds'] = 92.0
        metadata['audiobook']['durationSeconds'] = 92.0
        with self.assertRaisesRegex(TimelineError, 'the published recording ends at'):
            _build(metadata=metadata)

    def test_two_chapters_cannot_share_one_part_boundary(self) -> None:
        boundaries = [0.0, 10.0, 30.0]
        chapters = [
            {'id': 'a', 'startSeconds': 0.0, 'endSeconds': 0.1},
            {'id': 'b', 'startSeconds': 0.1, 'endSeconds': 30.0},
        ]
        with self.assertRaisesRegex(TimelineError, 'same part boundary'):
            anchor_chapters(boundaries, chapters)

    def test_unanchored_timings_are_a_plain_running_total(self) -> None:
        metadata = _fixture_metadata()
        payload = build_sync(
            _fixture_parts(),
            audio_id=metadata['audiobook']['audioId'],
            duration=metadata['audiobook']['durationSeconds'],
            chapters=None,
            log=lambda *_: None,
        )
        self.assertEqual(payload['documents'][1]['starts'], [30.0, 38.5, 45.0, 50.0, 61.75, 72.0])


class PublishedFixtureTests(unittest.TestCase):
    def test_the_committed_sync_map_is_what_this_tool_produces(self) -> None:
        """The reader's tests parse this file, so it has to stay the real output."""
        committed = json.loads((FIXTURES / 'sync.json').read_text(encoding='utf-8'))
        self.assertEqual(_build(), committed)


if __name__ == '__main__':
    unittest.main()
