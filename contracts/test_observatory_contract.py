"""
Phase 7's boundary is a grant, and a grant is invisible in the source. These
hold the Observatory's statements, the Genie space's instructions, and the
evaluation questions against what the phase actually promises.

The promise that matters: no surface added here can read a reader's own words.
Everything else in this file exists so that promise cannot quietly stop being
true.
"""

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "databricks/src/observatory"))
sys.path.insert(0, str(ROOT / "databricks/src"))

from queries import (  # noqa: E402
    FORBIDDEN_TABLES,
    WITHOUT_A_READER,
    PERMITTED_TABLES,
    STATEMENTS,
    WITHOUT_SOURCE_TIMESTAMP,
    Result,
)

OBSERVATORY_PY = (ROOT / "databricks/src/observatory/app.py").read_text()
OBSERVATORY_YML = (ROOT / "databricks/resources/observatory.yml").read_text()
GENIE = json.loads((ROOT / "databricks/genie/marginalia.geniespace.json").read_text())
QUESTIONS = json.loads((ROOT / "databricks/eval/genie_questions.json").read_text())
DASHBOARD = json.loads((ROOT / "databricks/dashboards/marginalia.lvdash.json").read_text())
DELETION_PY = (ROOT / "databricks/src/deletion.py").read_text()


def tables_named(statement: str) -> set[str]:
    """Every table a statement reads, by the name that follows FROM or JOIN."""
    found = set()
    for match in re.findall(r"(?:FROM|JOIN)\s+\{scoped\}\.(\w+)", statement):
        found.add(match)
    return found


class TheStatementsStillNameTables(unittest.TestCase):
    """
    Every check below is written in terms of what tables_named() finds, so a
    placeholder rename that silently made it find nothing would turn this whole
    file green while enforcing none of it. That has one line of defence and
    this is it.
    """

    def test_the_statements_parse(self):
        for name, statement in STATEMENTS.items():
            self.assertTrue(tables_named(statement), f"{name} names no table")


class TheBoundary(unittest.TestCase):
    def test_no_statement_reads_a_table_holding_the_readers_words(self):
        """
        The grant is the real enforcement, and it fails loudly. This fails
        earlier and says why, because a statement that needs a grant nobody
        intended to give is a design mistake rather than a permissions one.
        """
        for name, statement in STATEMENTS.items():
            for table in tables_named(statement):
                self.assertNotIn(table, FORBIDDEN_TABLES, f"{name} reads {table}")

    def test_every_statement_reads_only_permitted_tables(self):
        for name, statement in STATEMENTS.items():
            self.assertTrue(
                tables_named(statement) <= PERMITTED_TABLES,
                f"{name} reads {tables_named(statement) - PERMITTED_TABLES}",
            )

    def test_the_two_lists_do_not_overlap(self):
        self.assertEqual(PERMITTED_TABLES & FORBIDDEN_TABLES, set())

    def test_every_statement_is_scoped_to_one_reader(self):
        """
        An Observatory query without a user predicate would show one reader
        another's reading the moment a second reader exists.

        Agent quality is the exception and is named rather than skipped: it
        reads how the Librarian scored against synthetic readers over fixture
        passages, from a table with no reader column at all. A predicate there
        would return nothing and read as an agent nobody had evaluated.
        """
        for name, statement in STATEMENTS.items():
            if name in WITHOUT_A_READER:
                self.assertNotIn(":user", statement, f"{name} claims a reader it has none of")
                continue
            self.assertIn(":user", statement, f"{name} is not scoped to a reader")

    def test_the_observatory_refuses_rather_than_choosing_a_reader(self):
        self.assertIn("MARGINALIA_TRUSTED_USER_ID", OBSERVATORY_PY)
        self.assertIn("Not configured", OBSERVATORY_PY)
        self.assertIn('value: ${var.trusted_user_id}', OBSERVATORY_YML)


