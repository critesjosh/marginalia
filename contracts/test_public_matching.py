"""
Deterministic tests for public-work matching and the Phase 6 scores.

Uses recorded Open Library shapes, never the network, so a provider outage or a
catalogue edit can never make this suite fail.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "databricks" / "src"))

from public_matching import (  # noqa: E402
    MATCH_ACCEPT,
    choose_match,
    explain_recommendation,
    frontier_score_v1,
    match_confidence,
    metadata_completeness,
    normalize_author,
    normalize_title,
    recommendation_score_v1,
)

GENEALOGY = {
    "key": "/works/OL98169W",
    "title": "On the Genealogy of Morality: A Polemic",
    "author_name": ["Friedrich Nietzsche"],
    "edition_count": 32,
}
BIRTH_OF_TRAGEDY = {
    "key": "/works/OL98152W",
    "title": "The Birth of Tragedy",
    "author_name": ["Friedrich Nietzsche"],
    "edition_count": 61,
}


class Normalization(unittest.TestCase):
    def test_a_subtitle_does_not_make_a_different_work(self):
        self.assertEqual(
            normalize_title("On the Genealogy of Morality: A Polemic"),
            normalize_title("On the Genealogy of Morality"),
        )

    def test_diacritics_and_punctuation_fold_away(self):
        self.assertEqual(normalize_title("Zur Genealogie der Moral"), "zur genealogie der moral")
        self.assertEqual(normalize_title("Émile, or On Education"), "emile or on education")

    def test_a_leading_article_is_dropped(self):
        self.assertEqual(normalize_title("The Birth of Tragedy"), "birth of tragedy")

    def test_an_author_reads_the_same_in_either_order(self):
        self.assertEqual(
            normalize_author("Nietzsche, Friedrich"), normalize_author("Friedrich Nietzsche")
        )
        self.assertEqual(normalize_author("Friedrich Nietzsche"), "nietzsche f")


class Matching(unittest.TestCase):
    def test_attaches_a_clear_match(self):
        book = {"title": "On the Genealogy of Morality", "author": "Friedrich Nietzsche"}
        result = choose_match(book, [GENEALOGY, BIRTH_OF_TRAGEDY])
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["work_key"], "/works/OL98169W")
        self.assertGreaterEqual(result["confidence"], MATCH_ACCEPT)

    def test_a_shared_title_by_the_wrong_author_does_not_attach(self):
        book = {"title": "The Birth of Tragedy", "author": "Ada Lovelace"}
        result = choose_match(book, [BIRTH_OF_TRAGEDY])
        self.assertNotEqual(result["status"], "matched")
        self.assertIsNone(result["work_key"])

    def test_two_indistinguishable_candidates_stay_ambiguous(self):
        # The same work catalogued twice. Picking one is how a reader's
        # highlights end up cited against a book they never read.
        twin = {**GENEALOGY, "key": "/works/OL999999W"}
        book = {"title": "On the Genealogy of Morality", "author": "Friedrich Nietzsche"}
        result = choose_match(book, [GENEALOGY, twin])
        self.assertEqual(result["status"], "ambiguous")
        self.assertIsNone(result["work_key"])

    def test_nothing_close_enough_is_unmatched_not_ambiguous(self):
        book = {"title": "Introduction to Algorithms", "author": "Thomas Cormen"}
        result = choose_match(book, [GENEALOGY, BIRTH_OF_TRAGEDY])
        self.assertEqual(result["status"], "unmatched")

    def test_no_candidates_at_all(self):
        result = choose_match({"title": "Anything", "author": "Someone"}, [])
        self.assertEqual(result["status"], "unmatched")
        self.assertEqual(result["considered"], [])

    def test_a_missing_author_can_never_reach_the_accept_threshold(self):
        # Title alone is 0.65 plus at most 0.05 of popularity.
        book = {"title": "On the Genealogy of Morality", "author": ""}
        self.assertLess(match_confidence(book, GENEALOGY), MATCH_ACCEPT)

    def test_the_candidates_it_considered_are_always_recorded(self):
        book = {"title": "On the Genealogy of Morality", "author": "Friedrich Nietzsche"}
        result = choose_match(book, [GENEALOGY, BIRTH_OF_TRAGEDY])
        self.assertEqual([row["key"] for row in result["considered"]][0], "/works/OL98169W")

    def test_matching_is_reproducible_regardless_of_candidate_order(self):
        book = {"title": "On the Genealogy of Morality", "author": "Friedrich Nietzsche"}
        forward = choose_match(book, [GENEALOGY, BIRTH_OF_TRAGEDY])
        backward = choose_match(book, [BIRTH_OF_TRAGEDY, GENEALOGY])
        self.assertEqual(forward, backward)


class Scores(unittest.TestCase):
    def test_frontier_weights_sum_to_one_and_clamp(self):
        self.assertAlmostEqual(frontier_score_v1(1, 1, 1), 1.0)
        self.assertAlmostEqual(frontier_score_v1(0, 0, 0), 0.0)
        self.assertAlmostEqual(frontier_score_v1(2, -1, 0.5), 0.45 + 0.10)

    def test_recommendation_weights_sum_to_one(self):
        self.assertAlmostEqual(recommendation_score_v1(1, 1, 1, 1, 1), 1.0)
        self.assertAlmostEqual(recommendation_score_v1(1, 0, 0, 0, 0), 0.45)

    def test_metadata_completeness_counts_what_is_there(self):
        self.assertEqual(metadata_completeness({}), 0.0)
        self.assertEqual(metadata_completeness(GENEALOGY), 2 / 5)

    def test_an_explanation_needs_no_model_and_names_the_evidence(self):
        text = explain_recommendation(
            {"frontier_coverage": 0.6, "diversity": 0.7}, ["morality", "value judgment"]
        )
        self.assertIn("morality", text)
        self.assertTrue(text.endswith("."))
        # Deterministic: the same components always produce the same sentence.
        self.assertEqual(
            text,
            explain_recommendation(
                {"frontier_coverage": 0.6, "diversity": 0.7}, ["morality", "value judgment"]
            ),
        )


if __name__ == "__main__":
    unittest.main()
