#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"
[[ -f .env ]] || { printf 'ERROR: .env is missing\n' >&2; exit 1; }
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="/app/data/backups/database-${timestamp}.sqlite"
docker compose exec -T -e BACKUP_PATH="$destination" app npm run db:backup
printf 'SQLite backup created inside the persistent app_data volume: %s\n' "$destination"
