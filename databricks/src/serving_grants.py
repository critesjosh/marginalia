"""
Let the App read the synced tables. Every one of them, including the next one.

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

So this runs after the syncs, every time, and grants what exists rather than
what existed when somebody last wrote the grants down by hand.

It is idempotent and additive. It grants SELECT and nothing else: the synced
tables are read-only copies of Gold, and an App that could write to one would be
an App that could disagree with the pipeline.
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


INSTANCE = _argument("instance")
DATABASE = _argument("database")
SCHEMA = _argument("schema")
# The App's own service principal, which is the Postgres role it connects as.
# Supplied at deploy because it names private infrastructure, and empty means
# there is nobody to grant to rather than everybody.
READERS = [value.strip() for value in _argument("readers", "").split(",") if value.strip()]


def main() -> None:
    if not READERS:
        print("no reader roles given, so nothing to grant")
        return

    import psycopg
    from databricks.sdk import WorkspaceClient

    client = WorkspaceClient()
    instance = client.database.get_database_instance(name=INSTANCE)
    credential = client.database.generate_database_credential(
        request_id=str(uuid.uuid4()), instance_names=[INSTANCE]
    )

    # As the deploying identity, which owns the schema. A grant can only be made
    # by somebody who has the privilege to give away.
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
        tables = [row[0] for row in cursor.fetchall()]
        print(f"{len(tables)} table(s) in {SCHEMA}: {tables}")

        missing = []
        for role in READERS:
            # Identifiers cannot be parameterised, so they are quoted rather
            # than interpolated raw. A role name here comes from a bundle
            # variable, not from a request.
            quoted = '"' + role.replace('"', '""') + '"'
            try:
                cursor.execute(f"GRANT USAGE ON SCHEMA {SCHEMA} TO {quoted}")
                cursor.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA {SCHEMA} TO {quoted}")
                # Still worth setting: it covers anything this identity creates
                # later, and costs nothing beside the explicit grant above.
                cursor.execute(
                    f"ALTER DEFAULT PRIVILEGES IN SCHEMA {SCHEMA} GRANT SELECT ON TABLES TO {quoted}"
                )
            except psycopg.errors.UndefinedObject:
                # Not every service principal has a Postgres role. The
                # Observatory reads Gold through a warehouse and has never
                # connected to Lakebase, so naming it here is a mistake in the
                # variable rather than a reason to leave the App ungranted.
                missing.append(role)
                continue
            print(f"granted SELECT on {len(tables)} table(s) in {SCHEMA} to {role}")

        if missing:
            # Reported rather than raised: the grants that could be made were,
            # and a task that failed here would leave them made and look failed.
            print(f"no Postgres role for: {missing}. Nothing was granted to them.")


if __name__ == "__main__":
    main()
