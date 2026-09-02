# Marginalia intelligence bundle

Declarative Automation Bundle for the Databricks side of
[the intelligence plan](../docs/databricks-intelligence-plan.md). Phase 1 covers
authenticated ingress to Bronze; Phase 2 adds deterministic Silver identity,
highlights, and reading sessions; Phase 3 adds extraction and the first Gold
profiles; Phase 4 adds the serving loop, Lakebase, the App, and cloud deletion;
Phase 6 adds targeted public sources, frontier, and recommendations.

## What is here

```text
databricks.yml                   bundle, variables, dev and prod targets
resources/catalog.yml            the bronze/silver/gold/ops schemas
resources/events_ingestion.yml   triggered pipeline and its 15-minute schedule
resources/events_silver.yml      parsing, deduplication, state, and sessions
resources/concepts_gold.yml      engagement, interest, and frontier profiles
resources/serving.yml            Lakebase, synced tables, warehouse, and the App
resources/deletion.yml           the cloud deletion job and the replay purge
src/events_ingestion.py          Kafka source that writes events_raw
src/events_silver.py             Bronze quarantine and Silver materialized views
src/concepts.py                  canonicalization, response validation, scoring
src/concept_extraction.py        incremental extraction job, keyed by content hash
src/gold_profiles.py             book_engagement and reader_interest_profile
src/public_matching.py           work matching and the Phase 6 score formulas
src/public_sources.py            Open Library matching, targeted OpenAlex enrichment
src/frontier.py                  intellectual_frontier and recommendation_candidates
src/serving_sync.py              triggers the Lakebase synced tables and waits
src/deletion.py                  cloud deletion, its manifest, and verification
src/app/                         the Databricks App the Cloudflare Worker calls
```

The App is the only thing outside the workspace that can read a reader's
profile. It has four routes, no UI, and no second caller: the Worker
authenticates as one service principal, and the App refuses every request when
it has not been told which one that is.

`public_sources.py` also maintains `public_request_subjects`, the user-to-request
index used for cache eligibility and eventual cloud deletion of raw provider
requests.

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

6. Create the service principal the Cloudflare Worker authenticates as, and give
   it an OAuth secret. This is the only identity the App will answer, and it
   holds nothing else in the workspace.

   ```sh
   databricks service-principals create --display-name marginalia-worker
   databricks service-principal-secrets create <service-principal-id>
   ```

   Its application id becomes the `app_caller_service_principal` bundle variable
   and the App's `MARGINALIA_TRUSTED_CALLER`. The client id and secret become
   Worker secrets, alongside the App URL and the workspace token endpoint:

   ```sh
   wrangler secret put DATABRICKS_APP_URL
   wrangler secret put DATABRICKS_OAUTH_TOKEN_URL
   wrangler secret put DATABRICKS_CLIENT_ID
   wrangler secret put DATABRICKS_CLIENT_SECRET
   ```

   The token endpoint is `https://<workspace-host>/oidc/v1/token`. None of these
   four values is committed, and none reaches the browser.

