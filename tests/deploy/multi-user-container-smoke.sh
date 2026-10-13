#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${GITHUB_ACTIONS:-}" == 'true' ]] || { printf 'This destructive TEST stack is restricted to GitHub Actions.\n' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'Docker is required.\n' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export COMPOSE_PROJECT_NAME="invoice-generator-multi-user-${GITHUB_RUN_ID:-$$}"
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.host-caddy.yml)
base_url='http://127.0.0.1:3001'
test_secret='TEST-MULTI-USER-SESSION-SECRET-0000000000000000000000000000000000000000'

cleanup() { "${compose[@]}" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nDOMAIN=invoice.example.com\nAPP_ORIGIN=https://invoice.example.com\nDEPLOYMENT_MODE=EXISTING_HOST_CADDY\nDATABASE_PATH=/app/data/invoice-generator.sqlite\nBUSINESS_BACKUP_LIMIT=64mb\nPASSWORD_MIN_LENGTH=8\nSESSION_SECRET=%s\nTRUST_PROXY_HOPS=1\n' "$test_secret" > .env
chmod 600 .env

"${compose[@]}" up -d --build app
for _ in {1..60}; do curl -fsS "$base_url/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$base_url/health" | grep -q '"status":"ok"'
test "$("${compose[@]}" ps --services --filter status=running)" = 'app'
test "$(docker port "$("${compose[@]}" ps -q app)" 3000/tcp | tr -d '\r')" = '127.0.0.1:3001'

printf '%s' 'TEST-enterprise-admin-0001' | "${compose[@]}" exec -T \
  -e ADMIN_USERNAME=test-enterprise-admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
TEST_BASE_URL="$base_url" TEST_REQUEST_ORIGIN='https://invoice.example.com' TEST_FORWARDED_PROTO=https \
  node tests/deploy/multi-user-container-workflow.js

reset_password='TEST-enterprise-admin-reset-0002'
reset_output="$(TEST_TTY_SECRET="$reset_password" python3 tests/deploy/tty-secret-runner.py \
  "${compose[@]}" exec app npm run admin:reset-password)"
if printf '%s' "$reset_output" | grep -Fq "$reset_password"; then
  printf 'ADMIN reset command exposed the password.\n' >&2
  exit 1
fi
"${compose[@]}" exec -T app node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/invoice-generator.sqlite', { readonly: true });
const admin = db.prepare("SELECT id FROM users WHERE role='ADMIN'").get();
if (db.prepare("SELECT COUNT(*) n FROM sessions WHERE json_extract(payload, '$.userId')=?").get(admin.id).n !== 0) process.exit(1);
db.close();
NODE
TEST_BASE_URL="$base_url" TEST_REQUEST_ORIGIN='https://invoice.example.com' TEST_FORWARDED_PROTO=https \
  TEST_ADMIN_PASSWORD="$reset_password" node tests/deploy/multi-user-container-workflow.js verify-admin-reset

"${compose[@]}" exec -T app node <<'NODE'
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = new Database('/app/data/invoice-generator.sqlite');
const admin = db.prepare("SELECT * FROM users WHERE role='ADMIN'").get();
const employee = db.prepare("SELECT * FROM users WHERE role='EMPLOYEE' LIMIT 1").get();
assert.throws(() => db.prepare("INSERT INTO users(id,username,password_hash,created_at,display_name,role,status,auth_version) VALUES('second-admin','second-admin','x',1,'Second','ADMIN','ACTIVE',1)").run(), /UNIQUE/);
assert.throws(() => db.prepare("UPDATE users SET role='ADMIN' WHERE id=?").run(employee.id), /immutable/);
assert.throws(() => db.prepare("UPDATE users SET role='EMPLOYEE' WHERE id=?").run(admin.id), /immutable/);
assert.throws(() => db.prepare('DELETE FROM users WHERE id=?').run(admin.id), /cannot be deleted/);
assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='ADMIN'").get().n, 1);
db.close();
NODE

printf 'Production Docker enterprise multi-user, authorization and database constraints passed.\n'
