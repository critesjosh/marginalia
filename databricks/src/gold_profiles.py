# Gold: book engagement and the reader interest profile.
#
# Materialized views, because both are pure aggregation over Silver and cost
# nothing but compute to recompute. Every score exposes the components it was
# built from, so a number can be recomputed rather than believed.

from pyspark import pipelines as dp
from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F

spark = SparkSession.getActiveSession()

CATALOG = spark.conf.get("marginalia.catalog")
SILVER = spark.conf.get("marginalia.silver_schema")
GOLD = spark.conf.get("marginalia.gold_schema")

SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"
HIGHLIGHTS_CURRENT = f"{CATALOG}.{SILVER}.highlights_current"
READING_SESSIONS = f"{CATALOG}.{SILVER}.reading_sessions"
EXTRACTIONS = f"{CATALOG}.{SILVER}.concept_extractions"
SOURCE_STATE = f"{CATALOG}.{SILVER}.concept_source_state"

CONCEPT_EVIDENCE = f"{CATALOG}.{GOLD}.concept_evidence"
EXTRACTION_HEALTH = f"{CATALOG}.{GOLD}.extraction_health"
BOOK_ENGAGEMENT = f"{CATALOG}.{GOLD}.book_engagement"
READER_INTEREST = f"{CATALOG}.{GOLD}.reader_interest_profile"

SCORE_VERSION = "engagement_score_v1"
INTEREST_VERSION = "reader_interest_v1"

# Mirrors databricks/src/concepts.py. The Python copy is what the contract tests
# exercise; this is the same arithmetic in Spark, and the two are checked against
# each other by the shared reference values in those tests.
EVIDENCE_WEIGHTS = {
    "highlight_passage": 1.0,
    "highlight_note": 1.5,
    "user_question": 2.0,
    "book_memory": 0.75,
    "book_description": 0.25,
    "assistant_text": 0.0,
}
RECENCY_HALF_LIFE_DAYS = 90.0


def _saturating_log(column, ceiling: float):
    return F.least(F.lit(1.0), F.log1p(F.greatest(F.lit(0.0), column)) / F.log1p(F.lit(ceiling)))


# No delta.enableChangeDataFeed here. A materialized view accepts the property
# and does not honour it: CHANGE DATA FEED is not a supported operation on one,
# and a synced table that tried to read the feed failed rather than fell back.
# The serving copies take full snapshots instead, which is why they can.
@dp.materialized_view(
    name=BOOK_ENGAGEMENT,
    comment="Engagement per reader and book, with every component the score is built from.",
)
def book_engagement():
    sessions = (
        spark.read.table(READING_SESSIONS)
        .groupBy("user_id", "book_id")
        .agg(
            (F.sum("active_seconds") / 60.0).alias("active_minutes"),
            F.count("*").alias("session_count"),
            F.countDistinct(F.to_date("started_at")).alias("active_days"),
            F.max("maximum_progress").alias("maximum_progress"),
            F.max_by("ending_progress", F.col("ended_at")).alias("current_progress"),
            F.min("started_at").alias("first_activity_at"),
            F.max("ended_at").alias("last_activity_at"),
        )
    )

    highlights = (
        spark.read.table(HIGHLIGHTS_CURRENT)
        .groupBy("user_id", "book_id")
        .agg(F.count("*").alias("current_highlights"))
    )

    events = spark.read.table(SILVER_EVENTS)
    questions = (
        events.filter(F.col("event_type") == "question_asked")
        .groupBy("user_id", "book_id")
        .agg(F.count("*").alias("questions"))
    )
    completions = (
        events.filter(F.col("event_type") == "book_completed")
        .groupBy("user_id", "book_id")
        .agg(F.min("effective_event_time").alias("completed_at"))
    )

    # The title the reader's own library holds for a book, from the event that
    # added it. This is book metadata rather than anything the reader wrote, so
    # it can sit in Gold and be read by a surface granted none of their words.
    #
    # The latest book_added wins, because a re-added book carries the title the
    # library has now. Null where a book reached Gold without one, which the
    # Observatory shows as a missing title beside the id rather than filling in
    # the id and calling it a title.
    titles = (
        events.filter(F.col("event_type") == "book_added")
        .groupBy("user_id", "book_id")
        .agg(
            F.max_by(
                F.get_json_object(F.col("payload_json"), "$.title"),
                F.col("effective_event_time"),
            ).alias("title")
        )
    )

    joined = (
        sessions.join(highlights, ["user_id", "book_id"], "full_outer")
        .join(questions, ["user_id", "book_id"], "full_outer")
        .join(completions, ["user_id", "book_id"], "full_outer")
        .fillna(
            {
                "active_minutes": 0.0,
                "session_count": 0,
                "active_days": 0,
                "maximum_progress": 0.0,
                "current_progress": 0.0,
                "current_highlights": 0,
                "questions": 0,
            }
        )
        # Left, where the others are outer: a title is something a row can
        # carry, never a reason for the row to exist. Joining it outer would
        # put a book the reader added and never opened into engagement with
        # zero of everything.
        .join(titles, ["user_id", "book_id"], "left")
    )

    completed = F.col("completed_at").isNotNull()
    return joined.withColumn("completed", completed).withColumn(
        "engagement_score",
        0.30 * _saturating_log(F.col("active_minutes"), 300.0)
        + 0.15 * _saturating_log(F.col("session_count"), 20.0)
        + 0.15 * F.least(F.lit(1.0), F.greatest(F.lit(0.0), F.col("maximum_progress")))
        + 0.15 * F.least(F.lit(1.0), F.col("current_highlights") / 10.0)
        + 0.15 * F.least(F.lit(1.0), F.col("questions") / 10.0)
        + 0.10 * F.when(completed, F.lit(1.0)).otherwise(F.lit(0.0)),
    ).withColumn("score_version", F.lit(SCORE_VERSION)).withColumn(
        "computed_at", F.current_timestamp()
    )


