#!/usr/bin/env bash
# Builds the release installer assets into OUTPUT_DIR:
#   invoice-generator-installer.tar.gz  bundle (setup wizard, CLI, compose files, release.env)
#   install.sh                          bootstrap with version and bundle SHA-256 embedded
#   SHA256SUMS                          checksums of both
#
# usage: scripts/build-installer-bundle.sh VERSION APP_IMAGE CADDY_IMAGE OUTPUT_DIR [REPOSITORY]
# Production images must be digest references (name@sha256:...); local tags are accepted
# only with IG_ALLOW_LOCAL_IMAGES=1 for isolated tests.
set -Eeuo pipefail
umask 022

version="${1:?version}"
app_image="${2:?app image}"
caddy_image="${3:?caddy image}"
output="${4:?output directory}"
repository="${5:-cobrander-dev/invoice-generator-oss}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid version: $version" >&2
  exit 1
}
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "invalid repository: $repository" >&2
  exit 1
}
if [[ "${IG_ALLOW_LOCAL_IMAGES:-0}" != 1 ]]; then
  for image in "$app_image" "$caddy_image"; do
    [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || {
      echo "image must be pinned by digest: $image" >&2
      exit 1
    }
  done
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
mkdir -p "$output" "$staging/bundle"
cp -a "$root/installer/bundle/." "$staging/bundle/"
cp "$root/LICENSE" "$staging/bundle/LICENSE"
cat >"$staging/bundle/release.env" <<EOF
VERSION=$version
APP_IMAGE=$app_image
CADDY_IMAGE=$caddy_image
REPOSITORY=$repository
EOF
chmod 755 "$staging/bundle/setup.sh" "$staging/bundle/invoice-generator"
(
  cd "$staging/bundle"
  find . -type f ! -name MANIFEST.sha256 -printf '%P\n' | LC_ALL=C sort | xargs sha256sum >MANIFEST.sha256
)
# Reproducible archive: fixed owner, mtime and ordering.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00:00Z' \
  -C "$staging/bundle" -cf - . | gzip -n -9 >"$output/invoice-generator-installer.tar.gz"
bundle_sha="$(sha256sum "$output/invoice-generator-installer.tar.gz" | awk '{print $1}')"
sed -e "s|@REPOSITORY@|$repository|g" -e "s|@VERSION@|$version|g" -e "s|@BUNDLE_SHA256@|$bundle_sha|g" \
  "$root/installer/install.sh" >"$output/install.sh"
chmod 755 "$output/install.sh"
(cd "$output" && sha256sum invoice-generator-installer.tar.gz install.sh >SHA256SUMS)
printf 'bundle %s %s\n' "$version" "$bundle_sha"
