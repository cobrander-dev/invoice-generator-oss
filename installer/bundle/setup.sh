#!/usr/bin/env bash
# Invoice Generator 首次安装向导。由 install.sh 在校验安装包后调用。
#
# Non-interactive answers (isolated tests and automation):
#   IG_NONINTERACTIVE=1 IG_ACCESS_HOST=<domain|public IPv4> IG_ADMIN_USERNAME=<name>
#   IG_ADMIN_PASSWORD_FILE=<file> [IG_PROXY_MODE=auto|bundled|external]
#   [IG_HOST_CADDY=yes|no] [IG_TLS_ISSUER=auto|internal]
set -Eeuo pipefail
umask 077

BUNDLE_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/common.sh
. "$BUNDLE_DIR/lib/common.sh"
# shellcheck source=lib/validate.sh
. "$BUNDLE_DIR/lib/validate.sh"
# shellcheck source=lib/host-caddy.sh
. "$BUNDLE_DIR/lib/host-caddy.sh"
# shellcheck source=lib/https.sh
. "$BUNDLE_DIR/lib/https.sh"

interactive() { [[ "${IG_NONINTERACTIVE:-0}" != 1 ]]; }
ask() {
  local prompt="$1" answer=''
  printf '%s' "$prompt" >/dev/tty
  IFS= read -r answer </dev/tty || answer=''
  printf '%s' "$answer"
}
ask_secret() {
  local prompt="$1" answer=''
  printf '%s' "$prompt" >/dev/tty
  IFS= read -rs answer </dev/tty || answer=''
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}
confirm() {
  local answer
  answer="$(ask "$1")"
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

preflight() {
  require_root
  [[ "$(uname -s)" == Linux ]] || die LINUX_REQUIRED '仅支持 Linux 服务器。'
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 ||
    die DOCKER_REQUIRED '需要 Docker Engine 与 Docker Compose 插件。'
  docker info >/dev/null 2>&1 || die DOCKER_DAEMON_UNAVAILABLE 'Docker 服务未运行，请执行 systemctl start docker。'
  local tool
  for tool in curl ss flock gzip sha256sum openssl awk; do
    command -v "$tool" >/dev/null 2>&1 || die TOOLS_REQUIRED "缺少工具：$tool"
  done
}

# An existing project or volume named invoice-generator that this installer did not create
# belongs to someone else: never adopt, overwrite or remove it.
check_ownership() {
  local containers volume=''
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$IG_PROJECT")"
  docker volume inspect "$IG_DATA_VOLUME" >/dev/null 2>&1 && volume=yes
  if [[ -n "$containers" || -n "$volume" ]] && [[ ! -f "$IG_APP_ENV" ]]; then
    die PROJECT_EXISTS "Docker 中已存在名为 $IG_PROJECT 的项目或数据卷，但不是本安装程序创建的。为避免覆盖，安装已停止，请人工检查。"
  fi
}

choose_access_host() {
  local host="${IG_ACCESS_HOST:-}" suggested="${IG_SUGGESTED_IP:-}"
  while true; do
    if [[ -z "$host" ]]; then
      interactive || die ACCESS_HOST_REQUIRED '请设置 IG_ACCESS_HOST。'
      say ''
      say '请输入访问地址：'
      note '有域名：输入域名，例如 invoice.example.com（需已解析到本服务器）'
      note '没有域名：直接回车使用服务器公网 IP'
      host="$(ask "访问地址${suggested:+ [$suggested]}: ")"
      host="${host:-$suggested}"
    fi
    host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
    if valid_domain "$host"; then
      IG_ACCESS_KIND=domain
    elif public_ipv4 "$host"; then
      IG_ACCESS_KIND=ip
    else
      interactive || die ACCESS_HOST_INVALID "无效的域名或公网 IPv4 地址：$host"
      say "无效的域名或公网 IPv4 地址：$host"
      host=''
      continue
    fi
    IG_ACCESS_HOST="$host"
    return 0
  done
}

choose_proxy_mode() {
  IG_PROXY_MODE="${IG_PROXY_MODE:-auto}"
  IG_HOST_CADDY_SITE=no
  if [[ "$IG_PROXY_MODE" == auto ]]; then
    # Ports held by this installation's own Caddy (resumed setup) are not a conflict.
    if [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=$IG_PROJECT" --filter label=com.docker.compose.service=caddy)" ]]; then
      IG_PROXY_MODE=bundled
    elif port_in_use 80 || port_in_use 443; then
      IG_PROXY_MODE=external
    else
      IG_PROXY_MODE=bundled
    fi
  fi
  [[ "$IG_PROXY_MODE" == bundled || "$IG_PROXY_MODE" == external ]] || die CONFIG_INVALID 'IG_PROXY_MODE 无效。'
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    IG_APP_PORT=3001
    return 0
  fi
  IG_APP_PORT="$(free_loopback_port 3001)" || die NO_FREE_PORT '127.0.0.1:3001-3099 没有空闲端口。'
  say ''
  say '检测到 80/443 端口已被其他服务占用（例如 Nginx 或 Caddy），将使用“已有反向代理”模式：'
  note "Invoice Generator 只监听 127.0.0.1:$IG_APP_PORT，不占用 80/443"
  note "HTTPS 由你现有的反向代理提供，示例配置会写入 $IG_PROXY_DIR"
  if [[ "$IG_ACCESS_KIND" == domain ]] && detect_existing_host_caddy /etc/caddy/Caddyfile; then
    case "${IG_HOST_CADDY:-ask}" in
      yes) IG_HOST_CADDY_SITE=yes ;;
      no) ;;
      *) interactive && confirm "检测到正在运行的宿主机 Caddy，是否自动添加 $IG_ACCESS_HOST 站点？（会先校验并备份原配置）[Y/n]: " && IG_HOST_CADDY_SITE=yes ;;
    esac
  fi
  return 0
}

