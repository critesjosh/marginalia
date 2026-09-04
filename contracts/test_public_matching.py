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

import types  # noqa: E402

from public_matching import (  # noqa: E402
    MATCH_ACCEPT,
    choose_match,
    explain_recommendation,
    frontier_score_v1,
    match_confidence,
    make_title_normalizer,
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
        self.assertEqual(normalize_author("Friedrich Nietzsche"), "nietzsche friedrich")

    def test_people_who_share_a_surname_and_initial_stay_distinct(self):
        book = {"title": "A Shared Title", "author": "John Smith"}
        candidate = {
            "key": "/works/wrong-author",
            "title": "A Shared Title",
            "author_name": ["Jane Smith"],
            "edition_count": 100,
        }
        self.assertLess(match_confidence(book, candidate), MATCH_ACCEPT)

    def test_catalogue_middle_names_do_not_break_a_match(self):
        book = {"title": "A Wizard of Earthsea", "author": "Ursula Le Guin"}
        candidate = {
            "key": "/works/OL59885W",
            "title": "A Wizard of Earthsea",
            "author_name": ["Ursula K. Le Guin"],
            "edition_count": 100,
        }
        self.assertGreaterEqual(match_confidence(book, candidate), MATCH_ACCEPT)

    def test_a_gutenberg_edition_note_is_not_part_of_the_title(self):
        """
        Project Gutenberg writes "Title / translator and edition note". Both
        of these are real titles for the same work, from a reader's library and
        from Open Library, and they have to normalize to the same string or the
        reader's own book is invisible to the matcher.
        """
        self.assertEqual(
            normalize_title(
                "Oedipus King of Thebes / Translated into English Rhyming Verse "
                "with Explanatory Notes",
                "Sophocles",
            ),
            normalize_title("Oedipus, King of Thebes"),
        )

    def test_an_academic_edition_puts_the_author_before_the_colon(self):
        """
        "Author: Title (Series)" inverts the usual order, so taking the half
        before the colon searches a catalogue for the author's name as though
        it were a book. This one really did come back unmatched.
        """
        self.assertEqual(
            normalize_title(
                "Nietzsche: The Gay Science (Cambridge Texts in the History of Philosophy)",
                "Friedrich Nietzsche",
            ),
            normalize_title("The Gay Science"),
        )

    def test_a_real_subtitle_is_still_dropped(self):
        """The author rule must not cost us the subtitle rule it sits beside."""
        self.assertEqual(
            normalize_title("Moby Dick: or, The Whale", "Herman Melville"), "moby dick"
        )

    def test_a_title_is_not_mistaken_for_its_author(self):
        """
        Only a fragment made entirely of the author's own name counts. Dropping
        a real half of a title is worse than keeping an author prefix.
        """
        self.assertEqual(
            normalize_title("Nietzsche and Philosophy", "Gilles Deleuze"),
            "nietzsche and philosophy",
        )
        self.assertEqual(
            normalize_title("Nietzsche: A Very Short Introduction", None),
            "nietzsche",
        )

    def test_spark_title_closure_matches_the_local_normalizer(self):
        normalize_for_spark = make_title_normalizer()
        titles = ["The Čapek Reader", "Émile: or On Education", "A Wizard of Earthsea"]
        self.assertEqual(
            [normalize_for_spark(title) for title in titles],
            [normalize_title(title) for title in titles],
        )


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
        self.assertEqual(
            metadata_completeness(
                {"title": "A work", "authors": ["An author"], "publication_year": 2026}
            ),
            1.0,
        )

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


class SparkSerialization(unittest.TestCase):
    """
    These closures are sent to a Spark worker, which has no copy of this module.
    Cloudpickle serializes a nested function by value but a module-level one by
    reference, so a helper defined beside the factory rather than inside it
    fails on the worker with ModuleNotFoundError, and only there.

    That has happened twice. This is what makes it fail here instead.
    """

    def test_the_title_normalizer_calls_nothing_it_cannot_carry(self):
        normalize = make_title_normalizer()
        referenced = set(normalize.__code__.co_names) | set(normalize.__code__.co_freevars)
        globals_ = normalize.__globals__
        module_functions = [
            name for name in referenced if isinstance(globals_.get(name), types.FunctionType)
        ]
        self.assertEqual(module_functions, [], "a worker cannot import these")
