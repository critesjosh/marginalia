# Cloud deletion: remove one reader from every layer this bundle deployed.
#
# A job rather than a pipeline. Deletion is a request with a lifecycle, not a
# derivation, and it has to be able to report what it did to a browser that is
# polling for an answer.
#
# The manifest is versioned and names only tables this deployment actually has.
# A deletion that silently skipped a table it did not know about would report
# success it had not earned, so an unknown table is an error and a table that
# was never created is recorded as absent rather than assumed empty.

import json
import re
import sys
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.getActiveSession()


def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


CATALOG = _argument("catalog")
BRONZE = _argument("bronze_schema")
SILVER = _argument("silver_schema")
GOLD = _argument("gold_schema")
OPS = _argument("ops_schema")
# The Unity Catalog names of the Lakebase synced tables. Verification counts
# them because "removed from every queryable layer" includes the copy the
# browser actually reads, and a settled sync is a claim, not a check.
SERVED = [name.strip() for name in _argument("synced_tables", "").split(",") if name.strip()]
# Which half of the run this invocation is. The pipeline refreshes happen as job
# tasks in between, because a full refresh is the platform's operation and not
# something this script should reimplement with an SDK call and a poll loop.
STAGE = _argument("stage")
# Set only by the scheduled replay purge, which sweeps every active request
# rather than being handed one.
REQUEST_ID = _argument("request_id", "")

REQUESTS = f"{CATALOG}.{OPS}.deletion_requests"
AUDIT = f"{CATALOG}.{OPS}.deletion_audit"

MANIFEST_VERSION = "deletion_manifest_v1"

# Tables written directly, by the ingestion pipeline or by a job. Deleting the
# reader's rows here is what actually removes them: everything in the manifest's
# recomputed half is derived from these and cannot outlive them.
#
# Each entry is a table and the column naming the reader in it.
DELETED_TABLES = [
    (f"{CATALOG}.{BRONZE}.events_raw", "user_id"),
    (f"{CATALOG}.{SILVER}.concept_extractions", "user_id"),
    (f"{CATALOG}.{SILVER}.concept_source_state", "user_id"),
    (f"{CATALOG}.{SILVER}.concept_extraction_runs", None),
    # Overwritten each run rather than appended to, but what the last run left
    # behind persists indefinitely and holds the reader's id alongside the
    # model's answer about their text.
    (f"{CATALOG}.{SILVER}._concept_extraction_staging", "user_id"),
    (f"{CATALOG}.{SILVER}.book_work_matches", "user_id"),
    (f"{CATALOG}.{SILVER}.public_request_subjects", "user_id"),
]

# Materialized views. Nothing is deleted from them directly, because a full
# refresh of their pipeline recomputes them from sources the reader is already
# gone from. They are listed so verification checks them by name rather than by
# assuming the refresh worked.
RECOMPUTED_TABLES = [
    (f"{CATALOG}.{BRONZE}.ingestion_quarantine", "user_id"),
    (f"{CATALOG}.{SILVER}.events", "user_id"),
    (f"{CATALOG}.{SILVER}.event_conflicts", "user_id"),
    (f"{CATALOG}.{SILVER}.highlight_history", "user_id"),
    (f"{CATALOG}.{SILVER}.highlights_current", "user_id"),
    (f"{CATALOG}.{SILVER}.reading_sessions", "user_id"),
    (f"{CATALOG}.{GOLD}.book_engagement", "user_id"),
    (f"{CATALOG}.{GOLD}.reader_interest_profile", "user_id"),
    (f"{CATALOG}.{GOLD}.intellectual_frontier", "user_id"),
    (f"{CATALOG}.{GOLD}.recommendation_candidates", "user_id"),
]

# Public provider responses are not the reader's words, but the fact that a
# request was made on their behalf is. The response rows stay, since they
# describe published works and are shared between readers; the link that says
# this reader caused the request is what goes.
#
# research_works is deliberately absent from every list. It holds OpenAlex
# metadata about public research and names no reader at all.

# Every state except completed. A request that failed halfway has already had
# rows deleted out from under it, and dropping suppression there would let the
# topic replay the reader back into the tables the purge had emptied. It stays
# suppressed, and the nightly sweep picks it up again.
ACTIVE_STATUSES = ("accepted", "running", "purging_source", "failed")

# Both ids are server-stamped rather than browser-supplied, but they are still
# interpolated into SQL here, and an identifier that reaches a DELETE unchecked
# is exactly the mistake this job cannot afford to make once.
SAFE_ID = re.compile(r"^[A-Za-z0-9._:@-]{1,200}$")


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not SAFE_ID.match(value):
        raise SystemExit("refusing to run against an identifier that is not a plain id")
    return value


def _utc(value):
    """
    Spark hands back timestamps without a timezone. They are UTC by
    construction, but Python will not compare a naive datetime with an aware
    one, so the assumption has to be stated rather than left implicit.
    """
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _quoted(value: str) -> str:
    """A SQL string literal. Error text is arbitrary and often has quotes in it."""
    return "'" + str(value).replace("'", "''") + "'"


def ensure_tables():
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{OPS}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {REQUESTS} (
          request_id STRING NOT NULL,
          user_id STRING NOT NULL,
          status STRING NOT NULL,
          manifest_version STRING,
          requested_at TIMESTAMP NOT NULL,
          started_at TIMESTAMP,
          purged_at TIMESTAMP,
          completed_at TIMESTAMP,
          source_retention_until TIMESTAMP,
          error STRING
        ) USING DELTA
        """
    )
    # Only what a deletion has to be able to prove later. No titles, no
    # concepts, no text: an audit table that quoted the data it deleted would
    # be a copy of it.
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {AUDIT} (
          request_id STRING NOT NULL,
          user_id STRING NOT NULL,
          manifest_version STRING NOT NULL,
          stage STRING NOT NULL,
          recorded_at TIMESTAMP NOT NULL,
          table_counts STRING,
          status STRING NOT NULL,
          error STRING
        ) USING DELTA
        """
    )


