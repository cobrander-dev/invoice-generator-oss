#!/usr/bin/env bash
# HTTPS configuration for the bundled Caddy entry point and examples for existing proxies.

# render_caddyfile KIND HOST [ISSUER]
#   domain: Caddy's automatic public certificate (Let's Encrypt / ZeroSSL).
#   ip:     Let's Encrypt short-lived IP certificate first, then Caddy's local CA, so the
#           site is never served over plain HTTP.
#   ISSUER=internal forces the local CA (isolated tests without public DNS).
render_caddyfile() {
  local kind="$1" host="$2" issuer="${3:-auto}" sni='' site tls=''
  [[ "$kind" == ip ]] && sni=$'\tdefault_sni '"$host"$'\n'
  if [[ "$issuer" == internal ]]; then
    tls=$'\ttls internal\n'
  elif [[ "$kind" == ip ]]; then
    tls=$'\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t\tissuer internal\n\t}\n'
  fi
  site="$host"
  [[ "$kind" == ip ]] && site="https://$host"
  printf '{\n\tadmin off\n\tpersist_config off\n\tskip_install_trust\n%s\tservers {\n\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body 120s\n\t\t\twrite 120s\n\t\t\tidle 2m\n\t\t}\n\t}\n}\n\n' "$sni"
  printf '%s {\n%s' "$site" "$tls"
  printf '\tencode zstd gzip\n'
  printf '\trequest_body {\n\t\tmax_size 70MB\n\t}\n'
  printf '\theader -Server\n'
  printf '\treverse_proxy app:3000\n'
  printf '}\n'
}

write_caddyfile() {
  local temporary
  temporary="$(mktemp "$IG_CADDYFILE.XXXXXX")"
  render_caddyfile "$IG_ACCESS_KIND" "$IG_ACCESS_HOST" "${IG_TLS_ISSUER:-auto}" >"$temporary"
  chmod 644 "$temporary" # read by the non-root Caddy container; contains no secrets
  mv -f -- "$temporary" "$IG_CADDYFILE"
}

# Examples for an existing reverse proxy that already terminates TLS on 443.
write_proxy_examples() {
  local host="$1" port="$2"
  install -d -m 0755 "$IG_PROXY_DIR"
  cat >"$IG_PROXY_DIR/nginx-invoice-generator.conf" <<EOF
# Invoice Generator — Nginx 反向代理示例。请替换证书路径后放入 Nginx 配置并执行 nginx -t。
server {
    listen 443 ssl http2;
    server_name $host;

    ssl_certificate     /etc/ssl/certs/REPLACE_WITH_CERTIFICATE.pem;
    ssl_certificate_key /etc/ssl/private/REPLACE_WITH_PRIVATE_KEY.pem;

    client_max_body_size 70m;

    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_read_timeout 120s;
    }
}

server {
    listen 80;
    server_name $host;
    return 301 https://\$host\$request_uri;
}
EOF
  cat >"$IG_PROXY_DIR/Caddyfile-invoice-generator" <<EOF
# Invoice Generator — Caddy 反向代理示例。追加到现有 Caddyfile 后执行 caddy validate 与 systemctl reload caddy。
$host {
    request_body {
        max_size 70MB
    }
    reverse_proxy 127.0.0.1:$port
}
EOF
  chmod 644 "$IG_PROXY_DIR"/*
}

# Exports the local CA root used for IP installs so browsers can trust it.
export_local_ca() {
  local target="$IG_CONFIG_DIR/https/local-ca-root.crt"
  install -d -m 0755 "$IG_CONFIG_DIR/https"
  compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$target.tmp" 2>/dev/null || {
    rm -f -- "$target.tmp"
    return 1
  }
  mv -f -- "$target.tmp" "$target"
  chmod 644 "$target"
  printf '%s\n' "$target"
}
