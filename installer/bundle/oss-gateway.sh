#!/bin/sh
# oss-gateway — shared HTTPS gateway for self-hosted projects on one server.
#
# One Caddy on the public ports 80/443 routes each domain to its project's internal
# loopback port and obtains/renews a certificate per domain. Every project manages only
# its own site file; nothing here stops, overwrites or removes another site.
# This file is shipped identically by Invoice Generator and Product Hub
# (docs/HTTPS_GATEWAY.md); keep both copies the same.
#
#   oss-gateway detect                     managed | absent | host-caddy | unmanageable <owner>
#   oss-gateway create                     install the gateway (ports 80/443 must be free)
#   oss-gateway add-site NAME HOST FILE    add or replace site NAME; FILE holds one "HOST { ... }" block
#   oss-gateway add NAME HOST UPSTREAM     simple reverse proxy site, e.g. add n8n n8n.example.com 127.0.0.1:5678
#   oss-gateway remove NAME                remove site NAME
#   oss-gateway list | status
#
# Gateway: Docker Compose project "oss-gateway" in /opt/oss-gateway (host network, so it
# reaches services bound to 127.0.0.1). An existing systemd Caddy that owns 80/443 is used
# instead (marked blocks in /etc/caddy/Caddyfile). Any other owner of 80/443 (Nginx,
# Apache, another container) cannot be managed safely and is reported, never changed.
# Every change is validated on a copy first, backed up, reloaded without downtime and
# rolled back when the reload fails.
set -eu
umask 022

OSS_GATEWAY_FORMAT=1
GATEWAY_ROOT=${OSS_GATEWAY_ROOT:-/opt/oss-gateway}
GATEWAY_PROJECT=oss-gateway
GATEWAY_IMAGE=${OSS_GATEWAY_IMAGE:-caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b}
HOST_CADDYFILE=${OSS_GATEWAY_HOST_CADDYFILE:-/etc/caddy/Caddyfile}
GATEWAY_CLI=${OSS_GATEWAY_CLI:-/usr/local/bin/oss-gateway}

say() { printf '%s\n' "$*"; }
fail() {
  printf '失败 [%s]：%s\n' "$1" "${2:-}" >&2
  exit 1
}

valid_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{0,40}$'; }
valid_domain() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
}

port_busy() {
  [ -n "$(ss -H -ltn "sport = :$1" 2>/dev/null)" ] ||
    docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq "(^|[ ,])[^ ,]*:$1->"
}
port_owner() {
  owner=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null |
    awk -v p=":$1->" 'index($0, p) { printf "%s容器 %s", sep, $1; sep = "、" }')
  [ -n "$owner" ] || owner=$(ss -H -ltnp "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n 1 | cut -d'"' -f2)
  printf '%s' "${owner:-未知程序}"
}

gateway_container() {
  docker ps -q --filter label=oss.gateway=1 --filter status=running 2>/dev/null | head -n 1
}

# A systemd Caddy using a regular /etc/caddy/Caddyfile and serving both 80 and 443.
host_caddy_manageable() {
  [ -f "$HOST_CADDYFILE" ] && [ ! -L "$HOST_CADDYFILE" ] || return 1
  command -v caddy >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 || return 1
  systemctl is-active --quiet caddy || return 1
  for port in 80 443; do
    ss -H -ltnp "sport = :$port" 2>/dev/null | grep -q '"caddy"' || return 1
  done
}

detect() {
  if [ -n "$(gateway_container)" ]; then
    echo managed
  elif ! port_busy 80 && ! port_busy 443; then
    echo absent
  elif host_caddy_manageable; then
    echo host-caddy
  else
    owner80=$(port_owner 80)
    owner443=$(port_owner 443)
    if [ "$owner80" = "$owner443" ]; then echo "unmanageable $owner80"; else echo "unmanageable $owner80 / $owner443"; fi
  fi
}

with_lock() {
  mkdir -p "$GATEWAY_ROOT"
  exec 8>"$GATEWAY_ROOT/.lock"
  flock -w 120 8 || fail GATEWAY_BUSY '另一个网关操作正在进行，请稍后再试。'
}

compose_gateway() {
  GATEWAY_IMAGE="$(cat "$GATEWAY_ROOT/image")" docker compose -p "$GATEWAY_PROJECT" -f "$GATEWAY_ROOT/compose.yaml" "$@"
}

