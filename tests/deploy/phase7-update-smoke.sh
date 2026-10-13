#!/usr/bin/env bash
set -Eeuo pipefail

command -v docker >/dev/null 2>&1 || { printf 'Docker is required for Phase 7 update testing.\n' >&2; exit 2; }
docker compose version >/dev/null

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$BASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { printf 'Phase 7 requires a full base commit SHA.\n' >&2; exit 2; }

TEST_ROOT="$(mktemp -d)"
ORIGIN="$TEST_ROOT/origin.git"
REPO="$TEST_ROOT/repository"
LOG_DIR="$TEST_ROOT/logs"
mkdir -p "$LOG_DIR"

export COMPOSE_PROJECT_NAME="foreign-trade-phase7-${GITHUB_RUN_ID:-$$}"
export HTTP_PORT="127.0.0.1:28080"
export HTTPS_PORT="127.0.0.1:28443"
BASE_URL="https://localhost:28443"
REQUEST_ORIGIN="https://invoice.example.com"

compose() {
  sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost docker compose "$@"
}

cleanup() {
  if [[ -d "$REPO" ]]; then (cd "$REPO" && compose down >/dev/null 2>&1 || true); fi
  if [[ -d "$TEST_ROOT" ]]; then sudo chown -R "$(id -u):$(id -g)" "$TEST_ROOT" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

wait_for_health() {
  for _ in {1..60}; do curl -kfsS "$BASE_URL/health" >/dev/null 2>&1 && return 0; sleep 2; done
  (cd "$REPO" && compose ps) || true
  return 1
}

session_count() {
  (cd "$REPO" && compose exec -T app node -e "const D=require('better-sqlite3');const d=new D('/app/data/foreign-trade.sqlite',{readonly:true});console.log(d.prepare('SELECT COUNT(*) n FROM sessions').get().n);d.close()")
}

database_digest() {
  (cd "$REPO" && compose exec -T app node <<'NODE'
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const db = new Database('/app/data/foreign-trade.sqlite', { readonly: true });
const tables = ['users', 'sessions', 'schema_migrations', 'company', 'customers', 'products', 'orders', 'packing_lists', 'document_sequences', 'restore_points', 'meta'];
const state = {};
for (const table of tables) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) throw new Error(`missing table ${table}`);
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  state[table] = rows;
}
db.close();
process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'));
NODE
  )
}

assert_equal() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Phase 7 assertion failed: %s\nExpected: %s\nActual:   %s\n' "$label" "$expected" "$actual" >&2
    return 1
  fi
}

write_candidate_failure_wrapper() {
  mv server/server.js server/server-real.js
  cat > server/server.js <<'NODE'
'use strict';
if (String(process.env.DATABASE_PATH || '').endsWith('/candidate.sqlite')) {
  const server = require('node:http').createServer((_request, response) => {
    response.statusCode = 500;
    response.end('TEST candidate health failure');
  });
  server.listen(3000, '0.0.0.0');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  require('./server-real').main().catch(() => { process.exitCode = 1; });
}
NODE
}

write_promotion_failure_wrapper() {
  mv server/server.js server/server-real.js
  cat > server/server.js <<'NODE'
'use strict';
if (String(process.env.DATABASE_PATH || '').endsWith('/foreign-trade.sqlite')) {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  db.exec('CREATE TABLE IF NOT EXISTS phase7_failed_migration_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL); INSERT INTO phase7_failed_migration_probe(marker) VALUES (\'TEST PROMOTION SIDE EFFECT\');');
  db.close();
  process.exit(23);
} else {
  require('./server-real').main().catch(() => { process.exitCode = 1; });
}
NODE
}

git init --bare "$ORIGIN" >/dev/null
git -C "$ROOT" push "$ORIGIN" "$BASE_COMMIT:refs/heads/release-test" >/dev/null
git clone --branch release-test "$ORIGIN" "$REPO" >/dev/null
git -C "$REPO" config user.name 'Phase 7 CI Testing'
git -C "$REPO" config user.email 'phase7-ci@example.invalid'

git -C "$REPO" switch -c candidate-failure >/dev/null
(cd "$REPO" && write_candidate_failure_wrapper)
git -C "$REPO" add server/server.js server/server-real.js
git -C "$REPO" commit -m 'test: inject candidate health failure' >/dev/null
CANDIDATE_FAILURE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push origin HEAD:refs/heads/candidate-failure >/dev/null

git -C "$REPO" switch release-test >/dev/null
git -C "$REPO" switch -c promotion-success >/dev/null
printf 'Phase 7 immutable promotion TEST fixture.\n' > "$REPO/server/phase7-release-marker.txt"
git -C "$REPO" add server/phase7-release-marker.txt
git -C "$REPO" commit -m 'test: add immutable promotion target' >/dev/null
PROMOTION_SUCCESS_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push origin HEAD:refs/heads/promotion-success >/dev/null

