# Gold: the intellectual frontier and heuristic recommendations.
#
# Materialized views over Silver and the public-source tables. Every score
# exposes its components and every row names the evidence behind it, because a
# recommendation nobody can explain is one nobody should act on.

from pyspark import pipelines as dp
from pyspark.sql import SparkSession, Window
from pyspark.sql import functions as F

from concepts import make_concept_canonicalizer
from public_matching import FRONTIER_WEIGHTS, RECOMMENDATION_WEIGHTS, make_title_normalizer

spark = SparkSession.getActiveSession()

CATALOG = spark.conf.get("marginalia.catalog")
SILVER = spark.conf.get("marginalia.silver_schema")
GOLD = spark.conf.get("marginalia.gold_schema")

INTEREST = f"{CATALOG}.{GOLD}.reader_interest_profile"
RESEARCH = f"{CATALOG}.{SILVER}.research_works"
BOOK_CANDIDATES = f"{CATALOG}.{SILVER}.public_book_candidates"
SILVER_EVENTS = f"{CATALOG}.{SILVER}.events"

FRONTIER = f"{CATALOG}.{GOLD}.intellectual_frontier"
RECOMMENDATIONS = f"{CATALOG}.{GOLD}.recommendation_candidates"

FRONTIER_SCORE_VERSION = "frontier_score_v1"
RECOMMENDATION_SCORE_VERSION = "recommendation_heuristic_v1"

# A candidate needs more than one established concept pointing at it before it
# counts as adjacent rather than incidental.
MINIMUM_NEIGHBOURS = 2
DISMISSAL_WINDOW_DAYS = 90


def _clamp(column):
    return F.least(F.lit(1.0), F.greatest(F.lit(0.0), column))


def normalized_title(column, author=None):
    """
    The same shape public_matching.normalize_title produces, and the same
    function, so what counts as "already owned" here is what counted as a match
    there.

    The author is passed because it decides a real case: an academic edition
    writes "Author: Title", and without knowing the author the half before the
    colon looks like the title. A reader's own copy of The Gay Science would
    normalize to "nietzsche" and never match a candidate called "The Gay
    Science", which is how a reader gets recommended the book they are reading.
    """
    normalize = make_title_normalizer()
    if author is None:
        return F.udf(lambda value: normalize(value), "string")(column)
    return F.udf(lambda value, name: normalize(value, name), "string")(column, author)


def canonical_topic(column):
    """Use the exact canonicalization that produced Gold concept ids."""
    return F.udf(make_concept_canonicalizer(), "string")(column)


