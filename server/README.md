# Server — Authentication, SQLite and Production Packaging

服务器将前端接入受认证业务API，业务数据只读写SQLite。服务器页面加载`js/api-db.js`，不加载`js/db.js`，API失败时不会读取或写入浏览器IndexedDB。部署使用Docker与Caddy，见根目录README。

## 本地启动服务器开发版

使用支持当前依赖的Node.js（>=22.16；本轮测试使用26.2.0）。在项目根目录运行 `npm ci`。

1. 新建仅供本地TEST使用的`.env`：设置`NODE_ENV=development`、`HOST=127.0.0.1`、`PORT=3000`、`APP_ORIGIN=http://127.0.0.1:3000`和`DATABASE_PATH=./data/invoice-generator.sqlite`；不要直接沿用Production模板值。
2. 使用 `openssl rand -hex 32` 生成独立随机 `SESSION_SECRET`，填入 `.env`，并执行`chmod 600 .env`；不要分享或提交。
3. 以临时环境变量或标准输入提供测试管理员用户名和符合`PASSWORD_MIN_LENGTH`（默认8）的非弱密码，执行`npm run admin:init`。不要将管理员密码长期写进`.env`。
4. 运行 `npm run start:server`，在隔离浏览器打开 `http://127.0.0.1:3000/`。

服务器读取环境变量或根目录 `.env`，不自动生成凭据；缺失/占位Session Secret会拒绝启动。`PORT`与`APP_ORIGIN`需一起修改，浏览器固定使用配置的域名/IP和端口。localhost与127.0.0.1是不同Origin，不混用。

默认开发数据库为`data/invoice-generator.sqlite`。Production必须显式设置`DATABASE_PATH`；Docker固定使用`/app/data/invoice-generator.sqlite`。业务表包括`company`、`customers`、`products`、`orders`、`packing_lists`、`meta`、`restore_points`和服务器编号表`document_sequences`；认证/安全表包括`users`、`user_login_identifiers`、`sessions`、`audit_logs`、`schema_migrations`。`AUTH_DB_PATH`仅作为旧测试配置兼容别名。数据库目录0700、主文件0600；启动脚本使用umask 0077。不要把数据库放入任何公开静态目录。

`schema_migrations`只管理服务器DDL；启动不创建管理员、不修改管理员密码、不导入IndexedDB，也不写入Demo或重写业务JSON。多人Migration把唯一旧用户升级为唯一ADMIN，并把旧业务Owner归给该ADMIN；安全边界变化会使升级前Session失效，升级后需重新登录。业务数据和密码哈希保持不变。

## 企业多人账号与权限

本部署是Single Company + Multi User，不是多租户SaaS。数据库触发器与唯一索引共同保证系统最多一个不可降级的`ADMIN`；管理员只能创建`EMPLOYEE`，员工不物理删除。ADMIN可管理Employee、查看全公司数据、转移Customer及其Order/PI/CI/PL/Payment链路；EMPLOYEE只能访问自己拥有的Customer与关联业务。跨Owner访问统一返回404，明确角色禁止操作返回403。Product为全公司共享主数据；Company、Bank Accounts、Signature、Stamp对Employee只读但可用于其合法正式单据。

Employee使用临时密码首次登录时必须先修改密码。Disable、管理员Reset Password及本人Change Password都会仅使该用户旧Session失效，不影响其他账号。用户名与可选Email都按trim+lowercase建立全局唯一登录标识。管理员网页无“忘记密码”接口；仅可在VPS本地交互式运行`npm run admin:reset-password`，输入不回显。

`audit_logs`记录登录、账号管理、Owner转移、Customer/Product/Order生命周期、Final/Revised PI、CI、Packing List、Payment、Company配置与Backup/Restore。成功审计与对应业务写入位于同一SQLite事务；Employee只读自己的日志，ADMIN可读全部。日志不保存密码、临时密码、Hash、Cookie、Session Secret或CSRF Token。

## Phase 2–3业务数据层与前端接入

