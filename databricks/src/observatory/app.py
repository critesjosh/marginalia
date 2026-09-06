"""
Marginalia Observatory.

Eight views over one reader's own intelligence, read through a SQL warehouse
using the app's own service principal. No pasted token, no database password,
and no table holding the reader's own words.

What it reads are the per-reader views in the scoped schema, not Gold. The
service principal has no grant on Gold at all, so another reader's rows are
not something a mistaken predicate here could reach.

Every view states when its source was last computed, because a dashboard that
shows a number without saying how old it is invites the reader to assume it is
current. Where a number is an aggregate, the row beneath it names the evidence
it came from.
"""

import os

import pandas as pd
import streamlit as st
from databricks import sql as dbsql
from databricks.sdk.core import Config

from queries import FORBIDDEN_TABLES, STATEMENTS, Result

CATALOG = os.environ.get("MARGINALIA_CATALOG", "")
SCOPED = os.environ.get("MARGINALIA_SCOPED_SCHEMA", "")
WAREHOUSE_PATH = os.environ.get("MARGINALIA_WAREHOUSE_HTTP_PATH", "")
USER_ID = os.environ.get("MARGINALIA_TRUSTED_USER_ID", "")
# Ids rather than URLs, so no workspace host is committed or passed around.
# "unset" rather than empty, because an app environment variable must carry a
# value and an absent link is a real state worth naming.
GENIE_SPACE_ID = os.environ.get("MARGINALIA_GENIE_SPACE_ID", "unset")
DASHBOARD_ID = os.environ.get("MARGINALIA_DASHBOARD_ID", "unset")


def _workspace_link(path: str, identifier: str) -> str:
    """Built from the app's own host, which it already knows and we need not."""
    if not identifier or identifier == "unset":
        return ""
    try:
        host = Config().host.rstrip("/")
    except Exception:  # noqa: BLE001 - a missing link is not a reason to fail a page
        return ""
    return f"{host}{path}{identifier}"


st.set_page_config(page_title="Marginalia Observatory", layout="wide")


def _bind(statement: str) -> str:
    return statement.format(scoped=f"{CATALOG}.{SCOPED}")


@st.cache_resource
def _connection():
    config = Config()
    return dbsql.connect(
        server_hostname=config.host.replace("https://", ""),
        http_path=WAREHOUSE_PATH,
        credentials_provider=lambda: config.authenticate,
    )


@st.cache_data(ttl=60)
def run(name: str) -> Result:
    """
    One named statement. Cached for a minute: the pipeline behind these runs
    every fifteen, so re-querying on every widget interaction would spend the
    warehouse's time to produce the same answer.
    """
    statement = _bind(STATEMENTS[name])
    with _connection().cursor() as cursor:
        cursor.execute(statement, {"user": USER_ID})
        columns = [description[0] for description in cursor.description]
        rows = cursor.fetchall()

    computed_at = None
    if "computed_at" in columns:
        index = columns.index("computed_at")
        stamps = [row[index] for row in rows if row[index] is not None]
        computed_at = max(stamps) if stamps else None
    return Result(columns=columns, rows=[tuple(row) for row in rows], computed_at=computed_at)


def frame(result: Result, drop: tuple[str, ...] = ("computed_at",)) -> pd.DataFrame:
    data = pd.DataFrame(result.rows, columns=result.columns)
    return data.drop(columns=[c for c in drop if c in data.columns])


def source_line(result: Result) -> None:
    """The requirement, in one place: no view renders without saying this."""
    st.caption(f"Source: {result.freshness()}")


def unavailable(message: str) -> None:
    st.info(message)


# --------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------


def overview() -> None:
    st.header("Overview")
    result = run("overview")
    if result.empty:
        unavailable("Nothing has been computed for this reader yet.")
        return

    row = dict(zip(result.columns, result.rows[0]))
    columns = st.columns(6)
    for column, (label, key) in zip(
        columns,
        [
            ("Concepts", "concepts"),
            ("Books", "books"),
            ("Highlights", "highlights"),
            ("Questions", "questions"),
            ("Frontier", "frontier"),
            ("Recommended", "recommendations"),
        ],
    ):
        column.metric(label, int(row.get(key) or 0))
    source_line(result)

    st.subheader("Where these come from")
    st.markdown(
        "Every number above is a row count in Gold, not an estimate. "
        "Concepts and books are per reader; the frontier counts concepts the "
        "reader has no direct evidence for, which is why it does not overlap "
        "the concept count."
    )


