#!/usr/bin/env python3
"""Exercise the invariant evidence gate against valid and intentionally bad fixtures."""

from __future__ import annotations

import json
import importlib.util
import tempfile
from pathlib import Path

validator_path = Path(__file__).with_name("assert-invariant-campaign.py")
validator_spec = importlib.util.spec_from_file_location("assert_invariant_campaign", validator_path)
assert validator_spec is not None and validator_spec.loader is not None
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)
GateFailure = validator.GateFailure
PROPERTIES = validator.PROPERTIES
validate = validator.validate


def fixture_rows() -> list[dict[str, object]]:
    rows = []
    sequence = 1
    for property_name in sorted(PROPERTIES):
        for _ in range(2):
            actions = {
                name: {"calls": 1, "successes": 1, "noOps": 0}
                for name in ("send", "escrow", "claim", "refund", "withdrawFees", "withdrawOwed", "warp")
            }
            rows.append(
                {
                    "property": property_name,
                    "sequenceId": f"0x{sequence:064x}",
                    "seed": "7",
                    "runs": 2,
                    "depth": 7,
                    "calls": 7,
                    "routerCallAttempts": 6,
                    "routerTransitions": 6,
                    "noOps": 0,
                    "unexpectedReverts": 0,
                    "actions": actions,
                }
            )
            sequence += 1
    return rows


def write_case(root: Path, rows: list[dict[str, object]], log: str) -> tuple[Path, Path]:
    metrics = root / "metrics.jsonl"
    foundry_log = root / "foundry.log"
    metrics.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    foundry_log.write_text(log, encoding="utf-8")
    return metrics, foundry_log


def expect_failure(label: str, call) -> None:
    try:
        call()
    except GateFailure:
        return
    raise AssertionError(f"validator incorrectly accepted {label}")


def main() -> None:
    log = "\n".join(
        f"[PASS] {name}() (runs: 2, calls: 14, reverts: 0)" for name in sorted(PROPERTIES)
    )
    with tempfile.TemporaryDirectory(prefix="aud08-validator-") as temp:
        root = Path(temp)
        metrics, foundry_log = write_case(root, fixture_rows(), log)
        summary = validate(metrics, foundry_log, "7", 2, 7, 36, minimum_selector_successes=1)
        assert summary["recordedPropertySequenceIdentities"] == 6
        assert summary["rawHandlerCalls"] == 42
        assert summary["routerTransitions"] == 36

        valid_rows = fixture_rows()
        expect_failure(
            "an incomplete campaign",
            lambda: validate(
                write_case(root, valid_rows[:-1], log)[0], foundry_log, "7", 2, 7, 36,
                minimum_selector_successes=1,
            ),
        )

        duplicate_rows = fixture_rows()
        duplicate_rows[1]["sequenceId"] = duplicate_rows[0]["sequenceId"]
        duplicate_metrics, duplicate_log = write_case(root, duplicate_rows, log)
        expect_failure(
            "a repeated sequence identity",
            lambda: validate(duplicate_metrics, duplicate_log, "7", 2, 7, 36, minimum_selector_successes=1),
        )

        malformed_rows = fixture_rows()
        malformed_rows[0]["actions"]["warp"]["successes"] = 2
        malformed_metrics, malformed_log = write_case(root, malformed_rows, log)
        expect_failure(
            "invalid warp accounting",
            lambda: validate(malformed_metrics, malformed_log, "7", 2, 7, 36, minimum_selector_successes=1),
        )

        partial_log = root / "partial.log"
        partial_log.write_text("[PASS] invariantNativeSolvent() (runs: 2, calls: 14, reverts: 0)\n", encoding="utf-8")
        valid_metrics, _ = write_case(root, fixture_rows(), log)
        expect_failure(
            "a missing invariant campaign",
            lambda: validate(valid_metrics, partial_log, "7", 2, 7, 36, minimum_selector_successes=1),
        )

    print("AUD-08 invariant validator controls passed: incomplete, duplicate, accounting, and missing-campaign inputs fail.")


if __name__ == "__main__":
    main()
