#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prefix="${CI_PREFIX:-pingapp-audit-ci}"
database_name="${prefix//-/_}"
node_image="node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
postgres_image="postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
redis_image="redis:7.4.11-alpine3.21@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499"
foundry_image="ghcr.io/foundry-rs/foundry:v1.5.1@sha256:3a70bfa9bd2c732a767bb60d12c8770b40e8f9b6cca28efc4b12b1be81c7f28e"
docker_spec="${DOCKER:-docker}"
read -r -a docker_cmd <<< "$docker_spec"

if [[ ! "$prefix" =~ ^pingapp-audit-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "CI_PREFIX must match ^pingapp-audit-[a-z0-9]+(-[a-z0-9]+)*$ so every gated integration suite accepts the isolated resources." >&2
  exit 2
fi
if [[ "${#docker_cmd[@]}" -eq 0 ]]; then
  echo 'DOCKER must name a Docker command (for example: sudo docker).' >&2
  exit 2
fi

postgres_name="${prefix}-postgres"
redis_name="${prefix}-redis"
anvil_name="${prefix}-anvil"
monitor_database_name="pingapp_audit_monitor"
evidence_dir="${CI_EVIDENCE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pingapp-audit-ci-evidence}"
mkdir -p "$evidence_dir"
runtime="$(mktemp -d -t pingapp-audit-ci.XXXXXX)"
chmod 755 "$runtime"
mkdir -p "$runtime/bin" "$runtime/contracts-for-node"
test_contracts="$runtime/contracts-for-node"
containers=()
cleanup() {
  if [[ "${#containers[@]}" -gt 0 ]]; then
    "${docker_cmd[@]}" rm --force "${containers[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$runtime"
}
trap cleanup EXIT

for name in "$postgres_name" "$redis_name" "$anvil_name"; do
  if "${docker_cmd[@]}" container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing to replace existing container: $name" >&2
    exit 2
  fi
done

"${docker_cmd[@]}" run --detach --rm --cpus=2 --memory=1g --name "$postgres_name" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=pingapp --env POSTGRES_PASSWORD=ci-only-not-secret --env "POSTGRES_DB=$database_name" \
  "$postgres_image" >/dev/null
containers+=("$postgres_name")
"${docker_cmd[@]}" run --detach --rm --cpus=2 --memory=512m --name "$redis_name" \
  --publish 127.0.0.1::6379 "$redis_image" >/dev/null
containers+=("$redis_name")
"${docker_cmd[@]}" run --detach --rm --cpus=2 --memory=1g --name "$anvil_name" \
  --publish 127.0.0.1::8545 --entrypoint anvil "$foundry_image" \
  --host 0.0.0.0 --port 8545 --chain-id 4663 >/dev/null
containers+=("$anvil_name")

host_port() {
  "${docker_cmd[@]}" port "$1" "$2/tcp" | sed -E 's/^.*:([0-9]+)$/\1/'
}
postgres_port="$(host_port "$postgres_name" 5432)"
redis_port="$(host_port "$redis_name" 6379)"
anvil_port="$(host_port "$anvil_name" 8545)"

wait_for() {
  local description="$1" name="$2" command="$3" attempt
  for attempt in $(seq 1 60); do
    if "${docker_cmd[@]}" exec "$name" sh -c "$command" >/dev/null 2>&1; then
      echo "$description is ready."
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $description." >&2
  "${docker_cmd[@]}" logs "$name" >&2 || true
  return 1
}
wait_for PostgreSQL "$postgres_name" "pg_isready -U pingapp -d $database_name"
wait_for Redis "$redis_name" 'redis-cli ping | grep -qx PONG'
"${docker_cmd[@]}" exec "$postgres_name" createdb -U pingapp "$monitor_database_name"

for attempt in $(seq 1 60); do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:${anvil_port}" \
    -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    | grep -q '0x1237'; then
    echo 'Disposable Anvil is ready on chain ID 4663.'
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    echo 'Timed out waiting for disposable Anvil.' >&2
    "${docker_cmd[@]}" logs "$anvil_name" >&2 || true
    exit 1
  fi
  sleep 1
done

uid="$(id -u)"
gid="$(id -g)"
"${docker_cmd[@]}" run --rm --cpus=2 --memory=4g --user "${uid}:${gid}" --env HOME=/ci-runtime \
  --volume "$runtime:/ci-runtime" --volume "${repo_root}/contracts:/work" --workdir /work \
  --entrypoint forge "$foundry_image" build --out /ci-runtime/contracts-out --cache-path /ci-runtime/contracts-cache
cp -a "$repo_root/contracts/." "$test_contracts/"
rm -rf -- "$test_contracts/out" "$test_contracts/cache"
mkdir -p "$test_contracts/out"
cp -a "$runtime/contracts-out/." "$test_contracts/out/"
ln -s ../.svm/0.8.28/solc-0.8.28 "$runtime/bin/solc"
if [[ ! -x "$runtime/bin/solc" ]]; then
  echo 'Pinned Solidity 0.8.28 compiler is required for the offline deployment proof.' >&2
  exit 2
fi

"${docker_cmd[@]}" run --rm --cpus=2 --memory=3g --network host --user "${uid}:${gid}" \
  --env HOME=/tmp --env PATH=/ci-runtime/bin:/usr/local/bin:/usr/bin:/bin \
  --env NODE_ENV=test --env LOG_LEVEL=silent --env PORT=7410 --env CI_PREFIX="$prefix" \
  --env PG_PORT="$postgres_port" --env REDIS_PORT="$redis_port" \
  --env MONITOR_DATABASE_URL="postgres://pingapp:ci-only-not-secret@127.0.0.1:${postgres_port}/${monitor_database_name}" \
  --env DATABASE_URL="postgres://pingapp:ci-only-not-secret@127.0.0.1:${postgres_port}/${database_name}" \
  --env POSTGRES_PASSWORD=ci-only-not-secret \
  --env REDIS_URL="redis://127.0.0.1:${redis_port}/0" \
  --env CHAIN=robinhood --env PUBLIC_RPC_URL="http://127.0.0.1:${anvil_port}" \
  --env ANVIL_RPC_URL="http://127.0.0.1:${anvil_port}" \
  --env PHONE_HMAC_SECRET=0000000000000000000000000000000000000000000000000000000000000000 \
  --env PHONE_ENC_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
  --env IP_HASH_SALT=synthetic-ci-salt --env APP_URL=http://127.0.0.1:7400 \
  --env SMS_DRIVER=log --env SMS_ENABLED=false --env CARDS_ENABLED=false \
  --volume "$runtime:/ci-runtime:ro" \
  --volume "$evidence_dir:/evidence" \
  --volume "$repo_root:/work" --volume "$test_contracts:/work/contracts:ro" \
  --workdir /work "$node_image" sh -euc '
    test "$(node --version)" = "v24.21.0"
    npm ci
    npx drizzle-kit check
    if npm audit --audit-level=moderate --json > /evidence/npm-audit.json; then
      node scripts/ci/summarize-npm-audit.mjs /evidence/npm-audit.json
    else
      audit_status=$?
      node scripts/ci/summarize-npm-audit.mjs /evidence/npm-audit.json || true
      exit "$audit_status"
    fi
    npm run typecheck
    npm run build
    npm run migrate
    test -f test/f1-discovery.integration.test.ts || { echo "Required F1 integration test is missing." >&2; exit 1; }
    test -f test/sms-budget.integration.test.ts || { echo "Required F2 integration test is missing." >&2; exit 1; }
    test -f test/monitor.integration.test.ts || { echo "Required AUD-05 monitor integration test is missing." >&2; exit 1; }
    test -f test/worker-shutdown.integration.test.ts || { echo "Required worker shutdown integration test is missing." >&2; exit 1; }
    test -f test/token-eligibility.integration.test.ts || { echo "Required AUD-09 token eligibility integration test is missing." >&2; exit 1; }
    test -f test/aud09.integration.test.ts || { echo "Required AUD-09 RPC/webhook integration test is missing." >&2; exit 1; }
    test -f test/otp.test.ts || { echo "Required OTP regression test is missing." >&2; exit 1; }
    test -f tooling/scripts/deployment/rebuild-proof.mjs || { echo "Required deployment build proof is missing." >&2; exit 1; }
    test -f tooling/scripts/deployment/post-deploy-check.mjs || { echo "Required read-only deployment check is missing." >&2; exit 1; }
    test -f test/deployment-proof.test.ts || { echo "Required deployment proof test is missing." >&2; exit 1; }
    if npm test -- --exclude test/f1-discovery.integration.test.ts \
      --exclude test/sms-budget.integration.test.ts --exclude test/otp.test.ts \
      --exclude test/monitor.integration.test.ts --exclude test/deployment-proof.test.ts \
      --exclude test/worker-shutdown.integration.test.ts \
      --exclude test/token-eligibility.integration.test.ts --exclude test/aud09.integration.test.ts \
      --reporter=json --outputFile=/evidence/vitest-general.json; then :; else
      test_status=$?
      node scripts/ci/print-vitest-failures.mjs /evidence/vitest-general.json
      exit "$test_status"
    fi
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-general.json
    TRUSTED_PROXY_IPS=127.0.0.1 F1_INTEGRATION=1 npm test -- test/f1-discovery.integration.test.ts \
      --reporter=json --outputFile=/evidence/vitest-f1.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-f1.json --no-anvil \
      --expect-file=test/f1-discovery.integration.test.ts --expect-count=3
    PINGAPP_SMS_TEST_RESOURCE_PREFIX="$CI_PREFIX" \
      PINGAPP_SMS_TEST_POSTGRES_PORT="$PG_PORT" PINGAPP_SMS_TEST_REDIS_PORT="$REDIS_PORT" \
      SMS_DRIVER=seven SEVEN_API_KEY=fake-provider-key \
      SMS_ENABLED=true SMS_DAILY_CAP=12 SMS_FUNDED_INVITE_DAILY_BUDGET=4 \
      SMS_CLAIM_OTP_DAILY_BUDGET=4 SMS_ONBOARDING_DAILY_BUDGET=3 SMS_ADMIN_DAILY_BUDGET=1 \
      npm test -- test/sms-budget.integration.test.ts test/otp.test.ts \
        --reporter=json --outputFile=/evidence/vitest-f2.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-f2.json --no-anvil \
      --expect-file=test/sms-budget.integration.test.ts --expect-file=test/otp.test.ts \
      --expect-suite-count=test/sms-budget.integration.test.ts=14 \
      --expect-suite-count=test/otp.test.ts=3
    npm test -- test/deployment-proof.test.ts --reporter=json \
      --outputFile=/evidence/vitest-deployment-proof.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-deployment-proof.json --no-anvil \
      --expect-file=test/deployment-proof.test.ts \
      --expect-suite-count=test/deployment-proof.test.ts=14
    DATABASE_URL="$MONITOR_DATABASE_URL" npm run migrate
    DATABASE_URL="$MONITOR_DATABASE_URL" node scripts/ci/create-monitor-reader.mjs
    PINGAPP_MONITOR_TEST_RESOURCE_PREFIX=pingapp-audit-monitor \
      PINGAPP_MONITOR_TEST_POSTGRES_PORT="$PG_PORT" PINGAPP_MONITOR_TEST_REDIS_PORT="$REDIS_PORT" \
      DATABASE_URL="$MONITOR_DATABASE_URL" \
      ROUTER_WATCH_DATABASE_URL="postgres://pingapp_watch_ci:ci-monitor-readonly@127.0.0.1:${PG_PORT}/pingapp_audit_monitor" \
      ROUTER_ENABLED=true ROUTER_ADDRESS=0x0000000000000000000000000000000000000003 ROUTER_DEPLOY_BLOCK=0 \
      ROUTER_SIGNER_KEY=2222222222222222222222222222222222222222222222222222222222222222 \
      RELAYER_PRIVATE_KEY=3333333333333333333333333333333333333333333333333333333333333333 \
      npm test -- test/monitor.integration.test.ts --reporter=json --outputFile=/evidence/vitest-monitor.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-monitor.json --no-anvil \
      --expect-file=test/monitor.integration.test.ts --expect-suite-count=test/monitor.integration.test.ts=2
    PINGAPP_AUD09_RESOURCE_PREFIX="$CI_PREFIX" PINGAPP_AUD09_RPC_RESOURCE_PREFIX="$CI_PREFIX" \
      PINGAPP_AUD09_WEBHOOK_RESOURCE_PREFIX="$CI_PREFIX" PINGAPP_AUD09_POSTGRES_PORT="$PG_PORT" \
      PINGAPP_AUD09_REDIS_PORT="$REDIS_PORT" IZIPAY_WEBHOOK_SECRET=aud09-synthetic-webhook-secret \
      TOKEN_ELIGIBILITY_INTEGRATION=1 RPC_RELAY_INTEGRATION=1 AUD09_WEBHOOK_INTEGRATION=1 \
      npm test -- test/token-eligibility.integration.test.ts test/aud09.integration.test.ts \
        --reporter=json --outputFile=/evidence/vitest-aud09.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-aud09.json --no-anvil \
      --expect-file=test/token-eligibility.integration.test.ts --expect-file=test/aud09.integration.test.ts \
      --expect-suite-count=test/token-eligibility.integration.test.ts=2 \
      --expect-suite-count=test/aud09.integration.test.ts=3
    node tooling/scripts/deployment/rebuild-proof.mjs
  '

# This suite checks shutdown while Redis is unavailable, so stop only this runner's disposable Redis.
"${docker_cmd[@]}" stop "$redis_name" >/dev/null
"${docker_cmd[@]}" run --rm --cpus=2 --memory=3g --network host --user "${uid}:${gid}" \
  --env HOME=/tmp --env PINGAPP_WORKER_SHUTDOWN_TEST_RESOURCE_PREFIX=pingapp-audit-signer \
  --env "PINGAPP_WORKER_SHUTDOWN_TEST_REDIS_PORT=$redis_port" \
  --volume "$evidence_dir:/evidence" --volume "$repo_root:/work" \
  --volume "$test_contracts:/work/contracts:ro" --workdir /work "$node_image" sh -euc '
    test "$(node --version)" = "v24.21.0"
    npm ci
    npm test -- test/worker-shutdown.integration.test.ts --reporter=json \
      --outputFile=/evidence/vitest-worker-shutdown.json
    node scripts/ci/assert-vitest-results.mjs /evidence/vitest-worker-shutdown.json --no-anvil \
      --expect-file=test/worker-shutdown.integration.test.ts \
      --expect-suite-count=test/worker-shutdown.integration.test.ts=1
  '
