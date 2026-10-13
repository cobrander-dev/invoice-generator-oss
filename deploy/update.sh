#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/host-caddy.sh"
log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }
env_value() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$PROJECT_DIR/.env"; }

if [[ "${1:-}" == '--check' ]]; then
  bash -n "$0" "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/backup.sh" "$SCRIPT_DIR/lib/host-caddy.sh"
  grep -q 'merge --ff-only "$target_commit"' "$0" || die 'exact-commit fast-forward guard is missing'
  grep -q 'candidate.sqlite' "$0" || die 'isolated candidate database is missing'
  log 'update script passed static validation'
  exit 0
fi

target_commit="${1:-}"
[[ "$target_commit" =~ ^[0-9a-f]{40}$ ]] || die 'usage: sudo ./deploy/update.sh <40-character-git-commit-sha>'
[[ $# -eq 1 ]] || die 'exactly one immutable commit SHA is required'
[[ "$(id -u)" -eq 0 ]] || die 'run with sudo on Ubuntu'
cd "$PROJECT_DIR"
[[ -d .git && -f .env ]] || die 'run from an installed repository with .env'
[[ -z "$(git status --porcelain)" ]] || die 'deployment checkout has uncommitted changes'
valid_domain "$(env_value DOMAIN)" || die 'existing DOMAIN is invalid'
[[ "$(env_value APP_ORIGIN)" == "https://$(env_value DOMAIN)" ]] || die 'APP_ORIGIN must match DOMAIN over HTTPS'
deployment_mode='BUNDLED_CADDY'
compose_files=(-f "$PROJECT_DIR/docker-compose.yml")
if detect_existing_host_caddy /etc/caddy/Caddyfile; then
  deployment_mode='EXISTING_HOST_CADDY'
fi
configured_mode="$(env_value DEPLOYMENT_MODE)"
if [[ -n "$configured_mode" ]]; then
  [[ "$configured_mode" == 'BUNDLED_CADDY' || "$configured_mode" == 'EXISTING_HOST_CADDY' ]] || die 'configured DEPLOYMENT_MODE is invalid'
  [[ "$configured_mode" == "$deployment_mode" ]] || die 'configured deployment mode does not match the detected Caddy environment'
fi
if [[ "$deployment_mode" == 'EXISTING_HOST_CADDY' ]]; then
  compose_files+=(-f "$PROJECT_DIR/docker-compose.host-caddy.yml")
  log 'detected EXISTING_HOST_CADDY; updater will not modify or restart host Caddy'
fi
compose() { docker compose "${compose_files[@]}" "$@"; }
branch="$(git branch --show-current)"
[[ -n "$branch" ]] || die 'detached HEAD is not supported'
old_head="$(git rev-parse HEAD)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
candidate_tag="candidate-${target_commit:0:12}"
candidate_image="foreign-trade-invoice-generator:${candidate_tag}"
rollback_tag="rollback-${old_head:0:12}"
candidate_name="ft-candidate-${target_commit:0:12}-$$"
candidate_volume="ft_candidate_${target_commit:0:12}_$$"
candidate_root="$(mktemp -d /tmp/foreign-trade-update.XXXXXX)"
candidate_source="$candidate_root/source"
candidate_seed="$candidate_root/candidate-source.sqlite"
rollback_seed="$candidate_root/pre-update.sqlite"
candidate_container=''
promotion_started=false
promotion_backup_ready=false

wait_healthy() {
  local container="$1" health=''
  for _ in {1..30}; do
    health="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$health" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

release_candidate_runtime() {
  [[ -z "$candidate_container" ]] || docker rm -f "$candidate_container" >/dev/null 2>&1 || true
  docker volume rm "$candidate_volume" >/dev/null 2>&1 || true
  if [[ -d "$candidate_source" ]]; then git worktree remove --force "$candidate_source" >/dev/null 2>&1 || true; fi
}

cleanup_candidate() {
  release_candidate_runtime
  rm -rf -- "$candidate_root"
}

restore_checkout() {
  [[ "$(git rev-parse HEAD)" == "$old_head" ]] && return 0
  git switch --detach "$old_head"
  git branch -f "$branch" "$old_head"
  git switch "$branch"
}

rollback_production() {
  local failed_status="${1:-$?}" reason="${2:-unexpected command failure}"
  trap - ERR
  if [[ "$promotion_started" == true ]]; then
    log 'promotion failed; stopping services before restoring the consistent SQLite backup'
    restore_checkout
    if [[ "$deployment_mode" == 'BUNDLED_CADDY' ]]; then
      APP_IMAGE_TAG="$rollback_tag" compose stop caddy >/dev/null 2>&1 || true
    fi
    APP_IMAGE_TAG="$rollback_tag" compose stop app >/dev/null 2>&1 || true
    if [[ "$promotion_backup_ready" == true ]]; then
      chmod 644 "$rollback_seed"
      if ! APP_IMAGE_TAG="$rollback_tag" compose run --rm --no-deps --user node \
        -v "$rollback_seed:/rollback.sqlite:ro" --entrypoint sh app -c \
        "set -eu; cp '/rollback.sqlite' '/app/data/foreign-trade.sqlite.restore'; chmod 600 '/app/data/foreign-trade.sqlite.restore'; rm -f '/app/data/foreign-trade.sqlite-wal' '/app/data/foreign-trade.sqlite-shm'; mv '/app/data/foreign-trade.sqlite.restore' '/app/data/foreign-trade.sqlite'"; then
        chmod 600 "$rollback_seed"
        die 'rollback could not restore the consistent SQLite backup; public traffic remains stopped'
      fi
      chmod 600 "$rollback_seed"
    fi
    docker image tag "foreign-trade-invoice-generator:$rollback_tag" foreign-trade-invoice-generator:current
    APP_IMAGE_TAG=current compose up -d --no-build app
    local restored_container
    restored_container="$(APP_IMAGE_TAG=current compose ps -q app)"
    wait_healthy "$restored_container" || die 'rollback restored the database and old image, but health check failed; stop and inspect before retrying'
    APP_IMAGE_TAG=current compose exec -T app sh -c "umask 077; printf '%s\n' '$old_head' > /app/data/production-commit"
    if [[ "$deployment_mode" == 'BUNDLED_CADDY' ]]; then
      APP_IMAGE_TAG=current compose up -d --no-build caddy
    fi
    die "promotion failed ($reason); old image and matching SQLite backup were restored (original status $failed_status)"
  fi
  cleanup_candidate
  die "candidate preflight failed ($reason); Production code, image and SQLite were not changed (original status $failed_status)"
}
trap rollback_production ERR
trap 'rollback_production 130 interrupted' INT TERM
trap cleanup_candidate EXIT

log 'creating a consistent SQLite backup for isolated candidate migration testing'
candidate_backup="candidate-source-${timestamp}.sqlite"
compose exec -T -e BACKUP_PATH="/app/data/backups/${candidate_backup}" app npm run db:backup
production_container="$(compose ps -q app)"
[[ -n "$production_container" ]] || rollback_production 1 'Production application container is not running'
docker cp "$production_container:/app/data/backups/$candidate_backup" "$candidate_seed"
chmod 600 "$candidate_seed"

log "fetching immutable target $target_commit"
git fetch --prune origin
git cat-file -e "${target_commit}^{commit}" 2>/dev/null || rollback_production 1 'target commit does not exist after fetching origin'
git for-each-ref --contains="$target_commit" --format='%(refname)' refs/remotes/origin/ | grep -q '^refs/remotes/origin/' || rollback_production 1 'target commit is not reachable from the configured origin repository'
git merge-base --is-ancestor "$old_head" "$target_commit" || rollback_production 1 'target commit is not a fast-forward successor of the current Production version'

git worktree add --detach "$candidate_source" "$target_commit"
ln -s "$PROJECT_DIR/.env" "$candidate_source/.env"
candidate_compose_files=(-f "$candidate_source/docker-compose.yml")
if [[ "$deployment_mode" == 'EXISTING_HOST_CADDY' ]]; then
  candidate_compose_files+=(-f "$candidate_source/docker-compose.host-caddy.yml")
fi
docker compose "${candidate_compose_files[@]}" config --quiet
log "building exact candidate image $candidate_image"
docker build --pull -t "$candidate_image" "$candidate_source"

docker volume create "$candidate_volume" >/dev/null
docker run --rm --user 0 -v "$candidate_volume:/app/data" -v "$candidate_seed:/seed.sqlite:ro" \
  --entrypoint sh "$candidate_image" -c \
  "set -eu; chown node:node /app/data; cp /seed.sqlite /app/data/candidate.sqlite; chown node:node /app/data/candidate.sqlite; chmod 600 /app/data/candidate.sqlite"
candidate_secret="$(openssl rand -hex 48)"
candidate_container="$(docker run -d --name "$candidate_name" --network none --env-file .env \
  -e SESSION_SECRET="$candidate_secret" -e DATABASE_PATH=/app/data/candidate.sqlite \
  --health-cmd="node -e \"require('node:http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"" \
  --health-interval=2s --health-timeout=2s --health-retries=30 --health-start-period=5s \
  -v "$candidate_volume:/app/data" "$candidate_image")"
unset candidate_secret
wait_healthy "$candidate_container"
docker exec "$candidate_container" node -e \
  "require('node:http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
release_candidate_runtime
candidate_container=''

docker image inspect foreign-trade-invoice-generator:current >/dev/null
docker image tag foreign-trade-invoice-generator:current "foreign-trade-invoice-generator:$rollback_tag"

promotion_started=true
log 'candidate passed; quiescing public traffic before the final consistent SQLite backup'
if [[ "$deployment_mode" == 'BUNDLED_CADDY' ]]; then
  APP_IMAGE_TAG=current compose stop caddy
  compose exec -T -e BACKUP_PATH="/app/data/backups/pre-update-${timestamp}.sqlite" app npm run db:backup
  APP_IMAGE_TAG=current compose stop app
else
  APP_IMAGE_TAG=current compose stop app
  APP_IMAGE_TAG=current compose run --rm --no-deps -e BACKUP_PATH="/app/data/backups/pre-update-${timestamp}.sqlite" app npm run db:backup
fi
docker cp "$production_container:/app/data/backups/pre-update-${timestamp}.sqlite" "$rollback_seed"
chmod 600 "$rollback_seed"
promotion_backup_ready=true
git merge --ff-only "$target_commit"
[[ "$(git rev-parse HEAD)" == "$target_commit" ]] || rollback_production 1 'deployment checkout does not match requested commit'
docker image tag "$candidate_image" foreign-trade-invoice-generator:current
APP_IMAGE_TAG=current compose up -d --no-build app
container_id="$(APP_IMAGE_TAG=current compose ps -q app)"
wait_healthy "$container_id"
APP_IMAGE_TAG=current compose exec -T app sh -c "umask 077; printf '%s\n' '$target_commit' > /app/data/production-commit"
cleanup_candidate
promotion_started=false
trap - ERR INT TERM EXIT
if [[ "$deployment_mode" == 'BUNDLED_CADDY' ]]; then
  if ! APP_IMAGE_TAG=current compose up -d --no-build caddy; then
    APP_IMAGE_TAG=current compose stop caddy >/dev/null 2>&1 || true
    die 'application and database promotion succeeded, but Caddy failed to start; public traffic remains stopped and operator action is required'
  fi
fi
log "updated Production from $old_head to immutable commit $target_commit; rollback image and SQLite backup were preserved"
