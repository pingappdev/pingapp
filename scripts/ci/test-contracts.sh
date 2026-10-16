#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contracts_dir="$repo_root/contracts"
image="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e}"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"
uid="$(id -u)"
gid="$(id -g)"
require_ci_profile="${REQUIRE_CI_PROFILE:-0}"

if grep -Eq '^\[profile\.ci(\..*)?\]$' "$contracts_dir/foundry.toml"; then
  profile=ci
elif [[ "$require_ci_profile" == 1 ]]; then
  echo 'The CI workflow requires a [profile.ci] configuration in contracts/foundry.toml.' >&2
  exit 1
else
  profile=default
  echo 'No [profile.ci] found yet; using explicit deep fuzz flags and the current default invariant profile.' >&2
fi

if [[ ! -f "$contracts_dir/foundry.toml" ]]; then
  echo "Foundry project not found: $contracts_dir/foundry.toml" >&2
  exit 2
fi

run_forge() {
  "${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" --env HOME=/tmp \
    --env NO_COLOR=1 --env "FOUNDRY_PROFILE=$profile" \
    --volume "$contracts_dir:/work" --workdir /work --entrypoint forge "$image" "$@"
}

run_forge build
run_forge test --no-match-path 'test/fork/**' --fuzz-runs 5000
run_forge coverage --no-match-path 'test/fork/**' --report summary --fuzz-runs 5000
