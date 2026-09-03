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
SYNC_PY = (ROOT / "databricks/src/serving_sync.py").read_text()
FRONTIER_PY = (ROOT / "databricks/src/frontier.py").read_text()
SOURCES_PY = (ROOT / "databricks/src/public_sources.py").read_text()
EXTRACTION_PY = (ROOT / "databricks/src/concept_extraction.py").read_text()
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
        """
        Shape as well as prefix. Collapsing an interpolated segment to its
        prefix would let the collection route and the by-id route look like one
        path, and either could then disappear unnoticed.
        """
        upstream = {
            re.sub(r"\$\{[^}]+\}", "*", path)
            for path in re.findall(r"`\$\{base\}(/[a-z-]+(?:/[^`]*)?)`", INTELLIGENCE_TS)
        }
        served = {
            re.sub(r"\{[^}]+\}", "*", path)
            for path in re.findall(
                r'@app\.(?:get|post)\("/api/v1/users/\{user_id\}([^"]*)"', APP_PY
            )
        }
        self.assertEqual(upstream, served)
        self.assertIn("/deletion-requests", upstream)
        self.assertIn("/deletion-requests/*", upstream)

    def test_the_methods_match_as_well_as_the_paths(self):
        """A GET route the Worker POSTs to is a 405, not a missing route."""
        self.assertIn('@app.post("/api/v1/users/{user_id}/deletion-requests"', APP_PY)
        self.assertIn("`${base}/deletion-requests`,\n      'POST'", INTELLIGENCE_TS)

    def test_the_browser_asks_for_the_routes_the_worker_exposes(self):
        for route in ("interest-profile", "book-engagement", "delete"):
            self.assertIn(f"'{route}'", INSIGHTS_TS + INTELLIGENCE_TS)


class DeletionManifest(unittest.TestCase):
    def test_every_silver_table_holding_a_reader_is_in_the_manifest(self):
        """
        The manifest is the whole promise. A table that names a reader and is
        not listed is a table a completed deletion left them in, and the
        extraction staging table is exactly the kind that gets forgotten:
        overwritten each run, and therefore easy to think of as temporary.
        """
        listed = set(re.findall(r'\{SILVER\}\.(\w+)"', DELETION_PY))
        written = set(re.findall(r'= f"\{CATALOG\}\.\{SILVER\}\.(\w+)"', EXTRACTION_PY))
        self.assertLessEqual(written, listed)
        self.assertIn("_concept_extraction_staging", listed)

    def test_verification_reaches_the_copy_the_browser_reads(self):
        """Absence from Delta is not absence from the serving tables."""
        self.assertIn("SERVED", DELETION_PY)
        self.assertIn("+ served", DELETION_PY)
        self.assertIn("--synced_tables=", (ROOT / "databricks/resources/deletion.yml").read_text())

    def test_spark_timestamps_are_made_comparable_before_being_compared(self):
        """
        Spark returns timestamps without a timezone, and Python refuses to
        compare a naive datetime with an aware one. The retention check is the
        one place a raw Spark timestamp meets datetime.now(timezone.utc).
        """
        self.assertIn("def _utc(", DELETION_PY)
        self.assertIn("retention_until = _utc(", DELETION_PY)
        self.assertNotIn('request["source_retention_until"] <=', DELETION_PY)

    def test_a_failed_request_keeps_suppressing_and_gets_retried(self):
        """
        A half-finished purge that stopped suppressing would let the topic
        replay the reader into the tables it had just emptied.
        """
        active = re.search(r"ACTIVE_STATUSES = \((.*?)\)", DELETION_PY, re.S)
        self.assertIn("failed", active.group(1))

    def test_the_two_definitions_of_the_request_table_agree(self):
        """
        The job owns this table and the App creates it, because the first
        request is written before any run has happened. Two definitions of one
        table drift unless something compares them.
        """
        def columns(source: str) -> list[str]:
            body = re.search(
                r"CREATE TABLE IF NOT EXISTS \{?\w*\}?[^(]*\((.*?)\) USING DELTA", source, re.S
            )
            assert body
            return re.findall(r"^\s*(\w+) ", body.group(1), re.M)

        self.assertEqual(columns(APP_PY), columns(DELETION_PY))

    def test_the_app_starts_the_job_rather_than_only_recording_it(self):
        self.assertIn("workspace.jobs.run_now", APP_PY)
        self.assertIn("MARGINALIA_DELETION_JOB_ID", SERVING_YML)
        self.assertIn("permission: CAN_MANAGE_RUN", SERVING_YML)


