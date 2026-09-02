# Incremental concept extraction.
#
# A job, not a declarative pipeline, and deliberately so: a materialized view is
# recomputed whenever its source changes, which would call the model again for
# text that has not changed. Extraction is keyed by the hash of the content it
# read, so unchanged content is never paid for twice.

import json
import sys
import uuid

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

from concepts import (
    CANONICALIZATION_VERSION,
    MAX_EXTRACTION_ATTEMPTS,
    PROMPT_VERSION,
    ResponseInvalid,
    parse_extraction_response,
)

spark = SparkSession.getActiveSession()


def _argument(name: str, fallback: str | None = None) -> str:
    """
    A job task is given command-line parameters, not pipeline configuration, so
    nothing here can be read from spark.conf the way the declarative pipelines
    read theirs.
    """
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


CATALOG = _argument("catalog")
SILVER = _argument("silver_schema")
MODEL_ENDPOINT = _argument("concept_endpoint")
# Bounded so one run cannot spend without limit; the next run takes the rest.
BATCH_LIMIT = int(_argument("extraction_batch_limit", "200"))

SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"
HIGHLIGHTS_CURRENT = f"{CATALOG}.{SILVER}.highlights_current"
EXTRACTIONS = f"{CATALOG}.{SILVER}.concept_extractions"

SYSTEM_PROMPT = (
    "You extract the intellectual concepts a reader is engaging with.\n"
    "You are given one piece of text that a reader wrote or marked.\n"
    "Return between 1 and 8 concepts. A concept is a short noun phrase, at most "
    "80 characters. Prefer the specific over the general.\n"
    "Do not return the book's title, its author, or a character's name.\n"
    "Do not invent concepts the text does not support.\n"
    "confidence is your estimate from 0 to 1 that the concept is present.\n"
    "broader is optional: a single more general concept this one sits under.\n"
    'Respond with JSON only, shaped {"concepts":[{"label":str,"confidence":number,'
    '"broader":str}]}. No prose, no code fence.'
)

PARSED_SCHEMA = StructType(
    [
        StructField("validation_status", StringType()),
        StructField("validation_detail", StringType()),
        StructField(
            "concepts",
            ArrayType(
                StructType(
                    [
                        StructField("raw_concept", StringType()),
                        StructField("canonical_concept", StringType()),
                        StructField("broader_concept", StringType()),
                        StructField("confidence", DoubleType()),
                        StructField("canonicalization_version", IntegerType()),
                    ]
                )
            ),
        ),
    ]
)


@F.udf(returnType=PARSED_SCHEMA)
def validate_response(raw):
    """
    The same validator the deterministic contract tests exercise. Returning the
    status rather than raising keeps one bad response from failing the run.
    """
    try:
        return ("valid", None, parse_extraction_response(raw))
    except ResponseInvalid as invalid:
        return (invalid.status, invalid.detail, None)


