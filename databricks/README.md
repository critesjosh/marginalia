# Marginalia intelligence bundle

Declarative Automation Bundle for the Databricks side of
[the intelligence plan](../docs/databricks-intelligence-plan.md). Phase 1 covers
authenticated ingress to Bronze; Phase 2 adds deterministic Silver identity,
highlights, and reading sessions; Phase 3 adds extraction and the first Gold
profiles; Phase 4 adds the serving loop, Lakebase, the App, and cloud deletion;
Phase 6 adds targeted public sources, frontier, and recommendations; Phase 7
adds the Observatory, an AI/BI dashboard, a curated Genie space, and the
per-reader views all three read through; Phase 8 adds the Librarian, its
retrieval index, and the evaluation that decides whether it may be deployed;
Phase 9 adds recommendation outcomes and the gate that keeps a learned ranker
from being trained on too few of them; Phase 11 adds the read-only MCP surface,
which lives in the Cloudflare Worker rather than here.

Phase 10 is not here and cannot be: the gate blocks it until real feedback
accumulates, and the binding constraint is eight weeks of outcomes.

## What is here

```text
databricks.yml                   bundle, variables, dev and prod targets
resources/catalog.yml            the bronze/silver/gold/ops/scoped schemas
resources/events_ingestion.yml   triggered pipeline and its 15-minute schedule
resources/events_silver.yml      parsing, deduplication, state, and sessions
resources/concepts_gold.yml      engagement, interest, and frontier profiles
resources/serving.yml            Lakebase, synced tables, warehouse, and the App
resources/deletion.yml           the cloud deletion job and the replay purge
resources/observatory.yml        the Observatory app, dashboard, and Genie space
resources/librarian.yml          the retrieval index, the model, and its job
src/events_ingestion.py          Kafka source that writes events_raw
src/events_silver.py             Bronze quarantine and Silver materialized views
src/concepts.py                  canonicalization, response validation, scoring
src/concept_extraction.py        incremental extraction job, keyed by content hash
src/gold_profiles.py             book_engagement and reader_interest_profile
src/public_matching.py           work matching and the Phase 6 score formulas
src/public_sources.py            Open Library matching, targeted OpenAlex enrichment
src/frontier.py                  intellectual_frontier and recommendation_candidates
src/reader_scope.py              the per-reader views and the principal mapping
src/readiness_gate.py            whether enough feedback exists to train a ranker
src/librarian.py                 the Librarian's rules, with no network in them
src/librarian_agent.py           the served agent: retrieval, one call, tracing
src/librarian_passages.py        the retrieval source table and its index sync
src/librarian_deploy.py          logs, registers, and serves a model version
src/librarian_evaluation.py      the live evaluation, on synthetic readers
src/serving_sync.py              triggers the Lakebase synced tables and waits
src/serving_grants.py            grants and then verifies the App's Postgres reads
src/deletion.py                  cloud deletion, its manifest, and verification
src/app/                         the Databricks App the Cloudflare Worker calls
src/observatory/                 the Observatory app and every query it runs
dashboards/                      the AI/BI dashboard definition
genie/                           the Genie space instructions
eval/concept_eval.py             the live concept evaluation, run by hand
eval/genie_questions.json        fixed questions, their grain, and their checks
eval/genie_eval.py               runs those questions, and asks Genie the same ones
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
   by its owning role only, so the App's role has to be told inside the
   database. That is `serving_grants.py`, a task in the fifteen-minute job
   rather than a step somebody remembers: pass the App's service principal as
   `app_service_principals` at deploy and it runs after both syncs, whether or
   not they succeeded, because one sync failing does not make the table the
   other created readable.

   It closes the window rather than removing it. A table is created by a deploy
   and granted by the next run of the job, so there is an interval, bounded by
   the schedule, in which a newly synced table is unreadable. It also ends by
   asking Postgres `has_table_privilege` for every role and table it was told
   about and failing if one is not readable, because the failure it exists to
   prevent was a grant everyone believed had been made.

   A deployment that sets no reader roles says so loudly rather than succeeding
   quietly: an unconfigured one reproduces the original outage exactly. And the
   task must run as an identity with grant option on the schema; without it the
   run fails with `InsufficientPrivilege` rather than being caught.

   ```sql
   GRANT USAGE ON SCHEMA marginalia_gold TO "<app-service-principal>";
   GRANT SELECT ON ALL TABLES IN SCHEMA marginalia_gold TO "<app-service-principal>";
   ALTER DEFAULT PRIVILEGES IN SCHEMA marginalia_gold
     GRANT SELECT ON TABLES TO "<app-service-principal>";
   ```

   It is a task and not a one-time step because the third line does not cover a
   synced table. Default privileges apply to tables a particular role creates
   later, and a synced table is created by the sync, so a table added after the
   grants were written is invisible to an App that could read the ones before
   it. Phase 9 and Phase 11 each added one, and each returned
   `intelligence_unavailable` to the browser while the bundle validated, the
   sync reported ONLINE with rows, and every offline test passed. The App's log
   said `permission denied for table intellectual_frontier`, and nothing
   earlier in the chain could have.

   `SELECT` only: the synced tables are read-only copies, and the App has no
   reason to write to one. A service principal with no Postgres role, like the
   Observatory's, is reported and skipped rather than failing the task: it reads
   Gold through a warehouse and has never connected to Lakebase.

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

## Recommendation feedback, and the gate

Five outcomes per recommendation: shown, opened, dismissed, added, started. They
land in `marginalia_silver.recommendation_outcomes`, one row per event rather
than one per candidate, because an impression and a dismissal of the same work
are two facts at two times and the order they happened in is the whole of what
a ranker would learn from.

Every one carries the candidate's Open Library work key and the score version
that produced the recommendation. An outcome without that version cannot be
told apart from an outcome under a different formula, which is the difference
between a dataset and a pile of clicks. None of it is book text, so these events
need `syncEnabled` and no content consent at all.

`readiness_gate.py` runs on the fifteen-minute schedule and answers the plan's
six questions: 500 impressions, 50 positive outcomes, 50 explicit negatives, 20
distinct candidates, eight weeks of outcomes, and a fifth of them in a temporal
holdout. It writes every assessment to `marginalia_ops.recommender_readiness`.

```sh
databricks api post /api/2.2/jobs/run-now --json '{
  "job_id": <events-ingestion-schedule>, "only": ["recommender_readiness"]
}'
```

Two deliberate choices. The holdout is temporal rather than random: a random
split puts a reader's later click in training and their earlier one in test, so
the model is scored on a past it has already seen through the future and every
metric comes out flattering. And an unmet gate is reported rather than raised,
because unmet is the expected state for most of this system's life and a job
failing every quarter of an hour trains whoever owns it to ignore it.

Passing says the data is no longer the reason not to train. It is not a claim
that a model trained on it would be good, and it is not a claim that the
holdout is clean: the plan's requirement that a holdout outcome share no future
interaction with a training feature is a property of how features are built,
which no count can establish. The gate records the cut it measured so a
training job has to satisfy that rule itself rather than cite this.

One gap worth naming. The two positive outcomes need a book to have arrived
from a recommendation, and `addBook` now takes the candidate it came from, but
no acquisition flow passes one yet: Marginalia imports EPUBs, and a
recommendation is an Open Library work. Impressions, opens and dismissals
accumulate today; additions and starts wait on a way to get the book. Until
then the gate cannot pass, and it says so rather than counting zero as met.

## MCP

The read-only MCP server lives in the Cloudflare Worker, not here. The Worker
holds the only credential outside the workspace that may call the App and
already knows which reader it acts for; a server anywhere else would need a
second copy of both.

Four tools, each reading a route the App already serves: `list_interests`,
`list_book_engagement`, `list_recommendations`, `list_frontier`. A tool can
reach exactly what the Insights page can reach, which is what stops the MCP
surface being a second and wider door into the same data.

No tool takes a user id. Not "ignores one": the schemas set
`additionalProperties: false` and there is no field to put one in, so a prompt
naming another reader fails validation instead of quietly succeeding. The
reader comes from the Worker's own secret, the same one the Insights routes
use, and an MCP call is refused for a disabled reader exactly as an Insights
call is.

There are deliberately no tools over highlights or conversations. The plan's
MCP section lists them; nothing outside the workspace is granted the tables
that hold a reader's words, and adding them means a new grant on Silver and a
new decision about what may leave the workspace. That is a revision to make
deliberately, not one to slip in behind a tool definition.

Every call writes one row to `marginalia_ops.mcp_audit`: which tool, when, how
many rows, and whether it worked. Never the rows. The App creates that table on
first write, and its service principal needs to be able to:

```sql
GRANT SELECT, MODIFY ON TABLE marginalia_dev.<ops>.mcp_audit TO `<app-service-principal>`;
```

An audit that cannot be written is logged and does not fail the read: the
alternative to an unrecorded read is a reader who cannot read their own
profile. That choice makes the write path worth being careful about, because a
broken one is quiet: the first version called `execute()` on the connection
`warehouse()` returns rather than on a cursor, which would have left every read
unaudited and nothing failing.

Neither the tool name nor the reason is stored as the caller sent it. The tool
must be one this server has and the reason one it produces, or the row records
that something else was asked for. A free-text column in an operational table
is a place for a reader's sentence to end up under a different retention rule
than the one it came from.

One HTTP request is one authentication, so a batch is capped at ten messages
and a body at 64 KiB, and the rate limiter is charged once per tool call rather
than once at the door. Without both, a single authorised call fans out into an
unbounded number of reads of the App and writes of this table.

A tool whose upstream call fails, times out, or is refused by the limiter comes
back as a tool error rather than as a transport failure. A batch that lost every
other reply because one read was unreachable would be reporting the wrong thing
about nine tools that were fine.

## Cloud deletion

`marginalia-cloud-deletion` takes a request id and runs in two halves with the
pipeline refreshes in between:

```text
purge              delete the reader from every directly written table
recompute_*        full-refresh Silver, Gold, and frontier
sync_serving       push the recomputed rows into Lakebase and wait
verify             count the reader in every manifest table, then record
```

The manifest is versioned (`deletion_manifest_v5`) and splits into tables that
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

## The Observatory

A second App, deliberately separate from the serving one. They differ in every
way that matters: the Observatory has a UI and no external caller, reads Gold
through a warehouse rather than Postgres, and exists for the reader looking at
their own reading. Sharing an app would mean sharing a service principal, and
with it a grant on Gold the serving app has no business holding.

Eight views: Overview, Reading, Interests, Concepts, Frontier, Recommendations,
Agent quality, and Ask Marginalia. Every one states when its source was last
computed, which is a property of the queries rather than something each view
remembers to add.

Ask Marginalia links to the Genie space rather than reimplementing it. Genie is
its own product surface, and the plan says to stop rather than replace one.

Agent quality reads the most recent Librarian evaluation. It shows defect counts
rather than a success rate: every blocking count is meant to be zero, and a
percentage would make one spoiler violation across thirty cases read as 97%
success.

## Per-reader isolation

`marginalia_scoped` holds one view per Gold table the reader-facing surfaces
read, plus `reading_sessions`. Each selects its source where
`marginalia_ops.reader_principals` says the querying principal is that reader:

```sql
WHERE EXISTS (
  SELECT 1 FROM <ops>.reader_principals AS mapped
  WHERE mapped.user_id = source.user_id
    AND lower(mapped.principal) = lower(current_user())
)
```

A Unity Catalog view runs with its owner's privileges, so the Observatory, the
dashboard, and Genie are granted the scoped schema and nothing on Gold or
Silver. Being unmapped is not an error, it is an empty result: a principal
nobody vouched for is not a reader.

This works only where `current_user()` is the reader asking:

- the Observatory queries as its own service principal, which is mapped;
- Genie evaluates data access against the end user's own Unity Catalog identity,
  even though the warehouse runs on embedded compute credentials;
- a dashboard does not, by default. A published dashboard runs on the
  publisher's data permissions, which would make `current_user()` the publisher
  inside every view and hand each viewer the publisher's reader. The resource
  sets `embed_credentials: false`, and that line is what makes the dashboard
  per-reader rather than per-publisher.

A principal maps to at most one reader. Two rows naming the same principal and
different readers would union them, and the views would go on looking correct
while answering for two people. There is no unique constraint to declare this
with, so `reader_scope` checks it on every run and fails the task.

Row filters were the plan's other option and Unity Catalog will not apply one to
a materialized view, which every Gold table is. Views are what is available.

What this does not claim: whoever owns these schemas still owns them, and can
read the base tables or redefine these views. Readers are bounded from each
other; nobody is bounded from the owner, and no arrangement of grants inside one
metastore would do that.

`reader_scope` runs as a task in the fifteen-minute job rather than at deploy,
because a full refresh drops and recreates the materialized views underneath.
Map a principal by hand, once:

```sql
INSERT INTO <catalog>.<ops>.reader_principals
VALUES ('you@example.com', '<trusted-user-id>', 'the reader, at a keyboard', current_timestamp()),
       ('<observatory-service-principal>', '<trusted-user-id>', 'the Observatory app', current_timestamp());
