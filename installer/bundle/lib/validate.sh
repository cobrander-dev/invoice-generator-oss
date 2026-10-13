#!/usr/bin/env bash
# Administrator password rules shared with the server password policy.

valid_admin_password() {
  local password="$1" minimum="${2:-8}" normalized
  normalized="$(printf '%s' "$password" | tr '[:upper:]' '[:lower:]')"
  [[ "$minimum" =~ ^[0-9]+$ && "$minimum" -ge 8 && "$minimum" -le 128 ]] || return 1
  [[ ${#password} -ge "$minimum" && ${#password} -le 1024 && ! "$normalized" =~ change-me|replace-me|^12345678$|^password$|^abcdefgh$|^qwerty123$|^admin123$ ]]
}
