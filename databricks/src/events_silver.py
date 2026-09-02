# Bronze parsing, deterministic event identity, highlights, and reading sessions.
#
# These are materialized views rather than bounded-watermark streams. Lakeflow
# refreshes them when Bronze changes, and late offline events can therefore
# revise the affected state instead of being discarded permanently.

from pyspark import pipelines as dp
from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F

spark = SparkSession.getActiveSession()

CATALOG = spark.conf.get("marginalia.catalog")
BRONZE_SCHEMA = spark.conf.get("marginalia.bronze_schema")
SILVER_SCHEMA = spark.conf.get("marginalia.silver_schema")

BRONZE_EVENTS = f"{CATALOG}.{BRONZE_SCHEMA}.events_raw"
QUARANTINE = f"{CATALOG}.{BRONZE_SCHEMA}.ingestion_quarantine"
SILVER_EVENTS = f"{CATALOG}.{SILVER_SCHEMA}.events"
EVENT_CONFLICTS = f"{CATALOG}.{SILVER_SCHEMA}.event_conflicts"
HIGHLIGHT_HISTORY = f"{CATALOG}.{SILVER_SCHEMA}.highlight_history"
HIGHLIGHTS_CURRENT = f"{CATALOG}.{SILVER_SCHEMA}.highlights_current"
READING_SESSIONS = f"{CATALOG}.{SILVER_SCHEMA}.reading_sessions"

UUID_V4 = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
EVENT_TYPES = [
    "privacy_consent_changed",
    "highlight_created",
    "highlight_updated",
    "highlight_deleted",
    "conversation_started",
    "question_asked",
    "book_opened",
    "book_closed",
    "reading_progressed",
    "chapter_entered",
    "book_completed",
    "book_reopened",
]
READING_TYPES = [
    "book_opened",
    "book_closed",
    "reading_progressed",
    "chapter_entered",
    "book_completed",
    "book_reopened",
]
SESSION_EVENT_TYPES = ["book_opened", "book_closed", "reading_progressed", "chapter_entered"]
HIGHLIGHT_TYPES = ["highlight_created", "highlight_updated", "highlight_deleted"]

TOP_LEVEL_FIELDS = [
    "schemaVersion",
    "eventId",
    "installationId",
    "sequence",
    "source",
    "appVersion",
    "eventType",
    "eventTime",
    "emittedAt",
    "entities",
    "privacy",
    "payload",
    "userId",
    "receivedAt",
]


def _strings(values: list[str]):
    return F.array(*[F.lit(value) for value in values])


def _variant(variant, path: str, data_type: str):
    return F.try_variant_get(variant, path, data_type)


def _seconds(column):
    # Epoch seconds keeping the fraction. `unix_timestamp` truncates to whole
    # seconds, which would split a session at a 1,799.2-second gap and disagree
    # with the millisecond arithmetic the browser reference uses.
    return column.cast("double")


def _payload_keys(event_type):
    return (
        F.when(
            event_type == "privacy_consent_changed",
            _strings(["changed", "consentUpdatedAt"]),
        )
        .when(
            event_type == "highlight_created",
            _strings(["color", "chapter", "progress", "createdAt", "text", "note"]),
        )
        .when(
            event_type == "highlight_updated",
            _strings(
                [
                    "color",
                    "chapter",
                    "progress",
                    "createdAt",
                    "text",
                    "note",
                    "changedFields",
                ]
            ),
        )
        .when(event_type == "highlight_deleted", _strings(["deletedAt"]))
        .when(
            event_type == "conversation_started",
            _strings(["createdAt", "title", "seedText", "chapter", "progress"]),
        )
        .when(
            event_type == "question_asked",
            _strings(["createdAt", "chapter", "progress", "content"]),
        )
        .when(
            event_type == "book_opened",
            _strings(["progress", "chapter", "openedAt", "reopened"]),
        )
        .when(
            event_type == "book_closed",
            _strings(["progress", "chapter", "closedAt", "reason"]),
        )
        .when(
            event_type == "reading_progressed",
            _strings(["progress", "chapter", "observedAt", "trigger"]),
        )
        .when(
            event_type == "chapter_entered",
            _strings(["chapter", "chapterIndex", "progress", "enteredAt"]),
        )
        .when(event_type == "book_completed", _strings(["progress", "completedAt"]))
        .when(
            event_type == "book_reopened",
            _strings(["progress", "chapter", "reopenedAt", "daysSinceLastOpen"]),
        )
        .otherwise(_strings(["__unknown_event_type__"]))
    )


