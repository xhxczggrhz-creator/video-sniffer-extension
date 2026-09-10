/**
 * 视频嗅探器 - 下载引擎 v2.1（aria2 / Motrix 核心技术）
 *
 * 真正落地的 aria2 核心算法：
 * 1. 动态分段分配（aria2 --split / --min-split-size）：
 *    文件切成大量小分段，N 条连接从全局游标动态领取，谁快谁多干，
 *    彻底消除"一条慢连接拖住整块"的问题。
 * 2. OPFS 流式直写（Origin Private File System）：
 *    每个分段直接按字节偏移写入目标文件，无"缓存→合并"二次 I/O，
 *    无内存峰值，这是现代浏览器高速下载的关键底座。
 * 3. 自适应连接扩展（aria2 --max-connection-per-server）：
 *    带宽充裕时自动加连接，最高 16 条。
 * 4. UI 上报时间片节流：网络循环不再被渲染拖慢。
 *
 * v2.1 加固：
 * - fetch 超时控制（AbortController 30s 无数据自动断开重连）
 * - OPFS 全路径清理（finally 保证，异常/崩溃也不残留临时文件）
 * - URL 安全校验（禁止 file:// chrome:// 等非 HTTP(S) 协议）
 * - 断线自动重连 + 指数退避
 * - 连接停滞检测（长时间无数据的连接自动回收）
 *
 * 隐私：纯 HTTP 直连下载，无 P2P、无 BT、无任何第三方上报。
 */

const FETCH_TIMEOUT_MS = 30000;
// 探测竞态兜底：SW 端 15s 硬超时先触发，+2s 余量（v4.2.1）
const PROBE_RACE_TIMEOUT_MS = 17000;
const STALL_TIMEOUT_MS = 20000; // 接近 FETCH_TIMEOUT，避免过早断开
// P1-C：分段代理请求超时对齐 —— SW 端 PROXY_TIMEOUT_SEGMENT = 60s，
// 页面侧竞速必须 ≥ 60s + 5s 余量（旧值 35s 会在大分段流式落盘完成前
// 抢先判负，触发无谓重试/降级直连）。
const SEGMENT_PROXY_TIMEOUT_MS = 65000;

// v4.3.2 O-4：sendBgMessage / exponentialBackoff /
// sanitizeErrorMessage 收敛到 lib/net-helpers.js，本文件优先使用共享实现。
// 测试环境（test-engine-v3.js 用 new Function(src) 加载本文件、不加载
// net-helpers.js）走下方本地兜底——保持零改动可跑。生产环境 download.html
// 已在 download-engine.js 之前注入 lib/net-helpers.js，_NetHelpers 命中共享实现。
const _NetHelpers = (typeof window !== 'undefined' && window.__VideoSnifferNetHelpers__)
  || (typeof globalThis !== 'undefined' && globalThis.__VideoSnifferNetHelpers__)
  || {};
const sendBgMessage = _NetHelpers.sendBgMessage || async function sendBgMessage(message, timeoutMs = 25000) {
  // 本地兜底（仅测试环境命中）：与 lib/net-helpers.js 保持一致
  try {
    const wakeUp = chrome.runtime.connect({ name: 'keepalive' });
    setTimeout(() => { try { wakeUp.disconnect(); } catch {} }, 50);
  } catch {}
  const raw = await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`SW 响应超时（${timeoutMs / 1000}s）——可能 SW 休眠或繁忙，type=${message?.type}`)),
      timeoutMs,
    )),
  ]).catch((e) => {
    const msg = String(e?.message || e).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    console.warn('[VideoSniffer] sendBgMessage 失败:', msg, 'type=', message?.type);
    throw e;
  });
  if (raw && typeof raw === 'object' && 'success' in raw) {
    return raw.success ? (raw.data ?? {}) : { error: raw.error || '后台处理失败' };
  }
  return raw;
};
const _exponentialBackoff = _NetHelpers.exponentialBackoff || function exponentialBackoff(attempt, base = 300, cap = 10000) {
  return Math.min(cap, base * Math.pow(2, attempt)) + Math.random() * 250;
};

function validateDownloadUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return false;
    return true;
  } catch { return false; }
}

// P2 进度推送：segReqId → 引擎实例 路由表。SW 在代理分段抓取+落盘期间
// （32MB 分段可长达 25-60s）每 512KB 推 {type:'seg-progress', segReqId,
// written}；引擎把在途字节计入 downloadedBytes，进度条不再长时间冻结。
const SEG_REQ_ROUTES = new Map();
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'seg-progress' || !msg.segReqId) return;
    const engine = SEG_REQ_ROUTES.get(msg.segReqId);
    if (engine) engine._onSegProgress(msg.segReqId, msg.written);
  });
}

class DownloadEngine {
  constructor(options = {}) {
    this.url = options.url;
    this.fileName = options.fileName || 'video.mp4';
    this.format = options.format || 'mp4';
    this.totalSize = options.totalSize || 0;
    this.threadCount = Math.max(1, options.threadCount || 8);
    this._userThreadCount = this.threadCount;     // v4.2.7：保存用户设定值作为硬上限
    this.maxThreads = options.maxThreads || 16;
    this.mode = options.mode || 'normal';        // normal | force
    this.referer = options.referer || null;      // 强力下载：源页面地址
    this.speedBoost = options.speedBoost !== false;
    this.downloadId = options.downloadId || null;  // 下载唯一 ID（连接配额管理）
    this._forceRuleId = null;                   // DNR 规则 ID（每个下载独立）
    this._registered = false;                    // 是否已注册到下载注册表
    this._concurrentCount = 1;                   // 当前并发下载数
    this._useProxy = true;                       // 代理路径开关（v4.2.6 OPFS 手递手协议，保留作回退）
    // v4.3.15 直连优先：DNR 规则在 start() 对所有模式统一应用（注入 Referer/Cookie
    // 反防盗链 + ACAO 响应头放行 CORS，v3.1.1 起），下载页直连 fetch 分段为单缓冲
    // （网络 → 流式写目标 OPFS 一次），不再经历「SW 抓取 → SW 写 OPFS → 页面读回
    // → 页面再写目标」三重 I/O + SW 单线程串行。直连失败（CORS/网络/401/403）连续
    // 3 次才整体回退 SW 代理——与 stream-downloader v4.3.13 同款策略，速度贴近
    // 原生下载器。生死线不变：直连目标仍是用户选择的视频源服务器本身，仅官方
    // HTTP(S)，零 P2P/零外传；代理能力完整保留，不削弱任何已有防护。
    // （v4.2.5 直连优先失败的原因是当时 DNR 放行未覆盖普通模式；现前提已具备。）
    this._useDirect = true;                      // 直连优先基线
    this._directFailCount = 0;                   // 直连连续失败计数（≥3 整体回退代理）
    this._directBody = null;                     // 直连单流响应体（downloadSingleStream 内部中转）

    // aria2 风格分段参数
    // v4.2.7：增大默认分段（2MB→32MB），减少 OPFS 临时文件数量和 SW 消息往返，
    // 降低多任务 I/O 竞争。分段太少 → 海量小 OPFS 文件同时创建/删除 → 卡顿。
    this.minPieceSize = 2 * 1024 * 1024;         // 2MB
    this.maxPieceSize = 32 * 1024 * 1024;        // 32MB

    // 状态
    this.pieces = [];            // { index, start, end, downloaded, status }
    this.cursor = 0;            // 下一个待分配分段的下标
    this.downloadedBytes = 0;
    this.completedBytes = 0;    // 已完整落盘的分段字节数
    this.status = 'idle';
    this.paused = false;
    this.aborted = false;
    this.activeConnections = 0;
    this.connectionPromise = null;
    this.pieceErrors = new Map();
    this.workers = new Set();    // 活跃 worker Promise 集合（含动态增援的）
    this._detectedContainer = null;  // 首块 magic bytes 识别出的真实容器
    this._singleStreamFallback = false;  // 服务器忽略 Range 时的单流回退标记
    // v4.2.5 直连优先：Range 是 CORS 安全请求头，分段/探测请求不触发预检；
    // 防盗链 Referer/Origin/Cookie 与响应头 ACAO/Content-Range 均由 DNR 规则
    // 注入，下载页（chrome-extension://）可直连读取大站 CDN。
    // 反观过去默认把 1–16MB 分段经 chrome.runtime.sendMessage 往返代理，
    // 消息总线承载大二进制易超限/串行化慢，是"显示高速下载却始终 0%、不如
    // 2.x/3.x"的头号根因。仅当直连被 CORS 拦截时才切 SW 代理兜底。

    // 速度（EMA 平滑，避免数值跳动）
    this.speedEMA = 0;
    this.lastTickBytes = 0;
    this.lastTickTime = 0;

    this.onProgress = options.onProgress || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onSpeedUpdate = options.onSpeedUpdate || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    // OPFS
    this.fileHandle = null;
    this.writer = null;
    this.writeQueue = Promise.resolve();

    // UI 节流
    this._lastProgressNotify = 0;
    this._cleanupDone = false;
    // P2 进度推送：segReqId → 在途 piece（SW 抓取阶段的字节进度计入
    // downloadedBytes，completedBytes + Σ在途 downloaded 的口径见
    // _onSegProgress / _clearSegRoute）
    this._segInflight = new Map();
    // v4.3.2 S-1：quota_epoch 握手。SW 在 conn-realloc 广播里带递增 epoch，
    // 引擎只接受更新的 epoch（>=），旧 epoch 视为过期重放、忽略。
    // 防止 SW 重启/消息重放把已经收缩的配额再叠加回旧值。
    this._lastQuotaEpoch = 0;
  }

