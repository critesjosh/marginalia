"""
The Librarian evaluated against the deployed endpoint, on passages nobody wrote.

The contract tests already check every rule with the model held constant. This
checks the things a constant cannot: whether real retrieval honours the reader
filter and the spoiler position, and whether a real model obeys a note that
tells it to.

It runs on synthetic readers. The fixture passages are inserted under two ids
that belong to nobody, the index is synced, the deployed endpoint is asked the
fixture questions, and the synthetic readers are removed again in a finally
block. No reader's own words are involved at any point, which is also the Phase
8 preflight requirement: a synthetic agent traced and queried without private
reader data.

What it writes is aggregate. `librarian_evaluations` has no reader column at
all, because there is no reader in it, and a table with no reader column is one
the Observatory can show without a per-reader filter that would mean nothing.
"""

import json
import pathlib
import sys
import time
from datetime import datetime, timezone

from pyspark.sql import SparkSession

import librarian
from librarian import PROMPT_VERSION, evaluate_case, index_is_settled, summarize

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
INDEX = _argument("index_name")
ENDPOINT = _argument("serving_endpoint")
CASES_PATH = _argument("cases", "")
# The gate. A task that always runs and exits immediately costs one serverless
# start; a condition task would have cost the ability to run this without a
# deploy, because its outcome cannot be combined with ALL_DONE.
EVALUATE = _argument("evaluate", "true").lower() == "true"
# The experiment the endpoint traces to, so this run can delete the traces it
# caused by the same tag cloud deletion uses.
EXPERIMENT = _argument("experiment", "")

PASSAGES = f"{CATALOG}.{SILVER}.librarian_passages"
RESULTS = f"{CATALOG}.{OPS}.librarian_evaluations"

# How long to wait for the index to catch up with the seeded rows. A sync that
# has not finished is an evaluation of an empty index, which would pass every
# blocking check by retrieving nothing.
#
# Generous because a triggered sync on a cold pipeline is minutes, not seconds,
# and a timeout here fails a run that would have passed.
SYNC_TIMEOUT_SECONDS = 1800
# See librarian_passages.py: bounded, because an index with nothing to sync
# never leaves the settled state.
START_TIMEOUT_SECONDS = 120


def _cases() -> dict:
    """
    The fixtures, found by walking up from the module's own location.

    `librarian.__file__` rather than `__file__`: a serverless Python task
    executes this script without setting the latter, so reading it raises
    NameError before the job does anything. An imported module has one.
    """
    if CASES_PATH:
        return json.loads(pathlib.Path(CASES_PATH).read_text())
    here = pathlib.Path(librarian.__file__).resolve()
    for parent in here.parents:
        candidate = parent / "contracts/fixtures/librarian-phase-8.json"
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise SystemExit("could not find the Librarian evaluation cases")


# The columns, declared once, so creating the table and reconciling an existing
# one cannot disagree about them.
RESULT_COLUMNS = (
    ("run_id", "STRING NOT NULL"),
    ("evaluated_at", "TIMESTAMP NOT NULL"),
    ("prompt_version", "STRING"),
    ("serving_endpoint", "STRING"),
    ("case_id", "STRING"),
    ("cross_reader_evidence", "BIGINT"),
    ("spoiler_violations", "BIGINT"),
    ("citation_errors", "BIGINT"),
    ("unsupported_answers", "BIGINT"),
    ("injection_failures", "BIGINT"),
    ("retrieval_recall", "DOUBLE"),
    ("latency_ms", "BIGINT"),
    ("total_tokens", "BIGINT"),
    ("problems", "ARRAY<STRING>"),
    ("passed", "BOOLEAN"),
)


