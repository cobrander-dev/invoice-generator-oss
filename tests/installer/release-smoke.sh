#!/usr/bin/env bash
# Installs a built release (install.sh + bundle + digest-pinned GHCR images) on a disposable
# GitHub Actions runner and checks it end to end. usage: sudo -E release-smoke.sh DIST_DIR
set -Eeuo pipefail

dist="${1:?dist directory}"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "$(id -u)" -eq 0 ]] ||
  {
    echo 'refusing to run outside a disposable GitHub Actions runner as root' >&2
    exit 1
  }
fail() {
  echo "RELEASE SMOKE FAIL: $*" >&2
  exit 1
}

(cd "$dist" && sha256sum --check --strict SHA256SUMS)
work="$(mktemp -d)"
printf 'TEST-release-%s' "$(openssl rand -hex 12)" >"$work/admin-password"
chmod 600 "$work/admin-password"

IG_NONINTERACTIVE=1 IG_BUNDLE_FILE="$dist/invoice-generator-installer.tar.gz" IG_ACCESS_HOST=invoice.ci.test \
  IG_TLS_ISSUER=internal IG_ADMIN_USERNAME=ci-admin IG_ADMIN_PASSWORD_FILE="$work/admin-password" \
  bash "$dist/install.sh"

image="$(awk -F= '$1 == "APP_IMAGE" {print $2}' /opt/invoice-generator/current/release.env)"
[[ "$image" =~ ^ghcr\.io/.+@sha256:[0-9a-f]{64}$ ]] || fail "image not digest-pinned: $image"
running="$(docker inspect --format '{{.Config.Image}}' "$(docker ps -q --filter label=com.docker.compose.project=invoice-generator --filter label=com.docker.compose.service=app)")"
[[ "$running" == "$image" ]] || fail "running image $running differs from release $image"
invoice-generator doctor
invoice-generator backup
curl -fsS -k --connect-to invoice.ci.test:443:127.0.0.1:443 https://invoice.ci.test/login | grep -q 'csrf' ||
  fail 'login page not served'
echo 'RELEASE SMOKE PASS'
