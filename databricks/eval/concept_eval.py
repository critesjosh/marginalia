"""
Live concept-extraction evaluation.

Deliberately not part of `npm test`. It calls a real model, so it belongs
nowhere near a suite that has to pass offline and deterministically. Run it by
hand when the prompt, the model, or the canonicalization version changes:

    python3 databricks/eval/concept_eval.py [--endpoint databricks-gpt-oss-120b]

Passes when the response recalls at least four of the five reference concepts
and adds no more than two the fixture does not support.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "databricks" / "src"))

from concepts import (  # noqa: E402
    CANONICALIZATION_VERSION,
    PROMPT_VERSION,
    ResponseInvalid,
    canonicalize,
    parse_extraction_response,
)

FIXTURE = json.loads((ROOT / "contracts/fixtures/concept-extraction-phase-3.json").read_text())

# The same rules the extraction job prepends. Kept in one string so the thing
# evaluated is the thing that runs.
SYSTEM_PROMPT = (
    "You extract the intellectual concepts a reader is engaging with.\n"
    "You are given one piece of text that a reader wrote or marked.\n"
    "Return between 1 and 8 concepts.\n"
    "A concept is an index term: the name of an idea, as it would appear in the index\n"
    "of a book or as the title of an encyclopedia entry. \"value judgment\", \"free\n"
    "will\", \"social contract\".\n"
    "Do not describe what the passage does. \"critique of moral values\" and\n"
    "\"examination of the origins of X\" are descriptions of the passage, not concepts;\n"
    "the concepts there are \"moral value\" and \"origin of X\".\n"
    "Name both the specific ideas the text invokes and the broad subject it belongs\n"
    "to, when the text genuinely supports both.\n"
    "Prefer fewer concepts. Return only what a careful reader would list as the\n"
    "passage's main subjects, not every phrase it contains.\n"
    "Do not return a book's title, its author, or a character's name, unless the\n"
    "title is also the established name of an idea in its own right: \"the social\n"
    "contract\", \"genealogy of morality\". Judge the idea, not the cover.\n"
    "Do not invent concepts the text does not support.\n"
    "confidence is your estimate from 0 to 1 that the concept is present.\n"
    "broader is optional: a single more general concept this one sits under.\n"
    "Respond with JSON only, shaped {\"concepts\":[{\"label\":str,\"confidence\":number,\"broader\":str}]}. No prose, no code fence."
)


def query(endpoint: str, prompt: str) -> tuple[str, int]:
    """
    Through the CLI rather than the SDK: the CLI is already the authenticated
    surface every other step of this plan uses, and this adds no dependency to
    anybody's environment to run one evaluation.
    """
    body = {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(body, handle)
        request_path = handle.name

    try:
        started = time.monotonic()
        completed = subprocess.run(
            ["databricks", "serving-endpoints", "query", endpoint, "--json", f"@{request_path}"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        latency_ms = int((time.monotonic() - started) * 1000)
    finally:
        Path(request_path).unlink(missing_ok=True)

    if completed.returncode != 0:
        raise SystemExit(f"endpoint query failed: {completed.stderr.strip()[:400]}")

    answer = json.loads(completed.stdout)
    return answer["choices"][0]["message"]["content"], latency_ms


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="databricks-gpt-oss-120b")
    arguments = parser.parse_args()

    case = FIXTURE["evaluation"]
    expected = {canonicalize(name) for name in case["reference_concepts"]}

    raw, latency_ms = query(arguments.endpoint, case["text"])
    try:
        parsed = parse_extraction_response(raw)
    except ResponseInvalid as invalid:
        print(f"FAIL invalid response: {invalid.status} {invalid.detail}")
        print(raw)
        return 1

    extracted = {item["canonical_concept"] for item in parsed}
    recalled = sorted(expected & extracted)
    missed = sorted(expected - extracted)
    unsupported = sorted(extracted - expected)

    # Latency and endpoint, never the text. The concepts are printed because
    # this is a public-domain fixture run by hand, not a pipeline log.
    print(
        json.dumps(
            {
                "endpoint": arguments.endpoint,
                "prompt_version": PROMPT_VERSION,
                "canonicalization_version": CANONICALIZATION_VERSION,
                "latency_ms": latency_ms,
                "recalled": recalled,
                "missed": missed,
                "unsupported_additions": unsupported,
            },
            indent=2,
        )
    )

    ok = (
        len(recalled) >= case["live_minimum_recall"]
        and len(unsupported) <= case["live_maximum_unsupported"]
    )
    print(
        f"{'PASS' if ok else 'FAIL'}: recalled {len(recalled)}/{len(expected)} "
        f"(need {case['live_minimum_recall']}), "
        f"{len(unsupported)} unsupported (allow {case['live_maximum_unsupported']})"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
