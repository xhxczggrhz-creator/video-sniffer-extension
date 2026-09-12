# Chrome Web Store 上架清单（v4.5.0）

> 这份文档是「上传即可提交」的全部素材。带 ⬜ 的步骤**只能由账号持有人操作**，我无法代劳。

---

## 0. 分工边界

| 谁 | 做什么 |
|---|---|
| ✅ 已完成（本仓库） | 版本号、CHANGELOG、语言包、图标尺寸、打包 zip、门禁全绿、权限说明文案、商店文案、隐私问卷答案 |
| ⬜ 只能你做 | ① 注册 CWS 开发者账号（一次性 **$5**，需 Google 账号 + 信用卡）② 登录后上传 zip、粘贴下面的文案 ③ 拍截图 ④ 点「提交审核」 |

我无法登录你的 Google 账号、无法替你付费、也无法在真实 Chrome 里加载扩展拍图。

---

## 1. 上传包（已就绪）

```bash
npm run package     # → dist/video-sniffer-4.5.0.zip
```

已校验：

- 33 个文件，含 `_locales/zh_CN/messages.json` 与 `_locales/en/messages.json`
- 不含 `tests/`、`.trae/`、`dist/` 暂存目录
- **无 `eval` / `new Function` / 远程脚本**（`eval` 只出现在 `tests/`，不进包）
- 图标尺寸合规：`icons/icon128.png` 128×128、`icon48` 48×48、`icon32` 32×32、`icon16` 16×16
- 清单字段长度合规：名称 ≤45、`short_name` ≤12、简介 ≤132

---

## 2. 商店文案（直接复制）

### 中文（主语言）

**名称（≤45）**

```
视频嗅探器 - 网页视频下载
```

**简介（≤132）**

```
自动嗅探网页视频资源，多线程高速下载（aria2 动态分段技术），支持 HLS/DASH 流媒体、MSE 拦截捕获与音视频轨合并。纯 HTTP 直连，无 P2P，完全隐私。
```

**详细说明**

```
视频嗅探器：把网页里正在播放的视频抓下来。

■ 核心能力
• 自动嗅探：直链、HLS(m3u8) / DASH(mpd)、MSE 拦截捕获、blob 地址，一次列全
• 多线程高速下载：借鉴 aria2 动态分段，单文件多连接并发，逐段校验长度，单段失败自动重试
• 流媒体处理：HLS 分片（含 AES-128 解密）、DASH 流；TS 流下载完成后自动重封装为标准 MP4，失败自动降级，绝不产出坏文件
• 画质 / 音质自选：把 HLS 主清单与 DASH 清单里的可选档位列出来由你挑；音视频分离的站点视频轨与音轨可分别选。默认仍是自动取最高，不打开这个菜单就完全走原路径
• 音视频轨合并：音视频分离存储的站点自动配对并合并为单个 MP4
• MSE 拦截捕获：直接截获原始媒体分段，广告清除、超限保护，不受播放速度限制
• 录制模式：MediaRecorder 实时捕获，支持倍速与黑帧告警
• 列表搜索与排序：条目多时按名称 / 地址 / 格式筛选，可按大小、名称、类型排序
• 复制为命令：一键复制 curl / aria2c / ffmpeg 命令（自动带上 Referer），交给外部下载器
• 深色模式 + 快捷键：跟随系统主题；Alt+Shift+V 打开弹窗

■ 隐私
• 纯 HTTP(S) 直连，代码层面禁止 P2P / BT / 磁力
• 无遥测、无统计 SDK、无广告、无第三方上报
• 防盗链签名与 Cookie 只存在于浏览器会话内存，读取即清除，绝不落盘

■ 说明
基于通用媒体嗅探：只要页面会产生 HTTP(S) 媒体请求（直链 / HLS / DASH），就能被检测与下载。

■ 免责声明
仅供个人学习、研究与技术交流使用。请仅下载你有权访问与保存的内容，遵守目标站点的服务条款与当地法律。
```

### English

**Name (≤45)**

```
Video Sniffer - Web Video Downloader
```

**Summary (≤132)**

```
Download videos from any page: multi-threaded, HLS/DASH, MSE capture, A/V merging. No P2P, no telemetry, fully local.
```

