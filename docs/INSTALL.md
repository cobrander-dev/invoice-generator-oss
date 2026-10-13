# 安装、备份与升级指南

## 准备

- 一台 Ubuntu 22.04 / 24.04 / 26.04 或 Debian 12 / 13 服务器，x86_64 或 arm64，推荐 2 vCPU / 2 GiB 内存 / 20 GiB 磁盘。
- root 或 sudo 权限，能通过 SSH 登录。
- 使用域名时：域名的 A 记录已指向服务器公网 IP。
- 云服务器安全组与 `ufw` 等防火墙放行 TCP 80 和 443（使用内置 HTTPS 时）。

## 安装

```bash
curl -fsSL https://github.com/cobrander-dev/invoice-generator-oss/releases/latest/download/install.sh -o install.sh && bash install.sh
```

`&&` 保证只有完整下载成功才会运行安装脚本；安装脚本再用内嵌的 SHA-256 校验安装包。非 root 用户运行时会自动通过 sudo 重新执行。安装指定版本：把 `latest/download` 换成 `download/v1.2.3`。

安装向导会询问访问地址和管理员账号。安装完成后用浏览器打开 `https://你的域名或IP`，用刚创建的管理员登录。

### 使用公网 IP（没有域名）

向导中直接回车即可使用检测到的公网 IP。程序会优先申请 Let's Encrypt 6 天有效期的 IP 证书并自动续期；如果申请失败（例如 80/443 未放行），会改用本机 CA 签发的证书，浏览器会提示不受信任。此时运行：

```bash
sudo invoice-generator https
```

它会导出根证书 `/opt/invoice-generator/config/https/local-ca-root.crt` 并显示 SHA-256 指纹。核对指纹后，把根证书导入电脑的“受信任的根证书颁发机构”，即可正常访问。

### 服务器已有 Nginx 或 Caddy

如果 80 或 443 端口已被占用，程序不会改动现有服务，而是：

- 让 Invoice Generator 只监听 `127.0.0.1:3001`（若被占用则自动选择 3002–3099）；
- 在 `/opt/invoice-generator/proxy/` 生成 `nginx-invoice-generator.conf` 和 `Caddyfile-invoice-generator` 示例；
- 如果检测到正在运行的宿主机 Caddy 且使用域名，会询问是否自动添加站点：先校验并备份原 Caddyfile，追加站点后再次校验并 `reload`，任何一步失败都恢复原配置。

Nginx 示例需要填写你的证书路径，然后执行 `nginx -t && systemctl reload nginx`。反向代理必须设置 `X-Forwarded-Proto https`。

## 文件位置

| 路径 | 内容 |
| --- | --- |
| `/opt/invoice-generator/config/app.env` | 应用配置与 Session 密钥（0600，不要分享） |
| `/opt/invoice-generator/config/installer.env` | 访问地址、HTTPS 模式等安装设置 |
| `/opt/invoice-generator/backups/` | 数据库备份（0700） |
| `/opt/invoice-generator/releases/` | 当前及最近两个版本的安装文件 |
| Docker 数据卷 `invoice-generator_data` | SQLite 数据库 |

## 备份

- 每天 03:30 左右自动备份，保留最近 14 份自动备份（`installer.env` 中的 `BACKUP_KEEP` 可调整）。
- `sudo invoice-generator backup` 立即备份；手动备份、升级前和恢复前备份不会被自动删除。
- 每份备份包含 `.sqlite.gz`、`.sha256` 校验文件和 `.json` 摘要（完整性、数据库版本、记录数）。
- 备份含全部业务数据、账号和 Session，请定期复制到服务器以外的安全位置并加密保存。

## 恢复

```bash
sudo invoice-generator backups
sudo invoice-generator restore /opt/invoice-generator/backups/invoice-generator-20260101T033000Z-auto.sqlite.gz
```

恢复前会校验 SHA-256、数据库完整性和版本（不能恢复来自更新版本的备份），显示备份内容摘要，要求输入 `RESTORE` 确认，然后先停止服务、再备份当前数据，确保备份与被替换的数据完全一致。恢复后应用无法启动会自动还原。恢复后所有用户需要重新登录。

## 升级

```bash
sudo invoice-generator upgrade          # 最新版本
sudo invoice-generator upgrade v1.2.3   # 指定版本
```

升级流程：

1. 下载并校验新版本安装包；
2. 备份当前数据；
3. 在无网络的隔离容器中，用这份备份的副本启动新版本，验证数据库迁移和健康检查；
4. 停止服务并做最终备份；
5. 切换到新版本并检查健康。

第 1–3 步失败时不做任何更改；第 5 步失败时，先把新版本运行期间的数据库另存为 `*-failed-upgrade` 备份，再自动回滚到原版本和升级前数据。若新版本在失败前已有用户录入数据，这些数据保存在该备份中，需要人工核对补录；回滚不会直接丢弃它们。不支持降级。

## 常见错误代码

| 代码 | 含义与处理 |
| --- | --- |
| `ROOT_REQUIRED` | 请用 `sudo` 运行 |
| `DOCKER_DAEMON_UNAVAILABLE` | Docker 未运行：`sudo systemctl start docker` |
| `DOCKER_KEY_MISMATCH` | Docker 官方密钥指纹不符，安装已停止，请检查网络环境 |
| `RELEASE_CHECKSUM_MISMATCH` | 安装包校验失败，请重新下载 |
| `PROJECT_EXISTS` | 已有同名 Docker 项目或数据卷且不是本程序创建的，为避免覆盖已停止 |
| `ACCESS_HOST_INVALID` | 域名格式无效，或 IP 不是公网 IPv4 |
| `APP_UNHEALTHY` | 应用未通过健康检查，运行 `invoice-generator logs` 查看 |
| `BACKUP_CHECKSUM_MISMATCH` / `BACKUP_INVALID` | 备份文件损坏或被修改，未做任何更改 |
| `BACKUP_SCHEMA_TOO_NEW` | 备份来自更新的版本，请先升级 |
| `CANDIDATE_FAILED` | 新版本未通过隔离验证，当前版本未改动 |
| `UPGRADE_ROLLED_BACK` | 新版本启动失败，已回滚到原版本和升级前数据；新版本期间的数据另存为 `*-failed-upgrade` 备份 |
| `UPGRADE_ROLLBACK_HALTED` / `RESTORE_ROLLBACK_HALTED` | 无法先保存当前数据库，为避免丢失数据已停止回滚，服务处于停止状态，请勿删除任何文件并人工处理 |
| `DOWNGRADE_REFUSED` | 不支持降级 |
| `BUSY` | 另一个管理操作正在进行 |

遇到问题时先运行 `sudo invoice-generator doctor`，它只读取状态，不会修改任何内容。
