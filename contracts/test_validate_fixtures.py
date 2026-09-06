from __future__ import annotations

import json
import unittest
from pathlib import Path

from contracts.validate_fixtures import valid_event
from contracts.fixtures.generate_reading_fixtures import build as build_reading_fixtures
from contracts.fixtures.generate_bronze_phase2_fixture import build as build_bronze_fixtures

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "nietzsche-phase-0.jsonl"
READING_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "reading-sessions-phase-2.jsonl"
HIGHLIGHT_FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "highlight-lifecycle-phase-2.jsonl"
)
BRONZE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "bronze-phase2.jsonl"
LIBRARY_FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "library-lifecycle-phase-5.jsonl"
)
COVERAGE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "coverage-phase-5.jsonl"


class EventContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.events = [json.loads(line) for line in FIXTURE.read_text().splitlines() if line]

    def test_accepts_realistic_nietzsche_stream(self) -> None:
        self.assertEqual([valid_event(event) for event in self.events], [True] * 4)

    def test_rejects_unknown_envelope_and_payload_fields(self) -> None:
        unknown_envelope = {**self.events[0], "userId": "browser-must-not-send-this"}
        unknown_payload = json.loads(json.dumps(self.events[3]))
        unknown_payload["payload"]["surroundingContext"] = "not consented"
        self.assertEqual(
            [valid_event(unknown_envelope), valid_event(unknown_payload)],
            [False, False],
        )

    def test_rejects_unknown_schema_version(self) -> None:
        event = {**self.events[0], "schemaVersion": 2}
        self.assertFalse(valid_event(event))

    def test_requires_event_specific_entities_and_privacy_categories(self) -> None:
        missing_entity = json.loads(json.dumps(self.events[3]))
        del missing_entity["entities"]["messageId"]
        wrong_privacy = json.loads(json.dumps(self.events[0]))
        wrong_privacy["privacy"]["included"] = ["conversationText"]
        self.assertEqual(
            [valid_event(missing_entity), valid_event(wrong_privacy)],
            [False, False],
        )

    def test_keeps_consent_snapshots_and_optional_text_fields_in_lockstep(self) -> None:
        undisclosed_text = json.loads(json.dumps(self.events[0]))
        undisclosed_text["privacy"]["included"] = ["highlightNotes"]
        missing_consented_text = json.loads(json.dumps(self.events[3]))
        del missing_consented_text["payload"]["content"]
        self.assertEqual(
            [valid_event(undisclosed_text), valid_event(missing_consented_text)],
            [False, False],
        )


class CoverageFixtureTest(unittest.TestCase):
    """The event types no other fixture happened to exercise."""

    def setUp(self) -> None:
        self.events = [
            json.loads(line) for line in COVERAGE_FIXTURE.read_text().splitlines() if line
        ]

    def test_every_coverage_fixture_satisfies_the_contract(self) -> None:
        invalid = [e["eventId"] for e in self.events if not valid_event(e)]
        self.assertEqual(invalid, [])

    def test_assistant_content_requires_its_own_consent(self) -> None:
        shared = next(
            e
            for e in self.events
            if e["eventType"] == "assistant_response_received" and e["privacy"]["included"]
        )
        withheld = next(
            e
            for e in self.events
            if e["eventType"] == "assistant_response_received"
            and not e["privacy"]["included"]
        )
        self.assertIn("content", shared["payload"])
        self.assertNotIn("content", withheld["payload"])
        # Latency and outcome are usage and survive either way.
        self.assertIn("latencyMs", withheld["payload"])


