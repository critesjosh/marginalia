# Databricks feedback

Use this file to record feedback from hands-on Databricks work on Marginalia. Append
new entries in reverse chronological order, directly below this introduction.

Do not include access tokens, passwords, connection strings, private URLs, customer
data, or other secrets.

## Entries

<!-- cspell:ignore Geburt Jenseits sprach Tragodie -->

### 2026-09-03: recommendations from books, and what is still wrong with them

- Surface used: Open Library search API, Lakeflow pipelines
- Goal: record what changing the candidate source actually produced.
- Result: candidates are books. Asking Open Library about `friedrich nietzsche` returns Also sprach Zarathustra, Jenseits von Gut und Bose, Der Antichrist and Die Geburt der Tragodie, by Nietzsche, with edition counts that mean something. Under OpenAlex the same slot held a single-cell genomics paper scored against an interest in `artist`.
- Friction: two quality problems remain and neither is a bug. Open Library's `q=` searches titles, so a one-word concept like `artist` returns The Kill Artist and The Body Artist rather than books about art; `subject=` is the parameter that searches what a book is about. And the diversity component now works, which is the problem: it scores 0 for an author already being read, so Die Geburt der Tragodie, which is Nietzsche on Greek tragedy for a reader reading Nietzsche and Sophocles at once, ranks ninth, below a spy thriller that matched a word in its title. Diversity is right in general and wrong when the author is the reader's strongest interest.
- Workaround or follow-up: search by subject rather than title. Decide what diversity should mean when the strongest interest is a person: probably a cap on how many of one author may appear rather than a flat penalty on all of them.

### 2026-09-03: a Spark closure cannot call a module-level helper

- Surface used: Lakeflow declarative pipeline, Python UDF
- Goal: record a serialization failure that reached a live run twice.
- Result: `build_frontier` failed with `ModuleNotFoundError: No module named 'public_matching'` inside the Python worker. cloudpickle serializes a nested function by value and a module-level function by reference, so a helper defined beside the closure factory rather than inside it makes the worker try to import a module it does not have.
- Friction: the driver resolves the import fine, so nothing fails locally, in tests, or during analysis. The first version of this rule was learned in Phase 6 and broken again in Phase 7 by adding one helper in the obvious place.
- Workaround or follow-up: nest every helper a closure calls inside the factory. A contract test now inspects the returned closure's referenced globals and fails if any is a function defined in the module, which is checkable without a Spark session.

### 2026-09-02: Phase 7 review, two claims that were stronger than the enforcement

- Surface used: Databricks Apps, AI/BI dashboards, Genie, Unity Catalog grants
- Goal: record what a second reading found in the Observatory, the dashboard, and the Genie space.
- Result: two claims did not hold. The Observatory was granted `SELECT` on `concept_extractions`, which holds `raw_response`, the model's whole answer to a prompt built from the reader's highlights and questions; validation checks its shape, not its content, so it can quote them back. Granting it made "no table holding the reader's own words" false even though the query selected only labels. Fixed by projecting `marginalia_gold.concept_evidence` and `extraction_health` in the Gold pipeline and granting those instead. Separately the dashboard's dataset parameters named the production namespace, so a dev dashboard would have queried production; fixed with `dataset_catalog` and `dataset_schema` on the bundle resource, which do get target substitution.
- Friction: a Genie space's data-source list is not an access boundary. Genie runs under an identity that can hold Unity Catalog access of its own, so a reader who owns these schemas can reach past the list, and the instructions cannot prevent it. Neither the dashboard nor Genie filters by reader; `trusted_user_id` scopes the Observatory only. Both are latent rather than active in a single-reader deployment, and both become real the moment a second reader exists. The evaluation questions had also been installed as Genie benchmarks, which handed it the exact SQL for every question it was to be measured on.
- Workaround or follow-up: real per-reader isolation needs Unity Catalog row filters or per-reader views over Gold, for the dashboard and Genie alike. Not built in this phase and not claimed. The benchmarks were removed so the question set evaluates rather than instructs; comparing Genie's own answers against the fixed set still has to be done by hand.

### 2026-09-02: Phase 4 acceptance from a real reading session