@dp.temporary_view(name="parsed_event_records")
def parsed_event_records():
    raw = spark.read.table(BRONZE_EVENTS)
    variant = F.try_parse_json("raw_value")
    variant_schema = F.schema_of_variant(variant)
    schema_version = _variant(variant, "$.schemaVersion", "int")
    event_id = _variant(variant, "$.eventId", "string")
    installation_id = _variant(variant, "$.installationId", "string")
    sequence = _variant(variant, "$.sequence", "long")
    source = _variant(variant, "$.source", "string")
    app_version = _variant(variant, "$.appVersion", "string")
    event_type = _variant(variant, "$.eventType", "string")
    event_time = _variant(variant, "$.eventTime", "timestamp")
    emitted_at = _variant(variant, "$.emittedAt", "timestamp")
    received_at = _variant(variant, "$.receivedAt", "timestamp")
    user_id = _variant(variant, "$.userId", "string")
    book_id = _variant(variant, "$.entities.bookId", "string")
    highlight_id = _variant(variant, "$.entities.highlightId", "string")
    conversation_id = _variant(variant, "$.entities.conversationId", "string")
    message_id = _variant(variant, "$.entities.messageId", "string")
    payload = _variant(variant, "$.payload", "variant")
    privacy = _variant(variant, "$.privacy", "variant")
    entities = _variant(variant, "$.entities", "variant")
    payload_schema = F.schema_of_variant(payload)
    privacy_schema = F.schema_of_variant(privacy)
    entities_schema = F.schema_of_variant(entities)
    privacy_version = _variant(variant, "$.privacy.consentVersion", "int")
    privacy_included = _variant(variant, "$.privacy.included", "array<string>")
    payload_progress = _variant(variant, "$.payload.progress", "double")
    highlight_color = _variant(variant, "$.payload.color", "string")
    close_reason = _variant(variant, "$.payload.reason", "string")
    progress_trigger = _variant(variant, "$.payload.trigger", "string")
    payload_chapter = _variant(variant, "$.payload.chapter", "string")
    canonical_payload = F.to_json(payload)
    canonical_privacy = F.to_json(privacy)
    canonical_entities = F.to_json(entities)

    top_level_keys = F.json_object_keys("raw_value")
    payload_json = F.get_json_object("raw_value", "$.payload")
    payload_keys = F.json_object_keys(payload_json)
    entity_keys = F.json_object_keys(F.get_json_object("raw_value", "$.entities"))
    privacy_keys = F.json_object_keys(F.get_json_object("raw_value", "$.privacy"))
    unknown_top_level = F.size(F.array_except(top_level_keys, _strings(TOP_LEVEL_FIELDS))) > 0
    unknown_payload = F.size(F.array_except(payload_keys, _payload_keys(event_type))) > 0
    unknown_entity = F.size(
        F.array_except(entity_keys, _strings(["bookId", "highlightId", "conversationId", "messageId"]))
    ) > 0
    unknown_privacy = F.size(
        F.array_except(privacy_keys, _strings(["consentVersion", "included"]))
    ) > 0
    invalid_nested_object = (
        payload_schema.isNull()
        | ~payload_schema.startswith("OBJECT<")
        | privacy_schema.isNull()
        | ~privacy_schema.startswith("OBJECT<")
        | entities_schema.isNull()
        | ~entities_schema.startswith("OBJECT<")
    )
    duplicated_privacy_category = F.size(privacy_included) != F.size(
        F.array_distinct(privacy_included)
    )
    invalid_privacy_category = (
        (
            event_type.isin(
                [*READING_TYPES, "privacy_consent_changed", "highlight_deleted"]
            )
            & (F.size(privacy_included) != 0)
        )
        | (
            event_type.isin("conversation_started", "question_asked")
            & (F.size(F.array_except(privacy_included, _strings(["conversationText"]))) > 0)
        )
        | (
            event_type.isin("highlight_created", "highlight_updated")
            & (
                F.size(
                    F.array_except(
                        privacy_included,
                        _strings(["highlightText", "highlightNotes"]),
                    )
                )
                > 0
            )
        )
    )
    invalid_privacy = (
        privacy_version.isNull()
        | (privacy_version != 1)
        | privacy_included.isNull()
        | duplicated_privacy_category
        | invalid_privacy_category
    )

    missing_highlight_entity = event_type.isin(HIGHLIGHT_TYPES) & (
        book_id.isNull() | highlight_id.isNull()
    )
    missing_conversation_entity = (event_type == "conversation_started") & (
        book_id.isNull() | conversation_id.isNull()
    )
    missing_question_entity = (event_type == "question_asked") & (
        book_id.isNull() | conversation_id.isNull() | message_id.isNull()
    )
    missing_reading_entity = event_type.isin(READING_TYPES) & book_id.isNull()
    bad_progress = (
        payload_progress.isNotNull() & ((payload_progress < 0) | (payload_progress > 1))
    ) | (event_type.isin(READING_TYPES) & payload_progress.isNull())

    payload_timestamp = (
        F.when(
            event_type.isin(
                "highlight_created",
                "highlight_updated",
                "conversation_started",
                "question_asked",
            ),
            _variant(variant, "$.payload.createdAt", "timestamp"),
        )
        .when(
            event_type == "highlight_deleted",
            _variant(variant, "$.payload.deletedAt", "timestamp"),
        )
        .when(event_type == "book_opened", _variant(variant, "$.payload.openedAt", "timestamp"))
        .when(event_type == "book_closed", _variant(variant, "$.payload.closedAt", "timestamp"))
        .when(
            event_type == "reading_progressed",
            _variant(variant, "$.payload.observedAt", "timestamp"),
        )
        .when(
            event_type == "chapter_entered",
            _variant(variant, "$.payload.enteredAt", "timestamp"),
        )
        .when(
            event_type == "book_completed",
            _variant(variant, "$.payload.completedAt", "timestamp"),
        )
        .when(event_type == "book_reopened", _variant(variant, "$.payload.reopenedAt", "timestamp"))
    )
    missing_payload_timestamp = (
        ~event_type.eqNullSafe("privacy_consent_changed") & payload_timestamp.isNull()
    )
    invalid_highlight_payload = event_type.isin("highlight_created", "highlight_updated") & (
        highlight_color.isNull() | ~highlight_color.isin("yellow", "green", "blue", "pink")
    )
    invalid_close_reason = (event_type == "book_closed") & (
        close_reason.isNull() | ~close_reason.isin("explicit", "backgrounded", "navigated_away")
    )
    invalid_progress_trigger = (event_type == "reading_progressed") & (
        progress_trigger.isNull()
        | ~progress_trigger.isin("progress_delta", "chapter_change", "closing", "backgrounded")
    )
    missing_chapter = (event_type == "chapter_entered") & payload_chapter.isNull()

    quarantine_reason = (
        F.when(
            variant.isNull() | ~variant_schema.startswith("OBJECT<"),
            F.lit("malformed_json"),
        )
        .when(schema_version.isNull() | (schema_version != 1), F.lit("unknown_schema_version"))
        .when(event_id.isNull() | ~event_id.rlike(UUID_V4), F.lit("invalid_event_id"))
        .when(
            installation_id.isNull() | ~installation_id.rlike(UUID_V4),
            F.lit("invalid_installation_id"),
        )
        .when(user_id.isNull() | (F.length(user_id) == 0), F.lit("missing_user_id"))
        .when(sequence.isNull() | (sequence < 1), F.lit("invalid_sequence"))
        .when(source.isNull() | ~source.isin("pwa", "koreader"), F.lit("invalid_source"))
        .when(app_version.isNull() | (F.length(app_version) == 0), F.lit("invalid_app_version"))
        .when(event_type.isNull() | ~event_type.isin(EVENT_TYPES), F.lit("unknown_event_type"))
        .when(
            event_time.isNull() | emitted_at.isNull() | received_at.isNull(),
            F.lit("invalid_timestamp"),
        )
        .when(unknown_top_level, F.lit("unknown_envelope_field"))
        .when(invalid_nested_object, F.lit("invalid_nested_object"))
        .when(unknown_payload, F.lit("unknown_payload_field"))
        .when(unknown_entity, F.lit("unknown_entity_field"))
        .when(unknown_privacy, F.lit("unknown_privacy_field"))
        .when(invalid_privacy, F.lit("invalid_privacy"))
        .when(missing_highlight_entity, F.lit("missing_highlight_entity"))
        .when(missing_conversation_entity, F.lit("missing_conversation_entity"))
        .when(missing_question_entity, F.lit("missing_question_entity"))
        .when(missing_reading_entity, F.lit("missing_book_entity"))
        .when(bad_progress, F.lit("invalid_progress"))
        .when(missing_payload_timestamp, F.lit("invalid_payload_timestamp"))
        .when(invalid_highlight_payload, F.lit("invalid_highlight_payload"))
        .when(invalid_close_reason, F.lit("invalid_close_reason"))
        .when(invalid_progress_trigger, F.lit("invalid_progress_trigger"))
        .when(missing_chapter, F.lit("missing_chapter"))
    )

    future_clock = event_time > received_at + F.expr("INTERVAL 24 HOURS")
    effective_event_time = F.when(future_clock, received_at).otherwise(event_time)
    canonical_event = F.concat_ws(
        "\u0000",
        schema_version.cast("string"),
        event_id,
        installation_id,
        sequence.cast("string"),
        source,
        app_version,
        event_type,
        event_time.cast("string"),
        emitted_at.cast("string"),
        canonical_entities,
        canonical_privacy,
        canonical_payload,
    )

    return raw.select(
        "topic",
        "partition",
        "offset",
        "kafka_timestamp",
        "record_key",
        "raw_value",
        "ingested_at",
        schema_version.alias("schema_version"),
        event_id.alias("event_id"),
        installation_id.alias("installation_id"),
        sequence.alias("sequence"),
        source.alias("source"),
        app_version.alias("app_version"),
        event_type.alias("event_type"),
        event_time.alias("event_time"),
        emitted_at.alias("emitted_at"),
        received_at.alias("received_at"),
        effective_event_time.alias("effective_event_time"),
        future_clock.alias("future_clock"),
        user_id.alias("user_id"),
        book_id.alias("book_id"),
        highlight_id.alias("highlight_id"),
        conversation_id.alias("conversation_id"),
        message_id.alias("message_id"),
        payload.alias("payload"),
        canonical_payload.alias("payload_json"),
        privacy.alias("privacy"),
        canonical_privacy.alias("privacy_json"),
        payload_progress.alias("progress"),
        F.sha2(canonical_event, 256).alias("event_hash"),
        quarantine_reason.alias("quarantine_reason"),
    )


