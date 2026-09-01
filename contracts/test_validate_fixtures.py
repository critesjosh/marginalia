from __future__ import annotations

import json
import unittest
from pathlib import Path

from contracts.validate_fixtures import valid_event

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "nietzsche-phase-0.jsonl"


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


if __name__ == "__main__":
    unittest.main()
