#!/usr/bin/env bash
# shellcheck disable=SC2034 # variables are consumed by the scripts that source this library
# Shared helpers for the Invoice Generator setup wizard and management command.
# Everything Invoice Generator owns lives under IG_ROOT and in the Docker Compose project
# "invoice-generator"; no command here touches other Compose projects, prunes Docker or
# removes the data volume.

IG_ROOT="${IG_ROOT:-/opt/invoice-generator}"
IG_PROJECT=invoice-generator
IG_CONFIG_DIR="$IG_ROOT/config"
IG_INSTALLER_ENV="$IG_CONFIG_DIR/installer.env"
IG_APP_ENV="$IG_CONFIG_DIR/app.env"
IG_CADDYFILE="$IG_CONFIG_DIR/Caddyfile"
IG_BACKUP_DIR="$IG_ROOT/backups"
IG_RELEASES_DIR="$IG_ROOT/releases"
IG_CURRENT="$IG_ROOT/current"
IG_PROXY_DIR="$IG_ROOT/proxy"
IG_LOCK_FILE="$IG_ROOT/.lock"
IG_DATA_VOLUME="${IG_PROJECT}_data"
IG_DATABASE_PATH=/app/data/invoice-generator.sqlite
IG_CLI_LINK=/usr/local/bin/invoice-generator
# Shared with other self-hosted projects on the same server (see docs/HTTPS_PORTS.md): the
# project whose proxy owns host port 80 relays ACME HTTP-01 challenges to the others.
IG_RELAY_NETWORK=oss-https-relay
IG_ACME_CA_ROOT_FILE="$IG_CONFIG_DIR/acme-ca-root.pem"

say() { printf '%s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
warn() { printf '提示：%s\n' "$*" >&2; }
# die CODE MESSAGE: stable error code for troubleshooting plus a Chinese explanation.
die() {
  printf '失败 [%s]：%s\n' "$1" "${2:-}" >&2
  exit 1
}

require_root() { [[ "$(id -u)" -eq 0 ]] || die ROOT_REQUIRED '请使用 root 运行，或在命令前加 sudo。'; }

# Reads KEY from a KEY=VALUE file without evaluating it as shell code.
env_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$file"
}

# Writes KEY=VALUE pairs atomically with mode 0600. Values must be single-line.
write_env_file() {
  local file="$1" temporary
  shift
  temporary="$(mktemp "${file}.XXXXXX")"
  chmod 600 "$temporary"
  while [[ $# -gt 0 ]]; do
    [[ "$1" != *$'\n'* && "$1" == *=* ]] || {
      rm -f -- "$temporary"
      die CONFIG_INVALID "配置值无效：${1%%=*}"
    }
    printf '%s\n' "$1" >>"$temporary"
    shift
  done
  mv -f -- "$temporary" "$file"
}

set_env_value() {
  local file="$1" key="$2" value="$3" temporary
  [[ "$value" != *$'\n'* ]] || die CONFIG_INVALID "配置值无效：$key"
  temporary="$(mktemp "${file}.XXXXXX")"
  chmod 600 "$temporary"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" >"$temporary"
  mv -f -- "$temporary" "$file"
}

valid_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for part in "${BASH_REMATCH[@]:1}"; do
    [[ "$part" =~ ^(0|[1-9][0-9]*)$ && "$part" -le 255 ]] || return 1
  done
}

# Public unicast IPv4 only; private ranges are allowed solely for isolated tests.
public_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ _ <<<"$1"
  [[ "${IG_ALLOW_PRIVATE_IP:-0}" == 1 ]] && return 0
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 1
  ((a == 100 && b >= 64 && b <= 127)) && return 1
  ((a == 169 && b == 254)) && return 1
  ((a == 172 && b >= 16 && b <= 31)) && return 1
  ((a == 192 && b == 168)) && return 1
  return 0
}