class SourceTimestamps(unittest.TestCase):
    """
    "Every visualization shows its source update time" is a plan requirement,
    and the commonest way to break it is to add a view and forget.
    """

    def test_every_statement_returns_a_source_timestamp(self):
        for name, statement in STATEMENTS.items():
            if name in WITHOUT_SOURCE_TIMESTAMP:
                continue
            self.assertIn("computed_at", statement, f"{name} returns no source timestamp")

    def test_a_statement_without_one_says_so_rather_than_inventing_one(self):
        """
        reading_sessions records when reading happened, not when it was
        recomputed. Aliasing the latest activity into computed_at would make a
        stale view look current every time the reader read something.
        """
        for name in WITHOUT_SOURCE_TIMESTAMP:
            self.assertNotIn("AS computed_at", STATEMENTS[name])
        self.assertTrue(WITHOUT_SOURCE_TIMESTAMP < set(STATEMENTS))

    def test_the_overview_reports_its_oldest_source_not_its_newest(self):
        """Six numbers from four tables under one timestamp must be the oldest."""
        self.assertIn("least(", STATEMENTS["overview"])

    def test_freshness_never_reports_the_time_it_was_asked(self):
        """
        A view with no source timestamp must say so. Falling back to now would
        make every stale number look fresh, which is the specific failure this
        requirement exists to prevent.
        """
        self.assertEqual(
            Result(columns=[], rows=[]).freshness(), "source timestamp unavailable"
        )

    def test_the_dashboard_surfaces_its_source_timestamp(self):
        serialized = json.dumps(DASHBOARD)
        self.assertIn("computed_at", serialized)


class GenieInstructions(unittest.TestCase):
    def test_the_instructions_state_the_grain_of_every_table(self):
        instructions = GENIE["instructions"]
        for table in (
            "reader_interest_profile",
            "book_engagement",
            "intellectual_frontier",
            "recommendation_candidates",
        ):
            self.assertIn(table, instructions)
        self.assertIn("one row per", instructions)

    def test_the_instructions_name_the_score_versions(self):
        instructions = GENIE["instructions"]
        for version in (
            "reader_interest_v1",
            "engagement_score_v1",
            "frontier_heuristic_v1",
            "recommendation_heuristic_v1",
        ):
            self.assertIn(version, instructions)

    def test_the_instructions_forbid_the_join_that_is_always_empty(self):
        """
        The frontier is defined as concepts with no direct evidence, so an
        inner join to the interest profile returns nothing. A text-to-SQL
        answer of zero rows would read as "no frontier", not as a bad join.
        """
        instructions = GENIE["instructions"]
        self.assertIn("anti-join", instructions)
        self.assertIn("empty by construction", instructions)

    def test_the_instructions_forbid_crossing_identifier_spaces(self):
        instructions = GENIE["instructions"]
        self.assertIn("OpenAlex", instructions)
        self.assertIn("Open Library", instructions)
        self.assertIn("different identifier space", instructions)

    def test_the_instructions_require_refusal_rather_than_an_empty_result(self):
        """An empty result claims the reader has none. That is a false claim."""
        instructions = GENIE["instructions"]
        self.assertIn("will not read it", instructions)
        self.assertIn("empty result", instructions)

    def test_the_instructions_name_concept_extractions_as_off_limits(self):
        """
        Its raw_response column is a model's whole answer to a prompt built
        from the reader's text, so it is their words at one remove and the
        easiest table to reach for while believing the boundary held.
        """
        self.assertIn("concept_extractions", GENIE["instructions"])
        self.assertIn("raw_response", GENIE["instructions"])

    def test_the_instructions_require_the_source_timestamp_for_freshness(self):
        instructions = GENIE["instructions"]
        self.assertIn("computed_at", instructions)
        self.assertIn("Never report the current time", instructions)