  // ============================================================
  // OPFS - 高速流式文件写入（不可用时降级到内存模式）
  // ============================================================
  _useOPFS = true;  // 运行时检测

  async initOPFS() {
    // OPFS 可用性检测
    if (!navigator.storage?.getDirectory) {
      this._useOPFS = false;
      this._memChunks = [];  // 降级：内存收集
      return;
    }
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('vs-downloads', { create: true });
      // 唯一文件名，避免并发下载冲突
      const safe = this.fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      this.fileHandle = await dir.getFileHandle(`${Date.now()}_${safe}`, { create: true });
      this.writer = await this.fileHandle.createWritable({ keepExistingData: false });
    } catch (e) {
      // OPFS 初始化失败 → 降级到内存模式
      this._useOPFS = false;
      this._memChunks = [];
    }
  }

  // 写入队列：按偏移直写 OPFS（序列化保证一致性，并发分段安全）
  // 降级模式：收集到内存数组
  writeAt(position, data) {
    if (!this._useOPFS) {
      // 内存降级模式：收集分片
      this._memChunks = this._memChunks || [];
      this._memChunks.push({ position, data });
      return Promise.resolve();
    }
    if (!this.writer) return Promise.resolve();
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.writer) return;
      await this.writer.write({ type: 'write', position, data });
    }).catch((e) => {
      // 关键修复：写入失败绝不能吞掉（旧版静默 catch → 文件空洞
      // → "下载成功但无法播放"）。记录首次错误，finalize 时硬失败。
      this._writeError = this._writeError || new Error(`文件写入失败: ${e?.message || e}`);
    });
    return this.writeQueue;
  }

  async finalizeFile() {
    if (!this._useOPFS) {
      // 内存降级模式：合并所有分片为一个 Blob
      await this.writeQueue;
      if (this._writeError) throw this._writeError;
      this._memChunks = this._memChunks || [];
      // 按 position 排序保证顺序
      this._memChunks.sort((a, b) => a.position - b.position);
      const blob = new Blob(this._memChunks.map(c => c.data), { type: this.getMimeType() });
      this._memChunks = [];
      return blob;
    }
    await this.writeQueue;
    if (this._writeError) throw this._writeError;
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
    const file = await this.fileHandle.getFile();
    return file;
  }

  async removeOPFSFile() {
    // 内存降级模式：清空数组
    if (!this._useOPFS) {
      this._memChunks = [];
      return;
    }
    try {
      if (this.writer) { this.writer.abort?.(); this.writer = null; }
      if (this.fileHandle) {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
        await dir.removeEntry(this.fileHandle.name);
        this.fileHandle = null;
      }
    } catch {}
  }

  // ============================================================
  // 下载注册表：注册/注销 + 自适应连接数
  // ============================================================
  async registerDownload() {
    try {
      const resp = await sendBgMessage({
        type: 'register-download',
        downloadId: this.downloadId,
        maxThreads: this.maxThreads,
        url: this.url,
        userThreadCount: this._userThreadCount,
      });
      if (resp?.threadCount) {
        // v4.2.7 关键修复：用户在设置页拖动的线程数必须作为硬上限。
        // 旧版直接用 SW 分配值覆盖 this.threadCount → 用户设定完全无效。
        // 现在：取 SW 公平分配值与用户设定值的较小者，再收紧在 maxThreads 内。
        this.threadCount = Math.max(1, Math.min(this._userThreadCount, this.maxThreads || 16, resp.threadCount));
        this._concurrentCount = resp.concurrentCount || 1;
        // v4.2.7：多任务时增大分段大小（而非减小），减少 OPFS 临时文件数量
        // 和 SW 消息往返次数，降低 I/O 竞争。旧版减小分段反而制造更多
        // 并发 OPFS 写入，是"多任务卡顿"的帮凶。
        if (this._concurrentCount > 1) {
          this.maxPieceSize = 32 * 1024 * 1024;   // 16MB → 32MB
          this.minPieceSize = 2 * 1024 * 1024;    // 1MB → 2MB
        }
      }
      this._registered = true;
    } catch {}
  }

  async unregisterDownload() {
    if (!this._registered) return;
    this._registered = false;
    try {
      await chrome.runtime.sendMessage({
        type: 'unregister-download',
        downloadId: this.downloadId,
      });
    } catch {}
  }

  // ============================================================
  // 主流程
  // ============================================================
  async start() {
    // P1-D 防御：start() 入口复位 destroy()/pause() 残留状态。
    // destroy() 会置 aborted=true + _ensureCleanup() 把 url/referer 擦成 null，
    // 旧复用路径（destroy→start）必在 URL 校验一步再失败。正常重试已由
    // download.js 重建实例，此处复位是双保险。
    this.aborted = false;
    this.paused = false;
    this._writeError = null;

    if (!validateDownloadUrl(this.url)) {
      this.onError(new Error('URL 不合法：仅支持 http/https 协议，禁止本地地址'));
      this.setStatus('error');
      return;
    }

    try {
      this.setStatus('preparing');

      // 注册到下载注册表，获取自适应连接数
      await this.registerDownload();

      // 关键修复：任何模式都应用 DNR 放行规则（不再限 force 模式）。
      // 普通模式下大站直链同样被 CORS 拦截 —— 规则统一提供响应头 CORS
      // 覆盖；referer 存在时顺带注入 Referer/Origin 绕过防盗链。
      await this.applyForceHeaders();

      await this.initOPFS();

      // 关键修复：无论是否已知文件大小都必须探测。
      // 旧版已知大小时直接假定 supportsRange=true —— 若服务器实际忽略
      // Range，每个分段请求都会返回完整 200 并按分段偏移写盘，
      // 多份完整文件互相覆盖 → 文件必然损坏（"名称对但无法播放"的根因）。
      // 探测同时读取首 16 字节做内容校验（字体/HTML/JSON 伪装拦截）。
      // v4.2.1：独立状态让准备阶段可见进展（服务器慢时用户不再面对
      // 一动不动的"准备中"）
      this.setStatus('probing');
      const info = await this.probeFile();
      if (info.totalSize) this.totalSize = info.totalSize;
      this.supportsRange = info.supportsRange;

      this.lastTickTime = Date.now();
      this.lastTickBytes = 0;
      this.setStatus('downloading');
      this.startSpeedMonitor();

      try {
        if (this.supportsRange && this.totalSize > 0) {
          this.initPieces();
          await this.runConnections();
        } else {
          await this.downloadSingleStream(info.reuseBody);
        }
      } catch (err) {
        // 分段中途发现服务器忽略 Range（少见但真实存在）：转单流重下
        if (err?.name === 'NoRangeError' && !this._singleStreamFallback) {
          this._singleStreamFallback = true;
          await this.resetForSingleStream();
          await this.downloadSingleStream();
        } else {
          throw err;
        }
      }

      if (this.paused || this.aborted) {
        this.setStatus('paused');
        return;
      }

      this.setStatus('merging');
      const file = await this.finalizeFile();
      this.totalSize = file.size;

      await this.saveFile(file);
      await this._ensureCleanup();
      this.stopSpeedMonitor();
      this.setStatus('done');
      this.onComplete({ fileName: this.fileName, totalSize: this.totalSize });
    } catch (err) {
      this.stopSpeedMonitor();
      await this._ensureCleanup();
      await this.removeForceHeaders();
      if (this.paused) { this.setStatus('paused'); return; }
      this.setStatus('error');
      this.onError(err);
    }
  }

  // 隐私保证：无论成功/失败/崩溃，OPFS 临时文件必须清除 + 注销下载注册 + 擦除敏感字段
  async _ensureCleanup() {
    if (this._cleanupDone) return;
    this._cleanupDone = true;
    await this.unregisterDownload();
    await this.removeOPFSFile();
    // 擦除内存中的敏感字段
    this.url = null;
    this.referer = null;
    this._forceRuleId = null;
  }

  // ============================================================
  // 探测：Range 支持、文件大小、真实内容格式（三合一）
  // v4.3.15 直连优先：DNR 规则已在 start() 应用（注入 Referer/Cookie + ACAO），
  // 下载页直连探测零 SW 往返；被 CORS/防盗链拦截（TypeError/401/403）再切 SW 代理。
  // ============================================================
  async probeFile() {
    const canProxy = typeof chrome !== 'undefined' && chrome.runtime?.sendMessage;

    // v4.3.15：直连探测优先（与分段抓取同前提：DNR 规则已生效注入 ACAO）
    if (this._useDirect && this._forceRuleApplied && canProxy) {
      try {
        return await this._probeDirect();
      } catch (e) {
        if (this.paused || this.aborted || e?.name === 'ContentError') throw e;
        if (e instanceof TypeError || this._isAuthBlocked(e)) {
          // 直连被 CORS/网络拦截或需 Cookie/签名（401/403）→ 切 SW 代理
          this._useProxy = true;
        } else {
          throw e;
        }
      }
    }

    // SW 代理探测（payload 仅首 16 字节，无大二进制传递压力）
    if (this._useProxy && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const resp = await Promise.race([
          sendBgMessage({ type: 'proxy-probe', url: this.url }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('探测超时')), PROBE_RACE_TIMEOUT_MS)),
        ]);
        if (resp?.error) throw new Error(resp.error);

        const firstBytes = new Uint8Array(resp.firstBytes || []);
        this._validateMagic(firstBytes);

        if (resp.supportsRange) {
          return {
            totalSize: resp.totalSize || this.totalSize,
            supportsRange: true,
          };
        }
        // 不支持 Range → 单流模式；SW 探测已消费 body，后续需重新 fetch
        return {
          totalSize: resp.totalSize || this.totalSize,
          supportsRange: false,
          reuseBody: null,
        };
      } catch (e) {
        if (this.paused || this.aborted || e?.name === 'ContentError') throw e;
        // 代理探测失败 → 转直连重试
        this._useProxy = false;
        return this._probeDirect();
      }
    }

    return this._probeDirect();
  }

  // 直连探测：fetch 自身不受 CORS 预检影响（Range 为安全头），
  // 响应头 ACAO/Content-Range 由 DNR 注入，故可读到 totalSize 与首字节。
  async _probeDirect() {
    try {
      const resp = await this.fetchWithMode(this.url, {
        method: 'GET',
        headers: { Range: 'bytes=0-15' },
      }, FETCH_TIMEOUT_MS);

      if (resp.status === 206 || resp.headers.get('content-range')) {
        const buf = new Uint8Array(await resp.arrayBuffer().catch(() => new ArrayBuffer(0)));
        this._validateMagic(buf);
        const m = resp.headers.get('content-range')?.match(/bytes\s+\d+-\d+\/(\d+)/i);
        return {
          totalSize: m ? parseInt(m[1]) : this.totalSize,
          supportsRange: true,
        };
      }

      if (resp.ok && resp.body) {
        const [main, peek] = resp.body.tee();
        const reader = peek.getReader();
        const { value } = await reader.read();
        try { await reader.cancel(); } catch {}
        this._validateMagic(value);
        const len = resp.headers.get('content-length');
        return {
          totalSize: len ? parseInt(len) : this.totalSize,
          supportsRange: false,
          reuseBody: main,
        };
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      if (this.paused || this.aborted || e?.name === 'ContentError') throw e;
      if (e instanceof TypeError) throw e;   // 交由上层切 SW 代理
      // 非网络错误的 Range 失败 → 无 Range 重试（服务器可能不支持 Range）
      const resp = await this.fetchWithMode(this.url, {}, FETCH_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const [main, peek] = resp.body.tee();
      const reader = peek.getReader();
      const { value } = await reader.read();
      try { await reader.cancel(); } catch {}
      this._validateMagic(value);
      const len = resp.headers.get('content-length');
      return {
        totalSize: len ? parseInt(len) : this.totalSize,
        supportsRange: false,
        reuseBody: main,
      };
    }
  }

  // ============================================================
  // 首块内容校验：拦截伪装成视频的非视频内容（字体/HTML/JSON 等），
  // 同时识别真实容器格式用于修正扩展名。
  // 拦截场景：B站 hdslb 字体、防盗链 403 页面、伪装分片站点。
  // ============================================================
  _validateMagic(bytes) {
    if (!bytes || bytes.length < 4) return;
    const b = bytes;
    const str = (i, n) => {
      let s = '';
      for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
      return s;
    };
    const head4 = str(0, 4);

    // 已知非视频内容 → 硬拦截，绝不把垃圾存成 .mp4
    if (head4 === 'wOF2' || head4 === 'wOFF') {
      throw Object.assign(new Error('内容是字体文件（woff/woff2），不是视频，已拦截'), { name: 'ContentError' });
    }
    if (b[0] === 0x3C) { // '<'
      throw Object.assign(new Error('内容是 HTML 网页（链接可能已失效或需要登录），已拦截'), { name: 'ContentError' });
    }
    if (b[0] === 0x7B || b[0] === 0x5B) { // '{' '['
      throw Object.assign(new Error('内容是 JSON 数据（多为防盗链/错误响应），已拦截'), { name: 'ContentError' });
    }
    if (head4 === '%PDF') {
      throw Object.assign(new Error('内容是 PDF 文档，不是视频，已拦截'), { name: 'ContentError' });
    }
    if (head4 === 'GIF8' || (b[0] === 0x89 && str(1, 3) === 'PNG')) {
      throw Object.assign(new Error('内容是图片，不是视频，已拦截'), { name: 'ContentError' });
    }
    if (head4.slice(0, 2) === 'PK') {
      throw Object.assign(new Error('内容是 zip 压缩包，不是视频，已拦截'), { name: 'ContentError' });
    }

    // 已知视频容器 → 记录真实格式（保存时修正扩展名）
    if (str(4, 4) === 'ftyp') {
      const brand = str(8, 4);
      this._detectedContainer = brand.startsWith('M4A') ? 'm4a' : 'mp4';
      return;
    }
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
      this._detectedContainer = 'webm';   // EBML（webm/mkv）
      return;
    }
    if (str(0, 3) === 'FLV') { this._detectedContainer = 'flv'; return; }
    if (head4 === 'RIFF' && str(8, 4) === 'AVI ') { this._detectedContainer = 'avi'; return; }
    if (head4 === 'OggS') { this._detectedContainer = 'ogg'; return; }
    if (b[0] === 0x47) { this._detectedContainer = 'ts'; return; }
    // 未知格式：放行（不误伤小众容器），保存时不改扩展名
  }

  // fetch + 超时控制：无数据超过 timeout 即断开，防连接悬挂
  // 关键修复 v2.2：优先使用 SW 代理请求（绕过 CORS 预检）。
  // 下载页（chrome-extension://）发起带 Range 头的 fetch 触发 OPTIONS 预检，
  // 大站 CDN 对 OPTIONS 返回 403/405 → 预检失败 → 浏览器拦截请求。
  // SW 拥有 <all_urls> 主机权限，其 fetch 完全不受 CORS 约束。
  fetchWithMode(url, opts = {}, timeout = FETCH_TIMEOUT_MS) {
    // 优先走 SW 代理（解决大站 CORS 预检失败）
    if (this._useProxy && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      return this._proxyFetch(url, opts, timeout);
    }
    // 降级：直接 fetch（小站点或不支持 SW 代理时）
    const controller = new AbortController();
    // v4.2.10：带 reason 的超时中断。Chrome 不带 reason 的 abort() 拒绝原因是
    // "signal is aborted without reason"（AbortError DOMException），上抛到
    // 下载页会原样显示给用户。abort(reason) 让 fetch 以该 Error 拒绝。
    // 注意：reason 不用 AbortError 名字 —— connectionWorker 把 AbortError
    // 视为"用户暂停"信号（静默跳出循环不重试），超时必须走重试+退避路径。
    const timer = setTimeout(() => {
      controller.abort(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）——服务器无响应`));
    }, timeout);
    const init = {
      mode: 'cors',
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
      ...opts,
    };
    return fetch(url, init).finally(() => clearTimeout(timer));
  }

  // SW 代理请求：通过消息传递让 SW 执行实际 HTTP 请求（绕过 CORS）
  async _proxyFetch(url, opts = {}, timeout = FETCH_TIMEOUT_MS) {
    const hasRange = opts.headers?.Range;
    if (hasRange) {
      // 分段请求：解析 Range 头，让 SW 代理抓取指定字节范围
      const m = opts.headers.Range.match(/bytes=(\d+)-(\d+)/);
      if (m) {
        const resp = await Promise.race([
          sendBgMessage({
            type: 'proxy-fetch-segment',
            url,
            rangeStart: parseInt(m[1]),
            rangeEnd: parseInt(m[2]),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`代理分段请求超时（${Math.round(timeout / 1000)} 秒）——SW 无响应`)), timeout)),
        ]);
        if (resp?.error) throw new Error(resp.error);
        // 构造兼容的响应对象（兼容原有解析逻辑）
        return {
          status: resp.status,
          ok: resp.status >= 200 && resp.status < 300,
          headers: {
            get: (name) => {
              if (name.toLowerCase() === 'content-range' && resp.actualStart !== null) {
                return `bytes ${resp.actualStart}-${resp.actualStart + (resp.data?.byteLength || 0) - 1}/${resp.totalSize || '*'}`;
              }
              if (name.toLowerCase() === 'content-length') return String(resp.data?.byteLength || 0);
              return null;
            },
          },
          body: null,
          arrayBuffer: async () => resp.data,
          // 模拟 ReadableStream（单分段场景）
          getReader: () => {
            let consumed = false;
            return {
              read: async () => {
                if (consumed) return { done: true, value: undefined };
                consumed = true;
                return { done: false, value: new Uint8Array(resp.data) };
              },
              cancel: async () => {},
            };
          },
        };
      }
    }
    // 无 Range 头：探测请求或单流请求
    const resp = await Promise.race([
      sendBgMessage({
        type: 'proxy-probe',
        url,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`代理探测请求超时（${Math.round(timeout / 1000)} 秒）——SW 无响应`)), timeout)),
    ]);
    if (resp?.error) throw new Error(resp.error);
    const firstBytes = new Uint8Array(resp.firstBytes || []);
    return {
      status: resp.status || 200,
      ok: true,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'content-range' && resp.totalSize) {
            return `bytes 0-${(firstBytes.byteLength || 1) - 1}/${resp.totalSize}`;
          }
          if (name.toLowerCase() === 'content-length') return String(resp.totalSize || firstBytes.byteLength || 0);
          return null;
        },
      },
      body: null,
      arrayBuffer: async () => firstBytes.buffer,
      getReader: () => {
        let consumed = false;
        return {
          read: async () => {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: firstBytes };
          },
          cancel: async () => {},
        };
      },
    };
  }

  // ============================================================
  // aria2 核心：动态分段
  // ============================================================
  initPieces() {
    this.pieces = [];
    // 分段大小：让分段数 ≈ 连接数 × 3（保证调度粒度足够细，又不至于过多），
    // v4.2.7：从 ×6 降到 ×3，减少 OPFS 临时文件数量。限制在 [2MB, 32MB]。
    let pieceSize = Math.ceil(this.totalSize / (this.threadCount * 3));
    pieceSize = Math.min(Math.max(pieceSize, this.minPieceSize), this.maxPieceSize);

    let offset = 0;
    let index = 0;
    while (offset < this.totalSize) {
      const end = Math.min(offset + pieceSize - 1, this.totalSize - 1);
      this.pieces.push({
        index: index++,
        start: offset,
        end,
        size: end - offset + 1,
        downloaded: 0,
        status: 'pending',   // pending | active | done
      });
      offset = end + 1;
    }
    this.cursor = 0;
  }

  // 动态领取下一个分段 —— 谁快谁多干
  allocatePiece() {
    while (this.cursor < this.pieces.length) {
      const p = this.pieces[this.cursor];
      if (p.status === 'pending') {
        p.status = 'active';
        return p;
      }
      this.cursor++;
    }
    // 游标到底后扫一遍重试失败的
    return this.pieces.find(p => p.status === 'pending') || null;
  }

  // worker 统一登记：动态增援的连接也纳入等待集合，
  // 修复旧版竞态 —— 自适应扩展 spawn 的 worker 不在 Promise.all 内，
  // 主流程提前进入 merging/finalize 导致文件被截断
  spawnWorker() {
    const p = this.connectionWorker().catch(() => {}).finally(() => {
      this.workers.delete(p);
    });
    this.workers.add(p);
    return p;
  }

  async runConnections() {
    const n = Math.min(this.threadCount, this.pieces.length);
    for (let i = 0; i < n; i++) {
      this.spawnWorker();
    }
    // 关键修复 v2.2：轮询等待所有 worker 完成，同时处理动态增援竞态。
    // 旧版竞态：当所有 worker 完成时 while 循环退出，但此时 adjustThreads
    // 新 spawn 的 worker 可能还未加入 workers 集合 → 新 worker 被“遗忘”，
    // 导致配额回流后实际并未增加并发。
    while (this.workers.size > 0) {
      await Promise.all([...this.workers]);
      // 等待现有 worker 全部完成后，检查是否还有未分配的分段
      // 如果有，说明配额增加后新 worker 未被充分调度 → 补充 spawn
      if (this.workers.size === 0 && !this.paused && !this.aborted) {
        const hasPending = this.pieces.some(p => p.status === 'pending');
        if (hasPending && this.activeConnections < this.threadCount) {
          const toSpawn = Math.min(
            this.threadCount - this.activeConnections,
            this.pieces.filter(p => p.status === 'pending').length
          );
          for (let i = 0; i < toSpawn; i++) {
            this.spawnWorker();
          }
        }
      }
    }
    await this.retryFailedPieces();
  }

  // 并发阶段反复失败的分段：串行（并发=1，避开限流）重试 3 轮。
  // 这是"文件名对但无法播放"的核心修复——旧版直接把失败分段标记为
  // done 假装完成，OPFS 中留下全 0 空洞，moov/moof 错位导致文件损坏。
  async retryFailedPieces() {
    let failed = this.pieces.filter(p => p.status === 'final-retry');
    if (!failed.length) return;

    for (let round = 1; round <= 3 && failed.length; round++) {
      if (this.paused || this.aborted) return;
      await new Promise(r => setTimeout(r, 1000 * round));
      for (const p of failed) {
        if (this.paused || this.aborted) return;
        p.status = 'active';
        p.downloaded = 0;
        try {
          await this.fetchPiece(p);
        } catch {
          p.status = 'final-retry';
        }
      }
      failed = this.pieces.filter(p => p.status === 'final-retry');
    }

    if (failed.length && !this.paused && !this.aborted) {
      throw new Error(
        `${failed.length} 个分段反复下载失败（CDN 限流或拒绝）。已中止，未生成损坏文件 —— 请稍后重试，或减少同时下载的任务数`
      );
    }
  }

  // v4.3.2 S-1：conn-realloc 握手入口。SW 在广播里带递增 quota_epoch，
  // 旧 epoch（<= _lastQuotaEpoch）视为过期重放、直接忽略；新 epoch 才应用
  // 并记住。download.js 收到 conn-realloc 时调用本方法（替代直接调
  // adjustThreads），保留对旧 SW（无 epoch 字段）的向后兼容：epoch 缺失
  // 视为 0，仅当本任务此前也没见过 epoch 时才放过一次（避免 SW 升级
  // 灰度期间旧 SW 的无 epoch 广播被永久丢弃）。
  // 若检测到疑似失步（配额意外掉到 0 且无下游主动释放），主动向 SW
  // 发 conn-realloc-resync 请求重新对齐——这是「引擎侧自愈」入口，
  // SW 侧的 resync 处理器由 SW agent 实现（不在本文件范围）。
  handleConnRealloc(payload = {}) {
    const epoch = (payload.quota_epoch != null) ? Number(payload.quota_epoch) : null;
    // epoch 校验：缺失（旧 SW）放行一次；存在且 <= 已见 → 丢弃
    if (epoch != null) {
      if (epoch <= this._lastQuotaEpoch) {
        return;
      }
      this._lastQuotaEpoch = epoch;
    } else if (this._lastQuotaEpoch !== 0) {
      // 已见过 epoch 的引擎不再接受无 epoch 的旧格式广播（防回退重放）
      return;
    }
    const myQuota = (payload.allocations && this.downloadId && payload.allocations[this.downloadId] != null)
      ? payload.allocations[this.downloadId]
      : payload.threadCount;
    if (myQuota == null) return;
    this.adjustThreads(myQuota);
    // 失步自愈：配额意外掉到 0 且本任务既未暂停也非自然完成 → 疑似 SW
    // 状态错乱，主动请求 resync。SW 侧收到 conn-realloc-resync 后应重新
    // 广播当前配额（带更新 epoch）。
    if (myQuota === 0 && !this.paused && !this.aborted && this.status === 'downloading') {
      try {
        chrome.runtime.sendMessage({ type: 'conn-realloc-resync', downloadId: this.downloadId }).catch?.(() => {});
      } catch {}
    }
  }

  // 动态线程再分配（多任务公平调度）：SW 广播新配额时调用
  // v4.2.7：用户设定值作为硬上限，SW 分配不得超过用户选择
  adjustThreads(n) {
    const target = Math.max(1, Math.min(this._userThreadCount, this.maxThreads, n || this.threadCount));
    if (target === this.threadCount) return;
    const delta = target - this.threadCount;
    this.threadCount = target;
    if (delta > 0 && !this.paused && !this.aborted && this.status === 'downloading') {
      for (let i = 0; i < delta; i++) {
        this.spawnWorker();
      }
    }
    // 收缩方向：connectionWorker 在分段边界检测超员自动退出，无需强制中止
  }

  async connectionWorker() {
    this.activeConnections++;
    while (!this.paused && !this.aborted) {
      // 线程配额收缩（其他任务加入时的公平再分配）：超员 worker 退出。
      // 退出前先递减计数（同步块，无竞争），确保恰好退出多余的 worker，
      // 而不是全部同时看到超员一起退出导致任务停摆
      if (this.activeConnections > this.threadCount) {
        this.activeConnections--;
        return;
      }

      const piece = this.allocatePiece();
      if (!piece) break;

      const errCount = this.pieceErrors.get(piece.index) || 0;
      if (errCount >= 5) {
        // 关键修复：不再假装完成（旧版标记 done 但数据没写入 → OPFS 空洞
        // → 文件损坏）。标记 final-retry，由 retryFailedPieces 串行兜底，
        // 仍失败则整体报错。
        piece.status = 'final-retry';
        continue;
      }
      try {
        await this.fetchPiece(piece);
      } catch (err) {
        if (err.name === 'AbortError' || this.paused) {
          piece.status = 'pending';
          piece.downloaded = 0;
          break;
        }
        this.pieceErrors.set(piece.index, errCount + 1);
        piece.status = 'pending';
        piece.downloaded = 0;
        // 指数退避 + 抖动（避免多连接同时重试导致惊群）
        // v4.3.2 O-4：收敛到 _exponentialBackoff 共享助手（与 stream-downloader 同口径）
        await new Promise(r => setTimeout(r, _exponentialBackoff(errCount)));
      }
    }
    this.activeConnections--;
  }

  async fetchPiece(piece) {
    const canProxy = typeof chrome !== 'undefined' && chrome.runtime?.sendMessage;

    // v4.3.15 直连优先（单缓冲：网络 → 流式写目标 OPFS 一次，速度贴近原生）。
    // 前提 _forceRuleApplied：DNR 规则已注入 Referer/Cookie 反防盗链 + ACAO
    // 响应头放行 CORS，使扩展页直连 fetch 分段可行。直连失败（CORS/网络/
    // 401/403）连续 3 次才整体回退 SW 代理（双缓冲三重 I/O，仍可用）；
    // 其余错误（HTTP 4xx/5xx、短读、NoRange、暂停）与代理机制无关，按原
    // 重试逻辑抛出。生死线：直连目标仍是视频源服务器本身，零新增端点。
    if (this._useDirect && this._forceRuleApplied && canProxy) {
      try {
        const result = await this._directFetchPiece(piece);
        this._directFailCount = 0;
        return result;
      } catch (e) {
        if (this.paused || this.aborted) throw e;
        if (e?.name === 'NoRangeError' || e?.name === 'AbortError') throw e;
        if (e instanceof TypeError || this._isAuthBlocked(e)) {
          this._directFailCount = (this._directFailCount || 0) + 1;
          if (this._directFailCount >= 3) {
            this._useDirect = false;
            console.warn('[VideoSniffer] 分段直连连续失败，本任务剩余分段转 SW 代理');
          } else {
            console.warn('[VideoSniffer] 分段直连失败，本分段转代理重试:', e?.message || e);
          }
          return this._proxyFetchPiece(piece); // 本分段立即代理重试（不等第 3 次失败）
        }
        throw e;
      }
    }

    // SW 代理路径（v4.2.6 OPFS 手递手）：直连被回退、DNR 未生效或无代理能力时。
    // 代理可注入嗅探到的 Cookie/Referer 反防盗链，且不受 CORS 预检限制，大小站通吃。
    if (this._useProxy && canProxy) {
      return this._proxyFetchPiece(piece);
    }
    // 降级：直连（代理被禁用时）
    if (!this._useProxy && canProxy) {
      try {
        return await this._directFetchPiece(piece);
      } catch (e) {
        if (this.paused || this.aborted) throw e;
        if (this._isAuthBlocked(e)) {
          return this._proxyFetchPiece(piece); // 单段代理重试
        }
        throw e;
      }
    }
    return this._directFetchPiece(piece);
  }

  // 401/403 直连被拒（多为防盗链需 Cookie/签名，SW 代理可注入嗅探到的 Cookie 重试）
  _isAuthBlocked(e) {
    if (e instanceof TypeError) return true;   // CORS/网络
    if (e?.message && /^HTTP\s+(401|403)\b/i.test(e.message)) return true;
    return false;
  }

  // SW 代理分段抓取：SW 流式写入 OPFS 临时文件，下载页从 OPFS 读取并写入目标文件。
  // v4.2.6 优化：不再经 sendMessage 传大 ArrayBuffer（structured clone 慢且易超限），
  // 改为 OPFS 文件手递手——SW 与下载页共享 OPFS 存储空间，零拷贝交付分段数据。
  async _proxyFetchPiece(piece) {
    // P2 进度推送：登记在途分段，SW 写盘期间的 seg-progress 消息据此路由回来
    const segReqId = `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._segInflight.set(segReqId, piece);
    SEG_REQ_ROUTES.set(segReqId, this);
    let resp;
    try {
      resp = await Promise.race([
        // P1-C：sendBgMessage 显式传 65s（默认 25s 会在 SW 写大分段时误判超时）
        sendBgMessage({
          type: 'proxy-fetch-segment',
          segReqId,
          url: this.url,
          rangeStart: piece.start,
          rangeEnd: piece.end,
        }, SEGMENT_PROXY_TIMEOUT_MS),
        new Promise((_, reject) =>
          // v4.2.10：不用 AbortError 名字 —— connectionWorker 把 AbortError
          // 当"用户暂停"静默跳出循环；代理超时应走重试+退避（5 次后
          // final-retry 兜底），否则 SW 一时繁忙会让所有 worker 相继
          // 静默退出 → 下载永久停滞且零报错。
          setTimeout(() => reject(new Error('分段代理请求超时（65 秒）——SW 繁忙或无响应，稍后自动重试')), SEGMENT_PROXY_TIMEOUT_MS)
        ),
      ]);
    } finally {
      // SW 抓取阶段结束：摘除路由。piece.downloaded 归零并由下方 OPFS 读取
      // 循环重新累计（同一份字节不能在"抓取"与"落盘"两个阶段重复计数）。
      SEG_REQ_ROUTES.delete(segReqId);
      this._segInflight.delete(segReqId);
      piece.downloaded = 0;
      let inflight = 0;
      for (const p of this._segInflight.values()) inflight += p.downloaded || 0;
      this.downloadedBytes = this.completedBytes + inflight;
      this.notifyProgressThrottled();
    }

    if (resp?.error) {
      if (resp.error.includes('200') || resp.error.includes('Range')) {
        throw Object.assign(new Error('服务器不支持 Range 分段'), { name: 'NoRangeError' });
      }
      throw new Error(resp.error);
    }

    // 服务器返回 200（忽略 Range）→ 单流回退
    if (resp.status === 200) {
      throw Object.assign(new Error('服务器不支持 Range 分段'), { name: 'NoRangeError' });
    }
    if (resp.status !== 206) {
      throw new Error(`HTTP ${resp.status}`);
    }

    // 校验偏移一致性
    if (resp.actualStart !== null && resp.actualStart !== piece.start) {
      await this._removeOpfsTemp(resp.opfsFile);
      throw new Error(`CDN 返回范围错位（请求 ${piece.start}，实际 ${resp.actualStart}），已拒绝写入`);
    }
    if (resp.totalSize && resp.totalSize !== this.totalSize) {
      this.totalSize = resp.totalSize;
    }

    // 从 OPFS 临时文件读取分段数据，写入目标文件
    // v4.3.2 S-3：改用 file.stream() 流式读取，浏览器自决分块大小
    // （通常 64KB–1MB，远小于旧的 8MB/16MB slice），峰值内存从「单分段
    // 整块驻留」降到「单流块驻留」。旧版 file.slice().arrayBuffer() 对
    // ≤16MB 分段一次性整块读、>16MB 才分 8MB——32MB 分段会让内存峰值翻倍
    // （SW OPFS 落盘 + 本页读出 + 目标 writeAt 三处同时持有大缓冲）。
    // 流式 + writeAt(position, chunk)：每读到一块就写入目标 OPFS 句柄，
    // 读完后立即释放该块引用，不再累积到 parts 数组。
    let pieceBytes = 0;

    if (resp.opfsFile && this._useOPFS) {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
        const fh = await dir.getFileHandle(resp.opfsFile);
        const file = await fh.getFile();
        const total = resp.byteLength || file.size;
        // file.stream() 返回 ReadableStream，分块由底层决定（天然 ≤8MB）
        const reader = file.stream().getReader();
        try {
          while (true) {
            if (this.paused || this.aborted) {
              try { await reader.cancel(); } catch {}
              throw Object.assign(new Error('paused'), { name: 'AbortError' });
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            // 精确截断到分段边界（尾段时流可能多读越界字节）
            const remaining = piece.size - pieceBytes;
            const toWrite = value.byteLength > remaining ? value.slice(0, remaining) : value;
            if (toWrite.byteLength === 0) {
              // 已达分段边界，多余字节丢弃（若 reader 还在产出则提前关闭）
              try { await reader.cancel(); } catch {}
              break;
            }
            await this.writeAt(piece.start + pieceBytes, toWrite);
            pieceBytes += toWrite.byteLength;
            this.downloadedBytes += toWrite.byteLength;
            piece.downloaded = pieceBytes;
            this.notifyProgressThrottled();
            if (pieceBytes >= piece.size) {
              try { await reader.cancel(); } catch {}
              break;
            }
            if (pieceBytes >= total) {
              try { await reader.cancel(); } catch {}
              break;
            }
          }
        } finally {
          try { await reader.cancel(); } catch {}
        }
      } finally {
        await this._removeOpfsTemp(resp.opfsFile);
      }
    } else {
      // 降级：OPFS 不可用时仍走旧路径（data 字段可能不存在，这里做兜底）
      // 若 SW 返回了 opfsFile 但本地 OPFS 不可用（极少见），只能报错
      if (resp.opfsFile && !this._useOPFS) {
        throw new Error('OPFS 不可用，无法读取代理分段');
      }
      const data = new Uint8Array(resp.data || new ArrayBuffer(0));
      const chunk = data.byteLength > piece.size ? data.slice(0, piece.size) : data;
      await this.writeAt(piece.start, chunk);
      pieceBytes = chunk.byteLength;
      this.downloadedBytes += chunk.byteLength;
    }

    // P1-B 分段长度校验：中间分段（非文件尾）必须足额 —— pieceBytes < piece.size
    // 意味着 CDN 截断/SW 落盘少写，直接把"半截数据"标 done 会在文件中留下
    // 空洞（moov/moof 错位 → "文件名对但无法播放"）。抛错交由
    // connectionWorker 的指数退避 + retryFailedPieces 串行兜底，不静默。
    // 只有最后一段（piece.end >= totalSize-1）允许短读：服务器真实长度
    // 可能小于估算，由 finalizeFile 的 file.size 定稿。
    const isTailPiece = piece.end >= (this.totalSize - 1);
    if (!isTailPiece && pieceBytes < piece.size) {
      throw new Error(`分段短读 (${pieceBytes}/${piece.size} @ ${piece.start})，已拒绝写入`);
    }

    piece.status = 'done';
    this.completedBytes += pieceBytes;
    this.downloadedBytes = this.completedBytes;
    this.notifyProgressThrottled();
  }

  // P2 进度推送：SW 代理分段抓取期间的字节进度（每 512KB 一条消息）。
  // 口径：downloadedBytes = completedBytes + Σ在途分段 downloaded —— 多线程
  // 并发时 O(n) 重算（n ≤ maxThreads），杜绝乱序完成导致的累计漂移。
  _onSegProgress(segReqId, written) {
    if (this.paused || this.aborted) return;
    const piece = this._segInflight.get(segReqId);
    if (!piece) return;
    const w = Math.min(Math.max(written | 0, 0), piece.size);
    if (w <= (piece.downloaded || 0)) return;
    piece.downloaded = w;
    let inflight = 0;
    for (const p of this._segInflight.values()) inflight += p.downloaded || 0;
    this.downloadedBytes = this.completedBytes + inflight;
    this.notifyProgressThrottled();
  }

  // 清理 SW 代理留下的 OPFS 临时分段文件
  async _removeOpfsTemp(name) {
    if (!name || !this._useOPFS) return;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
      await dir.removeEntry(name);
    } catch {}
  }

  // 直接 fetch 分段抓取（降级路径）
  async _directFetchPiece(piece) {
    const controller = new AbortController();
    let lastDataTime = Date.now();

    let stallTimer = null;
    const checkStall = () => {
      if (Date.now() - lastDataTime > STALL_TIMEOUT_MS) {
        // v4.2.10：带 reason 且不用 AbortError 名字（connectionWorker 将
        // AbortError 视为用户暂停会静默跳出——超时必须走重试+退避）
        controller.abort(new Error(`分段下载停滞（${STALL_TIMEOUT_MS / 1000} 秒无新数据，服务器中断响应）`));
        return;
      }
      stallTimer = setTimeout(checkStall, 5000);
    };
    stallTimer = setTimeout(checkStall, 5000);

    const fetchTimer = setTimeout(() => {
      controller.abort(new Error(`分段下载超时（${FETCH_TIMEOUT_MS / 1000} 秒）`));
    }, FETCH_TIMEOUT_MS);

    const resp = await fetch(this.url, {
      method: 'GET',
      mode: 'cors',
      redirect: 'follow',
      credentials: 'omit',
      headers: { Range: `bytes=${piece.start}-${piece.end}` },
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(fetchTimer);
      clearTimeout(stallTimer);
    });

    if (resp.status === 200) {
      try { await resp.body?.cancel(); } catch {}
      throw Object.assign(new Error('服务器不支持 Range 分段'), { name: 'NoRangeError' });
    }
    if (resp.status !== 206) {
      try { await resp.arrayBuffer(); } catch {}
      throw new Error(`HTTP ${resp.status}`);
    }

    const crHeader = resp.headers.get('content-range');
    if (crHeader) {
      const m = crHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
      if (m) {
        const actualStart = parseInt(m[1]);
        if (actualStart !== piece.start) {
          try { await resp.body?.cancel(); } catch {}
          throw new Error(`CDN 返回范围错位（请求 ${piece.start}，实际 ${actualStart}），已拒绝写入`);
        }
        const total = parseInt(m[3]);
        if (total && total !== this.totalSize) this.totalSize = total;
      }
    }

    const reader = resp.body.getReader();
    let fileOffset = piece.start;
    let pieceBytes = 0;
    let remaining = piece.size;

    try {
      while (true) {
        if (this.paused || this.aborted) {
          try { reader.cancel(); } catch {}
          throw Object.assign(new Error('paused'), { name: 'AbortError' });
        }
        if (remaining <= 0) {
          try { reader.cancel(); } catch {}
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        lastDataTime = Date.now();

        const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;

        await this.writeAt(fileOffset, chunk);
        fileOffset += chunk.byteLength;
        pieceBytes += chunk.byteLength;
        remaining -= chunk.byteLength;
        piece.downloaded = pieceBytes;
        this.downloadedBytes += chunk.byteLength;

        this.notifyProgressThrottled();
      }
    } finally {
      clearTimeout(stallTimer);
      try { reader.cancel(); } catch {}
    }

    if (pieceBytes < piece.size) {
      // P1-B 与代理路径同口径收紧：只有"最后一段"允许短读（服务器真实长度
      // 小于估算时由 finalizeFile 的 file.size 定稿）。中间分段必须
      // pieceBytes > 0 且为尾段才容忍 —— 旧版 `pieceBytes > 0 ||` 让中间段
      // 拿到半截数据也算"完成"，文件中留下空洞（moov/moof 错位 →
      // "文件名对但无法播放"）。半截中间段在此抛错 → connectionWorker
      // 指数退避重试 / retryFailedPieces 串行兜底，绝不静默。
      //
      // 注意：只容忍"服务器给得比请求边界少"，绝不接受 actualStart 偏移
      // 错位（CDN 返回错误区间 = 损坏源，已在上面拒绝写入）。
      const fillsTailOrComplete = pieceBytes > 0 && piece.end >= (this.totalSize - 1);
      if (!fillsTailOrComplete) {
        throw new Error(`分段无数据/短读 (${pieceBytes}/${piece.size})`);
      }
    }

    piece.status = 'done';
    this.completedBytes += pieceBytes;
    this.downloadedBytes = this.completedBytes;
    this.notifyProgressThrottled();
  }

  // ============================================================
  // 单流下载（服务器不支持 Range 时）
  // source：probe 返回的 body 流（复用已建立的连接）/ Response 对象 / 无参（重新 fetch）
  // ============================================================
  // v4.3.15：直连全量抓取（单流模式）。DNR 已注入 ACAO/Referer/Cookie 时，
  // 扩展页直连 fetch 为单缓冲，避免 SW proxy-fetch-full 的 OPFS 双写。
  async _directFetchFull() {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）——服务器无响应`));
    }, FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(this.url, {
        mode: 'cors',
        redirect: 'follow',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!resp.ok) {
        try { await resp.body?.cancel(); } catch {}
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadSingleStream(source) {
    // v4.3.15 直连优先单流：DNR 规则已生效时先试直连；被 CORS/防盗链拦截
    // （TypeError/401/403）再回落下方 SW 代理路径（保留不动，叠加不削弱）。
    if (this._useDirect && this._forceRuleApplied && !source &&
        typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const resp = await this._directFetchFull();
        // 成功：直接进入下方公共读循环（body 非空时跳过代理块与重新 fetch）
        this._directBody = resp.body;
      } catch (e) {
        if (this.paused || this.aborted) return;
        if (e instanceof TypeError || this._isAuthBlocked(e)) {
          this._useDirect = false;
          console.warn('[VideoSniffer] 单流直连被拦，转 SW 代理:', e?.message || e);
        } else {
          throw e;
        }
      }
    }

    // 关键修复 v2.2：SW 代理模式 → 让 SW 直接抓取完整文件写入 OPFS
    if (this._useProxy && !this._directBody && !source && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const resp = await sendBgMessage({
          type: 'proxy-fetch-full',
          url: this.url,
        });
        if (resp?.error) throw new Error(resp.error);
        if (resp?.success) {
          // SW 已写入 OPFS，从 OPFS 读取并复制到本地 OPFS
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
          const srcHandle = await dir.getFileHandle(resp.opfsFileName);
          const srcFile = await srcHandle.getFile();
          this.totalSize = srcFile.size;
          // 分块复制到本地 OPFS 文件（避免一次性加载到内存）
          const CHUNK = 4 * 1024 * 1024; // 4MB
          let offset = 0;
          while (offset < srcFile.size) {
            if (this.paused || this.aborted) return;
            const end = Math.min(offset + CHUNK, srcFile.size);
            const chunk = await srcFile.slice(offset, end).arrayBuffer();
            await this.writeAt(offset, new Uint8Array(chunk));
            offset = end;
            this.downloadedBytes = offset;
            this.notifyProgressThrottled();
          }
          // 清理 SW 代理临时文件
          try { await dir.removeEntry(resp.opfsFileName); } catch {}
          return;
        }
      } catch (e) {
        if (this.paused || this.aborted) return;
        // 代理失败 → 降级到直接 fetch
        this._useProxy = false;
      }
    }

    let body = null;
    if (this._directBody) {
      // v4.3.15：直连单流已抓到响应体（跳过代理与重新 fetch）
      body = this._directBody;
      this._directBody = null;
    } else if (source instanceof ReadableStream) {
      body = source;
    } else if (source?.body instanceof ReadableStream) {
      body = source.body;
    } else {
      const resp = await this.fetchWithMode(this.url, {}, FETCH_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      body = resp.body;
    }

    if (!body) {
      // SW 代理探测时已消费 body 且无法复用 → 重新 fetch
      const resp = await this.fetchWithMode(this.url, {}, FETCH_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      body = resp.body;
    }

    const reader = body.getReader();
    let offset = 0;
    let lastDataTime = Date.now();

    while (true) {
      if (this.paused || this.aborted) {
        try { reader.cancel(); } catch {}
        return;
      }
      if (Date.now() - lastDataTime > FETCH_TIMEOUT_MS) {
        try { reader.cancel(); } catch {}
        throw new Error('连接超时，无数据流入');
      }
      const { done, value } = await reader.read();
      if (done) break;
      lastDataTime = Date.now();
      await this.writeAt(offset, value);
      offset += value.byteLength;
      this.downloadedBytes = offset;
      this.notifyProgressThrottled();
    }
  }

  // NoRange 回退：丢弃已按分段偏移写坏的数据，重建写入器从 0 开始单流下载
  async resetForSingleStream() {
    // P2：重建写入器前清掉旧的写入错误 —— 旧 writer 的失败不应连坐新 writer
    //（新写入失败会重新写入 _writeError）
    this._writeError = null;
    this.pieces = [];
    this.cursor = 0;
    this.downloadedBytes = 0;
    this.completedBytes = 0;
    this.lastTickBytes = 0;
    this.lastTickTime = Date.now();
    // 排空写入队列（旧 writer 的遗留写入全部落盘后整体丢弃，防止串写新 writer）
    try { await this.writeQueue; } catch {}
    if (this._useOPFS && this.fileHandle) {
      try { if (this.writer) await this.writer.abort(); } catch {}
      try {
        this.writer = await this.fileHandle.createWritable({ keepExistingData: false });
      } catch {
        this._useOPFS = false;
        this._memChunks = [];
      }
    } else {
      this._memChunks = [];
    }
    this.setStatus('downloading');
  }

  // ============================================================
  // 速度监控 + 自适应连接扩展（aria2 max-connection-per-server）
  // ============================================================
  startSpeedMonitor() {
    this.speedInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTickTime) / 1000;
      if (dt <= 0) return;

      const dBytes = this.downloadedBytes - this.lastTickBytes;
      // v4.3.16：负增量钳零。downloadedBytes = completedBytes + Σ在途分段字节
      //（代理分段失败重试时会摘除在途计数 → 总量瞬时回落），若直接喂给 EMA
      // 会出现「-几 B/s」的负速度显示。负增量 ≠ 回传数据，一律按 0 处理。
      const inst = dBytes > 0 ? dBytes / dt : 0;

      // EMA 平滑（α=0.4，既灵敏又不跳动）
      this.speedEMA = this.speedEMA === 0 ? inst : this.speedEMA * 0.6 + inst * 0.4;

      this.lastTickTime = now;
      this.lastTickBytes = this.downloadedBytes;

      this.onSpeedUpdate({
        speed: this.speedEMA,
        speedFormatted: this.formatSpeed(this.speedEMA),
        eta: this.calculateETA(),
        connections: this.activeConnections,
      });

      this.notifyProgressThrottled(true);

      // 自适应扩展：带宽利用充分且还有未分配分段 → 增开连接
      // v4.2.7：扩展上限受用户设定线程数约束，不再无视用户选择一路扩到 maxThreads
      if (this.speedBoost && !this.paused) {
        const hasPending = this.pieces.some(p => p.status === 'pending');
        if (hasPending &&
            this.activeConnections < this._userThreadCount &&
            this.threadCount < this._userThreadCount &&
            inst > 2 * 1024 * 1024) {   // 单连接均值 >2MB/s 说明带宽充裕
          this.threadCount++;
          // 动态增援：统一走 spawnWorker 登记（纳入等待集合，防竞态）
          this.spawnWorker();
        }
      }
    }, 1000);
  }

  stopSpeedMonitor() {
    if (this.speedInterval) {
      clearInterval(this.speedInterval);
      this.speedInterval = null;
    }
  }

  // UI 上报节流：每 200ms 最多一次，网络循环不再被渲染拖慢
  notifyProgressThrottled(force = false) {
    const now = performance.now();
    if (!force && now - this._lastProgressNotify < 200) return;
    this._lastProgressNotify = now;

    const total = this.totalSize || this.downloadedBytes || 0;
    this.onProgress({
      progress: total > 0 ? Math.min(100, (this.downloadedBytes / total) * 100) : 0,
      downloaded: this.downloadedBytes,
      total,
      pieces: this.pieces,
      connections: this.activeConnections,
      threads: this.threadCount,
    });
  }

  calculateETA() {
    if (this.speedEMA <= 0 || this.totalSize <= 0) return '--:--';
    const remaining = Math.max(0, this.totalSize - this.downloadedBytes);
    return this.formatTime(remaining / this.speedEMA);
  }

  // ============================================================
  // 强力下载：declarativeNetRequest 注入 Referer/Origin（fetch 无法直接设置这些头）
  // + 响应头 CORS 覆盖（B站/腾讯/爱奇艺等大站 CDN 不返回 ACAO，需要 DNR 放行）
  // ============================================================
  async applyForceHeaders() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    try {
      const resp = await sendBgMessage({
        type: 'apply-force-rule',
        url: this.url,
        referer: this.referer || null,
      });
      if (resp?.applied) {
        this._forceRuleApplied = true;
        this._forceRuleId = resp.ruleId;  // 保存本次下载的独立规则 ID
      }
    } catch {}
  }

  async removeForceHeaders() {
    if (!this._forceRuleApplied) return;
    try {
      await chrome.runtime.sendMessage({
        type: 'remove-force-rule',
        ruleId: this._forceRuleId,  // 仅移除自己的规则，不影响其他下载
      });
    } catch {}
    this._forceRuleApplied = false;
    this._forceRuleId = null;
  }

  // ============================================================
  // 暂停 / 继续
  // ============================================================
  pause() {
    this.paused = true;
    this.setStatus('paused');
    this.stopSpeedMonitor();
  }

  async resume() {
    if (!this.paused) return;
    this.paused = false;
    this._cleanupDone = false;
    // P2：恢复下载时清掉暂停前的写入错误（写入失败后暂停再继续，应重新尝试
    // 而不是在 finalize 一步直接判死）
    this._writeError = null;
    this.setStatus('downloading');

    // 重置未完成分段
    for (const p of this.pieces) {
      if (p.status === 'active') { p.status = 'pending'; p.downloaded = 0; }
    }
    this.lastTickTime = Date.now();
    this.lastTickBytes = this.downloadedBytes;
    this.startSpeedMonitor();

    try {
      try {
        if (this.supportsRange && this.totalSize > 0) {
          await this.runConnections();
        } else {
          await this.downloadSingleStream();
        }
      } catch (err) {
        // 与 start() 一致：分段中途发现服务器忽略 Range → 转单流
        if (err?.name === 'NoRangeError' && !this._singleStreamFallback) {
          this._singleStreamFallback = true;
          await this.resetForSingleStream();
          await this.downloadSingleStream();
        } else {
          throw err;
        }
      }

      if (this.paused) { this.setStatus('paused'); return; }

      this.setStatus('merging');
      const file = await this.finalizeFile();
      this.totalSize = file.size;
      await this.saveFile(file);
      await this._ensureCleanup();
      this.stopSpeedMonitor();
      this.setStatus('done');
      this.onComplete({ fileName: this.fileName, totalSize: this.totalSize });
    } catch (err) {
      this.stopSpeedMonitor();
      await this._ensureCleanup();
      await this.removeForceHeaders();
      if (this.paused) { this.setStatus('paused'); return; }
      this.setStatus('error');
      this.onError(err);
    }
  }

  // ============================================================
  // 保存已缓存文件（暂停时）
  // ============================================================
  async saveCachedFile() {
    try {
      await this.writeQueue;
      const file = await this.fileHandle.getFile();
      await this.saveFile(file);
      return { success: true, fileName: this.fileName };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  // 保存到浏览器下载
  // ============================================================
  async saveFile(file) {
    await this.removeForceHeaders();
    // 用首块探测到的真实容器修正扩展名（m4s→mp4、伪装名→真实格式）
    if (this._detectedContainer) {
      const want = this._detectedContainer;
      if (!new RegExp(`\\.${want}$`, 'i').test(this.fileName)) {
        this.fileName = this.fileName.replace(/\.[a-z0-9]{1,5}$/i, '') + '.' + want;
        this.format = want;
      }
    } else if (/\.m4s$/i.test(this.fileName)) {
      // 未探测到容器（校验跳过）时的兜底：m4s 是 fMP4 容器
      this.fileName = this.fileName.replace(/\.m4s$/i, '') + '.mp4';
      this.format = 'mp4';
    }
    // OPFS 文件无 MIME type，显式设置正确的类型防止 Chrome 改扩展名为 .txt
    const mime = this.getMimeType();
    const blob = file.type ? file : new Blob([file], { type: mime });
    const url = URL.createObjectURL(blob);
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
      chrome.downloads.download({
        url,
        filename: this.fileName,
        saveAs: false,
        conflictAction: 'uniquify',
      }, () => {
        if (chrome.runtime.lastError) {
          this.anchorDownload(url);
        } else {
          // 下载已触发，5 秒后回收 blob URL（留给浏览器足够时间读取）
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      });
    } else {
      this.anchorDownload(url);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  getMimeType() {
    const ext = (this.format || 'mp4').toLowerCase();
    const mimes = {
      'mp4': 'video/mp4',
      'm4s': 'video/mp4',   // B站 DASH 单文件 m4s 是 fMP4 容器
      'm4a': 'audio/mp4',   // B站 DASH 音频轨
      'webm': 'video/webm',
      'mkv': 'video/x-matroska',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'flv': 'video/x-flv',
      'm4v': 'video/x-m4v',
      'ogg': 'video/ogg',
      'ts': 'video/mp2t',
      'm3u8': 'application/vnd.apple.mpegurl',
      'mpd': 'application/dash+xml',
    };
    return mimes[ext] || 'video/mp4';
  }

  anchorDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ============================================================
  // 清理
  // ============================================================
  async clearCache() {
    await this.removeOPFSFile();
    this.pieces = [];
  }

  async destroy() {
    this.aborted = true;
    this.pause();
    await this.removeForceHeaders();
    await this.clearCache();
    await this._ensureCleanup();
  }

  // ============================================================
  // 工具
  // ============================================================
  formatSpeed(b) {
    if (!b || b < 1024) return `${(b || 0).toFixed(0)} B/s`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB/s`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB/s`;
    return `${(b / 1073741824).toFixed(2)} GB/s`;
  }

  formatTime(seconds) {
    if (!seconds || seconds < 0 || !isFinite(seconds)) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  setStatus(status) {
    this.status = status;
    try { this.onStatusChange(status); } catch {}
  }
}

if (typeof window !== 'undefined') {
  window.DownloadEngine = DownloadEngine;
}