load_settings() {
  [[ -f "$IG_INSTALLER_ENV" ]] || die NOT_INSTALLED "未找到安装配置 ${IG_INSTALLER_ENV}。"
  IG_ACCESS_HOST="$(env_get "$IG_INSTALLER_ENV" ACCESS_HOST)"
  IG_ACCESS_KIND="$(env_get "$IG_INSTALLER_ENV" ACCESS_KIND)"
  IG_PROXY_MODE="$(env_get "$IG_INSTALLER_ENV" PROXY_MODE)"
  IG_APP_PORT="$(env_get "$IG_INSTALLER_ENV" APP_PORT)"
  IG_TLS_ISSUER="$(env_get "$IG_INSTALLER_ENV" TLS_ISSUER)"
  IG_BACKUP_KEEP="$(env_get "$IG_INSTALLER_ENV" BACKUP_KEEP)"
  # Installations made before custom ports existed use 443/80 and no relay role.
  IG_HTTPS_PORT="$(env_get "$IG_INSTALLER_ENV" HTTPS_PORT)"
  IG_HTTPS_PORT="${IG_HTTPS_PORT:-443}"
  IG_HTTP_BIND="$(env_get "$IG_INSTALLER_ENV" HTTP_BIND)"
  IG_HTTP_BIND="${IG_HTTP_BIND:-80}"
  IG_RELAY_ROLE="$(env_get "$IG_INSTALLER_ENV" RELAY_ROLE)"
  IG_ACME_CA="$(env_get "$IG_INSTALLER_ENV" ACME_CA)"
  IG_GATEWAY="$(env_get "$IG_INSTALLER_ENV" GATEWAY)"
  IG_GATEWAY="${IG_GATEWAY:-no}"
  [[ "$IG_ACCESS_KIND" == domain || "$IG_ACCESS_KIND" == ip ]] || die CONFIG_INVALID 'ACCESS_KIND 无效。'
  [[ "$IG_PROXY_MODE" == bundled || "$IG_PROXY_MODE" == external ]] || die CONFIG_INVALID 'PROXY_MODE 无效。'
  [[ "$IG_APP_PORT" =~ ^[0-9]+$ ]] || die CONFIG_INVALID 'APP_PORT 无效。'
  [[ "${IG_BACKUP_KEEP:-14}" =~ ^[1-9][0-9]*$ ]] || die CONFIG_INVALID 'BACKUP_KEEP 无效。'
  valid_https_port "$IG_HTTPS_PORT" || die CONFIG_INVALID 'HTTPS_PORT 无效。'
  [[ "$IG_HTTP_BIND" == 80 || "$IG_HTTP_BIND" =~ ^127\.0\.0\.1:[0-9]+$ ]] || die CONFIG_INVALID 'HTTP_BIND 无效。'
  [[ -z "$IG_RELAY_ROLE" || "$IG_RELAY_ROLE" =~ ^(holder|member|none)$ ]] || die CONFIG_INVALID 'RELAY_ROLE 无效。'
  IG_BACKUP_KEEP="${IG_BACKUP_KEEP:-14}"
}

# Reads version and pinned image references of a release directory into IG_* variables.
load_release() {
  local release_dir="$1"
  [[ -f "$release_dir/release.env" ]] || die RELEASE_INVALID "发布目录缺少 release.env：$release_dir"
  IG_VERSION="$(env_get "$release_dir/release.env" VERSION)"
  IG_APP_IMAGE="$(env_get "$release_dir/release.env" APP_IMAGE)"
  IG_CADDY_IMAGE="$(env_get "$release_dir/release.env" CADDY_IMAGE)"
  [[ -n "$IG_VERSION" && -n "$IG_APP_IMAGE" && -n "$IG_CADDY_IMAGE" ]] ||
    die RELEASE_INVALID "release.env 不完整：$release_dir"
}

