#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contracts_dir="$repo_root/contracts"
foundry_image="ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e"
slither_image="ghcr.io/crytic/slither:0.11.6@sha256:89d4127ec3bfeba9725a863c58dd96b01781ff73737871dd3b07606ebc4cf16b"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"
uid="$(id -u)"
gid="$(id -g)"
evidence_dir="${CI_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pingapp-audit-ci-evidence}"
mkdir -p "$evidence_dir"

if [[ "${#docker_cmd[@]}" -eq 0 ]]; then
  echo 'DOCKER must name a Docker command (for example: sudo docker).' >&2
  exit 2
fi

runtime="$(mktemp -d -t pingapp-ci-slither.XXXXXX)"
chmod 755 "$runtime"
mkdir -p "$runtime/bin"
contracts_copy="$runtime/contracts"
mkdir -p "$contracts_copy"
while IFS= read -r -d '' relative; do
  source_file="$repo_root/$relative"
  destination="$contracts_copy/${relative#contracts/}"
  if [[ -f "$source_file" || -L "$source_file" ]]; then
    mkdir -p "$(dirname "$destination")"
    cp -a -- "$source_file" "$destination"
  fi
done < <(git -C "$repo_root" ls-files --cached --others --exclude-standard -z -- contracts)
trap 'rm -rf "$runtime"' EXIT

"${docker_cmd[@]}" run --rm --cpus=1 --memory=1g --user "${uid}:${gid}" \
  --volume "$repo_root:/repo:ro" --entrypoint python3 "$slither_image" \
  /repo/scripts/ci/test-slither-checker.py

"${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" \
  --env HOME=/ci-runtime --volume "$runtime:/ci-runtime" \
  --volume "$contracts_copy:/work" --workdir /work \
  --entrypoint forge "$foundry_image" build

"${docker_cmd[@]}" run --rm --cpus=1 --memory=1g --user "${uid}:${gid}" \
  --volume "$runtime:/ci-runtime" --entrypoint sh "$foundry_image" -euc \
  'cp /usr/local/bin/forge /ci-runtime/bin/forge'
ln -sf ../.svm/0.8.28/solc-0.8.28 "$runtime/bin/solc"
if [[ ! -x "$runtime/bin/forge" || ! -x "$runtime/bin/solc" ]]; then
  echo 'Pinned Foundry forge and Solidity 0.8.28 compiler are required for Slither.' >&2
  exit 2
fi

"${docker_cmd[@]}" run --rm --cpus=2 --memory=5g --user "${uid}:${gid}" \
  --env HOME=/ci-runtime \
  --env PATH=/ci-runtime/bin:/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --volume "$runtime:/ci-runtime" --volume "$repo_root:/repo:ro" \
  --volume "$evidence_dir:/evidence" \
  --volume "$contracts_copy:/work" --workdir /work \
  --entrypoint sh "$slither_image" -euc '
    set +e
    slither . --filter-paths "lib/|test/|script/" --fail-none --json /evidence/slither.json
    slither_status=$?
    set -e
    python3 /repo/scripts/ci/assert-slither-findings.py /evidence/slither.json \
      /repo/scripts/ci/slither-allowlist.json --repo-root /repo
    checker_status=$?
    if [ "$slither_status" -ne 0 ]; then exit "$slither_status"; fi
    exit "$checker_status"
  '