class FixedQuestions(unittest.TestCase):
    def test_every_question_carries_its_grain_and_its_checks(self):
        for question in QUESTIONS["questions"]:
            self.assertTrue(question["question"])
            self.assertTrue(question["grain"], question["id"])
            self.assertTrue(question["checks"], question["id"])

    def test_every_answerable_question_has_expected_sql(self):
        for question in QUESTIONS["questions"]:
            if question.get("expected_behavior") == "refuse":
                self.assertIsNone(question["expected_sql"])
            else:
                self.assertTrue(question["expected_sql"], question["id"])

    def test_the_set_includes_a_question_that_must_be_refused(self):
        """
        A question set with no wrong question only measures willingness. The
        refusal case is the one that tests the boundary rather than the SQL.
        """
        refusals = [q for q in QUESTIONS["questions"] if q.get("expected_behavior") == "refuse"]
        self.assertTrue(refusals)

    def test_no_expected_sql_reads_a_forbidden_table(self):
        for question in QUESTIONS["questions"]:
            sql = question.get("expected_sql") or ""
            for table in FORBIDDEN_TABLES:
                self.assertNotIn(table, sql, question["id"])

    def test_the_questions_are_not_given_to_genie_as_hints(self):
        """
        An evaluation whose answers appear in the instructions measures
        retrieval of the instructions, not the ability to answer.
        """
        instructions = GENIE["instructions"]
        for question in QUESTIONS["questions"]:
            sql = question.get("expected_sql")
            if sql:
                self.assertNotIn(sql, instructions)
        for sample in GENIE.get("sample_questions", []):
            self.assertNotIn("SELECT", sample.upper())


class TheDeployedSpaceMatchesItsSources(unittest.TestCase):
    """
    The space is inlined in YAML so its table identifiers get per-target
    substitution, which means the instructions and benchmark answers exist
    twice. These hold the copy that deploys against the two files it came from.
    """

    def test_the_deployed_instructions_are_the_written_instructions(self):
        first = GENIE["instructions"].split("\n")[0]
        self.assertIn(json.dumps(first + "\n"), OBSERVATORY_YML)

    def test_no_expected_answer_is_deployed_into_the_space(self):
        """
        The evaluation SQL was installed as Genie benchmarks, which handed it
        the exact answer to every question it was then measured on. An
        evaluation whose answers ship with the thing being evaluated measures
        recall of its own configuration.
        """
        self.assertNotIn("benchmarks:", OBSERVATORY_YML)
        for question in QUESTIONS["questions"]:
            sql = question.get("expected_sql")
            if sql:
                self.assertNotIn(json.dumps(sql), OBSERVATORY_YML, question["id"])

    def test_the_space_reads_only_the_per_reader_views(self):
        """
        Data sources are what Genie is pointed at, and a list of them is not an
        access boundary: Genie runs queries under an identity that may hold
        Unity Catalog access of its own, so it can reach past the list. What
        makes the list mean something is that every entry is a view that
        filters by the querying principal, and that Genie's identity is granted
        those and nothing on Gold. Reaching past the list then reaches tables
        it cannot read.
        """
        identifiers = re.findall(r"- identifier: [^\n]*\.(\w+)$", OBSERVATORY_YML, re.M)
        self.assertTrue(identifiers)
        for table in identifiers:
            self.assertNotIn(table, FORBIDDEN_TABLES)
            self.assertIn(table, PERMITTED_TABLES)
        self.assertNotIn(
            "- identifier: ${var.catalog}.${resources.schemas.gold.name}.",
            OBSERVATORY_YML,
            "a Genie data source reads Gold directly, which is every reader's rows",
        )


