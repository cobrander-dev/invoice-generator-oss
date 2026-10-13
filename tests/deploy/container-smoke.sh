#!/usr/bin/env bash
set -Eeuo pipefail

command -v docker >/dev/null 2>&1 || { printf 'Docker is required for container smoke testing.\n' >&2; exit 2; }
docker compose version >/dev/null
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { printf 'Use an isolated checkout with a TEST-only .env.\n' >&2; exit 2; }
grep -q '^DOMAIN=invoice.example.com$' .env || { printf 'Refusing unexpected TEST DOMAIN.\n' >&2; exit 2; }
grep -q '^APP_ORIGIN=http://localhost:18080$' .env || { printf 'Refusing non-TEST APP_ORIGIN.\n' >&2; exit 2; }
export HTTP_PORT="127.0.0.1:18080"
export HTTPS_PORT="127.0.0.1:18443"
export COMPOSE_PROJECT_NAME="foreign-trade-invoice-ci-${GITHUB_RUN_ID:-$$}"
compose=(docker compose -f docker-compose.yml -f tests/deploy/docker-compose.test.yml)
base_url="http://localhost:18080"
image="foreign-trade-invoice-generator:current"

cleanup() { "${compose[@]}" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_for_health() {
  for _ in {1..45}; do curl -fsS "$base_url/health" >/dev/null 2>&1 && return 0; sleep 2; done
  "${compose[@]}" ps
  return 1
}

expect_production_failure() {
  if docker run --rm "$@" "$image" >/tmp/ft-production-fail-fast.log 2>&1; then
    printf 'Production container unexpectedly accepted missing configuration.\n' >&2
    return 1
  fi
}

"${compose[@]}" up -d --build
wait_for_health
curl -fsS "$base_url/health" | grep -q '"status":"ok"'

# Inspect the production image, while the Compose override intentionally runs HTTP TEST mode.
docker run --rm --entrypoint sh "$image" -ec '
  test "$(id -u)" -ne 0
  test "$NODE_ENV" = production
  test -w /app/data
  test ! -e /app/.env
  test ! -e /app/.git
  test ! -e /app/tests
  test ! -e /app/js/db.js
  test -z "$(find /app -type f \( -name "*.sqlite" -o -name "*.db" -o -name "*.pem" -o -name "*.key" \) -print -quit)"
'
"${compose[@]}" exec -T app sh -ec 'test "$(id -u)" -ne 0 && test -w /app/data && touch /app/data/.write-test && rm /app/data/.write-test'

test_secret='TEST-ONLY-SESSION-SECRET-0000000000000000000000000000000000000000'
expect_production_failure -e NODE_ENV=production -e APP_ORIGIN=https://invoice.example.invalid -e DATABASE_PATH=/tmp/test.sqlite
expect_production_failure -e NODE_ENV=production -e DATABASE_PATH=/tmp/test.sqlite -e SESSION_SECRET="$test_secret"
expect_production_failure -e NODE_ENV=production -e APP_ORIGIN=https://invoice.example.invalid -e SESSION_SECRET="$test_secret"
rm -f /tmp/ft-production-fail-fast.log

printf '%s' 'TEST-container-passphrase-0000' | "${compose[@]}" exec -T -e ADMIN_USERNAME=test-container-admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js seed

"${compose[@]}" restart app
wait_for_health
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

# A direct stop sends SIGTERM. The application must close cleanly with exit code 0.
app_id="$("${compose[@]}" ps -q app)"
"${compose[@]}" stop -t 15 app
test "$(docker inspect --format '{{.State.ExitCode}}' "$app_id")" = 0
"${compose[@]}" start app
wait_for_health
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

# Down intentionally retains named volumes; recreating the stack must retain TEST data.
"${compose[@]}" down
"${compose[@]}" up -d
wait_for_health
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

"${compose[@]}" up -d --force-recreate app
wait_for_health
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

printf 'Container workflow, fail-fast, graceful shutdown and persistence checks passed.\n'
