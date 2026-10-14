# 共享 HTTPS 网关：同一服务器多个域名、网址不带端口

适合在一台服务器上安装多个项目，并让每个项目使用自己的域名，例如：

| 项目 | 访问地址 | 内部端口（只在本机监听） |
| --- | --- | --- |
| Invoice Generator | `https://invoice.example.com` | `127.0.0.1:3001` |
| Product Hub | `https://products.example.com` | `127.0.0.1:3000` |
| 其他服务（如 n8n） | `https://n8n.example.com` | 例如 `127.0.0.1:5678` |

公网只开放 TCP 80/443。网关按域名把请求转发到对应项目的本机端口，并为每个域名自动申请和续期 HTTPS 证书。项目自身的 HTTP 端口只绑定在 `127.0.0.1`，公网无法直接访问。

## 安装

安装向导的“HTTPS 方式”选择 **1) 共享 HTTPS 网关（推荐）**（需要域名，并已解析到本服务器）。无人值守安装：`IG_HTTPS_MODE=gateway`。

安装程序先检查谁占用了 80/443：

| 情况 | 处理 |
| --- | --- |
| 80/443 空闲 | 经你确认后安装共享网关（Docker 项目 `oss-gateway`，目录 `/opt/oss-gateway`） |
| 已有共享网关 | 为本项目添加独立站点 |
| 宿主机 systemd Caddy（`/etc/caddy/Caddyfile`） | 经你确认后在该文件末尾添加带标记的站点块 |
| Nginx、Apache、其他容器等 | 无法安全接管：停止并说明原因，不做任何修改；可改选“独立 HTTPS 端口”或“已有反向代理” |
| 域名已被其他站点使用 | 停止（`GATEWAY_SITE_CONFLICT`），不做任何修改 |

每次修改都先在副本上校验完整配置，修改前备份（`/opt/oss-gateway/backups/` 或 `/etc/caddy/Caddyfile.oss-backup-*`），再无中断地重新加载；重新加载失败时自动恢复原配置。其他网站不会被停止或覆盖。

## 管理命令

安装共享网关后可使用 `oss-gateway`：

```bash
sudo oss-gateway status                                  # 网关状态与站点列表
sudo oss-gateway add n8n n8n.example.com 127.0.0.1:5678  # 为其他服务添加域名
sudo oss-gateway remove n8n                              # 只移除这个站点
```

本项目的站点异常时，运行 `sudo invoice-generator https --apply` 重新添加（只影响本项目站点）。

## 独立性

- 网关是独立的 Docker 项目 `oss-gateway`，不属于任何一个应用。升级、备份、重装或停止某个项目都不会修改网关或其他项目的站点。
- 各项目的 Docker 项目、数据库、数据卷和配置目录完全独立。
- 网关的管理接口只在容器内的 Unix socket 上，不监听任何 TCP 端口。
- 登录：`APP_ORIGIN` 为 `https://域名`（不带端口），浏览器的 `Origin` 必须完全一致；会话 Cookie 为 `__Host-` 前缀、Secure、HttpOnly、无 Domain 属性，不同域名的项目之间 Cookie 互不可见。

## 证书

网关独占 80/443，因此每个域名都能通过 HTTP-01 或 TLS-ALPN-01 正常申请和自动续期。安装结束时会实际读取网关提供的证书并如实显示签发者。需要域名已解析到本服务器，并在防火墙/安全组放行 TCP 80 和 443。

## 与其他模式的关系

- “独立 HTTPS 端口”（含 443 单项目安装与 8443 等自定义端口，见 [HTTPS_PORTS.md](HTTPS_PORTS.md)）保持不变。
- 网关占用 80/443 后，同一服务器上再用“独立 HTTPS 端口”安装的项目无法借用 80 端口验证证书，请统一使用共享网关。
- 已有的单项目安装（本项目自己的 Caddy 占用 80/443）不会被自动迁移；此时新项目选择网关模式会被拒绝并说明原因。