# compose_in RELEASE_DIR ARGS... runs Docker Compose for the fixed project using that release.
compose_in() {
  local release_dir="$1" files
  shift
  load_release "$release_dir"
  files=(-f "$release_dir/compose/compose.yaml")
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    files+=(-f "$release_dir/compose/compose.https.yaml")
    # Releases older than custom ports have no relay file; they keep 80/443 as before.
    if [[ -n "${IG_RELAY_ROLE:-}" && -f "$release_dir/compose/compose.relay.yaml" ]]; then
      files+=(-f "$release_dir/compose/compose.relay.yaml")
    fi
    if [[ -n "${IG_ACME_CA:-}" && -f "$release_dir/compose/compose.acme-ca.yaml" ]]; then
      files+=(-f "$release_dir/compose/compose.acme-ca.yaml")
    fi
  else
    files+=(-f "$release_dir/compose/compose.external.yaml")
  fi
  IG_APP_IMAGE="$IG_APP_IMAGE" IG_CADDY_IMAGE="$IG_CADDY_IMAGE" IG_CONFIG_DIR="$IG_CONFIG_DIR" \
    IG_APP_PORT="$IG_APP_PORT" IG_HTTPS_PORT="${IG_HTTPS_PORT:-443}" IG_HTTP_BIND="${IG_HTTP_BIND:-80}" \
    IG_RELAY_ROLE="${IG_RELAY_ROLE:-}" IG_RELAY_ALIAS="$(relay_alias "${IG_ACCESS_HOST:-}")" \
    IG_ACME_CA_ROOT_FILE="$IG_ACME_CA_ROOT_FILE" docker compose -p "$IG_PROJECT" "${files[@]}" "$@"
}
compose() { compose_in "$IG_CURRENT" "$@"; }

# quietly COMMAND...: hides routine progress output, prints it only when the command fails.
quietly() {
  local output status=0
  output="$("$@" 2>&1)" || status=$?
  [[ "$status" -eq 0 ]] || printf '%s\n' "$output" >&2
  return "$status"
}

ensure_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 && return 0
  say "下载镜像 $image ..."
  docker pull --quiet "$image" >/dev/null || die IMAGE_PULL_FAILED "无法下载镜像 ${image}，请检查网络。"
}

container_healthy() {
  local container="$1" health=''
  [[ -n "$container" ]] || return 1
  for _ in $(seq 1 "${IG_HEALTH_ATTEMPTS:-60}"); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$health" == healthy ]] && return 0
    [[ "$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null)" == exited ]] && return 1
    sleep 2
  done
  return 1
}

app_healthy() { container_healthy "$(compose_in "${1:-$IG_CURRENT}" ps -q app 2>/dev/null)"; }

# Public origin used for links, the exact Origin/CSRF check and cookies: the port is part of
# the origin unless it is the standard 443.
public_origin() {
  local host="$1" port="${2:-443}"
  if [[ "$port" == 443 ]]; then printf 'https://%s' "$host"; else printf 'https://%s:%s' "$host" "$port"; fi
}

# End-to-end check through the public entry point configured for this installation.
entry_healthy() {
  local url port="${IG_HTTPS_PORT:-443}"
  if [[ "$IG_PROXY_MODE" == bundled || "${IG_GATEWAY:-no}" == yes ]]; then
    url="$(public_origin "$IG_ACCESS_HOST" "$port")/health"
    for _ in $(seq 1 30); do
      curl -fsS --max-time 5 -k --connect-to "$IG_ACCESS_HOST:$port:127.0.0.1:$port" "$url" >/dev/null 2>&1 && return 0
      sleep 2
    done
    return 1
  fi
  curl -fsS --max-time 5 "http://127.0.0.1:$IG_APP_PORT/health" >/dev/null 2>&1
}

with_lock() {
  mkdir -p "$IG_ROOT"
  exec 9>"$IG_LOCK_FILE"
  chmod 600 "$IG_LOCK_FILE"
  flock -n 9 || die BUSY '另一个 invoice-generator 操作正在进行，请稍后再试。'
}

port_in_use() {
  ss -H -ltn "( sport = :$1 )" 2>/dev/null | grep -q .
}

free_loopback_port() {
  local port
  for port in $(seq "${1:-3001}" "${2:-3099}"); do
    port_in_use "$port" || host_port_published "$port" || {
      printf '%s' "$port"
      return 0
    }
  done
  return 1
}