class PipelineRestrictions(unittest.TestCase):
    """
    Pipeline code and job code look identical and are not. A declarative
    pipeline runs under py4j security that does not whitelist Catalog methods,
    so spark.catalog there fails at analysis time with a
    Py4JSecurityException the source gives no hint of.
    """

    PIPELINES = ("events_ingestion.py", "events_silver.py", "gold_profiles.py", "frontier.py")

    def test_no_pipeline_calls_spark_catalog(self):
        for name in self.PIPELINES:
            source = (ROOT / "databricks/src" / name).read_text()
            code = [
                line for line in source.splitlines() if not line.lstrip().startswith("#")
            ]
            offenders = [line.strip() for line in code if "spark.catalog." in line]
            self.assertEqual(offenders, [], f"{name} calls spark.catalog")

    def test_suppression_tolerates_only_a_missing_table(self):
        """
        A broad except here would turn any read failure into "suppress nobody",
        which repopulates a reader who asked to be deleted.
        """
        body = re.search(
            r"def _without_deleted_readers.*?return frame\.join", SILVER_PY, re.S
        )
        assert body
        self.assertIn("except AnalysisException", body.group(0))
        self.assertIn("TABLE_OR_VIEW_NOT_FOUND", body.group(0))
        self.assertIn("raise", body.group(0))
        self.assertNotIn("except Exception", body.group(0))


class RuntimeDependencies(unittest.TestCase):
    """
    The serverless runtime ships its own databricks-sdk, and it is old enough
    that WorkspaceClient has no .database at all. A task that uses the Lakebase
    API and declares no dependency fails at runtime with an AttributeError,
    which nothing about the source suggests.
    """

    SDK_PIN = "databricks-sdk==0.133.0"

    def test_the_task_using_the_lakebase_api_pins_an_sdk_that_has_it(self):
        self.assertIn("workspace.database", SYNC_PY)
        for name in ("events_ingestion.yml", "deletion.yml"):
            resource = (ROOT / "databricks/resources" / name).read_text()
            self.assertIn("serving_sync.py", resource)
            self.assertIn("environment_key: serving", resource)
            self.assertIn(self.SDK_PIN, resource)

    def test_the_app_pins_the_same_sdk_as_the_jobs(self):
        """
        A database resource sets PGPASSWORD, so the App's credential path can
        go unexercised for a long time and then fail on the day it is needed.
        """
        requirements = (ROOT / "databricks/src/app/requirements.txt").read_text()
        self.assertIn(self.SDK_PIN, requirements)