- Surface used: deployed Cloudflare Worker, Confluent, Lakeflow pipelines, jobs, Lakebase, Databricks App
- Goal: close the Phase 4 acceptance list against a real browser rather than fixtures.
- Result: a highlight made at 14:04:15Z was readable through the same-origin Worker at 14:15:11Z, inside the 35-minute objective. All fifteen events from the session reached Silver with nothing quarantined. Extraction ran on text it had never seen and returned usable concepts for it. Deletion removed one reader from every layer including the serving copies and left the other intact.
- Friction: the freshness figure excludes the schedule wait, because Bronze ingestion was triggered by hand 85 seconds after the highlight; an unattended run adds up to the 15-minute interval. Enabling seven consent categories emitted seven separate `privacy_consent_changed` events in five seconds, one per click, each stamping its own consent version.
- Workaround or follow-up: quote the freshness objective as a range that includes the schedule interval, not the triggered figure. Batch a multi-category consent change into one patch.

<!-- cspell:ignore databrick socrate descarte hobbe keyne borge athen -->

### 2026-09-02: canonicalization mangles proper nouns

- Surface used: concept extraction over a live reading session
- Goal: record a defect that fixtures could not surface.
- Result: `_singularize` strips a trailing `s` from any word over three characters that does not end in `ss`, `us`, `is`, `ics`, or `ous`. Those guards protect mass nouns but not names, so `Databricks` became `databrick`, and `Socrates`, `Descartes`, `Hobbes`, `Keynes`, `Borges`, and `Athens` become `socrate`, `descarte`, `hobbe`, `keyne`, `borge`, and `athen`. That the spell
checker rejects every one of them is the shortest statement of the problem. The mangled form is the stable concept id used for interest matching, frontier adjacency, and OpenAlex queries, so it searches for a word nobody wrote. `databrick` reached third place in a live interest profile.
- Friction: the Nietzsche fixtures contain no proper noun ending in `s`, so the whole concept suite passes. `canonicalize` lowercases before singularizing, so the capitalization that would identify a name is gone by the time the decision is made.
- Workaround or follow-up: fixed at canonicalization version 3. The decision now happens before case is folded, and only for a single capitalized word that is not all capitals. Capitalization inside a phrase proves nothing, because the same fixture shows the model writing `Morality` and `Genealogy of Morals` as readily as `value judgments`; standing alone it is evidence, and a capitalized common noun standing alone has no `s` to lose. The accepted cost is that a bare capitalized plural keeps its `s`, so `Judgments` and `judgments` become different concepts. Fragmenting two real words is recoverable; coining a word and searching a provider for it is not.

### 2026-09-02: Phase 4 deployment

- Surface used: Databricks CLI, Automation Bundles, Lakebase, synced tables, Databricks Apps, SQL warehouse, Postgres
- Goal: provision the Phase 4 serving loop and run its acceptance checks against a live workspace.
- Result: the Lakebase instance, database catalog, synced tables, App, and deletion jobs deployed. Both synced tables reached `SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE` once switched to snapshot sync, carrying 14 interest rows and 2 engagement rows, queryable by their documented primary keys. The App started and serves on its workspace URL.
- Friction: a triggered sync over a materialized view fails with `SYNCED_TABLE_USER_ERROR.SOURCE_READ_ERROR`, because `CHANGE DATA FEED` is not supported on materialized views: the table property is accepted at creation and silently ignored. Free usage caps a workspace at one SQL warehouse. The first deploy created the database catalog and then failed creating synced tables against it with `CATALOG_DOES_NOT_EXIST`, an ordering race inside one deploy. Deleting a synced table in Unity Catalog leaves its Postgres destination table, so recreating fails `ALREADY_EXISTS`. Unity Catalog grants do not imply Postgres grants: `has_table_privilege` for the App's role was false until schema `USAGE` and table `SELECT` were granted inside the database. The `psql` client the CLI's `databricks psql` shells out to is a separate install.
- Workaround or follow-up: use snapshot sync for any materialized-view source, and do not claim Change Data Feed on one. Reference an existing warehouse rather than creating one. Re-run a first deploy that races on its own catalog. Drop the Postgres destination table before recreating a synced table. Grant the App's Postgres role explicitly, including default privileges so a later synced table is not invisible to it.

### 2026-09-02: Phase 4 serving review

