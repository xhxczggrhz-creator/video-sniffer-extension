## 摘要（Summary）

<!-- 一句话说明改动目的 -->

## 关联

- Closes #issue（如有）
- 涉及的安全 / 工程化优化：<!-- P0-x / P1-x / 里程碑 -->

## 变更内容（Changes）

- [ ] 列出主要改动点

## 自测（Checklist）

- [ ] 改动过的 JS 通过 `node scripts/check-js.js`
- [ ] `npm test`（test-validate + test-merger）通过
- [ ] 如有安全相关改动，`npm run test:security`（SSRF 回归）通过
- [ ] `manifest.json` 版本号已递增，且 `CHANGELOG.md` 有对应 `## [版本]` 条目
- [ ] **不收集、不出网传输**任何用户浏览数据；未引入遥测 / 第三方请求
- [ ] 未修改 `lib/mp4box.min.js`、`lib/ts-mux.min.js`（第三方文件，更新需走 VENDOR 流程）

## 已知影响
<!-- 说明对现有下载功能 / 权限的影响 -->

## 截图 / 日志（如有）