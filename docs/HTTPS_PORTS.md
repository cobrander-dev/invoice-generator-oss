# 自定义 HTTPS 端口与同一服务器多项目共存

安装向导会询问 HTTPS 端口：直接回车使用 443（访问地址不带端口），也可以输入 1024–65535 之间的其他端口，例如 Invoice Generator 用 8443、Product Hub 用 9443。端口被占用时安装程序只报告占用者并要求换一个端口，不会停止或修改任何其他程序。

无人值守安装：`IG_HTTPS_PORT=8443`。端口被占用时以 `HTTPS_PORT_IN_USE` 失败；未设置端口且 443 被占用时保持原来的行为，改用“已有反向代理”模式。

## 证书如何申请

公网证书机构（Let's Encrypt）只用两种方式验证服务器，端口都是固定的：

| 方式 | 验证端口 | 说明 |
| --- | --- | --- |
| HTTP-01 | 80 | 证书机构访问 `http://域名/.well-known/acme-challenge/…` |
| TLS-ALPN-01 | 443 | 只有使用 443 端口的项目可以用 |
| DNS-01 | 无 | 需要 DNS 服务商 API 凭据，本安装程序不支持 |

因此自定义端口的项目必须借助 80 端口。同一台服务器上只能有一个程序占用 80，所以各项目约定共享 80 端口：

- 安装时 80 端口空闲：本项目的 Caddy 占用 80（**holder**），自己用 HTTP-01 申请证书，并把其他域名的 80 端口请求转发给对应项目。
- 80 端口已被另一个遵守该约定的项目占用：本项目不再占用 80（**member**），由占用者转发证书验证请求，证书照常自动申请和续期。
- 80 端口被无关程序（例如宿主机 Nginx）占用：
  - 使用 443 端口时只用 TLS-ALPN-01，证书照常申请；
  - 使用其他端口时**无法自动获得受信任证书**。向导会说明原因，并让你选择：本机 CA 证书（浏览器提示不受信任，可导入根证书）、改用已有反向代理模式，或取消。无人值守安装以 `ACME_HTTP_PORT_UNAVAILABLE` 失败，除非明确设置 `IG_TLS_ISSUER=internal`。

安装结束时程序会实际连接 HTTPS 端口，读取服务器正在使用的证书并如实显示签发者：ACME 证书、本机 CA 证书，或“尚未获得证书”。不会把未成功的申请显示为成功。之后随时运行 `sudo invoice-generator https` 查看。

续期由 Caddy 自动完成（到期前约 1/3 有效期开始），走与首次申请相同的路径。member 的续期依赖 holder 项目保持运行；`sudo invoice-generator doctor` 会检查这一点。

## 共享约定（供其他项目实现）

- Docker 网络 `oss-https-relay`（不存在时创建，任何项目都不删除）。
- 每个项目的 HTTPS 代理加入该网络，网络别名为 `<访问域名>.acme-relay.invalid`，容器标签 `oss.https-relay=holder|member`。
- holder 的 Caddyfile 在 80 端口把非本项目域名的请求转发到 `{请求域名}.acme-relay.invalid:80`，并加上 `X-OSS-HTTPS-Relay: 1` 防止二次转发。只转发明文 HTTP（证书验证与跳转到 HTTPS）。
- 每个项目自己的 `http://域名` 跳转到 `https://域名:端口`。

## 防火墙与安全组

| 角色 | 需要放行 |
| --- | --- |
| holder | TCP 80 和所选 HTTPS 端口 |
| member / 其他 | 所选 HTTPS 端口 |

## 登录、Cookie 与 CSRF

`APP_ORIGIN` 包含端口（例如 `https://invoice.example.com:8443`），浏览器提交的 `Origin` 必须与之完全一致，其他端口的页面无法通过 CSRF 检查。会话 Cookie 为 `__Host-` 前缀、Secure、HttpOnly、无 Domain 属性。

注意：浏览器的 Cookie 只按主机名隔离、不按端口隔离。两个项目使用**同一个域名或 IP、不同端口**时，彼此能看到对方的 Cookie。两个项目的 Cookie 名称不同，不会互相覆盖，但建议为每个项目使用独立的子域名（例如 `invoice.example.com:8443` 与 `hub.example.com:9443`）。

## 已有安装

升级不会改变端口和证书方式。为让同一服务器上新安装的项目使用 80 端口转发，在本项目上运行一次：

```bash
sudo invoice-generator https --apply
```

它只重新生成本项目的 Caddy 配置并重建 Caddy 容器，数据、端口和已有证书保持不变。

## 已知限制

- 仅支持 HTTP-01 / TLS-ALPN-01；不支持 DNS-01。
- IP 访问的项目不能通过转发获得证书（转发按域名区分）；IP 访问使用其他端口且 80 被占用时只能使用本机 CA 证书。
- Docker 守护进程启用了 SELinux 标签（`selinux-enabled`）的系统未经测试。