**Detailed description**

```
Video Sniffer grabs the video that is already playing in your browser tab.

■ What it does
• Detection: direct links, HLS (m3u8) / DASH (mpd) manifests, MSE capture and blob URLs, listed in one click
• Multi-threaded download: aria2-style dynamic segmentation — one file over several concurrent connections, every segment length-verified, failed segments retried individually
• Streaming: HLS segments (including AES-128 decryption) and DASH streams at the best quality; finished TS streams are remuxed into standard MP4 and degrade gracefully instead of producing a broken file
• Track merging: separate video and audio tracks are merged into a single MP4
• MSE capture: intercepts the raw media segments directly, with ad stripping and size-limit protection
• Recording mode: MediaRecorder capture with speed-up and black-frame warnings
• Search & sort: filter by name / URL / format and sort by size, name or type
• Copy as command: one click for a ready-to-run curl / aria2c / ffmpeg command (with the correct Referer)
• Dark mode and a keyboard shortcut (Alt+Shift+V)

■ Privacy
• Plain HTTP(S) only — P2P, BitTorrent and magnet links are disabled in code
• No telemetry, no analytics SDK, no ads, no third-party reporting
• Hotlink signatures and cookies stay in session memory, are cleared on read, and are never written to disk

■ Scope
Built on generic media sniffing: if a page issues HTTP(S) media requests, it can be detected and downloaded.

■ Disclaimer
For personal study, research and technical exchange only. Download only content you are entitled to access and save, and follow the target site's terms of service and your local law.
```

### 分类与语言

- 类别：**Productivity**（Chrome Web Store 允许的类目里最贴近；无专门的「下载工具」类目）
- 主要语言：中文（简体）｜ 附加：English
- 主页：`https://github.com/xhxczggrhz-creator/video-sniffer-extension`

---

## 3. 权限说明（CWS 逐条必填，直接复制）

CWS 的隐私表要求**为每个声明权限写一段理由**。官方明确说：用不到的权限就删掉，声明过宽会被拒。

| 权限 | 说明（粘贴用） |
|---|---|
| `webRequest` | 读取页面自身发出的媒体请求，用于识别可下载的视频地址。仅读取请求/响应头与 URL，不做任何数据采集。 |
| `storage` | 保存用户设置、每个标签页的检测结果，以及会话级下载凭据（`chrome.storage.session`，会话结束即失效）。 |
| `downloads` | 仅在用户点击「保存」时把已下载完成的文件写入本地磁盘。 |
| `tabs` | 在对应标签页的图标上显示检测到的视频数量徽章，并把下载管理页开在原视频标签页旁边。 |
| `notifications` | 下载 / 合并 / 录制完成后给出完成提示。 |
| `contextMenus` | 提供右键菜单入口。 |
| `declarativeNetRequest` | 「强力下载」时，按用户请求为**该次下载**注入 Referer / Origin 请求头（动态规则，仅作用于用户主动发起的下载）。 |
| `alarms` | 定期清理过期缓存与会话数据（隐私清理）。 |
| `offscreen` | 在无 DOM 的 Service Worker 中完成音视频合并所需的 DOM / Blob 操作。**只处理本地 blob，不发起任何外部请求。** |
| `dns` | 用于 SSRF 防护的 DNS 复查（该 API 目前仅 Chrome Dev 渠道提供；稳定版不存在该 API，代码会自动跳过，URL 字面 IP 拦截仍然生效）。 |
| 主机权限 `<all_urls>` | 视频嗅探必须在用户访问的任意网站上运行，才能检测该页发出的媒体请求。这是本扩展唯一可行的实现方式。 |

> 如果 CWS 后台把 `dns` 标为「未知/多余权限」并要求移除：把 `manifest.json` 的 `permissions` 里 `"dns"` 一行删掉即可，**代码无需改动**（`background/service-worker.js` 里已有 `if (!chrome?.dns?.resolve) return true;` 保护，稳定版本就走的这条路径）。代价是 Dev 渠道下少一层 DNS 复查。

---

## 4. 隐私实践问卷