- Surface used: Databricks CLI bundle schema, Lakebase and Databricks Apps documentation
- Goal: verify the Phase 4 Lakebase, App, and deletion resources against the current platform before deploying them.
- Result: `databricks bundle validate` accepts a `retention_window_in_days` of 1 that the API documents as invalid (the range is 2 to 35), so the CLI schema had to be read directly to find it. The synced-table state enum is prefixed `SYNCED_TABLE_*` and its members include the API's own misspelling `SYNCED_TABLED_OFFLINE`; unprefixed names match nothing. Since March 2026 a new database instance is backed by an Autoscaling project, but the Database instance API still describes it, so `database_instances` remains the right bundle resource.
- Friction: bundle validation checks structure rather than documented value ranges, so an invalid field deploys and fails late. Unity Catalog grants do not imply Postgres grants: a synced table is readable only by its owning role until the App's role is granted `USAGE` and `SELECT` inside the database. Databricks forwards a caller identity across three `X-Forwarded-*` headers and does not document which carries a service principal's application id.
- Workaround or follow-up: read `databricks bundle schema` for value ranges rather than trusting validation. Accept any of the three identity headers against an allowlist rather than guessing one. Grant the App's Postgres role explicitly, including default privileges, so a later synced table is not invisible to it.

### 2026-09-02: Phase 6 deployment and live acceptance

- Surface used: Databricks CLI, Automation Bundles, jobs, Lakeflow pipelines, and SQL warehouse
- Goal: deploy the reviewed public-source, frontier, recommendation, and expanded Silver changes and exercise them on selected compute.
- Result: bundle validation passed. The user profile deployed the job and new frontier pipeline; ingestion, Silver, extraction, Gold, and public sources succeeded. Selected compute reached OpenAlex and wrote 99 research-work rows; the next run wrote zero, confirming the request-attempt TTL. Final views contained 25 frontier rows and 125 recommendations. SQL found no duplicate keys, missing provenance, score-recomputation mismatches, direct-interest leaks, or raw requests without a user deletion link.
- Friction: the default service-principal profile authenticated but lacked `USE CATALOG`, while validation still passed; the existing user profile had the required grants. Spark rejects `explode` nested inside scalar functions, and imported-module UDFs resolved on the driver but failed on workers. Pipeline tasks silently retried both failures. A SQL statement sent with Unicode-escaped quotes also arrived without string delimiters.
- Workaround or follow-up: deploy privileged bundle changes with the existing user profile until the service principal receives catalog grants. Project generators separately and serialize nested UDF implementations by value. Inspect pipeline events when a task stays running through retries; use parameterized or quote-free acceptance SQL.

### 2026-09-02: Phase 6 preflight, public sources

- Surface used: Open Library search API, OpenAlex works API
- Goal: clear the Phase 6 preflight before building public-data ingestion.
- Result: both reachable and returning the fields the plan wants. Open Library answered a
  title-and-author search with work keys, authors, first publish year, and edition counts.
  OpenAlex answered a title search with work ids, publication years, cited-by counts, and
  topics. Both publish their data as CC0, and the licence is recorded on every stored row
  rather than assumed by the code.
- Friction: two things worth knowing. Reachability was verified from the development
  machine, not from serverless compute, which is what the preflight actually asks for;
  the first job run is what will confirm workspace egress, and every request records its
  HTTP status and error so a failure is a visible row rather than an absence. And OpenAlex
  now returns credit-based rate-limit headers, `x-ratelimit-limit-usd: 0.1` with
  `x-ratelimit-onetime-remaining: 0`, which reads as a metered allowance rather than the
  purely polite pool the plan assumed.
- Workaround or follow-up: requests are spaced by a configurable interval, batches are
  bounded per run, both providers are told who is calling, and enrichment stays targeted at
  concepts a reader already has rather than mirroring anything. Watch the OpenAlex credit
  headers on the first real runs before raising the batch limit.

### 2026-09-02: Phases 2 through 4 deployed and run end to end

- Surface used: Databricks CLI (bundle deploy and run), Lakeflow pipelines, jobs, SQL warehouse
- Goal: deploy the bundle to dev and run ingest, Silver, extraction, and Gold end to end.
- Result: all four tasks succeeded. Silver holds 28 events, 2 current highlights, 6 reading
  sessions, 1 conflict, and 6 quarantined rows. Extraction read 5 candidates and wrote 14
  valid concepts in 33.9 seconds. Gold built both profiles, correctly keyed one row per
  reader and concept and per reader and book, with interest normalized within each reader.
  A second run found 0 pending candidates and called the model zero times, which is the
  incrementality criterion holding against real data rather than a fixture.
