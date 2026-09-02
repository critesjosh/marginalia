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

# What the platform calls a sync that has landed. Anything else is either still
# working or has failed, and neither is something to report as done.
SETTLED = {"ONLINE", "ONLINE_NO_PENDING_UPDATE"}
FAILED = {"OFFLINE_FAILED", "ONLINE_PIPELINE_FAILED", "OFFLINE"}


def state(name: str) -> str:
    table = workspace.database.get_synced_database_table(name=name)
    status = table.data_synchronization_status
    return str(getattr(status, "detailed_state", "") or "").upper()


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
