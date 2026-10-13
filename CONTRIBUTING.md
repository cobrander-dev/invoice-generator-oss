# Contributing

感谢你愿意改进 Invoice Generator OSS。

## 开发环境

```bash
npm ci
npm run test:all
```

本地运行服务器的步骤见 [server/README.md](server/README.md)。开发和测试必须使用独立的 TEST `.env` 与 SQLite 文件，不要使用真实业务数据或正式备份。

## 提交要求

- 每个 Pull Request 只解决一件事，保持改动可审查。
- 提交前运行 `npm run lint` 和 `npm run test:all`，全部通过。
- 修改金额、数量、重量、CBM、编号或 PDF 版式时，必须补充或更新对应测试。
- 新增 API 或数据入口时，必须包含认证、CSRF/Origin、Owner 隔离和越权访问测试。
- 不要提交 `.env`、数据库、备份、PDF 输出或任何真实客户、银行、签名和公章数据。测试数据使用 `example.invalid`、`TEST-` 前缀等明显虚构的值。
- 依赖版本由 `package-lock.json` 固定；升级依赖请单独提交并说明原因。

## 范围

本项目专注于外贸单据（PI、CI、Packing List）及其所需的公司、客户、产品、订单和付款记录。较大的新功能请先开 Issue 讨论。

## 安全问题

请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开提交。

## License

提交贡献即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
