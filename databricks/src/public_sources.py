# Open Library matching and targeted OpenAlex enrichment.
#
# A job rather than a pipeline, for the same reason extraction is one: it calls
# somebody else's server, and a materialized view would call it again every time
# its source changed. Raw responses land in Bronze with their provenance so a
# parser change can be re-run without asking the provider again.

import json
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

from public_matching import MATCHER_VERSION, choose_match

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
# Both providers ask to be told who is calling. Neither is a secret, and a job
# that cannot say who it is gets rate limited far harder.
CONTACT = _argument("public_contact")
BATCH_LIMIT = int(_argument("public_batch_limit", "25"))
# Open Library asks for no more than 100 requests per five minutes; one per
# second is well inside that and needs no coordination between runs.
REQUEST_SPACING_SECONDS = float(_argument("public_request_spacing", "1.0"))

SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"
INTEREST = f"{CATALOG}.{GOLD}.reader_interest_profile"
RAW = f"{CATALOG}.{BRONZE}.public_sources_raw"
MATCHES = f"{CATALOG}.{SILVER}.book_work_matches"
RESEARCH = f"{CATALOG}.{SILVER}.research_works"

USER_AGENT = f"Marginalia/0.1 ({CONTACT})"
PARSER_VERSION = "public-sources-v1"

# Recorded on every row rather than assumed. Both are open data today; a licence
# that changes is a fact about a row, not a fact about the code.
LICENSES = {
    "openlibrary": "CC0-1.0 (Open Library / Internet Archive)",
    "openalex": "CC0-1.0 (OpenAlex)",
}


def ensure_tables():
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{BRONZE}")
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SILVER}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {RAW} (
          request_id STRING NOT NULL,
          source STRING NOT NULL,
          request_url STRING NOT NULL,
          http_status INT,
          etag STRING,
          retrieved_at TIMESTAMP NOT NULL,
          parser_version STRING NOT NULL,
          source_license STRING NOT NULL,
          body STRING,
          error STRING
        ) USING DELTA
        """
    )
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {MATCHES} (
          user_id STRING NOT NULL,
          book_id STRING NOT NULL,
          work_key STRING,
          confidence DOUBLE,
          status STRING NOT NULL,
          considered STRING,
          matcher_version STRING NOT NULL,
          request_id STRING,
          matched_at TIMESTAMP NOT NULL
        ) USING DELTA
        """
    )
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {RESEARCH} (
          concept_id STRING NOT NULL,
          work_id STRING NOT NULL,
          title STRING,
          publication_year INT,
          cited_by_count BIGINT,
          authors STRING,
          topics STRING,
          request_id STRING,
          retrieved_at TIMESTAMP NOT NULL,
          source_license STRING NOT NULL
        ) USING DELTA
        """
    )


def fetch(source: str, url: str) -> dict:
    """
    One request, with everything needed to explain it later. A failure is a row
    too: a provider outage must be visible in Bronze, not an absence.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    record = {
        "request_id": str(uuid.uuid4()),
        "source": source,
        "request_url": url,
        "http_status": None,
        "etag": None,
        "retrieved_at": datetime.now(timezone.utc),
        "parser_version": PARSER_VERSION,
        "source_license": LICENSES[source],
        "body": None,
        "error": None,
    }
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            record["http_status"] = response.status
            record["etag"] = response.headers.get("ETag")
            record["body"] = response.read().decode("utf-8")
    except Exception as error:  # noqa: BLE001 - the reason is the data here
        record["error"] = f"{type(error).__name__}: {error}"[:500]
    # Spaced rather than hammered. These are free services run for everyone.
    time.sleep(REQUEST_SPACING_SECONDS)
    return record


def _write_raw(records: list[dict]):
    if not records:
        return
    spark.createDataFrame(
        [
            (
                r["request_id"], r["source"], r["request_url"], r["http_status"], r["etag"],
                r["retrieved_at"], r["parser_version"], r["source_license"], r["body"], r["error"],
            )
            for r in records
        ],
        "request_id STRING, source STRING, request_url STRING, http_status INT, etag STRING, "
        "retrieved_at TIMESTAMP, parser_version STRING, source_license STRING, body STRING, "
        "error STRING",
    ).write.mode("append").saveAsTable(RAW)


