# Open Library matching and targeted OpenAlex enrichment.
#
# A job rather than a pipeline, for the same reason extraction is one: it calls
# somebody else's server, and a materialized view would call it again every time
# its source changed. Raw responses land in Bronze with their provenance so a
# parser change can be re-run without asking the provider again.

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from pyspark.errors import AnalysisException
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
# Open Library asks for no more than 100 requests per five minutes. That is one
# every three seconds, not one every second: at a second apart a full batch runs
# at three times the rate the provider asks for.
REQUEST_SPACING_SECONDS = float(_argument("public_request_spacing", "3.0"))
# How long a concept's enrichment stays current before it is worth asking again.
ENRICHMENT_TTL_DAYS = int(_argument("public_enrichment_ttl_days", "30"))
# Failed requests retry on a slower clock than the 15-minute job schedule but
# do not wait a full successful-result TTL.
FAILED_REQUEST_RETRY_HOURS = int(_argument("public_failed_retry_hours", "6"))

SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"
INTEREST = f"{CATALOG}.{GOLD}.reader_interest_profile"
RAW = f"{CATALOG}.{BRONZE}.public_sources_raw"
MATCHES = f"{CATALOG}.{SILVER}.book_work_matches"
RESEARCH = f"{CATALOG}.{SILVER}.research_works"
BOOK_CANDIDATES = f"{CATALOG}.{SILVER}.public_book_candidates"
REQUEST_SUBJECTS = f"{CATALOG}.{SILVER}.public_request_subjects"

USER_AGENT = f"Marginalia/0.1 ({CONTACT})"
PARSER_VERSION = "public-sources-v1"

# Recorded on every row rather than assumed. Both are open data today; a licence
# that changes is a fact about a row, not a fact about the code.
# Every stored response records the licence it arrived under. A source missing
# from here raises rather than defaulting: a response with no licence recorded
# is one nobody can later work out the terms of, and guessing is worse than
# failing the run.
LICENSES = {
    "openlibrary": "CC0-1.0 (Open Library / Internet Archive)",
    "openlibrary_subject": "CC0-1.0 (Open Library / Internet Archive)",
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
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {BOOK_CANDIDATES} (
          concept_id STRING NOT NULL,
          work_key STRING NOT NULL,
          title STRING,
          authors ARRAY<STRING>,
          first_publish_year INT,
          edition_count INT,
          subjects ARRAY<STRING>,
          language ARRAY<STRING>,
          request_id STRING NOT NULL,
          retrieved_at TIMESTAMP NOT NULL,
          parser_version STRING NOT NULL
        ) USING DELTA
        """
    )
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {REQUEST_SUBJECTS} (
          request_id STRING NOT NULL,
          user_id STRING NOT NULL,
          book_id STRING,
          concept_id STRING,
          linked_at TIMESTAMP NOT NULL
        ) USING DELTA
        """
    )
    _backfill_request_subjects()


def _backfill_request_subjects():
    """Give already-written raw rows the deletion join path newer rows get."""
    if spark.read.table(REQUEST_SUBJECTS).limit(1).count() > 0:
        return
    sources = [
        spark.read.table(MATCHES)
        .filter(F.col("request_id").isNotNull())
        .select(
            "request_id",
            "user_id",
            "book_id",
            F.lit(None).cast("string").alias("concept_id"),
        )
    ]
    if spark.catalog.tableExists(INTEREST):
        sources.append(
            spark.read.table(RESEARCH)
            .filter(F.col("request_id").isNotNull())
            .select("request_id", "concept_id")
            .distinct()
            .join(
                spark.read.table(INTEREST).select("user_id", "concept_id").distinct(),
                ["concept_id"],
            )
            .select(
                "request_id",
                "user_id",
                F.lit(None).cast("string").alias("book_id"),
                "concept_id",
            )
        )
    combined = sources[0]
    for source in sources[1:]:
        combined = combined.unionByName(source)
    _merge_subject_frame(
        combined.distinct().withColumn("linked_at", F.current_timestamp())
    )