@dp.materialized_view(
    name=READER_INTEREST,
    comment="Interest per reader and concept, with the evidence and sources behind it.",
)
def reader_interest_profile():
    weights = F.create_map(
        *[item for pair in EVIDENCE_WEIGHTS.items() for item in (F.lit(pair[0]), F.lit(pair[1]))]
    )

    # What the reader's sources currently are and currently say, written by the
    # extraction job from Silver. Joining to it is what makes changed and deleted
    # content update evidence: a deleted highlight leaves no row, and changed text
    # carries a new hash, so the old concepts stop counting immediately rather
    # than waiting for a successful re-extraction that may never come.
    current = spark.read.table(SOURCE_STATE).select(
        "source_type", "source_id", "source_content_hash"
    )

    valid = (
        spark.read.table(EXTRACTIONS)
        .filter(F.col("validation_status") == "valid")
        .filter(F.col("canonical_concept").isNotNull())
        .join(current, ["source_type", "source_id", "source_content_hash"])
    )

    # One source contributes one extraction. Re-running the same content under a
    # new model, prompt, or canonicalization version writes a second valid set,
    # and counting both would double the source and repeat it in top_source_ids.
    latest = Window.partitionBy("source_type", "source_id", "source_content_hash")
    evidence = valid.withColumn("latest_at", F.max("extracted_at").over(latest)).filter(
        F.col("extracted_at") == F.col("latest_at")
    )

    contributions = (
        evidence.withColumn("weight", F.coalesce(weights[F.col("source_type")], F.lit(0.0)))
        .withColumn(
            "age_days",
            F.greatest(
                F.lit(0.0),
                (
                    # Aged against now, not against when it happened to be
                    # extracted. Decaying from extraction time would freeze a
                    # source at full weight forever once it had been read.
                    F.current_timestamp().cast("double")
                    - F.coalesce(F.col("source_time"), F.col("extracted_at")).cast("double")
                )
                / 86_400.0,
            ),
        )
        .withColumn(
            "decay", F.pow(F.lit(0.5), F.col("age_days") / F.lit(RECENCY_HALF_LIFE_DAYS))
        )
        .withColumn("contribution", F.col("weight") * F.col("confidence") * F.col("decay"))
        # Weight zero is kept rather than filtered, so a source type that
        # contributes nothing is visible in the evidence count instead of absent.
    )

    per_concept = contributions.groupBy(
        F.col("user_id"), F.col("canonical_concept").alias("concept_id")
    ).agg(
        F.sum("contribution").alias("raw_interest"),
        F.count("*").alias("evidence_count"),
        F.countDistinct("book_id").alias("distinct_books"),
        F.min("source_time").alias("first_evidence_at"),
        F.max("source_time").alias("last_evidence_at"),
        F.slice(
            F.transform(
                F.sort_array(
                    F.collect_list(F.struct(F.col("contribution"), F.col("source_id"))), False
                ),
                lambda item: item["source_id"],
            ),
            1,
            5,
        ).alias("top_source_ids"),
        F.max("canonicalization_version").alias("canonicalization_version"),
        F.max("model_endpoint").alias("model_endpoint"),
        F.max("prompt_version").alias("prompt_version"),
    )

    # Normalized within a reader: an interest score says where a concept sits
    # among that reader's own interests, not against anybody else's.
    strongest = Window.partitionBy("user_id")
    return (
        per_concept.withColumn("maximum_raw_interest", F.max("raw_interest").over(strongest))
        .withColumn(
            "interest_score",
            F.when(F.col("maximum_raw_interest") > 0, F.col("raw_interest") / F.col("maximum_raw_interest"))
            .otherwise(F.lit(0.0)),
        )
        .withColumn("score_version", F.lit(INTEREST_VERSION))
        .withColumn("computed_at", F.current_timestamp())
    )