def books_to_match():
    """
    Books whose reader shared metadata and that have no match under the current
    matcher version. Bumping MATCHER_VERSION is what re-opens every book.
    """
    events = spark.read.table(SILVER_EVENTS)
    privacy = F.from_json(F.col("privacy_json"), "consentVersion INT, included ARRAY<STRING>")
    added = (
        events.filter(F.col("event_type") == "book_added")
        .withColumn("privacy", privacy)
        .filter(F.array_contains(F.col("privacy.included"), "bookMetadata"))
        .withColumn("title", F.try_variant_get(F.col("payload"), "$.title", "string"))
        .withColumn("author", F.try_variant_get(F.col("payload"), "$.author", "string"))
        .filter(F.col("title").isNotNull())
        .select("user_id", "book_id", "title", "author")
        .dropDuplicates(["user_id", "book_id"])
    )

    deleted = (
        events.filter(F.col("event_type") == "book_deleted")
        .select("user_id", "book_id")
        .distinct()
    )
    added = added.join(deleted, ["user_id", "book_id"], "left_anti")

    try:
        done = (
            spark.read.table(MATCHES)
            .filter(F.col("matcher_version") == MATCHER_VERSION)
            .select("user_id", "book_id")
            .distinct()
        )
        added = added.join(done, ["user_id", "book_id"], "left_anti")
    except Exception:
        pass
    return added.limit(BATCH_LIMIT)


def match_books() -> int:
    pending = books_to_match().collect()
    if not pending:
        return 0

    raw_records, rows = [], []
    now = datetime.now(timezone.utc)
    for book in pending:
        query = urllib.parse.urlencode(
            {
                "q": f"{book['title']} {book['author'] or ''}".strip(),
                "fields": "key,title,author_name,first_publish_year,edition_count,subject,cover_i",
                "limit": "10",
            }
        )
        record = fetch("openlibrary", f"https://openlibrary.org/search.json?{query}")
        raw_records.append(record)

        candidates = []
        if record["body"]:
            try:
                candidates = json.loads(record["body"]).get("docs", []) or []
            except ValueError:
                candidates = []
        decision = choose_match({"title": book["title"], "author": book["author"] or ""}, candidates)
        rows.append(
            (
                book["user_id"], book["book_id"], decision["work_key"], float(decision["confidence"]),
                decision["status"], json.dumps(decision["considered"]), MATCHER_VERSION,
                record["request_id"], now,
            )
        )

    _write_raw(raw_records)
    spark.createDataFrame(
        rows,
        "user_id STRING, book_id STRING, work_key STRING, confidence DOUBLE, status STRING, "
        "considered STRING, matcher_version STRING, request_id STRING, matched_at TIMESTAMP",
    ).write.mode("append").saveAsTable(MATCHES)
    return len(rows)


def enrich_concepts() -> int:
    """
    Targeted, never a mirror. Only concepts a reader actually has interest in,
    and only the strongest of those.
    """
    try:
        concepts = (
            spark.read.table(INTEREST)
            .orderBy(F.col("interest_score").desc())
            .select("concept_id")
            .distinct()
            .limit(BATCH_LIMIT)
            .collect()
        )
    except Exception:
        return 0
    if not concepts:
        return 0

    raw_records, rows = [], []
    now = datetime.now(timezone.utc)
    for row in concepts:
        concept = row["concept_id"]
        query = urllib.parse.urlencode(
            {
                "filter": f"title.search:{concept}",
                "per-page": "10",
                "sort": "cited_by_count:desc",
                "mailto": CONTACT,
            }
        )
        record = fetch("openalex", f"https://api.openalex.org/works?{query}")
        raw_records.append(record)
        if not record["body"]:
            continue
        try:
            works = json.loads(record["body"]).get("results", []) or []
        except ValueError:
            continue
        for work in works:
            rows.append(
                (
                    concept,
                    work.get("id"),
                    work.get("title") or work.get("display_name"),
                    work.get("publication_year"),
                    work.get("cited_by_count"),
                    json.dumps(
                        [
                            a.get("author", {}).get("display_name")
                            for a in (work.get("authorships") or [])
                        ][:10]
                    ),
                    json.dumps([t.get("display_name") for t in (work.get("topics") or [])][:10]),
                    record["request_id"],
                    now,
                    LICENSES["openalex"],
                )
            )

    _write_raw(raw_records)
    if rows:
        spark.createDataFrame(
            rows,
            "concept_id STRING, work_id STRING, title STRING, publication_year INT, "
            "cited_by_count BIGINT, authors STRING, topics STRING, request_id STRING, "
            "retrieved_at TIMESTAMP, source_license STRING",
        ).write.mode("append").saveAsTable(RESEARCH)
    return len(rows)


def run():
    ensure_tables()
    matched = match_books()
    enriched = enrich_concepts()
    # Counts and versions only. No title and no reader text reaches a log.
    print(
        json.dumps(
            {
                "matcher_version": MATCHER_VERSION,
                "parser_version": PARSER_VERSION,
                "books_matched": matched,
                "research_works": enriched,
            }
        )
    )


run()