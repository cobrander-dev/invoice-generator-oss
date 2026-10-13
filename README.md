# Invoice Generator OSS

自托管的外贸单据系统：管理公司资料、客户、产品和订单，生成英文 Proforma Invoice（PI）、Commercial Invoice（CI）和 Packing List PDF。中文操作界面，单公司多账号，数据保存在你自己的服务器上。

```text
Browser -> HTTPS / Caddy -> Node.js / Express -> SQLite（Docker 持久卷）
```

## 功能

- 公司资料、多币种收款账户（USD / EUR / GBP 等）、Logo、签名与公章
- 客户（Buyer / Consignee）和产品库，产品 CSV 批量导入
- 订单：Draft、Final 和 Revised PI；从 PI 生成 CI 并确认差异
- Packing List：箱数、净重/毛重、尺寸和 CBM
- Payment Tracking：定金/尾款、付款水单附件
- 英文 PDF：电子签章或打印签章版本；订单 ZIP 批量导出
- 服务器权威的 Order / PI / CI / PL 编号和 Final 快照
- 单公司多人账号：唯一 ADMIN；Employee 按业务 Owner 隔离；业务转移与不可修改的 Audit Log
- Full Backup JSON 导出/导入、最新恢复点，以及 SQLite 在线一致性备份

## 安全设计

- 没有公开注册、默认账号或默认密码；首个管理员在安装时以隐藏输入创建。
- 密码使用 Argon2id；Session 保存在 SQLite，Cookie 为 `HttpOnly`、`Secure`、`SameSite=Lax`、`__Host-` 前缀。
- 所有写请求要求 Session、CSRF Token 和精确 Origin；乐观锁 `rowVersion` 防止覆盖他人修改。
- 生产环境缺少 HTTPS `APP_ORIGIN`、`DATABASE_PATH` 或安全 `SESSION_SECRET` 时拒绝启动。
- 容器以非 root、只读文件系统、`cap_drop: ALL` 运行；Node 端口不直接暴露到公网。

漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 一键安装

在一台 Ubuntu 22.04 / 24.04 或 Debian 12 / 13 服务器（x86_64 或 arm64）上以 root 运行：

```bash
curl -fsSLO https://github.com/cobrander-dev/invoice-generator-oss/releases/latest/download/install.sh
sudo bash install.sh
```

安装程序全程中文交互：

1. 检测系统；未安装 Docker 时询问后从 Docker 官方源安装（先核对官方 GPG 密钥指纹）。
2. 下载安装包，并用 `install.sh` 内嵌的 SHA-256 校验；安装包内每个文件再按清单校验，镜像按 digest 固定。
3. 输入访问地址：**有域名填域名，没有域名直接回车使用服务器公网 IP**。
4. 自动生成安全密钥，启动服务，创建管理员（密码隐藏输入）。
5. 启用每日自动备份，安装 `invoice-generator` 管理命令。

推荐 2 vCPU / 2 GiB 内存 / 20 GiB 磁盘。云服务器请在安全组放行 TCP 80 和 443。再次运行 `install.sh` 会打开管理菜单，不会覆盖已有安装。

| 场景 | HTTPS |
| --- | --- |
| 有域名，80/443 空闲 | 内置 Caddy 自动申请并续期证书 |
| 无域名，使用公网 IP | 优先申请 Let's Encrypt 短期 IP 证书并自动续期；失败时使用本机 CA 证书，`invoice-generator https` 可导出根证书及指纹 |
| 80/443 已被 Nginx / Caddy 占用 | 应用只监听 `127.0.0.1:3001`，在 `/opt/invoice-generator/proxy` 生成 Nginx 和 Caddy 配置示例；检测到运行中的宿主机 Caddy 时可自动添加站点（先校验并备份原配置，失败自动恢复） |

安装只使用名为 `invoice-generator` 的 Docker Compose 项目、`/opt/invoice-generator` 目录和 `invoice-generator_*` 数据卷。若检测到同名但不是本程序创建的项目或数据卷，安装会停止，不会覆盖。

## 日常管理