@dp.materialized_view(
    name=QUARANTINE,
    comment=(
        "Malformed or unsupported event records retained for inspection "
        "without blocking valid data."
    ),
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def ingestion_quarantine():
    return spark.read.table("parsed_event_records").filter(F.col("quarantine_reason").isNotNull())


EVENT_EXPECTATIONS = {
    "valid_event_id": f"event_id RLIKE '{UUID_V4}'",
    "valid_installation_id": f"installation_id RLIKE '{UUID_V4}'",
    "positive_sequence": "sequence >= 1",
    "known_event_type": "event_type IN (" + ",".join(f"'{value}'" for value in EVENT_TYPES) + ")",
    "timestamps_present": (
        "event_time IS NOT NULL AND emitted_at IS NOT NULL AND received_at IS NOT NULL "
        "AND effective_event_time IS NOT NULL"
    ),
    "valid_progress": "progress IS NULL OR (progress >= 0 AND progress <= 1)",
    "required_book_entity": "event_type = 'privacy_consent_changed' OR book_id IS NOT NULL",
    "required_highlight_entity": (
        "event_type NOT IN ('highlight_created','highlight_updated','highlight_deleted') "
        "OR highlight_id IS NOT NULL"
    ),
    "required_conversation_entity": (
        "event_type NOT IN ('conversation_started','question_asked') OR conversation_id IS NOT NULL"
    ),
    "required_message_entity": "event_type != 'question_asked' OR message_id IS NOT NULL",
}


@dp.materialized_view(
    name=SILVER_EVENTS,
    comment=(
        "First valid occurrence of each logical event; late events remain "
        "eligible for recomputation."
    ),
    table_properties={"delta.enableChangeDataFeed": "true"},
)
@dp.expect_all(EVENT_EXPECTATIONS)
def events():
    valid = spark.read.table("parsed_event_records").filter(F.col("quarantine_reason").isNull())
    first = Window.partitionBy("user_id", "event_id").orderBy(
        "kafka_timestamp", "partition", "offset"
    )
    return valid.withColumn("occurrence", F.row_number().over(first)).filter("occurrence = 1").drop(
        "occurrence", "quarantine_reason"
    )


@dp.materialized_view(
    name=EVENT_CONFLICTS,
    comment="Later valid occurrences whose canonical content differs from the accepted event.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def event_conflicts():
    occurrences = spark.read.table("parsed_event_records").filter(
        F.col("quarantine_reason").isNull()
    ).alias("seen")
    accepted = spark.read.table(SILVER_EVENTS).select(
        "user_id",
        "event_id",
        F.col("event_hash").alias("accepted_hash"),
        F.col("partition").alias("accepted_partition"),
        F.col("offset").alias("accepted_offset"),
    ).alias("accepted")
    return (
        occurrences.join(accepted, ["user_id", "event_id"])
        .filter(
            ((F.col("seen.partition") != F.col("accepted.accepted_partition"))
             | (F.col("seen.offset") != F.col("accepted.accepted_offset")))
            & (F.col("seen.event_hash") != F.col("accepted.accepted_hash"))
        )
        .select(
            "user_id",
            "event_id",
            F.col("accepted.accepted_hash").alias("accepted_hash"),
            F.col("seen.event_hash").alias("conflicting_hash"),
            F.col("seen.topic").alias("topic"),
            F.col("seen.partition").alias("partition"),
            F.col("seen.offset").alias("offset"),
            F.col("seen.kafka_timestamp").alias("kafka_timestamp"),
            F.col("seen.raw_value").alias("conflicting_raw_value"),
            F.col("seen.ingested_at").alias("detected_at"),
        )
    )


@dp.materialized_view(
    name=HIGHLIGHT_HISTORY,
    comment="Auditable create, update, and delete snapshots for every highlight.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def highlight_history():
    source = spark.read.table(SILVER_EVENTS).filter(F.col("event_type").isin(HIGHLIGHT_TYPES))
    return source.select(
        "user_id",
        "highlight_id",
        "book_id",
        "installation_id",
        "event_id",
        "event_type",
        "event_time",
        "effective_event_time",
        "received_at",
        "sequence",
        "future_clock",
        _variant(F.col("payload"), "$.color", "string").alias("color"),
        _variant(F.col("payload"), "$.chapter", "string").alias("chapter"),
        _variant(F.col("payload"), "$.progress", "double").alias("progress"),
        _variant(F.col("payload"), "$.createdAt", "timestamp").alias("created_at"),
        _variant(F.col("payload"), "$.deletedAt", "timestamp").alias("deleted_at"),
        _variant(F.col("payload"), "$.text", "string").alias("text"),
        _variant(F.col("payload"), "$.note", "string").alias("note"),
        "privacy_json",
    )


@dp.materialized_view(
    name=HIGHLIGHTS_CURRENT,
    comment="Latest non-deleted highlight snapshot after deterministic per-installation ordering.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def highlights_current():
    history = spark.read.table(HIGHLIGHT_HISTORY)
    within_installation = Window.partitionBy(
        "user_id", "highlight_id", "installation_id"
    ).orderBy(
        F.col("effective_event_time").desc(),
        F.col("sequence").desc(),
        F.col("received_at").desc(),
        F.col("event_id").desc(),
    )
    installation_heads = history.withColumn(
        "installation_rank", F.row_number().over(within_installation)
    ).filter("installation_rank = 1")
    across_installations = Window.partitionBy("user_id", "highlight_id").orderBy(
        F.col("effective_event_time").desc(),
        F.col("received_at").desc(),
        F.col("installation_id").desc(),
    )
    return (
        installation_heads.withColumn("current_rank", F.row_number().over(across_installations))
        .filter("current_rank = 1 AND event_type != 'highlight_deleted'")
        .drop("installation_rank", "current_rank", "deleted_at")
    )


@dp.materialized_view(
    name=READING_SESSIONS,
    comment="Reading sessionization v1 with 30-minute idle splits and 120-second interval caps.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
@dp.expect_all(
    {
        "non_negative_active_seconds": "active_seconds >= 0",
        "ordered_session_bounds": "ended_at >= started_at",
        "valid_session_progress": (
            "maximum_progress IS NULL OR "
            "(maximum_progress >= 0 AND maximum_progress <= 1)"
        ),
    }
)
def reading_sessions():
    readings = spark.read.table(SILVER_EVENTS).filter(
        F.col("event_type").isin(SESSION_EVENT_TYPES)
    )
    stream_keys = ["user_id", "installation_id", "book_id"]
    order_columns = [
        F.col("effective_event_time"),
        F.col("sequence"),
        F.col("received_at"),
        F.col("event_id"),
    ]
    stream_order = Window.partitionBy(*stream_keys).orderBy(*order_columns)
    previous_time = F.lag("effective_event_time").over(stream_order)
    previous_type = F.lag("event_type").over(stream_order)
    new_session = (
        previous_time.isNull()
        | (F.col("event_type") == "book_opened")
        | (previous_type == "book_closed")
        | ((_seconds(F.col("effective_event_time")) - _seconds(previous_time)) >= 1_800)
    )
    numbered = readings.withColumn("session_break", F.when(new_session, 1).otherwise(0)).withColumn(
        "session_number",
        F.sum("session_break").over(
            stream_order.rowsBetween(Window.unboundedPreceding, Window.currentRow)
        ),
    )

    session_keys = [*stream_keys, "session_number"]
    session_order = Window.partitionBy(*session_keys).orderBy(*order_columns)
    prior_in_session = F.lag("effective_event_time").over(session_order)
    elapsed = _seconds(F.col("effective_event_time")) - _seconds(prior_in_session)
    intervals = numbered.withColumn(
        "active_interval_seconds",
        F.when(prior_in_session.isNull(), F.lit(0.0)).otherwise(
            F.least(F.lit(120.0), F.greatest(F.lit(0.0), elapsed))
        ),
    ).withColumn("first_event_id", F.first("event_id").over(session_order))

    ordered_event_ids = F.transform(
        F.sort_array(
            F.collect_list(
                F.struct(
                    "effective_event_time",
                    "sequence",
                    "received_at",
                    "event_id",
                )
            )
        ),
        lambda item: item["event_id"],
    )
    return intervals.groupBy(*session_keys).agg(
        F.sha2(
            F.concat_ws(
                "\u0000",
                F.first("user_id"),
                F.first("installation_id"),
                F.first("book_id"),
                F.first("first_event_id"),
            ),
            256,
        ).alias("session_id"),
        F.min("effective_event_time").alias("started_at"),
        F.max("effective_event_time").alias("ended_at"),
        F.sum("active_interval_seconds").alias("active_seconds"),
        F.max("progress").alias("maximum_progress"),
        F.max_by("progress", F.struct(*order_columns)).alias("ending_progress"),
        F.count("event_id").alias("event_count"),
        ordered_event_ids.alias("event_ids"),
        F.max(F.col("event_type") == "book_closed").alias("ended_by_close_event"),
        F.max(
            (F.col("event_type") == "book_closed")
            & (_variant(F.col("payload"), "$.reason", "string") == "explicit")
        ).alias("closed_explicitly"),
        F.max("future_clock").alias("contains_future_clock_event"),
    )