def current_research_works():
    """One current row per concept and work, even after a TTL refresh."""
    latest = Window.partitionBy("concept_id", "work_id").orderBy(
        F.col("retrieved_at").desc(), F.col("request_id").desc()
    )
    return (
        spark.read.table(RESEARCH)
        .filter(F.col("work_id").isNotNull() & F.col("title").isNotNull())
        .withColumn("_recency", F.row_number().over(latest))
        .filter(F.col("_recency") == 1)
        .drop("_recency")
    )


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
    works = current_research_works()
    topics = works.withColumn(
        "topic", F.explode(F.from_json(F.col("topics"), "array<string>"))
    ).withColumn("topic", canonical_topic(F.col("topic")))

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
            F.col("request_id"),
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
                F.sort_array(F.array_distinct(F.collect_list("established_concept"))), 1, 5
            ).alias("established_concepts"),
            F.slice(F.sort_array(F.array_distinct(F.collect_list("work_title"))), 1, 5).alias("supporting_works"),
            # The ids, not only the titles: a row has to link back to the
            # public-source record it was derived from, not merely name it.
            F.slice(F.sort_array(F.array_distinct(F.collect_list("work_id"))), 1, 5).alias("supporting_work_ids"),
            F.slice(F.sort_array(F.array_distinct(F.collect_list("request_id"))), 1, 5).alias("source_request_ids"),
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
            FRONTIER_WEIGHTS["similarity"]
            * _clamp(F.col("similarity_to_established_interests"))
            + FRONTIER_WEIGHTS["neighbor_strength"]
            * _clamp(F.col("normalized_neighbor_strength"))
            + FRONTIER_WEIGHTS["source_quality"] * _clamp(F.col("source_quality")),
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

    # Candidates are books from Open Library, not works from OpenAlex.
    #
    # OpenAlex indexes research output. Asked what a reader should read next it
    # answers with papers, and it did: a single-cell genomics article scored
    # against an interest in "artist", and a record of secondary literature
    # standing in for Thus Spoke Zarathustra with a scholar in the author
    # field. Its topics are still what the frontier is built from, because
    # adjacency between subjects is exactly what it knows.
    #
    # This is also what the plan asked for before Phase 6 followed the wrong
    # source and changed it: the popularity prior is an edition count again.
    latest_candidate = Window.partitionBy("concept_id", "work_key").orderBy(
        F.col("retrieved_at").desc(), F.col("request_id").desc()
    )
    books = (
        spark.read.table(BOOK_CANDIDATES)
        .filter(F.col("work_key").isNotNull() & F.col("title").isNotNull())
        .withColumn("_recency", F.row_number().over(latest_candidate))
        .filter(F.col("_recency") == 1)
        .drop("_recency")
    )

    events = spark.read.table(SILVER_EVENTS)

    # Every book the reader already has must not come back as a suggestion.
    # Open Library work keys and OpenAlex work ids are different identifier
    # spaces, so an anti-join between them matches nothing and would recommend a
    # reader the book already on their shelf. The comparable thing both sides
    # have is the title, normalized the way the matcher normalizes it.
    added_books = (
        events.filter(F.col("event_type") == "book_added")
        .withColumn("title", F.try_variant_get(F.col("payload"), "$.title", "string"))
        .filter(F.col("title").isNotNull())
        .withColumn("author", F.try_variant_get(F.col("payload"), "$.author", "string"))
        .select(
            "user_id",
            "book_id",
            normalized_title(F.col("title"), F.col("author")).alias("owned_title"),
            F.lower(F.trim(F.col("author"))).alias("owned_author"),
        )
    )
    deleted_books = events.filter(F.col("event_type") == "book_deleted").select(
        "user_id", "book_id"
    )
    owned_titles = (
        added_books.join(deleted_books, ["user_id", "book_id"], "left_anti")
        .select("user_id", "owned_title", "owned_author")
        .distinct()
    )

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

    by_interest = (
        interests.join(books, interests.concept_id == books.concept_id)
        .select(
            interests.user_id,
            F.col("work_key").alias("candidate_id"),
            F.col("request_id"),
            F.coalesce(F.col("edition_count"), F.lit(0)).alias("edition_count"),
            interests.concept_id,
            interests.interest_score,
        )
    )

    interest_scored = by_interest.groupBy("user_id", "candidate_id").agg(
        F.avg("interest_score").alias("concept_interest_match"),
        F.max("edition_count").alias("edition_count"),
        F.slice(F.sort_array(F.array_distinct(F.collect_list("concept_id"))), 1, 5).alias("matched_concepts"),
        F.slice(F.sort_array(F.array_distinct(F.collect_list("request_id"))), 1, 3).alias("source_request_ids"),
    )
    metadata_recency = Window.partitionBy("work_key").orderBy(
        F.col("retrieved_at").desc(), F.col("request_id").desc(), F.col("concept_id")
    )
    candidate_metadata = (
        books.withColumn("_metadata_recency", F.row_number().over(metadata_recency))
        .filter(F.col("_metadata_recency") == 1)
        .select(
            F.col("work_key").alias("candidate_id"),
            F.col("title").alias("candidate_title"),
            F.col("authors").alias("candidate_authors"),
            F.col("first_publish_year").alias("publication_year"),
        )
    )
    interest_scored = interest_scored.join(candidate_metadata, ["candidate_id"])

    # Coverage is how far a candidate reaches into the reader's frontier, so it
    # is measured against that candidate's own topics. Joining the reader's
    # established concepts to the frontier could never match: the frontier is
    # defined as the concepts they have no direct evidence for.
    frontier_topics = (
        books.withColumn("topic", F.explode(F.col("subjects")))
        .withColumn("topic", canonical_topic(F.col("topic")))
        .select(F.col("work_key").alias("candidate_id"), F.col("topic"))
        .distinct()
    )
    coverage = (
        frontier.select(
            "user_id", F.col("candidate_concept").alias("topic"), "frontier_score"
        )
        .join(frontier_topics, ["topic"])
        .groupBy("user_id", "candidate_id")
        .agg(
            F.avg("frontier_score").alias("frontier_coverage"),
            F.slice(F.sort_array(F.array_distinct(F.collect_list("topic"))), 1, 5).alias("frontier_concepts"),
        )
    )

    scored = interest_scored.join(coverage, ["user_id", "candidate_id"], "left").fillna(
        {"frontier_coverage": 0.0}
    )

    # A book by an author already all over the reader's shelf is a weaker
    # suggestion than one that opens something new, however well it matches.
    # From the events themselves. Joining these to the matched works would only
    # have counted authors whose book Open Library happened to recognise, and an
    # author the reader is plainly reading is being read either way.
    read_authors = (
        events.filter(F.col("event_type") == "book_added")
        .withColumn("author", F.try_variant_get(F.col("payload"), "$.author", "string"))
        .filter(F.col("author").isNotNull())
        .select("user_id", F.lower(F.trim(F.col("author"))).alias("read_author"))
        .distinct()
    )

    # Open Library names the book's own author, so an author the reader is
    # already reading is now visible here. Under OpenAlex this component could
    # not work at all: its author field holds the scholar who wrote about the
    # book, so every Nietzsche recommendation looked like a new author.
    with_authors = scored.withColumn(
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
        # Editions, not citations. A work reprinted many times is one many
        # readers have wanted; a paper cited many times is one many
        # researchers have used, which says nothing about reading it.
        "popularity_prior",
        _clamp(F.log1p(F.col("edition_count")) / F.log1p(F.lit(100.0))),
    )

    final = (
        complete.withColumn(
            "normalized_title",
            # A candidate's authors are an array; the normalizer takes the
            # whole list and asks whether any of them explains a colon prefix.
            normalized_title(F.col("candidate_title"), F.col("candidate_authors")),
        )
        .join(
            owned_titles,
            # Author as well as title. Normalization is deliberately lossy, so
            # a title alone is not an identity: "S/Z" and "11/22/63" reduce
            # almost to nothing, and an author-prefixed title reduces to a
            # generic one. Excluding on the pair costs a rare duplicate and
            # avoids hiding a book the reader does not own.
            (complete.user_id == owned_titles.user_id)
            & (F.col("normalized_title") == owned_titles.owned_title)
            & (F.col("first_author").eqNullSafe(owned_titles.owned_author)),
            "left_anti",
        )
        .join(dismissed, ["user_id", "candidate_id"], "left_anti")
        .withColumn(
            "recommendation_score",
            RECOMMENDATION_WEIGHTS["interest"] * _clamp(F.col("concept_interest_match"))
            + RECOMMENDATION_WEIGHTS["frontier"] * _clamp(F.col("frontier_coverage"))
            + RECOMMENDATION_WEIGHTS["diversity"] * _clamp(F.col("diversity"))
            + RECOMMENDATION_WEIGHTS["popularity"] * _clamp(F.col("popularity_prior"))
            + RECOMMENDATION_WEIGHTS["metadata"] * _clamp(F.col("metadata_completeness")),
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
        .withColumn("authors", F.to_json(F.col("candidate_authors")))
        .drop("candidate_authors", "normalized_title")
    )
