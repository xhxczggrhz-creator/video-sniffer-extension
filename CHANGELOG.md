# Changelog

本项目的所有显著变更都会记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 历史说明：v4.3.17 之前的真实开发历史（几十上百次迭代）存于本地并在代码注释中保留
> 编号；GitHub 仓库仅是从本地快照的导入。v4.3.18 起正式在此维护公开 Changelog。

## [4.5.0] - 2026-09-13

### 画质/音质自选 +「重新嗅探」真正重扫（缺省路径行为不变）

- **画质 / 音质自选。** 此前画质只能由后台自动取最高：B站 DASH 双轨固定用
  `videoStreams[0]` + 最大码率音轨，HLS 主清单固定取带宽最高变体，DASH 固定取
  `height*1000000+bandwidth` 最高的 `Representation` —— 用户没有任何入口。现在
  条目上多出「画质」按钮：
  - **B站等双轨条目**：嗅探期后台**早已**把全部轨道写进 `biliData.allVideoStreams`
    / `allAudioStreams`（此前无人消费），现在直接列成「画质（视频轨）/ 音质
    （音频轨）」两组勾选，点「开始下载」按选中的轨下载，**零额外请求**。显式选档
    会丢弃「标准 MP4 直链」（它固定 1080P，且下载页策略 1 优先用它，会让选择失效）。
  - **通用 HLS / DASH**：点入口时经 SW 既有的 `proxy-fetch-text`（裸请求 →
    401/403/407 才补防盗链头 → 退避重试 → no-cors 探针）抓一次主清单解析档位。
    HLS 选中档位的清单地址本身就是可下载地址 —— **下载引擎零改动**；DASH 档位
    在清单内部，新增 `preferredHeight` 偏好透传到引擎，仅给命中的 `Representation`
    加权（不带该参数时逐字沿用旧版「取最高」行为）。
- **「重新嗅探本页视频」真正重扫。** 旧实现只把 `manual-scan` 转发给内容脚本，
  页面侧重扫出的仍是同一批 URL，在后台 `addDetectedVideo` 按 `_norm` 去重 →
  列表纹丝不动，用户看到的就是「点了没反应」。现在右键菜单与弹窗「重新扫描」
  统一走后台 `rescan-page`：**先清空该页记录，再让内容脚本从零嗅探**。只清视频
  列表，不动 cookie 快照（下载防盗链头仍可复用）。
- **恢复默认下载并发 12。** `DEFAULT_SETTINGS.threadCount` 此前为 8，而流媒体路径
  声明的上限是 24；单文件吞吐≈正比于连接数，默认 8 比旧默认 12 少约三分之一。
  设置页线程滑块上限同时由 16 放开到 24（此前 24 永远够不到）。注意：**已保存过
  设置的用户不受影响**（`getSettings` 以存储值为准），需在下载页把线程拖到 12+。
- 新增 `tests/test-stream-variants.js`：HLS 主清单档位解析回归测试（含
  `AVERAGE-BANDWIDTH` 不得被当作 `BANDWIDTH`、相对 URI 解析等边界）。

## [4.4.2] - 2026-09-13

### 第三方合规修复（无任何功能改动）

上架前做了一次**来源与许可证审计**，发现并修复以下实质合规缺口：

- **`lib/mp4box.min.js` 的版权声明与许可证正文缺失。** 该文件是 GPAC `mp4box.js`
  （**BSD-3-Clause**）的上游压缩产物，文件内只有构建横幅 `/*! mp4box 02-11-2024 */`，
  没有版权行。BSD-3 要求再分发时保留版权声明与许可证正文 —— 现已补齐。
- **Apache-2.0 许可证正文未随包分发。** `lib/ts-mux.min.js` 是 `mux.js` 7.0.3
  （Apache-2.0），§4(a) 要求向接收者提供许可证副本 —— 现已补齐。
- **`lib/VENDOR.md` 把 mp4box.js 的许可证误写为 BSD-2-Clause**，实为
  **BSD-3-Clause**（已核上游 LICENSE 原文）—— 已更正。
- 新增 **`lib/THIRD-PARTY-NOTICES.md`**：含两个上游组件的完整版权行与许可证正文
  （逐字取自上游，未转述）、来源与版本、是否改动、SHA256 完整性校验，以及
  「借鉴同类项目」的红线说明。它在 `lib/` 内，随发布包自动分发。
