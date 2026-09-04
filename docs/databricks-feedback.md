# Databricks feedback

Use this file to record feedback from hands-on Databricks work on Marginalia. Append
new entries in reverse chronological order, directly below this introduction.

Do not include access tokens, passwords, connection strings, private URLs, customer
data, or other secrets.

## Entries

### 2026-09-03: dashboard layout recheck stayed metadata-only

- Surface used: Databricks CLI metadata APIs through the local architecture dashboard
- Goal: verify live telemetry still worked after reflowing the tldraw service boxes.
- Result: the health endpoint returned all expected service metadata after the layout change, with no unavailable sources, and the preview remained reachable.
- Friction: none from Databricks in this pass.
- Workaround or follow-up: keep visual-layout checks separate from the optional row-count action so a formatting iteration never wakes the SQL warehouse.

### 2026-09-03: a live architecture dashboard without waking compute

- Surface used: Databricks CLI, Unity Catalog, Lakeflow pipelines, Lakebase, synced tables, Databricks Apps, Model Serving, Vector Search, AI/BI dashboards, Genie, SQL warehouses
- Goal: feed privacy-safe live service health and table inventory into the tldraw architecture diagram without exposing reader data or credentials.
- Result: metadata APIs report the current pipeline updates, App compute, endpoint readiness, Lakebase capacity, synced-table health, warehouse state, and governed object inventory without starting SQL compute. The dashboard returns only aggregate status, names, timestamps, and optional row counts; it never returns user ids, titles, reader text, provider bodies, workspace URLs, or credentials.
- Friction: `bundle summary` could not describe the deployed resources without receiving the externally supplied warehouse id, and `tables list` returns full column schemas and large internal property maps when the dashboard needs only names, types, and update times. Row counts are not metadata and would auto-start the stopped serverless warehouse if polled like health.
- Workaround or follow-up: query each resource API directly and reduce its response on the server before it reaches the browser. Refresh metadata automatically, but put SQL counts behind an explicit action that warns it can start billable compute.

<!-- cspell:ignore Geburt Jenseits sprach Tragodie cloudpickle -->

### 2026-09-04: a synced table nobody could read, and everything that said it was fine

- Surface used: Lakebase synced tables, Databricks Apps, Postgres
- Goal: record the one defect that only a live authenticated read could find.
- Result: two phases each added a synced table. Both deployed, both reported `SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE` with rows, both were queryable through Unity Catalog, and both routes returned `intelligence_unavailable` to the browser. The App's log had the answer: `permission denied for table intellectual_frontier`. `ALTER DEFAULT PRIVILEGES` had been set on the schema years of documentation say it should be, and it does not apply: default privileges cover tables a particular role creates later, and a synced table is created by the sync rather than by the role that ran the ALTER. So the grant covers the tables that existed when somebody last ran it by hand and nothing after.
- Friction: every signal available before an authenticated read said the system was healthy. Bundle validation passed, the sync status was ONLINE, `SELECT` over the SQL warehouse returned rows, and the offline suite was green. The gap between "Unity Catalog can read this" and "the App's Postgres role can read this" is invisible from the Unity Catalog side, and the synced-table status says nothing about who may read the result.
- Workaround or follow-up: a `serving_grants` task now runs after the syncs and grants over the tables that exist rather than the ones that existed. The general shape is worth keeping: a resource created by one identity for another to read needs the grant re-applied when the resource is re-created, and a status field that reports the resource is healthy is not reporting that.

### 2026-09-04: a CLI update mask the API refuses

- Surface used: Databricks CLI, Automation Bundles, Databricks Apps
- Goal: deploy a job change while an unrelated App resource was in the bundle.
- Result: `bundle deploy` failed with `Invalid update mask. Only description, budget_policy_id, ... are allowed. Supplied update mask: ..., forward_user_access_token, ...`. The CLI sends a field in the app update mask that the API does not accept, so any deploy touching a bundle containing an App fails, whatever changed. The job update never happened.
- Friction: nothing in the bundle references `forward_user_access_token`; it is the CLI's own mask. The failure blocks unrelated resources in the same bundle, which is the expensive part: a one-line job change cannot be deployed while an App is defined beside it.
- Workaround or follow-up: submit the affected task as a one-off run against the file the deploy had already uploaded (`jobs/runs/submit` pointing at the workspace path). Upgrading the CLI is the real fix; the version here sends a mask its own control plane rejects.

