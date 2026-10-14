#!/usr/bin/env bash
# Invoice Generator 首次安装向导。由 install.sh 在校验安装包后调用。
#
# Non-interactive answers (isolated tests and automation):
#   IG_NONINTERACTIVE=1 IG_ACCESS_HOST=<domain|public IPv4> IG_ADMIN_USERNAME=<name>
#   IG_ADMIN_PASSWORD_FILE=<file> [IG_HTTPS_MODE=gateway|port|external] [IG_HTTPS_PORT=443|1024-65535]
#   [IG_PROXY_MODE=auto|bundled|external] [IG_HOST_CADDY=yes|no] [IG_TLS_ISSUER=auto|internal]
#   [IG_ACME_CA=<https ACME directory> IG_ACME_CA_ROOT=<PEM file>]  (private ACME CA, tests)
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

step() { printf '\n[%s/5] %s\n' "$1" "$2"; }
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

# Asks for the public HTTPS port (default 443). A busy port is never taken over: the user picks
# another one or the existing-proxy mode. Sets IG_HTTPS_PORT and IG_PROXY_MODE.
choose_https_port() {
  local port="${IG_HTTPS_PORT:-}" explicit=0 container
  IG_PROXY_MODE="${IG_PROXY_MODE:-auto}"
  [[ "$IG_PROXY_MODE" =~ ^(auto|bundled|external)$ ]] || die CONFIG_INVALID 'IG_PROXY_MODE 无效。'
  [[ -n "$port" ]] && explicit=1
  [[ "$IG_PROXY_MODE" == external ]] && return 0
  while true; do
    if [[ -z "$port" ]]; then
      if interactive; then
        say ''
        say '请选择 HTTPS 端口：'
        note '直接回车使用 443（标准端口，访问地址不带端口号）'
        note '同一台服务器安装多个项目时，可输入其他端口，例如 8443、9443'
        note '输入 p：改用服务器上已有的反向代理（Nginx/Caddy）提供 HTTPS'
        port="$(ask 'HTTPS 端口 [443]: ')"
        port="${port:-443}"
      else
        port=443
      fi
    fi
    if [[ "$port" == p || "$port" == P ]]; then
      IG_PROXY_MODE=external
      return 0
    fi
    if ! valid_https_port "$port"; then
      interactive || die HTTPS_PORT_INVALID "无效的 HTTPS 端口：${port}（可用 443 或 1024-65535；80 保留给 HTTP 和证书验证）。"
      say "无效的端口：${port}（可用 443 或 1024-65535；80 保留给 HTTP 和证书验证）。"
      port=''
      continue
    fi
    port=$((10#$port))
    # A resumed setup may already run this installation's own Caddy on that port.
    if host_port_busy "$port" && ! { container="$(port_container "$port")" && [[ -n "$container" ]] && own_container "$container"; }; then
      if ! interactive; then
        # Original unattended behaviour: no port requested and 443 taken -> existing proxy.
        if [[ "$explicit" == 0 && "$IG_PROXY_MODE" == auto ]]; then
          IG_PROXY_MODE=external
          return 0
        fi
        die HTTPS_PORT_IN_USE "端口 $port 已被占用（$(port_owner "$port")）。不会停止或修改占用它的程序，请换一个端口，例如 IG_HTTPS_PORT=8443。"
      fi
      say "端口 $port 已被占用（$(port_owner "$port")）。不会停止或修改占用它的程序，请换一个端口。"
      port=''
      continue
    fi
    IG_HTTPS_PORT="$port"
    IG_PROXY_MODE=bundled
    return 0
  done
}

# Decides how the certificate is obtained and refuses to pretend when it cannot be.
choose_certificate_plan() {
  local choice
  IG_TLS_ISSUER="${IG_TLS_ISSUER:-auto}"
  [[ "$IG_TLS_ISSUER" == auto || "$IG_TLS_ISSUER" == internal ]] || die CONFIG_INVALID 'IG_TLS_ISSUER 无效。'
  IG_ACME_CA="${IG_ACME_CA:-}"
  if [[ -n "$IG_ACME_CA" ]]; then
    [[ "$IG_ACME_CA" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || die CONFIG_INVALID 'IG_ACME_CA 无效。'
    [[ -f "${IG_ACME_CA_ROOT:-}" ]] || die CONFIG_INVALID 'IG_ACME_CA 需要 IG_ACME_CA_ROOT（PEM 根证书文件）。'
  fi
  decide_relay_role
  say ''
  case "$IG_RELAY_ROLE" in
    holder)
      note "80 端口空闲：本项目使用 80 端口完成证书验证（HTTP-01），并为同一服务器上的其他项目转发验证请求"
      ;;
    member)
      note "80 端口由同一服务器上的另一个项目（${IG_PORT80_OWNER}）提供，证书验证请求由它转发到本项目"
      ;;
    none)
      if [[ "$IG_HTTPS_PORT" == 443 ]]; then
        note "80 端口被其他程序占用（${IG_PORT80_OWNER}），将只通过 443 端口完成证书验证（TLS-ALPN-01）"
      elif [[ "$IG_TLS_ISSUER" != internal ]]; then
        say "无法自动申请受信任的 HTTPS 证书："
        note "公网证书机构只在 80 端口（HTTP-01）或 443 端口（TLS-ALPN-01）验证域名"
        note "80 端口已被其他程序占用（${IG_PORT80_OWNER}），本项目使用的是 $IG_HTTPS_PORT 端口"
        note 'DNS-01 验证需要 DNS 服务商 API 凭据，本安装程序不支持'
        interactive || die ACME_HTTP_PORT_UNAVAILABLE "80 端口被其他程序占用（${IG_PORT80_OWNER}），自定义端口 $IG_HTTPS_PORT 无法自动申请受信任证书。可改用 IG_HTTPS_PORT=443、IG_PROXY_MODE=external，或明确设置 IG_TLS_ISSUER=internal 使用本机 CA 证书。"
        say '请选择：'
        note '1) 使用本机 CA 证书（浏览器会提示不受信任，可导入根证书后使用）'
        note '2) 改用已有反向代理模式（由占用 80/443 的 Nginx/Caddy 提供 HTTPS）'
        note '3) 取消安装'
        choice="$(ask '请输入 1/2/3 [3]: ')"
        case "$choice" in
          1) IG_TLS_ISSUER=internal ;;
          2) IG_PROXY_MODE=external ;;
          *) die CANCELLED '已取消，没有做任何更改。' ;;
        esac
      fi
      ;;
  esac
}

