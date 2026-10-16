#!/usr/bin/env python3
"""Fail on unreviewed medium-or-higher Slither findings and stale waivers."""

import argparse
import json
import sys
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("report")
parser.add_argument("allowlist")
parser.add_argument("--repo-root", required=True)
args = parser.parse_args()

try:
    with open(args.report, encoding="utf-8") as report_file:
        report = json.load(report_file)
    with open(args.allowlist, encoding="utf-8") as allowlist_file:
        allowlist = json.load(allowlist_file)
except (OSError, json.JSONDecodeError) as error:
    print(f"Could not read Slither report or allowlist: {error}", file=sys.stderr)
    raise SystemExit(2)

if report.get("success") is not True or report.get("error"):
    print("Slither report is incomplete or reports a compilation/analysis error.", file=sys.stderr)
    raise SystemExit(2)
if allowlist.get("schema") != 1 or not isinstance(allowlist.get("findings"), list):
    print("Slither allowlist schema is invalid.", file=sys.stderr)
    raise SystemExit(2)

detectors = report.get("results", {}).get("detectors", [])
if not isinstance(detectors, list):
    print("Slither report has no detector list.", file=sys.stderr)
    raise SystemExit(2)

def finding_identity(detector):
    elements = detector.get("elements", [])
    primary = elements[0] if elements else {}
    source = primary.get("source_mapping", {})
    return {
        "id": detector.get("id"),
        "check": detector.get("check"),
        "impact": detector.get("impact"),
        "file": source.get("filename_relative"),
        "function": primary.get("name"),
    }


waivers = {}
for waiver in allowlist["findings"]:
    waiver_id = waiver.get("id")
    if not isinstance(waiver_id, str) or waiver_id in waivers:
        print("Slither allowlist contains a missing or duplicate finding ID.", file=sys.stderr)
        raise SystemExit(2)
    waivers[waiver_id] = waiver
    if not waiver.get("reason") or not waiver.get("evidence"):
        print(f"Slither waiver {waiver_id} is missing a reason or evidence.", file=sys.stderr)
        raise SystemExit(2)
    for evidence in waiver["evidence"]:
        path = Path(args.repo_root, evidence.get("path", ""))
        needle = evidence.get("contains")
        try:
            source = path.read_text(encoding="utf-8")
        except OSError:
            print(f"Slither waiver evidence file is missing: {evidence.get('path')}", file=sys.stderr)
            raise SystemExit(2)
        if not isinstance(needle, str) or needle not in source:
            print(f"Slither waiver evidence anchor is missing: {evidence.get('path')}", file=sys.stderr)
            raise SystemExit(2)

seen_waivers = set()
unexpected = []
for detector in detectors:
    identity = finding_identity(detector)
    impact = identity["impact"]
    waiver = waivers.get(identity["id"])
    if waiver:
        expected = {key: waiver.get(key) for key in ("id", "check", "impact", "file", "function")}
        if identity != expected:
            print(f"Slither waiver no longer matches detector metadata: {identity}", file=sys.stderr)
            raise SystemExit(1)
        if identity["id"] in seen_waivers:
            print(f"Slither waiver matched more than once: {identity['id']}", file=sys.stderr)
            raise SystemExit(1)
        seen_waivers.add(identity["id"])
        continue
    if impact in {"Critical", "High", "Medium"}:
        unexpected.append(identity)

stale_waivers = sorted(set(waivers) - seen_waivers)
if stale_waivers:
    print(f"Slither allowlist contains {len(stale_waivers)} stale reviewed finding(s).", file=sys.stderr)
    raise SystemExit(1)

if unexpected:
    print(f"Slither found {len(unexpected)} unreviewed medium-or-higher finding(s):", file=sys.stderr)
    for identity in unexpected:
        print(
            f"- {identity['impact']} {identity['check']} at "
            f"{identity['file']}:{identity['function']} (id {identity['id']})",
            file=sys.stderr,
        )
    raise SystemExit(1)

for waiver in allowlist["findings"]:
    print(f"Slither reviewed exception: {waiver['impact']} {waiver['check']} at {waiver['file']}:{waiver['function']}.")
print("Slither reported no unreviewed medium-or-higher findings.")
