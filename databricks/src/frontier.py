# Gold: the intellectual frontier and heuristic recommendations.
#
# Materialized views over Silver and the public-source tables. Every score
# exposes its components and every row names the evidence behind it, because a
# recommendation nobody can explain is one nobody should act on.

from pyspark import pipelines as dp
from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F

spark = SparkSession.getActiveSession()

CATALOG = spark.conf.get("marginalia.catalog")
SILVER = spark.conf.get("marginalia.silver_schema")
GOLD = spark.conf.get("marginalia.gold_schema")

INTEREST = f"{CATALOG}.{GOLD}.reader_interest_profile"
EXTRACTIONS = f"{CATALOG}.{SILVER}.concept_extractions"
RESEARCH = f"{CATALOG}.{SILVER}.research_works"
MATCHES = f"{CATALOG}.{SILVER}.book_work_matches"
SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"

FRONTIER = f"{CATALOG}.{GOLD}.intellectual_frontier"
RECOMMENDATIONS = f"{CATALOG}.{GOLD}.recommendation_candidates"

FRONTIER_SCORE_VERSION = "frontier_score_v1"
RECOMMENDATION_SCORE_VERSION = "recommendation_heuristic_v1"

# A candidate needs more than one established concept pointing at it before it
# counts as adjacent rather than incidental.
MINIMUM_NEIGHBOURS = 1
DISMISSAL_WINDOW_DAYS = 90


def _clamp(column):
    return F.least(F.lit(1.0), F.greatest(F.lit(0.0), column))