def ensure_tables():
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SILVER}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {EXTRACTIONS} (
          user_id STRING NOT NULL,
          book_id STRING,
          source_type STRING NOT NULL,
          source_id STRING NOT NULL,
          source_content_hash STRING NOT NULL,
          source_time TIMESTAMP,
          model_endpoint STRING NOT NULL,
          prompt_version STRING NOT NULL,
          canonicalization_version INT,
          raw_concept STRING,
          canonical_concept STRING,
          broader_concept STRING,
          confidence DOUBLE,
          extracted_at TIMESTAMP NOT NULL,
          raw_response STRING,
          validation_status STRING NOT NULL,
          validation_detail STRING,
          attempts INT NOT NULL,
          run_id STRING NOT NULL
        )
        USING DELTA
        TBLPROPERTIES (delta.enableChangeDataFeed = true)
        """
    )


def candidates():
    """
    Only consented text, and only text the reader themself produced or marked.
    Assistant text has no branch here at all: it is not excluded downstream, it
    is never a candidate.
    """
    highlights = spark.read.table(HIGHLIGHTS_CURRENT)
    included = F.from_json(F.col("privacy_json"), "consentVersion INT, included ARRAY<STRING>")

    passages = (
        highlights.withColumn("privacy", included)
        .filter(F.array_contains(F.col("privacy.included"), "highlightText"))
        .filter(F.col("text").isNotNull() & (F.length(F.trim(F.col("text"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.lit("highlight_passage").alias("source_type"),
            F.col("highlight_id").alias("source_id"),
            F.col("text").alias("source_text"),
            F.col("effective_event_time").alias("source_time"),
        )
    )

    notes = (
        highlights.withColumn("privacy", included)
        .filter(F.array_contains(F.col("privacy.included"), "highlightNotes"))
        .filter(F.col("note").isNotNull() & (F.length(F.trim(F.col("note"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.lit("highlight_note").alias("source_type"),
            F.concat_ws(":", F.col("highlight_id"), F.lit("note")).alias("source_id"),
            F.col("note").alias("source_text"),
            F.col("effective_event_time").alias("source_time"),
        )
    )

    events = spark.read.table(SILVER_EVENTS)
    privacy = F.from_json(F.col("privacy_json"), "consentVersion INT, included ARRAY<STRING>")
    questions = (
        events.filter(F.col("event_type") == "question_asked")
        .withColumn("privacy", privacy)
        .filter(F.array_contains(F.col("privacy.included"), "conversationText"))
        .withColumn("content", F.try_variant_get(F.col("payload"), "$.content", "string"))
        .filter(F.col("content").isNotNull() & (F.length(F.trim(F.col("content"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.lit("user_question").alias("source_type"),
            F.col("message_id").alias("source_id"),
            F.col("content").alias("source_text"),
            F.col("effective_event_time").alias("source_time"),
        )
    )

    return (
        passages.unionByName(notes)
        .unionByName(questions)
        .withColumn("source_content_hash", F.sha2(F.col("source_text"), 256))
    )


def pending(all_candidates):
    """
    A candidate is pending when nothing has been recorded for this exact content
    under this exact model, prompt, and canonicalization version, and it has not
    already exhausted its attempts. Changing any of those four is what makes a
    manual retry possible without a special code path.
    """
    try:
        seen = spark.read.table(EXTRACTIONS)
    except Exception:
        return all_candidates.limit(BATCH_LIMIT)

    key = ["source_type", "source_id", "source_content_hash"]
    settled = (
        seen.filter(
            (F.col("model_endpoint") == MODEL_ENDPOINT)
            & (F.col("prompt_version") == PROMPT_VERSION)
            & (
                F.col("canonicalization_version").eqNullSafe(CANONICALIZATION_VERSION)
                | (F.col("validation_status") != "valid")
            )
        )
        .groupBy(*key)
        .agg(
            F.max(F.col("validation_status") == "valid").alias("succeeded"),
            F.max("attempts").alias("attempts"),
        )
        .filter(F.col("succeeded") | (F.col("attempts") >= MAX_EXTRACTION_ATTEMPTS))
        .select(*key)
    )
    return all_candidates.join(settled, key, "left_anti").limit(BATCH_LIMIT)


def previous_attempts(batch):
    try:
        seen = spark.read.table(EXTRACTIONS)
    except Exception:
        return batch.withColumn("previous_attempts", F.lit(0))

    key = ["source_type", "source_id", "source_content_hash"]
    counted = seen.groupBy(*key).agg(F.max("attempts").alias("previous_attempts"))
    return batch.join(counted, key, "left").fillna({"previous_attempts": 0})


def run():
    ensure_tables()
    batch = previous_attempts(pending(candidates()))
    if batch.isEmpty():
        print("no pending extraction candidates")
        return

    run_id = str(uuid.uuid4())

    # ai_query takes a single prompt string for a chat endpoint, so the system
    # rules are prepended rather than sent as their own message. The column is
    # built before it is read: adding it afterwards would leave ai_query
    # referencing a column that does not exist yet.
    prompted = batch.withColumn(
        "request", F.concat(F.lit(SYSTEM_PROMPT + "\n\nText:\n"), F.col("source_text"))
    )

    # failOnError => false so one refused or truncated response is recorded
    # against its own candidate rather than failing every other one with it.
    answered = prompted.withColumn(
        "response",
        F.expr(
            f"ai_query('{MODEL_ENDPOINT}', request, failOnError => false, "
            "modelParameters => named_struct('temperature', 0.0))"
        ),
    )

    parsed = answered.withColumn(
        "raw_response", F.col("response.result").cast("string")
    ).withColumn("parsed", validate_response(F.col("raw_response")))

    now = F.current_timestamp()
    common = [
        "user_id",
        "book_id",
        "source_type",
        "source_id",
        "source_content_hash",
        "source_time",
        F.lit(MODEL_ENDPOINT).alias("model_endpoint"),
        F.lit(PROMPT_VERSION).alias("prompt_version"),
    ]

    valid = (
        parsed.filter(F.col("parsed.validation_status") == "valid")
        .withColumn("concept", F.explode("parsed.concepts"))
        .select(
            *common,
            F.col("concept.canonicalization_version").alias("canonicalization_version"),
            F.col("concept.raw_concept").alias("raw_concept"),
            F.col("concept.canonical_concept").alias("canonical_concept"),
            F.col("concept.broader_concept").alias("broader_concept"),
            F.col("concept.confidence").alias("confidence"),
            now.alias("extracted_at"),
            # The response is the provenance for a concept now attached to a
            # reader. It is model output about consented text, held under the
            # same consent, and never logged.
            F.col("raw_response"),
            F.lit("valid").alias("validation_status"),
            F.lit(None).cast("string").alias("validation_detail"),
            (F.col("previous_attempts") + 1).alias("attempts"),
            F.lit(run_id).alias("run_id"),
        )
    )

    failed = parsed.filter(F.col("parsed.validation_status") != "valid").select(
        *common,
        F.lit(None).cast("int").alias("canonicalization_version"),
        F.lit(None).cast("string").alias("raw_concept"),
        F.lit(None).cast("string").alias("canonical_concept"),
        F.lit(None).cast("string").alias("broader_concept"),
        F.lit(None).cast("double").alias("confidence"),
        now.alias("extracted_at"),
        F.col("raw_response"),
        F.when(
            (F.col("previous_attempts") + 1) >= MAX_EXTRACTION_ATTEMPTS,
            F.lit("permanent_failure"),
        )
        .otherwise(F.col("parsed.validation_status"))
        .alias("validation_status"),
        F.col("parsed.validation_detail").alias("validation_detail"),
        (F.col("previous_attempts") + 1).alias("attempts"),
        F.lit(run_id).alias("run_id"),
    )

    valid.unionByName(failed).write.mode("append").saveAsTable(EXTRACTIONS)

    # Read the run back rather than recomputing the frame: every reference to it
    # would call the model again.
    summary = (
        spark.read.table(EXTRACTIONS)
        .filter(F.col("run_id") == run_id)
        .groupBy("validation_status")
        .count()
        .collect()
    )
    # Counts only. No raw text and no concept label reaches a log.
    print(
        json.dumps(
            {
                "run_id": run_id,
                "model_endpoint": MODEL_ENDPOINT,
                "prompt_version": PROMPT_VERSION,
                "canonicalization_version": CANONICALIZATION_VERSION,
                "rows_by_status": {row["validation_status"]: row["count"] for row in summary},
            }
        )
    )


run()
