"""
The Databricks App the Cloudflare Worker calls.

It is the only thing outside the workspace that can read a reader's profile, and
it is deliberately small: four routes, read-only Postgres queries against the
synced tables, and one write that creates a deletion request.

The reader's id is in the path because the Worker puts it there from its own
secret. The App still checks who is calling, because a route that trusts its
path parameter is a route that will serve anybody's profile to anybody who can
reach it.
"""

import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
from databricks import sql as dbsql
from databricks.sdk import WorkspaceClient
from databricks.sdk.core import Config
from fastapi import FastAPI, HTTPException, Path, Request
from psycopg.rows import dict_row
from pydantic import BaseModel

app = FastAPI(title="Marginalia intelligence")

PG_SCHEMA = os.environ.get("MARGINALIA_PG_SCHEMA", "marginalia_gold")
INSTANCE_NAME = os.environ.get("MARGINALIA_LAKEBASE_INSTANCE", "")
# The service principal the Worker authenticates as. Workspace authorization
# already gates the App, but this is what makes "only the trusted caller" a
# property of the App rather than of somebody's memory of a permissions page.
TRUSTED_CALLER = os.environ.get("MARGINALIA_TRUSTED_CALLER", "")
WAREHOUSE_HTTP_PATH = os.environ.get("MARGINALIA_WAREHOUSE_HTTP_PATH", "")
OPS_TABLE = os.environ.get("MARGINALIA_DELETION_TABLE", "")
# Kafka keeps delivered records for this long, so a deletion is not finished
# until the window has passed and a replay can no longer restore the reader.
SOURCE_RETENTION_DAYS = int(os.environ.get("MARGINALIA_SOURCE_RETENTION_DAYS", "7"))

UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE
)

workspace = WorkspaceClient()

_credential: dict = {"token": None, "expires_at": 0.0}


def database_password() -> str:
    """
    Lakebase takes a short-lived OAuth token as the Postgres password. Cached
    until shortly before it expires, because minting one per request would put a
    control-plane call in front of every read.
    """
    if os.environ.get("PGPASSWORD"):
        return os.environ["PGPASSWORD"]

    now = time.time()
    if _credential["token"] and _credential["expires_at"] - 60 > now:
        return _credential["token"]

    generated = workspace.database.generate_database_credential(
        request_id=str(uuid.uuid4()), instance_names=[INSTANCE_NAME]
    )
    expires_at = now + 3000
    if generated.expiration_time:
        expires_at = datetime.fromisoformat(
            str(generated.expiration_time).replace("Z", "+00:00")
        ).timestamp()
    _credential.update({"token": generated.token, "expires_at": expires_at})
    return generated.token


def connection() -> psycopg.Connection:
    return psycopg.connect(
        host=os.environ["PGHOST"],
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ["PGDATABASE"],
        user=os.environ["PGUSER"],
        password=database_password(),
        sslmode=os.environ.get("PGSSLMODE", "require"),
        row_factory=dict_row,
        connect_timeout=10,
    )


def authorize(request: Request, user_id: str) -> str:
    """
    Two checks, and the second is the one that matters. The platform decides
    whether the caller may reach the App at all; this decides whether the caller
    is the one identity allowed to ask about a reader.
    """
    if not TRUSTED_CALLER:
        # Refusing is the only safe reading of a missing configuration. Serving
        # a profile because nobody said who was allowed to read it is precisely
        # the failure this check exists to prevent.
        raise HTTPException(status_code=503, detail="caller_not_configured")

    caller = (
        request.headers.get("x-forwarded-preferred-username")
        or request.headers.get("x-forwarded-email")
        or ""
    )
    if caller != TRUSTED_CALLER:
        raise HTTPException(status_code=403, detail="untrusted_caller")

    if not user_id:
        raise HTTPException(status_code=400, detail="missing_user")
    return user_id


def source_updated_at(rows: list[dict]) -> str | None:
    stamps = [row.pop("computed_at", None) for row in rows]
    newest = max((stamp for stamp in stamps if stamp is not None), default=None)
    return newest.astimezone(timezone.utc).isoformat() if newest else None


