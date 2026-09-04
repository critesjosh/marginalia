# Bronze ingestion: Confluent Cloud topic -> marginalia_bronze.events_raw.
#
# Runs as a triggered pipeline. Each update reads from the offset the previous
# update committed, ingests whatever is available, and stops, so the pipeline
# bills only while it is working. The topic keeps seven days, which is the
# margin that lets an update that never ran still catch up.

from pyspark import pipelines as dp
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, current_timestamp, get_json_object

spark = SparkSession.getActiveSession()

SECRET_SCOPE = spark.conf.get("marginalia.kafka.secret_scope")
TOPIC = spark.conf.get("marginalia.kafka.topic")

# Envelope fields promoted to columns. Everything else stays in raw_value, so an
# envelope the pipeline has not been taught yet is preserved rather than dropped.
ENVELOPE_FIELDS = {
    "event_id": "$.eventId",
    "event_type": "$.eventType",
    "schema_version": "$.schemaVersion",
    "user_id": "$.userId",
    "installation_id": "$.installationId",
    "sequence": "$.sequence",
    "event_time": "$.eventTime",
}


def _kafka_options() -> dict[str, str]:
    # Unity Catalog service credentials cover Amazon MSK only, so Confluent needs
    # SASL/PLAIN. The read-only key lives in a secret scope and is never a bundle
    # variable; the Worker's produce-only key is a separate credential entirely.
    user = dbutils.secrets.get(scope=SECRET_SCOPE, key="api-key")  # noqa: F821
    password = dbutils.secrets.get(scope=SECRET_SCOPE, key="api-secret")  # noqa: F821
    bootstrap = dbutils.secrets.get(scope=SECRET_SCOPE, key="bootstrap-servers")  # noqa: F821

    jaas = (
        "kafkashaded.org.apache.kafka.common.security.plain.PlainLoginModule required "
        f'username="{user}" password="{password}";'
    )
    return {
        "kafka.bootstrap.servers": bootstrap,
        "subscribe": TOPIC,
        "startingOffsets": "earliest",
        "kafka.security.protocol": "SASL_SSL",
        "kafka.sasl.mechanism": "PLAIN",
        "kafka.sasl.jaas.config": jaas,
    }


@dp.table(
    name="events_raw",
    comment=(
        "Raw consented events as produced by the Cloudflare Worker. Kafka "
        "coordinates are ingestion identifiers, not product-event identifiers."
    ),
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def events_raw():
    raw_value = col("value").cast("string")
    promoted = [
        get_json_object(raw_value, path).alias(name) for name, path in ENVELOPE_FIELDS.items()
    ]
    return (
        spark.readStream.format("kafka")
        .options(**_kafka_options())
        .load()
        .select(
            col("topic"),
            col("partition"),
            col("offset"),
            col("timestamp").alias("kafka_timestamp"),
            col("key").cast("string").alias("record_key"),
            raw_value.alias("raw_value"),
            current_timestamp().alias("ingested_at"),
            *promoted,
        )
    )
