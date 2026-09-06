"""
Per-reader views over Gold, and the mapping that decides who is which reader.

Phase 7 shipped the Observatory, the dashboard, and the Genie space against the
Gold tables directly, and recorded honestly that this was not per-reader
isolation: a Genie space's data-source list is not an access boundary, and
neither Genie nor the dashboard filtered by reader. `trusted_user_id` scoped the
Observatory and nothing else. This closes that.

Row filters were the other option the plan named and are not available here:
Unity Catalog refuses to apply one to a materialized view, and every Gold table
is a materialized view. So the boundary is a view.

Each view selects from its source where a mapping row says the querying
principal is that reader. A Unity Catalog view runs with its owner's privileges,
so a reader principal is granted `SELECT` on the view and nothing on Gold, on
Silver, or on the mapping table itself. Being unmapped is not an error, it is an
empty result: a principal nobody has vouched for is not a reader.

`current_user()` is the identity asking, not the identity that built anything.
That holds for the Observatory, which queries as its own service principal, and
for Genie, whose data access is documented as always evaluated against the end
user's own Unity Catalog identity even though its warehouse runs on embedded
compute credentials. It does not hold for a dashboard published the default way,
whose viewers query on the publisher's data permissions; the dashboard resource
sets `embed_credentials: false` for exactly that reason.

A principal maps to at most one reader. The mapping table cannot express that
constraint, so this task checks it on every run and fails rather than serving a
view that unions two readers into one answer.

What this does not claim: the owner of these schemas still owns them, and can
read the base tables or redefine these views. Isolation between readers is real;
isolation from the person who deployed the workspace is not, and no arrangement
of grants inside one metastore would make it so.

Run as a job task rather than at deploy, because `CREATE OR REPLACE VIEW` is
cheap and idempotent, and a view whose source was dropped and recreated by a
full refresh needs remaking. A source that does not exist yet is skipped and
reported rather than failing the run: on a first deploy the frontier pipeline
has not run, and a missing view is a better outcome than a failed job.
"""

import sys

# The scoped copies, by the schema their source lives in. These are exactly the
# tables the Observatory is permitted to read; a contract test holds the two
# lists together, so adding a view here without meaning to widen that boundary
# fails rather than quietly widening it.
GOLD_VIEWS = (
    "book_engagement",
    "reader_interest_profile",
    "intellectual_frontier",
    "recommendation_candidates",
    "concept_evidence",
    "extraction_health",
)

SILVER_VIEWS = ("reading_sessions",)

# The one view in this schema that does not filter by reader, and the reason it
# does not: `librarian_evaluations` records how the agent scored against
# synthetic readers over fixture passages. It has no reader column, so there is
# nothing to filter on, and a filter written anyway would return nothing and
# look like a broken pipeline. It is named here rather than left to a comment so
# that a contract test can insist this list stays short and that the table it
# points at genuinely has no reader in it.
#
# Each entry is (view name, source schema kind, source table).
UNFILTERED_VIEWS = (("librarian_quality", "ops", "librarian_evaluations"),)

PRINCIPALS_TABLE = "reader_principals"


def principals_ddl(catalog: str, ops_schema: str) -> str:
    """
    Who counts as which reader. One row per principal per reader.

    A principal is a workspace identity: a user's email, or a service
    principal's application id. `user_id` is the trusted id the Worker stamps
    onto every event, which is the same id every Gold table is keyed by.
    """
    return f"""
        CREATE TABLE IF NOT EXISTS {catalog}.{ops_schema}.{PRINCIPALS_TABLE} (
          principal STRING NOT NULL COMMENT 'Workspace user email or service principal application id',
          user_id STRING NOT NULL COMMENT 'The trusted reader id every Gold table is keyed by',
          note STRING COMMENT 'Why this principal may read this reader',
          granted_at TIMESTAMP
        )
        COMMENT 'Principal to reader mapping. The only thing that decides what a scoped view returns.'
    """


def scoped_view_ddl(catalog: str, scoped_schema: str, source_schema: str, table: str, ops_schema: str) -> str:
    """
    One reader's rows out of a shared table.

    `EXISTS` rather than a join: a principal mapped to a reader twice, which a
    mapping table with no unique constraint permits, would otherwise duplicate
    every row and silently double any count taken over the view.

    `current_user()` is the querying principal, so this is one view for every
    reader rather than one view each. Comparison is case-insensitive because a
    workspace accepts an email in whichever case it was typed.
    """
    return f"""
        CREATE OR REPLACE VIEW {catalog}.{scoped_schema}.{table} AS
        SELECT source.*
        FROM {catalog}.{source_schema}.{table} AS source
        WHERE EXISTS (
          SELECT 1
          FROM {catalog}.{ops_schema}.{PRINCIPALS_TABLE} AS mapped
          WHERE mapped.user_id = source.user_id
            AND lower(mapped.principal) = lower(current_user())
        )
    """


