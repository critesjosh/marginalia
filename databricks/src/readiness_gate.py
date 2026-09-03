"""
Whether there is enough real feedback to train a ranker on. Usually there is not.

The plan blocks the learned recommender behind six counts, and this job is what
answers them. It is deliberately a job that reports rather than a check
somebody runs before training: a gate consulted only by the person who wants to
pass it is not a gate.

Every threshold is a minimum engineering requirement and none of them is a
claim that the resulting model would be good. A dataset can satisfy all six and
still teach a ranker nothing except which books were already at the top of the
list, which is why the temporal-holdout criterion is here at all: without it
the other five can be met by a fortnight of enthusiastic clicking.

The gate is computed from `recommendation_outcomes`, which holds one row per
event and no book text. Nothing in this job reads a reader's words.
"""

import json
import sys
from datetime import datetime, timedelta, timezone



def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


# Empty rather than required at import. The thresholds below are the contract
# this phase is really about, and reading them should not need a Spark session
# or a set of job arguments; main() refuses to run without them.
CATALOG = _argument("catalog", "")
SILVER = _argument("silver_schema", "")
OPS = _argument("ops_schema", "")

OUTCOMES = f"{CATALOG}.{SILVER}.recommendation_outcomes"
READINESS = f"{CATALOG}.{OPS}.recommender_readiness"

GATE_VERSION = "recommender_readiness_v1"

# The plan's six, transcribed rather than reinterpreted. Each is a floor.
THRESHOLDS = {
    "impressions": 500,
    "positive_outcomes": 50,
    "explicit_negatives": 50,
    "distinct_candidates": 20,
    "weeks_of_outcomes": 8,
    # A fifth of outcomes must sit after a cut that leaves training with no
    # sight of them. Expressed as a fraction because it is about the shape of
    # the split rather than about volume.
    "holdout_fraction": 0.20,
}

# Where the temporal split falls. Everything after it is holdout, and a feature
# computed for training may not use anything from it: that is what makes the
# holdout a test rather than a rehearsal.
HOLDOUT_FRACTION = THRESHOLDS["holdout_fraction"]


def _spark():
    """
    The session, fetched on use rather than at import.

    The thresholds below are the contract this phase is really about, and a
    test that wants to read them should not need a Spark session to do it.
    """
    from pyspark.sql import SparkSession

    return SparkSession.getActiveSession()


def _functions():
    from pyspark.sql import functions

    return functions


def _counts(frame) -> dict:
    F = _functions()
    row = frame.agg(
        F.sum(F.when(F.col("event_type") == "recommendation_shown", 1).otherwise(0)).alias("impressions"),
        F.sum(F.when(F.col("is_positive"), 1).otherwise(0)).alias("positive_outcomes"),
        F.sum(F.when(F.col("is_negative"), 1).otherwise(0)).alias("explicit_negatives"),
        F.countDistinct("candidate_id").alias("distinct_candidates"),
        F.min("effective_event_time").alias("first_outcome_at"),
        F.max("effective_event_time").alias("last_outcome_at"),
    ).collect()[0]
    return {name: row[name] for name in row.asDict()}


def _weeks(first, last) -> float:
    if first is None or last is None:
        return 0.0
    return (last - first) / timedelta(weeks=1)


def _holdout(frame, counts: dict) -> dict:
    """
    How much of the outcome data a temporal holdout would contain.

    Temporal rather than random. A random split puts a reader's later click in
    training and their earlier one in test, so the model is scored on a past it
    has already seen through the future, and every metric comes out flattering.

    "Not sharing a future interaction with training features" is the plan's
    phrase and is a property of how features are built, not of this count. What
    is checked here is that a holdout of the required size exists at all; the
    feature rule is stated in the record so the training job cannot claim this
    gate covered it.
    """
    F = _functions()
    decisions = frame.filter(F.col("is_positive") | F.col("is_negative"))
    ordered = [row["effective_event_time"] for row in decisions.select("effective_event_time").collect()]
    return holdout_over(ordered)


def holdout_over(moments: list) -> dict:
    """
    The temporal holdout, from the outcome times alone.

    Separated from the query so it can be tested: the property that matters is
    that it can fail, and the first version could not.

    The cut is a moment, not a position in the list.
    A position-based cut was the first version and it could not fail: taking the
    last fifth of any list gives you a fifth of the list. What a temporal
    holdout has to answer is whether outcomes are spread across the period they
    span, and a reader whose activity is front-loaded has no holdout however
    many rows they left behind.

    The cut sits four fifths of the way through the observed span, and the
    holdout is what happened after it. Strictly after: an outcome exactly on the
    boundary belongs to the period that produced the boundary.
    """
    ordered = sorted(moments)
    if not ordered:
        return {"outcomes": 0, "holdout_outcomes": 0, "holdout_share": 0.0, "cut_at": None}

    first, last = ordered[0], ordered[-1]
    span = last - first
    cut_at = first + span * (1 - HOLDOUT_FRACTION)
    holdout = sum(1 for moment in ordered if moment > cut_at)
    return {
        "outcomes": len(ordered),
        "holdout_outcomes": holdout,
        "holdout_share": holdout / len(ordered),
        "cut_at": cut_at,
    }


