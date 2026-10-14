#!/usr/bin/env bash
# End-to-end installer test. Runs ONLY as root on a disposable CI runner (GitHub Actions):
# it installs Invoice Generator under /opt/invoice-generator and binds ports 80/443.
#
# usage: sudo -E tests/installer/e2e.sh domain|ip|external|custom-port|conflict
#   domain       bundled Caddy, domain name, non-interactive answers
#   ip           bundled Caddy, public IPv4, real interactive wizard driven through a PTY
#   external     Nginx already owns 80/443; app on loopback behind the generated Nginx config
#   custom-port  bundled Caddy on HTTPS port 8443 (unattended), Nginx keeps 443
#   conflict     interactive wizard: 8443 is taken by Nginx and refused, then 9443 is chosen
# All modes then test backup, restore, upgrade, failed-upgrade rollback and isolation.
set -Eeuo pipefail

mode="${1:?usage: e2e.sh domain|ip|external|custom-port|conflict}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "$(id -u)" -eq 0 ]] ||
  {
    echo 'refusing to run outside a disposable GitHub Actions runner as root' >&2
    exit 1
  }

work="$(mktemp -d)"
dist="$work/dist"
caddy_image=caddy:2.11.4-alpine
password="TEST-e2e-$(openssl rand -hex 12)"
printf '%s' "$password" >"$work/admin-password"
chmod 600 "$work/admin-password"
jar="$work/cookies"
step() { printf '\n==> %s\n' "$*"; }
fail() {
  echo "E2E FAIL: $*" >&2
  exit 1
}
expect_failure() {
  local code="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    printf '%s\n' "$output"
    fail "expected failure $code"
  fi
  printf '%s\n' "$output"
  [[ "$output" == *"[$code]"* ]] || fail "expected error code $code"
}

port=443
case "$mode" in
  domain | external) host=invoice.ci.test ;;
  ip) host=203.0.113.10 ;;
  custom-port) host=invoice.ci.test port=8443 ;;
  conflict) host=invoice.ci.test port=9443 ;;
  *) fail "unknown mode $mode" ;;
esac
origin="https://$host"
[[ "$port" == 443 ]] || origin="https://$host:$port"
https=(curl -fsS -k --max-time 20 --connect-to "$host:$port:127.0.0.1:$port" -b "$jar" -c "$jar")

login() {
  rm -f "$jar"
  local token
  token="$("${https[@]}" "$origin/login" | grep -oE '[a-f0-9]{112}' | head -n 1)"
  [[ -n "$token" ]] || fail 'login token missing'
  jq -n --arg u ci-admin --rawfile p "$work/admin-password" '{username: $u, password: $p}' >"$work/login.json"
  "${https[@]}" -X POST "$origin/api/auth/login" -H "Origin: $origin" -H "X-CSRF-Token: $token" \
    -H 'Content-Type: application/json' --data @"$work/login.json" >/dev/null
}
api_post() {
  local token
  token="$("${https[@]}" "$origin/api/auth/csrf" | jq -r .csrfToken)"
  "${https[@]}" -X POST "$origin$1" -H "Origin: $origin" -H "X-CSRF-Token: $token" \
    -H 'Content-Type: application/json' --data "$2" >/dev/null
}
customer_count() { "${https[@]}" "$origin/api/customers" | jq '.data | length'; }
installed_version() { invoice-generator version | awk '{print $3}'; }
service_container() {
  docker ps -q --filter label=com.docker.compose.project=invoice-generator --filter "label=com.docker.compose.service=$1"
}
running_image() { docker inspect --format '{{.Config.Image}}' "$(service_container app)"; }

step 'build test images and release bundles'
docker build -q -t invoice-generator:ci-a "$root" >/dev/null
printf 'FROM invoice-generator:ci-a\nLABEL ci.release=b\n' | docker build -q -t invoice-generator:ci-b - >/dev/null
printf 'FROM invoice-generator:ci-a\nCMD ["node","-e","process.exit(1)"]\n' | docker build -q -t invoice-generator:ci-broken - >/dev/null
# Healthy in the network-less candidate check. Once promoted onto the real network it writes a
# business record (like a user saving data on the new version) and then crashes.
mkdir -p "$work/late-image"
cat >"$work/late-image/write-then-fail.js" <<'JS'
const Database = require('better-sqlite3');
const { migrateDatabase } = require('/app/server/db/migrations');
const db = new Database(process.env.DATABASE_PATH);
migrateDatabase(db);
db.prepare("INSERT OR IGNORE INTO customers (id, payload_json, updated_at, lifecycle_state) VALUES (?, ?, ?, 'ACTIVE')")
  .run('customer-written-after-switch', JSON.stringify({ id: 'customer-written-after-switch', buyerName: 'After switch' }), Date.now());