# 443, or an unprivileged port. 80 stays reserved for HTTP and certificate validation.
valid_https_port() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && { [[ "$1" == 443 ]] || ((10#$1 >= 1024 && 10#$1 <= 65535)); }
}

# A port Docker publishes may be invisible to ss when the userland proxy is disabled.
host_port_published() {
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq "(^|[ ,])[^ ,]*:$1->"
}

# Busy when any process listens on the TCP or UDP port or a container publishes it.
host_port_busy() {
  ss -H -ltnu "( sport = :$1 )" 2>/dev/null | grep -q . || host_port_published "$1"
}

# Human readable owner of a port: container names first, otherwise the process name.
port_owner() {
  local port="$1" owner
  owner="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null |
    awk -v p=":$port->" 'index($0, p) { printf "%s容器 %s", sep, $1; sep = "、" }')"
  [[ -n "$owner" ]] || owner="$(ss -H -ltnup "( sport = :$port )" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n 1 | cut -d'"' -f2)"
  printf '%s' "${owner:-未知程序}"
}

# Container that publishes host port $1 (first match), empty when none.
port_container() {
  docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null | awk -v p=":$1->" '
    { n = split($0, f, /[ ,]+/); for (i = 2; i <= n; i++) if (index(f[i], p) && f[i] !~ /^127\./) { print $1; exit } }'
}

own_container() {
  [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$1" 2>/dev/null)" == "$IG_PROJECT" ]]
}

relay_alias() {
  [[ -n "$1" ]] && printf '%s.acme-relay.invalid' "$1"
  return 0
}

# Decides how this installation gets certificates when other projects share the server:
#   holder  host port 80 is free (or already ours): publish 80, answer HTTP-01 and relay the
#           challenges of other projects' hostnames to them
#   member  port 80 belongs to another project's proxy labelled oss.https-relay=holder: its
#           relay forwards our HTTP-01 challenges (domain installs only)
#   none    port 80 belongs to an unrelated program: no HTTP-01; TLS-ALPN-01 only on 443
# Sets IG_RELAY_ROLE, IG_HTTP_BIND and IG_PORT80_OWNER.
decide_relay_role() {
  local container
  IG_PORT80_OWNER=''
  container="$(port_container 80)"
  if [[ -n "$container" ]] && own_container "$container"; then
    IG_RELAY_ROLE=holder
  elif [[ -z "$container" ]] && ! host_port_busy 80; then
    IG_RELAY_ROLE=holder
  elif [[ -n "$container" && "$IG_ACCESS_KIND" == domain &&
    "$(docker inspect --format '{{index .Config.Labels "oss.https-relay"}}' "$container" 2>/dev/null)" == holder ]]; then
    IG_RELAY_ROLE=member
    IG_PORT80_OWNER="$(port_owner 80)"
  else
    IG_RELAY_ROLE=none
    IG_PORT80_OWNER="$(port_owner 80)"
  fi
  if [[ "$IG_RELAY_ROLE" == holder ]]; then
    IG_HTTP_BIND=80
  else
    # Caddy still listens on container port 80 for relayed challenges; publish it on loopback only.
    IG_HTTP_BIND="127.0.0.1:$(free_loopback_port 18080 18179)" || die NO_FREE_PORT '127.0.0.1:18080-18179 没有空闲端口。'
  fi
}

ensure_relay_network() {
  docker network inspect "$IG_RELAY_NETWORK" >/dev/null 2>&1 ||
    docker network create --label oss.https-relay=1 "$IG_RELAY_NETWORK" >/dev/null 2>&1 ||
    docker network inspect "$IG_RELAY_NETWORK" >/dev/null 2>&1 ||
    die RELAY_NETWORK_FAILED "无法创建共享网络 ${IG_RELAY_NETWORK}。"
}

# Issuer of the certificate served on the local HTTPS port (empty when none is served yet).
served_certificate() {
  local host="$1" port="$2" sni=()
  [[ "$IG_ACCESS_KIND" == ip ]] || sni=(-servername "$host")
  openssl s_client -connect "127.0.0.1:$port" "${sni[@]}" </dev/null 2>/dev/null |
    openssl x509 -noout -issuer -enddate 2>/dev/null || true
}

