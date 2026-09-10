# 视频嗅探器（Video Sniffer）

> 浏览器 MV3 扩展：自动嗅探网页视频，多线程高速下载（aria2 动态分段技术），支持流媒体（HLS/DASH）、MSE 拦截捕获、音视频轨合并与录制。

**版本：4.3.17 ｜ 纯 HTTP 直连，无 P2P / BT / 磁力，完全隐私。**

---

## 功能特性

- **视频嗅探**：自动检测页面直链、HLS/DASH 流、MSE (Media Source Extensions) 捕获、Blob URL，弹出列表一键下载
- **多线程高速下载**：借鉴 aria2 动态分段技术，单文件并发多段，逐段校验长度，失败单段重试（连续 3 次才降级直连），进度实时推送
- **流媒体下载**：HLS 分片（含 AES-128 解密）、DASH 流，自动解析最高画质；TS 流完成下载后自动再封装为标准 MP4（mux.js + mp4-merger），失败自动降级不产出坏文件
- **音视频轨合并**：切轨流（视频轨 + 音频轨）自动合并为单 MP4
- **MSE 拦截捕获**：拦截 MediaSource appendBuffer 数据，广告清除、超限截断保护
- **录制模式**：MediaRecorder 实时捕获，支持倍速与黑帧告警

---

## 零数据泄露承诺

- 全部下载采用**官方 HTTP(S) 直连**（含 SW 代理与 MSE 捕获），**严禁任何 P2P / BT / 磁力链接**，代码层面硬编码禁止
- 数据仅在你本地浏览器与服务间流动，不上传任何第三方

---

## 安装（开发模式加载）

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本项目根目录
3. 浏览器版本需 ≥ Chrome 111（Manifest V3）

## 使用

1. 打开视频页面，点击扩展图标
2. 列表中会显示嗅探到的视频资源（直链 / 流媒体 / MSE 捕获）
3. 点击「下载」将在下载页多线程下载；流媒体条目自动选择画质并分片下载

---

## 目录结构

```
video-sniffer-extension/
├── background/service-worker.js   # MV3 后台：状态机 / 消息总线 / DNR / 流代理 / 下载调度
├── content/                       # 内容脚本
│   ├── mse-hook.js                #   MSE appendBuffer 拦截 + B站 __playinfo__
│   ├── media-sniffer.js           #   直链/流媒体嗅探 + 录制
│   └── content-script.js          #   消息桥接 / B站 playurl API
├── lib/                           # 核心库（mp4-merger / ts-remux / download-engine / stream-downloader / constants）
├── download-page/                 # 下载页面（多线程下载引擎 UI / 转封装 / 合并）
├── popup/                         # 扩展弹窗
├── offscreen/                     # Offscreen 文档
├── tests/                         # 回归/单测（node --check 语法校验 + 专项测试）
└── icons/                         # 图标
```

---

## 开发与测试

```bash
# 语法校验全部 JS
node --check background/service-worker.js
node --check content/*.js lib/*.js download-page/download.js

# 专项回归（详见各测试文件头部说明）
node tests/test-engine-v3.js
node tests/test-merger.js
```

---

## 免责声明

- 本扩展仅用于**个人学习与研究**；请在法律许可范围内使用
- 请遵守所在地区版权法规，勿用于盗版传播

---

## License

[MIT](LICENSE)