configure_external_proxy() {
  IG_HOST_CADDY_SITE=no
  IG_HTTPS_PORT=443
  IG_RELAY_ROLE=''
  IG_HTTP_BIND=80
  IG_APP_PORT="$(free_loopback_port 3001)" || die NO_FREE_PORT '127.0.0.1:3001-3099 没有空闲端口。'
  say ''
  say '使用“已有反向代理”模式：'
  note "Invoice Generator 只监听 127.0.0.1:${IG_APP_PORT}，不占用 80/443"
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

gateway() { sh "$BUNDLE_DIR/oss-gateway.sh" "$@"; }

# Shared HTTPS gateway (docs/HTTPS_GATEWAY.md): one Caddy on 80/443 routes each domain to
# its project's loopback port. Returns 1 when it cannot be used safely on this server.
choose_gateway() {
  local state
  if [[ "$IG_ACCESS_KIND" != domain ]]; then
    say '共享 HTTPS 网关按域名转发，需要域名；IP 访问请选择独立 HTTPS 端口。'
    return 1
  fi
  state="$(gateway detect)"
  case "$state" in
    managed)
      note '检测到共享 HTTPS 网关，将为本项目添加独立站点（先校验，失败自动回滚，其他站点不受影响）'
      ;;
    host-caddy)
      note '检测到宿主机 Caddy 占用 80/443，将在 /etc/caddy/Caddyfile 中添加本项目站点'
      note '修改前自动备份，先校验再重新加载，失败自动恢复，其他网站不受影响'
      if interactive && ! confirm '继续？[Y/n]: '; then return 1; fi
      ;;
    absent)
      note '80/443 空闲：将安装共享 HTTPS 网关（Docker 项目 oss-gateway，占用 80/443）'
      note '之后同一服务器的其他项目可以直接添加自己的域名'
      if interactive && ! confirm '安装共享 HTTPS 网关？[Y/n]: '; then return 1; fi
      ;;
    *)
      say "80/443 端口已被 ${state#unmanageable } 占用，无法安全接管：不会停止或修改它。"
      note '可改选“独立 HTTPS 端口”或“已有反向代理”。'
      interactive || die GATEWAY_UNAVAILABLE "80/443 已被 ${state#unmanageable } 占用，无法使用共享 HTTPS 网关。"
      return 1
      ;;
  esac
  IG_GATEWAY_STATE="$state"
  return 0
}

