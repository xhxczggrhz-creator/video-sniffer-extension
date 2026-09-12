# 第三方依赖清单（VENDOR）

> 本项目为无构建、纯静态加载的浏览器扩展（MV3 + ES Module）。以下为运行时打包进
> 扩展的**本地第三方资源**，均在 `lib/` 下，运行时不额外请求外部 CDN。
>
> **完整版权声明与许可证正文见 [`lib/THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)**
> —— 该文件随扩展一起打包分发，履行署名与许可证保留义务。

## 打包进扩展的第三方文件

| 文件 | 上游项目 | 用途 | 版本 / 构建 | 许可证 | 是否改动 |
|---|---|---|---|---|---|
| `lib/mp4box.min.js` | [gpac/mp4box.js](https://github.com/gpac/mp4box.js) | 解析 fMP4 盒结构，供音视频合并（`lib/mp4-merger.js`）使用 | 横幅 `02-11-2024`（上游未标语义化版本） | **BSD-3-Clause** | 否，原样取自上游 dist |
| `lib/ts-mux.min.js` | [videojs/mux.js](https://github.com/videojs/mux.js) | TS → fMP4 转复用（HLS 合并），供 `lib/ts-remux.js` 使用 | **7.0.3**（文件内横幅） | **Apache-2.0** | 否，原样取自上游 dist |

两个文件都**保持上游构建横幅未被改动**；因为未做二次修改，Apache-2.0 §4(b) 的
「修改声明」义务不适用，BSD-3 的「保留版权声明」义务由 `THIRD-PARTY-NOTICES.md`
随包分发来履行。

### 完整性校验（防止被误改/被替换）

| 文件 | SHA256 | 字节数 |
|---|---|---|
| `lib/mp4box.min.js` | `70221709a974a3ad6796935031c41565f3616cc4ed690c55dc59f97cd6d7dd1e` | 156753 |
| `lib/ts-mux.min.js` | `79da5742f8985d9362b14a3ca4d705eea726cea6d513d0d019c359bf4eec856b` | 115158 |

> 升级任一 min 文件时：同步更新本表哈希与 `THIRD-PARTY-NOTICES.md`，并跑
> `npm test`（含合并 / 转封装 / 校验用例）回归。

## 自研文件

`lib/` 下其余文件均为本项目自研代码，适用根目录的 MIT 许可证：

`constants.js`、`i18n.js`、`download-engine.js`、`mp4-merger.js`、`net-helpers.js`、
`storage.js`、`stream-downloader.js`、`ts-remux.js`。

## 关于「借鉴同类项目」

功能创意层面参考过数个开源同类项目（media-bridge、猫抓 cat-catch、
N_m3u8DL-RE、yt-dlp、Bili23-Downloader、CocoCut 等），**仅借鉴功能思路，未复制其
源代码**。相关说明与红线见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) 末节。

## 更新流程

自研依赖由 CI 语法门禁（`npm run lint`）守护；第三方 min 文件更新后务必跑
`npm test` 与 `node scripts/i18n-check.js` 回归。
