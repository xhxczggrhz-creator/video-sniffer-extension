# 回归测试脚本

回归/单元测试脚本目录。分为两类：

## A. 可在纯 Node（无浏览器 API）运行的标准测试（纳入 CI）

```bash
npm test                 # = node tests/test-validate.js && node tests/test-merger.js
npm run test:security    # = node tests/test-ssrf-p03.js （P0-3 SSRF 字面量绕过防护）
```

直接依赖浏览器/扩展 API 的脚本**不应**用 node 直跑（会挂死或报 `chrome is not defined`），
需在浏览器扩展上下文的 DevTools console 中加载。

## B. 需在扩展上下文运行（importScripts / console 加载）的脚本

以下脚本依赖 `chrome.*`、`MediaSource` 等浏览器 API，请在扩展的对应上下文
（Service Worker / content script / DevTools）中按需加载：

- `test-engine-v3.js` / `test-abort-reason-v4210.js` / `test-direct-first-v4315.js`：下载引擎 / 直连优先 / 中止原因
- `test-seg-guard-v4316.js`：分段长度防护
- `test-dns-v429.js`：DNS 安全复查（缓存 / 超时 / single-flight）
- `test-opfs-aggregate-v429.js`：OPFS 1MB 聚合写
- `test-ts-remux-v430.js` / `test-ts-remux-discontinuity.js`：TS→fMP4 转复用 / 不连续
- `test-mp4box-api.js` / `test-merger.js`：fMP4 轨道解析与音视频合并
- `repro-*.js` / `make-broken-mp4.js`：特定缺陷复现代码

## 新增测试约定

- 纯 Node 可跑的测试命名为 `test-<feature>.js` 并能在 CI `npm test`/`test:security` 中直接执行。
- 涉及安全（SSRF / 绕过 / 数据泄露）的回归必须纳入 `npm run test:security`。
- 依赖浏览器 API 的脚本保持只读、无副作用，控制台加载即可。