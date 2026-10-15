#!/usr/bin/env bash
# Upgrade path from a published release candidate (v0.1.0-rc.8, shared HTTPS gateway, as on the
# acceptance VPS) to a stable release built from this checkout. Runs ONLY as root on a disposable
# GitHub Actions runner. RC command-line tools compared versions with `sort -V`, which ranks
# v0.1.0 below v0.1.0-rc.8, so they refuse the upgrade; the documented path runs the new
# release's own management command once (docs/INSTALL.md).
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "$(id -u)" -eq 0 ]] || {
  echo 'refusing to run outside a disposable GitHub Actions runner as root' >&2
  exit 1
}
fail() {
  echo "RC TO STABLE FAIL: $*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

work="$(mktemp -d)"
host=invoice.ci.test
jar="$work/cookies"
printf 'TEST-rc-%s' "$(openssl rand -hex 12)" >"$work/admin-password"
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

step 'install the published v0.1.0-rc.8 behind the shared HTTPS gateway'
base=https://github.com/cobrander-dev/invoice-generator-oss/releases/download/v0.1.0-rc.8
for asset in install.sh invoice-generator-installer.tar.gz SHA256SUMS; do
  curl -fsSL --proto '=https' "$base/$asset" -o "$work/$asset"
done
(cd "$work" && sha256sum --check --strict --ignore-missing SHA256SUMS)
OSS_GATEWAY_LOCAL_CERTS=1 IG_NONINTERACTIVE=1 IG_HTTPS_MODE=gateway IG_ACCESS_HOST="$host" IG_TLS_ISSUER=internal \
  IG_ADMIN_USERNAME=ci-admin IG_ADMIN_PASSWORD_FILE="$work/admin-password" bash "$work/install.sh"
login
token="$("${https[@]}" "https://$host/api/auth/csrf" | jq -r .csrfToken)"
"${https[@]}" -X POST "https://$host/api/customers" -H "Origin: https://$host" -H "X-CSRF-Token: $token" \
  -H 'Content-Type: application/json' --data '{"id":"customer-rc","buyerName":"RC Buyer"}' >/dev/null
[[ "$(customers)" == 1 ]] || fail 'customer not stored'
site_before="$(sha256sum /opt/oss-gateway/sites/invoice-generator.caddy)"

step 'build a stable v0.1.0 bundle from this checkout'
docker build -q -t invoice-generator:ci-stable "$root" >/dev/null
IG_ALLOW_LOCAL_IMAGES=1 "$root/scripts/build-installer-bundle.sh" v0.1.0 invoice-generator:ci-stable \
  caddy:2.11.4-alpine "$work/stable" >/dev/null
sha="$(awk '$2 == "invoice-generator-installer.tar.gz" {print $1}' "$work/stable/SHA256SUMS")"

step 'the RC management command refuses it and changes nothing'
if output="$(invoice-generator upgrade --bundle "$work/stable/invoice-generator-installer.tar.gz" --sha256 "$sha" --yes 2>&1)"; then
  fail 'the RC command unexpectedly upgraded'
fi
printf '%s\n' "$output" | tail -n 3
[[ "$output" == *DOWNGRADE_REFUSED* ]] || fail 'expected the RC version-order refusal'
[[ "$(invoice-generator version)" == 'Invoice Generator v0.1.0-rc.8' ]] || fail 'refusal changed the version'

step 'the stable release runs its own management command once (documented path)'
mkdir "$work/new"
tar -xzf "$work/stable/invoice-generator-installer.tar.gz" -C "$work/new"
bash "$work/new/invoice-generator" upgrade --bundle "$work/stable/invoice-generator-installer.tar.gz" --sha256 "$sha" --yes
[[ "$(invoice-generator version)" == 'Invoice Generator v0.1.0' ]] || fail 'version after upgrade'
grep -q '^GATEWAY=yes$' /opt/invoice-generator/config/installer.env || fail 'gateway mode lost'
[[ "$(sha256sum /opt/oss-gateway/sites/invoice-generator.caddy)" == "$site_before" ]] || fail 'gateway site changed'
login
[[ "$(customers)" == 1 ]] || fail 'upgrade lost data'
invoice-generator doctor
# From now on the installed command orders versions correctly.
grep -q 'semver_gt "$new_version" "$old_version"' /opt/invoice-generator/current/invoice-generator || fail 'installed CLI'
printf '\nRC TO STABLE PASS\n'