def _known_etag(url: str) -> str | None:
    """The ETag from the last successful fetch of this exact URL, if any."""
    try:
        previous = (
            spark.read.table(RAW)
            .filter(
                (F.col("request_url") == url)
                & F.col("etag").isNotNull()
                & F.col("body").isNotNull()
            )
            .orderBy(F.col("retrieved_at").desc())
            .select("etag")
            .limit(1)
            .collect()
        )
    except AnalysisException:
        return None
    return previous[0]["etag"] if previous else None


def fetch(source: str, url: str) -> dict:
    """
    One request, with everything needed to explain it later. A failure is a row
    too: a provider outage must be visible in Bronze, not an absence.

    Conditional when we have already seen this URL: a 304 costs the provider
    almost nothing and tells us the body we stored is still current.
    """
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    etag = _known_etag(url)
    if etag:
        headers["If-None-Match"] = etag
    request = urllib.request.Request(url, headers=headers)
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
            record["etag"] = response.headers.get("ETag") or etag
            record["body"] = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        record["http_status"] = error.code
        record["etag"] = error.headers.get("ETag") or etag
        if error.code == 304:
            # Unchanged since we last asked. The stored body is still the answer.
            record["body"] = _stored_body(url)
            if record["body"] is None:
                record["error"] = "HTTPError 304 without a cached body"
        else:
            record["error"] = f"HTTPError {error.code}"
    except Exception as error:  # noqa: BLE001 - the reason is the data here
        record["error"] = f"{type(error).__name__}: {error}"[:500]
    # Spaced rather than hammered. These are free services run for everyone.
    time.sleep(REQUEST_SPACING_SECONDS)
    return record


def _stored_body(url: str) -> str | None:
    try:
        previous = (
            spark.read.table(RAW)
            .filter((F.col("request_url") == url) & F.col("body").isNotNull())
            .orderBy(F.col("retrieved_at").desc())
            .select("body")
            .limit(1)
            .collect()
        )
    except AnalysisException:
        return None
    return previous[0]["body"] if previous else None


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


def _write_subjects(records: list[dict]):
    if not records:
        return
    incoming = spark.createDataFrame(
        [
            (
                row["request_id"], row["user_id"], row.get("book_id"),
                row.get("concept_id"), row["linked_at"],
            )
            for row in records
        ],
        "request_id STRING, user_id STRING, book_id STRING, concept_id STRING, linked_at TIMESTAMP",
    ).dropDuplicates(["request_id", "user_id", "book_id", "concept_id"])
    _merge_subject_frame(incoming)


def _merge_subject_frame(incoming):
    incoming.createOrReplaceTempView("incoming_public_request_subjects")
    spark.sql(
        f"""
        MERGE INTO {REQUEST_SUBJECTS} target
        USING incoming_public_request_subjects source
        ON target.request_id = source.request_id
          AND target.user_id = source.user_id
          AND target.book_id <=> source.book_id
          AND target.concept_id <=> source.concept_id
        WHEN NOT MATCHED THEN INSERT *
        """
    )


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

    if spark.catalog.tableExists(MATCHES):
        # Only a decision counts as done. A request that failed left an `error`
        # row, and that book must be asked about again rather than being stuck
        # at "unmatched" because a provider was down for a minute.
        done = (
            spark.read.table(MATCHES)
            .filter(
                (F.col("matcher_version") == MATCHER_VERSION)
                & (F.col("status") != "error")
            )
            .select("user_id", "book_id")
            .distinct()
        )
        added = added.join(done, ["user_id", "book_id"], "left_anti")
    return added.orderBy("user_id", "book_id").limit(BATCH_LIMIT)


