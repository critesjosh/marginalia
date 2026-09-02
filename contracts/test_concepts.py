"""
Deterministic concept-extraction tests. Fixed model responses only: no network
call, so a model outage can never make this suite flaky. The live evaluation
runs separately.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "databricks" / "src"))

from concepts import (  # noqa: E402
    CANONICALIZATION_VERSION,
    CONCEPT_ALIASES,
    MAX_EXTRACTION_ATTEMPTS,
    ResponseInvalid,
    canonicalize,
    engagement_score_v1,
    evidence_contribution,
    next_validation_status,
    parse_extraction_response,
    recency_decay,
)

FIXTURE = json.loads((ROOT / "contracts/fixtures/concept-extraction-phase-3.json").read_text())


class Canonicalization(unittest.TestCase):
    def test_lowercases_normalizes_and_singularizes(self):
        self.assertEqual(canonicalize("  Value  Judgments "), "value judgment")
        self.assertEqual(canonicalize("GENEALOGIES"), "genealogy")
        self.assertEqual(canonicalize("moral values."), "morality")

    def test_applies_aliases_after_singularizing(self):
        self.assertEqual(canonicalize("Genealogy of Morals"), "genealogy of morality")
        self.assertEqual(canonicalize("good vs evil"), "good and evil")

    def test_leaves_irregular_and_short_words_alone(self):
        self.assertEqual(canonicalize("ethics"), "ethics")
        self.assertEqual(canonicalize("analysis"), "analysis")
        self.assertEqual(canonicalize("good and evil"), "good and evil")

    def test_mass_nouns_are_not_singularized(self):
        for word in ("ethics", "politics", "physics", "aesthetics", "metaphysics"):
            self.assertEqual(canonicalize(word), word)

    def test_every_alias_value_is_its_own_fixed_point(self):
        # A value that canonicalized to something else would flip a label back
        # and forth depending on how it was written.
        for key, value in CONCEPT_ALIASES.items():
            with self.subTest(key):
                self.assertEqual(canonicalize(value), value)
                # And a key must be reachable: it has to read the way a label
                # looks after singularization, or the lookup never sees it.
                self.assertEqual(canonicalize(key), value)

    def test_empty_input_canonicalizes_to_nothing(self):
        self.assertEqual(canonicalize("   "), "")
        self.assertEqual(canonicalize(None), "")


class FixedResponse(unittest.TestCase):
    def test_matches_all_five_reference_concepts(self):
        parsed = parse_extraction_response(FIXTURE["fixed_response"])
        extracted = [item["canonical_concept"] for item in parsed]
        expected = [canonicalize(name) for name in FIXTURE["evaluation"]["reference_concepts"]]
        self.assertEqual(sorted(extracted), sorted(expected))

    def test_keeps_the_raw_label_and_records_the_version(self):
        parsed = parse_extraction_response(FIXTURE["fixed_response"])
        first = parsed[0]
        self.assertEqual(first["raw_concept"], "Morality")
        self.assertEqual(first["canonical_concept"], "morality")
        self.assertEqual(first["canonicalization_version"], CANONICALIZATION_VERSION)
        self.assertEqual(first["broader_concept"], "moral philosophy")

    def test_collapses_a_repeated_concept_rather_than_failing(self):
        raw = json.dumps(
            {
                "concepts": [
                    {"label": "Morality", "confidence": 0.9},
                    {"label": "morals", "confidence": 0.4},
                ]
            }
        )
        parsed = parse_extraction_response(raw)
        self.assertEqual([item["canonical_concept"] for item in parsed], ["morality"])
        self.assertEqual(parsed[0]["confidence"], 0.9)


class InvalidResponses(unittest.TestCase):
    def test_every_fixture_invalid_response_is_rejected_with_a_status(self):
        for case in FIXTURE["invalid_responses"]:
            with self.subTest(case["name"]):
                with self.assertRaises(ResponseInvalid) as caught:
                    parse_extraction_response(case["raw"])
                self.assertIn(
                    caught.exception.status,
                    {"invalid_json", "schema_invalid", "empty_response"},
                )

    def test_an_overlong_broader_concept_is_rejected(self):
        raw = json.dumps(
            {"concepts": [{"label": "morality", "confidence": 0.5, "broader": "x" * 81}]}
        )
        with self.assertRaises(ResponseInvalid) as caught:
            parse_extraction_response(raw)
        self.assertEqual(caught.exception.status, "schema_invalid")

    def test_third_failure_is_terminal(self):
        self.assertEqual(next_validation_status(1), "retry")
        self.assertEqual(next_validation_status(MAX_EXTRACTION_ATTEMPTS - 1), "retry")
        self.assertEqual(next_validation_status(MAX_EXTRACTION_ATTEMPTS), "permanent_failure")


class Scoring(unittest.TestCase):
    def test_recency_decay_halves_at_the_half_life(self):
        self.assertAlmostEqual(recency_decay(0), 1.0)
        self.assertAlmostEqual(recency_decay(90), 0.5)
        self.assertAlmostEqual(recency_decay(180), 0.25)
        # Evidence from the future is not worth more than evidence from now.
        self.assertAlmostEqual(recency_decay(-10), 1.0)

    def test_assistant_text_contributes_nothing(self):
        self.assertEqual(evidence_contribution("assistant_text", 1.0, 0), 0.0)
        self.assertEqual(evidence_contribution("unknown_source", 1.0, 0), 0.0)

    def test_evidence_weights_order_question_above_note_above_passage(self):
        question = evidence_contribution("user_question", 1.0, 0)
        note = evidence_contribution("highlight_note", 1.0, 0)
        passage = evidence_contribution("highlight_passage", 1.0, 0)
        self.assertGreater(question, note)
        self.assertGreater(note, passage)

    def test_engagement_score_bounds(self):
        self.assertAlmostEqual(engagement_score_v1(0, 0, 0.0, 0, 0, False), 0.0)
        self.assertAlmostEqual(engagement_score_v1(10_000, 500, 1.0, 99, 99, True), 1.0)

    def test_engagement_components_are_independent(self):
        base = engagement_score_v1(0, 0, 0.0, 0, 0, False)
        completed = engagement_score_v1(0, 0, 0.0, 0, 0, True)
        self.assertAlmostEqual(completed - base, 0.10)
        progressed = engagement_score_v1(0, 0, 1.0, 0, 0, False)
        self.assertAlmostEqual(progressed - base, 0.15)


if __name__ == "__main__":
    unittest.main()
