# Third-party notices

Invoice Generator OSS 以 MIT License 发布（见 `LICENSE`）。它依赖并在容器镜像中分发以下第三方软件，各组件遵循其自身许可证。精确版本由 `package-lock.json`、`Dockerfile` 和 `docker-compose.yml` 固定。

## npm 生产依赖

全部生产依赖（含传递依赖）均为可与 MIT 一同分发的宽松许可证：MIT、ISC、BSD-3-Clause、MIT AND Zlib（pako）以及 MPL-2.0 OR Apache-2.0（DOMPurify，按 Apache-2.0 使用）。

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| Express、express-session、express-rate-limit | MIT | HTTP 服务、Session、登录限流 |
| Helmet | MIT | 安全响应头 |
| argon2 | MIT | Argon2id 密码哈希 |
| better-sqlite3 | MIT | SQLite 驱动（内含 SQLite，Public Domain） |
| jsPDF、jsPDF-AutoTable | MIT | 浏览器端 PDF 生成 |
| JSZip | MIT OR GPL-3.0-or-later | 订单 ZIP 导出，按 MIT 使用 |

发布前用以下命令复核生产依赖许可证：

```bash
node -e 'const l=require("./package-lock.json");for(const [p,v] of Object.entries(l.packages))if(p&&!v.dev)console.log(v.license,p)' | sort | uniq -c
```

## 仅开发/测试依赖

| 组件 | 许可证 |
| --- | --- |
| fake-indexeddb | Apache-2.0 |

## 容器镜像中的软件

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| Node.js 运行时（`node:24.20.0-bookworm-slim`） | MIT 及其捆绑许可证 | 上游官方镜像 |
| Debian 12 基础软件包 | 多种（GPL、LGPL、BSD、MIT 等） | 未修改的 Debian 软件包，源码见 <https://sources.debian.org> |
| Caddy（`caddy:2.11.4-alpine`） | Apache-2.0 | 可选 HTTPS 反向代理，官方镜像 |

完整许可证文本随各组件保存在 `node_modules` 对应包目录和镜像内。
