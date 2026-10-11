#!/usr/bin/env bash
set -euo pipefail
sudo docker run --rm -v "$PWD":/app -w /app --network host --entrypoint cast ghcr.io/foundry-rs/foundry:v1.5.1 "$@"
