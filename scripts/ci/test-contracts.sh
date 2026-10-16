#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contracts_dir="$repo_root/contracts"
source "$repo_root/scripts/ci/assert-ci-profile.sh"
image="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e}"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"
uid="$(id -u)"
gid="$(id -g)"
runtime="$(mktemp -d -t pingapp-ci-contracts.XXXXXX)"
chmod 755 "$runtime"
if [[ -n "${CI_EVIDENCE_DIR:-}" ]]; then
  evidence_dir="$CI_EVIDENCE_DIR"
else
  evidence_dir="$(mktemp -d -t pingapp-ci-contracts-evidence.XXXXXX)"
fi
mkdir -p "$evidence_dir"
export CI_EVIDENCE_DIR="$evidence_dir"
metrics_path="$evidence_dir/invariant-sequences.jsonl"
campaign_seed="${AUD08_CAMPAIGN_SEED:-11587915885060689942}"
metrics_container_path=/ci-runtime/evidence/invariant-sequences.jsonl
: > "$metrics_path"
rm -f -- "$metrics_path".*.seen
trap 'rm -rf -- "$runtime"' EXIT

if [[ ! -f "$contracts_dir/foundry.toml" ]]; then
  echo "Foundry project not found: $contracts_dir/foundry.toml" >&2
  exit 2
fi
assert_ci_invariant_profile "$contracts_dir/foundry.toml"
profile=ci

run_forge() {
  "${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" --env HOME=/ci-runtime \
    --env NO_COLOR=1 --env "FOUNDRY_PROFILE=$profile" --volume "$runtime:/ci-runtime" \
    --env AUD08_CAMPAIGN_RUNS=1024 --env AUD08_CAMPAIGN_DEPTH=128 \
    --env "AUD08_CAMPAIGN_SEED=$campaign_seed" --env "AUD08_METRICS_PATH=$metrics_container_path" \
    --volume "$evidence_dir:/ci-runtime/evidence" \
    --volume "$contracts_dir:/work" --workdir /work --entrypoint forge "$image" "$@" \
    --out /ci-runtime/out --cache-path /ci-runtime/cache
}

run_forge build
python3 -B "$repo_root/scripts/ci/test-invariant-campaign-validator.py"
run_forge test --no-match-path 'test/fork/**' --fuzz-runs 5000 --fuzz-seed "$campaign_seed" 2>&1 \
  | tee "$evidence_dir/foundry-test.log"
python3 -B "$repo_root/scripts/ci/assert-invariant-campaign.py" "$metrics_path" \
  --foundry-log "$evidence_dir/foundry-test.log" --seed "$campaign_seed" \
  --runs 1024 --depth 128 --minimum-router-transitions 131072
metrics_container_path=""
run_forge coverage --no-match-path 'test/fork/**' --report summary --fuzz-runs 5000 --fuzz-seed "$campaign_seed" 2>&1 \
  | tee "$evidence_dir/coverage.log"
python3 -B "$repo_root/scripts/ci/run-contract-mutations.py"
printf 'AUD-08 evidence retained at %s\n' "$evidence_dir"