db.close();
process.exit(1);
JS
printf 'FROM invoice-generator:ci-a\nCOPY write-then-fail.js /app/write-then-fail.js\nCMD ["sh","-c","[ -e /sys/class/net/eth0 ] && exec node /app/write-then-fail.js; exec node server/server.js"]\n' \
  >"$work/late-image/Dockerfile"
docker build -q -t invoice-generator:ci-late-failure "$work/late-image" >/dev/null
docker pull -q "$caddy_image" >/dev/null
for spec in a:v0.0.1-ci.1:ci-a b:v0.0.1-ci.2:ci-b broken:v0.0.1-ci.3:ci-broken late:v0.0.1-ci.4:ci-late-failure; do
  IFS=: read -r name version tag <<<"$spec"
  IG_ALLOW_LOCAL_IMAGES=1 "$root/scripts/build-installer-bundle.sh" "$version" "invoice-generator:$tag" "$caddy_image" "$dist/$name" >/dev/null
done
sha() { awk '$2 == "invoice-generator-installer.tar.gz" {print $1}' "$dist/$1/SHA256SUMS"; }

step 'start a neighbouring Docker project that must stay untouched'
docker volume create neighbor_data >/dev/null
docker run -d --name neighbor-app --label com.docker.compose.project=neighbor -v neighbor_data:/data \
  busybox:1.37 sh -c 'echo keep-me > /data/marker; sleep infinity' >/dev/null

if [[ "$mode" == external || "$mode" == custom-port || "$mode" == conflict ]]; then
  step 'start Nginx on 80/443 before installation'
  mkdir -p "$work/nginx/conf.d" "$work/nginx/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$host" -addext "subjectAltName=DNS:$host" \
    -keyout "$work/nginx/tls/key.pem" -out "$work/nginx/tls/cert.pem" 2>/dev/null
  listen=''
  [[ "$mode" == custom-port ]] && listen='listen 80 default_server; '
  [[ "$mode" == conflict ]] && listen='listen 8443 ssl; '
  [[ "$mode" == external ]] && listen='listen 80 default_server; listen 443 ssl default_server; '
  [[ "$mode" == custom-port ]] && listen+='listen 443 ssl default_server; '
  printf 'server { %sssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; return 404; }\n' "$listen" \
    >"$work/nginx/conf.d/default.conf"
  docker run -d --name ci-nginx --network host -v "$work/nginx/conf.d:/etc/nginx/conf.d:ro" \
    -v "$work/nginx/tls:/tls:ro" nginx:1.27-alpine >/dev/null
  sleep 2
fi

export IG_BUNDLE_FILE="$dist/a/invoice-generator-installer.tar.gz" IG_TLS_ISSUER=internal

if [[ "$mode" == ip ]]; then
  step 'installer refuses a pre-existing foreign invoice-generator volume'
  docker volume create invoice-generator_data >/dev/null
  expect_failure PROJECT_EXISTS env IG_NONINTERACTIVE=1 IG_ACCESS_HOST="$host" IG_ADMIN_USERNAME=ci-admin \
    IG_ADMIN_PASSWORD_FILE="$work/admin-password" bash "$dist/a/install.sh"
  docker volume inspect invoice-generator_data >/dev/null || fail 'foreign volume was removed'
  docker volume rm invoice-generator_data >/dev/null # created by this test above
  [[ ! -f /opt/invoice-generator/config/installer.env ]] || fail 'refused install left an installation marker'
  rm -rf /opt/invoice-generator

  step 'interactive installation through the real wizard'
  printf '%s' '[["访问地址", "203.0.113.10"], ["HTTPS 端口", ""], ["管理员用户名或邮箱", "ci-admin"], ["管理员密码", "env:IG_TEST_PASSWORD"], ["再次输入密码", "env:IG_TEST_PASSWORD"]]' >"$work/answers.json"
  IG_TEST_PASSWORD="$password" python3 "$root/tests/installer/drive-tty.py" "$work/answers.json" -- bash "$dist/a/install.sh"
