#!/usr/bin/env bash
set -euo pipefail
contracts_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_dir="$(cd -- "$contracts_dir/../.." && pwd)"
cd "$contracts_dir"
bin/forge.sh build
sudo docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$workspace_dir/app:/workspace/app" -v "$workspace_dir/docs:/workspace/docs" \
  -w /workspace/app --entrypoint node node:22-alpine \
  contracts/script/deploy-fork.mjs
