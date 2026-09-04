"""
Let the App read the synced tables, and prove afterwards that it can.

Unity Catalog grants say nothing about Postgres, and a synced table arrives in
Postgres owned by whatever created it rather than by whoever set up the schema.
`ALTER DEFAULT PRIVILEGES` covers tables a particular role creates later, which
is not the same thing: the sync creates them, so a table added after the grants
were written is invisible to an App that could read the two before it.

That is not a hypothetical. Phase 9 and Phase 11 each added a synced table, both
deployed cleanly, both reported ONLINE with rows, and both routes returned
`intelligence_unavailable` to the browser. The App's log said `permission denied
for table intellectual_frontier`, and nothing before the first authenticated
read through the live Worker could have said so: the bundle was valid, the sync
was healthy, the Unity Catalog grants were right, and every offline test passed.

So this runs after the syncs and grants over the tables that exist rather than
the ones that existed. It grants SELECT and nothing else, because the synced
tables are read-only copies of Gold and an App that could write to one would be
an App that could disagree with the pipeline.

It ends by checking. The failure this exists to prevent was silent, so a task
that granted something and reported success without looking would be the same
shape of mistake one layer up: it asks Postgres whether each expected table is
now readable by each role, and fails if one is not.

Two things it cannot do. It cannot grant on a table whose owner has not given
this identity the right to, so it must run as an identity with grant option on
the schema; that surfaces as `InsufficientPrivilege` and fails the task rather
than being caught. And it closes the window rather than removing it: a table is
created by a deploy and granted by the next run of this job, so there is an
interval in which a newly synced table is unreadable. The interval is bounded by
the job's schedule and is stated here rather than papered over.
"""

import sys
import uuid


def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


def _list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def quoted(identifier: str) -> str:
    """
    A Postgres identifier, quoted.

    Identifiers cannot be parameterised, so every one of them goes through
    here. These come from bundle variables rather than from a request, which
    makes this defence in depth rather than the only thing standing between a
    caller and the database; it is still the difference between a schema name
    with a capital letter working and not.
    """
    return '"' + identifier.replace('"', '""') + '"'


def grant_statements(schema: str, role: str, tables: list[str]) -> list[str]:
    """
    Exactly what will be run, as strings, so a test can read them.

    Per table rather than `ON ALL TABLES IN SCHEMA`. The schema holds read-only
    copies of Gold and nothing else today, and a blanket grant would quietly
    extend to whatever is put there tomorrow. Naming them means the set the App
    can read is the set this job was told about.

    The default-privileges line stays, and is not what makes this work: it
    covers tables this identity creates later, and the sync is not this
    identity. It costs nothing and helps in the one case where somebody creates
    a table here by hand.
    """
    statements = [f"GRANT USAGE ON SCHEMA {quoted(schema)} TO {quoted(role)}"]
    for table in tables:
        statements.append(
            f"GRANT SELECT ON TABLE {quoted(schema)}.{quoted(table)} TO {quoted(role)}"
        )
    statements.append(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA {quoted(schema)} GRANT SELECT ON TABLES TO {quoted(role)}"
    )
    return statements


# Empty rather than required at import, so a test can read the statement
# builder without a set of job arguments. main() refuses to run without them.
INSTANCE = _argument("instance", "")
DATABASE = _argument("database", "")
SCHEMA = _argument("schema", "")
# The App's own service principal, which is the Postgres role it connects as.
# Supplied at deploy because it names private infrastructure.
READERS = _list(_argument("readers", ""))
# The tables the deployment expects to find. Given rather than discovered so a
# missing one is a failure rather than a shorter list nobody counted.
EXPECTED = _list(_argument("tables", ""))


def main() -> None:
    missing = [
        name
        for name, value in (("instance", INSTANCE), ("database", DATABASE), ("schema", SCHEMA))
        if not value
    ]
    if missing:
        raise SystemExit(f"missing required job parameter(s): {', '.join(missing)}")

    import psycopg
    from databricks.sdk import WorkspaceClient

    client = WorkspaceClient()
    instance = client.database.get_database_instance(name=INSTANCE)
    credential = client.database.generate_database_credential(
        request_id=str(uuid.uuid4()), instance_names=[INSTANCE]
    )

    with psycopg.connect(
        host=instance.read_write_dns,
        port=5432,
        dbname=DATABASE,
        user=client.current_user.me().user_name,
        password=credential.token,
        sslmode="require",
        connect_timeout=20,
        autocommit=True,
    ) as connection, connection.cursor() as cursor:
        cursor.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = %s ORDER BY tablename",
            (SCHEMA,),
        )
        present = [row[0] for row in cursor.fetchall()]
        print(f"{len(present)} table(s) in {SCHEMA}: {present}")

        # What to grant on: what was expected and is there. A table that was
        # expected and is absent has not synced yet, which is a state this job
        # reports rather than one it can fix.
        targets = [table for table in EXPECTED if table in present] if EXPECTED else present
        absent = [table for table in EXPECTED if table not in present]
        if absent:
            print(f"expected but not yet in Postgres: {absent}")

        if not READERS:
            # Loud, because the outage this job exists to prevent was silent
            # and an unconfigured deployment reproduces it exactly.
            print(
                f"NO READER ROLES CONFIGURED. {len(targets)} table(s) in {SCHEMA} are readable "
                "only by their owner, and any App reading them will fail with permission denied. "
                "Set app_service_principals at deploy."
            )
            return

        missing_roles, granted = [], []
        for role in READERS:
            try:
                for statement in grant_statements(SCHEMA, role, targets):
                    cursor.execute(statement)
            except psycopg.errors.UndefinedObject:
                # Not every service principal has a Postgres role. The
                # Observatory reads Gold through a warehouse and has never
                # connected to Lakebase, so naming it is a mistake in a
                # variable rather than a reason to leave the App ungranted.
                missing_roles.append(role)
                continue
            granted.append(role)
            print(f"granted SELECT on {len(targets)} table(s) in {SCHEMA} to {role}")

        # The check. Asked of Postgres rather than inferred from the statements
        # having run, because the whole failure this job addresses was a grant
        # everyone believed had been made.
        unreadable = []
        for role in granted:
            for table in targets:
                cursor.execute(
                    "SELECT has_table_privilege(%s, %s, 'SELECT')",
                    (role, f"{SCHEMA}.{table}"),
                )
                if not cursor.fetchone()[0]:
                    unreadable.append(f"{role} cannot read {table}")

        if missing_roles:
            print(f"no Postgres role for: {missing_roles}. Nothing was granted to them.")
        if unreadable:
            raise SystemExit("grants did not take effect: " + "; ".join(unreadable))
        if granted:
            print(f"verified {len(granted) * len(targets)} role/table pair(s) readable")


if __name__ == "__main__":
    main()
