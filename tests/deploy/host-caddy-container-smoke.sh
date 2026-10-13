#!/usr/bin/env bash
set -Eeuo pipefail

command -v docker >/dev/null 2>&1 || { printf 'Docker is required for host Caddy container testing.\n' >&2; exit 2; }
docker compose version >/dev/null

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ -f .env ]] || { printf 'A TEST-only .env is required.\n' >&2; exit 2; }
grep -q '^NODE_ENV=test$' .env || { printf 'Refusing non-TEST NODE_ENV.\n' >&2; exit 2; }
grep -q '^DOMAIN=invoice.example.com$' .env || { printf 'Refusing unexpected TEST DOMAIN.\n' >&2; exit 2; }
grep -q '^APP_ORIGIN=http://127.0.0.1:3001$' .env || { printf 'Refusing unexpected TEST APP_ORIGIN.\n' >&2; exit 2; }
grep -q '^DEPLOYMENT_MODE=EXISTING_HOST_CADDY$' .env || { printf 'Refusing non-host-Caddy deployment mode.\n' >&2; exit 2; }

project_name='invoice-host-caddy-test'
compose=(docker compose -p "$project_name" -f docker-compose.yml -f docker-compose.host-caddy.yml)
base_url='http://127.0.0.1:3001'

cleanup() { "${compose[@]}" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_for_health() {
  for _ in {1..45}; do curl -fsS "$base_url/health" >/dev/null 2>&1 && return 0; sleep 2; done
  "${compose[@]}" ps -a
  return 1
}

assert_only_app() {
  local running app_id caddy_id binding published
  running="$("${compose[@]}" ps --services --filter status=running)"
  [[ "$running" == app ]] || { printf 'Host mode started unexpected services: %s\n' "$running" >&2; return 1; }
  app_id="$("${compose[@]}" ps -q app)"
  [[ -n "$app_id" ]] || return 1
  caddy_id="$("${compose[@]}" ps -aq caddy 2>/dev/null || true)"
  [[ -z "$caddy_id" ]] || { printf 'Project Caddy container unexpectedly exists.\n' >&2; return 1; }
  binding="$(docker inspect "$app_id" | node -e '
    const value=JSON.parse(require("node:fs").readFileSync(0,"utf8"))[0].HostConfig.PortBindings["3000/tcp"];
    if (!Array.isArray(value) || value.length !== 1) process.exit(2);
    process.stdout.write(`${value[0].HostIp}:${value[0].HostPort}`);
  ')"
  [[ "$binding" == '127.0.0.1:3001' ]] || { printf 'Unsafe host binding: %s\n' "$binding" >&2; return 1; }
  published="$(docker port "$app_id" 3000/tcp | tr -d '\r')"
  [[ "$published" == '127.0.0.1:3001' ]] || { printf 'Unexpected published port: %s\n' "$published" >&2; return 1; }
  [[ "$binding" != 0.0.0.0:* && "$published" != 0.0.0.0:* ]]
}

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build app
wait_for_health
assert_only_app

health_body="$(curl -fsS "$base_url/health")"
[[ "$health_body" == '{"status":"ok"}' ]] || { printf 'Unexpected health response: %s\n' "$health_body" >&2; exit 1; }

image_id="$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q app)")"
docker run --rm --entrypoint sh "$image_id" -ec '
  test "$(id -u)" -ne 0
  test "$NODE_ENV" = production
  test -w /app/data
  test ! -e /app/.env
  test ! -e /app/.git
  test ! -e /app/tests
  test ! -e /app/js/db.js
  test -z "$(find /app -type f \( -name "*.sqlite" -o -name "*.db" -o -name "*.pem" -o -name "*.key" \) -print -quit)"
'

printf '%s' 'TEST-container-passphrase-0000' | "${compose[@]}" exec -T \
  -e ADMIN_USERNAME=test-container-admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js seed

"${compose[@]}" restart app
wait_for_health
assert_only_app
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

"${compose[@]}" down
"${compose[@]}" up -d app
wait_for_health
assert_only_app
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

"${compose[@]}" up -d --force-recreate app
wait_for_health
assert_only_app
TEST_BASE_URL="$base_url" node tests/deploy/container-workflow.js verify

printf 'Existing host Caddy mode: app-only topology, loopback binding, business workflow and persistence checks passed.\n'