write_configuration() {
  local secret
  install -d -m 0755 "$IG_ROOT"
  install -d -m 0700 "$IG_CONFIG_DIR" "$IG_BACKUP_DIR"
  install -d -m 0755 "$IG_RELEASES_DIR"
  if [[ -f "$IG_APP_ENV" ]]; then
    note '检测到未完成的安装，保留已有密钥继续。'
    set_env_value "$IG_APP_ENV" APP_ORIGIN "https://$IG_ACCESS_HOST"
  else
    secret="$(openssl rand -hex 48)"
    write_env_file "$IG_APP_ENV" \
      "APP_ORIGIN=https://$IG_ACCESS_HOST" \
      "SESSION_SECRET=$secret" \
      'PASSWORD_MIN_LENGTH=8' \
      'BUSINESS_BACKUP_LIMIT=64mb'
    unset secret
  fi
  IG_TLS_ISSUER="${IG_TLS_ISSUER:-auto}"
  [[ "$IG_TLS_ISSUER" == auto || "$IG_TLS_ISSUER" == internal ]] || die CONFIG_INVALID 'IG_TLS_ISSUER 无效。'
}

install_release() {
  local target="$IG_RELEASES_DIR/$IG_VERSION"
  if [[ ! -d "$target" ]]; then
    local staging
    staging="$(mktemp -d "$IG_RELEASES_DIR/.staging.XXXXXX")"
    cp -a "$BUNDLE_DIR/." "$staging/"
    chmod 755 "$staging"
    mv -- "$staging" "$target"
  fi
  ln -sfn "$target" "$IG_CURRENT.new"
  mv -Tf -- "$IG_CURRENT.new" "$IG_CURRENT"
}

save_installer_settings() {
  write_env_file "$IG_INSTALLER_ENV" \
    "ACCESS_HOST=$IG_ACCESS_HOST" \
    "ACCESS_KIND=$IG_ACCESS_KIND" \
    "PROXY_MODE=$IG_PROXY_MODE" \
    "APP_PORT=$IG_APP_PORT" \
    "TLS_ISSUER=$IG_TLS_ISSUER" \
    "BACKUP_KEEP=${IG_BACKUP_KEEP:-14}" \
    "INSTALLED_VERSION=$IG_VERSION"
}

start_services() {
  ensure_image "$IG_APP_IMAGE"
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    ensure_image "$IG_CADDY_IMAGE"
    write_caddyfile
    quietly compose up -d --remove-orphans app caddy
  else
    write_proxy_examples "$IG_ACCESS_HOST" "$IG_APP_PORT"
    quietly compose up -d --remove-orphans app
  fi
  app_healthy || die APP_UNHEALTHY '应用未能通过健康检查。可运行 invoice-generator logs 查看日志。'
  if [[ "$IG_HOST_CADDY_SITE" == yes ]]; then
    ensure_host_caddy_site /etc/caddy/Caddyfile "$IG_ACCESS_HOST" "127.0.0.1:$IG_APP_PORT" ||
      warn '宿主机 Caddy 配置未修改（已恢复原配置），请参考示例手动添加。'
  fi
  if ! entry_healthy; then
    if [[ "$IG_PROXY_MODE" == bundled ]]; then
      warn 'HTTPS 入口暂未就绪，证书可能仍在申请中。稍后运行 invoice-generator doctor 检查。'
    else
      die APP_UNREACHABLE "无法访问 http://127.0.0.1:$IG_APP_PORT/health。"
    fi
  fi
}