### 2026-09-03: an audit that failed open, quietly

- Surface used: Databricks Apps, `databricks-sql-connector`
- Goal: record a Phase 11 defect whose shape recurs.
- Result: the MCP audit route called `execute()` on what `warehouse()` returns, which is a connection rather than a cursor. Every audit write would have raised, and the Worker treats a failed audit as something to log rather than fail on on purpose, so every tool call would have succeeded and none would have been recorded. Nothing would have failed, no test would have failed, and the table would simply have stayed empty.
- Friction: the combination is what makes it dangerous rather than either half. A deliberate fail-open on the caller's side and a broken write on the service's side produce a system that works and audits nothing, and the only signal is a log line nobody is reading. Every other route in the same file opens a cursor correctly, so the mistake is invisible to a reader skimming for shape.
- Workaround or follow-up: a contract test now asserts the route opens a cursor, and the audit is written before the tool result is returned rather than beside it. The general rule is that a fail-open path needs a test of the thing it fails open around, because its failure is by construction silent.

### 2026-09-03: a registry that decides whether an event exists at all

- Surface used: Lakeflow declarative pipeline, Unity Catalog
- Goal: record the Phase 9 defect a review found, because it would have been invisible until somebody asked why the numbers were zero.
- Result: Silver keeps four separate registries keyed by event type: the list of known types, the permitted payload keys per type, the payload timestamp per type, and which types may name no consent category. Four new event types were added to the contracts, the envelope, the browser, the Worker, and the fixtures, and to none of the four. Every event would have been collected, accepted, produced, and then quarantined on arrival as `unknown_event_type`, and the gate they feed would have gone on reporting zero for exactly the reason it was designed to report zero. The contract test that was supposed to catch it looked for the type names anywhere in the file and found them in a tuple that names them for something else.
- Friction: none from the platform; a quarantine that names the reason is the right behaviour. The lesson is about the shape of the check. A registry keyed by a value from a manifest deserves a test that parses the registry and compares it to the manifest, not one that greps for a string.
- Workaround or follow-up: the test now reads `EVENT_TYPES` out of the module with `ast` and asserts it covers the manifest, and was mutation-checked by deleting the four entries again.

### 2026-09-03: closing Phase 7's two open items, and what each one cost

- Surface used: Unity Catalog row filters and views, Genie Conversations API, AI/BI dashboards, Databricks Apps, Automation Bundles
- Goal: make per-reader isolation real, and compare Genie's own answers against the fixed question set instead of promising to do it by hand.
- Result: both closed. Unity Catalog will not apply a row filter to a materialized view, and every Gold table is one, so of the plan's two options only per-reader views were available. `marginalia_scoped` holds seven views that filter on `current_user()` through a mapping table; the Observatory, dashboard and Genie now read those and hold no grant on Gold or Silver at all. Verified rather than asserted: mapped to the wrong reader the view returned 0 rows against a base table holding 57, and mapped to the right one it returned all 57. `genie_eval.py --ask` then put all ten questions to the deployed space and agreed with the baseline on every one, including the refusal, which Genie answered by declining rather than by returning an empty result.
- Friction: three things, none of them documented anywhere I could find beforehand. A Genie space validates its data sources at deploy time, so a bundle cannot create a view and point Genie at it in the same deploy; the first deploy of a target needs the schema bootstrapped by hand, and the error arrives as a 403 PERMISSION_DENIED whose message is actually "table does not exist". `bundle deployment unbind` was the wrong reach for a dashboard the CLI said did not exist: it existed, and the identity I was authenticated as could not see it, so the fix was a profile rather than a state edit and the unbind then caused a 409 on the next deploy. And a stopped App returns no `config.env` at all from `apps get`, so a config change cannot be confirmed without starting it.
- Workaround or follow-up: bootstrap the scoped schema before the first deploy that includes the Genie resource, and check which identity the CLI is using before believing a resource is missing. The mapping table is deliberately not created by the bundle, because a row in it names a person.