@app.get("/api/v1/users/{user_id}/interest-profile")
def interest_profile(request: Request, user_id: str = Path(...)):
    authorize(request, user_id)
    with connection() as pg, pg.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT concept_id, interest_score, evidence_count, distinct_books,
                   last_evidence_at, computed_at
            FROM {PG_SCHEMA}.reader_interest_profile
            WHERE user_id = %s
            ORDER BY interest_score DESC, concept_id
            LIMIT 500
            """,
            (user_id,),
        )
        rows = cursor.fetchall()

    updated = source_updated_at(rows)
    return {
        "rows": [
            {
                "conceptId": row["concept_id"],
                "interestScore": float(row["interest_score"] or 0.0),
                "evidenceCount": int(row["evidence_count"] or 0),
                "distinctBooks": int(row["distinct_books"] or 0),
                **(
                    {"lastEvidenceAt": row["last_evidence_at"].astimezone(timezone.utc).isoformat()}
                    if row["last_evidence_at"]
                    else {}
                ),
            }
            for row in rows
        ],
        **({"sourceUpdatedAt": updated} if updated else {}),
    }


@app.get("/api/v1/users/{user_id}/book-engagement")
def book_engagement(request: Request, user_id: str = Path(...)):
    authorize(request, user_id)
    with connection() as pg, pg.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT book_id, active_minutes, session_count, maximum_progress,
                   current_highlights, questions, completed, engagement_score,
                   computed_at
            FROM {PG_SCHEMA}.book_engagement
            WHERE user_id = %s
            ORDER BY engagement_score DESC, book_id
            LIMIT 500
            """,
            (user_id,),
        )
        rows = cursor.fetchall()

    updated = source_updated_at(rows)
    return {
        "rows": [
            {
                "bookId": row["book_id"],
                "activeMinutes": float(row["active_minutes"] or 0.0),
                "sessionCount": int(row["session_count"] or 0),
                "maximumProgress": float(row["maximum_progress"] or 0.0),
                "currentHighlights": int(row["current_highlights"] or 0),
                "questions": int(row["questions"] or 0),
                "completed": bool(row["completed"]),
                "engagementScore": float(row["engagement_score"] or 0.0),
            }
            for row in rows
        ],
        **({"sourceUpdatedAt": updated} if updated else {}),
    }


class DeletionRequestBody(BaseModel):
    requestId: str


def warehouse():
    config = Config()
    return dbsql.connect(
        server_hostname=config.host.replace("https://", ""),
        http_path=WAREHOUSE_HTTP_PATH,
        credentials_provider=lambda: config.authenticate,
    )


# The browser's four statuses. purging_source is a real state of the job and not
# one the reader has a decision to make about: their data is out of every table
# that can be queried and the source topic is aging out.
BROWSER_STATUS = {
    "accepted": "accepted",
    "running": "running",
    "purging_source": "running",
    "completed": "completed",
    "failed": "failed",
}


@app.post("/api/v1/users/{user_id}/deletion-requests")
def create_deletion_request(
    request: Request, body: DeletionRequestBody, user_id: str = Path(...)
):
    authorize(request, user_id)
    if not UUID_PATTERN.match(body.requestId):
        raise HTTPException(status_code=400, detail="invalid_request_id")
    if not WAREHOUSE_HTTP_PATH or not OPS_TABLE:
        raise HTTPException(status_code=503, detail="deletion_not_configured")

    retention_until = datetime.now(timezone.utc) + timedelta(days=SOURCE_RETENTION_DAYS)
    with warehouse() as connection_, connection_.cursor() as cursor:
        # Idempotent by request id. The browser owns that id and retries with
        # the same one, so a retry after a timeout must find its own request
        # rather than open a second deletion of the same reader.
        cursor.execute(
            f"""
            MERGE INTO {OPS_TABLE} AS target
            USING (SELECT ? AS request_id, ? AS user_id, ? AS source_retention_until) AS source
            ON target.request_id = source.request_id
            WHEN NOT MATCHED THEN INSERT (
              request_id, user_id, status, requested_at, source_retention_until
            ) VALUES (
              source.request_id, source.user_id, 'accepted', current_timestamp(),
              source.source_retention_until
            )
            """,
            [body.requestId, user_id, retention_until],
        )
        cursor.execute(
            f"SELECT status FROM {OPS_TABLE} WHERE request_id = ? AND user_id = ?",
            [body.requestId, user_id],
        )
        row = cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=503, detail="deletion_not_recorded")
    return {"requestId": body.requestId, "status": BROWSER_STATUS.get(row[0], "running")}


@app.get("/api/v1/users/{user_id}/deletion-requests/{request_id}")
def deletion_request(request: Request, user_id: str = Path(...), request_id: str = Path(...)):
    authorize(request, user_id)
    if not UUID_PATTERN.match(request_id):
        raise HTTPException(status_code=400, detail="invalid_request_id")
    if not WAREHOUSE_HTTP_PATH or not OPS_TABLE:
        raise HTTPException(status_code=503, detail="deletion_not_configured")

    with warehouse() as connection_, connection_.cursor() as cursor:
        # Scoped to the reader as well as the id. A request id alone is a
        # readable handle on somebody's deletion.
        cursor.execute(
            f"SELECT status FROM {OPS_TABLE} WHERE request_id = ? AND user_id = ?",
            [request_id, user_id],
        )
        row = cursor.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="not_found")
    return {"requestId": request_id, "status": BROWSER_STATUS.get(row[0], "running")}


@app.get("/health")
def health():
    """No reader data and no authorization: it says the process is up, nothing more."""
    return {"status": "ok"}
