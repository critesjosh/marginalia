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


# Every statement is parameterized on the reader. The Observatory serves one
# trusted reader in this prototype, and the parameter is what keeps that true
# rather than a comment saying it is.
OVERVIEW = """
SELECT
  (SELECT count(*) FROM {gold}.reader_interest_profile WHERE user_id = :user) AS concepts,
  (SELECT count(*) FROM {gold}.book_engagement WHERE user_id = :user) AS books,
  (SELECT coalesce(sum(current_highlights), 0) FROM {gold}.book_engagement WHERE user_id = :user) AS highlights,
  (SELECT coalesce(sum(questions), 0) FROM {gold}.book_engagement WHERE user_id = :user) AS questions,
  (SELECT count(*) FROM {gold}.intellectual_frontier WHERE user_id = :user) AS frontier,
  (SELECT count(*) FROM {gold}.recommendation_candidates WHERE user_id = :user) AS recommendations,
  (SELECT max(computed_at) FROM {gold}.reader_interest_profile WHERE user_id = :user) AS computed_at
"""

READING = """
SELECT book_id, active_minutes, session_count, active_days, maximum_progress,
       current_progress, current_highlights, questions, completed,
       engagement_score, score_version, first_activity_at, last_activity_at, computed_at
FROM {gold}.book_engagement
WHERE user_id = :user
ORDER BY engagement_score DESC, book_id
"""

INTERESTS = """
SELECT concept_id, interest_score, evidence_count, distinct_books,
       first_evidence_at, last_evidence_at, top_source_ids,
       score_version, canonicalization_version, model_endpoint, prompt_version, computed_at
FROM {gold}.reader_interest_profile
WHERE user_id = :user
ORDER BY interest_score DESC, concept_id
"""

# The evidence behind the profile, by source rather than by concept. This is
# what makes an interest score checkable: a number nobody can trace is a number
# nobody should believe.
CONCEPTS = """
SELECT canonical_concept, source_type, count(*) AS extractions,
       count(DISTINCT source_id) AS sources, count(DISTINCT book_id) AS books,
       round(avg(confidence), 3) AS mean_confidence,
       max(extracted_at) AS computed_at
FROM {silver}.concept_extractions
WHERE user_id = :user AND validation_status = 'valid'
GROUP BY canonical_concept, source_type
ORDER BY extractions DESC, canonical_concept
"""

# Why extraction rejected what it rejected. An empty profile with no explanation
# is indistinguishable from a reader who highlighted nothing.
EXTRACTION_HEALTH = """
SELECT validation_status, count(*) AS rows_, max(extracted_at) AS computed_at
FROM {silver}.concept_extractions
WHERE user_id = :user
GROUP BY validation_status
ORDER BY rows_ DESC
"""

FRONTIER = """
SELECT candidate_concept, frontier_score, neighbour_count, supporting_work_count,
       best_cited_by_count, established_concepts, supporting_works,
       supporting_work_ids, source_request_ids, score_version, computed_at
FROM {gold}.intellectual_frontier
WHERE user_id = :user
ORDER BY frontier_score DESC, candidate_concept
"""

RECOMMENDATIONS = """
SELECT candidate_title, authors, publication_year, recommendation_score, explanation,
       concept_interest_match, frontier_coverage, diversity, popularity_prior,
       metadata_completeness, matched_concepts, candidate_id,
       source_request_ids, score_version, computed_at
FROM {gold}.recommendation_candidates
WHERE user_id = :user
ORDER BY recommendation_score DESC, candidate_id
"""

# Reading sessions, for the shape of attention over time rather than its total.
SESSIONS = """
SELECT to_date(started_at) AS day, count(*) AS sessions,
       round(sum(active_seconds) / 60.0, 1) AS active_minutes,
       max(started_at) AS computed_at
FROM {silver}.reading_sessions
WHERE user_id = :user
GROUP BY to_date(started_at)
ORDER BY day
"""

STATEMENTS = {
    "overview": OVERVIEW,
    "reading": READING,
    "interests": INTERESTS,
    "concepts": CONCEPTS,
    "extraction_health": EXTRACTION_HEALTH,
    "frontier": FRONTIER,
    "recommendations": RECOMMENDATIONS,
    "sessions": SESSIONS,
}

# Tables the Observatory is allowed to name. A statement mentioning anything
# else is a bug worth failing on rather than discovering in a grant error, and
# the contract test holds this list against what the grants actually give.
PERMITTED_TABLES = {
    "book_engagement",
    "reader_interest_profile",
    "intellectual_frontier",
    "recommendation_candidates",
    "concept_extractions",
    "reading_sessions",
}

# Tables that hold a reader's own words. Naming one here is not a grant; it is
# the list a test checks the statements against, so the boundary is enforced by
# something other than everyone remembering it.
FORBIDDEN_TABLES = {
    "events_raw",
    "ingestion_quarantine",
    "events",
    "highlights_current",
    "highlight_history",
    "public_sources_raw",
    "_concept_extraction_staging",
}