create_administrator() {
  local status=0 username password confirm_password
  compose exec -T app node server/scripts/admin-status.js >/dev/null 2>&1 || status=$?
  if [[ "$status" -eq 0 ]]; then
    note '管理员已存在，未修改任何账号。'
    return 0
  fi
  [[ "$status" -eq 3 ]] || die ADMIN_STATUS_FAILED '无法确认管理员状态。'
  username="${IG_ADMIN_USERNAME:-}"
  while true; do
    if [[ -z "$username" ]]; then
      interactive || die ADMIN_REQUIRED '请设置 IG_ADMIN_USERNAME。'
      username="$(ask '管理员用户名或邮箱: ')"
    fi
    username="$(printf '%s' "$username" | tr '[:upper:]' '[:lower:]')"
    [[ "$username" =~ ^[a-z0-9][a-z0-9@._+-]{2,127}$ ]] && break
    interactive || die ADMIN_USERNAME_INVALID '管理员用户名需为 3-128 位字母、数字或 @._+-。'
    say '用户名需为 3-128 位字母、数字或 @._+-。'
    username=''
  done
  if [[ -n "${IG_ADMIN_PASSWORD_FILE:-}" ]]; then
    password="$(<"$IG_ADMIN_PASSWORD_FILE")"
    valid_admin_password "$password" 8 || die ADMIN_PASSWORD_INVALID '管理员密码需 8-1024 位且不能是常见弱密码。'
  else
    interactive || die ADMIN_REQUIRED '请设置 IG_ADMIN_PASSWORD_FILE。'
    while true; do
      password="$(ask_secret '管理员密码（至少 8 位，输入时不显示）: ')"
      confirm_password="$(ask_secret '再次输入密码: ')"
      if [[ "$password" != "$confirm_password" ]]; then
        say '两次输入不一致，请重新输入。'
      elif ! valid_admin_password "$password" 8; then
        say '密码需 8-1024 位且不能是常见弱密码。'
      else
        break
      fi
    done
    unset confirm_password
  fi
  printf '%s' "$password" | compose exec -T -e ADMIN_USERNAME="$username" -e ADMIN_PASSWORD_STDIN=1 \
    app node server/scripts/init-admin.js >/dev/null || die ADMIN_INIT_FAILED '管理员创建失败。'
  unset password
  note "管理员已创建：$username"
}

install_cli_and_schedule() {
  chmod 755 "$IG_CURRENT/invoice-generator"
  ln -sfn "$IG_CURRENT/invoice-generator" "$IG_CLI_LINK"
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    install -m 0644 "$IG_CURRENT/systemd/invoice-generator-backup.service" /etc/systemd/system/
    install -m 0644 "$IG_CURRENT/systemd/invoice-generator-backup.timer" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now invoice-generator-backup.timer >/dev/null 2>&1 ||
      warn '自动备份定时器启用失败，请运行 invoice-generator doctor 检查。'
  else
    install -d -m 0755 /etc/cron.d
    printf '30 3 * * * root %s backup --auto >/dev/null 2>&1\n' "$IG_CLI_LINK" >/etc/cron.d/invoice-generator-backup
    chmod 644 /etc/cron.d/invoice-generator-backup
  fi
}

summary() {
  say ''
  say '========================================'
  say '  Invoice Generator 安装完成'
  say '========================================'
  say "访问地址：https://$IG_ACCESS_HOST"
  if [[ "$IG_PROXY_MODE" == external ]]; then
    say "应用监听：127.0.0.1:$IG_APP_PORT（由你现有的反向代理提供 HTTPS）"
    [[ "$IG_HOST_CADDY_SITE" == yes ]] || say "反向代理示例：$IG_PROXY_DIR"
  elif [[ "$IG_ACCESS_KIND" == ip ]]; then
    say 'IP 访问会优先申请 Let'"'"'s Encrypt 短期 IP 证书；若申请失败将使用本机 CA 证书，'
    say '浏览器会提示不受信任，可运行 invoice-generator https 导出根证书后导入。'
  fi
  say ''
  say '常用命令：'
  note 'sudo invoice-generator          管理菜单'
  note 'sudo invoice-generator status   运行状态'
  note 'sudo invoice-generator doctor   健康检查'
  note 'sudo invoice-generator backup   立即备份'
  note 'sudo invoice-generator upgrade  一键升级'
  say ''
  say "数据备份目录：$IG_BACKUP_DIR（每天自动备份，保留最近 ${IG_BACKUP_KEEP:-14} 份自动备份）"
  say '请定期把备份复制到服务器以外的安全位置。'
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    say '云服务器请在安全组中放行 TCP 80 和 443。'
  fi
}

main() {
  preflight
  with_lock
  if [[ -f "$IG_INSTALLER_ENV" ]]; then
    die ALREADY_INSTALLED '已安装 Invoice Generator，请使用 sudo invoice-generator 管理。'
  fi
  check_ownership
  load_release "$BUNDLE_DIR"
  say "Invoice Generator $IG_VERSION 安装向导"
  choose_access_host
  choose_proxy_mode
  write_configuration
  install_release
  start_services
  create_administrator
  install_cli_and_schedule
  save_installer_settings
  load_settings
  local backup
  backup="$(create_backup auto | tail -n 1)" && note "首次备份完成：$backup" || warn '首次备份失败，请运行 invoice-generator backup 重试。'
  summary
}

main "$@"
