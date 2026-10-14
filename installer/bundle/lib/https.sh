#!/usr/bin/env bash
# HTTPS configuration for the bundled Caddy entry point and examples for existing proxies.

# render_caddyfile KIND HOST [ISSUER] [HTTPS_PORT] [RELAY_ROLE] [ACME_CA]
#   domain: Caddy's automatic public certificate (Let's Encrypt / ZeroSSL).
#   ip:     Let's Encrypt short-lived IP certificate first, then Caddy's local CA, so the
#           site is never served over plain HTTP.
#   ISSUER=internal forces the local CA (no usable ACME challenge, or isolated tests).
#   HTTPS_PORT: published host port; Caddy always listens on 443 inside the container.
#     TLS-ALPN-01 is validated on public port 443, so it is disabled for any other port.
#   RELAY_ROLE (see decide_relay_role): holder adds the shared port-80 relay; none disables
#     HTTP-01 because port 80 belongs to an unrelated program. Empty = installation from
#     before custom ports (443, no relay), kept byte-compatible.
#   ACME_CA: private ACME directory (tests); its root is mounted at /etc/caddy/acme-ca-root.pem.
render_caddyfile() {
  local kind="$1" host="$2" issuer="${3:-auto}" port="${4:-443}" role="${5:-}" ca="${6:-}"
  local sni='' site tls='' acme='' origin global=''
  [[ "$kind" == ip ]] && sni=$'\tdefault_sni '"$host"$'\n'
  [[ "$port" == 443 ]] || acme+=$'\t\t\tdisable_tlsalpn_challenge\n'
  [[ "$role" == none ]] && acme+=$'\t\t\tdisable_http_challenge\n'
  # No challenge left: only the local CA can issue a certificate.
  [[ "$port" != 443 && "$role" == none ]] && issuer=internal
  if [[ "$issuer" == internal ]]; then
    tls=$'\ttls internal\n'
  elif [[ "$kind" == ip ]]; then
    tls=$'\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n'"$acme"$'\t\t}\n\t\tissuer internal\n\t}\n'
  elif [[ -n "$acme" ]]; then
    tls=$'\ttls {\n\t\tissuer acme {\n'"$acme"$'\t\t}\n\t}\n'
  fi
  site="$host"
  [[ "$kind" == ip ]] && site="https://$host"
  origin="https://$host"
  [[ "$port" == 443 ]] || origin="https://$host:$port"
  if [[ -n "$role" ]]; then
    # Redirects are explicit so they carry the public port; port 80 may be relayed.
    global+=$'\tauto_https disable_redirects\n'
  fi
  if [[ -n "$ca" ]]; then
    global+=$'\tacme_ca '"$ca"$'\n\tacme_ca_root /etc/caddy/acme-ca-root.pem\n'
  fi
  printf '{\n\tadmin off\n\tpersist_config off\n\tskip_install_trust\n%s%s\tservers {\n' "$sni" "$global"
  # HTTP/3 would be advertised on UDP 443, which belongs to another program when the port differs.
  [[ "$port" == 443 ]] || printf '\t\tprotocols h1 h2\n'
  printf '\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body 120s\n\t\t\twrite 120s\n\t\t\tidle 2m\n\t\t}\n\t}\n}\n\n'
  printf '%s {\n%s' "$site" "$tls"
  printf '\tencode zstd gzip\n'
  printf '\trequest_body {\n\t\tmax_size 70MB\n\t}\n'
  printf '\theader -Server\n'
  printf '\treverse_proxy app:3000\n'
  printf '}\n'
  [[ -n "$role" ]] || return 0
  printf '\nhttp://%s {\n\tredir %s{uri} 308\n}\n' "$host" "$origin"
  if [[ "$role" == holder ]]; then
    # Other projects on this server join the shared network as <hostname>.acme-relay.invalid;
    # plain HTTP for their hostnames (ACME HTTP-01 and redirects) is passed to them. The header
    # stops a request from being relayed twice.
    printf '\n:80 {\n\t@relay not header X-OSS-HTTPS-Relay *\n\thandle @relay {\n'
    printf '\t\treverse_proxy {http.request.host}.acme-relay.invalid:80 {\n\t\t\theader_up X-OSS-HTTPS-Relay 1\n\t\t}\n\t}\n'
    printf '\trespond 421\n}\n'
  fi
}

# Site block for the shared HTTPS gateway (docs/HTTPS_GATEWAY.md).
render_gateway_site() {
  local host="$1" port="$2"
  printf '%s {\n' "$host"
  printf '\tencode zstd gzip\n'
  printf '\trequest_body {\n\t\tmax_size 70MB\n\t}\n'
  printf '\theader -Server\n'
  printf '\treverse_proxy 127.0.0.1:%s\n' "$port"
  printf '}\n'
}

write_caddyfile() {
  local temporary
  temporary="$(mktemp "$IG_CADDYFILE.XXXXXX")"
  render_caddyfile "$IG_ACCESS_KIND" "$IG_ACCESS_HOST" "${IG_TLS_ISSUER:-auto}" "${IG_HTTPS_PORT:-443}" \
    "${IG_RELAY_ROLE:-}" "${IG_ACME_CA:-}" >"$temporary"
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
