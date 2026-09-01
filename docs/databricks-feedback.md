# Databricks feedback

Use this file to record feedback from hands-on Databricks work on Marginalia. Append
new entries in reverse chronological order, directly below this introduction.

Do not include access tokens, passwords, connection strings, private URLs, customer
data, or other secrets.

## Entries

### 2026-09-01: Phase 1 preflight and events ingestion bundle

- Surface used: CLI (`databricks auth describe`, `catalogs`, `warehouses`, `connections`,
  `bundle validate`), Unity Catalog, Lakeflow Connect managed Kafka connector
- Goal: verify the Phase 1 capability gate and define the Bronze ingestion bundle
- Result: Unity Catalog metastore and a serverless SQL warehouse are present, and the
  workspace recognizes Unity Catalog connections of type `KAFKA`, so the managed Kafka
  connector Beta is available. `databricks bundle validate` passes for both the `dev`
  and `prod` targets of `databricks/`.
- Friction:
  - The Kafka connector docs describe a Catalog Explorer flow only. Neither the connector
    page nor the "Create a Kafka connection" page gives the `CREATE CONNECTION` option
    keys, so the option names had to be discovered from validation errors: the type needs
    `bootstrap_servers`, `sasl_mechanism`, `user`, and `password` (camelCase spellings are
    rejected). A documented option table would have saved the round trips.
  - The bundle schema enum for `schema_evolution_mode` is upper case (`RESCUE`), while the
    documented pipeline example uses lower case (`rescue`). `bundle validate` reports this
    as a warning rather than an error, so a copied example deploys with an invalid value.
  - `GET /api/2.0/previews` returns `Not Found`, so there is no scriptable way to confirm
    a preview is enabled. Probing a connection create was the only check available.
- Workaround or follow-up: the Kafka connection is created outside the bundle so its SASL
  credentials never reach a committed variable; the bundle refers to it by name through
  the `kafka_connection_name` variable.

### 2026-09-01: Phase 1 deployment to the dev target

- Surface used: Databricks CLI (bundles, Unity Catalog, SQL statements), pipelines API
- Goal: create the Kafka connection, then deploy the catalog, schemas, and ingestion
  pipeline to the `dev` target.
- Result: the connection and all four schemas were created. The catalog and the pipeline
  both failed on their first attempt and needed changes to the bundle.
- Friction:
  - `resources.catalogs` fails on an account with Default Storage: the catalogs REST API
    returns `INVALID_STATE` asking for an explicit storage root, and the message says to
    use the UI. `CREATE CATALOG` over a SQL warehouse succeeds with no storage root on the
    same account, so a supported path exists that the bundle cannot reach. Catalog creation
    had to move out of the bundle.
  - Managed Kafka ingestion pipelines reject `continuous: false` with
    `INVALID_PARAMETER_VALUE`. This is not stated on the connector page, and it removes the
    option of an on-demand development pipeline, so a dev target bills the same as prod.
    A cheap development mode for managed ingestion would help, as would documenting the
    constraint next to the connector's other requirements.
  - Creating the connection needs `CREATE CONNECTION` on the metastore. A workspace service
    principal does not have it by default, and the error names the privilege but not where
    to grant it.
- Workaround or follow-up: the catalog is created by SQL as a documented operator step
  alongside the Kafka connection; the pipeline is pinned to `continuous: true` and the
  now-meaningless `ingestion_continuous` variable was removed.

### 2026-09-01: switching Bronze ingestion to a Structured Streaming Kafka source

- Surface used: Lakeflow pipelines, Databricks secret scopes, system billing tables
- Goal: replace the managed Kafka connector with a triggered pipeline, because the
  connector's mandatory continuous mode bills for an always-running cluster whatever the
  event volume.
- Result: the triggered pipeline ingests the same topic into `events_raw` and stops. A
  second update after one new record ingested only that record, leaving seven rows across
  seven distinct offsets, so offsets commit and resume correctly.
- Friction:
  - Unity Catalog service credentials for Kafka cover Amazon MSK only. A Confluent Cloud
    cluster still needs SASL/PLAIN with `kafka.sasl.jaas.config`, so the credential moves
    from a Unity Catalog connection to a secret scope and the connection object becomes
    unusable. Supporting any SASL cluster through a Unity Catalog connection would keep
    one credential story instead of two.
  - The pipelines Python module was renamed: `import dlt` is superseded by
    `from pyspark import pipelines as dp`, and the language reference moved from
    `/ldp/python-ref` to `/ldp/developer/python-ref`, which now 404s at the old path.
  - Serverless pipeline DBU consumption is not published on the pricing page, which loads
    its rates dynamically, and `system.billing.list_prices` exposes many plausible SKUs
    without indicating which one a serverless pipeline draws from. Estimating the cost of
    a continuous pipeline before running one was not possible from documentation alone.
- Workaround or follow-up: credentials and the bootstrap address live in the
  `marginalia_kafka` secret scope; the pipeline reads them with `dbutils.secrets.get`. A
  companion job triggers the pipeline every 15 minutes, paused in development.

## Entry template

### YYYY-MM-DD: short task name

- Surface used: CLI, API, workspace UI, job, pipeline, SQL warehouse, Lakebase,
  Model Serving, Databricks App, or another Databricks surface
- Goal: what you tried to accomplish
- Result: what worked and what did not
- Friction: errors, unclear behavior, missing documentation, or "none"
- Workaround or follow-up: what helped or what should change next