@dp.materialized_view(
    name=FRONTIER,
    comment="Concepts adjacent to a reader's established interests, with the evidence for each.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def intellectual_frontier():
    interests = spark.read.table(INTEREST).select(
        "user_id", "concept_id", "interest_score", "evidence_count"
    )

    # Adjacency comes from research works: a work that a reader's established
    # concept turned up, whose topics name something else, makes that something
    # else a neighbour of the concept.
    works = spark.read.table(RESEARCH)
    topics = works.withColumn(
        "topic", F.explode(F.from_json(F.col("topics"), "array<string>"))
    ).withColumn("topic", F.lower(F.trim(F.col("topic"))))

    established = interests.filter(F.col("evidence_count") > 0)
    neighbours = (
        established.join(topics, established.concept_id == topics.concept_id)
        .filter(F.lower(F.col("topic")) != F.lower(established.concept_id))
        .select(
            established.user_id,
            F.col("topic").alias("candidate_concept"),
            established.concept_id.alias("established_concept"),
            established.interest_score,
            F.col("work_id"),
            F.col("title").alias("work_title"),
            F.coalesce(F.col("cited_by_count"), F.lit(0)).alias("cited_by_count"),
        )
    )

    # A concept the reader already has direct evidence for is an interest, not a
    # frontier. The plan excludes them explicitly.
    direct = interests.filter(F.col("evidence_count") > 0).select(
        "user_id", F.col("concept_id").alias("candidate_concept")
    )

    aggregated = (
        neighbours.join(direct, ["user_id", "candidate_concept"], "left_anti")
        .groupBy("user_id", "candidate_concept")
        .agg(
            F.avg("interest_score").alias("similarity_to_established_interests"),
            F.countDistinct("established_concept").alias("neighbour_count"),
            F.countDistinct("work_id").alias("supporting_work_count"),
            F.max("cited_by_count").alias("best_cited_by_count"),
            F.slice(
                F.array_distinct(F.collect_list("established_concept")), 1, 5
            ).alias("established_concepts"),
            F.slice(F.array_distinct(F.collect_list("work_title")), 1, 5).alias("supporting_works"),
        )
        .filter(F.col("neighbour_count") >= MINIMUM_NEIGHBOURS)
    )

    # Both remaining components are normalized within the reader, so a score
    # says where a candidate sits among that reader's own frontier.
    per_reader = Window.partitionBy("user_id")
    return (
        aggregated.withColumn(
            "normalized_neighbor_strength",
            F.when(F.max("neighbour_count").over(per_reader) > 0,
                   F.col("neighbour_count") / F.max("neighbour_count").over(per_reader))
            .otherwise(F.lit(0.0)),
        )
        .withColumn(
            "source_quality",
            # Citations are a rough proxy for whether a work is load-bearing.
            # Logged, because the top of that distribution is very long.
            _clamp(F.log1p(F.col("best_cited_by_count")) / F.log1p(F.lit(1000.0))),
        )
        .withColumn(
            "frontier_score",
            0.45 * _clamp(F.col("similarity_to_established_interests"))
            + 0.35 * _clamp(F.col("normalized_neighbor_strength"))
            + 0.20 * _clamp(F.col("source_quality")),
        )
        .withColumn("score_version", F.lit(FRONTIER_SCORE_VERSION))
        .withColumn("computed_at", F.current_timestamp())
    )


@dp.materialized_view(
    name=RECOMMENDATIONS,
    comment="Books to suggest, with the component scores and the sentence that explains them.",
    table_properties={"delta.enableChangeDataFeed": "true"},
)
def recommendation_candidates():
    interests = spark.read.table(INTEREST)
    frontier = spark.read.table(FRONTIER)
    works = spark.read.table(RESEARCH)

    # Every book the reader already has, matched or not, and every book they
    # deleted. Neither may be recommended back to them.
    owned = (
        spark.read.table(MATCHES)
        .filter(F.col("work_key").isNotNull())
        .select("user_id", F.col("work_key").alias("candidate_id"))
        .distinct()
    )

    events = spark.read.table(SILVER_EVENTS)
    dismissed = (
        events.filter(F.col("event_type") == "recommendation_dismissed")
        .filter(
            F.col("effective_event_time")
            >= F.current_timestamp() - F.expr(f"INTERVAL {DISMISSAL_WINDOW_DAYS} DAYS")
        )
        .withColumn("candidate_id", F.try_variant_get(F.col("payload"), "$.candidateId", "string"))
        .select("user_id", "candidate_id")
        .distinct()
    )

    topics = works.withColumn(
        "topic", F.lower(F.trim(F.explode(F.from_json(F.col("topics"), "array<string>"))))
    )

    by_interest = (
        interests.join(topics, interests.concept_id == topics.concept_id)
        .select(
            interests.user_id,
            F.col("work_id").alias("candidate_id"),
            F.col("title").alias("candidate_title"),
            F.col("authors"),
            F.coalesce(F.col("cited_by_count"), F.lit(0)).alias("cited_by_count"),
            F.col("publication_year"),
            interests.concept_id,
            interests.interest_score,
        )
    )

    frontier_hits = frontier.select(
        "user_id",
        F.col("candidate_concept").alias("concept_id"),
        F.col("frontier_score"),
    )

    scored = (
        by_interest.join(frontier_hits, ["user_id", "concept_id"], "left")
        .groupBy("user_id", "candidate_id", "candidate_title", "authors", "publication_year")
        .agg(
            F.avg("interest_score").alias("concept_interest_match"),
            F.coalesce(F.avg("frontier_score"), F.lit(0.0)).alias("frontier_coverage"),
            F.max("cited_by_count").alias("cited_by_count"),
            F.slice(F.array_distinct(F.collect_list("concept_id")), 1, 5).alias("matched_concepts"),
        )
    )

    # A book by an author already all over the reader's shelf is a weaker
    # suggestion than one that opens something new, however well it matches.
    read_authors = (
        spark.read.table(MATCHES)
        .join(
            events.filter(F.col("event_type") == "book_added")
            .withColumn("author", F.try_variant_get(F.col("payload"), "$.author", "string"))
            .select("user_id", "book_id", "author"),
            ["user_id", "book_id"],
        )
        .filter(F.col("author").isNotNull())
        .select("user_id", F.lower(F.trim(F.col("author"))).alias("read_author"))
        .distinct()
    )

    with_authors = scored.withColumn(
        "candidate_authors",
        F.from_json(F.col("authors"), "array<string>"),
    ).withColumn(
        "first_author", F.lower(F.trim(F.element_at(F.col("candidate_authors"), 1)))
    )

    diversity = (
        with_authors.join(
            read_authors,
            (with_authors.user_id == read_authors.user_id)
            & (with_authors.first_author == read_authors.read_author),
            "left",
        )
        .withColumn(
            "diversity",
            F.when(F.col("read_author").isNotNull(), F.lit(0.0)).otherwise(F.lit(1.0)),
        )
        .drop(read_authors.user_id)
        .drop("read_author")
    )

    complete = diversity.withColumn(
        "metadata_completeness",
        (
            F.when(F.col("candidate_title").isNotNull(), F.lit(1.0)).otherwise(F.lit(0.0))
            + F.when(F.size(F.coalesce(F.col("candidate_authors"), F.array())) > 0, F.lit(1.0)).otherwise(F.lit(0.0))
            + F.when(F.col("publication_year").isNotNull(), F.lit(1.0)).otherwise(F.lit(0.0))
        )
        / 3.0,
    ).withColumn(
        "popularity_prior",
        _clamp(F.log1p(F.col("cited_by_count")) / F.log1p(F.lit(1000.0))),
    )

    final = (
        complete.join(owned, ["user_id", "candidate_id"], "left_anti")
        .join(dismissed, ["user_id", "candidate_id"], "left_anti")
        .withColumn(
            "recommendation_score",
            0.45 * _clamp(F.col("concept_interest_match"))
            + 0.20 * _clamp(F.col("frontier_coverage"))
            + 0.15 * _clamp(F.col("diversity"))
            + 0.10 * _clamp(F.col("popularity_prior"))
            + 0.10 * _clamp(F.col("metadata_completeness")),
        )
    )

    # Assembled, not generated. A recommendation has to be servable with no
    # model in the loop and no prose to wait on.
    explanation = F.concat(
        F.lit("Matches your interest in "),
        F.array_join(F.slice(F.col("matched_concepts"), 1, 3), ", "),
        F.when(F.col("frontier_coverage") >= 0.5, F.lit(", and reaches into territory next to it")).otherwise(F.lit("")),
        F.when(F.col("diversity") >= 0.5, F.lit(", by an author you have not been reading")).otherwise(F.lit("")),
        F.lit("."),
    )

    return (
        final.withColumn("explanation", explanation)
        .withColumn("score_version", F.lit(RECOMMENDATION_SCORE_VERSION))
        .withColumn("computed_at", F.current_timestamp())
        .drop("candidate_authors")
    )