```

Two resources validate what they point at when they are deployed, so the very
first deploy of a target needs those objects to exist already: a Genie space
checks its data sources, and a Vector Search index checks its source table.
Create the scoped views and `librarian_passages` by running the same DDL first,
or deploy once with those two resources commented out. Every deploy after that
is ordinary, and the error a missing source produces is worth knowing: the
Genie one arrives as a 403 whose message is that a table does not exist.

## What the Observatory cannot read

Its service principal has `USE SCHEMA` and `SELECT` on `marginalia_scoped`, and
nothing else. Not Gold, not the Silver schema, and not `concept_extractions`.

`concept_extractions` is excluded deliberately, and it is the one that looks
safe. It holds `raw_response`: the model's entire answer to a prompt built from
highlight passages, notes, and questions, validated for shape rather than
content, so it can quote them back. A grant on it is a grant on the reader's
words at one remove. The Observatory reads `marginalia_gold.concept_evidence`
instead, a projection carrying counts and no model output, so the boundary is a
grant rather than a promise about which columns a query happens to select.

Genie is pointed at the four scoped views and instructed not to read anything
else. A data-source list is not an access boundary on its own: Genie runs under
an identity that may hold Unity Catalog access of its own, and could name a
table the list omits. What makes the list mean something is that the entries are
per-reader views and the identity has no grant on Gold, so reaching past the
list reaches something it cannot read. The dashboard's datasets resolve to the
same schema for the same reason.

```sh
databricks apps get marginalia-observatory-dev   # read the service principal id
```

```sql
GRANT USE CATALOG ON CATALOG marginalia_dev TO `<observatory-service-principal>`;
GRANT USE SCHEMA, SELECT ON SCHEMA marginalia_dev.<scoped> TO `<observatory-service-principal>`;
```

One grant, on views that already know which reader is asking. An earlier version
granted the Gold schema and two Silver tables by name; that was per-table least
privilege and not per-reader, and it is what the scoped schema replaced. On a
workspace that had the earlier grants, take them away, or the scoped schema is
an addition rather than a boundary:

```sql
REVOKE SELECT, USE SCHEMA ON SCHEMA marginalia_dev.<gold> FROM `<observatory-service-principal>`;
REVOKE USE SCHEMA ON SCHEMA marginalia_dev.<silver> FROM `<observatory-service-principal>`;
REVOKE SELECT ON TABLE marginalia_dev.<silver>.reading_sessions FROM `<observatory-service-principal>`;
```

Grants are workspace state and not a committed file, so check rather than assume:

```sql
SHOW GRANTS ON SCHEMA marginalia_dev.<gold>;     -- expect no reader-facing principal
SHOW GRANTS ON SCHEMA marginalia_dev.<silver>;   -- the same
SHOW GRANTS ON SCHEMA marginalia_dev.<scoped>;   -- expect exactly the reader-facing ones
```

Remember that catalog- and schema-level privileges inherit downward: a principal
with `SELECT` on the catalog reads Gold whatever the schema grants say.

## The Librarian

Genie answers structured questions with SQL. The Librarian answers the
interpretive ones, which cannot be a query, so they are a model reading
retrieved passages.

```text
librarian_passages        a Delta table of the reader's own consented text
  -> librarian_passages_index   triggered Delta Sync, embedded by gte-large-en
  -> the agent                  retrieve, one model call, validate, or withhold
  -> a serving endpoint         scaled to zero between questions