elif [[ "$mode" == conflict ]]; then
  step 'an explicitly requested busy port is refused without touching its owner'
  expect_failure HTTPS_PORT_IN_USE env IG_NONINTERACTIVE=1 IG_ACCESS_HOST="$host" IG_HTTPS_PORT=8443 \
    IG_ADMIN_USERNAME=ci-admin IG_ADMIN_PASSWORD_FILE="$work/admin-password" bash "$dist/a/install.sh"
  [[ ! -f /opt/invoice-generator/config/installer.env ]] || fail 'refused install left an installation marker'
  [[ "$(docker inspect --format '{{.State.Running}}' ci-nginx)" == true ]] || fail 'port owner was stopped'
  curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/ | grep -q 404 || fail 'port owner no longer answers'
  rm -rf /opt/invoice-generator

  step 'interactive wizard: busy 8443 is refused, then 9443 is accepted'
  printf '%s' '[["访问地址", "invoice.ci.test"], ["HTTPS 端口", "8443"], ["HTTPS 端口", "9443"], ["管理员用户名或邮箱", "ci-admin"], ["管理员密码", "env:IG_TEST_PASSWORD"], ["再次输入密码", "env:IG_TEST_PASSWORD"]]' >"$work/answers.json"
  IG_TEST_PASSWORD="$password" python3 "$root/tests/installer/drive-tty.py" "$work/answers.json" -- bash "$dist/a/install.sh" |
    tee "$work/wizard.log"
  grep -q '端口 8443 已被占用' "$work/wizard.log" || fail 'busy port was not reported'
elif [[ "$mode" == custom-port ]]; then
  step 'non-interactive installation on HTTPS port 8443 while Nginx keeps 80/443'
  IG_NONINTERACTIVE=1 IG_ACCESS_HOST="$host" IG_HTTPS_PORT=8443 IG_ADMIN_USERNAME=ci-admin \
    IG_ADMIN_PASSWORD_FILE="$work/admin-password" bash "$dist/a/install.sh"
else
  step "non-interactive installation ($mode)"
  IG_NONINTERACTIVE=1 IG_ACCESS_HOST="$host" IG_ADMIN_USERNAME=ci-admin IG_ADMIN_PASSWORD_FILE="$work/admin-password" \
    bash "$dist/a/install.sh"
fi

step 'installation state'
[[ "$(stat -c '%a' /opt/invoice-generator/config/app.env)" == 600 ]] || fail 'app.env is not 0600'
[[ "$(stat -c '%a' /opt/invoice-generator/backups)" == 700 ]] || fail 'backups directory is not 0700'
grep -q '^SESSION_SECRET=[0-9a-f]\{96\}$' /opt/invoice-generator/config/app.env || fail 'session secret not generated'
[[ "$(installed_version)" == v0.0.1-ci.1 ]] || fail 'installed version'
if [[ "$mode" == external ]]; then
  grep -q '^PROXY_MODE=external$' /opt/invoice-generator/config/installer.env || fail 'external mode not selected'
  [[ "$(docker port "$(service_container app)" 3000/tcp)" == 127.0.0.1:3001 ]] || fail 'app must be published on 127.0.0.1:3001 only'
  [[ -z "$(service_container caddy)" ]] || fail 'bundled Caddy must not run'
  step 'enable the generated Nginx configuration'
  sed -e 's#/etc/ssl/certs/REPLACE_WITH_CERTIFICATE.pem#/tls/cert.pem#' -e 's#/etc/ssl/private/REPLACE_WITH_PRIVATE_KEY.pem#/tls/key.pem#' \
    /opt/invoice-generator/proxy/nginx-invoice-generator.conf >"$work/nginx/conf.d/invoice.conf"
  docker exec ci-nginx nginx -t
  docker exec ci-nginx nginx -s reload
  sleep 2