def _exists(table: str) -> bool:
    return spark.catalog.tableExists(table)


def active_requests() -> list[dict]:
    """
    The requests this invocation is responsible for. A run handed a request id
    takes that one; the scheduled purge takes every request still working.
    """
    requests = spark.read.table(REQUESTS)
    if REQUEST_ID:
        requests = requests.filter(F.col("request_id") == REQUEST_ID)
    else:
        requests = requests.filter(F.col("status").isin(*ACTIVE_STATUSES))
    return [row.asDict() for row in requests.collect()]


def _set_status(request_id: str, status: str, **columns):
    request_id = _identifier(request_id)
    assignments = ", ".join(
        [f"status = '{status}'"]
        + [
            f"{name} = {'NULL' if value is None else value}"
            for name, value in columns.items()
        ]
    )
    spark.sql(
        f"UPDATE {REQUESTS} SET {assignments} WHERE request_id = '{request_id}'"
    )


def _record(request_id: str, user_id: str, stage: str, counts: dict, status: str, error=None):
    spark.createDataFrame(
        [
            (
                request_id,
                user_id,
                MANIFEST_VERSION,
                stage,
                datetime.now(timezone.utc),
                json.dumps(counts, sort_keys=True),
                status,
                error,
            )
        ],
        "request_id STRING, user_id STRING, manifest_version STRING, stage STRING, "
        "recorded_at TIMESTAMP, table_counts STRING, status STRING, error STRING",
    ).write.mode("append").saveAsTable(AUDIT)


def _remaining(table: str, column: str, user_id: str) -> int:
    if not _exists(table):
        # Absent, not empty. A table this deployment never created cannot hold
        # the reader, and saying "0 rows" would imply it was checked.
        return -1
    return (
        spark.read.table(table)
        .filter(F.col(column) == user_id)
        .limit(1)
        .count()
    )


def purge(user_id: str) -> dict:
    """
    Delete the reader from every directly written table. Idempotent: a rerun of
    a request that already finished this deletes nothing and reports zero.
    """
    user_id = _identifier(user_id)
    counts = {}
    for table, column in DELETED_TABLES:
        if column is None:
            # A run-level table with no reader column. Nothing to delete, and
            # recorded so the manifest reads as complete rather than partial.
            counts[table] = 0
            continue
        if not _exists(table):
            counts[table] = -1
            continue
        before = spark.read.table(table).filter(F.col(column) == user_id).count()
        spark.sql(f"DELETE FROM {table} WHERE {column} = '{user_id}'")
        counts[table] = before
    return counts


def verify(user_id: str) -> dict:
    """Every table in the manifest, counted rather than trusted."""
    remaining = {}
    served = [(table, "user_id") for table in SERVED]
    for table, column in DELETED_TABLES + RECOMPUTED_TABLES + served:
        if column is None:
            continue
        remaining[table] = _remaining(table, column, user_id)
    return remaining


def run_purge():
    """First stage: claim the request, delete, and leave the refreshes to run."""
    for request in active_requests():
        request_id, user_id = request["request_id"], request["user_id"]
        try:
            _set_status(request_id, "running", started_at="current_timestamp()")
            counts = purge(user_id)
            _record(request_id, user_id, "purge", counts, "running")
        except Exception as error:  # noqa: BLE001 - the reason has to reach the reader
            detail = f"{type(error).__name__}: {error}"[:500]
            _set_status(request_id, "failed", error=_quoted(detail))
            _record(request_id, user_id, "purge", {}, "failed", detail)
            raise


def run_verify():
    """
    Second stage, after the refreshes. A request is only complete once the
    reader is absent everywhere and the topic can no longer replay them.
    """
    for request in active_requests():
        request_id, user_id = request["request_id"], request["user_id"]
        try:
            remaining = verify(user_id)
            present = {table: count for table, count in remaining.items() if count > 0}
            if present:
                detail = f"rows remain in {sorted(present)}"
                _set_status(request_id, "failed", error=_quoted(detail))
                _record(request_id, user_id, "verify", remaining, "failed", detail)
                continue

            # Gone from every queryable layer, but the topic still holds up to
            # its retention window. Until that has passed a replay could put the
            # reader back, so the request is not finished, it is waiting.
            retention_until = _utc(request["source_retention_until"])
            retention_passed = (
                retention_until is not None and retention_until <= datetime.now(timezone.utc)
            )
            if retention_passed:
                _set_status(
                    request_id,
                    "completed",
                    completed_at="current_timestamp()",
                    manifest_version=_quoted(MANIFEST_VERSION),
                )
                _record(request_id, user_id, "verify", remaining, "completed")
            else:
                _set_status(
                    request_id,
                    "purging_source",
                    purged_at="current_timestamp()",
                    manifest_version=_quoted(MANIFEST_VERSION),
                )
                _record(request_id, user_id, "verify", remaining, "purging_source")
        except Exception as error:  # noqa: BLE001
            detail = f"{type(error).__name__}: {error}"[:500]
            _set_status(request_id, "failed", error=_quoted(detail))
            _record(request_id, user_id, "verify", {}, "failed", detail)
            raise


def run():
    ensure_tables()
    if STAGE == "purge":
        run_purge()
    elif STAGE == "verify":
        run_verify()
    else:
        raise SystemExit(f"unknown --stage={STAGE}")


run()
