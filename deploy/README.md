# Deployment files

- `install.sh`：Ubuntu首次安装及幂等重跑；询问部署域名并写入`DOMAIN`与匹配的`APP_ORIGIN`，自动识别项目自带Caddy或已有宿主机Caddy模式。
- `update.sh`：读取并校验已有`.env`中的`DOMAIN`，不重新询问或覆盖配置；先备份，再执行fast-forward更新和candidate image健康检查；宿主机Caddy模式只更新invoice app。
- `backup.sh`：通过SQLite在线备份API创建灾难恢复副本。
- `caddy/Caddyfile`：唯一公网入口和自动HTTPS反向代理。
- `lib/host-caddy.sh`：检测已有宿主机Caddy，并以validate、备份、再次validate、reload的顺序安全增加站点。
- `../docker-compose.host-caddy.yml`：仅将app发布到`127.0.0.1:3001`，同时默认禁用项目Caddy service。

脚本不保存GitHub Token，也不删除Docker volume。部署前阅读根目录README与KNOWN_LIMITATIONS。