else
  grep -q '^PROXY_MODE=bundled$' /opt/invoice-generator/config/installer.env || fail 'bundled mode not selected'
  grep -q "^HTTPS_PORT=$port$" /opt/invoice-generator/config/installer.env || fail 'HTTPS port not recorded'
  grep -q "^APP_ORIGIN=$origin$" /opt/invoice-generator/config/app.env || fail 'APP_ORIGIN must carry the public port'
  docker port "$(service_container caddy)" 443/tcp | grep -q ":$port$" || fail "Caddy is not published on $port"
  if [[ "$mode" == custom-port ]]; then
    # Nginx (an unrelated program) owns port 80 and the explicit internal CA was required.
    grep -q '^RELAY_ROLE=none$' /opt/invoice-generator/config/installer.env || fail 'relay role must be none'
    docker port "$(service_container caddy)" 80/tcp | grep -q '^127\.0\.0\.1:' || fail 'port 80 must stay loopback-only'
    [[ "$(docker inspect --format '{{.State.Running}}' ci-nginx)" == true ]] || fail 'Nginx was stopped'
    curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:443/ | grep -q 404 || fail 'Nginx no longer owns 443'
  else
    grep -q '^RELAY_ROLE=holder$' /opt/invoice-generator/config/installer.env || fail 'relay role must be holder'
    if [[ "$mode" == conflict ]]; then
      curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/ | grep -q 404 || fail 'Nginx no longer owns 8443'
    fi
    [[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: $host" http://127.0.0.1/x)" == "308 $origin/x" ]] ||
      fail 'HTTP must redirect to the HTTPS origin'
  fi
fi
systemctl is-active --quiet invoice-generator-backup.timer || fail 'backup timer inactive'
if [[ "$mode" != external ]]; then
  # The certificate actually served is reported as it is (the local CA in these tests).
  invoice-generator https | tee "$work/https.log"
  grep -q 'Caddy Local Authority' "$work/https.log" || fail 'served certificate not reported'
  grep -q '本机 CA 证书' "$work/https.log" || fail 'local CA must not be reported as a public certificate'
fi
invoice-generator doctor
invoice-generator status

step 'business data through the public HTTPS entry'
login
# Cookies are host-only, Secure and HttpOnly; the CSRF/Origin check is exact, including the port.
grep -q '#HttpOnly_'"$host"'.*TRUE.*__Host-ft.sid' "$jar" || fail 'session cookie must be Secure and HttpOnly'
wrong_origin="https://$host"
[[ "$port" == 443 ]] && wrong_origin="https://$host:8443"
token="$("${https[@]}" "$origin/api/auth/csrf" | jq -r .csrfToken)"
status="$(curl -s -k -o /dev/null -w '%{http_code}' --connect-to "$host:$port:127.0.0.1:$port" -b "$jar" -X POST \
  "$origin/api/customers" -H "Origin: $wrong_origin" -H "X-CSRF-Token: $token" -H 'Content-Type: application/json' --data '{"id":"x"}')"
[[ "$status" == 403 ]] || fail "a different origin must be refused (got $status)"
api_post /api/customers '{"id":"customer-ci-a","buyerName":"CI Buyer A"}'
[[ "$(customer_count)" == 1 ]] || fail 'customer A not stored'

step 'manual backup and verified restore'
backup="$(invoice-generator backup | sed -n 's/^备份完成：//p')"
[[ -f "$backup" && -f "$backup.sha256" ]] || fail 'backup files missing'
(cd "$(dirname "$backup")" && sha256sum --check --strict --quiet "$(basename "$backup").sha256")
[[ "$(stat -c '%a' "$backup")" == 600 ]] || fail 'backup is not 0600'
api_post /api/customers '{"id":"customer-ci-b","buyerName":"CI Buyer B"}'
[[ "$(customer_count)" == 2 ]] || fail 'customer B not stored'
invoice-generator restore "$backup" --yes
login
[[ "$(customer_count)" == 1 ]] || fail 'restore did not return to the backup state'
pre_restore_summary="$(find /opt/invoice-generator/backups -name '*-pre-restore.json' | sort | tail -n 1)"
[[ -n "$pre_restore_summary" ]] || fail 'pre-restore safety backup missing'
[[ "$(jq '.counts.customers' "$pre_restore_summary")" == 2 ]] || fail 'pre-restore backup does not contain the latest data'

step 'corrupted and tampered backups are refused without touching data'
printf 'not a database' | gzip >"$work/corrupt.sqlite.gz"
(cd "$work" && sha256sum corrupt.sqlite.gz >corrupt.sqlite.gz.sha256)
expect_failure BACKUP_INVALID invoice-generator restore "$work/corrupt.sqlite.gz" --yes
cp "$backup" "$work/tampered.sqlite.gz"
printf '%064d  tampered.sqlite.gz\n' 0 >"$work/tampered.sqlite.gz.sha256"
expect_failure BACKUP_CHECKSUM_MISMATCH invoice-generator restore "$work/tampered.sqlite.gz" --yes
login
[[ "$(customer_count)" == 1 ]] || fail 'refused restore changed data'

