"""
The fixed Genie questions, the answer each one actually has, and what Genie says.

Two modes, because they answer different questions.

`--baseline` (the default) runs the SQL the question set names and prints the
result. It establishes what the right answer is, so that a Genie answer can be
compared against something rather than judged by whether it reads plausibly.

`--ask` puts each question to a deployed Genie space and compares what comes
back against that baseline, column by column. Phase 7 left this as a manual
step and it stayed undone, which is the usual fate of a manual step; the
comparison is mechanical, so it may as well be mechanical.

    python3 databricks/eval/genie_eval.py \
      --profile me --warehouse <id> --tables <catalog>.<scoped-schema>

    python3 databricks/eval/genie_eval.py \
      --profile me --warehouse <id> --tables <catalog>.<scoped-schema> \
      --ask --space <genie-space-id>

The values move as the reader reads. What is fixed is the question, the grain,
and the checks, which is why the baseline is computed on each run rather than
stored: an answer compared against last week's numbers fails for the wrong
reason.

Two things this cannot decide on its own and reports rather than guessing:
whether the SQL Genie wrote is right for the reason the grain describes, and
whether a refusal refuses for the right reason. It shows both so a person reads
them, and it fails on everything it can decide.
"""

import argparse
import json
import pathlib
import subprocess
import tempfile
import time

QUESTIONS = pathlib.Path(__file__).with_name("genie_questions.json")

# How long to wait for one Genie answer. Text-to-SQL over a warehouse that has
# to wake up is not fast, and a timeout that fired during a cold start would
# look like a wrong answer.
ANSWER_TIMEOUT_SECONDS = 300
POLL_SECONDS = 5


