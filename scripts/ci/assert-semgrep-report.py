#!/usr/bin/env python3
"""Fail closed on Semgrep findings/errors without printing matched source text."""

import argparse
import json
import sys

parser = argparse.ArgumentParser()
parser.add_argument("report")
parser.add_argument("--expect-rule")
parser.add_argument("--minimum-scanned-files", type=int, default=0)
args = parser.parse_args()

try:
    with open(args.report, encoding="utf-8") as report_file:
        report = json.load(report_file)
except (OSError, json.JSONDecodeError) as error:
    print(f"Could not parse Semgrep JSON report: {error}", file=sys.stderr)
    raise SystemExit(2)

errors = report.get("errors", [])
results = report.get("results", [])
if errors:
    print(f"Semgrep reported {len(errors)} scan/configuration error(s).", file=sys.stderr)
    for error in errors:
        details = ":".join(
            value for value in (error.get("type"), error.get("code"), error.get("path"))
            if isinstance(value, str) and value
        )
        print(f"- {details or 'unspecified scan error'}", file=sys.stderr)
    raise SystemExit(2)

paths = report.get("paths", {})
scanned = paths.get("scanned", []) if isinstance(paths, dict) else []
if args.minimum_scanned_files and len(scanned) < args.minimum_scanned_files:
    print(
        f"Semgrep scanned {len(scanned)} files; expected at least {args.minimum_scanned_files}.",
        file=sys.stderr,
    )
    raise SystemExit(2)

if args.expect_rule:
    matching = [result for result in results if result.get("check_id") == args.expect_rule]
    if len(matching) != 1:
        print(f"Expected one {args.expect_rule} result in the Semgrep failure-control fixture; found {len(matching)}.", file=sys.stderr)
        raise SystemExit(1)
    print(f"Semgrep failure-control detected {args.expect_rule}.")
    raise SystemExit(0)

if results:
    print(f"Semgrep found {len(results)} actionable finding(s):", file=sys.stderr)
    for result in results:
        location = result.get("start", {})
        print(
            f"- {result.get('check_id', 'unknown')} at {result.get('path', 'unknown')}:{location.get('line', '?')}",
            file=sys.stderr,
        )
    raise SystemExit(1)

print("Semgrep reported no findings or scan errors.")