# Waits for a certificate and reports honestly which kind is served. Returns 0 only for a
# certificate from an ACME CA; 2 for Caddy's local CA; 1 when nothing is served yet.
report_certificate() {
  local wait="${1:-0}" certificate='' deadline
  deadline=$(($(date +%s) + wait))
  while true; do
    certificate="$(served_certificate "$IG_ACCESS_HOST" "${IG_HTTPS_PORT:-443}")"
    if [[ -n "$certificate" && "$certificate" != *'Caddy Local Authority'* ]]; then break; fi
    [[ -n "$certificate" && "${IG_TLS_ISSUER:-auto}" == internal ]] && break
    (($(date +%s) < deadline)) || break
    sleep 5
  done
  if [[ -z "$certificate" ]]; then
    say '证书状态：尚未获得证书（仍在申请中或申请失败）。'
    return 1
  fi
  say "证书签发者：$(printf '%s\n' "$certificate" | sed -n 's/^issuer=//p' | sed 's/^ *//')"
  say "证书到期：$(printf '%s\n' "$certificate" | sed -n 's/^notAfter=//p')"
  if [[ "$certificate" == *'Caddy Local Authority'* ]]; then
    say '证书状态：本机 CA 证书（浏览器默认不信任）。'
    return 2
  fi
  say '证书状态：已获得 ACME 证书，Caddy 会在到期前自动续期。'
}

# Runs a short-lived helper container from the application image against the data volume.
data_helper() {
  local image="$1"
  shift
  docker run --rm --network none --user 0 --entrypoint sh -v "$IG_DATA_VOLUME:/app/data" "$@" "$image" -c "$IG_HELPER_SCRIPT"
}

# verify_database_file IMAGE FILE: integrity and schema compatibility check inside the image.
verify_database_file() {
  local image="$1" file="$2" directory output status
  directory="$(dirname -- "$file")"
  set +e
  output="$(docker run --rm --network none --user 0 --entrypoint node \
    -v "$directory:/verify:ro" "$image" server/scripts/verify-database.js "/verify/$(basename -- "$file")" 2>&1)"
  status=$?
  set -e
  IG_VERIFY_RESULT="$output"
  return "$status"
}

backup_files() {
  find "$IG_BACKUP_DIR" -maxdepth 1 -type f -name 'invoice-generator-*.sqlite.gz' -printf '%f\n' 2>/dev/null | sort
}

# create_backup KIND [RELEASE_DIR]: consistent online SQLite backup copied out of the volume,
# verified, compressed and checksummed. Prints the backup path on the last line.
create_backup() {
  local kind="$1" release_dir="${2:-$IG_CURRENT}" stamp name work result
  [[ "$kind" =~ ^(auto|manual|pre-upgrade|pre-restore|final-pre-upgrade|failed-upgrade|failed-restore)$ ]] || die BACKUP_KIND_INVALID "$kind"
  load_release "$release_dir"
  install -d -m 0700 "$IG_BACKUP_DIR"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="invoice-generator-${stamp}-${kind}"
  work="$(mktemp -d "$IG_BACKUP_DIR/.work.XXXXXX")"
  IG_HELPER_SCRIPT="set -eu
    DATABASE_PATH='$IG_DATABASE_PATH' BACKUP_PATH='/app/data/backups/$name.sqlite' node server/scripts/backup-database.js >/dev/null
    mv '/app/data/backups/$name.sqlite' /out/database.sqlite
    chmod 600 /out/database.sqlite"
  if ! data_helper "$IG_APP_IMAGE" -v "$work:/out"; then
    rm -rf -- "$work"
    die BACKUP_FAILED '数据库备份失败，正式数据未被修改。'
  fi
  if ! verify_database_file "$IG_APP_IMAGE" "$work/database.sqlite"; then
    rm -rf -- "$work"
    die BACKUP_VERIFY_FAILED "备份校验失败：$IG_VERIFY_RESULT"
  fi
  result="$IG_VERIFY_RESULT"
  gzip -9 -c "$work/database.sqlite" >"$work/$name.sqlite.gz"
  (cd "$work" && sha256sum "$name.sqlite.gz" >"$name.sqlite.gz.sha256")
  printf '%s\n' "$result" >"$work/$name.json"
  chmod 600 "$work/$name".*
  mv -f -- "$work/$name.sqlite.gz" "$work/$name.sqlite.gz.sha256" "$work/$name.json" "$IG_BACKUP_DIR/"
  rm -rf -- "$work"
  [[ "$kind" == auto ]] && prune_auto_backups
  printf '%s\n' "$IG_BACKUP_DIR/$name.sqlite.gz"
}