class PinnedDependencies(unittest.TestCase):
    """
    Both apps pin every dependency, and a pin that cannot resolve is only
    discovered in a build log after a deploy. These catch the two ways that
    has already gone wrong.
    """

    OBSERVATORY = (ROOT / "databricks/src/observatory/requirements.txt").read_text()
    SERVING = (ROOT / "databricks/src/app/requirements.txt").read_text()

    def _pins(self, text: str) -> dict:
        return dict(
            re.findall(r"^([A-Za-z0-9_.\[\]-]+)==([\d.]+)$", text, re.M)
        )

    def test_every_dependency_is_pinned(self):
        for name, text in (("observatory", self.OBSERVATORY), ("serving", self.SERVING)):
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                self.assertIn("==", line, f"{name} does not pin {line}")

    def test_pandas_stays_below_what_the_sql_connector_allows(self):
        """
        databricks-sql-connector 4.0.5 requires pandas<2.3.0. Pinning 2.3.3
        made the app fail to install, which is a slow way to learn it.
        """
        pandas = self._pins(self.OBSERVATORY).get("pandas")
        self.assertIsNotNone(pandas)
        major, minor = (int(part) for part in pandas.split(".")[:2])
        self.assertTrue((major, minor) < (2, 3), f"pandas {pandas} conflicts with the connector")

    def test_both_apps_agree_on_the_sdk(self):
        """A Lakebase API present in one app and absent in the other is worse
        than either choice made consistently."""
        self.assertEqual(
            self._pins(self.OBSERVATORY).get("databricks-sdk"),
            self._pins(self.SERVING).get("databricks-sdk"),
        )


class PhaseBoundaries(unittest.TestCase):
    def test_agent_quality_distinguishes_unevaluated_from_faultless(self):
        """
        The view was a placeholder through Phase 7 and now reads a real table.
        The distinction it had to keep is the same one: an empty result means
        nothing has scored the agent, which is a different and worse statement
        than an agent that scored zero defects.
        """
        section = OBSERVATORY_PY[OBSERVATORY_PY.index("def agent_quality") :]
        section = section[: section.index("def ask")]
        self.assertIn("nothing has scored it", section)
        self.assertIn('run("agent_quality")', section)

    def test_agent_quality_reports_defects_rather_than_a_success_rate(self):
        """
        Each blocking count is meant to be zero. A percentage would make one
        spoiler violation across thirty cases read as 97% success.
        """
        section = OBSERVATORY_PY[OBSERVATORY_PY.index("BLOCKING_COLUMNS") :]
        section = section[: section.index("def ask")]
        for column in ("spoiler_violations", "citation_errors", "injection_failures"):
            self.assertIn(column, section)
        self.assertNotIn("success_rate", section)

    def test_ask_links_to_genie_rather_than_replacing_it(self):
        """The plan's instruction: stop rather than replace a product surface."""
        section = OBSERVATORY_PY[OBSERVATORY_PY.index("def ask") :]
        self.assertIn("link_button", section)
        self.assertIn("MARGINALIA_GENIE_SPACE_ID", OBSERVATORY_PY)

    def test_the_observatory_is_a_separate_app_from_the_serving_one(self):
        """
        Sharing an app would share a service principal, and with it a grant on
        Gold that the serving app has no business holding.
        """
        self.assertIn("observatory_app_name", OBSERVATORY_YML)
        serving = (ROOT / "databricks/resources/serving.yml").read_text()
        self.assertNotIn("observatory", serving)


class LeastPrivilege(unittest.TestCase):
    def test_the_observatory_takes_a_warehouse_and_nothing_else(self):
        """
        No database resource, and no job. It reads Gold; it has no reason to
        reach Lakebase or to start anything.
        """
        self.assertIn("sql_warehouse", OBSERVATORY_YML)
        self.assertNotIn("database:", OBSERVATORY_YML)
        self.assertNotIn("CAN_MANAGE_RUN", OBSERVATORY_YML)

    def test_no_workspace_or_credential_is_committed(self):
        for text in (OBSERVATORY_YML, json.dumps(GENIE), json.dumps(DASHBOARD)):
            self.assertNotIn("https://dbc-", text)
            self.assertNotIn("dapi", text)


if __name__ == "__main__":
    unittest.main()
