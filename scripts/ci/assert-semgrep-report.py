#!/usr/bin/env python3
"""Fail closed on Semgrep errors and findings except exact source-anchored waivers."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("report")
parser.add_argument("--expect-rule")
parser.add_argument("--minimum-scanned-files", type=int, default=0)
parser.add_argument("--allowlist")
parser.add_argument("--source-root")
parser.add_argument("--sanitized-output")
args = parser.parse_args()


def safe_error(error):
    return {
        "type": error.get("type"),
        "code": error.get("code"),
        "path": error.get("path"),
    }


def write_sanitized(report, results, errors, waivers, output_path, scanned_count):
    if not output_path:
        return
    safe_report = {
        "schema": 1,
        "tool": "Semgrep",
        "status": "passed" if not errors and all(row["waived"] for row in results)
        and all(row["matchedExactlyOnce"] for row in waivers) else "failed",
        "scannedFileCount": scanned_count,
        "results": results,
        "errors": errors,
        "waivers": waivers,
    }
    temporary_path = f"{output_path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as output_file:
        json.dump(safe_report, output_file, indent=2, sort_keys=True)
        output_file.write("\n")
    os.replace(temporary_path, output_path)


try:
    with open(args.report, encoding="utf-8") as report_file:
        report = json.load(report_file)
except (OSError, json.JSONDecodeError) as error:
    print(f"Could not parse Semgrep JSON report: {error}", file=sys.stderr)
    raise SystemExit(2)

raw_results = report.get("results", [])
raw_errors = report.get("errors", [])
paths = report.get("paths", {})
scanned = paths.get("scanned", []) if isinstance(paths, dict) else []
scanned_count = len(scanned)

if args.expect_rule:
    matching = [result for result in raw_results if result.get("check_id") == args.expect_rule]
    if len(matching) != 1:
        print(f"Expected one {args.expect_rule} result in the Semgrep failure-control fixture; found {len(matching)}.", file=sys.stderr)
        raise SystemExit(1)
    print(f"Semgrep failure-control detected {args.expect_rule}.")
    raise SystemExit(0)

allowlist = []
source_root = None
if args.allowlist:
    if not args.source_root:
        print("A source root is required when a Semgrep waiver file is configured.", file=sys.stderr)
        raise SystemExit(2)
    try:
        with open(args.allowlist, encoding="utf-8") as allowlist_file:
            waiver_document = json.load(allowlist_file)
        if waiver_document.get("schema") != 1 or not isinstance(waiver_document.get("waivers"), list):
            raise ValueError("expected schema 1 and a waivers array")
        allowlist = waiver_document["waivers"]
        for waiver in allowlist:
            if not all(waiver.get(field) for field in ("ruleId", "path", "line", "sourceLineSha256", "reason")):
                raise ValueError("each waiver needs ruleId, path, line, sourceLineSha256, and reason")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Could not parse Semgrep waiver file: {error}", file=sys.stderr)
        raise SystemExit(2)
    source_root = Path(args.source_root).resolve(strict=True)

waiver_matches = [[] for _ in allowlist]
sanitized_results = []
unexpected_results = []

for result in raw_results:
    raw_path = result.get("path", "")
    check_id = result.get("check_id", "unknown")
    start = result.get("start", {})
    line_number = start.get("line")
    candidate = Path(raw_path)
    if not candidate.is_absolute() and source_root:
        candidate = source_root / candidate
    try:
        resolved_path = candidate.resolve(strict=True) if source_root else candidate
        if source_root and os.path.commonpath((str(source_root), str(resolved_path))) != str(source_root):
            raise ValueError("path escapes the source root")
        relative_path = resolved_path.relative_to(source_root).as_posix() if source_root else raw_path
        source_line_hash = None
        if source_root and isinstance(line_number, int) and line_number > 0:
            source_lines = resolved_path.read_bytes().splitlines(keepends=True)
            if line_number <= len(source_lines):
                source_line_hash = hashlib.sha256(source_lines[line_number - 1]).hexdigest()
    except (OSError, ValueError):
        relative_path = raw_path
        source_line_hash = None

    matching_waivers = [
        (index, waiver)
        for index, waiver in enumerate(allowlist)
        if waiver.get("ruleId") == check_id
        and waiver.get("path") == relative_path
        and waiver.get("line") == line_number
        and waiver.get("sourceLineSha256") == source_line_hash
    ]
    waived = len(matching_waivers) == 1
    if waived:
        waiver_matches[matching_waivers[0][0]].append(result)
        waiver_reason = matching_waivers[0][1]["reason"]
    else:
        waiver_reason = None
        unexpected_results.append((check_id, relative_path, line_number))

    sanitized_results.append({
        "ruleId": check_id,
        "path": relative_path,
        "line": line_number,
        "endLine": result.get("end", {}).get("line"),
        "severity": result.get("extra", {}).get("severity"),
        "sourceLineSha256": source_line_hash,
        "waived": waived,
        "waiverReason": waiver_reason,
    })

sanitized_errors = [safe_error(error) for error in raw_errors]
sanitized_waivers = []
for index, waiver in enumerate(allowlist):
    matched = len(waiver_matches[index]) == 1
    sanitized_waivers.append({
        "ruleId": waiver["ruleId"],
        "path": waiver["path"],
        "line": waiver["line"],
        "sourceLineSha256": waiver["sourceLineSha256"],
        "reason": waiver["reason"],
        "matchedExactlyOnce": matched,
    })

write_sanitized(report, sanitized_results, sanitized_errors, sanitized_waivers,
                args.sanitized_output, scanned_count)

if args.minimum_scanned_files and scanned_count < args.minimum_scanned_files:
    print(
        f"Semgrep scanned {scanned_count} files; expected at least {args.minimum_scanned_files}.",
        file=sys.stderr,
    )
    raise SystemExit(2)

if raw_errors:
    print(f"Semgrep reported {len(raw_errors)} scan/configuration error(s).", file=sys.stderr)
    for error in sanitized_errors:
        details = ":".join(value for value in (error.get("type"), error.get("code"), error.get("path")) if value)
        print(f"- {details or 'unspecified scan error'}", file=sys.stderr)
    raise SystemExit(2)

if args.allowlist:
    for index, waiver in enumerate(allowlist):
        count = len(waiver_matches[index])
        if count != 1:
            print(
                f"Semgrep waiver for {waiver['ruleId']} at {waiver['path']}:{waiver['line']} "
                f"matched {count} times; expected exactly once.",
                file=sys.stderr,
            )
            raise SystemExit(2)

if unexpected_results:
    print(f"Semgrep found {len(unexpected_results)} unreviewed finding(s):", file=sys.stderr)
    for check_id, relative_path, line_number in unexpected_results:
        print(f"- {check_id} at {relative_path}:{line_number or '?'}", file=sys.stderr)
    raise SystemExit(1)

if sanitized_results:
    print(f"Semgrep passed with {len(sanitized_results)} exact, source-anchored waiver(s).")
else:
    print("Semgrep reported no findings or scan errors.")