每个业务表只保存 `id`、完整原始 `payload_json`、服务器管理的 `row_version` 和 `updated_at`。账户、付款、附件、PI历史、CI和订单内PL继续位于原JSON内部，不建立第二份可编辑数据源。`row_version`不会写入业务对象或Full Backup；repository使用`expectedVersion`检测旧版本更新并抛出Conflict。

服务器业务备份继续使用原v2顶层格式，并兼容缺少`packingLists`的v1文件：`company`、`customers`、`products`、`orders`、`packingLists`、`meta`。v2记录可带可选`_server` Owner/Lifecycle元数据；旧备份缺少该元数据时，导入数据归当前唯一ADMIN。导出明确排除users、sessions、password hash、auth version、schema migration、row version、audit log和restore point。

前端通过以下受保护接口读写服务器业务数据：

| 路由 | 行为 |
| --- | --- |
| `GET /api/server-data/summary` | 返回业务数量摘要 |
| `GET /api/server-backup/export` | 一致性事务导出业务JSON |
| `POST /api/server-backup/inspect` | 校验并返回不含敏感payload的摘要 |
| `POST /api/server-backup/import` | 同一事务创建latest恢复点并完整替换 |
| `POST /api/server-backup/restore` | 同一事务恢复latest，不影响认证表 |
| `POST /api/server-backup/clear` | 精确确认“清空数据”后创建恢复点并清空业务数据 |
| `GET/PUT /api/company/main` | 公司主资料，使用rowVersion并发检查；仍被订单使用的收款账户不能删除（409 `DELETE_BLOCKED`） |
| `GET/POST/PUT/DELETE /api/customers` | Owner隔离的客户CRUD；DELETE只归档，不物理删除 |
| `GET/POST/PUT/DELETE /api/products` | 全公司共享产品CRUD；DELETE只归档，不物理删除 |
| `POST /api/products/bulk` | Product CSV单事务批量写入 |
| `GET/POST/PUT/DELETE /api/orders` | Owner隔离的订单CRUD；创建继承Customer Owner，DELETE只Void并保留全部单据/付款历史 |
| `GET /api/{customers,products,orders}?view=archived` | 已归档客户/产品、已作废订单列表（同样执行Owner隔离） |
| `POST /api/{customers,products,orders}/:id/archive` | 归档（订单为作废），与DELETE相同，可恢复 |
| `POST /api/{customers,products,orders}/:id/restore` | 恢复为使用中 |
| `GET /api/{customers,products,orders}/:id/deletion-check` | 返回能否永久删除及阻止原因 |
| `POST /api/{customers,products,orders}/:id/permanent-delete` | 永久删除：需If-Match与`{"confirmation":"永久删除"}`；存在关联时返回409 `DELETE_BLOCKED`及原因 |
| `GET /api/packing-lists` | Packing List列表和单条读取 |
| `GET/PUT /api/meta/:id` | 仅按明确meta key读写 |
| `GET /api/server-backup/restore-point` | 读取唯一latest恢复点 |

永久删除规则：客户被任何订单（含已作废订单）使用时不能删除；产品只能由ADMIN删除，且被任何订单行使用时不能删除；订单已有Final PI、CI、Packing List或收款记录时只能作废。客户和订单只能由Owner或ADMIN删除，其他员工得到404。删除与审计日志（`PERMANENT_DELETE_*`，记录名称或编号）在同一事务中提交，已分配的单据编号不会被重新使用。

所有业务写入接口均复用Phase 1的Session、精确Origin和CSRF边界。业务JSON请求上限默认64MB，兼容Base64签章和附件；响应与错误处理不记录完整请求。更新和删除必须携带已读取的rowVersion，409不会自动覆盖、重试或刷新表单。

Migration 002只建业务表；Migration 003只建内部编号表。两者都不解释、修复、seed或在启动时重写业务payload。Order、PI、CI、PL编号在SQLite事务内分配；Import/Restore同事务同步内部sequence，Clear重置sequence，历史编号永不改写。

