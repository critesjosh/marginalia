"""
The Databricks App the Cloudflare Worker calls.

It is the only thing outside the workspace that can read a reader's profile, and
it is deliberately small: seven routes, read-only Postgres queries against the
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
from fastapi import Body, FastAPI, HTTPException, Path, Request
from psycopg.rows import dict_row
from pydantic import BaseModel

app = FastAPI(title="Marginalia intelligence")

PG_SCHEMA = os.environ.get("MARGINALIA_PG_SCHEMA", "marginalia_gold")
INSTANCE_NAME = os.environ.get("MARGINALIA_LAKEBASE_INSTANCE", "")
# The service principal the Worker authenticates as. Workspace authorization
# already gates the App, but this is what makes "only the trusted caller" a
# property of the App rather than of somebody's memory of a permissions page.
TRUSTED_CALLER = os.environ.get("MARGINALIA_TRUSTED_CALLER", "")
# Comma-separated so a deployment can name the caller's application id and its
# username without having to know which header the platform puts each in.
ALLOWED_CALLERS = {value.strip() for value in TRUSTED_CALLER.split(",") if value.strip()}
WAREHOUSE_HTTP_PATH = os.environ.get("MARGINALIA_WAREHOUSE_HTTP_PATH", "")
OPS_TABLE = os.environ.get("MARGINALIA_DELETION_TABLE", "")
# One line per MCP tool call. Derived from the deletion table's name rather than
# configured separately: they live in the same operational schema, and two
# variables that must agree are two variables that eventually do not.
MCP_AUDIT_TABLE = OPS_TABLE.rsplit(".", 1)[0] + ".mcp_audit" if OPS_TABLE else ""
# The tools this server has. An audit row naming anything else records that
# something else was asked for rather than storing what the caller called it:
# a free-text column in an operational table is a place to put a reader's words.
KNOWN_TOOLS = {
    "list_interests",
    "list_book_engagement",
    "list_recommendations",
    "list_frontier",
}
# The reasons this server produces, in the shape it produces them.
AUDIT_DETAIL = re.compile(r"^(unknown_tool|unexpected_argument|upstream_[0-9]{3})$")
# Recording a request is not the same as starting one. The job is what actually
# deletes, and a reader who asked should not wait for a nightly sweep to find
# out that anything is happening.
DELETION_JOB_ID = os.environ.get("MARGINALIA_DELETION_JOB_ID", "")
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
    if not ALLOWED_CALLERS:
        # Refusing is the only safe reading of a missing configuration. Serving
        # a profile because nobody said who was allowed to read it is precisely
        # the failure this check exists to prevent.
        raise HTTPException(status_code=503, detail="caller_not_configured")

    # Databricks forwards a caller's identity across three headers, and which
    # one carries a service principal's application id is not something to
    # guess: a check that reads only one header and gets it wrong either refuses
    # the intended caller or is satisfied by a mutable username. Any of the
    # three matching an allowed identity is accepted, and nothing else is.
    presented = {
        request.headers.get(header, "")
        for header in ("x-forwarded-user", "x-forwarded-preferred-username", "x-forwarded-email")
    } - {""}
    if not presented & ALLOWED_CALLERS:
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


# Kept identical to databricks/src/deletion.py, which is the owner of this
# schema. Two definitions of one table is a drift risk, so a contract test
# compares the columns rather than trusting that they were kept in step.
REQUESTS_DDL = """
CREATE TABLE IF NOT EXISTS {table} (
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
        # The deletion job owns this table and creates it on its first run, but
        # the first request is written before any run has happened. Creating it
        # here removes that ordering entirely: idempotent, and identical to the
        # job's own definition, which a contract test holds it to.
        cursor.execute(REQUESTS_DDL.format(table=OPS_TABLE))
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

    start_deletion(body.requestId)
    return {"requestId": body.requestId, "status": BROWSER_STATUS.get(row[0], "running")}


def start_deletion(request_id: str):
    """
    Idempotent by the job's own design: a second run over a request whose purge
    already finished deletes nothing and verifies the same absence. Failing to
    start is not failing the request, because the row is written and the nightly
    sweep picks it up; the browser is polling either way.
    """
    if not DELETION_JOB_ID:
        return
    try:
        workspace.jobs.run_now(
            job_id=int(DELETION_JOB_ID), job_parameters={"request_id": request_id}
        )
    except Exception:  # noqa: BLE001 - the request stands whether or not this did
        return


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


@app.get("/api/v1/users/{user_id}/recommendations")
def recommendations(request: Request, user_id: str = Path(...)):
    """
    Books to read next, with the components that produced the ranking.

    The explanation is a column rather than generated prose, so what the reader
    is shown is what the score was computed from. Nothing here is the reader's
    own text: a candidate is a public work, and the concepts named are the
    labels their profile already holds.

    Fewer rows than the other two routes. This is a list a person reads rather
    than a profile a page summarises, and five hundred recommendations is not a
    longer list, it is a worse one.
    """
    authorize(request, user_id)
    with connection() as pg, pg.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT candidate_id, candidate_title, authors, publication_year,
                   recommendation_score, explanation, matched_concepts,
                   score_version, computed_at
            FROM {PG_SCHEMA}.recommendation_candidates
            WHERE user_id = %s
            ORDER BY recommendation_score DESC, candidate_id
            LIMIT 50
            """,
            (user_id,),
        )
        rows = cursor.fetchall()

    updated = source_updated_at(rows)
    return {
        "rows": [
            {
                "candidateId": row["candidate_id"],
                "candidateTitle": row["candidate_title"],
                "authors": row["authors"],
                "publicationYear": (
                    int(row["publication_year"]) if row["publication_year"] is not None else None
                ),
                "recommendationScore": float(row["recommendation_score"] or 0.0),
                "explanation": row["explanation"],
                "matchedConcepts": row["matched_concepts"],
                "scoreVersion": row["score_version"],
            }
            for row in rows
        ],
        **({"sourceUpdatedAt": updated} if updated else {}),
    }


@app.get("/api/v1/users/{user_id}/frontier")
def frontier(request: Request, user_id: str = Path(...)):
    """
    Concepts adjacent to what the reader has established, with what makes them
    adjacent.

    Every row names the established concepts and the public works behind it, so
    a frontier concept can be argued with rather than only accepted. Nothing
    here is the reader's own text: the concepts are labels their profile
    already holds and the works are published research.
    """
    authorize(request, user_id)
    with connection() as pg, pg.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT candidate_concept, frontier_score, neighbour_count,
                   supporting_work_count, best_cited_by_count, established_concepts,
                   supporting_works, score_version, computed_at
            FROM {PG_SCHEMA}.intellectual_frontier
            WHERE user_id = %s
            ORDER BY frontier_score DESC, candidate_concept
            LIMIT 200
            """,
            (user_id,),
        )
        rows = cursor.fetchall()

    updated = source_updated_at(rows)
    return {
        "rows": [
            {
                "candidateConcept": row["candidate_concept"],
                "frontierScore": float(row["frontier_score"] or 0.0),
                "neighbourCount": int(row["neighbour_count"] or 0),
                "supportingWorkCount": int(row["supporting_work_count"] or 0),
                "bestCitedByCount": int(row["best_cited_by_count"] or 0),
                "establishedConcepts": row["established_concepts"],
                "supportingWorks": row["supporting_works"],
                "scoreVersion": row["score_version"],
            }
            for row in rows
        ],
        **({"sourceUpdatedAt": updated} if updated else {}),
    }