def unfiltered_view_ddl(catalog: str, scoped_schema: str, view: str, source_schema: str, table: str) -> str:
    """
    A pass-through, for a source with no reader in it.

    Deliberately not given a filter that would always be true. A filter on a
    column that does not exist would fail; one written to be trivially true
    would look like the filtered views and be nothing like them, which is worse
    than a view that plainly has none.
    """
    return f"""
        CREATE OR REPLACE VIEW {catalog}.{scoped_schema}.{view} AS
        SELECT source.*
        FROM {catalog}.{source_schema}.{table} AS source
    """


def planned_views(catalog: str, scoped_schema: str, gold_schema: str, silver_schema: str, ops_schema: str):
    """
    Every view this task maintains, as (name, source, DDL, filtered).

    `filtered` is false for exactly the entries in UNFILTERED_VIEWS. Carrying
    it means a caller cannot mistake one kind for the other, and a test can
    insist the false ones are the ones that were meant.
    """
    plan = []
    for table in GOLD_VIEWS:
        plan.append(
            (
                f"{catalog}.{scoped_schema}.{table}",
                f"{catalog}.{gold_schema}.{table}",
                scoped_view_ddl(catalog, scoped_schema, gold_schema, table, ops_schema),
                True,
            )
        )
    for table in SILVER_VIEWS:
        plan.append(
            (
                f"{catalog}.{scoped_schema}.{table}",
                f"{catalog}.{silver_schema}.{table}",
                scoped_view_ddl(catalog, scoped_schema, silver_schema, table, ops_schema),
                True,
            )
        )
    schemas = {"ops": ops_schema, "gold": gold_schema, "silver": silver_schema}
    for view, kind, table in UNFILTERED_VIEWS:
        plan.append(
            (
                f"{catalog}.{scoped_schema}.{view}",
                f"{catalog}.{schemas[kind]}.{table}",
                unfiltered_view_ddl(catalog, scoped_schema, view, schemas[kind], table),
                False,
            )
        )
    return plan


def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


def _has_reader_column(spark, table: str) -> bool:
    if not spark.catalog.tableExists(table):
        return False
    return any(field.name == "user_id" for field in spark.table(table).schema.fields)


def main() -> None:
    from pyspark.sql import SparkSession

    spark = SparkSession.getActiveSession()

    catalog = _argument("catalog")
    scoped_schema = _argument("scoped_schema")
    gold_schema = _argument("gold_schema")
    silver_schema = _argument("silver_schema")
    ops_schema = _argument("ops_schema")

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {catalog}.{ops_schema}")
    spark.sql(
        f"CREATE SCHEMA IF NOT EXISTS {catalog}.{scoped_schema} "
        "COMMENT 'One reader\\'s own rows. The only Gold a reader-facing surface is granted.'"
    )
    spark.sql(principals_ddl(catalog, ops_schema))

    made, skipped = [], []
    for name, source, ddl, filtered in planned_views(catalog, scoped_schema, gold_schema, silver_schema, ops_schema):
        if not filtered and _has_reader_column(spark, source):
            # A source that grew a reader column while being served unfiltered
            # would hand every reader to every reader, silently and correctly
            # as far as any query could tell.
            raise SystemExit(
                f"{source} is served unfiltered but now has a user_id column; "
                "it needs a per-reader filter or it needs to leave the scoped schema"
            )
        if not spark.catalog.tableExists(source):
            # A source the deployment has not produced yet. Reported, not
            # invented: a view over a table that does not exist would fail on
            # first read rather than here, where the reason is legible.
            skipped.append((name, source))
            continue
        spark.sql(ddl)
        made.append(name)

    print(f"scoped views maintained: {len(made)}")
    for name in made:
        print(f"  {name}")
    for name, source in skipped:
        print(f"  skipped {name}: source {source} does not exist yet")

    mapping = f"{catalog}.{ops_schema}.{PRINCIPALS_TABLE}"
    mapped = spark.sql(f"SELECT count(*) AS rows FROM {mapping}").collect()[0]["rows"]
    if mapped == 0:
        # Not a failure. An unmapped deployment serves empty views, which is the
        # correct behaviour and an easy thing to mistake for a broken pipeline.
        print(
            f"no rows in {mapping}: "
            "every scoped view returns nothing until a principal is mapped to a reader"
        )

    # One reader per principal. Two rows for the same principal naming different
    # readers would union them, and every view would keep returning "one
    # reader's own rows" while returning two readers'. Unity Catalog has no
    # unique constraint to declare this with, so it is checked, and checked
    # after the views are made rather than before: the views are correct for
    # every principal that is mapped once, and refusing to build them would
    # punish everyone for one bad row.
    conflicting = spark.sql(
        f"""
        SELECT lower(principal) AS principal, count(DISTINCT user_id) AS readers
        FROM {mapping}
        GROUP BY lower(principal)
        HAVING count(DISTINCT user_id) > 1
        """
    ).collect()
    if conflicting:
        for row in conflicting:
            print(f"  {row['principal']} is mapped to {row['readers']} readers")
        raise SystemExit(
            f"{len(conflicting)} principal(s) in {mapping} map to more than one reader; "
            "the scoped views would return both"
        )


if __name__ == "__main__":
    main()