def assess(user_id: str | None = None) -> dict:
    F = _functions()
    frame = _spark().read.table(OUTCOMES)
    if user_id:
        frame = frame.filter(F.col("user_id") == user_id)

    counts = _counts(frame)
    weeks = _weeks(counts["first_outcome_at"], counts["last_outcome_at"])
    holdout = _holdout(frame, counts)

    measured = {
        "impressions": int(counts["impressions"] or 0),
        "positive_outcomes": int(counts["positive_outcomes"] or 0),
        "explicit_negatives": int(counts["explicit_negatives"] or 0),
        "distinct_candidates": int(counts["distinct_candidates"] or 0),
        # Unrounded, for the same reason the holdout share is: a duration just
        # under eight weeks that rounds to 8.0 is a gate deciding it was met
        # because a number looked like the number it was measured against.
        "weeks_of_outcomes": weeks,
        # Unrounded. Rounding before comparing let 0.1999 pass a threshold of
        # 0.2, which is a gate deciding it had been met because a number looked
        # like the number it was measured against.
        "holdout_fraction": holdout["holdout_share"],
    }

    unmet = [
        f"{name}: {measured[name]} of {THRESHOLDS[name]}"
        for name in THRESHOLDS
        if measured[name] < THRESHOLDS[name]
    ]
    return {
        "gate_version": GATE_VERSION,
        "assessed_at": datetime.now(timezone.utc),
        "user_id": user_id,
        "measured": measured,
        "thresholds": dict(THRESHOLDS),
        "unmet": unmet,
        "passed": not unmet,
        "holdout_cut_at": holdout["cut_at"],
        "holdout_outcomes": holdout["holdout_outcomes"],
        "decision_outcomes": holdout["outcomes"],
    }


def ensure_table():
    spark = _spark()
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{OPS}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {READINESS} (
          assessed_at TIMESTAMP NOT NULL,
          gate_version STRING NOT NULL,
          user_id STRING,
          passed BOOLEAN NOT NULL,
          impressions BIGINT,
          positive_outcomes BIGINT,
          explicit_negatives BIGINT,
          distinct_candidates BIGINT,
          weeks_of_outcomes DOUBLE,
          holdout_fraction DOUBLE,
          holdout_cut_at TIMESTAMP,
          decision_outcomes BIGINT,
          unmet ARRAY<STRING>
        )
        USING DELTA
        COMMENT 'Every assessment of whether a learned ranker may be trained. Counts only; no reader text.'
        """
    )


def main() -> None:
    missing = [name for name, value in (("catalog", CATALOG), ("silver_schema", SILVER), ("ops_schema", OPS)) if not value]
    if missing:
        raise SystemExit(f"missing required job parameter(s): {', '.join(missing)}")

    ensure_table()
    assessment = assess()

    spark = _spark()
    schema = spark.read.table(READINESS).schema
    record = {
        "assessed_at": assessment["assessed_at"],
        "gate_version": assessment["gate_version"],
        "user_id": assessment["user_id"],
        "passed": assessment["passed"],
        **{name: assessment["measured"][name] for name in assessment["measured"]},
        "holdout_cut_at": assessment["holdout_cut_at"],
        "decision_outcomes": assessment["decision_outcomes"],
        "unmet": assessment["unmet"],
    }
    row = tuple(record.get(field.name) for field in schema.fields)
    spark.createDataFrame([row], schema=schema).write.mode("append").saveAsTable(READINESS)

    readable = {
        name: (round(value, 3) if isinstance(value, float) else value)
        for name, value in assessment["measured"].items()
    }
    print(json.dumps(readable, indent=2, default=str))
    if assessment["passed"]:
        # Not an instruction to train. It says the data is no longer the reason
        # not to, which is a smaller statement than it sounds and is the only
        # one this job is entitled to make. It is not a claim that the
        # resulting model would be good.
        print(f"{GATE_VERSION}: every threshold met. Phase 10 is unblocked on data grounds alone.")
        return

    for shortfall in assessment["unmet"]:
        print(f"  short: {shortfall}")
    # Exit 0. A gate that is not yet met is the expected state for most of this
    # system's life, and a failing job every quarter of an hour would train
    # whoever owns it to ignore the alert that matters.
    print(f"{GATE_VERSION}: {len(assessment['unmet'])} threshold(s) unmet; a learned ranker stays blocked.")


if __name__ == "__main__":
    main()
