# Security Policy

## 报告漏洞

请不要在公开 Issue、Discussion 或 Pull Request 中披露安全漏洞。

请通过 GitHub 仓库的 **Security → Report a vulnerability**（Private Vulnerability Reporting）私下提交，内容尽量包括：

- 受影响的版本或 commit
- 复现步骤和影响范围（例如越权读取、认证绕过、数据泄露）
- 如有，建议的修复方式

我们会尽快确认收到报告，并在修复发布后致谢报告者（如你愿意）。

## 支持范围

只有最新发布版本会获得安全修复。

## 部署者须知

- 不要把应用容器端口直接暴露到公网；只通过 HTTPS 反向代理访问。
- `.env`（含 `SESSION_SECRET`）和 SQLite 备份都是高敏感数据，保持 0600 权限，不要提交到 Git 或分享。
- SQLite 和备份文件没有应用层加密；请加密后保存到服务器以外的位置。
- 不要在 Issue 或日志中粘贴真实客户、银行账户、签名或公章数据。