Phase 4业务Action包括 `finalize-pi`、`revise-pi`、`generate-ci`、`confirm-ci-differences`、`finalize-ci`、`payment-tracking`、`generate-packing-list`、`save-packing-list` 和 `finalize-packing-list`。每次Action都要求当前Order rowVersion，过期请求返回409且不自动重试。Final PDF仍由浏览器现有`js/pdf.js`生成，但只能在服务器成功保存Final快照后生成。金额、Payment Tracking、PI Revision、CI差异、重量和CBM均直接复用`js/core.js`，没有服务器第二套公式。

## 路由与边界

| 路由 | 行为 |
| --- | --- |
| `GET /health` | 仅返回 `{ "status": "ok" }`，不设置Session |
| `GET /login` | 登录表单，创建带CSRF令牌的预登录Session |
| `GET /login-assets/login.js`、`login.css` | 仅公开这两个登录资源 |
| `POST /api/auth/login` | Origin+预登录CSRF校验、限流、密码验证、Session轮换 |
| `GET /api/auth/me` | 需登录，返回安全账号摘要和服务器密码最小长度 |
| `GET /api/auth/csrf` | 需登录，获取当前Session的CSRF令牌 |
| `POST /api/auth/change-password` | 需登录，验证当前密码并使该用户其他旧Session失效 |
| `POST /api/auth/logout` | 需登录、Origin与CSRF正确；销毁Session并清除Cookie |
| `GET/POST/PUT /api/users` | 仅ADMIN管理Employee；不提供创建ADMIN或删除用户 |
| `GET /api/audit-logs` | ADMIN查看全部，Employee只看自己的活动 |
| `GET /`、`/index.html` | 未登录302到/login，登录后返回原业务入口 |
| 业务JS/CSS/vendor | 精确文件白名单+同样的登录保护 |
| 其他 `/api` | 未登录401；已登录且满足写入边界后404，不提供通用表名或SQL接口 |

没有公开注册、网页找回管理员密码或用户邀请。管理员重置Employee密码属于认证后的ADMIN操作；管理员自身只允许本地CLI恢复。没有 `express.static(项目根目录)`，也不公开整个 `node_modules`。`.env`、SQLite、源码测试、备份和server目录均不能通过HTTP下载。

`index.html`只加载一个`window.FTDB`实现：`js/api-db.js`。适配层在运行内存维护`store+id → rowVersion`，统一处理401、409、5xx和网络失败；Session ID与Session Secret不会进入JavaScript。Logout提示先保存未保存内容。Session过期仍由服务器判断，不能将前端显示状态作为认证依据。

## 密码与Session

- Argon2id：64MiB内存、3次迭代、parallelism=1、自动随机salt。
- SQLite只保存 `password_hash`，不保存明文密码。未知用户也执行一次Argon2验证，错误统一为“用户名或密码错误”。
- `express-session`配合专用SQLite Store，不使用MemoryStore。Cookie只含签名后的不透明随机Session ID；数据库保存ID的SHA-256索引和服务器Session载荷。
- 登录成功regenerate，旧Session失效；Logout删除记录，旧Cookie不能再次访问。
- 空闲过期30分钟，绝对过期12小时；请求可以续空闲时间，不能推迟绝对截止时间。每分钟清理过期记录，读取时也校验过期时间。
- Cookie：HttpOnly、SameSite=Lax、Path=/，无Domain。开发HTTP允许Secure=false；production固定Secure=true并使用 `__Host-ft.sid`。
- production要求HTTPS origin，非HTTPS业务请求拒绝。默认不信任Forwarded头；Docker部署固定`TRUST_PROXY_HOPS=1`，只接受前方单个Caddy代理，且应用端口不发布到公网。旧`TRUST_PROXY_LOOPBACK`仅为本地测试兼容配置。

## CSRF、限流与Headers

所有 `/api` 非GET/HEAD/OPTIONS操作统一要求精确Origin匹配及Session绑定的随机CSRF token。Login从HTML meta取得预登录token；业务适配层和Logout通过认证接口取得登录后token。token只保存在服务器Session及页面运行内存，不进入URL、localStorage、IndexedDB或业务payload。认证JSON限制8KB；业务及备份JSON默认限制64MB。

