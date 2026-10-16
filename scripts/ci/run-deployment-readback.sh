#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contracts_dir="$repo_root/contracts"
node_image="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
foundry_image="ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"

if [[ ! -f "$repo_root/tooling/scripts/deployment/post-deploy-check.mjs" \
  || ! -f "$repo_root/tooling/scripts/deployment/rebuild-proof.mjs" ]]; then
  echo 'Required read-only deployment proof scripts are missing.' >&2
  exit 2
fi
if [[ "${#docker_cmd[@]}" -eq 0 ]]; then
  echo 'DOCKER must name a Docker command (for example: docker).' >&2
  exit 2
fi

evidence_dir="${CI_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pingapp-audit-ci-evidence}"
mkdir -p "$evidence_dir"
runtime="$(mktemp -d -t pingapp-ci-readback.XXXXXX)"
chmod 755 "$runtime"
mkdir -p "$runtime/bin"
trap 'rm -rf -- "$runtime"' EXIT
uid="$(id -u)"
gid="$(id -g)"

echo 'Preparing the pinned Solidity 0.8.28 compiler in an isolated Foundry cache.'
"${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" \
  --env HOME=/ci-runtime --volume "$runtime:/ci-runtime" \
  --volume "$contracts_dir:/work" --workdir /work \
  --entrypoint forge "$foundry_image" build --out /ci-runtime/contracts-out --cache-path /ci-runtime/contracts-cache
ln -sf ../.svm/0.8.28/solc-0.8.28 "$runtime/bin/solc"
if [[ ! -x "$runtime/bin/solc" ]]; then
  echo 'Pinned Solidity 0.8.28 compiler is required for the read-only deployment proof.' >&2
  exit 2
fi

"${docker_cmd[@]}" run --rm --cpus=2 --memory=3g --user "${uid}:${gid}" \
  --env HOME=/tmp --env PATH=/ci-runtime/bin:/usr/local/bin:/usr/bin:/bin \
  --volume "$runtime:/ci-runtime:ro" --volume "$repo_root:/repo" \
  --volume "$evidence_dir:/evidence" --workdir /repo \
  --entrypoint sh "$node_image" -euc '
    test "$(node --version)" = "v24.21.0"
    solc --version | grep -Fq "Version: 0.8.28+commit.7893614a"
    npm ci
    if node tooling/scripts/deployment/rebuild-proof.mjs \
      > /evidence/deployment-rebuild-proof.json 2> /evidence/deployment-rebuild-proof.stderr; then :; else
      status=$?
      cat /evidence/deployment-rebuild-proof.stderr >&2
      exit "$status"
    fi
    if node tooling/scripts/deployment/post-deploy-check.mjs \
      > /evidence/deployment-readback.json 2> /evidence/deployment-readback.stderr; then :; else
      status=$?
      cat /evidence/deployment-readback.stderr >&2
      exit "$status"
    fi
    cat /evidence/deployment-rebuild-proof.json
    cat /evidence/deployment-readback.json
  '

for report in deployment-rebuild-proof.json deployment-readback.json; do
  if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"passed"' "$evidence_dir/$report"; then
    echo "The read-only deployment gate did not produce a passed $report." >&2
    exit 1
  fi
done
rebuild_sha256="$(sha256sum "$evidence_dir/deployment-rebuild-proof.json" | awk '{print $1}')"
readback_sha256="$(sha256sum "$evidence_dir/deployment-readback.json" | awk '{print $1}')"
printf '{"schema":1,"gate":"deployment-readback","status":"passed","source":"%s","rebuildProofSha256":"%s","readbackSha256":"%s","checkedAt":"%s"}\n' \
  "${GITHUB_SHA:-unknown}" "$rebuild_sha256" "$readback_sha256" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$evidence_dir/deployment-readback-manifest.json"

echo "Read-only deployment proof artifacts saved under $evidence_dir."
