# Refresh the Lakebase synced tables and wait for them to finish.
#
# Triggered synced tables do not refresh themselves. Whatever last wrote Gold
# has to say so, and has to wait: a deletion that reported success while the
# serving copy still held the reader would be reporting the wrong thing, and an
# Insights refresh that returned before the sync landed would serve yesterday.

import sys
import time

from databricks.sdk import WorkspaceClient

workspace = WorkspaceClient()


def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


TABLES = [name.strip() for name in _argument("synced_tables").split(",") if name.strip()]
TIMEOUT_SECONDS = int(_argument("sync_timeout_seconds", "900"))
POLL_SECONDS = 10

# The platform's own names, prefixed, exactly as the SDK enum spells them. The
# missing letter in SYNCED_TABLED_OFFLINE is the API's, not a typo here.
#
# ONLINE_NO_PENDING_UPDATE is the only state that means the update this run
# triggered has landed. Plain ONLINE means a copy is servable, which a stale one
# also is, so treating it as settled would let a run return before its own
# update was applied.
SETTLED = {"SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE"}
FAILED = {
    "SYNCED_TABLE_OFFLINE_FAILED",
    "SYNCED_TABLE_ONLINE_PIPELINE_FAILED",
    "SYNCED_TABLED_OFFLINE",
}


def state(name: str) -> str:
    table = workspace.database.get_synced_database_table(name=name)
    status = table.data_synchronization_status
    detailed = getattr(status, "detailed_state", None)
    # An enum, whose str() is "SyncedTableState.SYNCED_TABLE_ONLINE" and whose
    # value is the name the API actually uses.
    return str(getattr(detailed, "value", detailed) or "").upper()


def trigger(name: str) -> str:
    table = workspace.database.get_synced_database_table(name=name)
    pipeline_id = table.data_synchronization_status.pipeline_id
    if not pipeline_id:
        raise SystemExit(f"{name} has no sync pipeline to trigger")
    workspace.pipelines.start_update(pipeline_id=pipeline_id)
    return pipeline_id


def run():
    for name in TABLES:
        trigger(name)

    deadline = time.time() + TIMEOUT_SECONDS
    pending = list(TABLES)
    while pending and time.time() < deadline:
        time.sleep(POLL_SECONDS)
        still_pending = []
        for name in pending:
            current = state(name)
            if current in FAILED:
                raise SystemExit(f"{name} sync ended in {current}")
            if current not in SETTLED:
                still_pending.append(name)
        pending = still_pending

    if pending:
        # A timeout is a failure, not a warning to move past. The task after
        # this one verifies absence, and it must not run against a stale copy.
        raise SystemExit(f"sync did not settle within {TIMEOUT_SECONDS}s: {sorted(pending)}")


run()
