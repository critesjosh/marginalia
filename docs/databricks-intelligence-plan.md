# Marginalia Databricks intelligence layer

## Goal

Keep Marginalia offline-first while adding an opt-in data and intelligence layer. IndexedDB remains the reader's working store. EPUB files remain on the device by default.

The finished system will:

- emit useful reading behavior as an event stream;
- ingest that stream through Kafka and Lakeflow Connect;
- transform it through Bronze, Silver, and Gold tables with Spark Declarative Pipelines;
- enrich books and concepts with Open Library and targeted OpenAlex data;
- derive reading engagement, interest, momentum, recommendation, and intellectual-frontier datasets;
- trace and deploy a reading agent with MLflow and Model Serving;
- train a recommendation model only after real feedback data exists;
- expose structured analysis through an AI/BI dashboard and a Genie Agent;
- sync selected Gold tables into Lakebase for application reads;
- provide a separate Databricks App called Marginalia Observatory;
- expose curated, authenticated MCP tools.

## Boundaries

- The PWA and KOReader remain the reading clients.
- Normal reading must work without a network connection.
- The browser never receives Kafka, Databricks, Lakebase, or Model Serving credentials.
- Full EPUB files do not enter the cloud by default.
- Highlight, note, and conversation text each require explicit consent.
- Databricks computes intelligence. Lakebase serves selected results to the application.
- The Observatory is authenticated and separate from the public reader.

## Architecture

```text
Marginalia PWA and KOReader
        |
        | opt-in events with a Marginalia sync token
        v
Cloudflare or Netlify event API
        |
        | server-held Kafka credentials
        v
Kafka or Redpanda
        |
        v
Lakeflow Connect
        |
        v
Bronze event stream
        |
        v
Spark Declarative Pipelines
        |
        +--> Silver sessions, highlights, questions, books, concepts
        |
        +--> Gold engagement, interests, frontier, recommendations
                  |
          +-------+----------+----------------+
          |                  |                |
        AI/BI          Genie Agent       MLflow and
        dashboard                        Model Serving
          |                  |                |
          +------------------+----------------+
                             |
                       synced tables
                             |
                             v
                          Lakebase
                             |
                    +--------+---------+
                    |                  |
              Marginalia API     Observatory App
                                       |
                                      MCP
```

Lakebase Change Data Feed is the fallback ingestion path if the managed Kafka connector is unavailable. The first implementation uses one path, not both.

## Authentication

The personal prototype uses a random Marginalia sync token. The reader stores it in IndexedDB and sends it as a bearer token to the event API. The API validates it and assigns the trusted user identifier. It never trusts a user identifier supplied by the browser.

The event API stores Kafka credentials as deployment secrets. For reads, the API calls an authenticated Databricks App API with server-held service-principal OAuth credentials. The Databricks App accesses Lakebase, Genie, and Model Serving through its own resource permissions.

Replace the pasted token with normal sign-in before supporting multiple users.

## Event model

Events are immutable and versioned. Every event has a unique identifier, installation-local sequence, source, application version, event time, emission time, and relevant entity identifiers.

Initial vocabulary:

- library: `book_added`, `book_archived`, `book_restored`, `book_deleted`;
- reading: `book_opened`, `book_closed`, `reading_session_started`, `reading_session_ended`, `reading_progressed`, `chapter_entered`, `book_completed`, `book_reopened`;
- highlights: `highlight_created`, `highlight_updated`, `highlight_deleted`;
- conversations: `conversation_started`, `question_asked`, `assistant_response_received`, `conversation_resumed`, `conversation_deleted`;
- recommendations: `recommendation_shown`, `recommendation_opened`, `recommendation_dismissed`, `recommended_book_added`, `recommended_book_started`.

The browser uses an IndexedDB outbox. A product write and its event should share one IndexedDB transaction whenever possible. Delivery retries reuse the same event identifier, which lets Bronze deduplicate them.

## Data layers

Bronze preserves source records and ingestion failures:

```text
bronze.marginalia_events
bronze.openlibrary_records
bronze.openlibrary_ratings
bronze.openlibrary_reading_logs
bronze.openalex_responses
```

Silver reconstructs stable domain entities and history:

```text
silver.reading_events
silver.reading_sessions
silver.books
silver.highlights_current
silver.highlight_history
silver.conversations
silver.questions
silver.agent_responses
silver.concepts
silver.concept_aliases
silver.highlight_concepts
silver.question_concepts
silver.research_works
```

Gold begins with:

```text
gold.book_engagement
gold.reader_interest_profile
gold.intellectual_frontier
gold.recommendation_candidates
```

Later Gold tables include interest trajectories, concept relationships, recommendation outcomes, and agent quality metrics.

## Intelligence and ML

Concept extraction processes only new or changed highlights, questions, notes, summaries, and book descriptions. Each result records its source-content hash, model, prompt version, raw concept, canonical concept, confidence, and extraction time.

The first Model Serving workload is the Marginalia Librarian. MLflow evaluates retrieval relevance, evidence citations, spoiler violations, prompt-injection resistance, latency, and cost.

Recommendations begin with an explainable heuristic. Marginalia records impressions, opens, dismissals, additions, and starts. A learned ranker is trained only after positive and negative outcomes cover multiple books and time periods. It must be compared with the heuristic on a temporal holdout.

## Application surfaces

Marginalia gains a small Insights area backed by Lakebase data returned through its existing server layer.

Marginalia Observatory is a separate Databricks App with these sections:

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

The Genie Agent answers structured analytical questions. The Librarian handles semantic and interpretive questions. An orchestrator may route between them later.

The MCP server starts read-only with tools for highlights, conversations, interest profiles, trajectories, frontiers, recommendations, comparisons, and reading statistics. Write tools require an audit table and explicit confirmation behavior.

## Delivery phases

### Phase 0: local contracts and fixtures

- define the event and privacy schemas;
- add the IndexedDB outbox and installation-local sequence;
- add the sync credential shape without network delivery;
- create realistic fixture streams;
- make deduplication and sessionization semantics executable;
- wire representative highlight and conversation events;
- verify offline behavior remains unchanged.

### Phase 1: first streaming slice

```text
highlight -> outbox -> event API -> Kafka -> Lakeflow Connect -> Bronze
```

### Phase 2: medallion pipeline

Build Silver highlights and sessions, then Gold engagement and interest profiles.

### Phase 3: first serving loop

Sync the interest profile into Lakebase and display it in Marginalia.

### Phase 4: concepts and public data

Add concept normalization, targeted Open Library ingestion, recommendation candidates, the intellectual frontier, and later OpenAlex enrichment.

### Phase 5: Observatory

Build the Databricks App, dashboard, and Genie Agent.

### Phase 6: Librarian

Add retrieval, MLflow tracing and evaluation, Model Serving, and Observatory integration.

### Phase 7: recommendation feedback

Serve heuristic recommendations through Lakebase and record outcomes.

### Phase 8: learned ranking

Train and deploy a simple ranker only when real outcome data is adequate.

### Phase 9: MCP

Add authenticated read tools, isolation tests, and narrowly scoped writes if useful.

## First vertical slice

```text
Nietzsche highlight
      -> IndexedDB outbox
      -> authenticated event API
      -> Kafka
      -> Lakeflow Connect
      -> Bronze event
      -> Silver highlight
      -> concept extraction
      -> Gold interest profile
      -> Lakebase
      -> Marginalia Insights
```

The slice is complete when offline reading still works, failed delivery stays queued, retries do not duplicate an action, privacy settings remove excluded text, each layer contains the expected record, and deleting cloud data removes operational copies and schedules deletion from derived tables.