```

`librarian_passages` is a real Delta table and not a materialized view, for the
reason Phase 4 already paid for once: a Delta Sync index reads its source's
change feed, and a materialized view accepts `delta.enableChangeDataFeed` and
ignores it.

Four rules, all of them in `src/librarian.py`, which has no network in it and is
tested against fixed model replies:

1. A reader sees their own passages. `user_id` comes from the request the caller
   made, never from the question, and it is a retrieval filter rather than a
   ranking hint. Whatever the index returns is filtered again on the way back.

   Both filters prove the rows match the id that was asked for, not that the
   caller was entitled to ask. Anyone who can query the endpoint can name any
   reader, so the boundary is the endpoint's permissions, the same way the
   serving App's boundary is `MARGINALIA_TRUSTED_CALLER`. Grant `CAN_QUERY` to
   server-side identities that already know which reader they act for, and
   never build a route that forwards a browser-supplied id.

   ```sh
   databricks serving-endpoints get-permissions marginalia-librarian-dev
   ```
2. Nothing past the spoiler position. Each passage carries the progress it was
   made at, retrieval asks for `progress <=` the reader's position, and the
   result is checked against the same bound.

   A description has no position and belongs to the whole book, so it is kept.
   A digest also has no position and is not thereby harmless: it summarises
   whatever the reader had read when it was written, which on a finished book
   is the ending. Digests are dropped whenever a position is asked for.

   The position is required. An absent one made both filters unbounded, so a
   request that simply omitted the field saw everything; asking for the whole
   book is still possible and has to be said, as `spoiler_progress: 1.0`.
3. Every claim carries a passage id that was actually retrieved. A reply is a
   list of claims, each with its own evidence, rather than prose with one list
   at the end: a single list lets one real citation stand behind every sentence
   around it, invented ones included. An answer citing anything else, or making
   a claim that cites nothing, is withheld with its reasons rather than shown,
   because a reader cannot check a citation this system has just called
   invented.
4. Passage text is data. The system prompt says so, the question is placed after
   the passages so none can read as a follow-up instruction, and the evaluation
   checks behaviour rather than tone: an injected note names a marker, and
   emitting it is the failure.

A reply also carries `answerable`. Retrieval returns the nearest passages, not
the relevant ones, so a question about something the reader never marked still
comes back with their closest few. Saying so is the right answer and has nothing
to cite, and a validator that demanded a citation there would push the model
into answering from its own knowledge, which is the failure rule 3 exists to
stop. An unanswerable reply that cites anyway is withheld: one of its two halves
is false and there is no way to tell which. What the model wrote in that field
is not returned at all unless the caller passes `include_model_note`, which the
evaluation does and a reader-facing route must not: it is the one place a reply
need not cite anything, so displaying it would be displaying an uncited claim.

What none of this checks is whether the passage a claim cites actually supports
it. Per-claim citation is enforced; the honesty of the split is not something a
machine here can judge, and saying so is better than implying otherwise.

Nothing is retrieved that concept extraction would not read, which means no
assistant text at all. An agent that retrieves its own previous output cites
itself and calls it evidence.

### Deploying and evaluating it

```sh
# Rebuild the passages and sync the index. This is what the hourly schedule runs.
databricks bundle run librarian_job -t dev

