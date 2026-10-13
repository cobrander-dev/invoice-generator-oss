# Source deployment files

普通用户请使用一键安装程序（见根目录 README 与 [docs/INSTALL.md](../docs/INSTALL.md)）。

- `caddy/Caddyfile`：根目录 `docker-compose.yml` 从源码自行构建部署时使用的 Caddy 配置。
- `../docker-compose.host-caddy.yml`：源码部署时将 app 只发布到 `127.0.0.1:3001`，由宿主机反向代理接入。

一键安装程序的 Compose 文件、安装向导和管理命令位于 `installer/`。
