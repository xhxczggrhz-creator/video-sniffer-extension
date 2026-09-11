# 第三方依赖清单（VENDOR）

> 本项目为无构建、纯静态加载的浏览器扩展（MV3 + ES Module）。以下为运行时打包进
> 扩展的**本地第三方资源**，均在 `lib/` 下，运行时不额外请求外部 CDN。
> 所有 min 文件均可由对应上游源码构建，建议核对版本后按上游许可证合规引用。

| 文件 | 上游项目 | 用途 | 版本 | 许可证 | 备注 |
|---|---|---|---|---|---|
| `lib/mp4box.min.js` | GPAC `mp4box.js` | 解析 fMP4 轨道，供音视频合并（mp4-merger） | 0.4.x（待核对） | BSD-2-Clause | 上游：https://github.com/gpac/mp4box.js |
| `lib/ts-mux.min.js` | [`mux.js`](https://github.com/videojs/mux.js) | TS → fMP4 转复用（HLS 合并） | 待核对 | Apache-2.0 | 上游：videojs/mux.js |

## 版本与来源核对待办
- 上述两个 min 文件当前**尚未在文件中标注精确版本与构建日期**。建议今后在更新时：
  1. 记录构建自的上游 commit / tag；
  2. 在文件头部注释块补 `VENDOR-INFO: project=... version=... license=... upstream=...`；
  3. 与本表保持一致。
- 其余 `lib/*.js`（constants、download-engine、mp4-merger、net-helpers、storage、
  stream-downloader、ts-remux）均为本项目自研代码。

## 更新流程
自研依赖由 CI 语法门禁（`npm run lint`）守护；第三方 min 文件更新后务必跑
`npm test`（含合并 / 校验用例）回归。