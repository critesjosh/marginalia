# Cloud deletion: remove one reader from every layer this bundle deployed,
# except the record of the deletion itself.
#
# deletion_requests and deletion_audit keep the trusted user id after the reader
# is gone from everything else. That is the plan's instruction rather than an
# oversight: a request whose subject had been erased could not be looked up by
# the browser polling it, could not be swept again by the replay purge, and
# could not answer "was this reader deleted, and when" afterwards. They hold an
# id, timestamps, a status, and counts, and no reading, so they are named here
# rather than in a manifest that claims to empty them.
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
# The experiment holding the Librarian's traces. Empty when Phase 8 is not
# deployed, which the trace stage records as absent rather than as zero.
LIBRARIAN_EXPERIMENT = _argument("librarian_experiment", "")
# The Vector Search index the Librarian retrieves from. Verified directly
# rather than inferred from a sync having been asked for: a sync is a request,
# and the question deletion has to answer is whether the reader is still in
# there.
LIBRARIAN_INDEX = _argument("librarian_index", "")
# Set only by the scheduled replay purge, which sweeps every active request
# rather than being handed one.
REQUEST_ID = _argument("request_id", "")

REQUESTS = f"{CATALOG}.{OPS}.deletion_requests"
AUDIT = f"{CATALOG}.{OPS}.deletion_audit"

# v2 added reader_principals; v3 everything the Librarian holds; v4 the
# recommendation outcomes and the readiness assessments computed from them; v5
# the MCP audit. The
# version is recorded on every request, so a request completed under v1 is a
# claim about the tables v1 knew about and nothing more; bumping it is what
# keeps that readable later.
MANIFEST_VERSION = "deletion_manifest_v5"

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
    # Which workspace principals were vouched for as this reader. Not their
    # words, but a record that names them, and one that would otherwise outlive
    # every table it points at.
    (f"{CATALOG}.{OPS}.reader_principals", "user_id"),
    # What the Librarian retrieves from. Deleting the rows is what empties the
    # Vector Search index, which has no delete of its own: it syncs from this
    # table, so the sync after the purge is the deletion, and it is a task in
    # the job rather than a hope.
    (f"{CATALOG}.{SILVER}.librarian_passages", "user_id"),
    # Assessments of whether enough feedback exists to train on. Counts rather
    # than reading, but a row can name the reader it counted, and a count of a
    # deleted reader's behaviour is still a record of it.
    (f"{CATALOG}.{OPS}.recommender_readiness", "user_id"),
    # One row per MCP tool call. It holds no rows and no reading, but it names
    # the reader whose profile was read and when, which is a record of them.
    (f"{CATALOG}.{OPS}.mcp_audit", "user_id"),
]

# marginalia_ops.librarian_evaluations is in neither list and is not an
# omission. It records how the agent scored against synthetic readers, has no
# reader column, and holds nothing anybody wrote.
#
# MLflow traces are a store this manifest cannot express as a table, and they
# hold the passages the model was shown. They are deleted by their own stage,
# by the marginalia.user_id tag the agent stamps on every trace.
#
# The Librarian's serving endpoint holds no reader state to delete. It keeps no
# cache and no history: every request retrieves afresh from the index, and the
# index is emptied by emptying librarian_passages. The model version behind it
# is code and a prompt. Named here because "every Model Serving state" is on
# the phase's list, and an absence nobody wrote down reads as an oversight.

# The per-reader views in the scoped schema are deliberately in neither list.
# They select through current_user(), and this job runs as a principal no
# mapping names, so a count against them returns zero for every reader whether
# deleted or not. Verifying there would be a check that cannot fail, which is
# worse than no check: it would report absence it never established. The views
# hold no rows of their own, and the tables beneath them are verified above.

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
    (f"{CATALOG}.{SILVER}.recommendation_outcomes", "user_id"),
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


def _delete_traces(client, experiment_id: str, identifiers: list[str]) -> None:
    """
    Delete traces through the client, with the keyword this MLflow calls them by.

    There is no module-level `mlflow.delete_traces`; reaching for one raises
    AttributeError, which the evaluation found before a deletion request did.
    The client method exists, and its parameter has been `request_ids` and
    `trace_ids` in different versions, so it is chosen by looking rather than by
    guessing.
    """
    import inspect

    parameters = inspect.signature(client.delete_traces).parameters
    keyword = "trace_ids" if "trace_ids" in parameters else "request_ids"
    client.delete_traces(experiment_id=experiment_id, **{keyword: identifiers})


def remaining_in_index(user_id: str) -> int:
    """
    How many of this reader's passages the index still returns. -1 when there
    is no index to ask.

    Asked of the index itself, not of the table it syncs from. The table is
    where the delete happened; the index is what an answer would be built from,
    and the gap between them is a sync whose timing this job does not control.
    """
    if not LIBRARIAN_INDEX:
        return -1
    try:
        from databricks.sdk import WorkspaceClient
    except ImportError:
        return -1

    client = WorkspaceClient()
    try:
        response = client.api_client.do(
            "POST",
            f"/api/2.0/vector-search/indexes/{LIBRARIAN_INDEX}/query",
            body={
                "columns": ["passage_id"],
                "filters_json": json.dumps({"user_id": user_id}),
                # One is enough to fail on, and asking for one keeps this cheap.
                "num_results": 1,
                "query_text": user_id,
            },
        )
    except Exception as error:  # noqa: BLE001 - an unreachable index is not an absent reader
        raise SystemExit(f"could not ask {LIBRARIAN_INDEX} whether the reader is gone: {error}") from error

    rows = ((response.get("result") or {}).get("data_array")) or []
    return len(rows)


def purge_traces(user_id: str) -> int:
    """
    Every MLflow trace belonging to this reader.

    A trace holds the retrieved passages and the prompt built from them, which
    is the reader's own text in a store no DELETE reaches. The agent tags each
    trace with the reader it answered for, and that tag is the only handle
    there is; an untagged trace would be undeletable text, which is why the
    contract test insists the tag is written.

    Returns -1 when the experiment does not exist, matching how an absent table
    is recorded: never created is not the same as checked and empty.
    """
    if not LIBRARIAN_EXPERIMENT:
        return -1
    try:
        import mlflow
        from mlflow.tracking import MlflowClient
    except ImportError:
        return -1

    client = MlflowClient()
    experiment = client.get_experiment_by_name(LIBRARIAN_EXPERIMENT)
    if experiment is None:
        return -1

    deleted = 0
    while True:
        traces = mlflow.search_traces(
            experiment_ids=[experiment.experiment_id],
            filter_string=f"tags.`marginalia.user_id` = '{user_id}'",
            max_results=200,
            return_type="list",
        )
        if not traces:
            return deleted
        identifiers = [trace.info.trace_id for trace in traces]
        _delete_traces(client, experiment.experiment_id, identifiers)
        deleted += len(identifiers)
        if len(identifiers) < 200:
            return deleted


def run_purge():
    """First stage: claim the request, delete, and leave the refreshes to run."""
    for request in active_requests():
        request_id, user_id = request["request_id"], request["user_id"]
        try:
            _set_status(request_id, "running", started_at="current_timestamp()")
            counts = purge(user_id)
            counts["mlflow_traces"] = purge_traces(user_id)
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
            remaining["mlflow_traces"] = purge_traces(user_id)
            remaining[LIBRARIAN_INDEX or "librarian_index"] = remaining_in_index(user_id)
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