def _api(method: str, path: str, profile: str, body: dict | None = None) -> dict:
    command = ["databricks", "api", method, path, "-p", profile]
    if body is not None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write(json.dumps(body))
            command += ["--json", f"@{handle.name}"]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=300)
    if not completed.stdout.strip():
        raise SystemExit(f"{method} {path} returned nothing: {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def run_statement(sql: str, warehouse: str, profile: str) -> dict:
    return _api(
        "post",
        "/api/2.0/sql/statements",
        profile,
        {"warehouse_id": warehouse, "statement": sql, "wait_timeout": "50s"},
    )


def _columns(response: dict) -> list[str]:
    schema = ((response.get("manifest") or {}).get("schema") or {}).get("columns") or []
    return [column.get("name", "") for column in schema]


def _rows(response: dict) -> list[list]:
    return (response.get("result") or {}).get("data_array") or []


def _comparable(value):
    """
    One cell, in a form two sources can be compared in.

    The statement API returns every value as a string, and Genie's own result
    comes back the same way, but a float rendered by two different code paths
    can differ in its last digit. Numbers are compared rounded; everything else
    is compared as trimmed text.
    """
    if value is None:
        return None
    text = str(value).strip()
    try:
        return round(float(text), 6)
    except ValueError:
        return text


def _as_dicts(response: dict) -> list[dict]:
    columns = _columns(response)
    return [{name: _comparable(cell) for name, cell in zip(columns, row)} for row in _rows(response)]


class Genie:
    """One conversation per question, so nothing carries context into the next."""

    def __init__(self, space: str, profile: str):
        self.space = space
        self.profile = profile

    def ask(self, question: str) -> dict:
        started = _api(
            "post",
            f"/api/2.0/genie/spaces/{self.space}/start-conversation",
            self.profile,
            {"content": question},
        )
        conversation = started.get("conversation_id") or (started.get("conversation") or {}).get("id")
        message = started.get("message_id") or (started.get("message") or {}).get("id")
        if not conversation or not message:
            raise SystemExit(f"Genie did not start a conversation: {json.dumps(started)[:400]}")

        base = f"/api/2.0/genie/spaces/{self.space}/conversations/{conversation}/messages/{message}"
        deadline = time.time() + ANSWER_TIMEOUT_SECONDS
        answer = {}
        while time.time() < deadline:
            answer = _api("get", base, self.profile)
            if answer.get("status") in ("COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"):
                break
            time.sleep(POLL_SECONDS)
        else:
            raise SystemExit(f"Genie did not answer within {ANSWER_TIMEOUT_SECONDS}s")

        text, sql, result = [], None, None
        for attachment in answer.get("attachments") or []:
            if "text" in attachment and attachment["text"].get("content"):
                text.append(attachment["text"]["content"])
            if "query" in attachment:
                sql = attachment["query"].get("query")
                result = _api("get", f"{base}/attachments/{attachment['attachment_id']}/query-result", self.profile)
                result = result.get("statement_response", result)
        return {"status": answer.get("status"), "text": "\n".join(text), "sql": sql, "result": result}


def _row_problems(index: int, wanted_row: dict, got_row: dict) -> list[str]:
    """
    One expected row against one Genie row.

    Genie is free to name a column whatever its SQL called it: `max(computed_at)
    AS last_computed_at` is the right answer to a freshness question and a wrong
    column name is not a wrong answer. So a column is looked for by name first,
    and by value second among the cells nothing has claimed yet.

    Claiming matters. Without it one cell satisfies every expected column that
    happens to hold the same number, so an answer returning `current_highlights`
    alone would pass a question that asked for highlights and questions whenever
    the two were equal.
    """
    problems = []
    # Cells no expected column names. A column matched by name is never taken by
    # a value match for a different column, whichever order they are checked in.
    unclaimed = [value for name, value in got_row.items() if name not in wanted_row]

    for column, value in wanted_row.items():
        if column in got_row:
            if got_row[column] != value:
                problems.append(f"row {index}: {column} is {got_row[column]!r}, expected {value!r}")
        elif value in unclaimed:
            unclaimed.remove(value)
        else:
            problems.append(f"row {index}: no unclaimed column holds {column}={value!r}")
    return problems


def compare(expected: dict, actual: dict | None, ordered: bool) -> list[str]:
    """
    Every way this answer is wrong, in words. An empty list is a pass.

    Genie may return more columns than the question needs and may name them
    differently. What it may not do is return a different number of rows, or
    fail to carry a value the expected answer holds.

    `ordered` comes from the question. A ranking is wrong in a different order;
    a per-book breakdown is not, and comparing that one positionally fails a
    correct answer for arranging itself differently. Unordered rows are matched
    greedily: each expected row against the first Genie row that satisfies it.
    """
    if actual is None:
        return ["Genie returned no query result"]

    wanted = _as_dicts(expected)
    got = _as_dicts(actual)

    if not wanted:
        # Nothing to compare against. Row counts would agree with any query that
        # also returned nothing, so this would pass whatever Genie asked. An
        # evaluation over an empty profile is not evidence about Genie.
        return ["the baseline returned no rows, so this question proves nothing; evaluate against a reader with data"]

    problems = []
    if len(wanted) != len(got):
        problems.append(f"expected {len(wanted)} row(s), Genie returned {len(got)}")

    if ordered:
        for index, (wanted_row, got_row) in enumerate(zip(wanted, got)):
            problems += _row_problems(index, wanted_row, got_row)
        return problems

    unmatched = list(got)
    for index, wanted_row in enumerate(wanted):
        for candidate in unmatched:
            if not _row_problems(index, wanted_row, candidate):
                unmatched.remove(candidate)
                break
        else:
            # Report against the first row still unclaimed, so the message says
            # what differed rather than only that nothing matched.
            problems += _row_problems(index, wanted_row, unmatched[0]) if unmatched else [
                f"row {index}: nothing in Genie's answer matches {wanted_row}"
            ]
    return problems


REFUSAL_LENGTH_LIMIT = 600

REFUSAL_WORDS = ("cannot", "can't", "will not", "won't", "not able", "no access", "not permitted", "do not have")


def judge_refusal(answer: dict) -> list[str]:
    """
    The refusal question has no correct SQL, so it is checked differently.

    An empty result is the failure worth naming: it reads as the reader having
    no highlights, which is a different and false claim than declining to look.

    What this establishes is narrow and worth stating: no SQL was written, and
    the prose reads as a refusal. It cannot establish that the prose refused and
    then answered anyway, because that is a reading. The whole answer is printed
    for that reason, and a long one is flagged: a refusal is short, and several
    paragraphs after "I cannot" is the shape of an answer with a disclaimer on
    the front.
    """
    if answer.get("sql"):
        rows = len(_rows(answer.get("result") or {}))
        return [f"Genie wrote SQL for a question it should refuse, returning {rows} row(s)"]
    if not answer.get("text", "").strip():
        return ["Genie neither refused nor answered"]
    if not any(word in answer["text"].lower() for word in REFUSAL_WORDS):
        return ["Genie's answer does not read as a refusal; read it and judge by hand"]
    if len(answer["text"]) > REFUSAL_LENGTH_LIMIT:
        return [
            f"Genie refused in {len(answer['text'])} characters; read it in full, "
            "a refusal this long may have refused and then answered"
        ]
    return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="DEFAULT")
    parser.add_argument("--warehouse", required=True)
    parser.add_argument("--tables", required=True,
                        help="catalog.schema the baseline SQL reads; the same per-reader views Genie is given")
    parser.add_argument("--ask", action="store_true", help="put each question to a Genie space and compare")
    parser.add_argument("--space", default="", help="Genie space id, required with --ask")
    arguments = parser.parse_args()

    if arguments.ask and not arguments.space:
        raise SystemExit("--ask needs --space")

    questions = json.loads(QUESTIONS.read_text())
    genie = Genie(arguments.space, arguments.profile) if arguments.ask else None
    print(f"{questions['version']} against {arguments.tables}")
    print("asking Genie and comparing\n" if genie else "baseline only; ask Genie by hand or rerun with --ask\n")

    failures = []
    for question in questions["questions"]:
        identifier = question["id"]

        if question.get("expected_behavior") == "refuse":
            if not genie:
                print(f"  {identifier:30} REFUSAL  ask by hand; a correct answer declines")
                print(f"  {'':30}          an empty result is a wrong answer, not a near miss\n")
                continue
            answer = genie.ask(question["question"])
            problems = judge_refusal(answer)
            print(f"  {identifier:30} {'PASS' if not problems else 'FAIL'}  refusal")
            for line in answer.get("text", "").strip().splitlines():
                print(f"  {'':30}   Genie said: {line}")
            for problem in problems:
                print(f"  {'':30}   {problem}")
            print()
            failures += [f"{identifier}: {problem}" for problem in problems]
            continue

        expected = run_statement(
            question["expected_sql"].replace("{gold}", arguments.tables),
            arguments.warehouse,
            arguments.profile,
        )
        state = expected.get("status", {}).get("state")
        if state != "SUCCEEDED":
            detail = (expected.get("status", {}).get("error") or {}).get("message", "")[:120]
            print(f"  {identifier:30} {state}  {detail}\n")
            failures.append(f"{identifier}: the baseline statement did not run")
            continue

        if not genie:
            print(f"  {identifier:30} {len(_rows(expected))} row(s)  grain: {question['grain']}")
            for row in _rows(expected)[:5]:
                print(f"  {'':30}   {row}")
            for check in question["checks"]:
                print(f"  {'':30}   check: {check}")
            print()
            continue

        answer = genie.ask(question["question"])
        problems = compare(expected, answer.get("result"), question["ordered"])
        print(f"  {identifier:30} {'PASS' if not problems else 'FAIL'}  grain: {question['grain']}")
        if answer.get("sql"):
            print(f"  {'':30}   Genie ran: {' '.join(answer['sql'].split())[:180]}")
        for problem in problems:
            print(f"  {'':30}   {problem}")
        for check in question["checks"]:
            # Printed rather than asserted. Whether the SQL counts the right
            # thing at the right grain is a reading, and a matching result set
            # is evidence for it rather than proof of it.
            print(f"  {'':30}   check by eye: {check}")
        print()
        failures += [f"{identifier}: {problem}" for problem in problems]

    if failures:
        # A question set that cannot run is not a passing evaluation, it is an
        # evaluation that did not happen.
        for failure in failures:
            print(f"FAIL {failure}")
        raise SystemExit(f"{len(failures)} problem(s) across the question set")

    print("no disagreements between Genie and the baseline" if genie else "baseline established")


if __name__ == "__main__":
    main()
