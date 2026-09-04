"""
Phase 9's contract: the outcomes a learned ranker would be trained on, and the
gate that says there are not yet enough of them.

The gate is the point of this phase. Five event types are easy to add; what is
hard is not training on them the moment they exist, and the plan blocks that
behind six counts that a fortnight of enthusiastic clicking cannot meet.

Nothing here is book text. A candidate id is an Open Library work key, which is
public, so these events need `syncEnabled` and no content consent at all; the
tests below hold that, because a content category creeping into one of these
payloads would be a category nobody consented to for this purpose.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "databricks/src"))

MANIFEST = json.loads((ROOT / "contracts/events/v1/payloads.json").read_text())["payloads"]
ENVELOPE = json.loads((ROOT / "contracts/events/v1/envelope.schema.json").read_text())
GATE_PY = (ROOT / "databricks/src/readiness_gate.py").read_text()
SILVER_PY = (ROOT / "databricks/src/events_silver.py").read_text()
DELETION_PY = (ROOT / "databricks/src/deletion.py").read_text()
SERVING_YML = (ROOT / "databricks/resources/serving.yml").read_text()
INGESTION_YML = (ROOT / "databricks/resources/events_ingestion.yml").read_text()
EMITTERS_TS = (ROOT / "src/sync/recommendations.ts").read_text()
APP_PY = (ROOT / "databricks/src/app/app.py").read_text()

OUTCOME_EVENTS = (
    "recommendation_shown",
    "recommendation_opened",
    "recommendation_dismissed",
    "recommended_book_added",
    "recommended_book_started",
)


def schema(event_type: str) -> dict:
    return json.loads((ROOT / "contracts/events/v1/payloads" / MANIFEST[event_type]).read_text())


class TheVocabularyIsComplete(unittest.TestCase):
    def test_every_outcome_the_plan_names_has_a_payload_contract(self):
        for event_type in OUTCOME_EVENTS:
            self.assertIn(event_type, MANIFEST, f"{event_type} has no payload schema")

    def test_every_outcome_is_an_event_the_envelope_accepts(self):
        for event_type in OUTCOME_EVENTS:
            self.assertIn(event_type, ENVELOPE["properties"]["eventType"]["enum"])

    def test_every_outcome_names_the_candidate_it_is_about(self):
        """
        Without the work key an outcome is a click on nothing. It is the join
        between what was recommended and what happened next.
        """
        for event_type in OUTCOME_EVENTS:
            body = schema(event_type)
            self.assertIn("candidateId", body["required"], event_type)

    def test_every_outcome_can_carry_the_scoring_that_produced_it(self):
        """
        A recommendation is only interpretable against the formula behind it.
        An outcome without a score version cannot be told apart from an outcome
        under a different formula, which is the difference between a dataset
        and a pile of clicks.
        """
        for event_type in OUTCOME_EVENTS:
            self.assertIn("scoreVersion", schema(event_type)["properties"], event_type)

    def test_an_impression_records_where_in_the_list_it_appeared(self):
        """
        An impression at rank 1 and one at rank 20 are not the same evidence.
        A ranker trained without this learns the list's own order as though it
        were the reader's preference.
        """
        self.assertIn("rank", schema("recommendation_shown")["properties"])

    def test_no_outcome_payload_can_carry_the_readers_words(self):
        """
        These need syncEnabled and no content consent, which is only true while
        nothing in them can be text the reader wrote.

        Checked against the shape of every field rather than against a list of
        suspicious names. A denylist of five names is a denylist somebody adds
        a sixth field around, and the property that matters is that no string
        here is free: each one is an identifier, a version, or an enum, and
        every one of those is constrained so a sentence cannot fit through it.
        """
        for event_type in OUTCOME_EVENTS:
            body = schema(event_type)
            self.assertFalse(body["additionalProperties"], event_type)
            for name, field in body["properties"].items():
                if field.get("type") != "string":
                    continue
                if "enum" in field or field.get("format") == "date-time":
                    continue
                self.assertIn(
                    "pattern", field, f"{event_type}.{name} is an unconstrained string"
                )
                self.assertNotIn(
                    " ", field["pattern"], f"{event_type}.{name} admits a space, so it admits prose"
                )
                # The honest limit: no whitespace means no sentence. It does not
                # mean the value is a well-formed work key, and the schema's own
                # comment says so rather than claiming more.
                self.assertIn("not a full validation", json.dumps(body["properties"]["candidateId"]))

    def test_the_emitters_ask_for_no_content_consent(self):
        """`included: []` on every one, because there is no content in them."""
        self.assertEqual(EMITTERS_TS.count("included: []"), len(OUTCOME_EVENTS))
        for category in ("shareHighlightText", "shareConversationText", "shareBookMetadata"):
            self.assertNotIn(category, EMITTERS_TS)


class TheOutcomeAndItsLocalRecordCommitTogether(unittest.TestCase):
    def test_the_event_and_the_local_note_share_a_transaction(self):
        """
        The local note is what stops a dismissed book returning when the cloud
        recomputes its list. Writing it without the event loses the outcome;
        writing the event without it shows the card again.
        """
        self.assertIn("db.transaction(", EMITTERS_TS)
        for table in ("db.eventOutbox", "db.recommendationFeedback", "db.syncState"):
            self.assertIn(table, EMITTERS_TS)

    def test_an_impression_is_not_treated_as_a_decision(self):
        """
        Seeing a book is not a decision about it. Hiding what has merely been
        shown would empty the list after one look.
        """
        settled = EMITTERS_TS[EMITTERS_TS.index("export async function settledCandidates") :]
        self.assertIn("'dismissed', 'added', 'started'", settled)
        self.assertNotIn("'shown'", settled.split("export async function alreadyShown")[0])


class TheOutcomesReachSilver(unittest.TestCase):
    def test_every_event_type_in_the_manifest_is_one_silver_knows(self):
        """
        Silver quarantines anything not in EVENT_TYPES as unknown_event_type, so
        an event added to the contracts and not to that list is collected by the
        browser, accepted by the Worker, and thrown away on arrival.

        All four Phase 9 outcomes did exactly that. The test that was supposed
        to catch it looked for their names anywhere in the file, and found them
        in a tuple that names them for a different purpose.
        """
        import ast

        tree = ast.parse(SILVER_PY)
        known = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "EVENT_TYPES" for t in node.targets
            ):
                known = {element.value for element in node.value.elts}
        self.assertIsNotNone(known, "EVENT_TYPES is not a plain list any more")
        missing = set(MANIFEST) - known
        self.assertEqual(missing, set(), f"Silver would quarantine {sorted(missing)}")

    def test_every_event_type_has_a_payload_key_list_and_a_timestamp(self):
        """
        Two more registries keyed by event type. A type missing from the first
        has every field rejected as unknown; missing from the second, it has no
        payload timestamp and is quarantined for that instead.
        """
        keys = SILVER_PY[SILVER_PY.index("def _payload_keys") :]
        keys = keys[: keys.index("__unknown_event_type__")]
        timestamps = SILVER_PY[SILVER_PY.index("payload_timestamp = (") :]
        timestamps = timestamps[: timestamps.index("missing_payload_timestamp")]
        for event_type in MANIFEST:
            if event_type == "privacy_consent_changed":
                # Carries no payload timestamp by design; the quarantine rule
                # names it as the one exception.
                continue
            with self.subTest(event_type=event_type):
                self.assertIn(f'"{event_type}"', keys, f"{event_type} has no permitted payload keys")
                self.assertIn(f'"{event_type}"', timestamps, f"{event_type} has no payload timestamp")

    def test_every_outcome_must_name_the_work_it_is_about(self):
        """An outcome with no candidate is a click on nothing."""
        for event_type in OUTCOME_EVENTS:
            self.assertIn(f'"{event_type}"', SILVER_PY[SILVER_PY.index("missing_recommendation_candidate") :][:600])

    def test_the_outcomes_are_kept_one_row_per_event(self):
        """
        An impression and a dismissal of the same work are two facts at two
        times. Folding them into one row per candidate loses the order they
        happened in, which is the whole of what a ranker would learn from.
        """
        self.assertIn("RECOMMENDATION_OUTCOMES", SILVER_PY)
        self.assertIn("one row per event", SILVER_PY.lower())

    def test_positives_are_defined_once(self):
        """
        The gate and any later ranker read the same definition rather than each
        deciding what counts as the reader wanting the book.
        """
        self.assertIn("POSITIVE_OUTCOMES = (", SILVER_PY)
        self.assertIn('"recommended_book_added"', SILVER_PY)
        self.assertIn('"recommended_book_started"', SILVER_PY)


class TheGate(unittest.TestCase):
    def test_it_transcribes_the_plans_six_thresholds(self):
        from readiness_gate import THRESHOLDS

        self.assertEqual(THRESHOLDS["impressions"], 500)
        self.assertEqual(THRESHOLDS["positive_outcomes"], 50)
        self.assertEqual(THRESHOLDS["explicit_negatives"], 50)
        self.assertEqual(THRESHOLDS["distinct_candidates"], 20)
        self.assertEqual(THRESHOLDS["weeks_of_outcomes"], 8)
        self.assertEqual(THRESHOLDS["holdout_fraction"], 0.20)

    def test_the_plan_and_the_code_agree_on_every_number(self):
        """
        The thresholds exist in two places: the plan, which is the contract,
        and the job, which enforces it. A number changed in one is a gate that
        no longer means what the document says it does.
        """
        from readiness_gate import THRESHOLDS

        plan = (ROOT / "docs/databricks-intelligence-plan.md").read_text()
        gate = plan[plan.index("The learned ranker is blocked") :]
        gate = gate[: gate.index("These are minimum engineering gates")]
        for number in (
            THRESHOLDS["impressions"],
            THRESHOLDS["positive_outcomes"],
            THRESHOLDS["distinct_candidates"],
            THRESHOLDS["weeks_of_outcomes"],
        ):
            self.assertIn(str(number), gate, f"{number} is in the gate and not in the plan")
        self.assertIn("20%", gate)

    def test_the_holdout_can_actually_fail(self):
        """
        The first version took the last fifth of the list, which is a fifth of
        any list: the sixth gate could never fail, and six thresholds were
        really five. The cut is a moment now, so activity bunched at the start
        of its own span has no holdout.
        """
        import datetime

        from readiness_gate import holdout_over

        start = datetime.datetime(2026, 1, 1)
        spread = [start + datetime.timedelta(days=day) for day in range(100)]
        self.assertGreaterEqual(holdout_over(spread)["holdout_share"], 0.2)

        front_loaded = [start + datetime.timedelta(hours=hour) for hour in range(90)] + [
            start + datetime.timedelta(days=60 + day) for day in range(10)
        ]
        self.assertLess(holdout_over(front_loaded)["holdout_share"], 0.2)

    def test_the_holdout_of_nothing_is_nothing(self):
        from readiness_gate import holdout_over

        self.assertEqual(holdout_over([])["holdout_share"], 0.0)

    def test_neither_gated_number_is_rounded_before_it_is_compared(self):
        """
        0.1999 rounded to three places is 0.200, and a gate that compared the
        rounded value decided it had been met because the number looked like
        the number it was measured against. The same applied to weeks.
        """
        gate = GATE_PY[GATE_PY.index("measured = {") : GATE_PY.index("unmet = [")]
        self.assertNotIn("round(", gate)

    def test_the_holdout_is_temporal_rather_than_random(self):
        """
        A random split puts a reader's later click in training and their
        earlier one in test, so the model is scored on a past it has already
        seen through the future and every metric comes out flattering.
        """
        self.assertIn("Temporal rather than random", GATE_PY)
        self.assertNotIn("randomSplit", GATE_PY)
        self.assertNotIn("rand()", GATE_PY)

    def test_it_says_what_it_does_not_establish(self):
        """
        Passing means the data is no longer the reason not to train. It is not
        a claim that a model trained on it would be good, and the plan says so
        in the same words.
        """
        self.assertIn("no longer the reason", GATE_PY)
        self.assertIn("claim that the resulting model would be good", GATE_PY)

    def test_it_runs_on_a_schedule_rather_than_on_request(self):
        """A gate consulted only by whoever wants to pass it is not a gate."""
        self.assertIn("readiness_gate.py", INGESTION_YML)
        self.assertIn("not a gate", INGESTION_YML)

    def test_an_unmet_gate_is_reported_rather_than_raised(self):
        """
        Unmet is the expected state for most of this system's life. A job
        failing every quarter of an hour trains its owner to ignore it.
        """
        # main() may refuse to run without its job parameters. What it must not
        # do is fail because the gate is unmet, which is the ordinary case.
        unmet_branch = GATE_PY[GATE_PY.index("for shortfall in assessment"):]
        self.assertNotIn("raise", unmet_branch)
        self.assertIn("stays blocked", unmet_branch)


class WhatDeletionMustReach(unittest.TestCase):
    def test_the_outcomes_are_removed_with_the_reader(self):
        self.assertIn("recommendation_outcomes", DELETION_PY)

    def test_the_readiness_records_are_removed_too(self):
        """
        Counts rather than reading, but a row can name the reader it counted,
        and a count of a deleted reader's behaviour is still a record of it.
        """
        self.assertIn("recommender_readiness", DELETION_PY)

    def test_the_manifest_version_moved_with_the_manifest(self):
        self.assertIn('MANIFEST_VERSION = "deletion_manifest_v5"', DELETION_PY)


class TheRecommendationsAreServed(unittest.TestCase):
    def test_they_are_synced_at_the_documented_grain(self):
        block = SERVING_YML[SERVING_YML.index("recommendation_candidates:") :]
        self.assertIn("- user_id", block)
        self.assertIn("- candidate_id", block)

    def test_they_sync_behind_the_pipeline_that_builds_them(self):
        """
        Folding them into sync_serving would make the interest profile wait on
        public-source enrichment, which is rate-limited HTTP, and the freshness
        objective is measured to the profile.
        """
        task = INGESTION_YML[INGESTION_YML.index("task_key: sync_recommendations") :]
        task = task[: task.index("environment_key")]
        self.assertIn("task_key: build_frontier", task)

    def test_the_app_serves_the_explanation_rather_than_generating_one(self):
        """
        What the reader is told is what the score was computed from. Prose
        written about a score is not the score.
        """
        route = APP_PY[APP_PY.index("def recommendations(") :]
        route = route[: route.index("@app.get")] if "@app.get" in route[10:] else route
        self.assertIn("explanation", route)
        self.assertIn("matched_concepts", route)
        self.assertIn("score_version", route)

    def test_the_browser_never_names_the_reader(self):
        """
        The same rule as every other intelligence route: the id comes from the
        Worker's own secret.
        """
        worker = (ROOT / "workers/app/src/intelligence.ts").read_text()
        self.assertIn("`${base}/recommendations`", worker)
        self.assertIn("never from the path the", worker)


if __name__ == "__main__":
    unittest.main()