step 'upgrade to a new release'
invoice-generator upgrade --bundle "$dist/b/invoice-generator-installer.tar.gz" --sha256 "$(sha b)" --yes
[[ "$(installed_version)" == v0.0.1-ci.2 ]] || fail 'upgrade version'
[[ "$(running_image)" == invoice-generator:ci-b ]] || fail 'upgrade image'
login
[[ "$(customer_count)" == 1 ]] || fail 'upgrade lost data'

step 'a release that fails isolated validation is never promoted'
expect_failure CANDIDATE_FAILED invoice-generator upgrade --bundle "$dist/broken/invoice-generator-installer.tar.gz" --sha256 "$(sha broken)" --yes
[[ "$(installed_version)" == v0.0.1-ci.2 && "$(running_image)" == invoice-generator:ci-b ]] || fail 'failed candidate changed production'

step 'a release that fails after promotion is rolled back with the pre-upgrade data'
login
api_post /api/customers '{"id":"customer-ci-c","buyerName":"CI Buyer C"}'
expect_failure UPGRADE_ROLLED_BACK invoice-generator upgrade --bundle "$dist/late/invoice-generator-installer.tar.gz" --sha256 "$(sha late)" --yes
[[ "$(installed_version)" == v0.0.1-ci.2 && "$(running_image)" == invoice-generator:ci-b ]] || fail 'rollback version'
invoice-generator doctor
login
[[ "$(customer_count)" == 2 ]] || fail 'rollback did not return to the pre-upgrade data'
failed_summary="$(find /opt/invoice-generator/backups -name '*-failed-upgrade.json' | sort | tail -n 1)"
[[ -n "$failed_summary" ]] || fail 'database written after the switch was not preserved'
[[ "$(jq '.counts.customers' "$failed_summary")" == 3 ]] || fail 'preserved database is missing the record written after the switch'

step 'wrong checksums and downgrades are refused'
expect_failure RELEASE_CHECKSUM_MISMATCH invoice-generator upgrade --bundle "$dist/b/invoice-generator-installer.tar.gz" --sha256 "$(printf '0%.0s' {1..64})" --yes
expect_failure DOWNGRADE_REFUSED invoice-generator upgrade --bundle "$dist/a/invoice-generator-installer.tar.gz" --sha256 "$(sha a)" --yes

step 'automatic backup rotation keeps manual and upgrade backups'
sed -i 's/^BACKUP_KEEP=.*/BACKUP_KEEP=2/' /opt/invoice-generator/config/installer.env
for _ in 1 2 3; do
  invoice-generator backup --auto >/dev/null
  sleep 1
done
[[ "$(find /opt/invoice-generator/backups -name '*-auto.sqlite.gz' | wc -l)" == 2 ]] || fail 'auto backup rotation'
[[ -f "$backup" ]] || fail 'rotation removed a manual backup'
find /opt/invoice-generator/backups -name '*-pre-upgrade.sqlite.gz' | grep -q . || fail 'rotation removed pre-upgrade backups'
systemctl start invoice-generator-backup.service

step 're-running the installer opens the menu and changes nothing'
before="$(sha256sum /opt/invoice-generator/config/app.env)"
IG_NONINTERACTIVE=1 bash "$dist/b/install.sh" </dev/null
[[ "$(sha256sum /opt/invoice-generator/config/app.env)" == "$before" ]] || fail 'installer rerun changed configuration'

step 'isolation: neighbour project, no leftovers, data volume kept'
[[ "$(docker exec neighbor-app cat /data/marker)" == keep-me ]] || fail 'neighbour data changed'
[[ "$(docker inspect --format '{{.State.Running}}' neighbor-app)" == true ]] || fail 'neighbour stopped'
[[ -z "$(docker ps -aq --filter name=invoice-generator-candidate)" ]] || fail 'candidate container left behind'
[[ -z "$(docker volume ls -q --filter label=invoice-generator.candidate=1)" ]] || fail 'candidate volume left behind'
docker volume inspect invoice-generator_data >/dev/null || fail 'data volume missing'
invoice-generator doctor
printf '\nE2E PASS (%s)\n' "$mode"