# Rotation applies only to automatic backups; manual, pre-upgrade and pre-restore backups are kept.
prune_auto_backups() {
  local keep="${IG_BACKUP_KEEP:-14}" old
  mapfile -t old < <(find "$IG_BACKUP_DIR" -maxdepth 1 -type f -name 'invoice-generator-*-auto.sqlite.gz' -printf '%f\n' | sort | head -n "-$keep")
  for name in "${old[@]}"; do
    rm -f -- "$IG_BACKUP_DIR/$name" "$IG_BACKUP_DIR/$name.sha256" "$IG_BACKUP_DIR/${name%.sqlite.gz}.json"
  done
}

# preserve_database KIND RELEASE_DIR FALLBACK_IMAGE: saves the live database before a rollback
# overwrites it, so data written after a switch is never discarded. Services must be stopped.
# Uses a verified backup when possible, otherwise a raw copy of the SQLite files. Prints the path.
preserve_database() {
  local kind="$1" release_dir="$2" fallback_image="$3" path name work
  if path="$( (create_backup "$kind" "$release_dir") 2>/dev/null | tail -n 1)" && [[ -f "$path" ]]; then
    printf '%s\n' "$path"
    return 0
  fi
  name="invoice-generator-$(date -u +%Y%m%dT%H%M%SZ)-$kind-raw.tar.gz"
  install -d -m 0700 "$IG_BACKUP_DIR"
  work="$(mktemp -d "$IG_BACKUP_DIR/.work.XXXXXX")"
  IG_HELPER_SCRIPT="set -eu
    cd /app/data
    tar -czf /out/database.tar.gz \$(ls -1 invoice-generator.sqlite invoice-generator.sqlite-wal invoice-generator.sqlite-shm 2>/dev/null)"
  if data_helper "$fallback_image" -v "$work:/out" && [[ -s "$work/database.tar.gz" ]]; then
    mv -f -- "$work/database.tar.gz" "$IG_BACKUP_DIR/$name"
    chmod 600 "$IG_BACKUP_DIR/$name"
    (cd "$IG_BACKUP_DIR" && sha256sum "$name" >"$name.sha256" && chmod 600 "$name.sha256")
    rm -rf -- "$work"
    printf '%s\n' "$IG_BACKUP_DIR/$name"
    return 0
  fi
  rm -rf -- "$work"
  return 1
}

# Decompresses a verified backup into a private work directory; prints the SQLite path.
unpack_backup() {
  local archive="$1" work="$2"
  [[ -f "$archive" && ! -L "$archive" ]] || die BACKUP_NOT_FOUND "找不到备份文件：$archive"
  if [[ -f "$archive.sha256" ]]; then
    (cd "$(dirname -- "$archive")" && sha256sum --check --strict --quiet "$(basename -- "$archive").sha256") ||
      die BACKUP_CHECKSUM_MISMATCH '备份文件校验和不匹配，已停止。'
  else
    [[ "${IG_ALLOW_UNSIGNED_BACKUP:-0}" == 1 ]] || die BACKUP_CHECKSUM_MISSING '缺少 .sha256 校验文件，已停止。'
  fi
  gzip -dc -- "$archive" >"$work/restore.sqlite" || die BACKUP_CORRUPT '备份文件无法解压。'
  chmod 600 "$work/restore.sqlite"
  printf '%s\n' "$work/restore.sqlite"
}

# Replaces the live database file in the data volume. The application must be stopped.
replace_database() {
  local image="$1" file="$2" directory
  directory="$(dirname -- "$file")"
  IG_HELPER_SCRIPT="set -eu
    cp /restore/$(basename -- "$file") '$IG_DATABASE_PATH.restore'
    chown node:node '$IG_DATABASE_PATH.restore'
    chmod 600 '$IG_DATABASE_PATH.restore'
    rm -f '$IG_DATABASE_PATH-wal' '$IG_DATABASE_PATH-shm'
    mv -f '$IG_DATABASE_PATH.restore' '$IG_DATABASE_PATH'"
  data_helper "$image" -v "$directory:/restore:ro"
}

backup_age_hours() {
  local latest
  latest="$(find "$IG_BACKUP_DIR" -maxdepth 1 -type f -name 'invoice-generator-*.sqlite.gz' -printf '%T@\n' 2>/dev/null | sort -n | tail -n 1)"
  [[ -n "$latest" ]] || return 1
  printf '%s' $((($(date +%s) - ${latest%.*}) / 3600))
}
