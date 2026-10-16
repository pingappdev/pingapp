#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"
uid="$(id -u)"
gid="$(id -g)"
history_repo="${SECURITY_HISTORY_REPO:-$repo_root}"
filter_tree_to_public_export="${SECURITY_PUBLIC_TREE_FILTER:-0}"
evidence_dir="${CI_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pingapp-audit-ci-evidence}"
gitleaks_image="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
semgrep_image="semgrep/semgrep:1.180.0@sha256:529ee8a277ec8adc5b534d7c74eea0a47e9de21d62852b6ba7ac6ba9566845c3"

if [[ "${#docker_cmd[@]}" -eq 0 ]]; then
  echo 'DOCKER must name a Docker command (for example: sudo docker).' >&2
  exit 2
fi

scratch="$(mktemp -d -t pingapp-ci-scanners.XXXXXX)"
chmod 755 "$scratch"
mkdir -p "$evidence_dir"
trap 'rm -rf "$scratch"' EXIT
scan_tree="$scratch/working-tree"
mkdir -p "$scan_tree"
if [[ "$filter_tree_to_public_export" != 0 && "$filter_tree_to_public_export" != 1 ]]; then
  echo 'SECURITY_PUBLIC_TREE_FILTER must be 0 or 1.' >&2
  exit 2
fi

