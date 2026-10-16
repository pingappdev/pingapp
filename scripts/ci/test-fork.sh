#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contracts_dir="$repo_root/contracts"
source "$repo_root/scripts/ci/assert-ci-profile.sh"
foundry_image="ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e"
docker_spec="${DOCKER:-docker}"
fork_block=90041662
fork_rpc_url="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
read -r -a docker_cmd <<< "$docker_spec"

if [[ ! "$fork_rpc_url" =~ ^https:// ]]; then
  echo 'ROBINHOOD_RPC_URL must be an HTTPS RPC URL when provided.' >&2
  exit 2
fi
if [[ "${#docker_cmd[@]}" -eq 0 ]]; then
  echo 'DOCKER must name a Docker command (for example: docker).' >&2
  exit 2
fi
if [[ ! -f "$contracts_dir/test/fork/PingRouterFork.t.sol" ]]; then
  echo 'Required mainnet fork test file is missing: contracts/test/fork/PingRouterFork.t.sol.' >&2
  exit 2
fi
assert_ci_invariant_profile "$contracts_dir/foundry.toml"

export ROBINHOOD_RPC_URL="$fork_rpc_url"
evidence_dir="${CI_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pingapp-audit-ci-evidence}"
mkdir -p "$evidence_dir"
runtime="$(mktemp -d -t pingapp-ci-fork.XXXXXX)"
raw_output="$runtime/fork-test.raw.log"
safe_output="$evidence_dir/fork-test.log"
summary="$evidence_dir/fork-test.json"
chmod 755 "$runtime"
trap 'rm -rf -- "$runtime"' EXIT
uid="$(id -u)"
gid="$(id -g)"

echo "Running the focused mainnet fork suite at block $fork_block."
if "${docker_cmd[@]}" run --rm --cpus=2 --memory=5g --user "${uid}:${gid}" \
  --env HOME=/ci-runtime --env FOUNDRY_PROFILE=ci --env FORK_BLOCK="$fork_block" \
  --env NO_COLOR=1 --env "ROBINHOOD_RPC_URL=$fork_rpc_url" --volume "$runtime:/ci-runtime" \
  --volume "$contracts_dir:/work" --workdir /work \
  --entrypoint sh "$foundry_image" -euc \
  'forge build --out /ci-runtime/contracts-out --cache-path /ci-runtime/contracts-cache \
    && forge test --match-path test/fork/PingRouterFork.t.sol \
      --out /ci-runtime/contracts-out --cache-path /ci-runtime/contracts-cache' \
  >"$raw_output" 2>&1; then
  :
else
  status=$?
  perl -pe 's/\Q$ENV{ROBINHOOD_RPC_URL}\E/[REDACTED_RPC_URL]/g' "$raw_output" >"$safe_output"
  cat "$safe_output"
  printf '{"schema":1,"gate":"mainnet-fork","status":"failed","forkBlock":%s,"scope":"network-specific token behavior; CRM send/escrow may cleanly revert","source":"%s"}\n' \
    "$fork_block" "${GITHUB_SHA:-unknown}" >"$summary"
  exit "$status"
fi

perl -pe 's/\Q$ENV{ROBINHOOD_RPC_URL}\E/[REDACTED_RPC_URL]/g' "$raw_output" >"$safe_output"
cat "$safe_output"
if ! grep -Fq 'Ran 4 tests for test/fork/PingRouterFork.t.sol:PingRouterForkTest' "$safe_output" \
  || ! grep -Eq '^Suite result: ok\. 4 passed; 0 failed; 0 skipped; finished in ' "$safe_output"; then
  echo 'Fork suite did not report exactly four passing tests and zero failures/skips.' >&2
  printf '{"schema":1,"gate":"mainnet-fork","status":"failed","forkBlock":%s,"scope":"network-specific token behavior; CRM send/escrow may cleanly revert","source":"%s"}\n' \
    "$fork_block" "${GITHUB_SHA:-unknown}" >"$summary"
  exit 1
fi
printf '{"schema":1,"gate":"mainnet-fork","status":"passed","forkBlock":%s,"suite":"PingRouterForkTest","scope":"network-specific token behavior; CRM send/escrow may cleanly revert","passed":4,"failed":0,"skipped":0,"source":"%s"}\n' \
  "$fork_block" "${GITHUB_SHA:-unknown}" >"$summary"
echo 'Token compatibility is network-specific: the pinned CRM path may cleanly revert and does not imply universal transfer compatibility.'
echo "Mainnet fork suite passed; structured result saved to $summary."