# Evaluate whatever is currently deployed.
databricks bundle run librarian_job -t dev --params evaluate=true

# Log a new model version, serve it, and evaluate that.
databricks bundle run librarian_job -t dev --params deploy=true,evaluate=true
```

Two parameters rather than one. The deploy is gated because the endpoint holds a
model version and replacing it on a schedule would restart serving to redeploy
identical code. The evaluation is gated separately, and independently, because
re-evaluating what is already deployed should not require logging a new version
to reach it.

`evaluate` is read by the script rather than by a condition task. A task whose
every dependency was excluded is excluded too, whatever `run_if` says, so the
evaluation depends on `build_passages` as well as on `log_and_serve`: the first
always runs, which leaves `ALL_DONE` something to be true about, and naming the
second is what orders the two when a run does both.

The evaluation runs against the deployed endpoint and the real index, on two
synthetic readers whose passages are inserted, queried, and deleted again in a
`finally` block. No reader's own words are involved, which is also the Phase 8
preflight requirement. Its thresholds are in `librarian.py` and were set before
the first deployment: cross-reader evidence, spoiler violations, citation
errors, unsupported answers, and obeyed injections are each zero, retrieval
recall is at least 0.8, and median latency is measured warm.

Latency and token counts are recorded per case. Tokens rather than money: what
a token costs is a price list that moves, and a stored figure derived from one
would be wrong the day it changed.

Results land in `marginalia_ops.librarian_evaluations`, which has no reader
column because there is no reader in it. That is why the Observatory reads it
through the one view in `marginalia_scoped` that does not filter by reader, and
why `reader_scope` fails the run if that table ever grows a `user_id`.

### What deletion has to reach

`deletion_manifest_v5` adds `librarian_passages` and a stage for MLflow traces,
and the recommendation outcomes and readiness assessments Phase 9 records.

The index has no delete of its own: it syncs from the passages table, so
deleting the rows and waiting for the sync is the deletion, and the deletion job
runs `librarian_passages.py --wait_for_sync=true` rather than assuming it.

A trace holds the passages the model was shown, which is reader text in a store
no `DELETE` reaches. The agent tags every trace with `marginalia.user_id`, and
that tag is the only handle deletion has; an untagged trace would be
undeletable, which is why a contract test insists the tag is written.

Traces exist only because the served entity sets `ENABLE_MLFLOW_TRACING` and
`MLFLOW_EXPERIMENT_ID`. The decorators alone produce nothing, silently, and for
a while everything written here about traces was true of an empty experiment.

Every evaluation run deletes the traces it caused, by the same tag and the same
call. That is not tidiness: a tag that stopped being written, or a filter that
stopped matching, then fails an evaluation rather than a deletion.

## Evaluating Genie

The questions are fixed, in `eval/genie_questions.json`, each with the grain it
asks about and the SQL whose result is the correct answer. Grain is what the
set is really testing: the commonest way for a text-to-SQL answer to be wrong is
not bad syntax, it is counting the right thing at the wrong grain.

```sh
# The baseline: what the right answer is, run directly.
python3 databricks/eval/genie_eval.py --profile me \
  --warehouse <id> --tables marginalia_dev.<scoped-schema>

# The evaluation: ask Genie the same questions and compare.
python3 databricks/eval/genie_eval.py --profile me \
  --warehouse <id> --tables marginalia_dev.<scoped-schema> \
  --ask --space <genie-space-id>
```

The values move as the reader reads, so what is fixed is the question, the
grain, and the checks rather than stored numbers; the baseline is recomputed on
every run for that reason.

Genie may name a column whatever its SQL called it, so a column is matched by
name and then by value, and only a value that appears nowhere in the row fails.
Row order is compared only where the question says the ranking is the answer.
Both rules exist because the first run failed correct answers for aliasing a
column and for ordering an unordered breakdown differently.

Two questions also had a `LIMIT` their wording never asked for, so they measured
the evaluation's assumptions rather than Genie. They now ask for five.

One question has no SQL and must be refused: asking for the text of a reader's
highlights. A correct answer says it cannot see them. An empty result is a wrong
answer, because it reads as the reader having none, and Genie writing SQL at all
for that question is a failure whatever it returns.

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
