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


@dp.materialized_view(
    name=BOOK_ENGAGEMENT,
    comment="Engagement per reader and book, with every component the score is built from.",
    table_properties={"delta.enableChangeDataFeed": "true"},
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
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def reader_interest_profile():
    weights = F.create_map(
        *[item for pair in EVIDENCE_WEIGHTS.items() for item in (F.lit(pair[0]), F.lit(pair[1]))]
    )

    evidence = (
        spark.read.table(EXTRACTIONS)
        .filter(F.col("validation_status") == "valid")
        .filter(F.col("canonical_concept").isNotNull())
        # A source whose text has since changed or been deleted has a new hash,
        # and its old rows must stop counting. Keep only the extraction for the
        # hash the source currently has.
        .withColumn(
            "recency",
            F.row_number().over(
                Window.partitionBy("source_type", "source_id").orderBy(
                    F.col("extracted_at").desc()
                )
            ),
        )
    )
    current_hash = (
        evidence.filter("recency = 1")
        .select("source_type", "source_id", F.col("source_content_hash").alias("current_hash"))
        .distinct()
    )

    contributions = (
        evidence.join(current_hash, ["source_type", "source_id"])
        .filter(F.col("source_content_hash") == F.col("current_hash"))
        .withColumn("weight", F.coalesce(weights[F.col("source_type")], F.lit(0.0)))
        .withColumn(
            "age_days",
            F.greatest(
                F.lit(0.0),
                (
                    F.col("extracted_at").cast("double")
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
