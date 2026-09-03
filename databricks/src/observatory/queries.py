"""
Every query the Observatory runs, in one place, each returning its own source
timestamp alongside its rows.

The plan requires that every visualization show when its source was last
computed. Making that a property of the query rather than something each view
remembers to add is the only way it stays true: a view that forgets is a view
that quietly presents old numbers as current ones.

Nothing here selects a reader's own words. The Observatory shows how much
evidence stands behind a number and which sources produced it, by id and by
count, and stops there. The grant it runs under does not extend further, so a
query that tried would fail rather than succeed quietly.

Every statement names the scoped schema, whose views return only the rows the
querying principal is mapped to. The `:user` predicate is kept alongside that
and is now the second of two independent limits: the view decides what exists,
the predicate decides what is asked for. Either alone would be enough; keeping
both means a mistake in one is not a disclosure.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class Result:
    """Rows, the columns they arrived in, and when the source last changed."""

    columns: list[str]
    rows: list[tuple]
    computed_at: datetime | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.rows

    def freshness(self, now: datetime | None = None) -> str:
        """
        How old the source is, in words. Deliberately not "just now": the
        smallest honest unit here is a minute, because the pipeline that
        produces these runs on a fifteen-minute schedule.
        """
        if self.computed_at is None:
            return "source timestamp unavailable"
        moment = self.computed_at
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        elapsed = (now or datetime.now(timezone.utc)) - moment
        minutes = int(elapsed.total_seconds() // 60)
        if minutes < 1:
            return f"computed {moment:%H:%M} UTC, under a minute ago"
        if minutes < 60:
            return f"computed {moment:%H:%M} UTC, {minutes} min ago"
        hours = minutes // 60
        if hours < 24:
            return f"computed {moment:%H:%M} UTC, {hours}h ago"
        return f"computed {moment:%Y-%m-%d %H:%M} UTC, {hours // 24}d ago"


# Every statement is parameterized on the reader, and every table it names is a
# per-reader view. The Observatory serves one trusted reader in this prototype.
OVERVIEW = """
SELECT
  (SELECT count(*) FROM {scoped}.reader_interest_profile WHERE user_id = :user) AS concepts,
  (SELECT count(*) FROM {scoped}.book_engagement WHERE user_id = :user) AS books,
  (SELECT coalesce(sum(current_highlights), 0) FROM {scoped}.book_engagement WHERE user_id = :user) AS highlights,
  (SELECT coalesce(sum(questions), 0) FROM {scoped}.book_engagement WHERE user_id = :user) AS questions,
  (SELECT count(*) FROM {scoped}.intellectual_frontier WHERE user_id = :user) AS frontier,
  (SELECT count(*) FROM {scoped}.recommendation_candidates WHERE user_id = :user) AS recommendations,
  -- The oldest of the sources, not the newest. Every number above comes from
  -- a different table, and labelling them all with the freshest would let a
  -- stale frontier sit under a timestamp earned by the profile.
  least(
    (SELECT max(computed_at) FROM {scoped}.reader_interest_profile WHERE user_id = :user),
    (SELECT max(computed_at) FROM {scoped}.book_engagement WHERE user_id = :user),
    coalesce((SELECT max(computed_at) FROM {scoped}.intellectual_frontier WHERE user_id = :user), current_timestamp()),
    coalesce((SELECT max(computed_at) FROM {scoped}.recommendation_candidates WHERE user_id = :user), current_timestamp())
  ) AS computed_at
"""

READING = """
SELECT book_id, active_minutes, session_count, active_days, maximum_progress,
       current_progress, current_highlights, questions, completed,
       engagement_score, score_version, first_activity_at, last_activity_at, computed_at
FROM {scoped}.book_engagement
WHERE user_id = :user
ORDER BY engagement_score DESC, book_id
"""

INTERESTS = """
SELECT concept_id, interest_score, evidence_count, distinct_books,
       first_evidence_at, last_evidence_at, top_source_ids,
       score_version, canonicalization_version, model_endpoint, prompt_version, computed_at
FROM {scoped}.reader_interest_profile
WHERE user_id = :user
ORDER BY interest_score DESC, concept_id
"""

# The evidence behind the profile, from a Gold projection rather than from
# concept_extractions itself. That table holds raw_response, the model's whole
# answer to a prompt built from the reader's highlights and questions, which
# validation checks the shape of rather than the content of. Reading the
# projection means this app is never granted the table, so the boundary is a
# grant rather than a promise about which columns get selected.
CONCEPTS = """
SELECT concept_id, source_type, extractions, sources, books,
       mean_confidence, last_extracted_at, computed_at
