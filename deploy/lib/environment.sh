#!/usr/bin/env bash

file_owner_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

secure_env_file() {
  local env_file="$1" expected_owner_uid="$2" owner_uid
  [[ -f "$env_file" && ! -L "$env_file" ]] || return 1
  owner_uid="$(file_owner_uid "$env_file")"
  [[ "$owner_uid" == 0 || "$owner_uid" == "$expected_owner_uid" ]] || return 1
  chmod 600 "$env_file"
  [[ "$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")" == 600 ]]
}

valid_admin_password() {
  local password="$1" minimum="${2:-8}" normalized
  normalized="$(printf '%s' "$password" | tr '[:upper:]' '[:lower:]')"
  [[ "$minimum" =~ ^[0-9]+$ && "$minimum" -ge 8 && "$minimum" -le 128 ]] || return 1
  [[ ${#password} -ge "$minimum" && ${#password} -le 1024 && ! "$normalized" =~ change-me|replace-me|^12345678$|^password$|^abcdefgh$|^qwerty123$|^admin123$ ]]
}