- Friction: `ai_query` with `failOnError => false` returns a struct whose fields are
  `result` and `errorMessage`. The published reference says `response` and `errorMessage`.
  Believing the documentation costs a full job failure with `FIELD_NOT_FOUND`, and it is
  an analysis-time error, so nothing is written and no partial progress survives.
- Workaround or follow-up: the field name is now taken from an observed run rather than
  from the reference, with a comment saying so. Anyone reading the docs and "correcting"
  this code will break the job.

### 2026-09-01: Phase 3 live concept evaluation

- Surface used: `databricks serving-endpoints query` against `databricks-gpt-oss-120b`
- Goal: meet the Phase 3 acceptance bar of recalling at least four of five reference
  concepts with at most two unsupported additions.
- Result: passes at 4/5 recalled, 0 unsupported, about 2.3 seconds per request. Four
  evaluation runs were needed, and each failure was a real defect rather than noise.
- Friction: `gpt-oss-120b` is a reasoning model, so `message.content` is not a string. It
  is a list of parts, chain of thought first and the answer last, and the CLI hands that
  list back already serialized, so a caller sees a string that is really a list. Any
  validator written against a plain string fails with a misleading "not an object" error.
  The `ai_query` path has the same shape, so this would have failed in the pipeline too.
- Workaround or follow-up: response normalization is handled once, in the shared module,
  so the job, the evaluation, and the tests all read a response the same way. A serialized
  parts list and an accidental code fence are both unwrapped there.

### 2026-09-01: Phase 3 plan defect, a reference concept the rules forbid

- Surface used: plan review against live evaluation output
- Goal: recall `genealogy of morality`, one of the five reference concepts.
- Result: never recalled, and it should not be. `Concept extraction v1` instructs the
  model not to return a book's title, and "On the Genealogy of Morality" is the title of
  the book the evaluation passage comes from. The reference set asks for the one thing the
  extraction rules forbid.
- Friction: the acceptance bar is satisfiable without it, at four of five, so the
  contradiction does not block Phase 3. It would block any attempt to reach five of five,
  and it will mislead whoever next tunes this prompt.
- Workaround or follow-up: resolved by decision on 2026-09-01. A title may be returned when
  it is also the established name of an idea in its own right, judged as an idea rather than
  as a cover. The concept is still not recalled from this passage, which never uses the
  word genealogy, but that is now a property of the passage rather than a rule forbidding
  the answer it asks for.

### 2026-09-01: gpt-oss-120b emits a number as an English word

- Surface used: `databricks serving-endpoints query` against `databricks-gpt-oss-120b`
- Goal: run the live concept evaluation after a prompt change.
- Result: the response contained `"confidence": 0. nine`, a decoding glitch producing an
  English word inside a JSON number. The validator rejected it as `invalid_json` and the
  next identical request succeeded.
- Friction: temperature 0 does not make this endpoint deterministic, and a malformed
  number is indistinguishable from a malformed prompt at the call site. A pipeline that
  treated a parse failure as terminal would discard perfectly good candidates.
- Workaround or follow-up: none needed. This is exactly what the three-attempt retry and
  the `invalid_json` status exist for, and it is a useful confirmation that they are not
  theoretical.

### 2026-09-01: Phase 3 extraction, ai_query telemetry limits

- Surface used: `ai_query` in a Lakeflow job task against a pay-per-token chat endpoint
- Goal: record model, prompt version, latency, and cost per extraction, as Phase 3 requires.
- Result: partially met. Model endpoint, prompt version, canonicalization version, run
  latency, candidate count, and per-row response size are recorded in
  `concept_extraction_runs` and `concept_extractions`.
- Friction: `ai_query` returns only the parsed response and, with `failOnError => false`,
  an error message. It exposes no token counts and no per-row latency, so per-row cost
  cannot be attributed from SQL at all. Its return struct is `(response, errorMessage)`,
  which is easy to mistake for a field named `result`; selecting the wrong name fails at
  analysis time rather than returning null, so the whole job writes nothing.
- Workaround or follow-up: wall-clock latency is recorded per run and response size per
  row as the only honest cost signal available, rather than an invented estimate. Revisit
  if `ai_query` gains usage reporting, or move extraction to a Python client that reads the
  usage block from the serving response directly.