7. Grant, after the first deploy of the App. Both grants need identities that do
   not exist until their resources do: the App gets its own service principal
   when it is created, and the caller's `CAN USE` cannot precede the App.

   ```sh
   # Only CAN_USE. The caller may invoke the App and manage nothing.
   databricks apps set-permissions marginalia-intelligence-dev --json '{
     "access_control_list": [{
       "service_principal_name": "<caller-application-id>",
       "permission_level": "CAN_USE"
     }]
   }'
   ```

   The App's own service principal needs to read the deletion request table and
   nothing else in Unity Catalog. Everything it serves to the browser comes from
   Postgres, not from the catalog:

   ```sql
   GRANT USE CATALOG ON CATALOG marginalia_dev TO `<app-service-principal>`;
   GRANT USE SCHEMA ON SCHEMA marginalia_dev.dev_<you>_marginalia_ops TO `<app-service-principal>`;
   GRANT SELECT, MODIFY ON TABLE marginalia_dev.dev_<you>_marginalia_ops.deletion_requests
     TO `<app-service-principal>`;
   ```

   No grant on Bronze, Silver, or Gold. An App that could read Gold directly
   would be an App whose blast radius is every reader's text rather than one
   reader's scores.

   Unity Catalog grants say nothing about Postgres. A synced table is readable
   by its owning role only, so the App's role needs to be told, once, inside the
   database:

   ```sh
   databricks psql marginalia-lakebase-dev
   ```

   ```sql
   GRANT USAGE ON SCHEMA marginalia_gold TO "<app-service-principal>";
   GRANT SELECT ON ALL TABLES IN SCHEMA marginalia_gold TO "<app-service-principal>";
   ALTER DEFAULT PRIVILEGES IN SCHEMA marginalia_gold
     GRANT SELECT ON TABLES TO "<app-service-principal>";
   ```

   The default-privileges line is what stops a later synced table from being
   invisible to an App that could read the two before it. `SELECT` only: the
   synced tables are read-only copies, and the App has no reason to write to
   one.

No bootstrap step is needed for the deletion request table. The job owns it and
creates it on its first run, and the App creates it too, because the first
request is written before any run has happened. Both definitions are identical
and a contract test keeps them that way.

## Deploying

```sh
databricks bundle validate -t dev
databricks bundle deploy -t dev \
  --var="app_caller_service_principal=<application-id>" \
  --var="ops_warehouse_id=<warehouse-id>"
```

The warehouse is referenced rather than created. A workspace already has one, an
account on free usage is capped at one, and a warehouse outlives any single
bundle.

`dev` deploys into the `marginalia_dev` catalog, `prod` into `marginalia`.

Run one update on demand:

```sh
databricks bundle run events_ingestion -t dev
```

The concept model is the `concept_endpoint` bundle variable, defaulting to
`databricks-gpt-oss-120b`. The plan originally locked a `luna` endpoint, which
this workspace does not serve; the decision and the reason are recorded in
[the feedback log](../docs/databricks-feedback.md). Point it somewhere else with
`--var concept_endpoint=...` rather than editing extraction code.

Extraction is a job task and not a pipeline, because a materialized view is
recomputed when its source changes and would call the model again for text that
has not changed. It is keyed by the hash of the content it read, so unchanged
content is never paid for twice, and each run takes at most
`extraction_batch_limit` candidates.

Public sources are asked about a book only when its reader shared metadata,
and asked about a concept only when that reader already has interest in it.
Nothing is mirrored. Every response lands in `public_sources_raw` with its URL,
status, retrieval time, parser version, and licence, so a parser change is
re-run from what was already fetched rather than by asking again. A failed
request is a row too: an outage has to be visible rather than look like an
absence of results.

`public_contact` is sent to both providers, which ask callers to identify
themselves and rate limit anonymous traffic harder. It is not a credential.
Set it to a real address before running against production.

An ambiguous match attaches nothing. Two candidate works that title and author
cannot tell apart stay unresolved with their candidates recorded, because a
wrong work quietly poisons every recommendation built on top of it.

Requests default to at least three seconds apart, matching Open Library's
published ceiling of 100 requests per five minutes. A provider throttle stops
the remainder of that provider's batch after the response is recorded. ETags
make repeated URLs conditional, and OpenAlex enrichment is eligible for refresh
only after `public_enrichment_ttl_days` (30 by default). Override cadence through
bundle variables instead of editing the job.

Run the live concept evaluation by hand when the prompt, the model, or the
canonicalization version changes. It is deliberately outside `npm test`, which
has to pass offline and deterministically:

```sh
python3 databricks/eval/concept_eval.py --endpoint databricks-gpt-oss-120b
```

## The serving loop

Gold is recomputed in the workspace; the browser reads a copy of it. Between the
two sit two triggered Lakebase synced tables, keyed exactly as the plan
documents:

