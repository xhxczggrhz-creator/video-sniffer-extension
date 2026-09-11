# Changelog

本项目的所有显著变更都会记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 历史说明：v4.3.17 之前的真实开发历史（几十上百次迭代）存于本地并在代码注释中保留
> 编号；GitHub 仓库仅是从本地快照的导入。v4.3.18 起正式在此维护公开 Changelog。

## [4.3.18] - 2026-09-11

### 安全修复（安全与工程化评审 P0/P1）
- **P0-3 SSRF：封堵"类 IP 字面量"绕过。** 新增 `normalizeIpLiteralHost()`，把整数
  （如 `2130706433`=127.0.0.1）、十六进制（`0x7f000001`）、前导零八进制
  （`017700000001`）的主机名归一为点分十进制后再走 `isBlockedIpLiteral` 拦截；
  正常域名不受影响。配套 `tests/test-ssrf-p03.js` 安全回归门禁。
- **P0-4 规则 ID 竞态（TOCTOU）。** `remove-force-rule` 改为先 `await removeForceRuleById`
  成功、再 `freeRuleId`，消除并发下载时旧删除误伤新规则的 403 降级。
- **P1-1 MSE 捕获防御性拷贝。** `appendBuffer` 的 ArrayBuffer 分支改用 `slice(0)`，
  避免页面将其 transfer 到 Worker 后抛错 / buffer pool 回溯污染导致导出静默损坏。
- **P1-6 看门狗计时器早退泄漏。** `proxy-fetch-full` HTTP 错误分支补 `clearTimeout`，
  避免残留 30s 计时器拖延 SW 存活。
- **P1-7 消息 handler 同步抛错挂起。** `onMessage` 分发处加 try/catch，同步异常并入
  统一错误路径，保证 `sendResponse` 必定回调，不再挂起发起端。

### 文档
- **P0-2 如实标注 DNS 安全链边界。** 明确 `chrome.dns` 为 Dev/Beta 渠道专属，稳定版整条
  DNS 复查链失效，真正兜底是 `isSafeUrl` 字面拦截 + 浏览器自带 DNS/Secure DNS。

### 工程化基建
- 新增 `package.json`（npm scripts：lint / test / test:security / package）。
- 新增 `scripts/check-js.js`（ESM/CJS 语法门禁）、`scripts/package.js`（产 zip + SHA256）。
- 新增 `SECURITY.md`、`VENDOR.md`、`CHANGELOG.md`（本文件）、`PRIVACY.md`。
- 新增 GitHub Issue 模板（bug / feature / site-broken）、PR 模板、CI workflow。

## [4.3.17]
- 此前版本。变更记录见代码注释与仓库导入快照。