FROM {scoped}.concept_evidence
WHERE user_id = :user
ORDER BY extractions DESC, concept_id
"""

# Why extraction rejected what it rejected. An empty profile with no explanation
# is indistinguishable from a reader who highlighted nothing. Counts only:
# validation_detail quotes the response that failed.
EXTRACTION_HEALTH = """
SELECT validation_status, extractions, last_extracted_at, computed_at
FROM {scoped}.extraction_health
WHERE user_id = :user
ORDER BY extractions DESC
"""

FRONTIER = """
SELECT candidate_concept, frontier_score, neighbour_count, supporting_work_count,
       best_cited_by_count, established_concepts, supporting_works,
       supporting_work_ids, source_request_ids, score_version, computed_at
FROM {scoped}.intellectual_frontier
WHERE user_id = :user
ORDER BY frontier_score DESC, candidate_concept
"""

RECOMMENDATIONS = """
SELECT candidate_title, authors, publication_year, recommendation_score, explanation,
       concept_interest_match, frontier_coverage, diversity, popularity_prior,
       metadata_completeness, matched_concepts, candidate_id,
       source_request_ids, score_version, computed_at
FROM {scoped}.recommendation_candidates
WHERE user_id = :user
ORDER BY recommendation_score DESC, candidate_id
"""

# Reading sessions, for the shape of attention over time rather than its total.
#
# reading_sessions records when reading happened and not when the table was
# last recomputed, so there is no honest computed_at to report here. It carries
# none rather than aliasing the latest activity into that column, which would
# claim a stale view was current whenever the reader last read.
SESSIONS = """
SELECT to_date(started_at) AS day, count(*) AS sessions,
       round(sum(active_seconds) / 60.0, 1) AS active_minutes,
       max(ended_at) AS latest_activity
FROM {scoped}.reading_sessions
WHERE user_id = :user
GROUP BY to_date(started_at)
ORDER BY day
"""

# How the Librarian scored, from the most recent evaluation run.
#
# The only statement here with no reader in it, and the only one over a table
# that has none. An evaluation runs against synthetic readers over fixture
# passages, so there is no reader whose agent quality this is; adding a
# predicate to make it look like its neighbours would return nothing and read
# as an agent that had never been evaluated.
#
# Defect counts rather than a score. Every one of them is meant to be zero, and
# a percentage would make one spoiler violation look like 97% success.
AGENT_QUALITY = """
WITH latest AS (SELECT max(run_id) AS run_id FROM {scoped}.librarian_quality)
SELECT case_id, passed, cross_reader_evidence, spoiler_violations, citation_errors,
       unsupported_answers, injection_failures, retrieval_recall, latency_ms,
       problems, prompt_version, serving_endpoint,
       evaluated_at AS computed_at
FROM {scoped}.librarian_quality
WHERE run_id = (SELECT run_id FROM latest)
ORDER BY passed, case_id
"""

# Statements with no source timestamp of their own, named rather than inferred,
# so the test that every other statement carries one still means something.
WITHOUT_SOURCE_TIMESTAMP = {"sessions"}

# The statements that name no reader, for the same reason. One entry, and the
# test insists a statement is either in here or carries the predicate.
WITHOUT_A_READER = {"agent_quality"}

STATEMENTS = {
    "overview": OVERVIEW,
    "reading": READING,
    "interests": INTERESTS,
    "concepts": CONCEPTS,
    "extraction_health": EXTRACTION_HEALTH,
    "frontier": FRONTIER,
    "recommendations": RECOMMENDATIONS,
    "sessions": SESSIONS,
    "agent_quality": AGENT_QUALITY,
}

# Tables the Observatory is allowed to name, all of them per-reader views in
# the scoped schema. A statement mentioning anything else is a bug worth
# failing on rather than discovering in a grant error, and the contract test
# holds this list against what reader_scope.py actually creates.
PERMITTED_TABLES = {
    "book_engagement",
    "reader_interest_profile",
    "intellectual_frontier",
    "recommendation_candidates",
    "concept_evidence",
    "extraction_health",
    "reading_sessions",
    "librarian_quality",
}

# Tables that hold a reader's own words. Naming one here is not a grant; it is
# the list a test checks the statements against, so the boundary is enforced by
# something other than everyone remembering it.
FORBIDDEN_TABLES = {
    # Holds raw_response: the model's entire answer to a prompt built from the
    # reader's own text, checked for shape and not for content. Reading it is
    # reading their words at one remove, so the Observatory reads the
    # concept_evidence projection instead and is never granted this.
    "concept_extractions",
    "events_raw",
    "ingestion_quarantine",
    "events",
    "highlights_current",
    "highlight_history",
    "public_sources_raw",
    "_concept_extraction_staging",
}