```text
reader_interest_profile   (user_id, concept_id)
book_engagement           (user_id, book_id)
```

Both are snapshot syncs. A triggered sync reads the source's change feed, and a
materialized view cannot publish one: it accepts `delta.enableChangeDataFeed`
and ignores it, and the sync then fails outright rather than degrading. A
snapshot re-copies the table each run, which for one reader's profile costs
nothing worth optimizing. `sync_serving` is the last task of
the 15-minute job rather than a schedule of its own: a Gold table that has been
recomputed but not synced is not yet something a reader can see, and the
freshness objective is measured to the browser.

`serving_sync.py` waits for the sync to settle and fails on a timeout. A task
that returned early would let the deletion job verify absence against a copy
that still held the reader.

The App reads Postgres, never Gold. It authenticates to Lakebase with a
short-lived OAuth token, cached until shortly before it expires, and it answers
only the caller named in `MARGINALIA_TRUSTED_CALLER`. Deploy it with the caller's
application id:

```sh
databricks bundle deploy -t dev --var="app_caller_service_principal=<application-id>"
databricks bundle run intelligence -t dev
```

Deployed without that variable the App starts and refuses every request with
`caller_not_configured`. That is deliberate. An App that served a profile
because nobody had said who was allowed to read it would be the exact failure
the check exists to prevent.

## Cloud deletion

`marginalia-cloud-deletion` takes a request id and runs in two halves with the
pipeline refreshes in between:

```text
purge              delete the reader from every directly written table
recompute_*        full-refresh Silver, Gold, and frontier
sync_serving       push the recomputed rows into Lakebase and wait
verify             count the reader in every manifest table, then record
```

The manifest is versioned (`deletion_manifest_v1`) and splits into tables that
are deleted from and materialized views that are recomputed. A table the
deployment never created is recorded as absent rather than counted as empty,
because "0 rows" would imply it had been checked.

Bronze is never full-refreshed. It is a streaming table over a topic that
retains seven days, so a full refresh would re-ingest the reader the purge just
removed. Instead the Silver parse step drops rows for any reader with a deletion
in flight, and `marginalia-deletion-replay-purge` sweeps nightly until the
retention window has passed. Until then the request stays `purging_source`,
which the App reports to the browser as still running: the reader is gone from
every queryable layer, and the source can no longer be replayed only once the
window closes.

Run one by hand:

```sh
databricks bundle run cloud_deletion -t dev --params request_id=<uuid>
```

## Phase 4 acceptance

Each of these is a line in the plan's acceptance list, and each is checked
against the deployment rather than against the code.

```sh
# An interest profile is queryable by its documented primary key.
databricks api post /api/2.0/sql/statements --json '{
  "warehouse_id": "<ops-warehouse-id>",
  "statement": "SELECT count(*) FROM marginalia_serving_dev.marginalia_gold.reader_interest_profile WHERE user_id = :user AND concept_id = :concept",
  "wait_timeout": "50s"
}'

# An unauthorized service principal cannot read it: expect 403 untrusted_caller.
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OTHER_SP_TOKEN" \
  "$APP_URL/api/v1/users/$USER_ID/interest-profile"

# An invalid sync token cannot reach the Worker: expect 401 invalid_token.
curl -s -H 'Authorization: Bearer wrong' \
  https://<worker-host>/api/intelligence/v1/interest-profile
```

The 35-minute freshness run is one event timed end to end. Emit a fixture
highlight from an opted-in browser, note its `eventTime`, and wait for it to
appear in Insights. Bronze is at most 15 minutes behind, the rest of the job is
one pass, and the sync is the last task, so a run that exceeds 35 minutes is a
finding rather than variance. Record the result in
[the feedback log](../docs/databricks-feedback.md).

For deletion, ask from Settings and then check every layer named in the manifest,
the synced tables, and the Worker's own `SYNC_CONTROL`. The request should read
`purging_source` immediately and `completed` only after the topic's retention
window has elapsed.

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
