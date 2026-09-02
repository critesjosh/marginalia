"""
Run the fixed Genie questions and print the known-correct answer for each.

This does not ask Genie anything. It establishes what the right answer is, by
running the SQL the question set names, so that a Genie answer can be compared
against something rather than judged by whether it reads plausibly.

The values move as the reader reads. What is fixed is the question, the grain,
and the checks; a baseline captured today is evidence about today, which is why
this prints rather than asserting against stored numbers.

    python3 databricks/eval/genie_eval.py \
      --profile me --warehouse <id> --gold <catalog>.<schema>

The refusal question is listed and deliberately not run: it has no correct SQL,
and the thing being tested there is whether Genie declines rather than returns
an empty result.
"""

import argparse
import json
import pathlib
import subprocess
import tempfile

QUESTIONS = pathlib.Path(__file__).with_name("genie_questions.json")


def run_statement(sql: str, warehouse: str, profile: str) -> dict:
    body = json.dumps({"warehouse_id": warehouse, "statement": sql, "wait_timeout": "50s"})
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        handle.write(body)
        path = handle.name
    completed = subprocess.run(
        ["databricks", "api", "post", "/api/2.0/sql/statements", "-p", profile, "--json", f"@{path}"],
        capture_output=True,
        text=True,
        timeout=180,
    )
    return json.loads(completed.stdout)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="DEFAULT")
    parser.add_argument("--warehouse", required=True)
    parser.add_argument("--gold", required=True, help="catalog.schema holding the Gold tables")
    arguments = parser.parse_args()

    questions = json.loads(QUESTIONS.read_text())
    print(f"{questions['version']} against {arguments.gold}\n")

    failures = 0
    for question in questions["questions"]:
        identifier = question["id"]
        if question.get("expected_behavior") == "refuse":
            print(f"  {identifier:30} REFUSAL  ask Genie by hand; a correct answer declines")
            print(f"  {'':30}          an empty result is a wrong answer, not a near miss")
            continue

        answer = run_statement(
            question["expected_sql"].replace("{gold}", arguments.gold),
            arguments.warehouse,
            arguments.profile,
        )
        state = answer.get("status", {}).get("state")
        rows = (answer.get("result") or {}).get("data_array") or []
        if state != "SUCCEEDED":
            failures += 1
            detail = (answer.get("status", {}).get("error") or {}).get("message", "")[:120]
            print(f"  {identifier:30} {state}  {detail}")
            continue

        print(f"  {identifier:30} {len(rows)} row(s)  grain: {question['grain']}")
        for row in rows[:5]:
            print(f"  {'':30}   {row}")
        for check in question["checks"]:
            print(f"  {'':30}   check: {check}")
        print()

    if failures:
        # A question set that cannot run is not a passing evaluation, it is an
        # evaluation that did not happen.
        raise SystemExit(f"{failures} question(s) could not be run")


main()
