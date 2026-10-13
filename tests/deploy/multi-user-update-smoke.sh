#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${GITHUB_ACTIONS:-}" == 'true' ]] || { printf 'This destructive TEST updater exercise is restricted to GitHub Actions.\n' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'Docker is required.\n' >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V3_COMMIT='5069ee27787e12404576dc40b14e6640ba5ce1fa'
TARGET_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" merge-base --is-ancestor "$V3_COMMIT" "$TARGET_COMMIT"

TEST_ROOT="$(mktemp -d)"
ORIGIN="$TEST_ROOT/origin.git"
REPO="$TEST_ROOT/repository"
export COMPOSE_PROJECT_NAME="foreign-trade-migration-${GITHUB_RUN_ID:-$$}"
export HTTP_PORT='127.0.0.1:38080'
export HTTPS_PORT='127.0.0.1:38443'
BASE_URL='https://localhost:38443'
REQUEST_ORIGIN='https://invoice.example.com'

compose() {
  sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost docker compose "$@"
}

cleanup() {
  if [[ -d "$REPO" ]]; then (cd "$REPO" && compose down >/dev/null 2>&1 || true); fi
  sudo chown -R "$(id -u):$(id -g)" "$TEST_ROOT" >/dev/null 2>&1 || true
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

wait_for_health() {
  for _ in {1..60}; do curl -kfsS "$BASE_URL/health" >/dev/null 2>&1 && return 0; sleep 2; done
  (cd "$REPO" && compose ps) || true
  return 1
}

database_value() {
  local script="$1"
  (cd "$REPO" && compose exec -T app node -e "$script")
}

business_digest() {
  database_value "const D=require('better-sqlite3'),c=require('node:crypto'),d=new D('/app/data/foreign-trade.sqlite',{readonly:true}),s={};for(const t of ['company','customers','products','orders','packing_lists','meta','restore_points']){s[t]=d.prepare('SELECT id,payload_json,row_version,updated_at FROM '+t+' ORDER BY id').all()}s.document_sequences=d.prepare('SELECT * FROM document_sequences ORDER BY kind,period').all();d.close();process.stdout.write(c.createHash('sha256').update(JSON.stringify(s)).digest('hex'))"
}

whole_database_digest() {
  (cd "$REPO" && compose exec -T app node <<'NODE'
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const db = new Database('/app/data/foreign-trade.sqlite', { readonly: true });
const state = {};
for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  const quotedTable = `"${row.name.replaceAll('"', '""')}"`;
  state[row.name] = db.prepare(`SELECT * FROM ${quotedTable}`).all()
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
db.close();
process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'));
NODE
  )
}

git init --bare "$ORIGIN" >/dev/null
git -C "$ROOT" push "$ORIGIN" "$V3_COMMIT:refs/heads/production" "$TARGET_COMMIT:refs/heads/enterprise" >/dev/null
git clone --branch production "$ORIGIN" "$REPO" >/dev/null
git -C "$REPO" config user.name 'Enterprise Migration CI Testing'
git -C "$REPO" config user.email 'enterprise-migration-ci@example.invalid'

cat > "$REPO/.env" <<'ENV'
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DOMAIN=invoice.example.com
APP_ORIGIN=https://invoice.example.com
DATABASE_PATH=/app/data/foreign-trade.sqlite
BUSINESS_BACKUP_LIMIT=64mb
SESSION_SECRET=TEST-MIGRATION-SESSION-SECRET-0000000000000000000000000000000000000000
TRUST_PROXY_HOPS=1
ENV
chmod 600 "$REPO/.env"
sudo chown -R root:root "$REPO"

cd "$REPO"
sudo docker build -t foreign-trade-invoice-generator:current .
compose up -d app caddy
wait_for_health
printf '%s' 'TEST-container-passphrase-0000' | compose exec -T -e ADMIN_USERNAME=test-container-admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" seed

# Add a valid v3 restore point without changing the portable business payloads.
compose exec -T app node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/foreign-trade.sqlite');
const payload = JSON.stringify({ id: 'latest', version: 2, createdAt: '2026-09-11T00:00:00.000Z', marker: 'TEST_V3_RESTORE_POINT' });
db.prepare('INSERT OR REPLACE INTO restore_points(id,payload_json,row_version,updated_at) VALUES(?,?,?,?)').run('latest', payload, 7, 1700000000000);
db.close();
NODE

test "$(database_value "const D=require('better-sqlite3'),d=new D('/app/data/foreign-trade.sqlite',{readonly:true});process.stdout.write(String(d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v));d.close()")" = 3
test "$(database_value "const D=require('better-sqlite3'),d=new D('/app/data/foreign-trade.sqlite',{readonly:true});process.stdout.write(String(d.prepare('SELECT COUNT(*) n FROM sessions').get().n));d.close()")" -gt 0
BEFORE_BUSINESS="$(business_digest)"
BEFORE_ENV="$(sudo sha256sum .env | awk '{print $1}')"
printf 'TEST HOST CADDY FIXTURE - MUST NOT CHANGE\n' > "$TEST_ROOT/Caddyfile"
BEFORE_CADDY="$(sha256sum "$TEST_ROOT/Caddyfile" | awk '{print $1}')"

sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$TARGET_COMMIT"
wait_for_health
test "$(sudo git rev-parse HEAD)" = "$TARGET_COMMIT"
test "$(business_digest)" = "$BEFORE_BUSINESS"
test "$(sudo sha256sum .env | awk '{print $1}')" = "$BEFORE_ENV"
test "$(sha256sum "$TEST_ROOT/Caddyfile" | awk '{print $1}')" = "$BEFORE_CADDY"
database_value "const a=require('node:assert/strict'),D=require('better-sqlite3'),d=new D('/app/data/foreign-trade.sqlite',{readonly:true}),u=d.prepare('SELECT * FROM users').all();a.equal(d.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,4);a.equal(u.length,1);a.equal(u[0].role,'ADMIN');a.equal(u[0].status,'ACTIVE');a.equal(d.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);a.equal(d.prepare('SELECT COUNT(*) n FROM customers WHERE owner_user_id=?').get(u[0].id).n,1);a.equal(d.prepare('SELECT COUNT(*) n FROM orders WHERE owner_user_id=?').get(u[0].id).n,1);a.equal(d.prepare('SELECT COUNT(*) n FROM packing_lists WHERE owner_user_id=?').get(u[0].id).n,1);a.equal(JSON.parse(d.prepare(\"SELECT payload_json FROM restore_points WHERE id='latest'\").get().payload_json).marker,'TEST_V3_RESTORE_POINT');d.close()"
NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" verify

# A descendant candidate passes isolated migration but fails after promotion; updater must restore v4 state exactly.
sudo git config user.name 'Enterprise Migration CI Testing'
sudo git config user.email 'enterprise-migration-ci@example.invalid'
sudo git switch -c enterprise-promotion-failure >/dev/null
sudo mv server/server.js server/server-real.js
sudo tee server/server.js >/dev/null <<'NODE'
'use strict';
if (String(process.env.DATABASE_PATH || '').endsWith('/foreign-trade.sqlite')) {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  db.exec("CREATE TABLE enterprise_failed_promotion_probe(marker TEXT NOT NULL); INSERT INTO enterprise_failed_promotion_probe VALUES('TEST SIDE EFFECT')");
  db.close();
  process.exit(29);
}
require('./server-real').main().catch(() => { process.exitCode = 1; });
NODE
sudo git add server/server.js server/server-real.js
sudo git commit -m 'test: inject enterprise promotion failure' >/dev/null
FAILURE_COMMIT="$(sudo git rev-parse HEAD)"
sudo git push origin HEAD:refs/heads/enterprise-promotion-failure >/dev/null
sudo git switch production >/dev/null
AFTER_SUCCESS_DIGEST="$(whole_database_digest)"
set +e
sudo env COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" DOMAIN=https://localhost ./deploy/update.sh "$FAILURE_COMMIT" > "$TEST_ROOT/failure.log" 2>&1
status=$?
set -e
test "$status" -ne 0
grep -q 'old image and matching SQLite backup were restored' "$TEST_ROOT/failure.log"
wait_for_health
test "$(sudo git rev-parse HEAD)" = "$TARGET_COMMIT"
test "$(whole_database_digest)" = "$AFTER_SUCCESS_DIGEST"
test "$(sudo sha256sum .env | awk '{print $1}')" = "$BEFORE_ENV"
test "$(sha256sum "$TEST_ROOT/Caddyfile" | awk '{print $1}')" = "$BEFORE_CADDY"
database_value "const D=require('better-sqlite3'),d=new D('/app/data/foreign-trade.sqlite',{readonly:true});if(d.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='enterprise_failed_promotion_probe'\").get().n)process.exit(1);d.close()"
NODE_TLS_REJECT_UNAUTHORIZED=0 TEST_BASE_URL="$BASE_URL" TEST_REQUEST_ORIGIN="$REQUEST_ORIGIN" node "$ROOT/tests/deploy/container-workflow.js" verify

printf 'Production v3 to v4 candidate migration, promotion and failure rollback passed.\n'
