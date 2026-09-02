# Marginalia Databricks intelligence layer

## Goal

Keep Marginalia offline-first while adding an opt-in data and intelligence layer.
IndexedDB remains the reader's working store and EPUB files remain on the device by
default. Cloud features must degrade to cached or unavailable states without affecting
reading, highlighting, chat, import, export, or audiobook playback.

The finished system will:

- emit useful reading behavior as a versioned event stream;
- ingest that stream through Kafka and a triggered Databricks pipeline;
- transform it through Bronze, Silver, and Gold tables with Lakeflow Spark Declarative
  Pipelines;
- enrich books and concepts with targeted Open Library and OpenAlex data;
- derive engagement, interest, momentum, recommendation, and intellectual-frontier
  datasets;
- trace and deploy a reading agent with MLflow and Model Serving;
- train a recommendation model only after real positive and negative feedback exists;
- expose structured analysis through an AI/BI dashboard and a Genie Agent;
- sync selected Gold tables into Lakebase for application reads;
- provide a separate authenticated Databricks App called Marginalia Observatory; and
- expose curated, authenticated MCP tools.

## Non-negotiable boundaries

- The PWA and KOReader remain the reading clients.
- Normal reading must work without a network connection.
- The browser never receives Kafka, Confluent, Databricks, Lakebase, or Model Serving
  credentials.
- Full EPUB files, covers, EPUB fingerprints, CFIs, and surrounding book prose do not
  enter the cloud in the initial implementation.
- Usage metadata and every category of user or book text are opt-in and default off.
- Highlight text, highlight notes, conversation text, assistant text, book metadata,
  book memory, and surrounding prose have separate consent decisions.
- Databricks computes intelligence. Lakebase serves selected results to applications.
- The public reader never connects directly to Lakebase or a Databricks endpoint.
- The Observatory is authenticated and separate from the public reader.
- No learned recommender is trained until the data-readiness gate in Phase 9 passes.
- No write-capable MCP tool is added without an audit table and confirmation contract.

## Locked prototype decisions

These choices remove implementation branches from the first `/goal` runs.

| Decision | Prototype choice | Deferred alternative |
| --- | --- | --- |
| Public deployment | Cloudflare Worker at the existing Marginalia origin | Netlify parity after the Cloudflare path is stable |
| Event endpoint | Same-origin `POST /api/events/v1/batches` | Separate ingestion domain |
| Kafka provider | Confluent Cloud Kafka | Redpanda or self-managed Kafka |
| Worker-to-Kafka protocol | Confluent Kafka REST API v3 over HTTPS | Native Kafka over outbound TCP |
| Kafka-to-Databricks | Structured Streaming Kafka source in a triggered pipeline | Managed Kafka connector in Lakeflow Connect |
| Infrastructure definition | Declarative Automation Bundles checked into this repository | UI-only configuration |
| Transform cadence | Triggered every 15 minutes in the personal prototype | Continuous Gold computation |
| Lakebase serving sync | Triggered after a successful Gold update | Continuous sync |
| Concept model | Databricks pay-per-token endpoint `databricks-gpt-oss-120b` | A later evaluated cheaper or open model |
| Initial client | PWA | KOReader live delivery after the PWA contract is stable |
| Tenancy | One trusted personal user | Multi-user sign-in and row isolation |

The Structured Streaming Kafka source is generally available, so Phase 1 has no preview
dependency. Before Phase 1, verify that the target workspace has Unity Catalog and
serverless compute. If either is unavailable, stop that goal and report the missing
capability. Do not silently switch architectures.

The managed Kafka connector in Lakeflow Connect was the original choice and is kept as
the deferred alternative. It requires continuous pipeline mode, which bills for an
always-running cluster regardless of event volume; at personal scale that cost dominates
every other line in the system. Reconsider it only if ingestion latency below the trigger
interval becomes a real requirement.

Lakebase Change Data Feed is the approved alternative ingestion architecture if the
Kafka connector cannot be used. Its flow would be:

```text
event API -> Lakebase append-only event table -> Lakebase CDF -> Bronze
```

It is not an interchangeable connector setting. Selecting it triggers a new architecture
review and plan revision. At minimum, revise the locked decisions, architecture diagram,
Worker and Databricks trust boundaries, ordering guarantees, retention and deletion
semantics, Phase 1 deliverables and acceptance criteria, observability, and failure
fixtures before implementation resumes.

The concept model changed from `databricks-gpt-5-6-luna` on 2026-09-01. The Phase 3
preflight found that the target workspace does not serve a luna endpoint in its region,
and the plan requires stopping rather than substituting silently. `databricks-gpt-oss-120b`
was chosen from what the workspace does serve: it is the strongest reasoning model
available there, its 128K context holds a book's worth of highlights in one request, and
its adjustable reasoning effort is the cost lever. The endpoint is a bundle variable, so a
later evaluation can move it without touching extraction code.

Current references for the choices above:

- [Connect to Apache Kafka from Databricks](https://docs.databricks.com/aws/en/connect/streaming/kafka/)
- [Kafka authentication options](https://docs.databricks.com/aws/en/connect/streaming/kafka/authentication)
- [Triggered and continuous pipeline modes](https://docs.databricks.com/aws/en/ldp/pipeline-mode)
- [Confluent Cloud Kafka REST API](https://docs.confluent.io/cloud/current/kafka-rest/kafka-rest-cc.html)
- [Lakebase Change Data Feed](https://docs.databricks.com/aws/en/oltp/projects/lakebase-cdf)
- [Lakebase synced tables](https://docs.databricks.com/aws/en/oltp/projects/sync-tables)
- [Databricks Foundation Model APIs](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/)

## Target architecture

```text
Marginalia PWA
    |
    | local product write + atomic IndexedDB outbox event
    | bearer sync token, same-origin HTTPS
    v
Cloudflare Worker: /api/events/v1/batches
    |
    | validates token and schema; assigns trusted user_id
    | Confluent REST credentials held as Worker secrets
    v
Confluent Cloud: marginalia.events.v1
    |
    | SASL/TLS credentials held in a Databricks secret scope
    v
Triggered pipeline: Structured Streaming Kafka source
    |
    v
marginalia_bronze.events_raw
    |
    v
Spark Declarative Pipelines and scheduled jobs
    |
    +--> marginalia_silver.events, sessions, highlights, questions, books
    |
    +--> incremental concept extraction through databricks-gpt-oss-120b
    |
    +--> marginalia_gold.book_engagement, reader_interest_profile,
         intellectual_frontier, recommendation_candidates
                  |
          +-------+-----------+----------------+
          |                   |                |
        AI/BI            Genie Agent      MLflow and
        dashboard                         Model Serving
          |                   |                |
          +-------------------+----------------+
                              |
                      triggered synced tables
                              |
                              v
                         Lakebase Postgres
                              |
                    +---------+----------+
                    |                    |
             Databricks App API     Observatory UI
                    |
                    | OAuth M2M from server-held service principal
                    v
              Cloudflare Worker: /api/intelligence/v1/*
                    |
                    v
          cached Insights view in the PWA
```

The Kafka topic uses one partition for the personal prototype so source order is easy to
inspect. It uses `cleanup.policy=delete` and seven-day retention. The record key is
`<trusted_user_id>:<installation_id>`. Increase partitions only when multi-user traffic
requires it; per-installation ordering must remain stable.

The user-visible freshness objective is 35 minutes: up to 15 minutes for the triggered
ingestion pipeline to reach Bronze, the 15-minute transform cadence, and up to three
minutes for Gold sync and API refresh. Shortening the ingestion interval shortens this
objective and raises pipeline cost proportionally.
The Phase 4 smoke test and end-to-end slice measure this objective from browser event time
to the source timestamp returned by the Insights API.

## Authentication and trust boundaries

### Browser to Worker

The personal prototype uses a random 32-byte base64url Marginalia sync token. The user
pastes it into Settings and the PWA stores it in IndexedDB. The Worker stores only its
SHA-256 digest in the `MARGINALIA_SYNC_TOKEN_SHA256` secret.

The browser sends the token as `Authorization: Bearer <token>`. The Worker hashes the
presented value and performs a constant-time comparison. A valid token maps to the
server-held `MARGINALIA_TRUSTED_USER_ID`. The browser never supplies a user identifier;
any `userId` in a submitted body is rejected.

Rotating the Worker secret invalidates every existing browser token. Multi-user support
must replace this mechanism with normal sign-in and a server-side identity store.

A `SYNC_CONTROL` Workers KV binding stores a metadata-only enabled/disabled flag for the
trusted user. The Worker checks it before accepting events or serving Insights. This is
not the identity store: the token digest remains a secret. Its purpose is to stop every
installation promptly during full cloud deletion. A disabled user receives HTTP 423 and
must not be re-enabled until deletion completes and a new sync token is installed.

"Promptly" is bounded by KV, not by the write. Workers KV is eventually consistent, and a
Worker in another location can keep serving a cached enabled value for up to about a
minute after the disable is written, so an installation that has not yet seen it can still
submit events during that window. Deletion tolerates this because the deletion job runs
well after the request is created, and because the Kafka replay suppression covers records
produced in the gap. Closing the window properly means a Durable Object rather than KV,
which is a deliberate revision to make when multi-user support arrives and the barrier has
to be exact.

The deletion routes are deliberately exempt from the disabled check. Disabling is the
first thing deletion does, so refusing a disabled user would leave a failed request with
no way to retry and the status of the deletion permanently unreadable.

### Worker to Confluent

The Worker holds these deployment secrets or non-secret variables:

```text
CONFLUENT_REST_ENDPOINT
CONFLUENT_CLUSTER_ID
CONFLUENT_API_KEY
CONFLUENT_API_SECRET
CONFLUENT_TOPIC=marginalia.events.v1
```

The API key has produce-only permission on that topic. The Worker uses non-streaming
Kafka REST Produce requests because personal traffic is low and each event needs an
unambiguous delivery report before its outbox row is acknowledged.

### Pipeline to Kafka

A Databricks secret scope stores the read-only Confluent API key and secret. The pipeline
reads them with `dbutils.secrets.get` and passes them through `kafka.sasl.jaas.config`;
credentials never appear in bundle variables committed to Git. Unity Catalog service
credentials are not usable here because they support Amazon MSK only, not Confluent Cloud.

The key is read-only on `marginalia.events.v1` and is a different credential from the
produce-only key the Worker holds. Neither side can perform the other's operation.

### Worker to Databricks App API

The Cloudflare Worker holds OAuth M2M credentials for a dedicated external service
principal with only `CAN USE` on the Databricks App. The Databricks App has its own
service principal and least-privilege resource permissions for Lakebase, Genie, Model
Serving, MLflow experiments, and any required SQL warehouse.

The Worker inserts the trusted user identifier into App API requests. The App accepts
that identifier only from the authorized caller service principal.

### Logging rules

- Browser and Worker logs may contain event IDs, event types, status codes, counts, and
  latency.
- Logs must never contain sync tokens, Kafka credentials, OAuth credentials, highlighted
  text, notes, book metadata, conversation turns, prompts, or model outputs.
- Databricks pipeline quarantine tables may contain consented event payloads and therefore
  use the same access restrictions and retention rules as Bronze.

## Repository layout

Implementation uses the following layout:

```text
contracts/
  events/v1/envelope.schema.json
  events/v1/payloads/*.schema.json
  privacy/v1/consent.schema.json
  fixtures/*.jsonl
src/sync/
  types.ts
  privacy.ts
  outbox.ts
  emit.ts
  delivery.ts
  coordinator.ts
workers/app/src/
  events.ts
  intelligence.ts
  databricks-oauth.ts
  confluent.ts
databricks/
  databricks.yml
  resources/*.yml
  src/pipelines/*.py
  src/jobs/*.py
  src/observatory/
  tests/
```

JSON Schema 2020-12 files are the language-neutral source of truth. TypeScript types
mirror them for the PWA and Worker, and Python code validates fixtures against the same
schemas. Contract tests must fail if a fixture is valid in one runtime and invalid in
the other.

Bundle variables provide the workspace host, catalog, schema names, connection name,
serving endpoint names, and Lakebase target. No workspace URL, credential, or private
resource identifier is committed when it reveals private infrastructure.

The default logical names are:

```text
catalog variable: marginalia_catalog
schemas:
  marginalia_bronze
  marginalia_silver
  marginalia_gold
  marginalia_ops
```

Development and production are separate bundle targets. Development names may receive a
user-specific suffix; production uses the stable logical names above.

## Local storage additions

The next Dexie version adds:

```text
eventOutbox:
  eventId primary key
  sequence
  eventType
  eventTime
  payload
  privacySnapshot
  status = held | pending | rejected
  attempts
  nextAttemptAt
  lastErrorCode
  createdAt

syncState:
  id = "sync"
  installationId
  nextSequence
  leaseOwner
  leaseExpiresAt
  lastSuccessfulDeliveryAt
  pausedReason
  activeDeletionRequestId

insightsCache:
  id = profile name
  payload
  sourceUpdatedAt
  cachedAt
```

Acknowledged events are removed from `eventOutbox`; they are not retained locally as a
second analytics database. `held` is used only for a provisional question that the
existing chat UX may roll back when inference fails: abort or success promotes it to
`pending`, while rollback removes the message and event together. Events rejected
permanently remain visible in a small local diagnostics view until the user retries or
discards them.

Every instrumented product write and its event insertion share one Dexie transaction.
The transaction reads and increments `syncState.nextSequence`, constructs the immutable
event, performs the product write, and inserts the outbox row. If any operation fails,
none of them commit. Existing direct writes are moved behind domain functions as they
become instrumented.

Delivery is coordinated across tabs with the Web Locks API when available. A Dexie lease
with a 30-second expiry is the fallback. A stale tab may repeat delivery, but it must not
mint a new event ID.

When the user enables sync, the PWA requests persistent storage with
`navigator.storage.persist()` when the API is available. A denied or unavailable grant
does not block sync, but Settings warns that the browser may evict queued events under
storage pressure. "Queued indefinitely" means the application imposes no retry limit
while IndexedDB remains present; it is not a guarantee against browser storage eviction
or the user clearing site data.

## Privacy contract

### Consent state

All fields default to `false`:

```text
syncEnabled
shareBookMetadata
shareHighlightText
shareHighlightNotes
shareConversationText
shareAssistantText
shareBookMemory
shareSurroundingContext
```

`syncEnabled` permits envelope and behavioral metadata. Every other setting permits only
the named content category. Enabling a content category without `syncEnabled` stores the
preference but sends nothing.

The consent record includes `consentVersion=1` and `consentUpdatedAt`. Each event stores a
privacy snapshot listing only the content categories included in that event.

### Field matrix

| Data | Required consent | Initial behavior |
| --- | --- | --- |
| Event ID, installation ID, sequence, type, timestamps | `syncEnabled` | Included |
| Opaque local entity IDs, progress, color, chapter label | `syncEnabled` | Included |
| Title, author, publisher, date, language, description | `shareBookMetadata` | Included only when true |
| Highlighted passage | `shareHighlightText` | Included only when true |
| User-authored highlight note | `shareHighlightNotes` | Included only when true |
| User questions and conversation seed text | `shareConversationText` | Included only when true |
| Assistant replies | `shareAssistantText` | Included only when true |
| Rolling book digest | `shareBookMemory` | Included only when true |
| Prose surrounding a highlight or question | `shareSurroundingContext` | Excluded from the first vertical slice even when true |
| EPUB bytes, cover bytes, file hash, serialized locations, CFI | Not uploadable in v1 | Always excluded |

Hashes of excluded content are also excluded because they can reveal equality. Assistant
text is never used to infer reader interest; otherwise the system would learn from its
own generated output.

### Enabling, revoking, and backfill

- Enabling sync affects future product actions only. There is no automatic historical
  upload.
- An explicit `Upload existing data` flow may be added later and must preview categories
  and record counts before enqueueing anything.
- Turning off `syncEnabled` stops delivery immediately and deletes all unacknowledged
  outbox rows.
- Revoking a content category deletes unacknowledged events containing that category and
  emits a metadata-only `privacy_consent_changed` event if sync remains enabled.
- Revocation does not claim that already delivered data disappeared. The Settings UI
  separately offers `Delete my cloud data`, which uses the deletion workflow below.

## Event contract v1

Events are immutable. The browser creates this envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "uuid-v4",
  "installationId": "uuid-v4",
  "sequence": 42,
  "source": "pwa",
  "appVersion": "0.0.0+git-sha",
  "eventType": "highlight_created",
  "eventTime": "2026-09-01T14:30:00.000Z",
  "emittedAt": "2026-09-01T14:30:00.050Z",
  "entities": {
    "bookId": "opaque-local-id",
    "highlightId": "opaque-local-id"
  },
  "privacy": {
    "consentVersion": 1,
    "included": ["highlightText"]
  },
  "payload": {}
}
```

The Worker adds `userId` and `receivedAt` after authentication. The Kafka record never
contains the bearer token.

Rules:

- IDs are lowercase UUID v4 values for newly created local entities and events. Imported
  KOReader IDs remain entity references but never become event IDs.
- `sequence` starts at 1 and increases per installation. Gaps are allowed; regression is
  a diagnostic error but not a reason to discard a unique event.
- `eventTime` records when the product action happened. `emittedAt` records when the
  immutable envelope was created. `receivedAt` is authoritative for ingestion latency.
- Clocks more than 24 hours in the future are flagged in Silver and use `receivedAt` for
  ordering. Old offline events remain valid.
- Unknown schema versions are quarantined, never coerced.
- Unknown fields in a known v1 payload are rejected at the Worker so accidental private
  data cannot pass through a permissive schema.

### Initial payloads

`highlight_created` carries a full consent-filtered snapshot:

```json
{
  "color": "yellow",
  "chapter": "First Essay",
  "progress": 0.18,
  "createdAt": "2026-09-01T14:30:00.000Z",
  "text": "optional consented passage",
  "note": "optional consented note"
}
```

`highlight_updated` carries the current consent-filtered snapshot plus
`changedFields`. `highlight_deleted` carries only `deletedAt` and entity IDs.

`conversation_started` carries its created time, title, chapter, progress, optional
consented seed text, and entities `bookId` and `conversationId`. It is emitted atomically
with creation of the local conversation, before any question event refers to that ID.

`question_asked` carries:

```json
{
  "createdAt": "2026-09-01T14:35:00.000Z",
  "chapter": "First Essay",
  "progress": 0.18,
  "content": "optional consented user question"
}
```

Its entities include `bookId`, `conversationId`, and `messageId`.
`assistant_response_received` has the same entity identifiers, latency in milliseconds,
model label, success status, and optional consented assistant content.

### Vocabulary and ownership

| Family | Events | First instrumented phase |
| --- | --- | --- |
| Privacy | `privacy_consent_changed`, `cloud_deletion_requested` | 0 and 4 |
| Library | `book_added`, `book_archived`, `book_restored`, `book_deleted` | 5 |
| Reading | `book_opened`, `book_closed`, `reading_progressed`, `chapter_entered`, `book_completed`, `book_reopened` | 2 |
| Highlights | `highlight_created`, `highlight_updated`, `highlight_deleted` | 0 |
| Conversations | `conversation_started`, `question_asked`, `assistant_response_received`, `conversation_resumed`, `conversation_deleted` | 0 and 5 |
| Recommendations | `recommendation_shown`, `recommendation_opened`, `recommendation_dismissed`, `recommended_book_added`, `recommended_book_started` | 8 |

Each event type gets a payload schema before application code may emit it.

## Delivery contract

The PWA sends at most 20 events and 128 KiB of uncompressed JSON per request:

```text
POST /api/events/v1/batches
Authorization: Bearer <sync-token>
Content-Type: application/json

{ "events": [...] }
```

The endpoint is same-origin, accepts only `POST`, rejects bodies above the limit, and
returns `Cache-Control: no-store`. The Worker validates every event before producing any
event in that request.

The client uses head-of-line delivery. It selects the oldest unacknowledged non-held
event by sequence and may include only the following eligible outstanding sequence
values. Numeric gaps are allowed because consent revocation can remove queued rows. If a
lower-sequence event is held, rejected, or in backoff, no later event for that
installation is eligible. A permanently rejected head event pauses that installation
until the user retries or discards it from diagnostics.

The Worker sends the batch to Confluent sequentially in sequence order. The first result
that is not `accepted` stops production; unattempted later events are returned as `retry`
with code `blocked_by_prior_event`. The Worker returns one result per event:

```json
{
  "results": [
    { "eventId": "...", "status": "accepted" },
    { "eventId": "...", "status": "retry", "code": "upstream_unavailable" }
  ]
}
```

Status behavior:

- `accepted`: remove the outbox row.
- `retry`: keep it with exponential backoff and jitter.
- `rejected`: keep it in local diagnostics and do not retry automatically.
- HTTP 401: pause the delivery loop as `invalid_token` until Settings changes.
- HTTP 413: halve the batch and retry; a single oversized event becomes `rejected`.
- HTTP 429 or 5xx: retry.

Retry delay is `min(5 minutes, 2^attempts seconds)`, plus 0–25% random jitter. Retryable
events have no application-level attempt limit and remain queued while IndexedDB exists
until acknowledged, discarded by the user, or removed by consent revocation. Online,
visibility, and a 60-second timer trigger delivery; normal reading never waits for it.

The Worker acknowledges an event only after Confluent returns a successful delivery
report. A network failure after Kafka accepted the record can cause a retry and duplicate
Kafka record, which downstream deduplication is required to handle.

## Data layers and semantics

### Bronze

```text
marginalia_bronze.events_raw
marginalia_bronze.ingestion_quarantine
marginalia_bronze.openlibrary_records
marginalia_bronze.openlibrary_ratings
marginalia_bronze.openlibrary_reading_logs
marginalia_bronze.openalex_responses
```

`events_raw` preserves Kafka topic, partition, offset, and Kafka timestamp, which the
Kafka source exposes as native columns, alongside the raw JSON value, parsed envelope
fields, and pipeline ingestion time. An envelope field the pipeline does not recognize is
kept in the raw JSON rather than dropped. Kafka coordinates are unique ingestion
identifiers, not product-event identifiers.

Bronze retains valid and malformed source records for 30 days. Quarantine retains
failures for 14 days. Access is limited to the pipeline and Observatory administrators.

### Silver

```text
marginalia_silver.events
marginalia_silver.event_conflicts
marginalia_silver.reading_sessions
marginalia_silver.books
marginalia_silver.highlights_current
marginalia_silver.highlight_history
marginalia_silver.conversations
marginalia_silver.questions
marginalia_silver.agent_responses
marginalia_silver.concepts
marginalia_silver.concept_aliases
marginalia_silver.highlight_concepts
marginalia_silver.question_concepts
marginalia_silver.research_works
```

`events` has primary logical key `(user_id, event_id)`. The first valid Kafka occurrence
wins. A later occurrence with the same canonical payload hash is a harmless delivery
duplicate. A later occurrence with different content is written to `event_conflicts` and
never mutates the accepted event.

No bounded event-time watermark may permanently discard an offline event. Incremental
jobs track affected user, book, and UTC date partitions and recompute those partitions
when late data arrives.

Current-state tables apply creates, updates, and deletes in `(event_time, sequence,
received_at)` order within an installation. Cross-installation conflicts use the latest
`event_time`, then `received_at`; all source events remain auditable in history.

### Reading sessionization v1

- A session begins with `book_opened` or the first active reading event after 30 minutes
  without activity for that user, installation, and book.
- `book_closed` ends a session when available.
- Otherwise a gap of 30 minutes ends the previous session at its last active event.
- Active seconds are the intervals between adjacent active reading events, with each
  interval capped at 120 seconds to avoid counting an abandoned open page.
- A session ID is a deterministic hash of user ID, installation ID, book ID, and the
  first event ID.
- `reading_progressed` is emitted at most every 30 seconds and only after progress moves
  by at least 0.002, the chapter changes, or the reader closes or backgrounds the book.
- Progress is monotonic for completion calculations but raw backward navigation remains
  visible in Silver events.

### Gold

Initial tables are:

```text
marginalia_gold.book_engagement
marginalia_gold.reader_interest_profile
marginalia_gold.intellectual_frontier
marginalia_gold.recommendation_candidates
```

All scoring formulas carry a `score_version`, source update timestamp, and enough
component columns to explain the final number.

#### Book engagement v1

One row per `(user_id, book_id)` with active minutes, session count, active days,
current and maximum progress, current highlight count, question count, completion,
first/last activity, and engagement score.

```text
engagement_score_v1 =
  0.30 * min(1, log1p(active_minutes) / log1p(300)) +
  0.15 * min(1, log1p(session_count) / log1p(20)) +
  0.15 * maximum_progress +
  0.15 * min(1, current_highlights / 10) +
  0.15 * min(1, questions / 10) +
  0.10 * completed
```

#### Concept extraction v1

Only new or changed consented highlight text, notes, user questions, book memory, and
book descriptions are candidates. Assistant text and surrounding context are excluded.

The extraction job calls `databricks-gpt-oss-120b` with prompt version
`concept-extraction-v1`, temperature 0, and a JSON-only schema. It requests 1–8 concise
concept labels, an optional broader concept, and confidence from 0 to 1. Results record:

```text
source_type, source_id, source_content_hash, model_endpoint, prompt_version,
raw_concept, canonical_concept, confidence, extracted_at, raw_response,
validation_status
```

`source_content_hash` is computed only for consented text already in Databricks. Invalid
model responses are quarantined and retry at most three times. After the third failure,
the candidate becomes `permanent_failure`, is excluded from profiles, remains visible in
pipeline diagnostics, and alerts the job owner. Manual retry requires a changed prompt,
model, validator version, or an explicit operator action. Contract and pipeline tests use
fixed model responses; live model calls are tested separately and never make the
deterministic suite flaky.

The live Nietzsche evaluation uses a fixed public-domain highlight whose reference
concepts are `morality`, `genealogy of morality`, `value judgment`, `good and evil`, and
`origin of moral values`. After alias canonicalization, a passing live response recalls
at least four of those five concepts and adds no more than two concepts unsupported by
the fixture. The deterministic fixed-response test must match all five exactly.

Canonicalization lowercases, Unicode-normalizes, singularizes simple English plurals,
applies `concept_aliases`, and preserves both raw and canonical values. Alias changes
create a new canonicalization version rather than rewriting provenance invisibly.

#### Reader interest profile v1

One row per `(user_id, concept_id)`. Evidence contributions are:

```text
highlight passage: 1.0
highlight note:    1.5
user question:     2.0
book memory:       0.75
book description: 0.25
assistant text:    0.0
```

Each contribution is multiplied by extraction confidence and exponential recency decay
with a 90-day half-life. Raw interest is the sum. `interest_score` divides each raw value
by the maximum raw value for that user, producing 0–1. The table also exposes evidence
count, distinct books, first/last evidence time, and the top five source IDs.

#### Intellectual frontier v1

A frontier concept is not directly established interest. It is adjacent to established
concepts through research-work subjects, concept co-occurrence, or embedding similarity.
Candidates with direct evidence count greater than zero are excluded.

```text
frontier_score_v1 =
  0.45 * similarity_to_established_interests +
  0.35 * normalized_neighbor_strength +
  0.20 * source_quality
```

Every row names the established concepts and public works that explain the candidate.

#### Recommendation heuristic v1

Candidate public works exclude books already in the library, works dismissed within 90
days, or rows missing a stable OpenAlex work ID. Open Library work keys identify matches
to books already in the reader's library; OpenAlex work IDs identify the external research
rows that supply frontier and recommendation candidates. They are deliberately not joined
as though they were the same identifier namespace. Components are:

```text
0.45 concept-interest match
0.20 frontier coverage
0.15 diversity from recently read authors and subjects
0.10 OpenAlex citation prior
0.10 metadata completeness
```

Recommendations always expose component scores and a short deterministic explanation.
No generated prose is required to serve them.

## Lakebase serving contract

The first synced tables are:

```text
marginalia_gold.reader_interest_profile
  primary key: (user_id, concept_id)

marginalia_gold.book_engagement
  primary key: (user_id, book_id)
```

Both Gold sources are materialized views, which cannot publish Delta Change Data Feed:
the table property is accepted and ignored, and a sync that reads the feed fails rather
than degrading. Lakebase therefore uses Snapshot sync after a successful Gold job, which
re-copies each table. For one reader's profile that is cheaper than the machinery an
incremental sync would need. Synced Postgres tables are treated as read-only; indexes may be
added for `user_id`, but the application never updates analytical rows in place.

The Databricks App API exposes:

```text
GET  /api/v1/users/{trusted_user_id}/interest-profile
GET  /api/v1/users/{trusted_user_id}/book-engagement
POST /api/v1/users/{trusted_user_id}/deletion-requests
GET  /api/v1/users/{trusted_user_id}/deletion-requests/{request_id}
```

Only the trusted Cloudflare caller may use user-specific routes in the personal
prototype. The public Worker exposes corresponding endpoints without a browser-supplied
user ID:

```text
GET  /api/intelligence/v1/interest-profile
GET  /api/intelligence/v1/book-engagement
POST /api/intelligence/v1/delete
GET  /api/intelligence/v1/delete/{request_id}
```

Private responses use `Cache-Control: no-store`. The PWA saves the last successful
response in `insightsCache` and shows its source timestamp. Offline or failed refreshes
show cached insights with a stale label; absence of cached data shows an unavailable
state and never blocks reading.

## Cloud deletion workflow

`Delete my cloud data` requires an explicit confirmation in Settings. The browser first
creates a deletion request UUID. One local transaction stores it as
`activeDeletionRequestId`, sets `syncEnabled=false`, purges the outbox, and clears the
Insights cache. The browser then calls the Worker with that request ID and its sync token. The Worker
sets the trusted user's `SYNC_CONTROL` state to disabled before it creates an idempotent
deletion request in `marginalia_ops.deletion_requests` through the Databricks App. This
blocks other installations that still hold the token. If request creation fails, sync
remains disabled locally and at the Worker; retrying uses the same request ID.

The deletion job uses a versioned resource manifest so it deletes only resources that
exist in the deployed phase. Phase 8 extends that manifest with MLflow traces and
evaluation tables. The job:

1. pauses serving for the user;
2. deletes the user's rows from Bronze, quarantine, Silver, Gold, concept-extraction
   results, recommendation outcomes, and operational caches; triggers Lakebase sync from
   the deleted Gold sources; and verifies absence from the read-only synced tables;
3. deletes or redacts user-linked MLflow traces and evaluation rows when Phase 8 has
   created them;
4. clears the PWA Insights cache after the API reports success;
5. records only request ID, trusted user ID, timestamps, status, manifest version,
   affected table counts,
   and errors in the restricted audit table; and
6. schedules file cleanup according to the configured Delta retention policy.

Operational query removal must complete within 24 hours. Kafka can retain already
delivered records for up to seven days, so the deletion remains `purging_source` until
topic retention has passed. Pipelines suppress the user while a deletion request is
active, preventing a retained event from repopulating served tables. A scheduled purge
removes any Bronze rows re-created by connector replay, and a final purge runs after the
Kafka retention interval. Completion means
the user is absent from all queryable application, Bronze, Silver, Gold, and Lakebase
tables and the Kafka retention interval has elapsed. Provider-managed backup retention
is documented honestly rather than claimed to be under application control.

Deleting a local book or conversation emits its normal entity-deletion event; it does
not imply full-account cloud deletion. Those events remove the current entity from
Silver and recompute derived rows while preserving the consented event history until
retention or a full cloud deletion request applies.

## Public-data ingestion

Open Library matching starts only for books with `shareBookMetadata=true`. Matching uses
stable identifiers when available, then normalized title and author with an explicit
confidence score. Ambiguous matches remain unresolved rather than silently attaching the
wrong work.

Raw API responses land in Bronze with request URL stripped of secrets, retrieval time,
HTTP status, ETag when available, parser version, and source license metadata. Jobs use
conditional requests and provider-friendly rate limits.

`marginalia_silver.public_request_subjects` links every raw request to the user and book or
concept that caused it. The link is written even for errors and empty results, drives retry
and TTL eligibility, and gives cloud deletion a complete request-ID path into the otherwise
public raw response table. The first deployment backfills links for requests already
represented in `book_work_matches` or `research_works`.

OpenAlex enrichment is targeted, not a bulk mirror. Queries begin from concepts and
works already present in a user's profile. Research works retain source IDs, titles,
authorship, publication dates, concepts, cited-by counts, and retrieval provenance.

## Observatory, Genie, Librarian, and MCP boundaries

### Observatory

Marginalia Observatory is a Databricks App with:

```text
Overview
Reading
Interests
Concepts
Frontier
Recommendations
Agent quality
Ask Marginalia
```

Every visualization shows its source update time and links aggregate values to the
underlying evidence rows. The App uses its own service principal and resource bindings;
it contains no pasted PAT or database password.

### Genie

The Genie Agent answers structured analytical questions over curated Gold tables. Its
instructions define table grain, score versions, join keys, and prohibited raw-text
access. It is evaluated with fixed questions whose expected SQL result is known.

### Librarian

The Librarian handles semantic and interpretive questions. It retrieves only content the
user consented to upload, returns evidence IDs and book/chapter labels, obeys the current
spoiler position, and treats book text as untrusted data.

MLflow traces retrieval, tool calls, model identity, prompt version, latency, token use,
and cost. Evaluation covers retrieval relevance, citation correctness, spoiler
violations, prompt-injection resistance, unsupported claims, latency, and cost. The
first deployment is a Model Serving agent endpoint; an orchestrator between Genie and
the Librarian is deferred until both are independently reliable.

### MCP

The initial MCP server is authenticated and read-only. Tools return structured records
for highlights, conversations, interest profiles, trajectories, frontiers,
recommendations, comparisons, and reading statistics. Each tool enforces the caller's
trusted user scope server-side. Prompt-supplied user IDs never select another user's
data.

Write tools are a separate approval. Each must define idempotency, an audit row, a
preview response, explicit confirmation, and a compensating or deletion action.

## Delivery phases

Each phase is an independently completable `/goal`. A goal must not silently continue
into the next phase.

### Implementation status (2026-09-02)

| Phase | Status | Evidence and remaining gate |
| --- | --- | --- |
| 0 | Complete | Local contracts, privacy controls, outbox, fixtures, and repository checks landed. |
| 1 | Complete | Authenticated ingress and triggered Bronze ingestion were deployed and exercised. |
| 2 | Complete | Silver deduplication, quarantine, highlights, and sessions were deployed and exercised. |
| 3 | Complete | Incremental extraction and Gold profiles ran against live data; the evaluation passed at 4/5 recall and 0 unsupported additions. |
| 4 | Complete | Verified end to end on 2026-09-02 against the deployed Worker and a real reading session. A highlight made in the browser at 14:04:15Z was readable through the same-origin Worker at 14:15:11Z, inside the 35-minute objective; the schedule was triggered by hand rather than waited for, so an unattended run adds up to the schedule interval. Missing and invalid sync tokens were refused at the Worker, an unauthenticated caller at the App. Cloud deletion removed one reader from every layer including the serving copies, left the other reader intact, and settled on `purging_source` until the topic retention window closes. |
| 5 | Complete | Behavioral event contracts and atomic PWA instrumentation landed; existing KOReader handoff remains offline and idempotent. |
| 6 | Complete | Public-source ingestion, matching, frontier, and heuristic recommendations passed local tests, bundle validation, selected-compute egress, a cache/TTL rerun, live materialization, and SQL checks for keys, provenance, score reproduction, direct-interest exclusion, and deletion linkage. The client-side dismissal emitter remains Phase 9 work, so dismissed exclusion is contract- and transformation-tested here but not yet a live UI loop. |
| 7 | Implemented; live acceptance in progress | Preflight passed: Apps, AI/BI dashboards, and Genie are all enabled and manageable by the deploying identity. The Observatory app, the dashboard, and a curated Genie space are deployed. The boundary is a grant rather than a guideline: the Observatory's service principal holds `SELECT` on Gold and on exactly two Silver tables by name, and nothing on `highlights_current` or `events`, which was verified against the live grants. The fixed question set runs and produces known-correct answers. Genie's own answers have not yet been compared against them by hand. |
| 8-11 | Not started | Later phases retain the preflight and sequencing gates below. |

This table is the status record; phase headings below remain the normative deliverables and
acceptance criteria. A later phase having code does not make an earlier incomplete phase
complete.

### Phase 0: local contracts, privacy, outbox, and fixtures

Deliver:

- JSON event and privacy schemas;
- Dexie migration for `eventOutbox`, `syncState`, and `insightsCache`;
- Settings UI with every consent default off;
- atomic sequence and outbox helpers;
- cross-tab delivery coordination and retry state machine using a fake transport;
- realistic Nietzsche highlight and question fixture streams;
- deterministic deduplication and sessionization reference functions;
- representative highlight create/update/delete, conversation-start, and question
  events; and
- local diagnostics for rejected events.

Do not add network delivery, provision infrastructure, or deploy anything.

Acceptance:

- existing users migrate without losing books, highlights, conversations, settings, or
  audiobook state;
- product write and event insertion either both commit or both roll back;
- all consent settings are false for new and migrated users;
- no event is queued while sync is disabled;
- revocation removes affected queued content;
- two tabs cannot mint the same sequence or deliver concurrently beyond lease recovery;
- enabling sync requests persistent browser storage and a denied request produces the
  documented eviction warning;
- head-of-line retry tests never send a later sequence while an earlier one is waiting;
- retry tests reuse the same event ID;
- fixtures validate identically in TypeScript and Python; and
- `npm test`, `npm run lint`, `npx tsc -b`, and `npm run build` pass.

### Phase 1: authenticated ingress to Bronze

Preflight:

- verify Databricks CLI authentication and target workspace identity;
- verify Unity Catalog and serverless compute;
- create or identify the Confluent cluster in the same cloud region when practical; and
- verify the Cloudflare deployment can reach the Confluent REST endpoint.

Deliver:

- Confluent topic, least-privilege credentials, and retention configuration;
- Worker batch endpoint, token validation, schema validation, rate limits, and producer;
- PWA network delivery loop;
- Databricks secret scope holding the read-only Confluent credentials;
- triggered pipeline reading the Kafka source into `marginalia_bronze.events_raw`;
- DAB development target and validation commands; and
- ingestion observability without payload logging.

Acceptance:

- an opted-in fixture highlight reaches Bronze on the next pipeline run;
- an invalid token, browser-supplied user ID, oversized batch, unknown field, and unknown
  schema version are rejected;
- Confluent or network failure leaves the exact event queued;
- a simulated lost acknowledgement creates two Bronze records with the same `event_id`,
  ready for Phase 2 deduplication;
- a pipeline run that starts after a gap resumes from its committed offset and ingests
  every record produced while it was stopped;
- text excluded by consent never appears in Worker logs, Kafka, or Bronze;
- `databricks bundle validate -t dev` passes; and
- live Databricks work is recorded in `docs/databricks-feedback.md`.

### Phase 2: Silver events, highlights, and reading sessions

Deliver:

- Bronze parsing and quarantine rules;
- event deduplication and divergent-duplicate detection;
- highlight current/history tables;
- reading event instrumentation and v1 sessionization;
- late-event recomputation; and
- data-quality expectations for IDs, timestamps, progress, and required entities.

Acceptance:

- duplicate fixture events produce one Silver event;
- the two Bronze records from the Phase 1 lost-acknowledgement fixture produce one
  logical Silver event;
- divergent duplicate payloads appear in `event_conflicts`;
- create/update/delete reconstruct the expected highlight state;
- explicit close, idle timeout, backward navigation, late arrival, and future-clock
  fixtures produce the documented sessions; and
- malformed events remain inspectable without stopping valid records.

### Phase 3: concept extraction and first Gold profiles

Preflight:

- verify the workspace exposes `databricks-gpt-oss-120b` in its region;
- verify the job service principal can query the endpoint and write the extraction and
  Gold tables; and
- run one non-private synthetic request through the JSON validator. Stop rather than
  substituting a model if any check fails.

Deliver:

- incremental extraction candidates keyed by source-content hash;
- `concept-extraction-v1` prompt and JSON validator;
- fixed-response deterministic tests and a small live evaluation set;
- concept aliases and canonicalization versioning;
- `book_engagement` and `reader_interest_profile`; and
- component-level explanations and provenance.

Acceptance:

- unchanged source content is not extracted twice;
- changed or deleted content updates downstream evidence correctly;
- no unconsented or assistant text enters extraction;
- the Nietzsche fixed-response test matches all five reference concepts and the live
  evaluation recalls at least four of five with at most two unsupported additions;
- three invalid responses terminate as `permanent_failure`, remain diagnosable, and do
  not contribute to a profile;
- every Gold score recomputes from exposed component columns; and
- model, prompt version, latency, and cost are recorded without raw text in logs.

### Phase 4: first serving loop and Insights

Preflight:

- verify Lakebase, Databricks Apps, and triggered synced tables are enabled;
- verify Delta Change Data Feed and the documented composite primary keys are accepted;
- verify the external caller service principal can obtain OAuth M2M credentials and has
  only `CAN USE` on the App; and
- verify the App service principal can reach its declared Lakebase resources. Stop on a
  missing capability rather than changing the serving architecture.

Deliver:

- Lakebase project and triggered synced tables;
- Databricks App API with Lakebase resource binding;
- external service-principal OAuth from Cloudflare;
- public Worker intelligence endpoints;
- PWA Insights view and IndexedDB cache; and
- full cloud deletion request and status UI.

Acceptance:

- an interest profile is queryable from Lakebase by its documented primary key;
- the browser receives it only through the same-origin Worker;
- invalid sync tokens and unauthorized service principals cannot read it;
- cached Insights remain visible offline and are labeled stale;
- no Insights state affects normal reader operation; and
- a fixture event appears through Insights within 35 minutes of its browser event time;
- deletion disables local sync and the Worker's `SYNC_CONTROL`, clears the requesting
  browser's outbox/cache, removes the user from every queryable layer deployed through
  Phase 4, and suppresses retained Kafka replay.

### Phase 5: complete behavioral event coverage

Deliver library, remaining reading, conversation lifecycle, completion, and reopen event
schemas and instrumentation. Add KOReader export or delivery support without requiring
KOReader to be online during reading.

Acceptance requires contract fixtures for every event, atomic PWA writes, idempotent
KOReader imports, and no change to existing offline behavior.

### Phase 6: public data, frontier, and heuristic recommendations

Preflight:

- verify Open Library and OpenAlex are reachable from the selected Databricks compute;
- record their current authentication, rate-limit, attribution, and license requirements;
  and
- confirm the planned stored fields and request cadence comply. Stop and revise the
  source plan if they do not.

Deliver Open Library matching and ingestion, targeted OpenAlex enrichment, intellectual
frontier v1, recommendation heuristic v1, explanation fields, and source provenance.

Acceptance requires correct handling of ambiguous book matches, cached/rate-limited
source calls, reproducible scores, exclusion of owned/dismissed books, and evidence links
for every frontier and recommendation row.

### Phase 7: Observatory, dashboard, and Genie

Preflight:

- verify Databricks Apps, AI/BI dashboards, and Genie are enabled in the workspace;
- verify the deployment identity can create or manage each resource; and
- verify the App and Genie service principals can be granted only the documented
  resources. Stop rather than replacing a product surface.

Deliver the Databricks App UI, AI/BI dashboard, curated Genie space, resource permissions,
and fixed analytical evaluation questions.

Acceptance requires authenticated access, least-privilege resources, accurate source
timestamps, correct answers on the fixed question set, and no raw-text table exposed to
Genie unless explicitly required and consented.

### Phase 8: Librarian

Preflight:

- verify MLflow tracing/evaluation and agent Model Serving are enabled in the region;
- verify the deployment and runtime service principals have the documented permissions;
  and
- verify a synthetic agent can be traced and queried without private reader data.

Deliver retrieval indexes, the Librarian agent, MLflow tracing and evaluation, Model
Serving deployment, spoiler controls, and Observatory integration.

Acceptance thresholds are set before deployment. At minimum: no cross-user evidence,
zero spoiler violations in the blocking suite, evidence IDs on every interpretive claim,
prompt-injection tests passing, and latency/cost reported against the chosen baseline.
Extend the deletion resource manifest and acceptance suite to cover every MLflow trace,
evaluation table, retrieval index, and Model Serving state introduced in this phase.

### Phase 9: recommendation feedback and data-readiness gate

Deliver heuristic recommendations through Lakebase and record impressions, opens,
dismissals, additions, and starts.

The learned ranker is blocked until the dataset contains at least:

- 500 recommendation impressions;
- 50 positive outcomes (`recommended_book_added` or `recommended_book_started`);
- 50 explicit negatives (`recommendation_dismissed`);
- 20 distinct candidate books;
- 8 weeks of outcomes; and
- enough events to place at least 20% of outcomes in a temporal holdout without sharing a
  future interaction with training features.

These are minimum engineering gates, not a claim that the resulting model will be good.

### Phase 10: learned ranking

Train a simple interpretable baseline such as logistic regression or gradient-boosted
trees on frozen, versioned features. Compare it with the heuristic on the temporal
holdout using ranking quality, calibration, coverage, diversity, and negative-feedback
rate. Do not deploy unless it improves the primary registered metric without violating
diversity and coverage guardrails. Record the exact training data version, feature
definitions, algorithm, parameters, metrics, and model lineage in MLflow.

### Phase 11: MCP

Deliver authenticated read-only tools, JSON schemas, pagination, rate limits, user-scope
isolation tests, audit logs, and tool documentation. Consider narrowly scoped writes only
after the read surface is stable.

## First end-to-end vertical slice

The first slice spans Phases 0–4 and has no hidden Phase 6 dependency. Its data path
through Gold has run successfully and every stage below is now deployed by the bundle. The
slice is complete once the App is deployed with its caller service principal and the
freshness and deletion acceptance runs pass:

```text
Nietzsche highlight
      -> atomic IndexedDB outbox
      -> authenticated Cloudflare event API
      -> Confluent Cloud Kafka
      -> triggered Kafka ingestion pipeline
      -> Bronze event
      -> deduplicated Silver highlight
      -> databricks-gpt-oss-120b concept extraction
      -> Gold reader interest profile
      -> triggered Lakebase synced table
      -> authenticated Databricks App API
      -> Cloudflare intelligence API
      -> cached Marginalia Insights
```

The slice is complete only when:

- offline reading and existing features still pass their verification suite;
- failed delivery stays queued and retries reuse the same event ID;
- duplicate Kafka delivery produces one logical action;
- every excluded content category is absent before the event leaves the browser;
- the expected record and provenance are visible at every layer;
- Gold scores reproduce from their documented components;
- Insights work online, degrade to a labeled cache offline, and never block reading;
- secrets and private text are absent from logs and committed files;
- full cloud deletion removes queryable copies and suppresses retained-source replay;
- the fixture event is returned by Insights within 35 minutes of browser event time;
- bundle validation, local tests, lint, typecheck, production build, and live smoke checks
  pass; and
- every hands-on Databricks phase appends concise feedback to
  `docs/databricks-feedback.md`.

## `/goal` execution guidance

Start with Phase 0 as its own persistent goal. Use this objective:

```text
Implement and verify Phase 0 from docs/databricks-intelligence-plan.md. Stay within
Phase 0: add the versioned event and privacy contracts, Dexie outbox/sync/cache migration,
opt-in Settings controls, atomic event helpers, fake delivery and coordination, fixtures,
deterministic semantics, representative highlight and question instrumentation, and local
diagnostics. Do not provision, deploy, or use external services. Preserve all existing
offline behavior. Finish only when the Phase 0 acceptance criteria and repository checks
pass.
```

After Phase 0 is reviewed, create a new goal for Phase 1. External phases must use the
phase preflight and stop on missing access rather than inventing credentials, changing
providers, or weakening acceptance criteria.
