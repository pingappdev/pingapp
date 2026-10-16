#!/usr/bin/env python3
"""Validate durable per-sequence metrics from the AUD-08 Foundry run."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


PROPERTIES = {
    "invariantFinalizedIdsNeverReappear",
    "invariantNativeSolvent",
    "invariantTokensSolvent",
}
ROUTER_ACTIONS = ("send", "escrow", "claim", "refund", "withdrawFees", "withdrawOwed")
ALL_ACTIONS = (*ROUTER_ACTIONS, "warp")


class GateFailure(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateFailure(message)


def validate(
    path: Path,
    foundry_log: Path,
    seed: str,
    runs: int,
    depth: int,
    minimum_transitions: int,
    minimum_selector_successes: int = 1_000,
) -> dict[str, Any]:
    require(path.is_file(), f"missing invariant sequence evidence: {path}")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GateFailure(f"cannot read invariant sequence evidence: {exc}") from exc
    require(bool(lines), "invariant sequence evidence is empty")

    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise GateFailure(f"malformed JSON at line {line_number}") from exc
        require(isinstance(row, dict), f"line {line_number} is not a JSON object")
        rows.append(row)

    expected_rows = runs * len(PROPERTIES)
    require(len(rows) == expected_rows, f"expected {expected_rows} distinct sequence rows, got {len(rows)}")
    counts = Counter(row.get("property") for row in rows)
    require(set(counts) == PROPERTIES, f"unexpected invariant property set: {sorted(counts)}")
    require(all(counts[name] == runs for name in PROPERTIES), f"each invariant must record exactly {runs} sequences")

    ids: set[tuple[str, str]] = set()
    totals = Counter()
    selector_successes = Counter()
    per_property = {name: Counter() for name in PROPERTIES}
    for index, row in enumerate(rows, start=1):
        property_name = row["property"]
        sequence_id = row.get("sequenceId")
        require(isinstance(sequence_id, str) and sequence_id.startswith("0x") and len(sequence_id) == 66,
                f"row {index} has no 32-byte sequence identity")
        identity = (property_name, sequence_id)
        require(identity not in ids, f"duplicate sequence identity at row {index}")
        ids.add(identity)
        require(str(row.get("seed")) == seed, f"row {index} used a different seed")
        require(row.get("runs") == runs and row.get("depth") == depth, f"row {index} profile differs from requested campaign")
        require(row.get("calls") == depth, f"row {index} is a partial sequence")
        require(row.get("unexpectedReverts") == 0, f"row {index} contains an unexpected router revert")

        actions = row.get("actions")
        require(isinstance(actions, dict) and set(actions) == set(ALL_ACTIONS), f"row {index} has incomplete action counters")
        for action_name, action in actions.items():
            require(isinstance(action, dict), f"row {index} action {action_name} is not an object")
            action_calls = action.get("calls")
            successes = action.get("successes")
            no_ops = action.get("noOps")
            require(all(isinstance(value, int) and value >= 0 for value in (action_calls, successes, no_ops)),
                    f"row {index} action {action_name} has invalid counters")
            require(successes + no_ops == action_calls, f"row {index} action {action_name} accounting mismatch")
            totals[f"{action_name}.calls"] += action_calls
            totals[f"{action_name}.successes"] += successes
            totals[f"{action_name}.noOps"] += no_ops
            per_property[property_name][f"{action_name}.successes"] += successes
            if action_name in ROUTER_ACTIONS:
                selector_successes[action_name] += successes

        require(sum(actions[name]["calls"] for name in ALL_ACTIONS) == depth,
                f"row {index} selector calls do not add up to depth")
        require(row.get("noOps") == sum(actions[name]["noOps"] for name in ALL_ACTIONS),
                f"row {index} aggregate no-op count mismatches selector counters")
        router_transitions = sum(actions[name]["successes"] for name in ROUTER_ACTIONS)
        require(row.get("routerTransitions") == router_transitions,
                f"row {index} router transition count includes non-router actions or is inconsistent")
        router_attempts = row.get("routerCallAttempts")
        require(isinstance(router_attempts, int) and router_attempts == router_transitions,
                f"row {index} router attempts differ from successful transitions with zero reverts")
        require(router_attempts + row["noOps"] + actions["warp"]["successes"] == depth,
                f"row {index} separates warp/no-op/router accounting incorrectly")
        totals["routerTransitions"] += router_transitions
        totals["routerCallAttempts"] += router_attempts
        totals["noOps"] += row["noOps"]
        totals["warps"] += actions["warp"]["successes"]
        totals["unexpectedReverts"] += row["unexpectedReverts"]

    require(len(ids) == expected_rows, "sequence identities are not unique within property campaigns")

    try:
        log_text = foundry_log.read_text(encoding="utf-8")
    except OSError as exc:
        raise GateFailure(f"cannot read Foundry test log: {exc}") from exc
    for property_name in PROPERTIES:
        matches = re.findall(
            rf"\[PASS\] {re.escape(property_name)}\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)",
            log_text,
        )
        require(len(matches) == 1, f"Foundry log must show one independent campaign for {property_name}")
        actual_runs, actual_calls, actual_reverts = map(int, matches[0])
        require(actual_runs == runs and actual_calls == runs * depth and actual_reverts == 0,
                f"Foundry log reports incomplete or failing campaign for {property_name}")
    require(totals["routerTransitions"] >= minimum_transitions,
            f"only {totals['routerTransitions']} successful router transitions; require at least {minimum_transitions}")
    minimum_per_selector = {
        selector: minimum_selector_successes for selector in ROUTER_ACTIONS
    }
    for selector, minimum in minimum_per_selector.items():
        require(selector_successes[selector] >= minimum,
                f"only {selector_successes[selector]} successful {selector} transitions; require {minimum}")

    return {
        "requestedFuzzSeed": seed,
        "traceReplayability": "not established; same-seed single-thread campaigns produced different sequence JSONL hashes",
        "aggregationScope": "three independently executed invariant property campaigns",
        "runsPerInvariant": runs,
        "depth": depth,
        "recordedPropertySequenceIdentities": len(ids),
        "rawHandlerCalls": sum(totals[f"{action}.calls"] for action in ALL_ACTIONS),
        "properties": {name: {"sequences": counts[name], **per_property[name]} for name in sorted(PROPERTIES)},
        "routerTransitions": totals["routerTransitions"],
        "routerCallAttempts": totals["routerCallAttempts"],
        "noOps": totals["noOps"],
        "warps": totals["warps"],
        "unexpectedReverts": totals["unexpectedReverts"],
        "successfulTransitionsBySelector": dict(sorted(selector_successes.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("metrics", type=Path)
    parser.add_argument("--foundry-log", required=True, type=Path)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--runs", type=int, required=True)
    parser.add_argument("--depth", type=int, required=True)
    parser.add_argument("--minimum-router-transitions", type=int, required=True)
    args = parser.parse_args()
    try:
        summary = validate(
            args.metrics,
            args.foundry_log,
            args.seed,
            args.runs,
            args.depth,
            args.minimum_router_transitions,
        )
    except GateFailure as exc:
        print(f"AUD-08 invariant campaign gate failed: {exc}", file=sys.stderr)
        return 1
    summary_path = args.metrics.with_name("invariant-campaign-summary.json")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
