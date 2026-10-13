#!/usr/bin/env bash
# Invoice Generator 一键安装程序 / One-line installer
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/download/@VERSION@/install.sh -o install.sh && bash install.sh
#
# The script runs only after curl has saved the whole file. Started by a non-root user, it
# re-runs itself through sudo.
#
# This file is rendered for one release: it downloads that release's installer bundle,
# checks it against the SHA-256 embedded below, installs Docker from Docker's official
# repository when missing (after pinning Docker's GPG key fingerprint) and runs setup.sh.
# Re-running it on an installed server opens the management menu instead.
set -Eeuo pipefail
umask 077

IG_REPOSITORY='@REPOSITORY@'
IG_RELEASE='@VERSION@'
IG_BUNDLE_SHA256='@BUNDLE_SHA256@'
IG_BUNDLE_NAME=invoice-generator-installer.tar.gz
IG_CLI=/usr/local/bin/invoice-generator
DOCKER_GPG_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

say() { printf '%s\n' "$*"; }
step() { printf '\n[%s/5] %s\n' "$1" "$2"; }
die() {
  printf '失败 [%s]：%s\n' "$1" "${2:-}" >&2
  exit 1
}
ask() {
  local answer=''
  [[ "${IG_NONINTERACTIVE:-0}" == 1 ]] && {
    printf '%s' "${2:-}"
    return 0
  }
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=''
  printf '%s' "$answer"
}

[[ "$IG_BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die INSTALLER_NOT_RENDERED '这是未发布的模板文件，请从 GitHub Release 下载 install.sh。'
if [[ "$(id -u)" -ne 0 ]]; then
  [[ -f "$0" ]] && command -v sudo >/dev/null 2>&1 || die ROOT_REQUIRED '请使用 root 运行，或在命令前加 sudo。'
  forward=() # keep the caller's exported IG_* answers (unattended installs)
  while read -r name; do
    [[ "$name" == IG_* ]] && forward+=("$name=${!name}")
  done < <(compgen -e)
  exec sudo ${forward[@]+"${forward[@]}"} bash "$0" "$@"
fi
[[ "$(uname -s)" == Linux ]] || die LINUX_REQUIRED '仅支持 Linux 服务器。'
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die ARCH_UNSUPPORTED "不支持的 CPU 架构：$(uname -m)（支持 x86_64 与 arm64）。" ;;
esac
[[ "${IG_NONINTERACTIVE:-0}" == 1 || -r /dev/tty ]] || die TTY_REQUIRED '需要交互式终端（请通过 SSH 登录后运行）。'

say ''
say '========================================'
say "  Invoice Generator 安装程序 $IG_RELEASE"
say '========================================'

if [[ -x "$IG_CLI" && -f /opt/invoice-generator/config/installer.env ]]; then
  say '检测到已安装 Invoice Generator，打开管理菜单。'
  exec "$IG_CLI"
fi

step 1 '正在检查系统'
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
OS_ID="${ID:-unknown}"
OS_VERSION="${VERSION_ID:-unknown}"
case "$OS_ID $OS_VERSION" in
  'ubuntu 22.04' | 'ubuntu 24.04' | 'ubuntu 26.04' | 'debian 12' | 'debian 13') ;;
  *)
    say "提示：当前系统 $OS_ID $OS_VERSION 未经验证，推荐 Ubuntu 26.04 / 24.04 / 22.04 或 Debian 12 / 13。"
    case "$(ask '仍要继续吗？[y/N]: ' n)" in y | Y) ;; *) exit 1 ;; esac
    ;;
esac

say "系统：$OS_ID $OS_VERSION（$ARCH）"

step 2 '正在安装依赖'
missing=()
for tool in curl:curl openssl:openssl ss:iproute2 tar:tar sha256sum:coreutils gpg:gnupg gzip:gzip flock:util-linux; do
  command -v "${tool%%:*}" >/dev/null 2>&1 || missing+=("${tool#*:}")
done
if ((${#missing[@]})); then
  command -v apt-get >/dev/null 2>&1 || die TOOLS_REQUIRED "缺少工具：${missing[*]}，请先手动安装。"
  say "安装必要工具：${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates "${missing[@]}" >/dev/null
fi

install_docker() {
  local key fingerprint
  case "$OS_ID" in ubuntu | debian) ;; *) die DOCKER_REQUIRED '该系统无法自动安装 Docker，请先按 https://docs.docker.com/engine/install/ 安装。' ;; esac
  [[ -n "${VERSION_CODENAME:-}" ]] || die OS_CODENAME_REQUIRED '无法识别系统版本代号。'
  say '从 Docker 官方源安装 Docker Engine 与 Compose 插件...'
  install -m 0755 -d /etc/apt/keyrings
  key="$(mktemp)"
  curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$OS_ID/gpg" -o "$key"
  fingerprint="$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
  [[ "$fingerprint" == "$DOCKER_GPG_FINGERPRINT" ]] || {
    rm -f -- "$key"
    die DOCKER_KEY_MISMATCH 'Docker 官方 GPG 密钥指纹不匹配，已停止。'
  }
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  rm -f -- "$key"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$ARCH" "$OS_ID" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
}

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say '未检测到 Docker Engine 或 Docker Compose 插件。'
  case "$(ask '是否从 Docker 官方源自动安装？[Y/n]: ' y)" in
    n | N | no | NO) die DOCKER_REQUIRED '请先安装 Docker：https://docs.docker.com/engine/install/' ;;
    *) install_docker ;;
  esac
fi
docker info >/dev/null 2>&1 || die DOCKER_DAEMON_UNAVAILABLE 'Docker 服务未运行，请执行 systemctl start docker 后重试。'
say 'Docker 已就绪。'

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
if [[ -n "${IG_BUNDLE_FILE:-}" ]]; then
  cp -- "$IG_BUNDLE_FILE" "$work/$IG_BUNDLE_NAME" # offline install or isolated test
else
  say '正在下载安装包...'
  curl -fsSL --proto '=https' --tlsv1.2 \
    "https://github.com/$IG_REPOSITORY/releases/download/$IG_RELEASE/$IG_BUNDLE_NAME" -o "$work/$IG_BUNDLE_NAME" ||
    die RELEASE_DOWNLOAD_FAILED '下载失败，请检查网络或 GitHub 访问。'
fi
[[ "$(sha256sum "$work/$IG_BUNDLE_NAME" | awk '{print $1}')" == "$IG_BUNDLE_SHA256" ]] ||
  die RELEASE_CHECKSUM_MISMATCH '安装包校验失败，已停止。'
mkdir "$work/bundle"
tar -xzf "$work/$IG_BUNDLE_NAME" -C "$work/bundle" --no-same-owner
(cd "$work/bundle" && sha256sum --check --strict --quiet MANIFEST.sha256) ||
  die RELEASE_CHECKSUM_MISMATCH '安装包内容校验失败，已停止。'
say '安装包校验通过。'

suggested_ip=''
if [[ -z "${IG_ACCESS_HOST:-}" ]]; then
  suggested_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [[ "$suggested_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || suggested_ip=''
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say '提示：检测到 ufw 防火墙已启用。使用内置 HTTPS 时请放行：ufw allow 80,443/tcp'
fi

IG_SUGGESTED_IP="$suggested_ip" bash "$work/bundle/setup.sh"
