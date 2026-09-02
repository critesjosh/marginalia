# Incremental concept extraction.
#
# A job, not a declarative pipeline, and deliberately so: a materialized view is
# recomputed whenever its source changes, which would call the model again for
# text that has not changed. Extraction is keyed by the hash of the content it
# read, so unchanged content is never paid for twice.

import json
import sys
import uuid
from datetime import datetime, timezone

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
# What currently exists and what it currently says. Gold joins to this instead
# of inferring the present from past extractions.
SOURCE_STATE = f"{CATALOG}.{SILVER}.concept_source_state"
STAGING = f"{CATALOG}.{SILVER}._concept_extraction_staging"
RUNS = f"{CATALOG}.{SILVER}.concept_extraction_runs"

SOURCE_KEY = ["source_type", "source_id", "source_content_hash"]

SYSTEM_PROMPT = (
    "You extract the intellectual concepts a reader is engaging with.\n"
    "You are given one piece of text that a reader wrote or marked.\n"
    "Return between 1 and 8 concepts.\n"
    "A concept is an index term: the name of an idea, as it would appear in the index\n"
    "of a book or as the title of an encyclopedia entry. \"value judgment\", \"free\n"
    "will\", \"social contract\".\n"
    "Do not describe what the passage does. \"critique of moral values\" and\n"
    "\"examination of the origins of X\" are descriptions of the passage, not concepts;\n"
    "the concepts there are \"moral value\" and \"origin of X\".\n"
    "Name both the specific ideas the text invokes and the broad subject it belongs\n"
    "to, when the text genuinely supports both.\n"
    "Prefer fewer concepts. Return only what a careful reader would list as the\n"
    "passage's main subjects, not every phrase it contains.\n"
    "Do not return the book's title, its author, or a character's name.\n"
    "Do not invent concepts the text does not support.\n"
    "confidence is your estimate from 0 to 1 that the concept is present.\n"
    "broader is optional: a single more general concept this one sits under.\n"
    "Respond with JSON only, shaped {\"concepts\":[{\"label\":str,\"confidence\":number,\"broader\":str}]}. No prose, no code fence."
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
          response_chars INT,
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

    Book memory and book descriptions are named as candidate sources in the plan
    and are absent here on purpose: the v1 event contract carries no event that
    delivers either to Bronze, so there is nothing to read. They join when Phase 5
    completes behavioral coverage, and their evidence weights already exist.
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
    exhausted its attempts under that same combination. Changing any of the three
    is what makes a retry possible without a special code path, so every query
    below is scoped by all three rather than by content alone.
    """
    try:
        seen = _recorded()
    except Exception:
        return all_candidates.limit(BATCH_LIMIT)

    settled = (
        seen.groupBy(*SOURCE_KEY)
        .agg(
            F.max(F.col("validation_status") == "valid").alias("succeeded"),
            F.max("attempts").alias("attempts"),
        )
        .filter(F.col("succeeded") | (F.col("attempts") >= MAX_EXTRACTION_ATTEMPTS))
        .select(*SOURCE_KEY)
    )
    return all_candidates.join(settled, SOURCE_KEY, "left_anti").limit(BATCH_LIMIT)


def _recorded():
    """
    Rows this model, prompt, and canonicalization version produced. A failure
    records the canonicalization version that judged it, so bumping the version
    genuinely reopens a permanent failure instead of leaving it stuck behind a
    null.
    """
    return spark.read.table(EXTRACTIONS).filter(
        (F.col("model_endpoint") == MODEL_ENDPOINT)
        & (F.col("prompt_version") == PROMPT_VERSION)
        & (F.col("canonicalization_version") == CANONICALIZATION_VERSION)
    )


def previous_attempts(batch):
    try:
        counted = _recorded().groupBy(*SOURCE_KEY).agg(F.max("attempts").alias("previous_attempts"))
    except Exception:
        return batch.withColumn("previous_attempts", F.lit(0))
    return batch.join(counted, SOURCE_KEY, "left").fillna({"previous_attempts": 0})


def run():
    ensure_tables()
    started = datetime.now(timezone.utc)
    all_candidates = candidates()

    # The set of sources that currently exist, with the content they currently
    # hold. Gold reads this rather than inferring the current state from past
    # extractions: a deleted highlight leaves no row here, and changed text has a
    # different hash, so stale evidence stops counting even when the new text has
    # not been extracted yet or failed permanently.
    all_candidates.select(
        "user_id", "book_id", "source_type", "source_id", "source_content_hash", "source_time"
    ).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(SOURCE_STATE)

    batch = previous_attempts(pending(all_candidates))
    if batch.isEmpty():
        _record_run(started, str(uuid.uuid4()), 0)
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
    # against its own candidate rather than failing every other one with it. The
    # struct it returns is (response, errorMessage), not (result, ...).
    answered = prompted.withColumn(
        "answer",
        F.expr(
            f"ai_query('{MODEL_ENDPOINT}', request, failOnError => false, "
            "modelParameters => named_struct('temperature', 0.0))"
        ),
    )

    parsed = (
        answered.withColumn("raw_response", F.col("answer.response").cast("string"))
        .withColumn("upstream_error", F.col("answer.errorMessage").cast("string"))
        .withColumn("parsed", validate_response(F.col("raw_response")))
        .select(
            "user_id",
            "book_id",
            *SOURCE_KEY,
            "source_time",
            "previous_attempts",
            "raw_response",
            "upstream_error",
            "parsed",
            # ai_query reports no token counts, so the response size is the only
            # per-row cost signal available. See the feedback log.
            F.length(F.col("raw_response")).alias("response_chars"),
        )
    )

    # Materialized before it is branched. `valid` and `failed` both read it, and
    # a frame that is not materialized would run the ai_query lineage once per branch:
    # paying twice, and writing rows from two different answers.
    parsed.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(STAGING)
    staged = spark.read.table(STAGING)

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
        F.lit(CANONICALIZATION_VERSION).alias("canonicalization_version"),
    ]
    trailer = [
        now.alias("extracted_at"),
        # The response is the provenance for a concept now attached to a reader.
        # It is model output about consented text, held under the same consent,
        # and never logged.
        F.col("raw_response"),
        (F.col("previous_attempts") + 1).alias("attempts"),
        F.col("response_chars"),
        F.lit(run_id).alias("run_id"),
    ]

    valid = (
        staged.filter(F.col("parsed.validation_status") == "valid")
        .withColumn("concept", F.explode("parsed.concepts"))
        .select(
            *common,
            F.col("concept.raw_concept").alias("raw_concept"),
            F.col("concept.canonical_concept").alias("canonical_concept"),
            F.col("concept.broader_concept").alias("broader_concept"),
            F.col("concept.confidence").alias("confidence"),
            F.lit("valid").alias("validation_status"),
            F.lit(None).cast("string").alias("validation_detail"),
            *trailer,
        )
    )

    failed = staged.filter(F.col("parsed.validation_status") != "valid").select(
        *common,
        F.lit(None).cast("string").alias("raw_concept"),
        F.lit(None).cast("string").alias("canonical_concept"),
        F.lit(None).cast("string").alias("broader_concept"),
        F.lit(None).cast("double").alias("confidence"),
        F.when(
            (F.col("previous_attempts") + 1) >= MAX_EXTRACTION_ATTEMPTS,
            F.lit("permanent_failure"),
        )
        .otherwise(F.col("parsed.validation_status"))
        .alias("validation_status"),
        F.coalesce(F.col("parsed.validation_detail"), F.col("upstream_error")).alias(
            "validation_detail"
        ),
        *trailer,
    )

    valid.unionByName(failed).write.mode("append").saveAsTable(EXTRACTIONS)
    _record_run(started, run_id, staged.count())


def _record_run(started, run_id, candidate_count):
    """
    Run-level telemetry. ai_query exposes no per-row token count or latency, so
    wall-clock latency and response size are what can honestly be recorded; the
    limitation is noted in the feedback log rather than papered over with an
    invented cost estimate.
    """
    finished = datetime.now(timezone.utc)
    try:
        by_status = {
            row["validation_status"]: row["count"]
            for row in spark.read.table(EXTRACTIONS)
            .filter(F.col("run_id") == run_id)
            .groupBy("validation_status")
            .count()
            .collect()
        }
    except Exception:
        by_status = {}

    spark.createDataFrame(
        [
            (
                run_id,
                MODEL_ENDPOINT,
                PROMPT_VERSION,
                CANONICALIZATION_VERSION,
                started,
                finished,
                int((finished - started).total_seconds() * 1000),
                int(candidate_count),
                json.dumps(by_status),
            )
        ],
        "run_id STRING, model_endpoint STRING, prompt_version STRING, "
        "canonicalization_version INT, started_at TIMESTAMP, finished_at TIMESTAMP, "
        "latency_ms BIGINT, candidate_count INT, rows_by_status STRING",
    ).write.mode("append").saveAsTable(RUNS)

    # Counts only. No raw text and no concept label reaches a log.
    print(
        json.dumps(
            {
                "run_id": run_id,
                "model_endpoint": MODEL_ENDPOINT,
                "prompt_version": PROMPT_VERSION,
                "canonicalization_version": CANONICALIZATION_VERSION,
                "latency_ms": int((finished - started).total_seconds() * 1000),
                "candidate_count": int(candidate_count),
                "rows_by_status": by_status,
            }
        )
    )


run()