reload_gateway() {
  docker exec "$(gateway_container)" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
    --address unix//config/admin.sock >/dev/null 2>&1
}

# validate_sites DIR: the full gateway configuration with DIR as its site directory.
validate_sites() {
  root_mount=''
  [ ! -f "$GATEWAY_ROOT/acme-ca-root.pem" ] ||
    root_mount="-v $GATEWAY_ROOT/acme-ca-root.pem:/etc/caddy/acme-ca-root.pem:ro"
  # shellcheck disable=SC2086 # root_mount is empty or one -v option without spaces in paths we create
  docker run --rm --network none -v "$GATEWAY_ROOT/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$1:/etc/caddy/sites:ro" $root_mount "$(cat "$GATEWAY_ROOT/image")" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$GATEWAY_ROOT/.last-validate.log" 2>&1
}

render_main_caddyfile() {
  printf '# oss-gateway format %s. Sites live in sites/*.caddy, one file per project.\n' "$OSS_GATEWAY_FORMAT"
  printf '{\n\t# Admin API only on a socket inside the container volume, never on TCP.\n'
  printf '\tadmin unix//config/admin.sock\n\tpersist_config off\n\tskip_install_trust\n'
  [ -z "${OSS_GATEWAY_EMAIL:-}" ] || printf '\temail %s\n' "$OSS_GATEWAY_EMAIL"
  if [ -n "${OSS_GATEWAY_ACME_CA:-}" ]; then
    printf '\tacme_ca %s\n\tacme_ca_root /etc/caddy/acme-ca-root.pem\n' "$OSS_GATEWAY_ACME_CA"
  fi
  [ "${OSS_GATEWAY_LOCAL_CERTS:-0}" != 1 ] || printf '\tlocal_certs\n'
  printf '\tservers {\n\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body 120s\n\t\t\twrite 120s\n\t\t\tidle 2m\n\t\t}\n\t}\n}\n\n'
  printf 'import /etc/caddy/sites/*.caddy\n'
}

render_compose() {
  cat <<EOF
# oss-gateway: shared HTTPS entry point. Managed by oss-gateway; do not edit.
name: oss-gateway

services:
  caddy:
    image: \${GATEWAY_IMAGE:?gateway image is required}
    # Host network: binds 80/443 and reaches project services on 127.0.0.1 only.
    network_mode: host
    labels:
      oss.gateway: '1'
    volumes:
      - $GATEWAY_ROOT/Caddyfile:/etc/caddy/Caddyfile:ro
      - $GATEWAY_ROOT/sites:/etc/caddy/sites:ro
$([ ! -f "$GATEWAY_ROOT/acme-ca-root.pem" ] || printf '      - %s/acme-ca-root.pem:/etc/caddy/acme-ca-root.pem:ro\n' "$GATEWAY_ROOT")
      - data:/data
      - config:/config
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

volumes:
  data: {}
  config: {}
EOF
}

install_cli() {
  self=$(command -v "$0" 2>/dev/null || printf '%s' "$0")
  if [ "$(readlink -f "$self")" != "$(readlink -f "$GATEWAY_ROOT/oss-gateway" 2>/dev/null || true)" ]; then
    install -m 0755 "$self" "$GATEWAY_ROOT/oss-gateway"
  fi
  # A foreign file at the command path is left alone.
  if [ ! -e "$GATEWAY_CLI" ] || [ -L "$GATEWAY_CLI" ]; then ln -sfn "$GATEWAY_ROOT/oss-gateway" "$GATEWAY_CLI"; fi
}