def match_books() -> int:
    pending = books_to_match().collect()
    if not pending:
        return 0

    raw_records, rows, subjects = [], [], []
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
        subjects.append(
            {
                "request_id": record["request_id"],
                "user_id": book["user_id"],
                "book_id": book["book_id"],
                "concept_id": None,
                "linked_at": now,
            }
        )

        # A request that did not come back with a usable body has decided
        # nothing. Recording "unmatched" would be a claim the run cannot make,
        # and would permanently retire the book from ever being asked about.
        if record["error"] or not record["body"]:
            rows.append(
                (
                    book["user_id"], book["book_id"], None, 0.0, "error", None,
                    MATCHER_VERSION, record["request_id"], now,
                )
            )
            if record["http_status"] == 429:
                break
            continue
        try:
            candidates = json.loads(record["body"]).get("docs", []) or []
        except ValueError:
            rows.append(
                (
                    book["user_id"], book["book_id"], None, 0.0, "error", None,
                    MATCHER_VERSION, record["request_id"], now,
                )
            )
            continue

        decision = choose_match({"title": book["title"], "author": book["author"] or ""}, candidates)
        rows.append(
            (
                book["user_id"], book["book_id"], decision["work_key"], float(decision["confidence"]),
                decision["status"], json.dumps(decision["considered"]), MATCHER_VERSION,
                record["request_id"], now,
            )
        )

    _write_raw(raw_records)
    _write_subjects(subjects)
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
    if not spark.catalog.tableExists(INTEREST):
        return 0

    wanted = spark.read.table(INTEREST).groupBy("concept_id").agg(
        F.max("interest_score").alias("strongest_interest"),
        F.sort_array(F.collect_set("user_id")).alias("user_ids"),
    )
    # Eligibility follows attempts, not result rows. A successful empty result
    # still consumes its TTL; a failed request retries after six hours instead
    # of pinning every 15-minute batch forever.
    # Scoped to this provider. Without the filter a successful Open Library
    # book search marks the concept recently attempted for OpenAlex as well,
    # and enrichment stops for the full TTL without anything reporting it.
    attempts = (
        spark.read.table(REQUEST_SUBJECTS)
        .filter(F.col("concept_id").isNotNull())
        .join(spark.read.table(RAW).filter(F.col("source") == "openalex"), ["request_id"])
    )
    recent_success = attempts.filter(
        F.col("body").isNotNull()
        & F.col("error").isNull()
        & (
            F.col("retrieved_at")
            >= F.current_timestamp() - F.expr(f"INTERVAL {ENRICHMENT_TTL_DAYS} DAYS")
        )
    ).select("concept_id")
    recent_failure = attempts.filter(
        F.col("error").isNotNull()
        & (
            F.col("retrieved_at")
            >= F.current_timestamp() - F.expr(f"INTERVAL {FAILED_REQUEST_RETRY_HOURS} HOURS")
        )
    ).select("concept_id")
    recent = recent_success.union(recent_failure).distinct()
    wanted = wanted.join(recent, ["concept_id"], "left_anti")

    concepts = wanted.orderBy(F.col("strongest_interest").desc(), "concept_id").limit(BATCH_LIMIT).collect()
    if not concepts:
        return 0

    raw_records, rows, subjects = [], [], []
    now = datetime.now(timezone.utc)
    for row in concepts:
        concept = row["concept_id"]
        query = urllib.parse.urlencode(
            {
                "search": concept,
                "per-page": "10",
                "sort": "cited_by_count:desc",
                "mailto": CONTACT,
            }
        )
        record = fetch("openalex", f"https://api.openalex.org/works?{query}")
        raw_records.append(record)
        subjects.extend(
            {
                "request_id": record["request_id"],
                "user_id": user_id,
                "book_id": None,
                "concept_id": concept,
                "linked_at": now,
            }
            for user_id in row["user_ids"]
        )
        if not record["body"]:
            if record["http_status"] == 429:
                break
            continue
        try:
            works = json.loads(record["body"]).get("results", []) or []
        except ValueError:
            # A body that will not parse is a failed attempt, not an empty
            # answer. Left unmarked it reads as success and holds the concept
            # for the full TTL while storing nothing.
            record["error"] = "response body did not parse as JSON"
            continue
        for work in works:
            work_id = work.get("id")
            if not work_id:
                continue
            rows.append(
                (
                    concept,
                    work_id,
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
    _write_subjects(subjects)
    if rows:
        spark.createDataFrame(
            rows,
            "concept_id STRING, work_id STRING, title STRING, publication_year INT, "
            "cited_by_count BIGINT, authors STRING, topics STRING, request_id STRING, "
            "retrieved_at TIMESTAMP, source_license STRING",
        ).write.mode("append").saveAsTable(RESEARCH)
    return len(rows)


def find_books() -> int:
    """
    Books a reader might read next, asked of the catalogue that has books.

    OpenAlex indexes research output, so asking it for reading recommendations
    returns papers: a single-cell genomics article scored against an interest
    in "artist". It remains the right source for the frontier, which is about
    what topics sit next to each other. It is the wrong source for what to read
    next, and Open Library is the right one, having books, editions, and the
    authors who actually wrote them.

    Asked about the reader's own concepts, so a candidate arrives already
    attached to the interest that produced it.
    """
    if not spark.catalog.tableExists(INTEREST):
        return 0

    wanted = spark.read.table(INTEREST).groupBy("concept_id").agg(
        F.max("interest_score").alias("strongest_interest"),
        F.sort_array(F.collect_set("user_id")).alias("user_ids"),
    )
    # Same attempt-based eligibility as the research enrichment: a successful
    # empty answer still consumes its window, a failure retries sooner.
    attempts = (
        spark.read.table(REQUEST_SUBJECTS)
        .filter(F.col("concept_id").isNotNull())
        .join(spark.read.table(RAW).filter(F.col("source") == "openlibrary_subject"), ["request_id"])
    )
    recent_success = attempts.filter(
        F.col("body").isNotNull()
        & F.col("error").isNull()
        & (F.col("retrieved_at") >= F.current_timestamp() - F.expr(f"INTERVAL {ENRICHMENT_TTL_DAYS} DAYS"))
    ).select("concept_id")
    recent_failure = attempts.filter(
        F.col("error").isNotNull()
        & (F.col("retrieved_at") >= F.current_timestamp() - F.expr(f"INTERVAL {FAILED_REQUEST_RETRY_HOURS} HOURS"))
    ).select("concept_id")
    wanted = wanted.join(recent_success.union(recent_failure).distinct(), ["concept_id"], "left_anti")

    concepts = (
        wanted.orderBy(F.col("strongest_interest").desc(), "concept_id")
        .limit(BATCH_LIMIT)
        .collect()
    )
    if not concepts:
        return 0

    raw_records, rows, subjects = [], [], []
    now = datetime.now(timezone.utc)
    for row in concepts:
        concept = row["concept_id"]
        query = urllib.parse.urlencode(
            {
                "q": concept,
                "limit": "10",
                "fields": "key,title,author_name,first_publish_year,edition_count,subject,language",
            }
        )
        record = fetch("openlibrary_subject", f"https://openlibrary.org/search.json?{query}")
        raw_records.append(record)
        subjects.extend(
            {
                "request_id": record["request_id"],
                "user_id": user_id,
                "book_id": None,
                "concept_id": concept,
                "linked_at": now,
            }
            for user_id in row["user_ids"]
        )
        if not record["body"]:
            if record["http_status"] == 429:
                break
            continue
        try:
            docs = json.loads(record["body"]).get("docs", []) or []
        except ValueError:
            record["error"] = "response body did not parse as JSON"
            continue
        for doc in docs:
            work_key = doc.get("key")
            if not work_key or not doc.get("title"):
                continue
            rows.append(
                (
                    concept,
                    work_key,
                    doc.get("title"),
                    doc.get("author_name") or [],
                    doc.get("first_publish_year"),
                    doc.get("edition_count"),
                    (doc.get("subject") or [])[:25],
                    doc.get("language") or [],
                    record["request_id"],
                    now,
                    PARSER_VERSION,
                )
            )

    _write_raw(raw_records)
    _write_subjects(subjects)
    if rows:
        spark.createDataFrame(
            rows,
            "concept_id STRING, work_key STRING, title STRING, authors ARRAY<STRING>, "
            "first_publish_year INT, edition_count INT, subjects ARRAY<STRING>, "
            "language ARRAY<STRING>, request_id STRING, retrieved_at TIMESTAMP, "
            "parser_version STRING",
        ).write.mode("append").saveAsTable(BOOK_CANDIDATES)
    return len(rows)


def run():
    ensure_tables()
    matched = match_books()
    enriched = enrich_concepts()
    # Counts and versions only. No title and no reader text reaches a log.
    books = find_books()
    print(
        json.dumps(
            {
                "matcher_version": MATCHER_VERSION,
                "book_candidates": books,
                "parser_version": PARSER_VERSION,
                "books_examined": matched,
                "research_works": enriched,
            }
        )
    )


run()
