# 当前限制说明

## 业务与单据

1. 正式 PDF 使用内置 Helvetica 字体，单据设计为英文；中文备注不建议放入正式 PDF。
2. HS Code 不会自动生成或校验海关归类，必须由使用者根据实际商品确认。
3. 产品 CSV 导入面向标准逗号分隔文件；复杂 Excel 工作簿请先另存为 UTF-8 CSV。
4. Logo、签名、公章和付款水单以 Base64 保存在业务 JSON 中。大量高清图片或超大附件会增加数据库和 Full Backup 体积；建议单个附件控制在 10 MB 以内，Full Backup JSON 受 `BUSINESS_BACKUP_LIMIT`（默认 64 MB）限制。
5. 浏览器可能根据安全设置询问是否允许下载；如多文件下载受阻，请使用“批量导出 / 订单 ZIP”。
6. 启动为只读加载模式：不会自动注入 Demo 数据、补写历史快照或修改公司资料。需要 Schema 迁移时只能通过明确、独立、可回滚的 Migration 执行。

## 服务器 Production 限制

- 登录 Rate Limit 当前保存在单个 Node 进程内存；单实例有效，多实例需共享限流存储。
- 重复Customer提醒采用大小写、空白和标点归一化后的名称精确匹配，只返回通用提醒且不阻止创建；当前不做可能误报并泄露跨Owner特征的模糊匹配。
- Customer、Product归档和Order作废保留底层记录与Audit历史；当前第一版界面不提供恢复为Active的操作。
- CSP 禁止 inline script 和 eval，但因现有模板包含 style 属性，`style-src`暂时保留`unsafe-inline`。
- SQLite、银行账户、客户、签名、公章和附件未做应用层静态加密；依赖服务器磁盘、文件权限、主机访问控制和加密离机备份。
- 纯TEST数据的PI、CI、Packing List回归、依赖审计以及Production Docker镜像验证均在GitHub Actions Ubuntu Runner执行。
- SQLite适合单用户/少量用户单实例；不要让多个应用容器同时写同一个SQLite文件。
- 更新器以完整commit SHA构建隔离candidate，并先在SQLite一致性副本上运行migration和健康检查；正式promotion失败时恢复匹配的旧image、Git checkout与更新前SQLite备份。未来如引入无法由整库恢复覆盖的外部状态或不可逆变更，仍需独立降级方案。
- 自动HTTPS依赖部署时输入的域名正确指向服务器且公网80/443可访问；当前部署脚本只支持域名，不支持仅用公网IP访问。已有宿主机Caddy模式的检测、配置幂等、validate回滚及reload已使用隔离mock测试；真实域名的证书申请和续期仍需真实VPS验收。
- 当前部署脚本仅支持Ubuntu，并在服务器上本地构建镜像；尚无预构建镜像、按版本号升级和restore命令。
- Docker build、Compose、Caddy代理、登录、业务E2E及restart/down-up/force-recreate持久化已在GitHub Actions Ubuntu Runner通过。仍待真实VPS验收：首次安装、真实DNS、Caddy自动HTTPS与续期，以及加密离机灾备的恢复演练。本项目仍是Production Release Candidate，不代表已完成真实环境认证。
