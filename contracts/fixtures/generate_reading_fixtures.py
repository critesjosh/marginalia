"""Generate the Phase 2 sessionization fixtures.

Each case in CASES is one documented acceptance criterion from the plan's
"Reading sessionization v1" section. Generating them keeps the timestamps
consistent when a rule changes; the generated .jsonl is what tests read.

Run: python3 contracts/fixtures/generate_reading_fixtures.py
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).parent / "reading-sessions-phase-2.jsonl"

BOOK = "sample-genealogy-of-morals"
INSTALL_A = "20000000-0000-4000-8000-000000000001"
INSTALL_B = "20000000-0000-4000-8000-000000000002"
START = datetime(2026, 9, 1, 9, 0, 0, tzinfo=timezone.utc)

# Sessionization rules under test, kept next to the data they produce.
IDLE_GAP_MINUTES = 30
ACTIVE_INTERVAL_CAP_SECONDS = 120


def stamp(minutes: float) -> str:
    return (
        (START + timedelta(minutes=minutes))
        .isoformat()
        .replace("+00:00", "Z")
        .replace(".000000", "")
    )


def event(
    n: int,
    event_type: str,
    minutes: float,
    payload: dict,
    *,
    installation: str = INSTALL_A,
    sequence: int | None = None,
    emitted_minutes: float | None = None,
) -> dict:
    return {
        "schemaVersion": 1,
        "eventId": f"40000000-0000-4000-8000-{n:012d}",
        "installationId": installation,
        "sequence": sequence if sequence is not None else n,
        "source": "pwa",
        "appVersion": "0.0.0+fixture",
        "eventType": event_type,
        "eventTime": stamp(minutes),
        "emittedAt": stamp(emitted_minutes if emitted_minutes is not None else minutes),
        "entities": {"bookId": BOOK},
        # Reading events are metadata only and never carry reader text.
        "privacy": {"consentVersion": 1, "included": []},
        "payload": payload,
    }


def opened(n: int, minutes: float, progress: float, **kw) -> dict:
    return event(
        n, "book_opened", minutes, {"progress": progress, "openedAt": stamp(minutes)}, **kw
    )


def progressed(n: int, minutes: float, progress: float, trigger="progress_delta", **kw) -> dict:
    return event(
        n,
        "reading_progressed",
        minutes,
        {"progress": progress, "observedAt": stamp(minutes), "trigger": trigger},
        **kw,
    )


def closed(n: int, minutes: float, progress: float, reason="explicit", **kw) -> dict:
    return event(
        n,
        "book_closed",
        minutes,
        {"progress": progress, "closedAt": stamp(minutes), "reason": reason},
        **kw,
    )


def build() -> list[dict]:
    events: list[dict] = []

    # Case 1: an explicit close ends the session at book_closed. Adjacent active
    # events are 5 and 10 minutes apart, so every interval is capped at 120s and
    # active seconds are 2 x 120 plus the 60-second close interval = 300,
    # not the 960s of wall clock.
    events += [
        opened(1, 0, 0.10),
        progressed(2, 5, 0.14),
        progressed(3, 15, 0.19),
        closed(4, 16, 0.19),
    ]

    # Case 2: no close, and a gap longer than the idle timeout. The first session
    # ends at its last active event (minute 25), not at the start of the next one.
    events += [
        opened(5, 20, 0.19),
        progressed(6, 25, 0.23),
        progressed(7, 25 + IDLE_GAP_MINUTES + 1, 0.27),
        closed(8, 60, 0.27),
    ]

    # Case 3: backward navigation. Raw progress goes down and stays visible in
    # Silver events, while completion treats progress as monotonic.
    events += [
        opened(9, 120, 0.27),
        progressed(10, 122, 0.31),
        progressed(11, 124, 0.12),
        progressed(12, 126, 0.33),
        closed(13, 128, 0.33),
    ]

    # Case 4: late arrival. The event happened inside case 3's session but was
    # delivered after it, so recomputation has to fold it back into that session
    # rather than opening a new one.
    events.append(progressed(14, 123, 0.32, sequence=14, emitted_minutes=400))

    # Case 5: a clock ahead of delivery. The Silver fixture loader stamps
    # receivedAt from emittedAt, making eventTime more than 24 hours later as
    # specified by the plan; the pipeline must not let it stretch a session.
    events.append(progressed(15, 5000, 0.34, sequence=15, emitted_minutes=130))

    # Case 6: a harmless delivery duplicate. Byte-identical to event 2, so it
    # collapses to one Silver event and never reaches event_conflicts.
    duplicate = dict(events[1])
    events.append(duplicate)

    # Case 7: a divergent duplicate. Same event id, different progress. The first
    # occurrence wins and this one is recorded in event_conflicts.
    divergent = json.loads(json.dumps(events[2]))
    divergent["payload"]["progress"] = 0.99
    events.append(divergent)

    # Case 8: a second installation reading the same book concurrently. Sessions
    # are per installation, so this must not merge with case 3.
    events += [
        opened(16, 121, 0.05, installation=INSTALL_B, sequence=1),
        progressed(17, 125, 0.08, installation=INSTALL_B, sequence=2),
        closed(18, 127, 0.08, installation=INSTALL_B, sequence=3),
    ]

    return events


def main() -> None:
    events = build()
    OUT.write_text("".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events))
    print(f"wrote {len(events)} events to {OUT}")


if __name__ == "__main__":
    main()
