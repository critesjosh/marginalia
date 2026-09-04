"""
The table the Librarian retrieves from, and the Vector Search index over it.

A real Delta table rather than a materialized view, for a reason Phase 4 already
paid for once: a Delta Sync index reads its source's Change Data Feed, and a
materialized view accepts `delta.enableChangeDataFeed` and ignores it. A sync
over one fails rather than degrading.

What lands here is the reader's own consented text and nothing else. The rules
are the ones concept extraction already applies to the same tables, and are
repeated rather than imported because that job parses its arguments at import
time. A contract test holds the two source-type lists together, so the drift
that would matter, retrieving something extraction refuses to read, fails.

The one column that is here and not there is `progress`. It is the spoiler
position: a passage carries where in the book it was made, so retrieval can be
asked for nothing past where the reader has got to.
"""

import sys
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import Window
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
SILVER = _argument("silver_schema")
OPS = _argument("ops_schema")
INDEX = _argument("index_name", "")
INDEX_ENDPOINT = _argument("index_endpoint", "")
# Cloud deletion sets this. Everywhere else the sync is fire-and-forget, because
# the next thing to read the index is a person asking a question. Deletion is
# the exception: verification runs after this task, and an unfinished sync would
# let it confirm absence against an index that still held the reader.
WAIT_FOR_SYNC = _argument("wait_for_sync", "false").lower() == "true"
SYNC_TIMEOUT_SECONDS = int(_argument("sync_timeout_seconds", "1800"))
# How long to watch for a requested sync to become visible before deciding it
# had nothing to do. Bounded: an index with no changes never leaves the settled
# state, and waiting for it to would be waiting forever.
START_TIMEOUT_SECONDS = 120

PASSAGES = f"{CATALOG}.{SILVER}.librarian_passages"
HIGHLIGHTS_CURRENT = f"{CATALOG}.{SILVER}.highlights_current"
EVENTS = f"{CATALOG}.{SILVER}.events"
DELETION_REQUESTS = f"{CATALOG}.{OPS}.deletion_requests"

ACTIVE_DELETION_STATUSES = ("accepted", "running", "purging_source", "failed")

PRIVACY = "consentVersion INT, included ARRAY<STRING>"