# CI uses 0 and copies every tracked/unignored file. Set 1 only for local scans
# of the private development checkout; then match docs/public-export/config.json,
# including its path-component exclusions.
while IFS= read -r -d '' relative; do
  if [[ "$filter_tree_to_public_export" == 1 ]]; then
    case "$relative" in
      docs/*|deploy/*) continue ;;
    esac
    IFS=/ read -r -a path_parts <<< "$relative"
    excluded=0
    for part in "${path_parts[@]}"; do
      case "$part" in
        AGENTS.md|.env|.env.*) excluded=1; break ;;
      esac
    done
    [[ "$excluded" == 0 ]] || continue
  fi
  source_path="$repo_root/$relative"
  target_path="$scan_tree/$relative"
  if [[ -f "$source_path" || -L "$source_path" ]]; then
    mkdir -p "$(dirname "$target_path")"
    cp -a -- "$source_path" "$target_path"
  fi
done < <(git -C "$repo_root" ls-files --cached --others --exclude-standard -z)

gitleaks_run() {
  "${docker_cmd[@]}" run --rm --cpus=2 --memory=2g --user "${uid}:${gid}" \
    --env HOME=/tmp --volume "$1:/scan:ro" \
    --volume "$repo_root/.gitleaksignore:/ci/.gitleaksignore:ro" \
    --workdir /scan --entrypoint gitleaks "$gitleaks_image" \
    --gitleaks-ignore-path /ci/.gitleaksignore "${@:2}"
}

run_gitleaks_self_test() {
  local fixture="$scratch/gitleaks-fixture" status
  mkdir -p "$fixture/src" "$fixture/config"
  cat > "$fixture/config/gitleaks.toml" <<'EOF'
title = "CI scanner self-test"
[[rules]]
id = "ci-test-token"
description = "Synthetic marker for the scanner failure control"
regex = '''CI_TEST_SECRET_[0-9a-f]{16}'''
secretGroup = 0
entropy = 0
EOF
  printf '%s\n' 'const marker = "CI_TEST_SECRET_0123456789abcdef";' > "$fixture/src/check.js"
  git -C "$fixture" init --quiet
  git -C "$fixture" config user.email ci@example.invalid
  git -C "$fixture" config user.name ci-scanner-test
  git -C "$fixture" add .
  git -C "$fixture" commit --quiet -m 'test: add synthetic scanner marker'

  if gitleaks_run "$fixture" dir --config /scan/config/gitleaks.toml --redact --no-banner --log-level error /scan; then
    echo 'Gitleaks tree self-test failed to reject its synthetic marker.' >&2
    return 1
  else
    status=$?
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "Gitleaks tree self-test returned unexpected status $status." >&2
    return 1
  fi

  if gitleaks_run "$fixture" git --config /scan/config/gitleaks.toml --redact --no-banner --log-level error \
    --log-opts='--all --full-history' /scan; then
    echo 'Gitleaks history self-test failed to reject its synthetic marker.' >&2
    return 1
  else
    status=$?
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "Gitleaks history self-test returned unexpected status $status." >&2
    return 1
  fi
  echo 'Gitleaks tree and full-history failure controls passed; output is redacted.'
}

run_semgrep_self_test() {
  local fixture="$scratch/semgrep-fixture"
  mkdir -p "$fixture"
  cat > "$fixture/unsafe.js" <<'EOF'
const supplied = process.argv[2];
eval(supplied);
EOF
  if "${docker_cmd[@]}" run --rm --cpus=2 --memory=2g --user "${uid}:${gid}" \
    --env HOME=/tmp --env SEMGREP_SEND_METRICS=off \
    --volume "$repo_root:/repo:ro" \
    --volume "$repo_root/scripts/ci/semgrep-rules.yml:/ci/semgrep-rules.yml:ro" \
    --volume "$fixture:/fixture:ro" --entrypoint sh "$semgrep_image" -euc '
      set +e
      semgrep scan --config /ci/semgrep-rules.yml --metrics=off --disable-version-check \
        --strict --error --json --quiet /fixture > /tmp/semgrep-self-test.json
      status=$?
      set -e
      if [ "$status" -ne 1 ]; then
        echo "Expected the deliberate Semgrep finding to exit 1; got $status." >&2
        exit 1
      fi
      python3 /repo/scripts/ci/assert-semgrep-report.py --expect-rule=ci.pingapp.security.direct-eval \
        /tmp/semgrep-self-test.json
    '; then
    :
  else
    echo 'Semgrep self-test failed to verify its deliberate direct-eval finding.' >&2
    return 1
  fi
  echo 'Semgrep deliberate-failure control passed.'
}

run_gitleaks_self_test
run_semgrep_self_test

echo 'Scanning the public working tree with Gitleaks.'
gitleaks_run "$scan_tree" dir --redact --no-banner --verbose /scan

echo 'Scanning the exporter-selected public history with Gitleaks.'
"${docker_cmd[@]}" run --rm --cpus=2 --memory=2g --user "${uid}:${gid}" \
  --env HOME=/tmp --volume "$history_repo:/repo:ro" \
  --volume "$repo_root/.gitleaksignore:/ci/.gitleaksignore:ro" \
  --workdir /repo --entrypoint gitleaks "$gitleaks_image" \
  --gitleaks-ignore-path /ci/.gitleaksignore git --redact --no-banner --verbose --timeout 300 \
  --log-opts='--all --full-history' /repo

echo 'Scanning first-party source with pinned Semgrep rules.'
"${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" \
  --env HOME=/tmp --env SEMGREP_SEND_METRICS=off \
  --volume "$scan_tree:/scan:ro" \
  --volume "$evidence_dir:/evidence" \
  --volume "$repo_root/scripts/ci/semgrep-rules.yml:/ci/semgrep-rules.yml:ro" \
  --volume "$repo_root/scripts/ci/assert-semgrep-report.py:/ci/assert-semgrep-report.py:ro" \
  --workdir /scan --entrypoint sh "$semgrep_image" -euc '
    rules_dir=/tmp/semgrep-rules
    rules_commit=17e31e11ebac99fb7dfe1cd288f7a32151b6f3f9
    git init --quiet "$rules_dir"
    git -C "$rules_dir" remote add origin https://github.com/semgrep/semgrep-rules.git
    git -C "$rules_dir" fetch --quiet --depth=1 origin "$rules_commit"
    git -C "$rules_dir" checkout --quiet --detach FETCH_HEAD
    actual_commit=$(git -C "$rules_dir" rev-parse HEAD)
    if [ "$actual_commit" != "$rules_commit" ]; then
      echo "Semgrep rules checkout mismatch: $actual_commit" >&2
      exit 2
    fi
    upstream_rule_count=$(find "$rules_dir/javascript/lang" "$rules_dir/typescript/lang" \
      "$rules_dir/javascript/react" "$rules_dir/typescript/react" \
      -type f \( -name "*.yaml" -o -name "*.yml" \) -print | wc -l | tr -d "[:space:]")
    if [ "$upstream_rule_count" -lt 1 ]; then
      echo "Pinned Semgrep rule checkout contains no YAML rule files." >&2
      exit 2
    fi
    echo "Semgrep loaded source directories at $actual_commit ($upstream_rule_count YAML rule files)."
    set +e
    semgrep scan --config "$rules_dir/javascript/lang" --config "$rules_dir/typescript/lang" \
      --config "$rules_dir/javascript/react" --config "$rules_dir/typescript/react" \
      --config /ci/semgrep-rules.yml \
      --metrics=off --disable-version-check --strict --error --jobs=2 --timeout=10 --json --quiet \
      --exclude node_modules --exclude contracts/lib --exclude contracts/out \
      --exclude contracts/cache --exclude dist --exclude coverage --exclude .playwright-cli \
      /scan > /evidence/semgrep-report.json
    status=$?
    set -e
    python3 /ci/assert-semgrep-report.py --minimum-scanned-files=1 \
      /evidence/semgrep-report.json
    exit "$status"
  '

echo 'Gitleaks and Semgrep gates passed.'