### 2026-09-01: Phase 3 preflight, concept model unavailable

- Surface used: Databricks CLI (`serving-endpoints list`, `serving-endpoints get`)
- Goal: clear the Phase 3 preflight gate before building concept extraction.
- Result: the gate failed. The workspace exposes eleven serving endpoints and
  `databricks-gpt-5-6-luna` is not among them; a direct get returns "Endpoint with name
  'databricks-gpt-5-6-luna' does not exist." Phase 3 stopped without substituting a model,
  as the plan requires.
- Friction: the locked plan names a pay-per-token endpoint that this workspace and region
  do not serve, and the CLI reports absence the same way for an endpoint that is
  unavailable regionally and one that was never provisioned, so the two cannot be told
  apart from the client.
- Workaround or follow-up: the concept model was changed to `databricks-gpt-oss-120b`
  and the locked decision revised in the plan.

### 2026-09-01: Phase 2 deployment and synthetic acceptance run

- Surface used: Databricks CLI (bundles, pipelines, filesystem), Unity Catalog volume,
  SQL warehouse
- Goal: deploy Phase 2 and verify quarantine, deduplication, conflicts, highlight state,
  late events, future clocks, and sessionization against synthetic Bronze records.
- Result: the Silver pipeline was deployed and three updates completed. The 29-record
  acceptance set produced 24 logical events, one conflict, six expected sessions, one
  current highlight, and three inspectable quarantine rows with the expected reasons.
- Friction: the default service-principal profile authenticated but lacked `USE CATALOG`,
  public DBFS root was disabled, and `try_parse_json` accepts bare text as a scalar Variant
  rather than returning null.
- Workaround or follow-up: deployed with an existing authorized user profile, stored the
  fixture in a governed development volume, and required a top-level Variant object before
  treating a record as a valid envelope.

### 2026-09-01: Phase 2 Silver bundle validation

- Surface used: Databricks CLI (`databricks bundle validate`), Lakeflow pipelines bundle
- Goal: validate the Phase 2 quarantine, deduplication, highlights, and reading-session
  pipeline against the configured development workspace.
- Result: the development bundle resolved both pipelines and their schema references and
  passed validation.
- Friction: validation requires workspace metadata even for bundle structure checks, so it
  fails with a generic credentials message in the restricted network environment.
- Workaround or follow-up: rerunning the same command with workspace network access used
  the existing profile successfully; no reauthentication or profile change was needed.

### 2026-09-01: Phase 1 review authentication check

- Surface used: Databricks CLI (`databricks auth describe`)
- Goal: revalidate the configured development identity before reviewing the deployed
  Phase 1 resources and starting Phase 2 work.
- Result: the CLI found the configured profile, but authentication could not complete
  from the restricted execution environment because workspace metadata was unreachable.
- Friction: the resulting generic credentials error looks like a bad profile even though
  all required profile fields were present; the preceding metadata warnings were the only
  indication that network reachability was the actual blocker.
- Workaround or follow-up: rerun the same read-only check with workspace network access
  before treating the stored credentials as invalid or attempting to reauthenticate.

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

### 2026-09-02: Phase 4 serving review validation

- Surface used: Databricks CLI (`bundle schema`, `bundle validate`, `auth profiles`)
- Goal: validate the Phase 4 Lakebase, Databricks App, and deletion job resource
  definitions against the current CLI schema.
- Result: the local schema exposed an invalid one-day Provisioned instance retention
  window (the accepted range is 2–35 days). Live bundle validation could not finish
  because both configured workspace profiles were expired.
- Friction: `bundle validate` reports only the authentication failure before completing
  schema validation, so `bundle schema` had to be inspected separately to find the
  resource constraint.
- Workaround or follow-up: refresh a workspace profile and rerun strict validation; use
  the local CLI schema for resource-field checks that do not require workspace access.

### YYYY-MM-DD: short task name

- Surface used: CLI, API, workspace UI, job, pipeline, SQL warehouse, Lakebase,
  Model Serving, Databricks App, or another Databricks surface
- Goal: what you tried to accomplish
- Result: what worked and what did not
- Friction: errors, unclear behavior, missing documentation, or "none"
- Workaround or follow-up: what helped or what should change next
