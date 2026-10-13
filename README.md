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

## 安装

> 面向普通用户的一键安装程序（域名 / 公网 IP 两种模式）正在开发中。下面是当前可用的 Docker 部署方式，需要一台 Ubuntu 服务器、指向服务器的域名，并开放 TCP 80/443。

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/cobrander-dev/invoice-generator-oss.git /opt/invoice-generator
sudo /opt/invoice-generator/deploy/install.sh
```

安装器会：检查 Ubuntu，从 Docker 官方源安装 Docker Engine 与 Compose 插件；询问域名；生成随机 `SESSION_SECRET` 并写入 0600 权限的 `.env`；构建并启动容器；等待健康检查；以隐藏输入创建首个管理员。重复运行不会覆盖已有 `.env`、数据或管理员。

如果服务器上已有正在运行并占用 80/443 的宿主机 Caddy，安装器会自动切换为 `EXISTING_HOST_CADDY` 模式：只启动应用并绑定 `127.0.0.1:3001`，在验证并备份原 Caddyfile 后追加一个站点，原有站点保持不变；任何一步失败都会恢复备份。

### 手动 Docker 部署

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 48   # 将结果写入 .env 的 SESSION_SECRET
# 将 DOMAIN 和 APP_ORIGIN 改为你的真实域名
docker compose config --quiet
docker compose build --pull app
docker compose up -d
```

然后按下文“管理员”一节初始化管理员。管理员凭据不能长期写入 `.env`。

## 配置

| 变量 | 说明 |
| --- | --- |
| `NODE_ENV=production` | 启用 Production Cookie 和 HTTPS 要求 |
| `DOMAIN` | 部署域名，不含协议 |
| `APP_ORIGIN=https://...` | CSRF / Origin 精确允许值，必须与 `DOMAIN` 一致 |
| `DEPLOYMENT_MODE` | `BUNDLED_CADDY` 或 `EXISTING_HOST_CADDY`，安装器自动写入 |
| `DATABASE_PATH=/app/data/foreign-trade.sqlite` | 持久卷中的 SQLite 路径 |
| `SESSION_SECRET` | 至少 32 字节随机值 |
| `PASSWORD_MIN_LENGTH` | 密码最小长度，默认 8，最大 128 |
| `BUSINESS_BACKUP_LIMIT` | Full Backup JSON 请求大小上限，默认 `64mb` |
| `TRUST_PROXY_HOPS=1` | 只信任前方一个 Caddy 代理 |

## 管理员

```bash
read -r -p 'Administrator username or email: ' ADMIN_USERNAME
read -r -s -p 'Administrator password: ' ADMIN_PASSWORD; printf '\n'
printf '%s' "$ADMIN_PASSWORD" | docker compose exec -T -e ADMIN_USERNAME="$ADMIN_USERNAME" -e ADMIN_PASSWORD_STDIN=1 app npm run admin:init
unset ADMIN_PASSWORD
```

`admin:init` 只允许首次初始化。忘记管理员密码时，只能在服务器本机运行 `docker compose exec -it app npm run admin:reset-password`（输入不回显，旧 Session 失效）；网页不提供管理员密码找回。

## 备份

- **应用内 Full Backup JSON**：在“数据备份”页面导出，包含业务数据，不含账号、密码哈希、Session 和 Audit Log。
- **服务器 SQLite 备份**：`sudo ./deploy/backup.sh` 使用 SQLite 在线备份 API 在 `app_data/backups/` 生成 0600 权限的一致性副本。它包含业务和认证数据，请加密后保存到服务器以外的位置。

不要直接复制运行中的 SQLite 主文件。严禁执行 `docker compose down -v`、`docker volume prune` 或 `docker system prune`，它们会删除数据卷。

## 更新

```bash
sudo ./deploy/update.sh <完整 40 位 Git commit SHA>
```

更新器先在线备份 SQLite，只接受 fast-forward，构建独立候选镜像，在数据库副本上验证迁移和健康检查后才切换；失败时恢复旧镜像、旧代码和更新前备份。按版本号升级的管理命令将随一键安装程序提供。

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
deploy/              Caddy、安装、更新和备份脚本
tests/               业务、PDF、安全、多用户和部署测试
Dockerfile           非 root 生产镜像
docker-compose.yml   App、Caddy、网络和持久卷
```

`js/db.js` 是早期浏览器 IndexedDB 存储适配层，只用于备份格式兼容测试，不会被服务器页面加载，也不会打包进镜像。

## 已知限制

见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。

## License

[MIT](LICENSE)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
