#!/usr/bin/env python3
"""Prove the Slither gate rejects new high findings and stale waivers."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path


checker = Path(__file__).with_name("assert-slither-findings.py")


def run_checker(root: Path, report: dict, allowlist: dict) -> subprocess.CompletedProcess[str]:
    report_path = root / "report.json"
    allowlist_path = root / "allowlist.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    allowlist_path.write_text(json.dumps(allowlist), encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(checker),
            str(report_path),
            str(allowlist_path),
            "--repo-root",
            str(root),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


with tempfile.TemporaryDirectory(prefix="pingapp-slither-gate-test-") as temp:
    root = Path(temp)
    (root / "src").mkdir()
    (root / "src/Probe.sol").write_text("function reviewedAnchor() {}\n", encoding="utf-8")

    unreviewed_report = {
        "success": True,
        "results": {
            "detectors": [
                {
                    "id": "synthetic-unreviewed-high",
                    "check": "arbitrary-send-eth",
                    "impact": "High",
                    "elements": [
                        {
                            "name": "sendFunds",
                            "source_mapping": {"filename_relative": "src/Probe.sol"},
                        }
                    ],
                }
            ]
        },
    }
    empty_allowlist = {"schema": 1, "findings": []}
    unreviewed = run_checker(root, unreviewed_report, empty_allowlist)
    if unreviewed.returncode != 1 or "unreviewed" not in unreviewed.stderr:
        print("Slither gate accepted its deliberate unreviewed High finding.", file=sys.stderr)
        raise SystemExit(1)

    clean_report = {"success": True, "results": {"detectors": []}}
    stale_allowlist = {
        "schema": 1,
        "findings": [
            {
                "id": "synthetic-stale-waiver",
                "check": "arbitrary-send-eth",
                "impact": "High",
                "file": "src/Probe.sol",
                "function": "sendFunds",
                "reason": "Synthetic stale-waiver failure control.",
                "evidence": [
                    {"path": "src/Probe.sol", "contains": "function reviewedAnchor()"}
                ],
            }
        ],
    }
    stale = run_checker(root, clean_report, stale_allowlist)
    if stale.returncode != 1 or "stale reviewed finding" not in stale.stderr:
        print("Slither gate accepted its deliberate stale waiver.", file=sys.stderr)
        raise SystemExit(1)

print("Slither new-finding and stale-waiver failure controls passed.")
