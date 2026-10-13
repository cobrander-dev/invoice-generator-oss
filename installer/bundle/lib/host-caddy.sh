#!/usr/bin/env bash

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]
}

host_caddy_is_listening() {
  local port="$1"
  ss -H -ltnp 2>/dev/null | awk -v port=":${port}" '
    $4 ~ (port "$") && $0 ~ /caddy/ { found=1 }
    END { exit(found ? 0 : 1) }
  '
}

detect_existing_host_caddy() {
  local caddy_file="${1:-/etc/caddy/Caddyfile}"
  [[ -f "$caddy_file" && ! -L "$caddy_file" ]] || return 1
  command -v caddy >/dev/null 2>&1 || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  command -v ss >/dev/null 2>&1 || return 1
  systemctl is-active --quiet caddy || return 1
  host_caddy_is_listening 80 || return 1
  host_caddy_is_listening 443 || return 1
}

validate_host_caddy_file() {
  caddy validate --config "$1" --adapter caddyfile >/dev/null
}

host_caddy_has_site() {
  local caddy_file="$1" domain="$2" escaped_domain
  escaped_domain="${domain//./\\.}"
  grep -Eq "^[[:space:]]*(https?://)?${escaped_domain}([[:space:]:,{]|$)" "$caddy_file"
}

ensure_host_caddy_site() {
  local caddy_file="$1" domain="$2" upstream="$3"
  local timestamp backup_file temporary_file

  valid_domain "$domain" || {
    printf '[host-caddy] ERROR: invalid domain: %s\n' "$domain" >&2
    return 1
  }

  [[ -f "$caddy_file" && ! -L "$caddy_file" ]] || {
    printf '[host-caddy] ERROR: Caddyfile must be a regular non-symlink file: %s\n' "$caddy_file" >&2
    return 1
  }
  validate_host_caddy_file "$caddy_file" || {
    printf '[host-caddy] ERROR: existing Caddyfile validation failed; no changes made\n' >&2
    return 1
  }
  if host_caddy_has_site "$caddy_file" "$domain"; then
    printf '[host-caddy] existing site preserved: %s\n' "$domain"
    return 0
  fi

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="${caddy_file}.backup-${timestamp}"
  temporary_file="$(mktemp "${caddy_file}.tmp.XXXXXX")"
  cp -a -- "$caddy_file" "$backup_file"
  cp -a -- "$caddy_file" "$temporary_file"
  {
    printf '\n# BEGIN Invoice Generator\n'
    printf '%s {\n' "$domain"
    printf '    reverse_proxy %s\n' "$upstream"
    printf '}\n'
    printf '# END Invoice Generator\n'
  } >> "$temporary_file"

  if ! validate_host_caddy_file "$temporary_file"; then
    cp -a -- "$backup_file" "$caddy_file"
    rm -f -- "$temporary_file"
    printf '[host-caddy] ERROR: candidate Caddyfile validation failed; original restored from %s\n' "$backup_file" >&2
    return 1
  fi

  mv -f -- "$temporary_file" "$caddy_file"
  if ! validate_host_caddy_file "$caddy_file"; then
    cp -a -- "$backup_file" "$caddy_file"
    printf '[host-caddy] ERROR: installed Caddyfile validation failed; original restored from %s\n' "$backup_file" >&2
    return 1
  fi
  if ! systemctl reload caddy; then
    cp -a -- "$backup_file" "$caddy_file"
    validate_host_caddy_file "$caddy_file" >/dev/null 2>&1 || true
    systemctl reload caddy >/dev/null 2>&1 || true
    printf '[host-caddy] ERROR: Caddy reload failed; original restored from %s\n' "$backup_file" >&2
    return 1
  fi
  printf '[host-caddy] site installed and Caddy reloaded: %s -> %s\n' "$domain" "$upstream"
}
