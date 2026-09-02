# Matching a reader's book to a public work, and the Phase 6 scoring formulas.
#
# Free of Spark and of any network call, like concepts.py, so the deterministic
# tests can exercise the judgement without reaching Open Library.

import math
import re
import unicodedata

MATCHER_VERSION = "openlibrary-match-v1"
FRONTIER_SCORE_VERSION = "frontier_score_v1"
RECOMMENDATION_SCORE_VERSION = "recommendation_heuristic_v1"

# A match at or above this is attached. Between the two, the candidates are kept
# but nothing is attached: an ambiguous match is worse than no match, because a
# wrong work quietly poisons every recommendation built on it.
MATCH_ACCEPT = 0.82
MATCH_CONSIDER = 0.55
# Two candidates this close to each other are not distinguishable by title and
# author alone, however high they score.
MATCH_SEPARATION = 0.08

ARTICLES = ("the ", "a ", "an ")


def _fold(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.lower()


def normalize_title(title: str) -> str:
    """
    Titles differ by subtitle, punctuation, and article between editions and
    catalogues. What survives is the part that identifies the work.
    """
    text = _fold(title)
    # A subtitle is the commonest difference between the same work in two
    # catalogues, so the part before the colon is what gets compared.
    text = text.split(":")[0]
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for article in ARTICLES:
        if text.startswith(article):
            text = text[len(article) :]
            break
    return text


def normalize_author(author: str) -> str:
    """
    "Nietzsche, Friedrich" and "Friedrich Nietzsche" are one person. Surname
    plus first initial is what both reliably contain.
    """
    text = _fold(author)
    text = re.sub(r"[^a-z, ]+", " ", text)
    if "," in text:
        surname, _, rest = text.partition(",")
    else:
        parts = [p for p in text.split() if p]
        if not parts:
            return ""
        surname, rest = parts[-1], " ".join(parts[:-1])
    surname = surname.strip()
    initial = next((c for c in rest.strip() if c.isalpha()), "")
    return f"{surname} {initial}".strip()


def _tokens(value: str) -> set[str]:
    return {token for token in value.split(" ") if token}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def match_confidence(
    book: dict,
    candidate: dict,
) -> float:
    """
    How much a candidate work looks like this book. Title carries most of it,
    author is the check that stops a shared title attaching the wrong work, and
    edition count is a weak tiebreak between otherwise equal candidates.
    """
    title = _jaccard(_tokens(normalize_title(book.get("title", ""))),
                     _tokens(normalize_title(candidate.get("title", ""))))
    if title == 0.0:
        return 0.0

    book_author = normalize_author(book.get("author", ""))
    candidates = [normalize_author(name) for name in candidate.get("author_name", []) or []]
    if not book_author or not candidates:
        # No author to check against. The title alone can be right, but it is
        # never enough to attach on.
        author = 0.0
    elif book_author in candidates:
        author = 1.0
    else:
        author = max(
            (_jaccard(_tokens(book_author), _tokens(name)) for name in candidates),
            default=0.0,
        )

    # An edition count says a work is the well-known one rather than a stray
    # record of it, but it says nothing about whether it is this book.
    editions = candidate.get("edition_count") or 0
    popularity = min(1.0, math.log1p(editions) / math.log1p(50))

    return round(0.65 * title + 0.30 * author + 0.05 * popularity, 6)


def choose_match(book: dict, candidates: list[dict]) -> dict:
    """
    Picks a work, or explains why it did not.

    An ambiguous result is deliberate and terminal for this run: the candidates
    are recorded so a human or a later matcher version can look, but nothing is
    attached to the reader's book.
    """
    scored = sorted(
        (
            {
                "key": candidate.get("key"),
                "title": candidate.get("title"),
                "confidence": match_confidence(book, candidate),
            }
            for candidate in candidates
        ),
        key=lambda row: (-row["confidence"], row["key"] or ""),
    )
    result = {
        "matcher_version": MATCHER_VERSION,
        "work_key": None,
        "confidence": 0.0,
        "status": "unmatched",
        "considered": scored[:5],
    }
    if not scored or scored[0]["confidence"] < MATCH_CONSIDER:
        return result

    best = scored[0]
    runner_up = scored[1]["confidence"] if len(scored) > 1 else 0.0
    result["confidence"] = best["confidence"]

    if best["confidence"] < MATCH_ACCEPT:
        result["status"] = "ambiguous"
    elif best["confidence"] - runner_up < MATCH_SEPARATION:
        # Two works this close cannot be told apart by title and author, and
        # guessing between them is how a reader's highlights end up cited
        # against a book they never read.
        result["status"] = "ambiguous"
    else:
        result["status"] = "matched"
        result["work_key"] = best["key"]
    return result


def frontier_score_v1(
    similarity_to_established: float,
    normalized_neighbor_strength: float,
    source_quality: float,
) -> float:
    """The plan's formula, with every component clamped rather than trusted."""
    clamp = lambda value: min(1.0, max(0.0, value))  # noqa: E731
    return round(
        0.45 * clamp(similarity_to_established)
        + 0.35 * clamp(normalized_neighbor_strength)
        + 0.20 * clamp(source_quality),
        6,
    )


def recommendation_score_v1(
    concept_interest_match: float,
    frontier_coverage: float,
    diversity: float,
    popularity_prior: float,
    metadata_completeness: float,
) -> float:
    clamp = lambda value: min(1.0, max(0.0, value))  # noqa: E731
    return round(
        0.45 * clamp(concept_interest_match)
        + 0.20 * clamp(frontier_coverage)
        + 0.15 * clamp(diversity)
        + 0.10 * clamp(popularity_prior)
        + 0.10 * clamp(metadata_completeness),
        6,
    )


def metadata_completeness(work: dict) -> float:
    """How much of a work's record is actually there, as a 0-1 fraction."""
    fields = ("title", "author_name", "first_publish_year", "subject", "cover_i")
    present = sum(1 for field in fields if work.get(field))
    return present / len(fields)


def explain_recommendation(components: dict, concepts: list[str]) -> str:
    """
    A deterministic sentence, assembled rather than generated. The plan requires
    recommendations to be servable with no model in the loop.
    """
    if concepts:
        named = ", ".join(concepts[:3])
        lead = f"Matches your interest in {named}"
    else:
        lead = "Matches your reading"
    if components.get("frontier_coverage", 0) >= 0.5:
        lead += ", and reaches into territory next to it"
    if components.get("diversity", 0) >= 0.5:
        lead += ", by an author you have not been reading"
    return lead + "."
