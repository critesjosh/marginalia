# Marginalia intelligence bundle

Declarative Automation Bundle for the Databricks side of
[the intelligence plan](../docs/databricks-intelligence-plan.md). Phase 1 covers
authenticated ingress to Bronze; Phase 2 adds deterministic Silver identity,
highlights, and reading sessions.

## What is here

```text
databricks.yml                   bundle, variables, dev and prod targets
resources/catalog.yml            the bronze/silver/gold/ops schemas
resources/events_ingestion.yml   triggered pipeline and its 15-minute schedule
resources/events_silver.yml      parsing, deduplication, state, and sessions
src/events_ingestion.py          Kafka source that writes events_raw
src/events_silver.py             Bronze quarantine and Silver materialized views
```

Nothing in this directory names a workspace, a credential, or a private resource
id. The host comes from your Databricks CLI profile or `DATABRICKS_HOST`.

## Prerequisites

The workspace needs Unity Catalog and serverless compute. The Structured
Streaming Kafka source is generally available, so there is no preview to enable.

Creating the catalog and the secret scope needs metastore privileges a workspace
service principal does not hold by default; run those steps as a user with
metastore admin rights.

The identity that deploys the bundle also needs `USE CATALOG` plus ownership or
the corresponding create privileges on all four target schemas. Bundle
validation can succeed for an identity that cannot deploy, because deployment
must read and reconcile the existing Unity Catalog objects.

## Steps that stay outside the bundle

The secret scope holds the SASL credentials, so it is created by hand and only
referenced here by name.

1. Create the Confluent topic `marginalia.events.v1` with one partition,
   `cleanup.policy=delete`, and seven-day retention (`retention.ms=604800000`).
   One partition is what makes the per-installation event ordering the Worker
   enforces hold all the way to Bronze.
2. Create two service accounts with narrow ACLs rather than one shared key, so a
   leaked Worker secret can append to one topic and do nothing else.

   ```sh
   confluent kafka topic create marginalia.events.v1 \
     --partitions 1 --config cleanup.policy=delete,retention.ms=604800000

   confluent iam service-account create marginalia-worker --description "produce only"
   confluent api-key create --resource <lkc-id> --service-account <sa-worker>
   confluent kafka acl create --allow --service-account <sa-worker> \
     --operations write,describe --topic marginalia.events.v1
   ```

   The Databricks account is the same shape with `read` in place of `write`, plus
   the consumer group the Kafka source uses:

   ```sh
   confluent kafka acl create --allow --service-account <sa-databricks> \
     --operations read,describe --topic marginalia.events.v1
   confluent kafka acl create --allow --service-account <sa-databricks> \
     --operations read,describe --consumer-group <prefix> --prefix
   ```

   Run these while logged in to Confluent Cloud. The CLI's `acl create` flags
   differ between the Cloud and on-prem contexts, and `confluent kafka acl create
   --help` shows the on-prem set (`--operation`, singular) until you log in.

   The group id the Spark Kafka source picks is not documented. Start with a
   broad prefix, run the dev pipeline once, read the group id it actually used
   from the Confluent console, then narrow the prefix to match.

   `CONFLUENT_CLUSTER_ID` is the `lkc-` id and `CONFLUENT_REST_ENDPOINT` is the
   cluster's HTTPS endpoint; the secret scope below needs the `:9092` bootstrap
   address instead, because Databricks reads over the native protocol.
3. Create the secret scope the pipeline reads. The read-only Confluent key goes
   here and nowhere else; it is never a Worker secret, because the Worker only
   ever produces. Unity Catalog service credentials are not an option: they
   support Amazon MSK, not Confluent Cloud.

   ```sh
   databricks secrets create-scope marginalia_kafka
   printf %s "$KAFKA_BOOTSTRAP_SERVERS"      | databricks secrets put-secret marginalia_kafka bootstrap-servers
   printf %s "$DATABRICKS_KAFKA_API_KEY"     | databricks secrets put-secret marginalia_kafka api-key
   printf %s "$DATABRICKS_KAFKA_API_SECRET"  | databricks secrets put-secret marginalia_kafka api-secret
   ```

   Piping the values keeps them out of shell history and out of the process
   list. The bootstrap address is the `:9092` SASL_SSL endpoint, not the `:443`
   REST endpoint the Worker uses. It is stored alongside the credentials so that
   no private host appears in a committed file. Once the scope exists, remove the
   values from any local file.

4. Set the matching Worker secrets from the repository root:

   ```sh
   wrangler secret put CONFLUENT_REST_ENDPOINT
   wrangler secret put CONFLUENT_CLUSTER_ID
   wrangler secret put CONFLUENT_API_KEY
   wrangler secret put CONFLUENT_API_SECRET
   wrangler secret put MARGINALIA_SYNC_TOKEN_SHA256
   wrangler secret put MARGINALIA_TRUSTED_USER_ID
   ```

   The sync token is generated here, not issued by any service. The Worker
   stores only its digest; the token itself is pasted into Settings in the
   browser and kept nowhere else.

   ```sh
   SYNC_TOKEN=$(openssl rand -hex 32)
   printf %s "$SYNC_TOKEN" | openssl dgst -sha256 -hex
   ```

   `MARGINALIA_TRUSTED_USER_ID` is a stable id you choose, such as `uuidgen`.
   The Worker stamps it onto every event, which is why a browser-supplied user
   id is rejected outright.

5. Create the catalog. It is not a bundle resource: on an account with Default
   Storage the catalogs REST API refuses to create one without an explicit
   storage root, while the same statement over a SQL warehouse succeeds.

   ```sh
   databricks api post /api/2.0/sql/statements --json '{
     "warehouse_id": "<warehouse-id>",
     "statement": "CREATE CATALOG IF NOT EXISTS marginalia_dev",
     "wait_timeout": "50s"
   }'
   ```

## Deploying

```sh
databricks bundle validate -t dev
databricks bundle deploy -t dev
```

`dev` deploys into the `marginalia_dev` catalog, `prod` into `marginalia`.

Run one update on demand:

```sh
databricks bundle run events_ingestion -t dev
```

Refresh Silver after Bronze independently when debugging transformations:

```sh
databricks bundle run events_silver -t dev
```

The pipeline is triggered, not continuous. An update reads from the offset the
previous update committed, ingests the backlog, and stops, so it bills only
while it is working. A companion job runs it every 15 minutes; development mode
deploys that schedule paused, so dev updates only when you ask for one.

Bronze freshness is therefore the schedule interval. Shortening it shortens the
end-to-end freshness objective and raises cost proportionally. Seven-day topic
retention means an update that resumes within that window still catches up.
After a longer gap, expired committed offsets make the next update fail rather
than silently skipping records; restore from a retained source or accept the
explicit gap before restarting from the earliest available offset.
