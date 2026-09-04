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

FRONTIER_WEIGHTS = {
    "similarity": 0.45,
    "neighbor_strength": 0.35,
    "source_quality": 0.20,
}
RECOMMENDATION_WEIGHTS = {
    "interest": 0.45,
    "frontier": 0.20,
    "diversity": 0.15,
    "popularity": 0.10,
    "metadata": 0.10,
}

ARTICLES = ("the ", "a ", "an ")


def _fold(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.lower()


def make_title_normalizer():
    """
    Titles differ by subtitle, punctuation, and article between editions and
    catalogues. What survives is the part that identifies the work.

    Returned as a closure over values rather than as a module function because
    Spark resolves an imported module on the driver and not always on a worker.
    Everything it needs is bound here, so it serializes whole.
    """
    articles = tuple(ARTICLES)

    def looks_like_the_author(fragment, author):
        """
        Whether a title fragment is really the author's name.

        Nested rather than module level, and that is not a style choice.
        Cloudpickle serializes a module-level function by reference, so a
        worker would have to import public_matching to call it, and it cannot.
        Everything this closure needs has to be inside it.

        Deliberately strict: every word of the fragment must be part of the
        author's name. "Nietzsche" against "Friedrich Nietzsche" qualifies; a
        title that merely mentions them does not, because dropping a real half
        of a title is worse than keeping an author prefix.
        """
        if not author:
            return False
        names = author if isinstance(author, (list, tuple)) else [author]
        words = {word for word in re.split(r"[^a-z0-9]+", str(fragment).lower()) if word}
        if not words:
            return False
        for name in names:
            folded = unicodedata.normalize("NFKD", str(name or ""))
            folded = "".join(ch for ch in folded if not unicodedata.combining(ch)).lower()
            name_words = {word for word in re.split(r"[^a-z0-9]+", folded) if word}
            if name_words and words <= name_words:
                return True
        return False

    def normalize(value, author=None):
        text = unicodedata.normalize("NFKD", str(value or ""))
        text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()

        # Series and edition notes ride in brackets: "The Gay Science
        # (Cambridge Texts in the History of Philosophy)". Every word of that
        # is a token the real title does not have.
        text = re.sub(r"\([^)]*\)", " ", text)
        text = re.sub(r"\[[^\]]*\]", " ", text)

        # Project Gutenberg writes "Title / translator and edition note". The
        # part after the slash describes the edition, not the work.
        text = text.split("/")[0]

        # A colon usually separates a title from its subtitle, and the title is
        # the half that identifies the work. But academic editions invert it,
        # writing "Author: Title", and taking the first half there throws the
        # title away and searches for the author instead. So the first half is
        # dropped when it is the author, and kept otherwise.
        parts = text.split(":")
        if len(parts) > 1 and looks_like_the_author(parts[0], author):
            text = ":".join(parts[1:])
        else:
            text = parts[0]

        text = re.sub(r"[^a-z0-9 ]+", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        for article in articles:
            if text.startswith(article):
                text = text[len(article) :]
                break
        return text

    return normalize




def normalize_title(title: str, author=None) -> str:
    """The same normalization the Spark side uses, never a second copy of it."""
    return make_title_normalizer()(title, author)


def normalize_author(author: str) -> str:
    """
    "Nietzsche, Friedrich" and "Friedrich Nietzsche" are one person.

    The given name is kept whole rather than reduced to an initial. Surname plus
    initial made "John Smith" and "Jane Smith" the same author, which is enough
    to attach a shared title to the wrong person.
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
    surname = re.sub(r"\s+", " ", surname).strip()
    given = re.sub(r"\s+", " ", rest).strip()
    return f"{surname} {given}".strip() if given else surname


def _tokens(value: str) -> set[str]:
    return {token for token in value.split(" ") if token}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _author_similarity(left: str, right: str) -> float:
    """
    Surnames must agree, and so must given names unless one side is an initial.
    Two people who share only a surname are not a partial match for each other,
    they are different people, and scoring them as close is how a shared title
    gets attached to the wrong author.
    """
    left_parts = left.split(" ")
    right_parts = right.split(" ")
    if not left_parts or not right_parts or left_parts[0] != right_parts[0]:
        return 0.0
    left_given = set(left_parts[1:])
    right_given = set(right_parts[1:])
    if not left_given or not right_given:
        # A surname alone matches a surname alone, but weakly: it is one name
        # in common and no evidence that it is the same person.
        return 0.5
    if left_given == right_given:
        return 1.0
    if left_given < right_given or right_given < left_given:
        # Catalogues disagree about middle names constantly. An extra middle
        # name is compatible; a different given name is not.
        return 0.95
    # "J. Smith" against "John Smith" is the common catalogue difference, and an
    # initial is genuinely one letter. "Jane" against "John" is not an initial
    # difference, it is a different person who happens to share a letter.
    for given in left_given:
        for other in right_given:
            if not given or not other:
                continue
            if (len(given) == 1 or len(other) == 1) and given[0] == other[0]:
                return 0.85
    return 0.0


def match_confidence(
    book: dict,
    candidate: dict,
) -> float:
    """
    How much a candidate work looks like this book. Title carries most of it,
    author is the check that stops a shared title attaching the wrong work, and
    edition count is a weak tiebreak between otherwise equal candidates.
    """
    title = _jaccard(
        _tokens(normalize_title(book.get("title", ""), book.get("author"))),
        _tokens(normalize_title(candidate.get("title", ""), candidate.get("author_name"))),
    )
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
        author = max((_author_similarity(book_author, name) for name in candidates), default=0.0)

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
        FRONTIER_WEIGHTS["similarity"] * clamp(similarity_to_established)
        + FRONTIER_WEIGHTS["neighbor_strength"] * clamp(normalized_neighbor_strength)
        + FRONTIER_WEIGHTS["source_quality"] * clamp(source_quality),
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
        RECOMMENDATION_WEIGHTS["interest"] * clamp(concept_interest_match)
        + RECOMMENDATION_WEIGHTS["frontier"] * clamp(frontier_coverage)
        + RECOMMENDATION_WEIGHTS["diversity"] * clamp(diversity)
        + RECOMMENDATION_WEIGHTS["popularity"] * clamp(popularity_prior)
        + RECOMMENDATION_WEIGHTS["metadata"] * clamp(metadata_completeness),
        6,
    )


def metadata_completeness(work: dict) -> float:
    """How much of a work's record is actually there, as a 0-1 fraction."""
    fields = ("title", "authors", "publication_year")
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
