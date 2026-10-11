#!/usr/bin/env bash
set -euo pipefail
env_args=()
if [[ -n "${FOUNDRY_ENV_FILE:-}" ]]; then
  env_args+=(--env-file "$FOUNDRY_ENV_FILE")
fi
sudo docker run --rm -v "$PWD":/app -w /app --network host "${env_args[@]}" --entrypoint forge ghcr.io/foundry-rs/foundry:v1.5.1 "$@"