git -C "$REPO" switch -c promotion-failure >/dev/null
(cd "$REPO" && write_promotion_failure_wrapper)
git -C "$REPO" add server/server.js server/server-real.js
git -C "$REPO" commit -m 'test: inject post-migration promotion failure' >/dev/null
PROMOTION_FAILURE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push origin HEAD:refs/heads/promotion-failure >/dev/null

git -C "$REPO" switch promotion-success >/dev/null
git -C "$REPO" switch -c local-only >/dev/null
printf 'This commit intentionally remains outside origin.\n' > "$REPO/server/phase7-local-only.txt"
git -C "$REPO" add server/phase7-local-only.txt
git -C "$REPO" commit -m 'test: create non-origin target' >/dev/null
LOCAL_ONLY_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" switch release-test >/dev/null

cat > "$REPO/.env" <<'ENV'
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DOMAIN=invoice.example.com
APP_ORIGIN=https://invoice.example.com
DATABASE_PATH=/app/data/foreign-trade.sqlite
BUSINESS_BACKUP_LIMIT=64mb
SESSION_SECRET=TEST-PHASE7-SESSION-SECRET-0000000000000000000000000000000000000000
TRUST_PROXY_HOPS=1
ENV
chmod 600 "$REPO/.env"
sudo chown -R root:root "$REPO"

cd "$REPO"
sudo docker build -t foreign-trade-invoice-generator:current .
compose up -d app caddy
wait_for_health
printf '%s' 'TEST-container-passphrase-0000' | compose exec -T -e ADMIN_USERNAME=test-container-admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init