| 问题 | 答案 |
|---|---|
| 单一用途说明（Single purpose） | 检测网页中的视频资源并下载到本地。 |
| 是否收集用户数据 | **否**。不收集、不存储、不出网传输任何浏览行为数据。 |
| 是否出售 / 转让数据 | 否（无数据可售）。 |
| 是否用于与单一用途无关的目的 | 否。 |
| 是否使用远程代码 | **否**。所有 JS 都打包在扩展内，无 `eval`、无 `new Function`、无远程脚本（`content_security_policy` 为 `script-src 'self'`）。 |
| 隐私政策 URL | `https://github.com/xhxczggrhz-creator/video-sniffer-extension/blob/main/PRIVACY.md` |

---

## 5. 截图清单（1280×800，准备 3–5 张）

⬜ 需要你在真实 Chrome 里加载扩展后拍摄（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选仓库根目录）。

1. **嗅探列表**：打开一个含多个视频源的页面 → 点图标 → 列表里多条条目，能看到「流媒体 / 视频轨·无声 / 音频轨」徽章
2. **画质 / 音质自选**：点条目上的「画质」→ 弹出各档位列表（体现 v4.5.0 新功能；截图里不要出现平台 logo）
3. **搜索 + 排序**：搜索框输入关键词后的过滤结果
4. **复制为命令**：展开某条的「⋯ 更多复制方式」菜单（curl / aria2c / ffmpeg）
5. **下载管理页**：多线程进度条 + 分段可视化 + 连接数 / 速度 / 剩余时间
6. **深色模式下的设置面板**（可选，展示国际化与主题）

小贴士：截图里不要出现受版权保护的具体影片画面或平台 logo，用中性页面更安全。

---

## 6. ⚠️ 上架前必须知道的风险（本节最重要）

CWS 官方「下架 / 拒绝的常见原因」中明确列出：

- **便利下载 YouTube 视频**
- **便利下载侵犯内容所有者知识产权的内容**

来源：[Troubleshooting Chrome Web Store violations](https://developer.chrome.com/docs/webstore/troubleshooting)

现实案例：SaveFrom.net Helper 于 **2025 年底**再次因政策违规从商店下架。

对本项目的具体含义：

1. 本扩展里存在**平台定向的深度集成**（`content/mse-hook.js` 读取某站的 `__playinfo__`、`content/content-script.js` 调用其 `/x/player/playurl` 直链 API、弹窗里有该平台的下载徽章）。按上面第一条政策，**针对某一平台做定向下载**正是最容易被判违规的形态 —— 风险不在代码质量，在「定向」这个形态本身。
2. README 里的免责声明**不能免除商店政策责任**。商店政策与著作权法是两套判定，前者更主观、更快。
3. 因此「长期存在运行」的最大变量不是代码，而是**这个类目在 CWS 上的存活率**。

应对方式（按诚实程度排序，别选第三种）：

- **A. 接受风险，照实上架。** 商店作为补充渠道，GitHub（unpacked + release zip）始终是主渠道。被下架也不会失去用户。
- **B. 真正收窄范围再上架。** 商店版只保留通用 HLS/DASH/MSE 嗅探与下载，去掉平台定向的代码路径与品牌化文案。这是功能决策，不是话术。
- **C. 换措辞藏功能 —— 不要做。** 一旦被复核，后果比初次拒绝重得多。

**第二条上架渠道**：Edge Add-ons（`https://partner.microsoft.com/dashboard/microsoftedge`）接受同一份 MV3 zip，免费、审核相对宽松。同一份包可以两边都投。

---

## 7. 提交后的维护闭环

1. 发版：改 `manifest.json` + `package.json` 的版本 → 写 `CHANGELOG.md`（CI 会校验两者一致）→ `npm run package` → 上传新 zip。
2. CI 已包含：语法门禁（含跨脚本顶层声明冲突）、单元回归、SSRF 安全回归、**i18n 语言包门禁**。
3. 新增一门语言：只需加 `_locales/<lang>/messages.json`，零代码改动（见 [i18n.md](i18n.md)）。
4. 首次提交通常 1–3 个工作日；被拒时按 dashboard 的违规条款逐条回复，不要重复提交同一份包。