# gateway (recommended), port (own Caddy on 443 or a custom port) or external.
choose_https_mode() {
  local choice
  IG_HTTPS_MODE="${IG_HTTPS_MODE:-}"
  if [[ -z "$IG_HTTPS_MODE" ]]; then
    if [[ "${IG_PROXY_MODE:-auto}" == external ]]; then
      IG_HTTPS_MODE=external
    elif ! interactive || [[ -n "${IG_HTTPS_PORT:-}" || "${IG_PROXY_MODE:-auto}" == bundled ]]; then
      IG_HTTPS_MODE=port # unattended installs keep their original behaviour
    elif [[ "$IG_ACCESS_KIND" != domain ]]; then
      note '使用 IP 访问：共享 HTTPS 网关需要域名，将使用本项目自己的 HTTPS 入口'
      IG_HTTPS_MODE=port
    fi
  fi
  [[ -z "$IG_HTTPS_MODE" || "$IG_HTTPS_MODE" =~ ^(gateway|port|external)$ ]] || die CONFIG_INVALID 'IG_HTTPS_MODE 无效。'
  while true; do
    if [[ -z "$IG_HTTPS_MODE" ]]; then
      say ''
      say '请选择 HTTPS 方式：'
      note '1) 共享 HTTPS 网关（推荐）：网址不带端口，同一服务器的多个项目共用 80/443，按域名转发'
      note '2) 独立 HTTPS 端口（高级）：本项目使用自己的 Caddy，端口可选 443 或 8443 等'
      note '3) 已有反向代理：只监听本机端口，由你现有的 Nginx/Caddy 提供 HTTPS'
      choice="$(ask '请选择 [1]: ')"
      case "${choice:-1}" in
        1) IG_HTTPS_MODE=gateway ;;
        2) IG_HTTPS_MODE=port ;;
        3) IG_HTTPS_MODE=external ;;
        *) continue ;;
      esac
    fi
    if [[ "$IG_HTTPS_MODE" == gateway ]] && ! choose_gateway; then
      interactive || die GATEWAY_UNAVAILABLE '无法使用共享 HTTPS 网关。'
      IG_HTTPS_MODE=''
      continue
    fi
    return 0
  done
}

choose_proxy_mode() {
  IG_HOST_CADDY_SITE=no
  IG_GATEWAY=no
  choose_https_mode
  case "$IG_HTTPS_MODE" in
    gateway)
      IG_GATEWAY=yes
      IG_PROXY_MODE=external
      IG_HTTPS_PORT=443
      IG_RELAY_ROLE=''
      IG_HTTP_BIND=80
      IG_APP_PORT="$(free_loopback_port 3001)" || die NO_FREE_PORT '127.0.0.1:3001-3099 没有空闲端口。'
      note "本项目内部端口：127.0.0.1:${IG_APP_PORT}（只在本机监听，不对公网开放）"
      return 0
      ;;
    external) IG_PROXY_MODE=external ;;
  esac
  choose_https_port
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    choose_certificate_plan
  fi
  if [[ "$IG_PROXY_MODE" == external ]]; then
    configure_external_proxy
  else
    IG_APP_PORT=3001
  fi
}

# Renders this project's gateway site and adds it; the gateway is created first when absent.
register_gateway_site() {
  local site="$IG_CONFIG_DIR/gateway-site.caddy"
  if [[ "$(gateway detect)" == absent ]]; then
    gateway create || die GATEWAY_START_FAILED '共享 HTTPS 网关安装失败，其他网站未受影响。'
  fi
  render_gateway_site "$IG_ACCESS_HOST" "$IG_APP_PORT" >"$site"
  chmod 644 "$site"
  gateway add-site invoice-generator "$IG_ACCESS_HOST" "$site" ||
    die GATEWAY_SITE_FAILED '无法在共享 HTTPS 网关中添加站点，已回滚，其他网站未受影响。应用仍只在本机端口运行。'
}

write_configuration() {
  local secret
  install -d -m 0755 "$IG_ROOT"
  install -d -m 0700 "$IG_CONFIG_DIR" "$IG_BACKUP_DIR"
  install -d -m 0755 "$IG_RELEASES_DIR"
  if [[ -f "$IG_APP_ENV" ]]; then
    note '检测到未完成的安装，保留已有密钥继续。'
    set_env_value "$IG_APP_ENV" APP_ORIGIN "$(public_origin "$IG_ACCESS_HOST" "$IG_HTTPS_PORT")"
  else
    secret="$(openssl rand -hex 48)"
    write_env_file "$IG_APP_ENV" \
      "APP_ORIGIN=$(public_origin "$IG_ACCESS_HOST" "$IG_HTTPS_PORT")" \
      "SESSION_SECRET=$secret" \
      'PASSWORD_MIN_LENGTH=8' \
      'BUSINESS_BACKUP_LIMIT=64mb'
    unset secret
  fi
  IG_TLS_ISSUER="${IG_TLS_ISSUER:-auto}"
  [[ "$IG_TLS_ISSUER" == auto || "$IG_TLS_ISSUER" == internal ]] || die CONFIG_INVALID 'IG_TLS_ISSUER 无效。'
  if [[ -n "${IG_ACME_CA:-}" ]]; then
    install -m 0644 "$IG_ACME_CA_ROOT" "$IG_ACME_CA_ROOT_FILE"
  fi
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
    "HTTPS_PORT=$IG_HTTPS_PORT" \
    "HTTP_BIND=$IG_HTTP_BIND" \
    "RELAY_ROLE=${IG_RELAY_ROLE:-}" \
    "ACME_CA=${IG_ACME_CA:-}" \
    "GATEWAY=${IG_GATEWAY:-no}" \
    "BACKUP_KEEP=${IG_BACKUP_KEEP:-14}" \
    "INSTALLED_VERSION=$IG_VERSION"
}