### 2026-09-03: four runtime-only mistakes, and the checks that now catch them

- Surface used: serverless Python tasks, Model Serving
- Goal: record the pattern, because it repeated four times in one phase and each repeat cost a job start.
- Result: a NUL byte in a source file; `__file__` undefined in a serverless task; an import removed with the line above it; and a helper copied between two modules calling a two-argument function with one. Every one passed `py_compile`, passed every test, deployed cleanly, and failed minutes into a run with a message that named neither the file nor the cause. They are now four contract tests over `databricks/src`: no control characters, no `__file__` in a job script, every standard-library module used is imported, every locally-defined function called exists and is given enough arguments. Each was mutation-checked against the mistake it was written for.
- Friction: the shared property is that a serverless task compiles the file and runs it, so anything Python defers to call time is deferred past the point where feedback is cheap. A syntax error costs a second; a NameError costs a cluster start.
- Workaround or follow-up: none needed from the platform, though an error naming the file it could not compile would have saved the first one. The lesson is local: a job script deserves the static checks a library gets, because it has none of the runtime protection a library gets from being imported by tests.

### 2026-09-03: an endpoint that traced nothing, and said nothing about it

- Surface used: Model Serving, MLflow tracing
- Goal: check that the Librarian's traces existed before claiming cloud deletion removes them.
- Result: there were none. The agent is decorated with `@mlflow.trace` on every span, the endpoint served a day of questions, and `GET /api/2.0/mlflow/traces` for the experiment returned `{}`. Tracing from a served model needs `ENABLE_MLFLOW_TRACING` and `MLFLOW_EXPERIMENT_ID` in the served entity's environment, neither of which is implied by the decorators or by logging the model to an experiment. Everything written about what a trace records, and about deleting one, was true of an empty set until those two variables were set.
- Friction: the failure is entirely silent. The decorators run, nothing errors, the experiment exists, and the only way to find out is to go looking for traces that should be there. An endpoint serving a traced model with tracing unconfigured could say so once at startup.
- Workaround or follow-up: the deploy task now reads the experiment id and sets both variables, and refuses to deploy if the experiment does not exist rather than pointing the endpoint at nowhere.

### 2026-09-03: what a reasoning model returns, and what it cites

- Surface used: `databricks-gpt-oss-120b` through Model Serving, Vector Search
- Goal: record two shapes that only appear when a real model answers a real question.
- Result: `choices[0].message.content` is not a string. It is a list of parts, one a reasoning summary and one the answer, so reading it as text gets an empty answer and a reply withheld for "the model returned nothing", blaming the model for the reader's own bug. Separately, asked to cite passage ids, it cited the whole passage block back, brackets and chapter and text. That is a real passage in the wrong format, and rejecting it would have withheld a correct answer over punctuation, so a citation containing exactly one known id now resolves to it. Exactly one: two is ambiguous and guessing would attach a claim to a passage that may not support it.
- Friction: neither shape is visible from the endpoint listing, which reports the task as `llm/v1/chat` and says nothing about content parts. The first was found by querying the deployed agent and reading a withheld answer; there is no way to have known it from the model's page.
- Workaround or follow-up: extract the parts of type `text` and drop the reasoning summary, which is the model talking to itself rather than an answer. Both rules live in the module the contract tests exercise, so neither is discovered twice.

### 2026-09-03: three ways a table or an index quietly disagreed