def reading() -> None:
    st.header("Reading")
    result = run("reading")
    if result.empty:
        unavailable("No reading sessions have reached Gold yet.")
        return
    st.dataframe(frame(result), width="stretch")
    source_line(result)

    sessions = run("sessions")
    if not sessions.empty:
        st.subheader("Attention over time")
        data = frame(sessions).set_index("day")
        st.bar_chart(data["active_minutes"])
        st.caption(
            "Active minutes per day, from reading sessions in Silver rather "
            "than from wall-clock time a book was open."
        )
        source_line(sessions)


def interests() -> None:
    st.header("Interests")
    result = run("interests")
    if result.empty:
        unavailable("No interest profile has been computed yet.")
        return

    data = frame(result)
    st.bar_chart(data.set_index("concept_id")["interest_score"].head(15))
    st.caption(
        "Interest is normalized within this reader: it says where a concept "
        "sits among their own interests, not against anybody else's."
    )
    st.dataframe(data, width="stretch")
    source_line(result)


def concepts() -> None:
    st.header("Concepts")
    st.markdown(
        "The evidence behind the profile, by source rather than by score. "
        "An interest nobody can trace back to something they read is a number "
        "worth distrusting."
    )
    result = run("concepts")
    if result.empty:
        unavailable("No valid extractions yet.")
    else:
        st.dataframe(frame(result), width="stretch")
        source_line(result)

    health = run("extraction_health")
    if not health.empty:
        st.subheader("Extraction health")
        st.dataframe(frame(health), width="stretch")
        st.caption(
            "Rejected extractions are shown rather than hidden. An empty "
            "profile with no explanation looks the same as a reader who "
            "highlighted nothing."
        )
        source_line(health)


def frontier() -> None:
    st.header("Frontier")
    st.markdown(
        "Concepts adjacent to what this reader has established, with the "
        "works that made them adjacent. A frontier concept is one they have "
        "no direct evidence for, so it will not appear under Interests."
    )
    result = run("frontier")
    if result.empty:
        unavailable(
            "No frontier rows yet. This needs public-source enrichment to have "
            "found research works whose topics reach past the reader's own concepts."
        )
        return
    st.dataframe(frame(result), width="stretch")
    source_line(result)


def recommendations() -> None:
    st.header("Recommendations")
    result = run("recommendations")
    if result.empty:
        unavailable("No recommendation candidates yet.")
        return

    data = frame(result)
    for _, row in data.head(10).iterrows():
        with st.container(border=True):
            st.markdown(f"**{row.get('candidate_title') or row.get('candidate_id')}**")
            st.caption(row.get("explanation") or "No explanation recorded.")
            components = st.columns(5)
            for column, label in zip(
                components,
                [
                    "concept_interest_match",
                    "frontier_coverage",
                    "diversity",
                    "popularity_prior",
                    "metadata_completeness",
                ],
            ):
                value = row.get(label)
                column.metric(
                    label.replace("_", " "), f"{float(value):.2f}" if value is not None else "-"
                )
            st.caption(
                f"score {float(row['recommendation_score']):.3f} "
                f"({row.get('score_version')}) · matched {row.get('matched_concepts')}"
            )
    st.dataframe(data, width="stretch")
    source_line(result)


# The defect counts that are meant to be zero, and are not quality measures.
# A run with one of these is a failed run whatever the rest of it says.
BLOCKING_COLUMNS = (
    "cross_reader_evidence",
    "spoiler_violations",
    "citation_errors",
    "unsupported_answers",
    "injection_failures",
)