start_services() {
  step 3 '正在下载镜像（首次安装可能需要几分钟）'
  ensure_image "$IG_APP_IMAGE"
  [[ "$IG_PROXY_MODE" != bundled ]] || ensure_image "$IG_CADDY_IMAGE"
  step 4 '正在配置服务'
  if [[ "$IG_PROXY_MODE" == bundled ]]; then
    write_caddyfile
    ensure_relay_network
    quietly compose up -d --remove-orphans app caddy
  else
    write_proxy_examples "$IG_ACCESS_HOST" "$IG_APP_PORT"
    quietly compose up -d --remove-orphans app
  fi
  app_healthy || die APP_UNHEALTHY '应用未能通过健康检查。可运行 invoice-generator logs 查看日志。'
  [[ "${IG_GATEWAY:-no}" != yes ]] || register_gateway_site
  if [[ "$IG_HOST_CADDY_SITE" == yes ]]; then
    ensure_host_caddy_site /etc/caddy/Caddyfile "$IG_ACCESS_HOST" "127.0.0.1:$IG_APP_PORT" ||
      warn '宿主机 Caddy 配置未修改（已恢复原配置），请参考示例手动添加。'
  fi
  if ! entry_healthy; then
    if [[ "$IG_PROXY_MODE" == bundled || "${IG_GATEWAY:-no}" == yes ]]; then
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
  step 5 '安装成功'
  say '========================================'
  say '  Invoice Generator 安装完成'
  say '========================================'
  say "访问地址：$(public_origin "$IG_ACCESS_HOST" "$IG_HTTPS_PORT")"
  if [[ "$IG_PROXY_MODE" == external ]]; then
    say "应用监听：127.0.0.1:${IG_APP_PORT}（由你现有的反向代理提供 HTTPS）"
    [[ "$IG_HOST_CADDY_SITE" == yes ]] || say "反向代理示例：$IG_PROXY_DIR"
  else
    local status=0
    say ''
    report_certificate "${IG_CERT_WAIT:-90}" || status=$?
    if [[ "$status" -eq 1 ]]; then
      note '请确认域名已解析到本服务器，并在防火墙/安全组放行下方端口；Caddy 会自动重试。'
      note '稍后运行 sudo invoice-generator https 查看证书状态。'
    elif [[ "$status" -eq 2 ]]; then
      note '可运行 sudo invoice-generator https 导出根证书并核对指纹后导入电脑。'
    fi
  fi
  say ''
  say '常用命令：'
  note 'sudo invoice-generator          管理菜单'
  note 'sudo invoice-generator status   运行状态'
  note 'sudo invoice-generator doctor   健康检查'
  note 'sudo invoice-generator backup   立即备份'
  note 'sudo invoice-generator upgrade  一键升级'
  say ''
  say "数据备份目录：${IG_BACKUP_DIR}（每天自动备份，保留最近 ${IG_BACKUP_KEEP:-14} 份自动备份）"
  say '请定期把备份复制到服务器以外的安全位置。'
  if [[ "${IG_GATEWAY:-no}" == yes ]]; then
    say '云服务器请在安全组/防火墙中放行 TCP 80 和 443。'
    say '同一服务器的其他网站可用 sudo oss-gateway add <名称> <域名> 127.0.0.1:<端口> 添加。'
  elif [[ "$IG_PROXY_MODE" == bundled ]]; then
    if [[ "$IG_RELAY_ROLE" == holder ]]; then
      say "云服务器请在安全组/防火墙中放行 TCP 80 和 TCP ${IG_HTTPS_PORT}。"
      [[ "$IG_HTTPS_PORT" == 443 ]] || say '80 端口用于证书验证，并为同一服务器上的其他项目转发证书验证请求，请保持本项目运行。'
    else
      say "云服务器请在安全组/防火墙中放行 TCP ${IG_HTTPS_PORT}。"
    fi
    [[ "$IG_RELAY_ROLE" != member ]] || say "证书续期依赖占用 80 端口的项目（${IG_PORT80_OWNER}）保持运行。"
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