cmd_create() {
  with_lock
  state=$(detect)
  case "$state" in
    managed) say '共享 HTTPS 网关已在运行。'; return 0 ;;
    absent) ;;
    host-caddy) fail GATEWAY_HOST_CADDY '服务器已有 Caddy 占用 80/443，将直接使用它，无需安装网关。' ;;
    *) fail GATEWAY_UNAVAILABLE "80/443 端口已被 ${state#unmanageable } 占用，无法安全安装共享网关；不会停止或修改它。" ;;
  esac
  docker compose version >/dev/null 2>&1 || fail DOCKER_COMPOSE_REQUIRED '需要 Docker Compose 插件。'
  [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$GATEWAY_PROJECT")" ] &&
    fail GATEWAY_STOPPED "已有停止的 $GATEWAY_PROJECT 容器，请先运行 docker compose -p $GATEWAY_PROJECT start 或人工检查。"
  install -d -m 0755 "$GATEWAY_ROOT" "$GATEWAY_ROOT/sites"
  install -d -m 0700 "$GATEWAY_ROOT/backups"
  if [ -n "${OSS_GATEWAY_ACME_CA:-}" ]; then
    [ -f "${OSS_GATEWAY_ACME_CA_ROOT:-}" ] || fail GATEWAY_CONFIG_INVALID 'OSS_GATEWAY_ACME_CA 需要 OSS_GATEWAY_ACME_CA_ROOT。'
    install -m 0644 "$OSS_GATEWAY_ACME_CA_ROOT" "$GATEWAY_ROOT/acme-ca-root.pem"
  fi
  printf '%s\n' "$GATEWAY_IMAGE" >"$GATEWAY_ROOT/image"
  render_main_caddyfile >"$GATEWAY_ROOT/Caddyfile"
  render_compose >"$GATEWAY_ROOT/compose.yaml"
  chmod 0644 "$GATEWAY_ROOT/Caddyfile" "$GATEWAY_ROOT/compose.yaml" "$GATEWAY_ROOT/image"
  docker image inspect "$GATEWAY_IMAGE" >/dev/null 2>&1 || docker pull -q "$GATEWAY_IMAGE" >/dev/null ||
    fail GATEWAY_IMAGE_PULL_FAILED "无法下载 ${GATEWAY_IMAGE}。"
  validate_sites "$GATEWAY_ROOT/sites" || fail GATEWAY_CONFIG_INVALID "网关配置校验失败：$(tail -n 3 "$GATEWAY_ROOT/.last-validate.log")"
  compose_gateway up -d >/dev/null 2>&1 || fail GATEWAY_START_FAILED '共享网关启动失败。'
  for _ in $(seq 1 30); do
    [ -n "$(gateway_container)" ] && docker exec "$(gateway_container)" test -S /config/admin.sock 2>/dev/null && break
    sleep 1
  done
  [ -n "$(gateway_container)" ] || fail GATEWAY_START_FAILED '共享网关未能运行。'
  install_cli
  say "共享 HTTPS 网关已安装：Docker 项目 ${GATEWAY_PROJECT}，配置目录 ${GATEWAY_ROOT}。"
}

# Site address lines of a site body: unindented lines that open a block.
site_addresses() { grep -E '^[^[:space:]#}][^#]*\{[[:space:]]*$' "$1" | sed 's/[[:space:]]*{[[:space:]]*$//'; }

# The site file may only define HOST, so a project can never take over another domain.
check_site_body() {
  file=$1 host=$2
  [ -f "$file" ] || fail SITE_FILE_MISSING "站点文件不存在：$file"
  [ "$(site_addresses "$file")" = "$host" ] || fail SITE_FILE_INVALID "站点文件只能包含 $host 一个站点。"
  if grep -Eq '^[[:space:]]*import([[:space:]]|$)' "$file"; then fail SITE_FILE_INVALID '站点文件不能使用 import。'; fi
}