class LibraryFixtureTest(unittest.TestCase):
    """Every Phase 5 lifecycle event, checked against the same contract the
    browser and the Worker use."""

    def setUp(self) -> None:
        self.events = [
            json.loads(line) for line in LIBRARY_FIXTURE.read_text().splitlines() if line
        ]

    def test_every_library_fixture_satisfies_the_contract(self) -> None:
        invalid = [e["eventId"] for e in self.events if not valid_event(e)]
        self.assertEqual(invalid, [])

    def test_covers_every_new_event_type(self) -> None:
        self.assertEqual(
            sorted({e["eventType"] for e in self.events}),
            [
                "book_added",
                "book_archived",
                "book_deleted",
                "book_memory_updated",
                "book_restored",
                "conversation_deleted",
            ],
        )

    def test_only_the_two_text_carrying_events_may_include_a_category(self) -> None:
        # Archiving, restoring, removing, and deleting a conversation are usage.
        # Nothing about them can carry a title or a word the reader wrote.
        for event in self.events:
            included = event["privacy"]["included"]
            if event["eventType"] not in {"book_added", "book_memory_updated"}:
                self.assertEqual(included, [], event["eventType"])

    def test_a_title_requires_metadata_consent(self) -> None:
        # The same event type with and without consent: one carries the title,
        # the other records only that a book arrived.
        with_title = next(
            e for e in self.events if e["eventType"] == "book_added" and e["privacy"]["included"]
        )
        without = next(
            e
            for e in self.events
            if e["eventType"] == "book_added" and not e["privacy"]["included"]
        )
        self.assertIn("title", with_title["payload"])
        self.assertNotIn("title", without["payload"])
        self.assertEqual(with_title["privacy"]["included"], ["bookMetadata"])

    def test_a_summary_requires_memory_consent(self) -> None:
        with_summary = next(
            e
            for e in self.events
            if e["eventType"] == "book_memory_updated" and e["privacy"]["included"]
        )
        without = next(
            e
            for e in self.events
            if e["eventType"] == "book_memory_updated" and not e["privacy"]["included"]
        )
        self.assertIn("summary", with_summary["payload"])
        self.assertNotIn("summary", without["payload"])


class ReadingFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.events = [
            json.loads(line) for line in READING_FIXTURE.read_text().splitlines() if line
        ]

    def test_every_reading_fixture_satisfies_the_contract(self) -> None:
        invalid = [e["eventId"] for e in self.events if not valid_event(e)]
        self.assertEqual(invalid, [])

    def test_checked_in_fixture_matches_the_generator(self) -> None:
        self.assertEqual(self.events, build_reading_fixtures())

    def test_reading_events_never_carry_consented_text(self) -> None:
        # The whole family is metadata only, so an included category or a text
        # field on any of them is a contract break, not a consent question.
        self.assertEqual({len(e["privacy"]["included"]) for e in self.events}, {0})
        text_fields = {"text", "note", "content", "seedText", "title"}
        self.assertEqual(
            [e["eventId"] for e in self.events if text_fields & e["payload"].keys()], []
        )

    def test_carries_a_delivery_duplicate_and_a_divergent_duplicate(self) -> None:
        # Phase 2 deduplication is specified against these two cases: identical
        # repeats collapse, divergent ones land in event_conflicts.
        by_id: dict[str, list[dict]] = {}
        for event in self.events:
            by_id.setdefault(event["eventId"], []).append(event)
        repeated = {k: v for k, v in by_id.items() if len(v) > 1}
        self.assertEqual(len(repeated), 2)
        identical = [k for k, v in repeated.items() if v[0] == v[1]]
        divergent = [k for k, v in repeated.items() if v[0] != v[1]]
        self.assertEqual(len(identical), 1)
        self.assertEqual(len(divergent), 1)

    def test_rejects_a_reading_event_that_declares_consented_text(self) -> None:
        broken = json.loads(json.dumps(self.events[0]))
        broken["privacy"]["included"] = ["bookMetadata"]
        self.assertFalse(valid_event(broken))


class HighlightLifecycleFixtureTest(unittest.TestCase):
    def test_every_highlight_lifecycle_event_satisfies_the_contract(self) -> None:
        events = [
            json.loads(line) for line in HIGHLIGHT_FIXTURE.read_text().splitlines() if line
        ]
        self.assertEqual([event["eventId"] for event in events if not valid_event(event)], [])
        self.assertEqual(
            [event["eventType"] for event in events],
            ["highlight_deleted", "highlight_created"],
        )


class BronzePhaseTwoFixtureTest(unittest.TestCase):
    def test_contains_valid_events_duplicates_conflicts_and_quarantine_cases(self) -> None:
        records = build_bronze_fixtures()
        self.assertEqual(records, BRONZE_FIXTURE.read_text().splitlines())
        parsed = [json.loads(record) for record in records[:-1]]
        self.assertEqual(len(records), 29)
        self.assertEqual(records[-1], "not-json")
        self.assertEqual(sum(event["schemaVersion"] == 99 for event in parsed), 1)
        self.assertEqual(sum("unexpectedPrivateField" in event for event in parsed), 1)
        self.assertTrue(all("userId" in event and "receivedAt" in event for event in parsed))


if __name__ == "__main__":
    unittest.main()