def ensure_results_table():
    """
    Create the table, and add any column it has since grown.

    `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
    so a column added here never reaches one, and the writer below builds its
    rows from the live schema and drops the value silently. `total_tokens` was
    written for a run and stored nowhere, which is the quietest way for a
    measurement to go missing.
    """
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{OPS}")
    columns = ",\n          ".join(f"{name} {kind}" for name, kind in RESULT_COLUMNS)
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {RESULTS} (
          {columns}
        )
        USING DELTA
        COMMENT 'Librarian evaluation runs over synthetic readers. Holds no reader data and no reader id.'
        """
    )

    existing = {field.name for field in spark.read.table(RESULTS).schema.fields}
    # NOT NULL is dropped when adding to an existing table: Delta cannot add a
    # non-nullable column to rows that already exist without a default.
    missing = [(name, kind.replace(" NOT NULL", "")) for name, kind in RESULT_COLUMNS if name not in existing]
    if missing:
        added = ", ".join(f"{name} {kind}" for name, kind in missing)
        spark.sql(f"ALTER TABLE {RESULTS} ADD COLUMNS ({added})")
        print(f"added {len(missing)} column(s) to {RESULTS}: {[name for name, _ in missing]}")


def _tuples(records: list[dict], schema):
    """
    Rows in the schema's own field order.

    A list of dicts is accepted by createDataFrame and matched by key, which is
    fine until a column is added in the middle and the mismatch shows up as a
    type error three fields later. Ordering explicitly makes the schema the one
    source of order.
    """
    return [tuple(record.get(field.name) for field in schema.fields) for record in records]


def seed(fixtures: dict) -> None:
    now = datetime.now(timezone.utc)
    records = [
        {
            "passage_id": passage["passage_id"],
            "user_id": passage["user_id"],
            "book_id": passage["book_id"],
            "chapter": passage.get("chapter"),
            "progress": passage.get("progress"),
            "source_type": passage["source_type"],
            "source_id": passage["source_id"],
            "content": passage["content"],
            "created_at": now,
            "indexed_at": now,
        }
        for passage in fixtures["passages"]
    ]
    schema = spark.read.table(PASSAGES).schema
    spark.createDataFrame(_tuples(records, schema), schema=schema).write.mode("append").saveAsTable(PASSAGES)
    print(f"seeded {len(records)} synthetic passage(s)")


def remove_synthetic(fixtures: dict) -> None:
    readers = sorted(set(fixtures["readers"].values()))
    quoted = ", ".join(f"'{reader}'" for reader in readers)
    spark.sql(f"DELETE FROM {PASSAGES} WHERE user_id IN ({quoted})")
    print(f"removed {len(readers)} synthetic reader(s) from {PASSAGES}")
    _remove_synthetic_traces(readers)


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


def _remove_synthetic_traces(readers: list[str]) -> None:
    """
    The traces this run produced, deleted by the same tag cloud deletion uses.

    They hold fixture text and no reader's words, so leaving them would harm
    nobody; deleting them is worth doing anyway, because it exercises the exact
    path a deletion request depends on. A tag that stopped being written, or a
    filter that stopped matching, shows up here on the next evaluation rather
    than in the middle of somebody's deletion.
    """
    if not EXPERIMENT:
        print("no experiment configured, so no traces to remove")
        return
    try:
        import mlflow
        from mlflow.tracking import MlflowClient
    except ImportError:
        print("mlflow is unavailable here, so synthetic traces were left in place")
        return

    client = MlflowClient()
    experiment = client.get_experiment_by_name(EXPERIMENT)
    if experiment is None:
        print(f"{EXPERIMENT} does not exist, so there are no traces to remove")
        return

    for reader in readers:
        removed = 0
        while True:
            traces = mlflow.search_traces(
                experiment_ids=[experiment.experiment_id],
                filter_string=f"tags.`marginalia.user_id` = '{reader}'",
                max_results=200,
                return_type="list",
            )
            if not traces:
                break
            identifiers = [trace.info.trace_id for trace in traces]
            _delete_traces(client, experiment.experiment_id, identifiers)
            removed += len(identifiers)
            if len(identifiers) < 200:
                break
        print(f"removed {removed} trace(s) for synthetic reader {reader}")


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
    seen = None
    while time.time() < deadline:
        state = _index_state(client, INDEX)
        if not state:
            # Unreadable rather than not-yet-settled. Waiting half an hour to
            # report that would be waiting for something that is not coming.
            raise SystemExit(f"could not read the state of {INDEX}")
        if state != seen:
            seen = state
            print(f"index {INDEX} ({note}): {seen}")
        if index_is_settled(state):
            return
        time.sleep(10)
    raise SystemExit(f"{INDEX} did not settle within {SYNC_TIMEOUT_SECONDS}s")


def sync_index(client) -> None:
    """
    Get the seeded passages into the index, and be sure they arrived.

    Waits before triggering as well as after. The passage build that runs
    ahead of this starts a sync of its own, and asking for another while one is
    running is refused outright: "Index is not ready to sync yet. Pipeline is
    in state WAITING_FOR_RESOURCES". So the first wait is for somebody else's
    sync, and the second is for this one.
    """
    deadline = time.time() + SYNC_TIMEOUT_SECONDS
    _wait_until_settled(client, deadline, "before sync")
    client.vector_search_indexes.sync_index(index_name=INDEX)
    if not _wait_until_it_starts(client):
        print(f"no sync became visible within {START_TIMEOUT_SECONDS}s; the seeded rows may already be indexed")
    _wait_until_settled(client, deadline, "after sync")


def _index_state(client, index_name: str = "") -> str:
    """
    The index's detailed state, read from the API rather than off the model.

    The SDK's index object returned an empty `detailed_state` on this runtime,
    which made the wait below poll a blank string until it timed out with
    nothing to say. The REST response has the field; reading it directly is one
    fewer thing that can silently be absent.
    """
    response = client.api_client.do("GET", f"/api/2.0/vector-search/indexes/{index_name or INDEX}")
    return str((response.get("status") or {}).get("detailed_state") or "")


def ask(client, case: dict) -> tuple[dict, float]:
    started = time.time()
    response = client.serving_endpoints.query(
        name=ENDPOINT,
        dataframe_records=[
            {
                "question": case["question"],
                "user_id": case["user_id"],
                "book_id": case.get("book_id"),
                # 1.0 where the case names no position: the request contract
                # requires one, and the whole book has to be asked for rather
                # than fallen into.
                "spoiler_progress": case.get("spoiler_progress") if case.get("spoiler_progress") is not None else 1.0,
                "k": 8,
                # The evaluation is the caller that needs it: an injection that
                # lands in a declined reply's prose has landed, and the prose
                # is otherwise not returned.
                "include_model_note": True,
            }
        ],
    )
    latency_ms = (time.time() - started) * 1000
    predictions = response.predictions or []
    if not predictions:
        return {"error": "the endpoint returned nothing"}, latency_ms
    # One JSON string per request: the reply has two shapes and the signature
    # names one string column rather than being wrong about one of them.
    reply = predictions[0]
    if isinstance(reply, str):
        try:
            reply = json.loads(reply)
        except json.JSONDecodeError:
            return {"error": f"the endpoint returned something that is not JSON: {reply[:200]}"}, latency_ms
    return reply, latency_ms


def main() -> None:
    if not EVALUATE:
        print("evaluate=false: not seeding, not syncing, not asking the model")
        return

    from databricks.sdk import WorkspaceClient

    fixtures = _cases()
    ensure_results_table()
    client = WorkspaceClient()

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results, latencies, rows = [], [], []

    try:
        seed(fixtures)
        sync_index(client)

        for case in fixtures["cases"]:
            answered, latency_ms = ask(client, case)
            latencies.append(latency_ms)

            # Scored against what was retrieved, not against what was cited. A
            # spoiler that reached the prompt and was then not mentioned has
            # still been shown to a model, and an answer reporting only its own
            # citations would hide the exact failure the rule exists to catch.
            #
            # The passages themselves come from the fixture rather than from the
            # reply: an answer that reported its own evidence as compliant would
            # be marking its own work.
            by_id = {passage["passage_id"]: passage for passage in fixtures["passages"]}
            # An id the fixture does not know belongs to a real reader, because
            # the index holds their passages alongside the seeded ones. Dropping
            # it would have made the one leak this evaluation exists to catch
            # score as zero cross-reader evidence. It is carried through as a
            # passage belonging to nobody in this run, which is exactly what
            # evaluate_case counts.
            # What reached the prompt, and what the agent's second filter took
            # out on the way. The dropped ones are what the index actually
            # returned in defiance of its filters, and scoring only the
            # survivors would report a leak the filter caught as no leak at all.
            reached = list(answered.get("retrieved_ids", []))
            dropped = list(answered.get("dropped_by_the_second_filter", []))
            retrieved = [
                by_id.get(identifier, {"passage_id": identifier, "user_id": "__not_in_the_fixture__"})
                for identifier in reached + dropped
            ]
            # `answerable` travels too. Without it the scorer defaults to
            # answerable and marks an honest "nothing here answers that" as an
            # unsupported answer, which is a blocking defect and would fail a
            # run for doing the right thing.
            parsed = (
                {
                    "answer": answered["answer"],
                    "answerable": answered.get("answerable", True),
                    # The prose of a declined reply. It never reaches the reader,
                    # but the model produced it, and an injection landing there
                    # has landed; dropping it here hid that from the scoring.
                    "model_note": answered.get("model_note"),
                    "claims": answered.get("claims", []),
                }
                if "answer" in answered
                else {"error": answered.get("error", "no answer")}
            )

            scored = evaluate_case(case, retrieved, parsed)
            results.append(scored)
            rows.append(
                {
                    "run_id": run_id,
                    "evaluated_at": datetime.now(timezone.utc),
                    "prompt_version": PROMPT_VERSION,
                    "serving_endpoint": ENDPOINT,
                    "case_id": scored["case_id"],
                    "cross_reader_evidence": scored["cross_reader_evidence"],
                    "spoiler_violations": scored["spoiler_violations"],
                    "citation_errors": scored["citation_errors"],
                    "unsupported_answers": scored["unsupported_answers"],
                    "injection_failures": scored["injection_failures"],
                    "retrieval_recall": float(scored["retrieval_recall"]),
                    "latency_ms": int(latency_ms),
                    # None when no model was called, which the refusal case is
                    # meant to do. Zero would claim it called one for free.
                    "total_tokens": (answered.get("usage") or {}).get("total_tokens"),
                    "problems": scored["problems"],
                    "passed": not scored["problems"],
                }
            )
            print(f"  {scored['case_id']:50} {'pass' if not scored['problems'] else scored['problems']}")
    finally:
        # Whatever happened, the synthetic readers do not stay in a table the
        # index syncs from.
        remove_synthetic(fixtures)
        try:
            client.vector_search_indexes.sync_index(index_name=INDEX)
        except Exception as problem:  # noqa: BLE001
            print(f"could not resync after cleanup: {problem}")

    if rows:
        schema = spark.read.table(RESULTS).schema
        spark.createDataFrame(_tuples(rows, schema), schema=schema).write.mode("append").saveAsTable(RESULTS)

    summary = summarize(results, latencies, [row["total_tokens"] for row in rows])
    print(json.dumps({key: value for key, value in summary.items() if key != "failures"}, indent=2, default=str))
    for failure in summary["failures"]:
        print(f"FAIL {failure}")
    if not summary["passed"]:
        raise SystemExit(f"librarian evaluation failed: {len(summary['failures'])} threshold(s) breached")


if __name__ == "__main__":
    main()