def agent_quality() -> None:
    st.header("Agent quality")
    st.markdown(
        "The most recent Librarian evaluation. It runs against synthetic "
        "readers over fixture passages, so nothing here is anybody's reading: "
        "it is how the agent behaved when a note told it to ignore its "
        "instructions, when the retriever returned another reader's passage, "
        "and when it was asked about a part of the book the reader has not "
        "reached."
    )
    result = run("agent_quality")
    if result.empty:
        # Still the Phase 7 distinction, and still worth keeping: an empty
        # table means no evaluation has run, which is different from an
        # evaluation that found nothing wrong.
        unavailable(
            "No evaluation runs recorded. The Librarian may be deployed and "
            "unevaluated; this is empty because nothing has scored it, not "
            "because it scored zero."
        )
        return

    data = frame(result)
    defects = int(sum(data[column].fillna(0).sum() for column in BLOCKING_COLUMNS if column in data))
    if defects:
        st.error(
            f"{defects} blocking defect(s) in the last run. Each of these is meant to be "
            "zero: a spoiler shown, a citation invented, another reader's passage cited, "
            "an answer given with no source, or an instruction inside a passage obeyed."
        )
    else:
        st.success("No blocking defects in the last run.")

    columns = st.columns(3)
    columns[0].metric("Cases", len(data))
    if "retrieval_recall" in data:
        columns[1].metric("Mean retrieval recall", f"{data['retrieval_recall'].fillna(0).mean():.2f}")
    if "latency_ms" in data:
        # The median rather than the mean: one cold start after the endpoint
        # has scaled to zero would otherwise be reported as the typical wait.
        columns[2].metric("Median latency", f"{data['latency_ms'].median():.0f} ms")

    st.dataframe(data, width="stretch")
    source_line(result)


def ask() -> None:
    st.header("Ask Marginalia")
    st.markdown(
        "Structured analytical questions are answered by a curated Genie "
        "space over the Gold tables. Genie is its own product surface, so "
        "this links to it rather than reimplementing it here."
    )
    genie = _workspace_link("/genie/rooms/", GENIE_SPACE_ID)
    if genie:
        st.link_button("Open the Genie space", genie)
    else:
        unavailable("No Genie space is configured for this deployment.")

    st.subheader("What it can and cannot see")
    st.markdown(
        "- It reads the Gold profiles, the frontier, and recommendations.\n"
        "- It has no grant on highlight text, notes, conversations, questions, "
        "assistant replies, book memory, or raw provider responses.\n"
        "- Asked for any of those it says it cannot see them, rather than "
        "returning nothing, because nothing would read as having none."
    )
    dashboard = _workspace_link("/dashboardsv3/", DASHBOARD_ID)
    if dashboard:
        st.subheader("Dashboard")
        st.link_button("Open the AI/BI dashboard", dashboard)


VIEWS = {
    "Overview": overview,
    "Reading": reading,
    "Interests": interests,
    "Concepts": concepts,
    "Frontier": frontier,
    "Recommendations": recommendations,
    "Agent quality": agent_quality,
    "Ask Marginalia": ask,
}


def main() -> None:
    st.sidebar.title("Marginalia Observatory")
    choice = st.sidebar.radio("View", list(VIEWS), label_visibility="collapsed")
    st.sidebar.caption(
        "One reader's own intelligence, read through per-reader views. No "
        "table holding their own words is reachable from here, and no other "
        "reader's rows are either."
    )
    if st.sidebar.button("Refresh"):
        st.cache_data.clear()

    missing = [
        name
        for name, value in [
            ("MARGINALIA_CATALOG", CATALOG),
            ("MARGINALIA_SCOPED_SCHEMA", SCOPED),
            ("MARGINALIA_WAREHOUSE_HTTP_PATH", WAREHOUSE_PATH),
            ("MARGINALIA_TRUSTED_USER_ID", USER_ID),
        ]
        if not value
    ]
    if missing:
        # Refusing beats guessing. An Observatory that picked a default reader
        # would show somebody the wrong person's reading.
        st.error(f"Not configured: {', '.join(missing)}")
        return

    try:
        VIEWS[choice]()
    except Exception as error:  # noqa: BLE001 - the reason belongs on screen
        message = str(error)
        if any(table in message for table in FORBIDDEN_TABLES):
            st.error(
                "That query reached for a table the Observatory has no grant on. "
                "This is the boundary working, not a fault to route around."
            )
        else:
            st.error(f"Could not load this view: {message[:400]}")


main()
