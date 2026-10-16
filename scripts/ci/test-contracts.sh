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
    --volume "$contracts_dir:/work" --workdir /work --entrypoint forge "$image" "$@" \
    --out /ci-runtime/out --cache-path /ci-runtime/cache
}

run_forge build
run_forge test --no-match-path 'test/fork/**' --fuzz-runs 5000
run_forge coverage --no-match-path 'test/fork/**' --report summary --fuzz-runs 5000