@app.post("/api/v1/users/{user_id}/mcp-audit")
def record_mcp_audit(request: Request, user_id: str = Path(...), entry: dict = Body(...)):
    """
    One line per MCP tool call: which tool, when, how many rows, and whether it
    worked.

    Never the rows. An audit that quoted what a tool returned would be a second
    copy of the reader's profile living under a different retention rule, which
    is exactly the shape of thing the logging rules exist to prevent.

    A write, in a service whose whole point is that it only reads. It is here
    because the alternative is an audit the Worker keeps to itself, and an
    audit that lives only where the thing being audited runs is not much of an
    audit. It writes to one operational table and can touch nothing else.
    """
    authorize(request, user_id)

    # The tool and the detail are both caller-influenced, and this table is
    # governed by the rule that it holds no reader content. So neither is
    # stored as sent: the tool must be one this server actually has, and the
    # detail must be one of the reasons this server produces. Anything else is
    # recorded as the fact that something else was asked for.
    tool = str(entry.get("tool", ""))[:120]
    if tool not in KNOWN_TOOLS:
        tool = "unknown_tool"
    detail = entry.get("detail")
    detail = str(detail)[:80] if detail is not None else None
    if detail is not None and not AUDIT_DETAIL.match(detail):
        detail = "unrecognised_detail"
    rows = int(entry.get("rows") or 0)
    ok = bool(entry.get("ok"))
    at = str(entry.get("at", ""))[:40]
    if not tool or not at:
        raise HTTPException(status_code=400, detail="an audit row needs a tool and a time")
    if not WAREHOUSE_HTTP_PATH or not MCP_AUDIT_TABLE:
        raise HTTPException(status_code=503, detail="audit storage is not configured")

    with warehouse() as sql, sql.cursor() as cursor:
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {MCP_AUDIT_TABLE} (
              called_at TIMESTAMP NOT NULL,
              recorded_at TIMESTAMP NOT NULL,
              user_id STRING NOT NULL,
              tool STRING NOT NULL,
              rows_returned BIGINT,
              succeeded BOOLEAN,
              detail STRING
            ) USING DELTA
            """
        )
        cursor.execute(
            f"""
            INSERT INTO {MCP_AUDIT_TABLE}
            VALUES (?, current_timestamp(), ?, ?, ?, ?, ?)
            """,
            (at, user_id, tool, rows, ok, detail),
        )

    return {"recorded": True}


@app.get("/health")
def health():
    """No reader data and no authorization: it says the process is up, nothing more."""
    return {"status": "ok"}