登录每15分钟限制：每IP60次、IP+username组合10次、username整体30次。成功尝试也计入，防止可预测的清零绕过；返回429和Retry-After。username在限流key中经过hash，不记录密码或request body。

限流计数目前使用express-rate-limit的进程内计数器（**不是Session MemoryStore**），重启会重置，只支持单实例；公网部署前应评估持久化/反代防爆破与账户限流造成的拒绝服务风险。当前未实现公开互联网DoS防护。

Helmet提供CSP、nosniff、no-referrer、Frame保护等；响应no-store。CSP无 `*`、无unsafe-eval、无inline JavaScript。`style-src 'unsafe-inline'`暂时兼容既有业务模板style属性，是后续收紧项。`img-src data: blob:`用于现有Logo/签章/产品图片；`frame-src/object-src blob:`为本地生成PDF查看保留，脚本不允许data/blob来源。正式HTTPS才启用HSTS和upgrade-insecure-requests。

## 明确的安全限制

1. SQLite文件、导出的Full Backup和服务器宿主机本身未加密；必须依赖VPS文件权限、磁盘/备份保护和后续HTTPS部署。
2. 服务器不会读取浏览器IndexedDB。从早期浏览器本地版迁移时，先在本地版导出Full Backup JSON，再由服务器版Import Preview和Import导入；不得在测试中使用正式备份。
3. 业务界面长时间没有网络请求时不会自动保持Session；返回/聚焦会校验登录状态。已加载内容无法靠Cookie从客户端撤回。
4. Auth数据库和备份本身未加密；需要宿主机权限保护。服务器不得打印环境变量、原始错误或Session载荷。
5. jsPDF与jsPDF-AutoTable在浏览器端生成PI、CI和Packing List，服务器不调用PDF构建器；PDF内容与视觉回归只使用纯TEST数据。依赖漏洞以`npm audit --omit=dev`为发布门槛。
6. Phase 5已加入Docker和Caddy配置；GitHub Actions使用HTTP TEST模式验证实际容器与反向代理，不模拟Let's Encrypt。部署同时支持项目自带Caddy和已有宿主机Caddy两种模式；后者仅把app绑定到`127.0.0.1:3001`，由宿主机Caddy负责真实域名TLS。真实域名TLS仍须在VPS部署阶段验收。

Phase 5增加非root应用镜像、Caddy自动HTTPS、named volumes、Production fail-fast、在线SQLite备份和安全更新脚本。完整部署方式见根目录README。

## 测试

`npm test`运行业务计算、PDF、DB/archive及startup safety测试；`npm run test:all`运行全部本地测试。

`npm run test:server`使用临时TEST目录/SQLite、虚构管理员和测试端口，不访问正式浏览器或正式数据库；测试结束删除自建临时数据。

`npm run test:server:business`运行Phase 2的临时SQLite、Backup兼容、原子回滚、并发版本和API边界测试，不使用正式数据。

`npm run test:server:phase3`运行固定CRUD路由、CSRF、rowVersion/409、产品批量事务、Packing List双写、服务器Backup/Clear及`api-db.js`错误映射和无IndexedDB fallback测试。

`npm run test:server:phase4`运行服务器权威编号、导入/恢复sequence同步、Final/Revised PI、CI差异、Packing List、付款重算、普通PUT防篡改及双客户端并发测试。

`npm run test:server:delete`运行归档、恢复与永久删除的权限、跨用户隔离、关联保护和审计测试。`npm run test:browser`用无头Chrome验证管理界面的中英双语、客户表单桌面/手机布局、归档/恢复/永久删除流程和角色权限（需本机Chrome，或设置`CHROME_PATH`）。

`npm run test:server:multi-user`运行唯一ADMIN、账号状态/密码/Session失效、Owner隔离与转移、共享Product、公司资料只读、业务单据权限、Archive/Void、Audit原子性及Backup兼容测试。

早期浏览器本地版（IndexedDB）不属于本项目；`js/db.js`只为备份格式兼容测试保留。服务器版`index.html`使用API适配器，不能用静态文件服务器作为业务入口。