def ensure_table():
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SILVER}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {PASSAGES} (
          passage_id STRING NOT NULL,
          user_id STRING NOT NULL,
          book_id STRING,
          chapter STRING,
          progress DOUBLE,
          source_type STRING,
          source_id STRING,
          content STRING,
          created_at TIMESTAMP,
          indexed_at TIMESTAMP
        )
        USING DELTA
        TBLPROPERTIES (delta.enableChangeDataFeed = true)
        """
    )


def _suppressed_readers():
    """
    Readers with a deletion in flight. The same suppression Silver applies, for
    the same reason: the topic can replay a deleted reader for as long as it
    retains them, and an index that re-learned them would be a copy of the
    reader in a system the purge does not reach by deleting a Delta row.
    """
    try:
        requests = spark.read.table(DELETION_REQUESTS)
    except Exception:  # noqa: BLE001 - no request has ever been made
        return None
    return requests.filter(F.col("status").isin(*ACTIVE_DELETION_STATUSES)).select("user_id").distinct()


def passages():
    highlights = spark.read.table(HIGHLIGHTS_CURRENT).withColumn(
        "privacy", F.from_json(F.col("privacy_json"), PRIVACY)
    )

    passage_rows = (
        highlights.filter(F.array_contains(F.col("privacy.included"), "highlightText"))
        .filter(F.col("text").isNotNull() & (F.length(F.trim(F.col("text"))) > 0))
        .select(
            "user_id",
            "book_id",
            "chapter",
            "progress",
            F.lit("highlight_passage").alias("source_type"),
            F.col("highlight_id").alias("source_id"),
            F.col("text").alias("content"),
            F.col("effective_event_time").alias("created_at"),
        )
    )

    note_rows = (
        highlights.filter(F.array_contains(F.col("privacy.included"), "highlightNotes"))
        .filter(F.col("note").isNotNull() & (F.length(F.trim(F.col("note"))) > 0))
        .select(
            "user_id",
            "book_id",
            "chapter",
            "progress",
            F.lit("highlight_note").alias("source_type"),
            F.concat_ws(":", F.col("highlight_id"), F.lit("note")).alias("source_id"),
            F.col("note").alias("content"),
            F.col("effective_event_time").alias("created_at"),
        )
    )

    events = spark.read.table(EVENTS).withColumn(
        "privacy", F.from_json(F.col("privacy_json"), PRIVACY)
    )

    question_rows = (
        events.filter(F.col("event_type") == "question_asked")
        .filter(F.array_contains(F.col("privacy.included"), "conversationText"))
        .withColumn("content", F.try_variant_get(F.col("payload"), "$.content", "string"))
        .filter(F.col("content").isNotNull() & (F.length(F.trim(F.col("content"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.try_variant_get(F.col("payload"), "$.chapter", "string").alias("chapter"),
            F.try_variant_get(F.col("payload"), "$.progress", "double").alias("progress"),
            F.lit("user_question").alias("source_type"),
            F.col("message_id").alias("source_id"),
            "content",
            F.col("effective_event_time").alias("created_at"),
        )
    )

    # A digest is rewritten in place, so only the newest one describes what the
    # reader currently has. Ranked before the consent filter, so an older shared
    # digest cannot outlive the redaction that replaced it.
    latest_memory = Window.partitionBy("user_id", "book_id").orderBy(
        F.col("effective_event_time").desc(), F.col("event_id").desc()
    )
    memory_rows = (
        events.filter(F.col("event_type") == "book_memory_updated")
        .withColumn("rank", F.row_number().over(latest_memory))
        .filter("rank = 1")
        .withColumn("summary", F.try_variant_get(F.col("payload"), "$.summary", "string"))
        .withColumn("cleared", F.try_variant_get(F.col("payload"), "$.cleared", "boolean"))
        .filter(~F.coalesce(F.col("cleared"), F.lit(False)))
        .filter(F.array_contains(F.col("privacy.included"), "bookMemory"))
        .filter(F.col("summary").isNotNull() & (F.length(F.trim(F.col("summary"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.lit(None).cast("string").alias("chapter"),
            # A digest is about the whole book, so it belongs at no position in
            # it. Null rather than zero: zero would be a claim that it describes
            # only the opening.
            F.lit(None).cast("double").alias("progress"),
            F.lit("book_memory").alias("source_type"),
            F.concat_ws(":", F.col("book_id"), F.lit("memory")).alias("source_id"),
            F.col("summary").alias("content"),
            F.col("effective_event_time").alias("created_at"),
        )
    )

    latest_added = Window.partitionBy("user_id", "book_id").orderBy(
        F.col("effective_event_time").desc(), F.col("event_id").desc()
    )
    description_rows = (
        events.filter(F.col("event_type") == "book_added")
        .withColumn("rank", F.row_number().over(latest_added))
        .filter("rank = 1")
        .filter(F.array_contains(F.col("privacy.included"), "bookMetadata"))
        .withColumn("description", F.try_variant_get(F.col("payload"), "$.description", "string"))
        .filter(F.col("description").isNotNull() & (F.length(F.trim(F.col("description"))) > 0))
        .select(
            "user_id",
            "book_id",
            F.lit(None).cast("string").alias("chapter"),
            F.lit(None).cast("double").alias("progress"),
            F.lit("book_description").alias("source_type"),
            F.concat_ws(":", F.col("book_id"), F.lit("description")).alias("source_id"),
            F.col("description").alias("content"),
            F.col("effective_event_time").alias("created_at"),
        )
    )

    deleted_books = (
        spark.read.table(EVENTS)
        .filter(F.col("event_type") == "book_deleted")
        .select("user_id", "book_id")
        .distinct()
    )

    combined = (
        passage_rows.unionByName(note_rows)
        .unionByName(question_rows)
        .unionByName(memory_rows)
        .unionByName(description_rows)
        .join(deleted_books, ["user_id", "book_id"], "left_anti")
    )

    suppressed = _suppressed_readers()
    if suppressed is not None:
        combined = combined.join(suppressed, ["user_id"], "left_anti")

    # Deterministic, so a rebuild produces the same ids and the index does not
    # churn every row on every run. Scoped by reader as well as source, because
    # a passage id is what an answer cites and two readers must never share one.
    return combined.withColumn(
        "passage_id",
        F.sha2(F.concat_ws("|", F.col("user_id"), F.col("source_type"), F.col("source_id")), 256),
    ).withColumn("indexed_at", F.lit(datetime.now(timezone.utc)))


def main() -> None:
    ensure_table()
    current = passages()

    # Replace rather than merge. The set is small, deriving it is cheap, and a
    # merge would need a delete branch for every way a passage can stop being
    # retrievable: consent revoked, note cleared, book deleted, reader deleted.
    # Each of those is a row that must vanish, and the failure mode of missing
    # one is an index that still holds text the reader withdrew.
    current.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(PASSAGES)

    total = spark.read.table(PASSAGES).count()
    readers = spark.read.table(PASSAGES).select("user_id").distinct().count()
    print(f"librarian passages: {total} across {readers} reader(s)")

    if INDEX and INDEX_ENDPOINT:
        _sync_index()


def _index_state(client) -> str:
    """
    The index's detailed state, read from the API rather than off the model.

    The SDK's index object returned an empty `detailed_state` on this runtime,
    which made a wait poll a blank string until it timed out with nothing to
    say. The REST response has the field.
    """
    response = client.api_client.do("GET", f"/api/2.0/vector-search/indexes/{INDEX}")
    return str((response.get("status") or {}).get("detailed_state") or "")


def _wait_until_it_starts(client, index_name_or_none=None) -> bool:
    """
    Wait for a requested sync to become visible, and say whether it did.

    The state does not change the instant a sync is asked for, so a wait
    beginning immediately can see the settled state from before it and return
    at once. A fixed sleep was the first answer and is a guess: it is right
    until the day the status lags eleven seconds. This watches for the state to
    leave settled instead, and gives up after a bounded wait rather than
    blocking, because a sync with nothing to do never leaves it.

    Returns True when a sync was seen to start. False means either that it had
    already finished or that there was nothing to sync, and the caller decides
    what that is worth.
    """
    import time

    from librarian import index_is_settled

    deadline = time.time() + START_TIMEOUT_SECONDS
    while time.time() < deadline:
        if not index_is_settled(_index_state(client)):
            return True
        time.sleep(5)
    return False


def _wait_until_settled(client, deadline: float, note: str) -> None:
    import time

    from librarian import index_is_settled

    seen = None
    while time.time() < deadline:
        state = _index_state(client)
        if not state:
            raise SystemExit(f"could not read the state of {INDEX}")
        if state != seen:
            seen = state
            print(f"index {INDEX} ({note}): {seen}")
        if index_is_settled(state):
            return
        time.sleep(10)
    raise SystemExit(f"{INDEX} did not settle within {SYNC_TIMEOUT_SECONDS}s")


def _sync_index() -> None:
    """
    Ask the index to catch up.

    A triggered Delta Sync index picks up the change feed on demand. Normally
    this does not block: the next thing to read the index is a person asking a
    question, and holding a job task open buys nothing. Under `--wait_for_sync`
    it does block, because the caller is cloud deletion and what comes next is
    a check that the reader is gone.
    """
    import time

    from databricks.sdk import WorkspaceClient

    client = WorkspaceClient()

    if WAIT_FOR_SYNC:
        # Before as well as after. Another sync may already be running, and
        # asking for a second is refused outright with "Index is not ready to
        # sync yet".
        _wait_until_settled(client, time.time() + SYNC_TIMEOUT_SECONDS, "before sync")

    try:
        client.vector_search_indexes.sync_index(index_name=INDEX)
        print(f"sync started for {INDEX}")
    except Exception as problem:  # noqa: BLE001
        # An index that does not exist yet is the first-deploy case and not a
        # reason to fail the run that just built its source.
        print(f"could not sync {INDEX}: {problem}")
        if WAIT_FOR_SYNC:
            raise SystemExit(f"deletion cannot verify an index it could not sync: {problem}") from problem
        return

    if not WAIT_FOR_SYNC:
        return

    # The state does not change the instant a sync is requested, so waiting for
    # settled straight away can see the state from before it and return at
    # once. For deletion that would mean confirming a reader's absence against
    # an index that still held them.
    started = _wait_until_it_starts(client)
    if not started:
        print(f"no sync became visible on {INDEX} within {START_TIMEOUT_SECONDS}s; it had nothing to apply")
    _wait_until_settled(client, time.time() + SYNC_TIMEOUT_SECONDS, "after sync")
    print(f"index {INDEX} settled after the deletion sync")


if __name__ == "__main__":
    main()