- 明确记录红线：本仓库以 MIT 分发，**不得引入 GPL/AGPL/LGPL 代码**。同类项目中
  猫抓（cat-catch）为 GPL-3.0 —— 只可参考其文档与交互，**不可参考其源码实现**。

## [4.4.1] - 2026-09-13

### 借鉴同类项目（纯增量，未改动任何既有流程）

- **弹窗「粘贴链接下载」**（借鉴 [media-bridge](https://github.com/jvillegasd/media-bridge)
  的 manual URL input）：页面没嗅到、或链接在别处时，直接在弹窗粘贴视频 / 流媒体直链、
  回车即下载。**复用既有的 `start-download` 链路**（后台 `isSafeUrl` 校验 → 会话存储 →
  下载页），不新增消息通道，嗅探与下载主链路零改动；按 URL 扩展名自动判定
  直链 / HLS / DASH 走对应引擎。
- **文件名命名模板**（借鉴 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)
  的 `--save-pattern`、yt-dlp 的 `-o`）：设置里的「自定义名称」现在支持变量 ——
  `{title}` `{site}` `{quality}` `{format}` `{type}` `{date}` `{time}`。
  模板里没有 `{…}` 时行为与旧版固定名**完全一致**；未识别的 `{xxx}` 原样保留。

### 调研结论（本轮未实现，按性价比排序）

对比了 Bili23-Downloader、猫抓(cat-catch)、media-bridge、N_m3u8DL-RE：

- **画质选择**：现在固定选最高画质，同类均可选。需要在嗅探期解析清单枚举变体，
  会动下载主链路，风险最高 —— 留待单独一轮。
- **下载历史页面**：历史数据已存 `chrome.storage.local`，但缺独立页面查看。
- **站点黑名单**（猫抓的「避免抓取列表」姿态）：成本很低，作为合规姿态可随时加。
- **字幕 / 弹幕下载**：Bili23 有；通用实现需解析 HLS `EXT-X-MEDIA:TYPE=SUBTITLES`
  与 DASH 文本轨。
- **直播流录制**：media-bridge / N_m3u8DL-RE 支持，成本高。

## [4.4.0] - 2026-09-12

### 国际化（i18n）
- **接入 Chrome 原生语言包**：新增 `_locales/zh_CN`、`_locales/en`，`manifest.json` 的
  名称/简介/弹窗标题改用 `__MSG_*__`。**新增语言只需新增一个 JSON 文件，零代码改动**；
  Chrome 自动按界面语言加载，缺失的键自动回落 `default_locale`（zh_CN）。
- **`lib/i18n.js`**：`t(key, subs)` 薄封装 + `data-i18n` DOM 本地化；拿不到译文时返回键名
  而不是空串，HTML 里的中文原文作为无 JS 兜底保留，**语言包损坏也不会白屏**。
- 覆盖范围：扩展清单、弹窗、下载管理页、后台通知/右键菜单/错误文案、页面内 MSE 提示。
  仍为中文的部分：代码注释、`console.*` 调试输出、MAIN world 脚本（无 `chrome.i18n`）
  与 `lib/mp4-merger.js` / `lib/ts-remux.js` 的内部错误码；这些不面向终端用户。
- **`scripts/i18n-check.js` + `npm run test:i18n`**：门禁校验 zh/en 键集合一致、
  `$n` 占位符一致、代码引用的键都存在、`manifest.json` 的 `__MSG_*__` 都存在、
  未合并的 `*.frag.json` 清零。已接入 CI。

### 借鉴同类扩展的能力
- **弹窗搜索 / 排序**（借鉴猫抓、Video DownloadHelper）：条目多时按名称/地址/格式筛选，
  支持智能排序、按大小、按名称、按类型，排序方式持久化。
- **「更多复制方式」**：一键复制 链接 / `curl` / `aria2c` / `ffmpeg` 命令（自动带上
  源页面 Referer），方便把任务交给外部下载器。
- **深色模式**：`prefers-color-scheme` 自适应，弹窗不再在暗色系统下刺眼。
- **键盘快捷键**：`Alt+Shift+V` 直接打开弹窗。

### 工程化
- `manifest.json` 增加 `default_locale`、`short_name`、`homepage_url`。
- 打包与 CI 纳入 `_locales`（此前会漏打包语言包）。

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