- Surface used: Delta, Vector Search, Model Serving
- Goal: record the failures that came from state rather than from code.
- Result: three, each silent in its own way.
  1. `CREATE TABLE IF NOT EXISTS` does nothing to a table that exists, and the writer built its rows from the live schema, so a column added to the declaration was dropped without a word. A whole run's token counts were measured and stored nowhere. The table now reconciles itself with `ALTER TABLE ADD COLUMNS`.
  2. A triggered index refuses a second sync while one is running: "Index is not ready to sync yet. Pipeline is in state WAITING_FOR_RESOURCES". The evaluation's sync raced the passage build's, so the wait now brackets the trigger rather than following it, and sleeps ten seconds after asking, because the state does not change the instant a sync is requested.
  3. Serving hands a request through a pandas DataFrame, so an absent field arrives as NaN rather than None. NaN is truthy, and a NaN in a retrieval filter serializes as bare `NaN`, which is not JSON: a missing spoiler position became a rejected query rather than an unfiltered one.
- Friction: all three are the same shape. Something absent was represented as something present, and every layer accepted it until the one that could not.
- Workaround or follow-up: absence is now explicit in the one module that has no network in it, and each rule has a test that fails locally in a second rather than fifteen minutes into a job.

### 2026-09-03: five things that only fail in a workspace

- Surface used: serverless Python tasks, MLflow, Unity Catalog model registry, Vector Search, Databricks SDK
- Goal: record every way the Librarian's deploy failed, because each one passed locally first.
- Result: five failures, four of them a class of error rather than a typo.
  1. A NUL byte in a source file. `python -m py_compile` accepted it, every local test passed, and the job died with "source code string cannot contain null bytes" naming no file. A contract test now rejects any control character in `databricks/src`.
  2. `__file__` is not defined in a serverless Python task: the runner compiles and executes the source without it, so a module-level `Path(__file__)` raises NameError before the job does anything. An imported sibling module has one, so paths now come from `librarian.__file__`.
  3. Fixing that removed `import sys` alongside it and nothing noticed, because compiling proves nothing about names. A test now checks that every standard-library module a source uses is one it imports.
  4. Unity Catalog refuses to register a model with no signature, and refuses one with inputs only. The reply here has two shapes, an answer or a withheld one, so the output schema is a single string holding JSON rather than a schema that would be wrong about one of them.
  5. `EndpointCoreConfigInput` requires `name` even when `name` is passed beside it to `create_and_wait`, and raises TypeError rather than defaulting it.
- Friction: the first two are the expensive ones, because they cost a full job start each to discover and neither message names the file or the cause. A serverless task that set `__file__`, or an error that said which file could not be compiled, would have saved both.
- Workaround or follow-up: the guards are contract tests now, so the next occurrence costs a second rather than a job run.

### 2026-09-03: a field the API accepts and does not return

- Surface used: Vector Search, Automation Bundles
- Goal: record why `columns_to_sync` came back out of the index definition.
- Result: declaring it made every subsequent `bundle deploy` plan a recreate of the index. The create call accepts the field, a read of the index does not return it, and the CLI compares what it sent against what it can see, so the difference is permanent. Recreating a Delta Sync index re-runs the whole embedding pipeline, which is the one thing this field was not worth. Omitting it syncs every column, which includes the two that are filters rather than output, and those are what matter.
- Friction: a permanent destructive diff is the worst shape a drift can take, because the safe answer is to stop deploying and the convenient answer is to pass `--auto-approve` forever.
- Workaround or follow-up: either return the field from a read or reject it on create. Accepting and forgetting it is what makes the tooling wrong.

### 2026-09-03: Phase 8 preflight, and a resource that validates what it points at

