"""
Per-reader isolation, held against the thing that actually enforces it.

Phase 7 shipped the reader-facing surfaces reading Gold directly and recorded
that this was not isolation. The fix is a view per Gold table that filters by
the querying principal, plus grants that give a reader-facing identity those
views and nothing else. A view that forgot the filter would look exactly like
one that had it, everywhere except in the rows it returned, so the filter is
checked here rather than trusted.

What these cannot check is the grants, which live in a workspace and not in
this repository. They check everything that decides what a grant would expose.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "databricks/src"))
sys.path.insert(0, str(ROOT / "databricks/src/observatory"))

from queries import FORBIDDEN_TABLES, PERMITTED_TABLES  # noqa: E402
from reader_scope import (  # noqa: E402
    GOLD_VIEWS,
    PRINCIPALS_TABLE,
    SILVER_VIEWS,
    UNFILTERED_VIEWS,
    planned_views,
    principals_ddl,
    scoped_view_ddl,
)

OBSERVATORY_YML = (ROOT / "databricks/resources/observatory.yml").read_text()
INGESTION_YML = (ROOT / "databricks/resources/events_ingestion.yml").read_text()
CATALOG_YML = (ROOT / "databricks/resources/catalog.yml").read_text()
DELETION_PY = (ROOT / "databricks/src/deletion.py").read_text()
SCOPE_PY = (ROOT / "databricks/src/reader_scope.py").read_text()

PLAN = planned_views("cat", "scoped", "gold", "silver", "ops")
FILTERED = [(name, source, ddl) for name, source, ddl, filtered in PLAN if filtered]
UNFILTERED = [(name, source, ddl) for name, source, ddl, filtered in PLAN if not filtered]


def normalized(sql: str) -> str:
    return " ".join(sql.split())


class EveryViewFiltersByPrincipal(unittest.TestCase):
    """
    The whole boundary is one WHERE clause, so it is compared whole.

    Searching for substrings was the first version of this and it was worth
    little: `EXISTS (...) OR TRUE` contains every substring an earlier version
    looked for and returns every reader's rows to anybody.
    """

    EXPECTED_FILTER = normalized(
        """
        WHERE EXISTS (
          SELECT 1
          FROM cat.ops.reader_principals AS mapped
          WHERE mapped.user_id = source.user_id
            AND lower(mapped.principal) = lower(current_user())
        )
        """
    )

    def test_every_view_carries_exactly_the_expected_filter(self):
        for name, _source, ddl in FILTERED:
            _, _, clause = normalized(ddl).partition("WHERE ")
            self.assertEqual("WHERE " + clause, self.EXPECTED_FILTER, f"{name} filters differently")

    def test_the_filter_is_the_last_thing_in_the_statement(self):
        """
        A clause appended after it, a UNION most of all, would add rows the
        filter never saw while leaving the filter itself untouched.
        """
        for name, _source, ddl in FILTERED:
            self.assertTrue(normalized(ddl).endswith("lower(current_user()) )"), name)

    def test_the_expected_filter_is_not_trivially_satisfiable(self):
        """
        Guards the guard. If EXPECTED_FILTER were ever relaxed to something a
        permissive view also matches, every test above would keep passing.
        """
        for wrong in (
            "WHERE EXISTS (SELECT 1 FROM cat.ops.reader_principals AS mapped) OR TRUE",
            "WHERE TRUE",
            "WHERE EXISTS (SELECT 1 FROM cat.ops.reader_principals AS mapped "
            "WHERE lower(mapped.principal) = lower(current_user()))",
        ):
            self.assertNotEqual(normalized(wrong), self.EXPECTED_FILTER)

    def test_a_view_selects_from_its_own_table_only(self):
        for name, source, ddl in FILTERED:
            self.assertIn(f"FROM {source} AS source", ddl, name)
            # One FROM for the source and one for the mapping. A third is a join
            # this file has not reasoned about.
            self.assertEqual(normalized(ddl).count(" FROM "), 2, name)


class TheViewsCoverExactlyWhatIsPermitted(unittest.TestCase):
    def test_the_scoped_views_are_the_observatory_permitted_tables(self):
        """
        Two lists that must not drift. A view added here without adding it
        there is a table nothing reads; a table permitted there without a view
        here is a query that fails at runtime with a grant error, which reads
        as a deployment problem rather than as the missing view it is.
        """
        scoped = set(GOLD_VIEWS) | set(SILVER_VIEWS) | {view for view, _, _ in UNFILTERED_VIEWS}
        self.assertEqual(scoped, PERMITTED_TABLES)

    def test_no_view_is_made_over_a_table_holding_the_readers_words(self):
        """
        A scoped view is a grant waiting to happen. Making one over
        concept_extractions would hand a reader-facing surface the model's
        whole answer to a prompt built from their highlights, per-reader and
        therefore looking entirely correct.
        """
        made = set(GOLD_VIEWS) | set(SILVER_VIEWS) | {view for view, _, _ in UNFILTERED_VIEWS}
        self.assertEqual(made & FORBIDDEN_TABLES, set())


class TheMapping(unittest.TestCase):
    def test_the_mapping_is_created_before_it_is_read(self):
        ddl = principals_ddl("cat", "ops")
        self.assertIn("CREATE TABLE IF NOT EXISTS cat.ops.reader_principals", ddl)
        for column in ("principal", "user_id"):
            self.assertIn(f"{column} STRING NOT NULL", ddl)

        # And that main() actually creates it before making views that select
        # from it. A view over a missing table fails at read time, in a place
        # that does not say what is wrong.
        source = SCOPE_PY[SCOPE_PY.index("def main"):]
        self.assertLess(source.index("principals_ddl("), source.index("planned_views("))

    def test_one_principal_cannot_be_mapped_to_two_readers(self):
        """
        Two rows naming the same principal and different readers would union
        them, and the views would go on returning "one reader's own rows" while
        returning two readers'. Unity Catalog has no unique constraint to say
        this with, so the task says it.
        """
        source = SCOPE_PY[SCOPE_PY.index("def main"):]
        self.assertIn("count(DISTINCT user_id) > 1", source)
        self.assertIn("raise SystemExit", source)

    def test_deletion_removes_the_mapping_rows_for_a_deleted_reader(self):
        """
        Not the reader's words, but a record naming them, and one that would
        otherwise outlive every table it points at.
        """
        self.assertIn('f"{CATALOG}.{OPS}.reader_principals", "user_id"', DELETION_PY)

    def test_the_manifest_version_moved_when_the_manifest_did(self):
        """
        A completed request records which manifest ran. Leaving the version
        alone would make a v1 completion indistinguishable from a v2 one.
        """
        self.assertIn('MANIFEST_VERSION = "deletion_manifest_v5"', DELETION_PY)

    def test_deletion_does_not_verify_against_the_scoped_views(self):
        """
        They filter by current_user(), and the deletion job runs as a principal
        no mapping names, so a count against them is zero for every reader
        whether deleted or not: a check that cannot fail, reporting absence it
        never established.
        """
        self.assertNotIn("scoped_schema", DELETION_PY, "the deletion job takes the scoped schema as a parameter")
        manifests = DELETION_PY[DELETION_PY.index("DELETED_TABLES") : DELETION_PY.index("ACTIVE_STATUSES")]
        for view in set(GOLD_VIEWS) | set(SILVER_VIEWS) | {name for name, _, _ in UNFILTERED_VIEWS}:
            self.assertNotIn(f"{{SCOPED}}.{view}", manifests)
        self.assertNotIn("SCOPED", manifests)

    def test_every_store_phase_8_added_is_accounted_for(self):
        """
        The phase's list: MLflow traces, the evaluation table, the retrieval
        index, and Model Serving state. Each is either deleted or has a written
        reason it holds nothing to delete.
        """
        self.assertIn("librarian_passages", DELETION_PY)
        self.assertIn("marginalia.user_id tag", DELETION_PY)
        self.assertIn("librarian_evaluations", DELETION_PY)
        self.assertIn("serving endpoint holds no reader state", DELETION_PY)

    def test_the_index_is_asked_directly_whether_the_reader_is_gone(self):
        """
        A sync is a request. Verifying the table it syncs from answers where
        the delete happened, not where an answer would be built from, and the
        gap between the two is a sync whose timing this job does not control.
        """
        self.assertIn("def remaining_in_index", DELETION_PY)
        self.assertIn("/query", DELETION_PY)
        self.assertIn("remaining_in_index(user_id)", DELETION_PY)
        # An index it cannot reach is not an absent reader.
        self.assertIn("could not ask", DELETION_PY)

    def test_the_index_is_emptied_by_a_task_rather_than_assumed(self):
        """
        A Vector Search index has no delete of its own. It syncs from the
        passages table, so the sync is the deletion, and the job waits for it
        before verifying anything.
        """
        deletion_yml = (ROOT / "databricks/resources/deletion.yml").read_text()
        self.assertIn("rebuild_librarian_passages", deletion_yml)
        self.assertIn("--wait_for_sync=true", deletion_yml)

    def test_the_records_deletion_keeps_are_named_where_it_says_it_removes_everything(self):
        """
        deletion_requests and deletion_audit keep the reader's id on purpose, so
        the module's opening sentence has to carve them out rather than claim
        every layer.
        """
        opening = DELETION_PY[: DELETION_PY.index("import json")]
        self.assertIn("except the record of the deletion itself", opening)
        self.assertIn("deletion_audit", opening)


class TheSurfacesReadTheViews(unittest.TestCase):
    def test_the_scoped_schema_is_a_deployed_resource(self):
        self.assertIn("${var.scoped_schema}", CATALOG_YML)

    def test_the_dashboard_datasets_resolve_to_the_scoped_schema(self):
        self.assertIn("dataset_schema: ${resources.schemas.scoped.name}", OBSERVATORY_YML)

    def test_dashboard_viewers_query_as_themselves(self):
        """
        A published dashboard runs on the publisher's data permissions by
        default. current_user() would then be the publisher inside every scoped
        view, and each viewer would be handed the publisher's reader: the views
        would be per-reader and the dashboard would not.
        """
        self.assertIn("embed_credentials: false", OBSERVATORY_YML)

    def test_the_observatory_is_given_the_scoped_schema_and_not_gold(self):
        self.assertIn("MARGINALIA_SCOPED_SCHEMA", OBSERVATORY_YML)
        self.assertNotIn("MARGINALIA_GOLD_SCHEMA", OBSERVATORY_YML)
        self.assertNotIn("MARGINALIA_SILVER_SCHEMA", OBSERVATORY_YML)

    def test_the_views_are_maintained_by_a_task_rather_than_by_hand(self):
        """
        A full refresh drops and recreates the materialized views these select
        from. Created once at deploy, they would survive as definitions
        pointing at tables that no longer exist.
        """
        self.assertIn("reader_scope.py", INGESTION_YML)
        self.assertIn("--scoped_schema=${resources.schemas.scoped.name}", INGESTION_YML)

    def test_the_view_task_runs_after_the_tables_it_reads_are_built(self):
        task = INGESTION_YML[INGESTION_YML.index("task_key: reader_scope") :]
        task = task[: task.index("environment_key")]
        self.assertIn("task_key: build_frontier", task)


class TheOneViewThatDoesNotFilter(unittest.TestCase):
    """
    An exemption in a boundary is the thing most worth writing a test about.
    These insist the list stays short, that the table it names genuinely has no
    reader in it, and that the exemption cannot be granted by accident.
    """

    def test_there_is_exactly_one_and_it_is_the_evaluation_table(self):
        self.assertEqual(UNFILTERED_VIEWS, (("librarian_quality", "ops", "librarian_evaluations"),))

    def test_the_source_it_reads_declares_no_reader_column(self):
        """
        The justification for the exemption is that there is no reader to
        filter on. That is a fact about the table's DDL, so it is checked
        against the DDL rather than against the sentence explaining it.
        """
        evaluation = (ROOT / "databricks/src/librarian_evaluation.py").read_text()
        declared = evaluation[evaluation.index("RESULT_COLUMNS = (") :]
        declared = declared[: declared.index("\n)")]
        self.assertNotIn("user_id", declared)
        self.assertIn("case_id", declared)

    def test_a_source_that_grew_a_reader_column_stops_the_run(self):
        """
        Checked at run time as well, because the DDL above is `IF NOT EXISTS`:
        a table altered in the workspace would not change the statement here.
        """
        self.assertIn("_has_reader_column", SCOPE_PY)
        self.assertIn("served unfiltered but now has a user_id column", SCOPE_PY)

    def test_it_is_not_given_a_filter_that_is_always_true(self):
        """
        A trivially-true predicate would make it look like its neighbours and
        behave nothing like them, which is worse than plainly having none.
        """
        for _name, _source, ddl in UNFILTERED:
            self.assertNotIn("WHERE", ddl)
            self.assertNotIn("current_user()", ddl)


class WhatIsNotClaimed(unittest.TestCase):
    def test_the_module_says_what_this_boundary_does_not_cover(self):
        """
        The owner of these schemas can still read the base tables or redefine
        these views. Isolation between readers is real; isolation from the
        person who deployed the workspace is not, and a comment claiming
        otherwise would be the most expensive kind of wrong.
        """
        self.assertIn("owner of these schemas still owns them", SCOPE_PY)

    def test_row_filters_are_recorded_as_unavailable_rather_than_unconsidered(self):
        self.assertIn("Row filters", SCOPE_PY)
        self.assertIn("materialized view", SCOPE_PY)


class TheDdlNamesOnlyIdentifiersThisRepositoryChose(unittest.TestCase):
    def test_nothing_a_reader_wrote_reaches_a_statement(self):
        """
        Every identifier in the DDL is a literal in reader_scope.py or a bundle
        variable. No table is read to decide what to create, so there is no
        path from a row into a statement this executes.
        """
        for table in set(GOLD_VIEWS) | set(SILVER_VIEWS):
            self.assertRegex(table, r"^[a-z][a-z0-9_]*$")
        self.assertRegex(PRINCIPALS_TABLE, r"^[a-z][a-z0-9_]*$")

    def test_the_view_ddl_replaces_rather_than_accumulating(self):
        """
        A column added to a Gold table has to reach the view, and a view left
        as it was would keep serving the old projection while every test that
        reads the source passed.
        """
        ddl = scoped_view_ddl("cat", "scoped", "gold", "book_engagement", "ops")
        self.assertIn("CREATE OR REPLACE VIEW", ddl)
        self.assertIn("SELECT source.*", ddl)


if __name__ == "__main__":
    unittest.main()