@dp.materialized_view(
    name=CONCEPT_EVIDENCE,
    comment=(
        "How much evidence stands behind each concept, and from what kind of "
        "source. A projection: it exists so a reader-facing surface can show "
        "the evidence without being granted the table that holds the model's "
        "raw answer."
    ),
)
def concept_evidence():
    """
    The counts behind the profile, carrying no raw model output.

    concept_extractions holds raw_response, raw_concept, and broader_concept.
    raw_response is the model's whole answer to a prompt built from the
    reader's highlights, notes and questions, and validation checks its shape
    rather than its content, so it can quote them back. A grant on that table
    is a grant on the reader's words at one remove. This view is what gets
    granted instead.

    Joined to the source state for the same reason the profile is: an
    extraction whose source has been edited or deleted stops counting, so the
    evidence shown here is the evidence the current profile was built from
    rather than everything ever extracted.
    """
    current = spark.read.table(SOURCE_STATE).select(
        "source_type", "source_id", "source_content_hash"
    )
    valid = (
        spark.read.table(EXTRACTIONS)
        .filter(F.col("validation_status") == "valid")
        .filter(F.col("canonical_concept").isNotNull())
        .join(current, ["source_type", "source_id", "source_content_hash"])
    )
    latest = Window.partitionBy("source_type", "source_id", "source_content_hash")
    evidence = valid.withColumn("latest_at", F.max("extracted_at").over(latest)).filter(
        F.col("extracted_at") == F.col("latest_at")
    )
    return (
        evidence.groupBy("user_id", F.col("canonical_concept").alias("concept_id"), "source_type")
        .agg(
            F.count("*").alias("extractions"),
            F.countDistinct("source_id").alias("sources"),
            F.countDistinct("book_id").alias("books"),
            F.round(F.avg("confidence"), 3).alias("mean_confidence"),
            F.max("extracted_at").alias("last_extracted_at"),
        )
        .withColumn("computed_at", F.current_timestamp())
    )


@dp.materialized_view(
    name=EXTRACTION_HEALTH,
    comment="Extraction outcomes per reader, so an empty profile can be explained.",
)
def extraction_health():
    """
    Counts by outcome and nothing else. validation_detail is deliberately
    absent: it quotes the response that failed, which is the model's words
    about the reader's words.
    """
    return (
        spark.read.table(EXTRACTIONS)
        .groupBy("user_id", "validation_status")
        .agg(
            F.count("*").alias("extractions"),
            F.max("extracted_at").alias("last_extracted_at"),
        )
        .withColumn("computed_at", F.current_timestamp())
    )
