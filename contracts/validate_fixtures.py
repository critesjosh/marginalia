#!/usr/bin/env python3
"""Validate Marginalia v1 events with the language-neutral JSON Schemas."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
EVENT_ROOT = ROOT / "events" / "v1"


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


ENVELOPE = Draft202012Validator(
    load(EVENT_ROOT / "envelope.schema.json"), format_checker=FormatChecker()
)
# Derived from the manifest, not retyped. Three registries listed these by hand
# and two of them had already drifted.
PAYLOADS = load(EVENT_ROOT / "payloads.json")["payloads"]

PAYLOAD_VALIDATORS = {
    event_type: Draft202012Validator(
        load(EVENT_ROOT / "payloads" / filename), format_checker=FormatChecker()
    )
    for event_type, filename in PAYLOADS.items()
}


def valid_event(event: Any) -> bool:
    if not ENVELOPE.is_valid(event):
        return False
    validator = PAYLOAD_VALIDATORS.get(event["eventType"])
    return validator is not None and validator.is_valid(event["payload"])


def main() -> int:
    values = json.load(sys.stdin)
    json.dump([valid_event(value) for value in values], sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
