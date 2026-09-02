"""
The serving loop crosses four runtimes: the browser, the Worker, the Databricks
App, and the pipelines. Nothing type-checks across that boundary, and every
disagreement inside it costs a deployment to discover.

These read the actual files rather than a copy of what they say, so a rename in
one runtime fails here instead of in a live acceptance run.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

INSIGHTS_TS = (ROOT / "src/sync/insights.ts").read_text()
INTELLIGENCE_TS = (ROOT / "workers/app/src/intelligence.ts").read_text()
APP_PY = (ROOT / "databricks/src/app/app.py").read_text()
DELETION_PY = (ROOT / "databricks/src/deletion.py").read_text()
SILVER_PY = (ROOT / "databricks/src/events_silver.py").read_text()
SERVING_YML = (ROOT / "databricks/resources/serving.yml").read_text()
GOLD_PY = (ROOT / "databricks/src/gold_profiles.py").read_text()


def ts_interface_fields(source: str, name: str) -> set[str]:
    body = re.search(rf"export interface {name}(?:<\w+>)? \{{(.*?)\n\}}", source, re.S)
    assert body, f"no interface {name}"
    return set(re.findall(r"^\s*(\w+)\??:", body.group(1), re.M))


def python_dict_keys(source: str, marker: str) -> set[str]:
    """The response keys one route builds, read from its dict literal."""
    start = source.index(marker)
    end = source.index('**({"sourceUpdatedAt"', start)
    # "rows" is the envelope the row objects sit in, not a field of one.
    return set(re.findall(r'"(\w+)":', source[start:end])) - {"rows"}


class DeletionVocabulary(unittest.TestCase):
    def test_the_app_returns_only_statuses_the_browser_declares(self):
        body = re.search(r"export interface DeletionRequest \{(.*?)\n\}", INSIGHTS_TS, re.S)
        assert body, "no DeletionRequest interface"
        union = re.search(r"status: ((?:'\w+'(?: \| )?)+)", body.group(1))
        assert union, "no DeletionRequest status union"
        browser = set(re.findall(r"'(\w+)'", union.group(1)))

        mapping = re.search(r"BROWSER_STATUS = \{(.*?)\n\}", APP_PY, re.S)
        assert mapping, "no BROWSER_STATUS map"
        served = set(re.findall(r':\s*"(\w+)"', mapping.group(1)))
        self.assertEqual(served, browser)

    def test_every_job_status_has_a_browser_meaning(self):
        """
        A status the job can write and the App cannot translate would reach a
        polling browser as a guess. purging_source is the one that matters: it
        is a real state and it has to read as still running.
        """
        mapping = re.search(r"BROWSER_STATUS = \{(.*?)\n\}", APP_PY, re.S)
        translated = set(re.findall(r'"(\w+)":', mapping.group(1)))
        written = set(re.findall(r'_set_status\(request_id, "(\w+)"', DELETION_PY))
        self.assertLessEqual(written, translated)
        self.assertIn("purging_source", translated)

    def test_suppression_covers_exactly_the_statuses_deletion_treats_as_active(self):
        """
        Silver suppresses a reader while their deletion is in flight. If the two
        lists disagree, either a replayed event repopulates a reader mid-deletion
        or a finished reader is suppressed forever.
        """
        active = re.search(r"ACTIVE_STATUSES = \((.*?)\)", DELETION_PY, re.S)
        suppressed = re.search(r"DELETING_STATUSES = \[(.*?)\]", SILVER_PY, re.S)
        assert active and suppressed
        self.assertEqual(
            set(re.findall(r'"(\w+)"', active.group(1))),
            set(re.findall(r'"(\w+)"', suppressed.group(1))),
        )


class ResponseShapes(unittest.TestCase):
    def test_interest_rows_carry_what_the_browser_reads(self):
        self.assertEqual(
            python_dict_keys(APP_PY, 'def interest_profile'),
            ts_interface_fields(INSIGHTS_TS, "InterestConcept"),
        )

    def test_engagement_rows_carry_what_the_browser_reads(self):
        self.assertEqual(
            python_dict_keys(APP_PY, 'def book_engagement'),
            ts_interface_fields(INSIGHTS_TS, "BookEngagement"),
        )

    def test_the_envelope_the_browser_expects_is_the_one_served(self):
        envelope = ts_interface_fields(INSIGHTS_TS, "InsightsEnvelope")
        self.assertEqual(envelope, {"rows", "sourceUpdatedAt"})
        for field in envelope:
            self.assertIn(f'"{field}"', APP_PY)


class Routes(unittest.TestCase):
    def test_every_worker_upstream_path_is_a_route_the_app_serves(self):
        upstream = set(re.findall(r"`\$\{base\}(/[a-z-]+(?:/[^`]*)?)`", INTELLIGENCE_TS))
        served = set(re.findall(r'@app\.(?:get|post)\("/api/v1/users/\{user_id\}([^"]*)"', APP_PY))
        # The Worker's paths carry interpolations where the App declares
        # parameters. Comparing the fixed prefix is what both actually agree on.
        self.assertEqual(
            {path.split("/$")[0].rstrip("/") for path in upstream},
            {path.split("/{")[0].rstrip("/") for path in served},
        )

    def test_the_browser_asks_for_the_routes_the_worker_exposes(self):
        for route in ("interest-profile", "book-engagement", "delete"):
            self.assertIn(f"'{route}'", INSIGHTS_TS + INTELLIGENCE_TS)


class ServingResources(unittest.TestCase):
    def test_synced_tables_use_the_documented_primary_keys(self):
        interest = SERVING_YML.index("reader_interest_profile:")
        engagement = SERVING_YML.index("book_engagement:")
        self.assertIn("- concept_id", SERVING_YML[interest:engagement])
        self.assertIn("- book_id", SERVING_YML[engagement:])
        self.assertEqual(SERVING_YML.count("scheduling_policy: TRIGGERED"), 2)

    def test_both_synced_sources_publish_change_data_feed(self):
        """A synced table over a source without CDF re-copies the whole table."""
        self.assertEqual(GOLD_PY.count('"delta.enableChangeDataFeed": "true"'), 2)

    def test_the_app_names_no_workspace_or_credential(self):
        for forbidden in ("https://", "dapi", "client_secret"):
            self.assertNotIn(forbidden, SERVING_YML)


if __name__ == "__main__":
    unittest.main()