- Surface used: Model Serving, Vector Search, MLflow, Automation Bundles
- Goal: establish whether the Librarian could be built here at all before building any of it, as the phase's preflight requires.
- Result: everything the phase needs is available. A custom Model Serving endpoint create was accepted for validation and refused only because the model did not exist, which is the answer that says the feature is enabled. A Vector Search STANDARD endpoint created and came back ONLINE in one call. MLflow experiments and the tracking API answer normally, and the workspace serves `databricks-gte-large-en` for embeddings. The bundle can declare all of it: `vector_search_endpoints`, `vector_search_indexes`, `registered_models`, and `model_serving_endpoints` are resource kinds.
- Friction: two resources validate their target at deploy rather than creating it, and both produce an error that names the wrong problem. A Genie space refuses with `403 PERMISSION_DENIED` whose message is that a table does not exist. A Vector Search index refuses with `404 TABLE_DOES_NOT_EXIST` on the source table its own job creates. Both mean the same thing, and both make the first deploy of a target a two-step operation that no amount of ordering inside the bundle can fix.
- Workaround or follow-up: create the scoped views and `librarian_passages` with the same DDL before the first deploy of a target. A `depends_on` between a resource and the job that creates its source would remove the step, and neither resource kind has one.

### 2026-09-03: probing a capability without buying it

- Surface used: Model Serving REST API
- Goal: answer "can this workspace create a custom serving endpoint" without creating one.
- Result: posting a create request naming a model that does not exist distinguishes the two cases cleanly. A workspace without the feature refuses the request; this one accepted it and refused the model, which is the answer, and nothing was provisioned or billed.
- Friction: there is no capability endpoint to ask instead. `GET /api/2.0/previews` returns Not Found, which an earlier phase already recorded, and entitlements are not exposed per feature. Probing by deliberate failure works but reads as a mistake in an audit log.
- Workaround or follow-up: a read-only capabilities endpoint would replace a family of probes that all look like errors.

### 2026-09-03: two identities that decide whether a per-reader view is a boundary

- Surface used: Genie, AI/BI dashboards, Unity Catalog views
- Goal: check the assumption the whole scoped-view design rests on, that `current_user()` inside a view is the reader asking.
- Result: true for Genie and false by default for a dashboard. Genie splits the two credentials: the warehouse runs on the space author's embedded compute credentials, while data access is evaluated against the end user's own Unity Catalog identity, so a view filtering on `current_user()` filters per asker. A published dashboard does the opposite unless told otherwise: with the default shared data permissions viewers query on the publisher's permissions, which would put the publisher inside every scoped view and hand each viewer the publisher's reader. `embed_credentials: false` on the bundle resource is the whole difference between per-reader and per-publisher, and this deployment already had it, which is worse than not: it was true by accident and nothing said so.
- Friction: the two products document their identity model in their own pages and neither says how it interacts with a view that reads `current_user()`, which is the one thing a person building this needs. The Genie page describes compute credentials in a sentence that reads, on a first pass, as though it settles data access too.
- Workaround or follow-up: pin `embed_credentials: false` rather than inheriting it, and treat any surface added later as per-publisher until its identity model is checked. A review raised this as a likely defect in Genie; the docs said otherwise for Genie and confirmed it for the dashboard, which is why it was worth reading them rather than acting on either claim.

### 2026-09-03: the first honest evaluation failed the evaluation, not the thing evaluated

- Surface used: Genie Conversations API
- Goal: record what the first automated comparison actually found.
- Result: 29 reported problems across the question set, and most were mine. Genie answered `MAX(computed_at) AS last_computed_at`, which is the right answer with a different column name, and a comparator matching on names called it missing. It returned a per-book breakdown in a different row order, and a positional comparison called six rows wrong. Two questions had a `LIMIT 5` in their expected SQL that the question's wording never asked for, so "What concepts are at the edge of what I have read?" was failed for returning all 265 of them. After matching columns by name and then by value, comparing order only where the question says the ranking is the answer, and making the two questions ask for five, all ten passed.
- Friction: none from the platform. The lesson is about the shape of the check: an evaluation written against one's own assumed SQL measures the assumptions first, and every one of those four failures would have been read as a Genie defect by anyone reading the output rather than the diff.
- Workaround or follow-up: a question set now carries `ordered` per question, because whether row order is part of the answer is a property of the question and not of the comparator.

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