# Prints "NAME" of the managed site serving HOST (empty when none).
managed_site_for() {
  for existing in "$GATEWAY_ROOT"/sites/*.caddy; do
    [ -f "$existing" ] || continue
    if site_addresses "$existing" | grep -Fxq "$1"; then basename "$existing" .caddy; fi
  done
}

host_caddy_has_site() {
  awk -v host="$1" -v name="$2" '
    /^# BEGIN oss-gateway site / { inside = ($5 == name) }
    /^# END oss-gateway site / { inside = 0; next }
    !inside && /^[^[:space:]#}][^#]*\{[[:space:]]*$/ {
      line = $0; sub(/[[:space:]]*\{[[:space:]]*$/, "", line)
      n = split(line, parts, /[[:space:],]+/)
      for (i = 1; i <= n; i++) { a = parts[i]; sub(/^https?:\/\//, "", a); sub(/:[0-9]+$/, "", a); if (a == host) found = 1 }
    }
    END { exit(found ? 0 : 1) }' "$HOST_CADDYFILE"
}

# Copy of the host Caddyfile without the marked block of NAME.
host_caddy_without() {
  awk -v name="$1" '
    $0 ~ "^# BEGIN oss-gateway site " name " " { skip = 1; next }
    skip && $0 ~ "^# END oss-gateway site " name "$" { skip = 0; next }
    !skip { print }' "$HOST_CADDYFILE"
}

host_caddy_apply() { # CANDIDATE: validate, back up, install, reload; restore on any failure
  candidate=$1
  caddy validate --config "$candidate" --adapter caddyfile >"$candidate.log" 2>&1 || {
    rm -f "$candidate" "$candidate.log"
    fail GATEWAY_CONFIG_INVALID '新的 Caddy 配置校验失败，原配置未修改。'
  }
  backup="$HOST_CADDYFILE.oss-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$HOST_CADDYFILE" "$backup"
  chmod --reference="$HOST_CADDYFILE" "$candidate" 2>/dev/null || chmod 0644 "$candidate"
  mv -f "$candidate" "$HOST_CADDYFILE"
  rm -f "$candidate.log"
  if ! systemctl reload caddy >/dev/null 2>&1; then
    cp -p "$backup" "$HOST_CADDYFILE"
    systemctl reload caddy >/dev/null 2>&1 || true
    fail GATEWAY_RELOAD_FAILED "Caddy 重新加载失败，已恢复原配置（备份：${backup}）。"
  fi
  say "已更新 $HOST_CADDYFILE 并重新加载 Caddy（原配置备份：${backup}）。"
}

managed_apply() { # NAME NEWFILE|-   (- removes the site)
  name=$1 new=$2
  candidate=$(mktemp -d "$GATEWAY_ROOT/.candidate.XXXXXX")
  chmod 0755 "$candidate"
  for existing in "$GATEWAY_ROOT"/sites/*.caddy; do
    [ ! -f "$existing" ] || [ "$(basename "$existing")" = "$name.caddy" ] || cp -p "$existing" "$candidate/"
  done
  [ "$new" = - ] || install -m 0644 "$new" "$candidate/$name.caddy"
  if ! validate_sites "$candidate"; then
    rm -rf "$candidate"
    fail GATEWAY_CONFIG_INVALID "新的网关配置校验失败，现有站点未受影响：$(tail -n 3 "$GATEWAY_ROOT/.last-validate.log")"
  fi
  rm -rf "$candidate"
  previous=''
  if [ -f "$GATEWAY_ROOT/sites/$name.caddy" ]; then
    previous="$GATEWAY_ROOT/backups/$name.caddy.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$GATEWAY_ROOT/sites/$name.caddy" "$previous"
  fi
  if [ "$new" = - ]; then
    rm -f "$GATEWAY_ROOT/sites/$name.caddy"
  else
    install -m 0644 "$new" "$GATEWAY_ROOT/sites/.$name.caddy.new"
    mv -f "$GATEWAY_ROOT/sites/.$name.caddy.new" "$GATEWAY_ROOT/sites/$name.caddy"
  fi
  if ! reload_gateway; then
    if [ -n "$previous" ]; then cp -p "$previous" "$GATEWAY_ROOT/sites/$name.caddy"; else rm -f "$GATEWAY_ROOT/sites/$name.caddy"; fi
    reload_gateway || true
    fail GATEWAY_RELOAD_FAILED '网关重新加载失败，已恢复原配置，其他站点未受影响。'
  fi
}

cmd_add_site() {
  [ $# -eq 3 ] || fail USAGE 'oss-gateway add-site NAME HOST FILE'
  name=$1 host=$2 file=$3
  valid_name "$name" || fail SITE_NAME_INVALID "站点名称无效：$name"
  valid_domain "$host" || fail SITE_HOST_INVALID "域名无效：$host"
  check_site_body "$file" "$host"
  with_lock
  body=$(mktemp)
  { printf '# oss-gateway site %s %s. Managed by its installer; changes are replaced.\n' "$name" "$host"; cat "$file"; } >"$body"
  state=$(detect)
  case "$state" in
    managed)
      owner=$(managed_site_for "$host")
      [ -z "$owner" ] || [ "$owner" = "$name" ] || {
        rm -f "$body"
        fail GATEWAY_SITE_CONFLICT "$host 已由网关站点 $owner 使用，未做任何更改。"
      }
      managed_apply "$name" "$body"
      ;;
    host-caddy)
      if host_caddy_has_site "$host" "$name"; then
        rm -f "$body"
        fail GATEWAY_SITE_CONFLICT "$host 已在 $HOST_CADDYFILE 中配置，未做任何更改。"
      fi
      candidate=$(mktemp "$HOST_CADDYFILE.oss-candidate.XXXXXX")
      { host_caddy_without "$name"; printf '\n# BEGIN oss-gateway site %s %s\n' "$name" "$host"; cat "$file"; printf '# END oss-gateway site %s\n' "$name"; } >"$candidate"
      host_caddy_apply "$candidate"
      ;;
    absent) rm -f "$body"; fail GATEWAY_NOT_INSTALLED '尚未安装共享 HTTPS 网关。' ;;
    *) rm -f "$body"; fail GATEWAY_UNAVAILABLE "80/443 端口已被 ${state#unmanageable } 占用，无法安全添加站点；不会停止或修改它。" ;;
  esac
  rm -f "$body"
  say "已添加站点 ${name}：https://$host"
}

cmd_add() {
  [ $# -eq 3 ] || fail USAGE 'oss-gateway add NAME HOST UPSTREAM（例如 add n8n n8n.example.com 127.0.0.1:5678）'
  printf '%s' "$3" | grep -Eq '^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9.-]+):[1-9][0-9]{0,4}$' || fail SITE_UPSTREAM_INVALID "上游地址无效：$3"
  site=$(mktemp)
  printf '%s {\n\treverse_proxy %s\n}\n' "$2" "$3" >"$site"
  ( cmd_add_site "$1" "$2" "$site" ) || { rm -f "$site"; exit 1; }
  rm -f "$site"
}

cmd_remove() {
  [ $# -eq 1 ] && valid_name "$1" || fail USAGE 'oss-gateway remove NAME'
  with_lock
  case "$(detect)" in
    managed)
      [ -f "$GATEWAY_ROOT/sites/$1.caddy" ] || fail SITE_NOT_FOUND "没有站点 $1。"
      managed_apply "$1" -
      ;;
    host-caddy)
      grep -q "^# BEGIN oss-gateway site $1 " "$HOST_CADDYFILE" || fail SITE_NOT_FOUND "没有站点 $1。"
      candidate=$(mktemp "$HOST_CADDYFILE.oss-candidate.XXXXXX")
      host_caddy_without "$1" >"$candidate"
      host_caddy_apply "$candidate"
      ;;
    *) fail GATEWAY_NOT_INSTALLED '没有可管理的共享网关。' ;;
  esac
  say "已移除站点 $1，其他站点未受影响。"
}

cmd_list() {
  case "$(detect)" in
    managed)
      for site in "$GATEWAY_ROOT"/sites/*.caddy; do
        [ ! -f "$site" ] || printf '%s\t%s\n' "$(basename "$site" .caddy)" "$(site_addresses "$site")"
      done
      ;;
    host-caddy) sed -n 's/^# BEGIN oss-gateway site \([^ ]*\) \(.*\)$/\1\t\2/p' "$HOST_CADDYFILE" ;;
  esac
}

cmd_status() {
  state=$(detect)
  case "$state" in
    managed) say "共享 HTTPS 网关：运行中（Docker 项目 ${GATEWAY_PROJECT}，镜像 $(cat "$GATEWAY_ROOT/image" 2>/dev/null)）" ;;
    host-caddy) say "共享 HTTPS 网关：使用宿主机 Caddy（${HOST_CADDYFILE}）" ;;
    absent) say '共享 HTTPS 网关：未安装（80/443 空闲）' ;;
    *) say "共享 HTTPS 网关：不可用，80/443 由 ${state#unmanageable } 占用" ;;
  esac
  cmd_list
}

main() {
  [ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED '请使用 root 运行，或在命令前加 sudo。'
  command=${1:-status}
  [ $# -eq 0 ] || shift
  case "$command" in
    detect) detect ;;
    create) cmd_create ;;
    add-site) cmd_add_site "$@" ;;
    add) cmd_add "$@" ;;
    remove) cmd_remove "$@" ;;
    list) cmd_list ;;
    status) cmd_status ;;
    *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
}

# Sourcing for tests: OSS_GATEWAY_SOURCE_ONLY=1 . oss-gateway.sh
[ "${OSS_GATEWAY_SOURCE_ONLY:-0}" = 1 ] || main "$@"
