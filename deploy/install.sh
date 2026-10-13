#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/environment.sh"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/host-caddy.sh"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }
env_value() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$PROJECT_DIR/.env"; }

validate_files() {
  [[ -f "$PROJECT_DIR/Dockerfile" ]] || die 'Dockerfile is missing'
  [[ -f "$PROJECT_DIR/docker-compose.yml" ]] || die 'docker-compose.yml is missing'
  [[ -f "$PROJECT_DIR/docker-compose.host-caddy.yml" ]] || die 'host Caddy Compose override is missing'
  [[ -f "$PROJECT_DIR/deploy/caddy/Caddyfile" ]] || die 'Caddyfile is missing'
  [[ -f "$PROJECT_DIR/deploy/lib/environment.sh" ]] || die 'environment helper is missing'
  [[ -f "$PROJECT_DIR/deploy/lib/host-caddy.sh" ]] || die 'host Caddy helper is missing'
  bash -n "$PROJECT_DIR/deploy/install.sh" "$PROJECT_DIR/deploy/update.sh" "$PROJECT_DIR/deploy/backup.sh" "$PROJECT_DIR/deploy/lib/environment.sh" "$PROJECT_DIR/deploy/lib/host-caddy.sh"
  log 'deployment files passed static validation'
}

if [[ "${1:-}" == '--check' ]]; then validate_files; exit 0; fi
[[ "$(id -u)" -eq 0 ]] || die 'run with sudo on Ubuntu'
[[ -r /etc/os-release ]] || die 'unsupported system: /etc/os-release is missing'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || die 'Phase 5 installer supports Ubuntu only'

install_host_tools() {
  apt-get update
  apt-get install -y ca-certificates curl git openssl openssh-client iproute2
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then return; fi
  log 'installing Docker Engine and Compose plugin from the official repository'
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "${VERSION_CODENAME}" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_host_tools
install_docker

if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  repository_url="${REPOSITORY_SSH_URL:-}"
  install_dir="${INSTALL_DIR:-/opt/foreign-trade-invoice-generator}"
  [[ "$repository_url" =~ ^git@github\.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ || "$repository_url" =~ ^ssh://git@github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]] || die 'set a GitHub SSH repository URL in REPOSITORY_SSH_URL'
  [[ ! -e "$install_dir" ]] || die 'INSTALL_DIR already exists; run its deploy/install.sh instead'
  log 'cloning the repository through the configured SSH URL'
  git clone "$repository_url" "$install_dir"
  exec "$install_dir/deploy/install.sh"
fi

cd "$PROJECT_DIR"
validate_files

deployment_mode='BUNDLED_CADDY'
compose_files=(-f "$PROJECT_DIR/docker-compose.yml")
if detect_existing_host_caddy /etc/caddy/Caddyfile; then
  deployment_mode='EXISTING_HOST_CADDY'
  compose_files+=(-f "$PROJECT_DIR/docker-compose.host-caddy.yml")
  log 'detected active host Caddy on ports 80 and 443; selecting EXISTING_HOST_CADDY'
else
  log 'selecting bundled app + Caddy Compose deployment'
fi
compose() { docker compose "${compose_files[@]}" "$@"; }

[[ ! -L .env ]] || die 'existing .env must not be a symbolic link'
[[ ! -e .env || -f .env ]] || die 'existing .env must be a regular file'
if [[ ! -f .env ]]; then
  read -r -p 'Domain (for example invoice.example.com): ' domain
  valid_domain "$domain" || die 'invalid domain'
  secret="$(openssl rand -hex 48)"
  temp_env="$(mktemp "$PROJECT_DIR/.env.XXXXXX")"
  {
    printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\n'
    printf 'DOMAIN=%s\nAPP_ORIGIN=https://%s\n' "$domain" "$domain"
    printf 'DEPLOYMENT_MODE=%s\n' "$deployment_mode"
    printf 'DATABASE_PATH=/app/data/foreign-trade.sqlite\nBUSINESS_BACKUP_LIMIT=64mb\n'
    printf 'PASSWORD_MIN_LENGTH=8\n'
    printf 'SESSION_SECRET=%s\nTRUST_PROXY_HOPS=1\n' "$secret"
  } > "$temp_env"
  chmod 600 "$temp_env"
  mv "$temp_env" .env
  unset secret
  log 'created .env with a new random session secret'
else
  env_content_before="$(sha256sum .env | awk '{print $1}')"
  project_owner_uid="$(file_owner_uid "$PROJECT_DIR")"
  secure_env_file .env "$project_owner_uid" || die 'existing .env owner is not root or the project owner'
  existing_secret="$(env_value SESSION_SECRET)"
  [[ "$(env_value NODE_ENV)" == production ]] || die 'existing .env is not production configuration'
  valid_domain "$(env_value DOMAIN)" || die 'existing DOMAIN is invalid'
  [[ "$(env_value APP_ORIGIN)" == "https://$(env_value DOMAIN)" ]] || die 'APP_ORIGIN must match DOMAIN over HTTPS'
  [[ "$(env_value DATABASE_PATH)" == /app/data/* ]] || die 'DATABASE_PATH must use the persistent /app/data volume'
  [[ "$existing_secret" != change-me && ${#existing_secret} -ge 32 ]] || die 'existing SESSION_SECRET is unsafe'
  [[ "$(sha256sum .env | awk '{print $1}')" == "$env_content_before" ]] || die 'existing .env content changed while securing permissions'
  unset existing_secret
  log 'preserving existing .env and session secret'
fi

configured_mode="$(env_value DEPLOYMENT_MODE)"
if [[ -n "$configured_mode" ]]; then
  [[ "$configured_mode" == 'BUNDLED_CADDY' || "$configured_mode" == 'EXISTING_HOST_CADDY' ]] || die 'existing DEPLOYMENT_MODE is invalid'
  [[ "$configured_mode" == "$deployment_mode" ]] || die 'configured deployment mode does not match the detected Caddy environment'
fi

compose config --quiet
compose build --pull app
if [[ "$deployment_mode" == 'EXISTING_HOST_CADDY' ]]; then
  compose up -d app
else
  compose up -d app caddy
fi

container_id="$(compose ps -q app)"
[[ -n "$container_id" ]] || die 'application container did not start'
for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "${health:-}" == healthy ]] || die 'application health check failed'
if [[ "$deployment_mode" == 'EXISTING_HOST_CADDY' ]]; then
  curl -fsS http://127.0.0.1:3001/health >/dev/null || die 'host-bound application health check failed on 127.0.0.1:3001'
  ensure_host_caddy_site /etc/caddy/Caddyfile "$(env_value DOMAIN)" '127.0.0.1:3001' || die 'host Caddy configuration failed and was rolled back'
fi

set +e
compose exec -T app npm run admin:status >/dev/null 2>&1
admin_status=$?
set -e
if [[ "$admin_status" -eq 0 ]]; then
  log 'administrator already exists; credentials were not changed'
elif [[ "$admin_status" -eq 3 ]]; then
  read -r -p 'Administrator username or email: ' admin_user
  read -r -s -p 'Administrator password: ' admin_password; printf '\n'
  password_minimum="$(env_value PASSWORD_MIN_LENGTH)"; password_minimum="${password_minimum:-8}"
  [[ -n "$admin_user" ]] && valid_admin_password "$admin_password" "$password_minimum" || die "administrator password must be ${password_minimum}-1024 characters and not weak or a placeholder"
  printf '%s' "$admin_password" | compose exec -T -e ADMIN_USERNAME="$admin_user" -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
  unset admin_password
else
  die 'administrator status could not be verified'
fi

log "ready: https://$(env_value DOMAIN)"