```bash
sudo invoice-generator            # 中文管理菜单
sudo invoice-generator status     # 运行状态
sudo invoice-generator doctor     # 只读健康检查
sudo invoice-generator backup     # 立即备份
sudo invoice-generator backups    # 列出备份
sudo invoice-generator restore <备份文件>
sudo invoice-generator upgrade    # 升级到最新版本
sudo invoice-generator logs       # 查看日志
sudo invoice-generator https      # HTTPS 证书信息
sudo invoice-generator reset-admin-password
```

详细说明见 [docs/INSTALL.md](docs/INSTALL.md)。

## 备份与恢复

- **自动备份**：每天 03:30 左右自动备份，保留最近 14 份自动备份。手动、升级前和恢复前的备份不会被自动删除。
- **备份内容**：使用 SQLite 在线备份 API 生成一致性副本，经完整性检查后压缩，附 SHA-256 校验文件，保存在 `/opt/invoice-generator/backups`（0700）。备份包含业务数据、账号和 Session，请复制到服务器以外的安全位置并妥善加密保存。
- **恢复**：`restore` 先校验备份的 SHA-256、完整性和数据库版本，要求输入 `RESTORE` 确认，并在恢复前自动再备份一次当前数据；恢复后应用无法启动时自动还原。
- **应用内 Full Backup JSON**：在“数据备份”页面导出业务数据，不含账号、密码哈希、Session 和 Audit Log。

严禁执行 `docker compose down -v`、`docker volume prune` 或 `docker system prune`，它们会删除数据卷。

## 升级

`sudo invoice-generator upgrade`（或 `upgrade v1.2.3`）依次：校验新版本安装包 → 备份当前数据 → 在无网络的隔离容器中用备份副本启动新版本并验证数据库迁移 → 停止服务并做最终备份 → 切换到新版本并检查健康。任何一步失败都不会切换；切换后启动失败时，先另存新版本期间的数据库，再自动回滚到原版本和升级前数据。不支持降级。

## 从源码部署（高级）

不使用安装程序时，可用仓库中的 `docker-compose.yml` 自行构建：

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 48   # 写入 .env 的 SESSION_SECRET，并修改 DOMAIN 和 APP_ORIGIN
docker compose build --pull app
docker compose up -d
printf '%s' "$ADMIN_PASSWORD" | docker compose exec -T -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
```

| 变量 | 说明 |
| --- | --- |
| `APP_ORIGIN=https://...` | CSRF / Origin 精确允许值 |
| `DATABASE_PATH` | 持久卷中的 SQLite 路径 |
| `SESSION_SECRET` | 至少 32 字节随机值 |
| `PASSWORD_MIN_LENGTH` | 密码最小长度，默认 8，最大 128 |
| `BUSINESS_BACKUP_LIMIT` | Full Backup JSON 请求大小上限，默认 `64mb` |
| `TRUST_PROXY_HOPS=1` | 只信任前方一个反向代理 |

## 开发与测试

需要 Node.js 24（容器使用 24.20.0）。开发请使用独立的 TEST `.env` 和数据库，详见 [server/README.md](server/README.md)。

```bash
npm ci
npm run admin:init
npm run start:server
npm run test:all
```

`npm run test:all` 依次运行业务、PDF 回归和全部服务器测试。Docker 容器级测试位于 `tests/deploy/`，由 GitHub Actions 在 Ubuntu Runner 上执行。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录结构

```text
css/ js/             前端界面、共享计算核心、PDF 生成与服务器 API 适配层
server/              认证、API、SQLite 与运维脚本
installer/           一键安装程序、管理命令与 Compose 配置
deploy/              源码部署使用的 Caddyfile
tests/               业务、PDF、安全、多用户和部署测试
Dockerfile           非 root 生产镜像
docker-compose.yml   App、Caddy、网络和持久卷
```

`js/db.js` 是早期浏览器 IndexedDB 存储适配层，只用于备份格式兼容测试，不会被服务器页面加载，也不会打包进镜像。

## 已知限制

见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。

## License

[MIT](LICENSE)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
