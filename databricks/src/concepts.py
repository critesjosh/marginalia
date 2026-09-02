# Concept canonicalization, response validation, and the Gold scoring formulas.
#
# Deliberately free of Spark and of any network call: the pipeline imports it,
# and the deterministic test suite exercises it directly with fixed model
# responses, so nothing here can make that suite flaky.

import json
import math
import re
import unicodedata

PROMPT_VERSION = "concept-extraction-v1"

# Alias edits do not rewrite provenance in place. Bump this instead, so a row
# records the version that produced its canonical value and an older row stays
# explicable.
CANONICALIZATION_VERSION = 1

MAX_CONCEPTS = 8
MIN_CONCEPTS = 1
MAX_LABEL_CHARS = 80
MAX_EXTRACTION_ATTEMPTS = 3

# Evidence weights from the plan. Assistant text is present and zero on purpose:
# leaving it out entirely would make an accidental future contribution silent.
EVIDENCE_WEIGHTS = {
    "highlight_passage": 1.0,
    "highlight_note": 1.5,
    "user_question": 2.0,
    "book_memory": 0.75,
    "book_description": 0.25,
    "assistant_text": 0.0,
}

RECENCY_HALF_LIFE_DAYS = 90.0

# Keys are written the way a label reads *after* singularization, because that
# is the only form the lookup ever sees. A key that is still plural is dead, and
# a value that is not its own fixed point would flip a label back and forth;
# both are asserted against in the contract tests.
CONCEPT_ALIASES = {
    "genealogy of moral": "genealogy of morality",
    "moral genealogy": "genealogy of morality",
    "the genealogy of morality": "genealogy of morality",
    "moral value judgment": "value judgment",
    "judgment of value": "value judgment",
    "value-judgment": "value judgment",
    "moral": "morality",
    "good versus evil": "good and evil",
    "good vs evil": "good and evil",
    "good and evil distinction": "good and evil",
    "origins of moral value": "origin of moral value",
    "the origin of moral value": "origin of moral value",
    "origin of value": "origin of moral value",
}


# Endings that look plural and are not: a mass noun ("ethics", "politics"), a
# Latin singular ("corpus", "analysis"), or a word that simply ends in one of
# them. Stripping the s here would coin a concept nobody wrote.
NON_PLURAL_SUFFIXES = ("ss", "us", "is", "ics", "ous")


def _singularize(word: str) -> str:
    """Simple English plurals only. Anything irregular is left alone."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith(("sses", "shes", "ches", "xes", "zes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith(NON_PLURAL_SUFFIXES):
        return word[:-1]
    return word


def canonicalize(label: str) -> str:
    """
    Lowercase, Unicode-normalize, singularize the final word, then apply
    aliases. Aliases run last so an alias key is written the way a canonical
    label already reads.
    """
    if label is None:
        return ""
    text = unicodedata.normalize("NFKC", str(label)).strip().lower()
    text = re.sub(r"[‐-―]", "-", text)
    text = re.sub(r"\s+", " ", text)
    text = text.strip(" .,;:")
    if not text:
        return ""

    words = text.split(" ")
    words[-1] = _singularize(words[-1])
    text = " ".join(words)
    return CONCEPT_ALIASES.get(text, text)


class ResponseInvalid(Exception):
    """Carries the stable validation_status recorded against the candidate."""

    def __init__(self, status: str, detail: str = ""):
        super().__init__(f"{status}: {detail}" if detail else status)
        self.status = status
        self.detail = detail


def parse_extraction_response(raw: str) -> list[dict]:
    """
    Validates one model response and returns its concepts with canonical labels
    attached. Raises ResponseInvalid with the status to record on failure.
    """
    if raw is None or not str(raw).strip():
        raise ResponseInvalid("empty_response")

    try:
        document = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise ResponseInvalid("invalid_json", str(error)[:200]) from error

    if not isinstance(document, dict):
        raise ResponseInvalid("schema_invalid", "top level is not an object")

    unknown = set(document) - {"concepts"}
    if unknown:
        raise ResponseInvalid("schema_invalid", f"unknown field {sorted(unknown)[0]}")

    concepts = document.get("concepts")
    if not isinstance(concepts, list):
        raise ResponseInvalid("schema_invalid", "concepts is not an array")
    if not MIN_CONCEPTS <= len(concepts) <= MAX_CONCEPTS:
        raise ResponseInvalid("schema_invalid", f"{len(concepts)} concepts")

    parsed = []
    seen = set()
    for item in concepts:
        if not isinstance(item, dict):
            raise ResponseInvalid("schema_invalid", "concept is not an object")
        unknown = set(item) - {"label", "confidence", "broader"}
        if unknown:
            raise ResponseInvalid("schema_invalid", f"unknown field {sorted(unknown)[0]}")

        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            raise ResponseInvalid("schema_invalid", "missing label")
        if len(label) > MAX_LABEL_CHARS:
            raise ResponseInvalid("schema_invalid", "label too long")

        confidence = item.get("confidence")
        # bool is an int subclass, and `true` is not a confidence.
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ResponseInvalid("schema_invalid", "missing confidence")
        if not 0.0 <= float(confidence) <= 1.0:
            raise ResponseInvalid("schema_invalid", "confidence out of range")

        broader = item.get("broader")
        if broader is not None:
            if not isinstance(broader, str) or not broader.strip():
                raise ResponseInvalid("schema_invalid", "broader is not a label")
            if len(broader) > MAX_LABEL_CHARS:
                raise ResponseInvalid("schema_invalid", "broader too long")

        canonical = canonicalize(label)
        if not canonical:
            raise ResponseInvalid("schema_invalid", "label canonicalizes to nothing")
        # A model that says the same thing twice is not a failure; it is one
        # concept. Keep the first, which carries the model's own ordering.
        if canonical in seen:
            continue
        seen.add(canonical)

        parsed.append(
            {
                "raw_concept": label.strip(),
                "canonical_concept": canonical,
                "broader_concept": canonicalize(broader) if broader else None,
                "confidence": float(confidence),
                "canonicalization_version": CANONICALIZATION_VERSION,
            }
        )

    return parsed


def next_validation_status(attempts: int) -> str:
    """
    A candidate retries at most three times. The third failure is terminal: it
    stays diagnosable and contributes to no profile.
    """
    return "permanent_failure" if attempts >= MAX_EXTRACTION_ATTEMPTS else "retry"


def recency_decay(age_days: float, half_life_days: float = RECENCY_HALF_LIFE_DAYS) -> float:
    """Exponential decay with a 90-day half-life. Future evidence is not amplified."""
    return 0.5 ** (max(0.0, age_days) / half_life_days)


def evidence_contribution(source_type: str, confidence: float, age_days: float) -> float:
    return EVIDENCE_WEIGHTS.get(source_type, 0.0) * confidence * recency_decay(age_days)


def engagement_score_v1(
    active_minutes: float,
    session_count: int,
    maximum_progress: float,
    current_highlights: int,
    questions: int,
    completed: bool,
) -> float:
    """
    The plan's formula, kept here so the pipeline and its tests cannot drift.
    Every component is exposed as its own column, so the score recomputes.
    """
    return (
        0.30 * min(1.0, math.log1p(max(0.0, active_minutes)) / math.log1p(300))
        + 0.15 * min(1.0, math.log1p(max(0, session_count)) / math.log1p(20))
        + 0.15 * min(1.0, max(0.0, maximum_progress))
        + 0.15 * min(1.0, max(0, current_highlights) / 10)
        + 0.15 * min(1.0, max(0, questions) / 10)
        + 0.10 * (1.0 if completed else 0.0)
    )