# Real anonymous HTTP/session lifecycle through Caddy.
test "$(session_count)" = 0
for _ in {1..100}; do curl -kfsS "$BASE_URL/login" >/dev/null; done
test "$(session_count)" = 0
for _ in {1..3}; do
  login_html="$(curl -kfsS "$BASE_URL/login")"
  login_token="$(printf '%s' "$login_html" | sed -n 's/.*name="csrf-token" content="\([^"]*\)".*/\1/p' | head -1)"
  code="$(curl -ksS -o /dev/null -w '%{http_code}' -H "Origin: $REQUEST_ORIGIN" -H "X-CSRF-Token: $login_token" -H 'Content-Type: application/json' --data '{"username":"test-container-admin","password":"WRONG-TEST-PASSWORD"}' "$BASE_URL/api/auth/login")"
  test "$code" = 401
done
test "$(session_count)" = 0
cookie_jar="$TEST_ROOT/login.cookies"
login_html="$(curl -kfsS "$BASE_URL/login")"
login_token="$(printf '%s' "$login_html" | sed -n 's/.*name="csrf-token" content="\([^"]*\)".*/\1/p' | head -1)"
curl -kfsS -c "$cookie_jar" -H "Origin: $REQUEST_ORIGIN" -H "X-CSRF-Token: $login_token" -H 'Content-Type: application/json' --data '{"username":"test-container-admin","password":"TEST-container-passphrase-0000"}' "$BASE_URL/api/auth/login" >/dev/null
test "$(session_count)" = 1
csrf="$(curl -kfsS -b "$cookie_jar" "$BASE_URL/api/auth/csrf" | node -pe "JSON.parse(require('node:fs').readFileSync(0,'utf8')).csrfToken")"
curl -kfsS -b "$cookie_jar" -H "Origin: $REQUEST_ORIGIN" -H "X-CSRF-Token: $csrf" -X POST "$BASE_URL/api/auth/logout" >/dev/null
test "$(session_count)" = 0

NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" seed
INITIAL_DIGEST="$(database_digest)"
INITIAL_HEAD="$(sudo git rev-parse HEAD)"
INITIAL_IMAGE="$(sudo docker image inspect --format '{{.Id}}' foreign-trade-invoice-generator:current)"
test "$INITIAL_HEAD" = "$BASE_COMMIT"

# Invalid and mutable deployment identities fail before promotion.
for invalid in release-test v1.0 "${PROMOTION_SUCCESS_COMMIT:0:12}" "${PROMOTION_SUCCESS_COMMIT^^}"; do
  if sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$invalid" >/dev/null 2>&1; then
    printf 'Updater accepted invalid identity: %s\n' "$invalid" >&2
    exit 1
  fi
done
if sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh 0000000000000000000000000000000000000000 >/dev/null 2>&1; then
  printf 'Updater accepted a nonexistent SHA.\n' >&2
  exit 1
fi
if sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$LOCAL_ONLY_COMMIT" >/dev/null 2>&1; then
  printf 'Updater accepted a commit outside origin.\n' >&2
  exit 1
fi

# A real failing candidate stays isolated while old Production and Caddy remain available.
candidate_log="$LOG_DIR/candidate-failure.log"
sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$CANDIDATE_FAILURE_COMMIT" >"$candidate_log" 2>&1 &
candidate_pid=$!
candidate_id=''
for _ in {1..60}; do
  candidate_id="$(sudo docker ps -q --filter "name=ft-candidate-${CANDIDATE_FAILURE_COMMIT:0:12}" | head -1)"
  [[ -n "$candidate_id" ]] && break
  sleep 1
done
[[ -n "$candidate_id" ]]
test "$(sudo docker inspect --format '{{.HostConfig.NetworkMode}}' "$candidate_id")" = none
candidate_mounts="$(sudo docker inspect --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$candidate_id")"
printf '%s\n' "$candidate_mounts" | grep -q "/app/data"
if printf '%s\n' "$candidate_mounts" | grep -q "${COMPOSE_PROJECT_NAME}_app_data"; then
  printf 'Candidate mounted Production app_data.\n' >&2
  exit 1
fi
test "$(database_digest)" = "$INITIAL_DIGEST"
curl -kfsS "$BASE_URL/health" >/dev/null
set +e
wait "$candidate_pid"
candidate_status=$?
set -e
test "$candidate_status" -ne 0
grep -q 'candidate preflight failed' "$candidate_log"
test "$(sudo git rev-parse HEAD)" = "$BASE_COMMIT"
test "$(database_digest)" = "$INITIAL_DIGEST"
test "$(sudo docker image inspect --format '{{.Id}}' foreign-trade-invoice-generator:current)" = "$INITIAL_IMAGE"
curl -kfsS "$BASE_URL/health" >/dev/null

# A valid immutable fast-forward commit promotes successfully and records its exact identity.
sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$PROMOTION_SUCCESS_COMMIT" | tee "$LOG_DIR/promotion-success.log"
wait_for_health
test "$(sudo git rev-parse HEAD)" = "$PROMOTION_SUCCESS_COMMIT"
test "$(compose exec -T app cat /app/data/production-commit | tr -d '\r')" = "$PROMOTION_SUCCESS_COMMIT"
grep -q "$PROMOTION_SUCCESS_COMMIT" "$LOG_DIR/promotion-success.log"
NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" verify

# The earlier sibling commit is now non-fast-forward and must be rejected.
if sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$CANDIDATE_FAILURE_COMMIT" >/dev/null 2>&1; then
  printf 'Updater accepted a non-fast-forward target.\n' >&2
  exit 1
fi

PRE_FAILURE_DIGEST="$(database_digest)"
PRE_FAILURE_IMAGE="$(sudo docker image inspect --format '{{.Id}}' foreign-trade-invoice-generator:current)"

# Candidate passes, Production writes a detectable migration side effect, then fails health.
promotion_log="$LOG_DIR/promotion-failure.log"
set +e
sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$PROMOTION_FAILURE_COMMIT" >"$promotion_log" 2>&1
promotion_status=$?
set -e
printf '%s\n' '--- Phase 7 promotion failure / rollback log ---'
sed -n '1,260p' "$promotion_log"
test "$promotion_status" -ne 0 || { printf 'Promotion failure fixture unexpectedly succeeded.\n' >&2; exit 1; }
grep -q 'old image and matching SQLite backup were restored' "$promotion_log" || { printf 'Rollback success marker was absent.\n' >&2; exit 1; }
wait_for_health
assert_equal "$PROMOTION_SUCCESS_COMMIT" "$(sudo git rev-parse HEAD)" 'rollback checkout commit'
assert_equal "$PRE_FAILURE_IMAGE" "$(sudo docker image inspect --format '{{.Id}}' foreign-trade-invoice-generator:current)" 'rollback image identity'
assert_equal "$PROMOTION_SUCCESS_COMMIT" "$(compose exec -T app cat /app/data/production-commit | tr -d '\r')" 'rollback production commit marker'
assert_equal "$PRE_FAILURE_DIGEST" "$(database_digest)" 'rollback SQLite digest'
assert_equal 0 "$(compose exec -T app node -e "const D=require('better-sqlite3');const d=new D('/app/data/foreign-trade.sqlite',{readonly:true});console.log(d.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='phase7_failed_migration_probe'\").get().n);d.close()")" 'rollback migration side-effect removal'
NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" verify

printf 'Phase 7 real Docker candidate isolation, immutable promotion, migration rollback, HTTP authority and session checks passed.\n'
