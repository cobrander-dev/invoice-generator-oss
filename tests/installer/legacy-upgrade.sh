#!/usr/bin/env bash
# Upgrade from the published v0.1.0-rc.6 (before custom HTTPS ports) to this checkout. Runs ONLY
# as root on a disposable GitHub Actions runner. The old CLI performs the upgrade with the new
# compose files, so they must keep 80/443 by default; afterwards `https --apply` turns the
# installation into the port-80 relay holder without touching data, port or certificates.
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "$(id -u)" -eq 0 ]] || {
  echo 'refusing to run outside a disposable GitHub Actions runner as root' >&2
  exit 1
}
fail() {
  echo "LEGACY UPGRADE FAIL: $*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

work="$(mktemp -d)"
host=invoice.ci.test
jar="$work/cookies"
printf 'TEST-legacy-%s' "$(openssl rand -hex 12)" >"$work/admin-password"
chmod 600 "$work/admin-password"
https=(curl -fsS -k --max-time 20 --connect-to "$host:443:127.0.0.1:443" -b "$jar" -c "$jar")
login() {
  rm -f "$jar"
  local token
  token="$("${https[@]}" "https://$host/login" | grep -oE '[a-f0-9]{112}' | head -n 1)"
  jq -n --arg u ci-admin --rawfile p "$work/admin-password" '{username: $u, password: $p}' >"$work/login.json"
  "${https[@]}" -X POST "https://$host/api/auth/login" -H "Origin: https://$host" -H "X-CSRF-Token: $token" \
    -H 'Content-Type: application/json' --data @"$work/login.json" >/dev/null
}
customers() { "${https[@]}" "https://$host/api/customers" | jq '.data | length'; }

step 'install the published v0.1.0-rc.6'
base=https://github.com/cobrander-dev/invoice-generator-oss/releases/download/v0.1.0-rc.6
for asset in install.sh invoice-generator-installer.tar.gz SHA256SUMS; do
  curl -fsSL --proto '=https' "$base/$asset" -o "$work/$asset"
done
(cd "$work" && sha256sum --check --strict --ignore-missing SHA256SUMS)
IG_NONINTERACTIVE=1 IG_ACCESS_HOST="$host" IG_TLS_ISSUER=internal IG_ADMIN_USERNAME=ci-admin \
  IG_ADMIN_PASSWORD_FILE="$work/admin-password" bash "$work/install.sh"
login
token="$("${https[@]}" "https://$host/api/auth/csrf" | jq -r .csrfToken)"
"${https[@]}" -X POST "https://$host/api/customers" -H "Origin: https://$host" -H "X-CSRF-Token: $token" \
  -H 'Content-Type: application/json' --data '{"id":"customer-legacy","buyerName":"Legacy Buyer"}' >/dev/null
[[ "$(customers)" == 1 ]] || fail 'customer not stored'

step 'upgrade with the old CLI to a bundle built from this checkout'
docker build -q -t invoice-generator:ci-new "$root" >/dev/null
IG_ALLOW_LOCAL_IMAGES=1 "$root/scripts/build-installer-bundle.sh" v0.1.1-ci.1 invoice-generator:ci-new \
  caddy:2.11.4-alpine "$work/new" >/dev/null
sha="$(awk '$2 == "invoice-generator-installer.tar.gz" {print $1}' "$work/new/SHA256SUMS")"
invoice-generator upgrade --bundle "$work/new/invoice-generator-installer.tar.gz" --sha256 "$sha" --yes
[[ "$(invoice-generator version)" == 'Invoice Generator v0.1.1-ci.1' ]] || fail 'version after upgrade'
! grep -q '^HTTPS_PORT=' /opt/invoice-generator/config/installer.env || fail 'upgrade must not invent settings'
login
[[ "$(customers)" == 1 ]] || fail 'upgrade lost data'
caddy="$(docker ps -q --filter label=com.docker.compose.project=invoice-generator --filter label=com.docker.compose.service=caddy)"
docker port "$caddy" 80/tcp | grep -q '0.0.0.0:80$' || fail 'port 80 changed by the upgrade'
docker port "$caddy" 443/tcp | grep -q '0.0.0.0:443$' || fail 'port 443 changed by the upgrade'
invoice-generator doctor | tee "$work/doctor.log"
grep -q 'https --apply' "$work/doctor.log" || fail 'doctor must mention https --apply for legacy installs'

step 'https --apply makes the legacy install the port-80 relay holder'
invoice-generator https --apply
grep -q '^RELAY_ROLE=holder$' /opt/invoice-generator/config/installer.env || fail 'relay role not saved'
caddy="$(docker ps -q --filter label=com.docker.compose.project=invoice-generator --filter label=com.docker.compose.service=caddy)"
[[ "$(docker inspect --format '{{index .Config.Labels "oss.https-relay"}}' "$caddy")" == holder ]] || fail 'holder label missing'
docker network inspect oss-https-relay --format '{{range .Containers}}{{.Name}} {{end}}' | grep -q invoice-generator ||
  fail 'not attached to the relay network'
login
[[ "$(customers)" == 1 ]] || fail 'apply changed data'
[[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: $host" http://127.0.0.1/x)" == "308 https://$host/x" ]] ||
  fail 'HTTP redirect after apply'
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: other.ci.test' -H 'X-OSS-HTTPS-Relay: 1' http://127.0.0.1/x)" == 421 ]] ||
  fail 'relay loop guard'
invoice-generator doctor
printf '\nLEGACY UPGRADE PASS\n'
