"""Build server-stamped Bronze records for the live Phase 2 acceptance run."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "bronze-phase2.jsonl"
SOURCES = [
    ROOT / "nietzsche-phase-0.jsonl",
    ROOT / "highlight-lifecycle-phase-2.jsonl",
    ROOT / "reading-sessions-phase-2.jsonl",
]
USER_ID = "phase2-fixture-user"


def _one_second_later(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) + timedelta(seconds=1)
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build() -> list[str]:
    events: list[dict] = []
    for source in SOURCES:
        events.extend(json.loads(line) for line in source.read_text().splitlines() if line)

    seen: dict[str, int] = {}
    records: list[str] = []
    for event in events:
        event = json.loads(json.dumps(event))
        event_id = event["eventId"]
        occurrence = seen.get(event_id, 0)
        seen[event_id] = occurrence + 1
        event["userId"] = USER_ID
        event["receivedAt"] = (
            _one_second_later(event["emittedAt"]) if occurrence else event["emittedAt"]
        )
        records.append(json.dumps(event, separators=(",", ":")))

    unknown_version = json.loads(records[0])
    unknown_version["eventId"] = "90000000-0000-4000-8000-000000000001"
    unknown_version["schemaVersion"] = 99
    records.append(json.dumps(unknown_version, separators=(",", ":")))

    unknown_field = json.loads(records[0])
    unknown_field["eventId"] = "90000000-0000-4000-8000-000000000002"
    unknown_field["unexpectedPrivateField"] = "synthetic rejection marker"
    records.append(json.dumps(unknown_field, separators=(",", ":")))
    records.append("not-json")
    return records


def main() -> None:
    records = build()
    OUT.write_text("\n".join(records) + "\n")
    print(f"wrote {len(records)} records to {OUT}")


if __name__ == "__main__":
    main()