class TheTwoPublicSources(unittest.TestCase):
    """
    OpenAlex and Open Library answer different questions, and using one for
    both produced recommendations that were research papers: a single-cell
    genomics article scored against an interest in "artist", and a scholar in
    the author field of Thus Spoke Zarathustra.
    """

    def _function(self, name: str) -> str:
        body = FRONTIER_PY[FRONTIER_PY.index(f"def {name}") :]
        end = body.find("\n@dp.")
        return body if end == -1 else body[:end]

    def test_the_frontier_is_built_from_research_works(self):
        """Adjacency between subjects is what OpenAlex actually knows."""
        frontier = self._function("intellectual_frontier")
        self.assertIn("current_research_works()", frontier)
        self.assertIn("cited_by_count", frontier)

    def test_recommendations_are_built_from_books(self):
        recommendations = self._function("recommendation_candidates")
        self.assertIn("BOOK_CANDIDATES", recommendations)
        self.assertNotIn("current_research_works()", recommendations)
        self.assertNotIn("cited_by_count", recommendations)

    def test_the_popularity_prior_counts_editions_not_citations(self):
        """
        A work reprinted many times is one many readers wanted. A paper cited
        many times is one many researchers used, which is a different claim.
        """
        recommendations = self._function("recommendation_candidates")
        self.assertIn("edition_count", recommendations)

    def test_book_candidates_are_fetched_from_open_library(self):
        self.assertIn("openlibrary.org/search.json", SOURCES_PY)
        self.assertIn("public_book_candidates", SOURCES_PY)

    def test_every_source_it_fetches_from_has_a_recorded_licence(self):
        """
        A provider response is stored with the licence it arrived under, so a
        source added without one fails the run at the first request. Adding
        openlibrary_subject and forgetting this is exactly what happened.
        """
        licensed = set(re.findall(r'^    "(\w+)": "', SOURCES_PY, re.M))
        fetched = set(re.findall(r'fetch\("(\w+)"', SOURCES_PY))
        self.assertTrue(fetched)
        self.assertTrue(fetched <= licensed, f"unlicensed sources: {fetched - licensed}")

    def test_the_run_summary_does_not_overstate_what_matched(self):
        """
        It counted every book it examined, including the ones that matched
        nothing, and called them matched.
        """
        self.assertIn("books_examined", SOURCES_PY)
        self.assertNotIn("books_matched", SOURCES_PY)


class SyncedTableStates(unittest.TestCase):
    def test_states_use_the_names_the_api_actually_returns(self):
        """
        The SDK enum is prefixed. Unprefixed names match nothing, so a settled
        sync would time out and a failed one would go unnoticed until it did.
        """
        for name in re.findall(r'"(SYNCED[A-Z_]*)"', SYNC_PY):
            self.assertTrue(name.startswith("SYNCED_TABLE"), name)
        self.assertIn('"SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE"', SYNC_PY)
        # Plain ONLINE is a servable copy, including a stale one.
        self.assertNotIn('SETTLED = {"SYNCED_TABLE_ONLINE"}', SYNC_PY)

    def test_the_enum_value_is_read_rather_than_the_enum_stringified(self):
        self.assertIn('getattr(detailed, "value", detailed)', SYNC_PY)


class ServingResources(unittest.TestCase):
    def test_synced_tables_use_the_documented_primary_keys(self):
        interest = SERVING_YML.index("reader_interest_profile:")
        engagement = SERVING_YML.index("book_engagement:")
        self.assertIn("- concept_id", SERVING_YML[interest:engagement])
        self.assertIn("- book_id", SERVING_YML[engagement:])

    def test_the_sync_policy_matches_what_a_materialized_view_can_offer(self):
        """
        A materialized view accepts delta.enableChangeDataFeed and does not
        honour it, and a TRIGGERED or CONTINUOUS sync reads that feed. The live
        failure was SYNCED_TABLE_USER_ERROR.SOURCE_READ_ERROR, not a fallback,
        so the Gold sources must not claim a feed and the policy must be one
        that does not need it.
        """
        self.assertNotIn('"delta.enableChangeDataFeed"', GOLD_PY)
        self.assertEqual(SERVING_YML.count("scheduling_policy: SNAPSHOT"), 2)
        for unavailable in ("TRIGGERED", "CONTINUOUS"):
            self.assertNotIn(f"scheduling_policy: {unavailable}", SERVING_YML)

    def test_the_instance_retention_window_is_one_the_api_accepts(self):
        """Valid values are 2 to 35 days; bundle validation does not enforce it."""
        window = re.search(r"retention_window_in_days: (\d+)", SERVING_YML)
        self.assertTrue(window)
        self.assertGreaterEqual(int(window.group(1)), 2)
        self.assertLessEqual(int(window.group(1)), 35)

    def test_the_app_names_no_workspace_or_credential(self):
        for forbidden in ("https://", "dapi", "client_secret"):
            self.assertNotIn(forbidden, SERVING_YML)


if __name__ == "__main__":
    unittest.main()
