/**
 * 视频嗅探器 - 流媒体下载器 v2.1（HLS / DASH）
 *
 * 速度核心：
 * 1. 高并发分段池：默认 12 并发、可自适应扩展到 24（HTTP/2 CDN 上效果显著）
 * 2. 乱序下载、按序落盘：完成的分片立即写入 OPFS 临时文件，
 *    不再全部驻留内存（旧版几百个 TS 分片全在内存里 → 卡顿崩溃）
 * 3. 失败分段自动重试 + 指数退避，单分段失败不影响整体
 * 4. UI 上报节流
 *
 * v2.1 加固：
 * - fetch 超时控制（AbortController 30s，防清单/分片请求悬挂）
 * - pendingBlobs 内存上限（乱序分片超过 64 个时暂停领取，防 OOM）
 * - OPFS 全路径清理（finally 保证，异常/崩溃也不残留临时文件）
 * - URL 安全校验（禁止 file:// chrome:// 等非 HTTP(S) 协议）
 * - 指数退避重试上限（单分段最多 5 次，超过跳过）
 *
 * v2.2 提效：
 * - AES-128 HLS 自动解密直下载（Web Crypto API，无需实时播放即可下载）
 *   覆盖大量"加密"流媒体（AES-128 标准加密）
 *   支持 EXT-X-KEY 内联 IV 和序号默认 IV
 * - 不支持解密的加密方式（SAMPLE-AES 等）走录制模式兜底
 */

// Node/非扩展上下文兜底（无 chrome.i18n 时返回键名）；必须用 var —— 多个经典 script 共享同一全局作用域，重复 const t 会 SyntaxError
var t = (typeof globalThis.t === 'function') ? globalThis.t : ((k) => k);

const STREAM_FETCH_TIMEOUT = 30000;
// v4.3.7：分段代理请求的宽松总上限（兜底防 SW 彻底失联时本页无限挂起）。
// SW 端 proxy-fetch-segment 已改为 30s 停滞看门狗（数据在流动就不打断），
// 慢速链路下 32MB 分片可耗时数分钟，故本页绝不能再用默认 25s 抢先判负。
const SEGMENT_PROXY_TIMEOUT = 300000;
// v4.2.9：清单（m3u8/mpd）是几 KB 的小请求，专属 15s 超时（直连与代理竞速
// 各自对齐）。旧版共用 30s——DNS 复查 12s 挂起 + 直连 30s 干等，正是
// "卡在『正在获取流清单』很久后报失败"的时长来源。
const MANIFEST_FETCH_TIMEOUT = 15000;
const MAX_PENDING_BLOBS = 64;

// v4.3.2 O-4：sendBgMessage / exponentialBackoff /
// sanitizeErrorMessage 收敛到 lib/net-helpers.js。本文件优先使用共享实现，
// 测试环境（test-ts-remux-v430.js 等用 new Function(src) 或 require 加载本
// 文件、不注入 net-helpers.js）走下方本地兜底，保持零改动可跑。生产环境
// download.html 已在 stream-downloader.js 之前注入 lib/net-helpers.js。
// v4.3.4 修复：这两个顶层名必须与 download-engine.js 区分。
// download.html 以普通 <script> 依次加载两个引擎（共享全局词法作用域），
// 若都声明顶层 const sendBgMessage / _NetHelpers，后加载者抛
// SyntaxError: Identifier has already been declared，整个文件不执行 →
// window.StreamDownloader 未定义 → "StreamDownloader is not defined"。
const _SDNetHelpers = (typeof window !== 'undefined' && window.__VideoSnifferNetHelpers__)
  || (typeof globalThis !== 'undefined' && globalThis.__VideoSnifferNetHelpers__)
  || {};
const sdSendBgMessage = _SDNetHelpers.sendBgMessage || async function sdSendBgMessage(message, timeoutMs = 25000) {
  // 本地兜底（仅测试环境命中）：与 lib/net-helpers.js 保持一致
  try {
    const wakeUp = chrome.runtime.connect({ name: 'keepalive' });
    setTimeout(() => { try { wakeUp.disconnect(); } catch {} }, 50);
  } catch {}
  const raw = await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(t('sd_sw_timeout', [timeoutMs / 1000, message?.type]))),
      timeoutMs,
    )),
  ]).catch((e) => {
    const msg = String(e?.message || e).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    console.warn('[VideoSniffer] sendBgMessage 失败:', msg, 'type=', message?.type);
    throw e;
  });
  if (raw && typeof raw === 'object' && 'success' in raw) {
    return raw.success ? (raw.data ?? {}) : { error: raw.error || t('sd_bg_failed') };
  }
  return raw;
};
const _sdSanitizeErrorMessage = _SDNetHelpers.sanitizeErrorMessage || function _sdSanitizeErrorMessage(err) {
  return String(err?.message ?? err ?? '').replace(/https?:\/\/[^\s'"]+/g, '[URL]');
};

// v4.3.8：分段代理在途进度路由（与 download-engine.js 的 SEG_REQ_ROUTES 同机制，
// 但用独立顶层名 _SD_SEG_REQ_ROUTES，避免两引擎顶层 const 重名触发
// SyntaxError——v4.3.4 R-1 的教训）。SW 在 proxy-fetch-segment 抓取+落盘期间
// 每 512KB 推 {type:'seg-progress', segReqId, written}，路由回来让 downloadedBytes
// 在 SW 抓取阶段就持续累加，速度曲线平滑，不再只在分片完成瞬间跳变（"过山车"元凶）。
const _SD_SEG_REQ_ROUTES = new Map();
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'seg-progress' || !msg.segReqId) return;
    const engine = _SD_SEG_REQ_ROUTES.get(msg.segReqId);
    if (engine && typeof engine._onSegProgress === 'function') {
      engine._onSegProgress(msg.segReqId, msg.written);
    }
  });
}

function validateStreamUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return false;
    return true;
  } catch { return false; }
}

class StreamDownloader {
  constructor(options = {}) {
    this.manifestUrl = options.url;
    this.fileName = options.fileName || 'video.mp4';
    this.format = options.format || 'm3u8';
    this.threadCount = Math.max(1, options.threadCount || 12);
    this._userThreadCount = this.threadCount;  // v4.2.7：用户设定作为硬上限
    this.maxThreads = options.maxThreads || 24;
    // 画质自选（DASH）：用户在 popup 里选的档位高度。0/缺省 = 维持原行为
    //（取最高 Representation），保证不改变既有下载结果。
    this._preferredHeight = parseInt(options.preferredHeight || '0', 10) || 0;
    this.mode = options.mode || 'normal';
    this.referer = options.referer || null;
    this.downloadId = options.downloadId || null;  // 下载唯一 ID（连接配额管理）
    this._registered = false;
    this._concurrentCount = 1;

    // 状态
    this.segments = [];
    this.initSegment = null;      // DASH fMP4 初始化段
    this.downloadedSegments = 0;
    this.failedSegments = 0;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.completedBytes = 0;      // 已完整落盘的分片字节数（不含在途）
    this._segInflight = new Map(); // segReqId -> written（SW 抓取+落盘期间的在途字节）
    this.status = 'idle';
    this.paused = false;
    this.segmentErrors = new Map();
    this.activeWorkers = 0;
    this.isFMP4 = false;          // 分片是 fMP4（m4s / .mp4）
    this._remuxedToMp4 = false;   // v4.3.0：TS 已成功转封装为 MP4（决定最终扩展名）
    this._formatConfirmed = false; // 是否已通过 magic bytes 确认真实容器格式
    this.workers = new Set();     // 活跃 worker Promise 集合（含动态增援的）
    this._queue = [];             // 待下载分片队列（实例化，供动态增援 worker 取段）
    this._queueCursor = 0;
    this._generation = 0;         // v4.3.7：每次 start() 自增；worker 据此识别自身是否过期

    // 速度
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
    this.flushIndex = 0;          // 下一个待顺序落盘的分片号
    this.pendingBlobs = new Map(); // index -> Blob（乱序完成的分片暂存）
    this._inflight = new Set();   // 正在下载的分片号（P1-E 队头救援防双下）
    this._headSpin = 0;           // 内存闸门自旋计数（P1-E 死锁检测）

    // AES-128 加密
    this.encryption = null;       // { method, keyUri, iv } 或 null
    this.cryptoKey = null;        // 已导入的 CryptoKey
    this._keyCache = new Map();   // keyUri -> CryptoKey（多密钥场景）

    this._lastProgressNotify = 0;
    this._cleanupDone = false;
    this._writeError = null;          // 首次写入错误（finalize 时硬失败）

    // 强力下载 DNR 规则
    this._forceRuleApplied = false;
    this._forceRuleId = null;
    this._useProxy = true;                       // 关键修复 v2.2：默认启用 SW 代理（绕过 CORS）
    this._useDirect = true;                      // v4.3.13：直连优先（单缓冲，速度贴近原生下载器）
    this._directFailCount = 0;                   // 直连连续失败计数（≥3 回退代理）
  }

  // ============================================================
  // OPFS（不可用时降级到内存模式）
  // ============================================================
  _useOPFS = true;

  async initOPFS() {
    if (!navigator.storage?.getDirectory) {
      this._useOPFS = false;
      this._memChunks = [];
      return;
    }
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('vs-downloads', { create: true });
      const safe = this.fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      this.fileHandle = await dir.getFileHandle(`stream_${Date.now()}_${safe}`, { create: true });
      this.writer = await this.fileHandle.createWritable({ keepExistingData: false });
    } catch {
      this._useOPFS = false;
      this._memChunks = [];
    }
  }

  writeSequential(blob) {
    if (!this._useOPFS) {
      this._memChunks = this._memChunks || [];
      this._memChunks.push(blob);
      return Promise.resolve();
    }
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.writer) return;
      await this.writer.write(blob);
    }).catch((e) => {
      // 关键修复：写入失败绝不能静默吞掉（旧版 .catch(()=>{}) 让 writeQueue
      // 永远 resolve，finalize 恒成功 → 产出坏文件却无任何报错）。记录首次
      // 错误，finalize 时硬失败。
      this._writeError = this._writeError || new Error(t('sd_write_failed', [e?.message || e]));
    });
    return this.writeQueue;
  }

  async finalizeFile() {
    // P2 顺序修复（对齐 download-engine.js:200-201）：先排空写入队列、再检查
    // 写入错误。旧版先查 _writeError —— 最后一次 writeSequential 的失败要等
    // writeQueue 链真正执行后才写入 _writeError，立即检查会漏掉"最后一笔失败"
    // → 产出损坏文件却上报成功。
    await this.writeQueue;
    if (this._writeError) throw this._writeError;
    if (!this._useOPFS) {
      const mime = this.isFMP4 ? 'video/mp4' : 'video/mp2t';
      const blob = new Blob(this._memChunks || [], { type: mime });
      this._memChunks = [];
      return blob;
    }
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
    return await this.fileHandle.getFile();
  }

  async removeOPFSFile() {
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
      const resp = await sdSendBgMessage({
        type: 'register-download',
        downloadId: this.downloadId,
        maxThreads: this.maxThreads,
        url: this.manifestUrl,
        userThreadCount: this._userThreadCount,
      });
      if (resp?.threadCount) {
        // v4.2.7：用户设定值作为硬上限
        this.threadCount = Math.max(1, Math.min(this._userThreadCount, this.maxThreads, resp.threadCount));
        this._concurrentCount = resp.concurrentCount || 1;
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
    // P1-D 防御 + v4.3.7 修复：start() 入口必须复位所有"按次累计"的运行态。
    // download.js 的重试路径（1582-1590）实际是「同实例 destroy().then(start())」，
    // 并非注释里说的"新建实例"。start() 此前只重置 paused/aborted/proxy 标志，
    // 遗漏了 downloadedSegments / failedSegments / segmentErrors / downloadedBytes /
    // flushIndex / pendingBlobs / _inflight / workers / activeWorkers /
    // _formatConfirmed / _remuxedToMp4 / isFMP4 / initSegment / speedEMA / lastTick
    // 等按次累计状态 → 旧值跨次保留，表现为：
    //   ① downloadedSegments 从上次 800 继续累加，UI 出现「1585/1471 段 / 107.7%」
    //      越界（counter leak，最常见的肉眼可见症状）
    //   ② segmentErrors 把上次失败的索引误判为已达 5 次上限 → 本可成功的分片
    //      在重试里被直接 skipped → 用户看到的"莫名失败"
    //   ③ flushIndex 不归零、pendingBlobs 不清空、workers 不重置 → OPFS 落盘
    //      顺序错乱、残留分片写入、worker 计数错位
    // 以下完整对齐构造函数（第 99-149 行）每运行一次应有的初始态。

    // v4.3.7：自增 generation。worker 在入口处捕获此值，decrement 时校验——
    // 与当前 _generation 不匹配的旧 worker（destroy 后尚未自然退出的），
    // 不会回写本轮 activeWorkers，避免 start() 重置 0 后被旧 worker 减成负数。
    this._generation++;
    const myGen = this._generation;

    this.paused = false;
    this.aborted = false;
    this._writeError = null;
    this._cleanupDone = false;
    this._proxyFailCount = 0;
    this._proxyTextFailCount = 0;   // v4.2.9：清单代理连续失败计数（≥2 才弃清单代理）
    // v4.3.4-2：记录代理失败真实原因（DNS 复查超时/网络中断/HTTP 状态），
    // 直连被 CSP 拦截时透传它，替代误导性的"跨域访问"文案
    this._lastProxyTextError = null;
    this._useProxyText = true;      // v4.2.9：清单/密钥代理开关独立于分段开关 ——
                                     // 清单 host（主站）与分片 host（CDN）常不同域，
                                     // 清单侧 DNS 挂起不应连累分片的代理能力
    this._headSpin = 0;

    // v4.3.7 新增：补齐"按次累计"运行态重置
    this.downloadedSegments = 0;
    this.failedSegments = 0;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.completedBytes = 0;          // v4.3.8：与 downloadedBytes 拆开，含在途字节
    this._segInflight = new Map();    // v4.3.8：在途分片字节路由表
    this.segmentErrors = new Map();   // 旧 Map 复用会让上次失败索引直接判到 errs≥5
    this.activeWorkers = 0;
    this._remuxedToMp4 = false;
    this._formatConfirmed = false;
    this.isFMP4 = false;
    this.initSegment = null;
    // workers 集合：旧 Promise 仍可能因 paused/OPFS 已清理而抛错，附加 .catch
    // 吞掉避免 UnhandledPromiseRejection；它们的网络/OPFS 资源由各自 fetch
    // 超时/写错误自然释放。generation 守卫已防止它们回写本轮 activeWorkers。
    const oldWorkers = this.workers;
    this.workers = new Set();
    [...oldWorkers].forEach(p => p.catch?.(() => {}));
    this._queue = [];                 // 防御性（processHLS/DASH 重建后会再覆盖）
    this._queueCursor = 0;
    this.speedEMA = 0;
    this.lastTickBytes = 0;
    this.lastTickTime = 0;
    this.flushIndex = 0;
    this.pendingBlobs = new Map();
    this._inflight = new Set();
    this._useProxy = true;            // 构造函数基线为 true；重试不应继承上次"已禁用"
    this._useDirect = true;           // v4.3.13：直连优先基线
    this._directFailCount = 0;

    if (!validateStreamUrl(this.manifestUrl)) {
      this.onError(new Error(t('sd_url_invalid')));
      this.setStatus('error');
      return;
    }

    try {
      this.setStatus('preparing');

      // 注册到下载注册表，获取自适应连接数
      await this.registerDownload();

      // 关键修复：任何模式都应用 DNR 放行规则（不再限 force 模式）。
      // 大站清单/分片请求同样被 CORS 拦截 —— 规则统一提供响应头 CORS
      // 覆盖（按下载页 tab 限定，覆盖清单域+分片域的所有请求）。
      if (chrome?.runtime?.sendMessage) {
        try {
          const resp = await sdSendBgMessage({
            type: 'apply-force-rule',
            url: this.manifestUrl,
            referer: this.referer || null,
          });
          if (resp?.applied) {
            this._forceRuleApplied = true;
            this._forceRuleId = resp.ruleId;
          }
        } catch {}
      }

      const urlLower = this.manifestUrl.toLowerCase();
      // v4.2.1：清单获取独立状态，准备阶段可见进展
      this.setStatus('manifest');
      if (urlLower.includes('.mpd')) {
        await this.processDASH();
      } else {
        await this.processHLS();
      }

      if (this.segments.length === 0) {
        throw new Error(t('sd_no_segments'));
      }

      await this.initOPFS();

      this.setStatus('downloading');
      this.lastTickTime = Date.now();
      this.startSpeedMonitor();

      if (this.initSegment) {
        await this.writeSequential(this.initSegment);
      }

      await this.downloadSegmentsConcurrent();
      this.stopSpeedMonitor();

      if (this.paused) { this.setStatus('paused'); return; }

      // 修复 v2.2：下载完成后检查跳过的分段，避免产出空洞损坏文件
      const skipped = this.segments.filter(s => s.status === 'skipped');
      if (skipped.length > 0 && !this.paused && !this.aborted) {
        // fMP4 的每个 moof 必须严格连续，任何空洞都会导致载荷错位、文件永久
        // 损坏，因此 fMP4 一律拒绝跳过；MPEG-TS 容忍少量（≤5%）短暂缺失
        if (this.isFMP4 || skipped.length > this.segments.length * 0.05) {
          throw new Error(t('sd_segments_failed', [skipped.length, this.segments.length]));
        }
        console.warn(`[VideoSniffer] ${skipped.length} 个分片下载失败，继续生成文件（可能包含短暂缺失）`);
      }

      this.setStatus('merging');
      const file = await this.finalizeFile();
      this.totalBytes = file.size;

      // v4.3.0：MPEG-TS 自动转封装为 MP4（iPhone/手机原生可播；TS 仅电脑
      // 播放器能放）。失败/超大文件降级回 .ts 原样保存，不影响原有产出。
      const finalFile = await this.remuxTsToMp4(file);
      this.totalBytes = finalFile.size;
      await this.saveFile(finalFile);
      await this._ensureCleanup();
      this.setStatus('done');
      this.onComplete({ fileName: this.fileName, totalSize: this.totalBytes });
    } catch (err) {
      this.stopSpeedMonitor();
      await this._ensureCleanup();
      if (this._forceRuleApplied && chrome?.runtime?.sendMessage) {
        try { await chrome.runtime.sendMessage({ type: 'remove-force-rule', ruleId: this._forceRuleId }); } catch {}
        this._forceRuleApplied = false;
        this._forceRuleId = null;
      }
      if (this.paused) { this.setStatus('paused'); return; }
      this.setStatus('error');
      this.onError(err);
    }
  }

  async _ensureCleanup() {
    if (this._cleanupDone) return;
    this._cleanupDone = true;
    // 隐私：清除解密密钥缓存
    this._keyCache.clear();
    this.cryptoKey = null;
    this.encryption = null;
    // 注销下载注册，释放连接配额
    await this.unregisterDownload();
    await this.removeOPFSFile();
  }

  // ============================================================
  // HLS
  // ============================================================
  async processHLS(depth = 0) {
    if (depth > 5) throw new Error(t('sd_playlist_deep'));
    const text = await this.fetchText(this.manifestUrl);
    const parsed = this.parseM3U8(text, this.manifestUrl);

    if (parsed.isMaster && parsed.variants.length > 0) {
      // v4.3.10：选最高清晰度变体。带宽优先；带宽缺失/相同时按分辨率高度
      // 兜底（旧版 bandwidth 全 0 时 reduce 恒返回第一个 = 最低清晰度 480p）。
      const scoreOf = (v) => {
        let h = 0;
        if (v.resolution) {
          const m = String(v.resolution).match(/(\d+)x(\d+)/);
          if (m) h = Math.min(parseInt(m[1]), parseInt(m[2]));  // 短边即高度
        }
        return { bw: v.bandwidth || 0, h };
      };
      const best = parsed.variants.reduce((a, b) => {
        const sa = scoreOf(a), sb = scoreOf(b);
        if (sb.bw !== sa.bw) return sb.bw > sa.bw ? b : a;
        return sb.h > sa.h ? b : a;
      });
      this.manifestUrl = best.url;
      await this.processHLS(depth + 1);
      return;
    }

    // 不支持的加密方式（SAMPLE-AES 等）无法直接下载
    if (parsed.unsupportedEncryption) {
      throw new Error(t('sd_sample_aes_unsupported'));
    }

    this.segments = parsed.segments.map((seg, index) => ({
      index,
      url: seg.url,
      duration: seg.duration,
      seq: seg.seq,              // 媒体序号（AES-128 默认 IV 基准，P2 修复）
      status: 'pending',
      size: 0,
      encryption: seg.encryption,  // 每段携带加密信息
    }));
    this.estimatedDuration = parsed.totalDuration;

    // AES-128 加密：获取解密密钥
    if (parsed.encryption && parsed.encryption.method === 'AES-128') {
      this.encryption = parsed.encryption;
      this.cryptoKey = await this.fetchEncryptionKey(parsed.encryption.keyUri);
      if (!this.cryptoKey) {
        throw new Error(t('sd_aes_key_failed'));
      }
    }

    const sample = this.segments[0]?.url || '';
    this.isFMP4 = /\.(m4s|mp4)(\?|$)/i.test(sample) ||
                  text.includes('ftyp') ||
                  parsed.hasFMP4Map;

    if (parsed.mapUrl) {
      this.initSegment = await this.fetchBlob(parsed.mapUrl);
      this.isFMP4 = true;
    }
  }

  parseM3U8(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const result = {
      isMaster: false,
      variants: [],
      segments: [],
      totalDuration: 0,
      mapUrl: null,
      hasFMP4Map: false,
      encryption: null,          // { method, keyUri, iv }
      unsupportedEncryption: false,  // SAMPLE-AES 等不支持解密的加密方式标记
      mediaSequence: 0,          // EXT-X-MEDIA-SEQUENCE（AES-128 默认 IV 的正确序号基准）
    };

    let currentDuration = 0;
    let currentEncryption = null;
    let segSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // EXT-X-MEDIA-SEQUENCE：清单第一个分段的媒体序号。AES-128 无显式 IV
      // 时解密用的序号基准必须是它（RFC 8216），而不是数组下标 —— 滑动窗口
      // /直播转点播的清单序号常从非 0 开始，用下标会导致从第二段起全部解
      // 密失败（花屏/噪音）。
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const m = line.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
        if (m) result.mediaSequence = parseInt(m[1]);
      }

      // EXT-X-KEY：加密信息
      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/);
        const method = methodMatch ? methodMatch[1] : 'NONE';
        if (method === 'NONE') {
          currentEncryption = null;
        } else if (method === 'AES-128') {
          const uriMatch = line.match(/URI="([^"]+)"/);
          const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
          currentEncryption = {
            method: 'AES-128',
            keyUri: uriMatch ? this.resolveUrl(uriMatch[1], baseUrl) : null,
            iv: ivMatch ? ivMatch[1] : null, // null = 用序号作 IV
          };
        } else {
          // SAMPLE-AES 等不支持的加密方式 → 标记为不可直接下载
          result.unsupportedEncryption = true;
          currentEncryption = { method, keyUri: null, iv: null };
        }
      }

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        result.isMaster = true;
        const bw = line.match(/BANDWIDTH=(\d+)/);
        const res = line.match(/RESOLUTION=(\d+x\d+)/);
        const next = lines[i + 1];
        if (next && !next.startsWith('#')) {
          result.variants.push({
            url: this.resolveUrl(next, baseUrl),
            bandwidth: bw ? parseInt(bw[1]) : 0,
            resolution: res ? res[1] : null,
          });
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uri = line.match(/URI="([^"]+)"/);
        if (uri) {
          result.mapUrl = this.resolveUrl(uri[1], baseUrl);
          result.hasFMP4Map = true;
        }
      } else if (line.startsWith('#EXTINF:')) {
        const m = line.match(/#EXTINF:([\d.]+)/);
        currentDuration = m ? parseFloat(m[1]) : 0;
        result.totalDuration += currentDuration;
      } else if (!line.startsWith('#') && line.length > 0) {
        const segmentUrl = this.resolveUrl(line, baseUrl);
        if (/\.m3u8(\?|$)/i.test(segmentUrl) && result.segments.length === 0) {
          result.isMaster = true;
          result.variants.push({ url: segmentUrl, bandwidth: 0 });
        } else {
          result.segments.push({
            url: segmentUrl,
            duration: currentDuration,
            // 媒体序号（EXT-X-MEDIA-SEQUENCE + 数组序号）：AES-128 默认 IV 用
            seq: result.mediaSequence + segSeq,
            encryption: currentEncryption, // 每段携带当前加密状态
          });
          segSeq++;
        }
        currentDuration = 0;
      }
    }

    // 保留最后一个加密状态作为全局标记
    if (currentEncryption) result.encryption = currentEncryption;
    return result;
  }

  // ============================================================
  // DASH
  // ============================================================
  async processDASH() {
    const text = await this.fetchText(this.manifestUrl);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error(t('sd_dash_parse_failed'));

    // 选最高画质的视频 Representation
    const periods = doc.querySelectorAll('Period');
    const scope = periods.length > 0 ? periods : [doc.documentElement];

    let bestRep = null;
    let bestScore = -1;

    for (const period of scope) {
      for (const rep of period.querySelectorAll('Representation')) {
        const height = parseInt(rep.getAttribute('height') || '0');
        const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0');
        const score = height * 1000000 + bandwidth;
        // 画质自选：命中用户指定高度时给远超任何真实码率分数的加权
        //（_preferredHeight=0 时此分支不生效，行为与旧版完全一致）
        const weighted = (this._preferredHeight && height === this._preferredHeight)
          ? score + 1e12 : score;
        if (weighted > bestScore) {
          bestScore = weighted;
          bestRep = rep;
        }
      }
    }
    if (!bestRep) throw new Error(t('sd_dash_no_video'));

    const adaptation = bestRep.closest('AdaptationSet');
    const segTemplate = bestRep.querySelector('SegmentTemplate') ||
                        adaptation?.querySelector('SegmentTemplate');
    const segList = bestRep.querySelector('SegmentList') ||
                    adaptation?.querySelector('SegmentList');
    const baseUrlEl = bestRep.querySelector('BaseURL') ||
                      adaptation?.querySelector('BaseURL');

    const timescale = parseInt(segTemplate?.getAttribute('timescale') || '1');

    if (segTemplate) {
      const media = segTemplate.getAttribute('media');
      const startNumber = parseInt(segTemplate.getAttribute('startNumber') || '1');
      const timeline = segTemplate.querySelector('SegmentTimeline');

      if (timeline) {
        let currentTime = 0;
        let segIndex = 0;
        for (const t of timeline.querySelectorAll('S')) {
          const tAttr = t.getAttribute('t');
          const d = parseInt(t.getAttribute('d') || '0');
          const r = parseInt(t.getAttribute('r') || '0');
          if (tAttr) currentTime = parseInt(tAttr);
          for (let i = 0; i < r + 1; i++) {
            this.pushDashSegment(media, startNumber, segIndex, currentTime);
            currentTime += d;
            segIndex++;
          }
        }
      } else {
        // duration 属性推算（用 Period/MPD 时长计算总数）
        const duration = parseInt(segTemplate.getAttribute('duration') || '0');
        // P2 修复：时长基准取 Period@duration，缺失时退回 MPD@mediaPresentationDuration
        const durAttr = bestRep.closest('Period')?.getAttribute('duration')
          || doc.documentElement.getAttribute('mediaPresentationDuration');
        const periodDur = parseFloat(String(durAttr || '').replace('PT', '').replace('S', '')) || 0;
        let segCount = 1000;
        let speculative = true;   // 时长未知 → 分段表是盲推的，404 即自然终点
        if (duration > 0 && periodDur > 0) {
          segCount = Math.ceil(periodDur * timescale / duration);
          speculative = false;
        }
        segCount = Math.min(segCount, 20000);
        for (let i = 0; i < segCount; i++) {
          this.pushDashSegment(media, startNumber, i, i * duration, speculative);
        }
      }

      // fMP4 初始化段
      const init = segTemplate.getAttribute('initialization');
      if (init) {
        this.initSegment = await this.fetchBlob(
          this.resolveUrl(init.replace(/\$Number\$/g, '0').replace(/\$RepresentationID\$/g,
            bestRep.getAttribute('id') || '0'), this.manifestUrl));
        this.isFMP4 = true;
      }
    } else if (segList) {
      segList.querySelectorAll('SegmentURL').forEach((segUrlEl, index) => {
        const media = segUrlEl.getAttribute('media');
        if (media) {
          this.segments.push({
            index,
            url: this.resolveUrl(media, this.manifestUrl),
            duration: 0,
            status: 'pending',
            size: 0,
          });
        }
      });
      const initEl = segList.querySelector('Initialization');
      if (initEl?.getAttribute('sourceURL')) {
        this.initSegment = await this.fetchBlob(
          this.resolveUrl(initEl.getAttribute('sourceURL'), this.manifestUrl));
        this.isFMP4 = true;
      }
    } else if (baseUrlEl) {
      this.segments.push({
        index: 0,
        url: this.resolveUrl(baseUrlEl.textContent.trim(), this.manifestUrl),
        duration: 0,
        status: 'pending',
        size: 0,
      });
    }
  }

  pushDashSegment(mediaTemplate, startNumber, segIndex, time, speculative = false) {
    if (!mediaTemplate) return;
    const url = this.resolveUrl(
      mediaTemplate
        .replace(/\$Number(%0\d+d)?\$/g, (_, f) =>
          f ? String(startNumber + segIndex).padStart(parseInt(f.slice(2, -1)), '0')
            : String(startNumber + segIndex))
        .replace(/\$Time\$/g, String(time)),
      this.manifestUrl
    );
    this.segments.push({
      index: segIndex,
      url,
      duration: 0,
      status: 'pending',
      size: 0,
      speculative,   // P2：时长未知的盲推分段，404 = 清单真实终点（见 _trimSegmentsAfter）
    });
  }

  // ============================================================
  // 高并发分片下载（动态扩展 + 动态再分配）
  // ============================================================
  async downloadSegmentsConcurrent() {
    // 队列实例化：动态增援的 worker（配额扩张）可从同一游标领取分片
    this._queue = this.segments.filter(s => s.status === 'pending');
    this._queueCursor = 0;

    const n = Math.min(this.threadCount, this._queue.length);
    for (let i = 0; i < n; i++) {
      this.spawnWorker();
    }
    // 关键修复 v2.2：轮询等待所有 worker 完成，同时处理动态增援竞态。
    // 旧版竞态：所有 worker 完成后 while 退出，但 adjustThreads 新 spawn 的
    // worker 可能还未被调度 → 配额回流后实际未增加并发。
    while (this.workers.size > 0) {
      await Promise.all([...this.workers]);
      // 等待现有 worker 全部完成后，检查是否还有未分配的分片
      if (this.workers.size === 0 && !this.paused) {
        const remaining = this._queue.filter(s => s.status === 'pending');
        if (remaining.length > 0 && this.activeWorkers < this.threadCount) {
          const toSpawn = Math.min(
            this.threadCount - this.activeWorkers,
            remaining.length
          );
          for (let i = 0; i < toSpawn; i++) {
            this.spawnWorker();
          }
        }
      }
    }
  }

  spawnWorker() {
    const p = this.segmentWorker().catch(() => {}).finally(() => {
      this.workers.delete(p);
    });
    this.workers.add(p);
    return p;
  }

  // 动态线程再分配（多任务公平调度）：SW 广播新配额时调用
  adjustThreads(n) {
    // v4.2.7：用户设定值作为硬上限
    const target = Math.max(1, Math.min(this._userThreadCount, this.maxThreads, n || this.threadCount));
    if (target === this.threadCount) return;
    const delta = target - this.threadCount;
    this.threadCount = target;
    if (delta > 0 && !this.paused && this.status === 'downloading') {
      for (let i = 0; i < delta; i++) {
        this.spawnWorker();
      }
    }
    // 收缩方向：segmentWorker 在分片边界检测超员自动退出
  }

  // 从队列领取下一个待下载分片（游标代替 shift()，shift 是 O(n)）
  _nextSeg() {
    while (this._queueCursor < this._queue.length) {
      const seg = this._queue[this._queueCursor++];
      if (seg.status !== 'done') return seg;
    }
    return null;
  }

  async segmentWorker() {
    this.activeWorkers++;
    // v4.3.7：捕获本轮 generation，decrement 时校验——
    // start() 重置了 activeWorkers=0 和 workers=新 Set，但旧 worker 仍在
    // 飞行（destroy 未等其退出）。若不守卫，旧的 this.activeWorkers-- 会把
    // 本轮计数减成负数，进而让本轮 worker 持续被判定为"超员"反复退出。
    const myGen = this._generation;
    while (!this.paused) {
      // 线程配额收缩（其他任务加入时的公平再分配）：超员 worker 退出。
      // 退出前先递减计数（同步块，无竞争），恰好退出多余的 worker
      if (this.activeWorkers > this.threadCount) {
        if (myGen === this._generation) this.activeWorkers--;
        return;
      }

      // 内存保护：乱序分片过多时暂停领取，等 flush 释放
      if (this.pendingBlobs.size >= MAX_PENDING_BLOBS) {
        await this.flushInOrder();
        if (this.pendingBlobs.size >= MAX_PENDING_BLOBS) {
          // P1-E 队头死锁修复：pendingBlobs 打满且队头分片（flushIndex 对应）
          // 既未完成、也没人正在下载（它曾失败被重排队尾，_nextSeg 游标已
          // 越过它）时，所有 worker 都卡在内存闸门上等 flushInOrder，而
          // flushInOrder 只能等队头 → 全体每 500ms 空转直到天荒地老。
          // 对策：连续 20 轮自旋（≈10s，给正常 flush 留足余量）后由当前
          // worker 直接下载队头分片（跳过游标顺序），补齐即解锁整条顺序
          // 落盘流水线。选自旋计数而非立即抢办：避免和正在写入的 worker
          // 抢内存闸门、也避免对短暂乱序过度反应。
          this._headSpin = (this._headSpin || 0) + 1;
          let acted = false;
          if (this._headSpin >= 20) {
            acted = await this._rescueHeadSegment();
            if (acted) this._headSpin = 0;
          }
          if (!acted) {
            await new Promise(r => setTimeout(r, 500));
          }
          continue;
        }
        this._headSpin = 0;
      }

      const seg = this._nextSeg();
      if (!seg) break;

      const errs = this.segmentErrors.get(seg.index) || 0;
      if (errs >= 5) {
        // 修复 v2.2：不再假装完成（旧版标记 done 但数据没写入 → 文件空洞/损坏）
        // v4.3.16：标记 skipped 前先确认没有 worker 正在下载它（重复 queue 条目
        // 会让同一分段被多次领取）；且 skip 幂等（已 skipped 不再重复计数）。
        if (this._inflight.has(seg.index)) continue;   // 另一 worker 在飞，等其结论
        if (seg.status === 'done') continue;
        if (seg.status !== 'skipped') {
          seg.status = 'skipped';
          this.failedSegments++;
          this.downloadedSegments++;
        }
        continue;
      }

      await this._downloadSegment(seg);
    }
    if (myGen === this._generation) this.activeWorkers--;
  }

  // 领取并下载单个分片（成功落 pendingBlobs / 失败重排队尾 + 退避）。
  // worker 主循环与 P1-E 队头救援共用同一条路径，保证行为一致。
  async _downloadSegment(seg) {
    // v4.3.16：并发/重复领取守卫。失败分片会被 push 回 _queue（重试），同一
    // 分段因此在队列里出现多个条目；P1-E 队头救援与普通 worker 也可能同时指向
    // 同一分段。旧代码无入口守卫 → 同一分段被并发下载：
    //   ① 每个完成者各自 downloadedSegments++ → UI 出现「131/128 段 / 102.3%」
    //      越界（v4.3.8 只修了重试重置，没堵住运行期重复领取）；
    //   ② segmentErrors 被两个 catch 各 +1 → 5 次重试窗口双倍消耗 → 本可成功的
    //      分片被提前判 skip → TS 缺失率超 5% 时整单中止（"13 个分片反复下载
    //      失败" 的假性失败根因之一）。
    // 守卫：已在下载中（_inflight）或已终结（done/skipped）的分段直接放弃。
    if (this._inflight.has(seg.index)) return;
    if (seg.status === 'done' || seg.status === 'skipped') return;
    // v4.3.16：捕获代际。destroy→start()（同实例重试）后，旧 worker 在飞的
    // fetch 完成回调仍会执行到计数/置位代码——不校验代际就会把本轮刚清零的
    // downloadedSegments/failedSegments/segmentErrors 重新写脏（v4.3.8 只给
    // activeWorkers-- 加了守卫，计数路径仍是漏网的）。
    const myGen = this._generation;
    this._inflight.add(seg.index);
    // v4.3.8：为代理分段登记在途进度路由。SW 抓取+落盘期间每 512KB 推
    // seg-progress → _onSegProgress 更新 _segInflight[segReqId] → downloadedBytes
    // 平滑累加，速度曲线不再只在分片完成瞬间跳变（"过山车"根因）。
    const segReqId = `sseg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._segInflight.set(segReqId, 0);
    if (typeof _SD_SEG_REQ_ROUTES !== 'undefined') _SD_SEG_REQ_ROUTES.set(segReqId, this);
    try {
      let blob = await this.fetchBlob(seg.url, segReqId);

      // AES-128 解密：下载后本地解密，速度远超实时录制
      if (seg.encryption && seg.encryption.method === 'AES-128') {
        blob = await this.decryptSegment(blob, seg);
      }

      // 首次分片：用 magic bytes 确认真实容器格式（决定最终扩展名）
      if (!this._formatConfirmed && blob.size >= 8) {
        this._formatConfirmed = true;
        await this.detectRealFormat(blob);
      }

      // 队头救援与普通领取可能并发指向同一分片：第二个完成者直接放弃，
      // 防止 downloadedBytes 重复计数 / pendingBlobs 留下永不清除的孤儿分片
      // v4.3.16：终结态含 skipped（被跳过即已计数，不允许再以 done 覆盖计数）
      if (seg.status === 'done' || seg.status === 'skipped') return;
      if (myGen !== this._generation) return;  // 过期 worker：不写本轮状态（finally 仍会清理 in-flight）

      seg.status = 'done';
      seg.size = blob.size;
      // v4.3.8：改为 completedBytes 累计，downloadedBytes 由 _recompute 统一
      // 得出（含在途）。旧 this.downloadedBytes += blob.size 只计完成分片，
      // 速度 EMA 采不到 SW 抓取阶段的字节 → 显示成"过山车"。
      this.completedBytes += blob.size;
      this.downloadedSegments++;

      this.pendingBlobs.set(seg.index, blob);
      await this.flushInOrder();

      this.notifyProgressThrottled();
    } catch (err) {
      if (this.paused) return;
      // DASH 推测分段的自然边界（P2）：未知总时长的清单按上限盲推了分段，
      // 服务器 404/410 = 后面已无分片 → 截断分段表（不算失败、不重试）
      if (seg.speculative && /HTTP\s+(404|410)/i.test(String(err?.message || ''))) {
        this._trimSegmentsAfter(seg.index);
        return;
      }
      // v4.3.12：普通分片 404/410 = 该分片 URL 已过期（CDN 防盗链短链/混淆域
      // 常见，签名 TTL 一过就 404；截图里 static.worldstatic.c.off?2e=… 就是
      // 典型短链过期形态）。重试也无用（旧版一律计入 _proxyFailCount，3
      // 个过期分片就会永久禁用代理 → 后续所有分片转直连也 404 → 速度塌到
      // 几十 B/s）。直接标记 skipped，代理计数不受影响。
      // v4.3.16：skip 幂等 + 代际守卫 —— 同一分段的重复条目/过期 worker 不得重复计数。
      if (/HTTP\s+(404|410)\b/i.test(String(err?.message || ''))) {
        if (myGen !== this._generation) return;
        if (seg.status === 'skipped' || seg.status === 'done') return;
        seg.status = 'skipped';
        this.failedSegments++;
        this.downloadedSegments++;
        return;
      }
      const errs = this.segmentErrors.get(seg.index) || 0;
      this.segmentErrors.set(seg.index, errs + 1);
      this._queue.push(seg);
      await new Promise(r => setTimeout(r, 300 + errs * 700));
    } finally {
      this._inflight.delete(seg.index);
      // 摘除在途路由（成功/失败都摘，防止路由表泄漏 + 重复计数）
      if (typeof _SD_SEG_REQ_ROUTES !== 'undefined') _SD_SEG_REQ_ROUTES.delete(segReqId);
      this._segInflight.delete(segReqId);
      this._recomputeDownloadedBytes();
    }
  }

  // v4.3.8：下载字节数 = 已完整落盘 + 各在途分片的已抓取字节。
  // SW 抓取阶段 seg-progress 持续回调 _onSegProgress → 更新 _segInflight[segReqId]，
  // downloadedBytes 随之平滑增长，速度 EMA 不再只在分片完成瞬间跳变。
  _recomputeDownloadedBytes() {
    let inflight = 0;
    for (const w of this._segInflight.values()) inflight += w || 0;
    this.downloadedBytes = this.completedBytes + inflight;
  }

  // seg-progress 回调（SW 每 512KB 推一次 written，单位字节）
  _onSegProgress(segReqId, written) {
    if (this._segInflight.has(segReqId)) {
      this._segInflight.set(segReqId, written || 0);
      this._recomputeDownloadedBytes();
    }
  }

  // P1-E 队头救援：仅当自旋次数达到阈值（20 轮 ≈ 10s）且队头确实无人处理时
  // 才动手，正常的内存闸门等待不受影响。返回 true 表示本轮有动作（无需再睡）。
  async _rescueHeadSegment() {
    const head = this.segments[this.flushIndex];
    if (!head || head.status === 'done') return false;
    if (head.status === 'skipped') return false;   // flushInOrder 自己会跳过
    if (this._inflight.has(head.index)) return false;  // 已有 worker 在下载它
    const errs = this.segmentErrors.get(head.index) || 0;
    if (errs >= 5) {
      // 队头反复失败已达上限：标记 skipped 让 flushInOrder 越过它，
      // 空洞安全性由 start() 统一判定（fMP4 拒绝 / TS ≤5% 容忍）
      head.status = 'skipped';
      this.failedSegments++;
      this.downloadedSegments++;
      return true;
    }
    await this._downloadSegment(head);
    return true;
  }

  // 截断 index 及其之后的全部分段（DASH 盲推分段遇到 404 = 清单真实终点）
  _trimSegmentsAfter(index) {
    const keep = this.segments.filter(s => s.index < index);
    const removed = this.segments.length - keep.length;
    if (removed <= 0) return;
    this.segments = keep;
    // 队列同步裁剪：未领取的推测分段从此不可见
    this._queue = this._queue.filter(s => s.index < index);
    console.warn(`[VideoSniffer] DASH 分段在 #${index} 处自然结束（服务器 404），截去 ${removed} 个推测分段`);
    this.notifyProgressThrottled(true);
  }

  async flushInOrder() {
    while (this.pendingBlobs.has(this.flushIndex) ||
           this.segments[this.flushIndex]?.status === 'skipped') {
      if (this.segments[this.flushIndex]?.status === 'skipped') {
        // 跳过的分段：无法获取其字节尺寸，不写假占位（写不出等长空洞）。
        // 直接推进序号让后续分段按序落盘；数据空洞的安全性由 start() 统一
        // 判定（fMP4 拒绝；TS ≤5% 才继续）
        this.flushIndex++;
        continue;
      }
      const blob = this.pendingBlobs.get(this.flushIndex);
      if (!blob) break;
      this.pendingBlobs.delete(this.flushIndex);
      await this.writeSequential(blob);
      this.flushIndex++;
    }
  }

  // ============================================================
  // 真实容器格式检测：读取首段 magic bytes 判断 fMP4 / MPEG-TS
  // ============================================================
  async detectRealFormat(blob) {
    try {
      const head = await blob.slice(0, 16).arrayBuffer();
      const v = new Uint8Array(head);
      // ftyp box（fMP4 / MP4）：偏移 4 处为 'ftyp'
      if (v.length >= 8 && v[4] === 0x66 && v[5] === 0x74 && v[6] === 0x79 && v[7] === 0x70) {
        this.isFMP4 = true;
        return;
      }
      // MPEG-TS：0x47 同步字节
      if (v.length >= 1 && v[0] === 0x47) {
        this.isFMP4 = false;
        return;
      }
      // 兜底：默认按已有判断
    } catch {}
  }

  // ============================================================
  // 速度监控 + 动态并发扩展
  // ============================================================
  startSpeedMonitor() {
    this.speedInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTickTime) / 1000;
      if (dt <= 0) return;
      // v4.3.16：负增量钳零。downloadedBytes = completedBytes + Σ在途分片字节，
      // 分片失败/超时摘除在途计数时总量瞬时回落 → 直接求差会显示「-几 B/s」。
      // 负增量只是计数口径的回撤，不是回传数据，按 0 处理。
      const dBytes = this.downloadedBytes - this.lastTickBytes;
      const inst = dBytes > 0 ? dBytes / dt : 0;
      this.speedEMA = this.speedEMA === 0 ? inst : this.speedEMA * 0.6 + inst * 0.4;
      this.lastTickTime = now;
      this.lastTickBytes = this.downloadedBytes;

      this.onSpeedUpdate({
        speed: this.speedEMA,
        speedFormatted: this.formatSpeed(this.speedEMA),
        eta: this.calculateETA(),
        connections: this.activeWorkers,
      });
      this.notifyProgressThrottled(true);
    }, 1000);
  }

  stopSpeedMonitor() {
    if (this.speedInterval) { clearInterval(this.speedInterval); this.speedInterval = null; }
  }

  calculateETA() {
    if (this.speedEMA <= 0 || this.downloadedSegments === 0) return '--:--';
    const remaining = this.segments.length - this.downloadedSegments;
    if (remaining <= 0) return '00:00';
    const avgBytesPerSeg = this.completedBytes / this.downloadedSegments;
    const bytesPerWorker = this.speedEMA / Math.max(1, this.activeWorkers);
    const seconds = (remaining * avgBytesPerSeg) / Math.max(1, bytesPerWorker * Math.max(1, this.activeWorkers));
    return this.formatTime(seconds);
  }

  notifyProgressThrottled(force = false) {
    const now = performance.now();
    if (!force && now - this._lastProgressNotify < 200) return;
    this._lastProgressNotify = now;

    const total = this.segments.length;
    // P2 性能修复：不再把全量分段数组 map 复制后每 200ms 推给 UI ——
    // 上千段的流（长视频 HLS/DASH）每次都是几千个临时对象 + structured
    // 传参，纯浪费。只传汇总 { completed, total }；分段可视化由 download.js
    // 用汇总数等价渲染。
    this.onProgress({
      progress: total > 0 ? (this.downloadedSegments / total) * 100 : 0,
      downloaded: this.downloadedBytes,
      total: this.downloadedBytes, // 流媒体总大小未知，进度按分片数
      segmentProgress: { completed: this.downloadedSegments, total },
      failedSegments: this.failedSegments,
      connections: this.activeWorkers,
    });
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
    this.setStatus('downloading');
    this.lastTickTime = Date.now();
    this.lastTickBytes = this.downloadedBytes;
    this.startSpeedMonitor();

    try {
      await this.downloadSegmentsConcurrent();
      this.stopSpeedMonitor();

      if (this.paused) { this.setStatus('paused'); return; }

      this.setStatus('merging');
      const file = await this.finalizeFile();
      this.totalBytes = file.size;
      const finalFile = await this.remuxTsToMp4(file);
      this.totalBytes = finalFile.size;
      await this.saveFile(finalFile);
      await this._ensureCleanup();
      this.setStatus('done');
      this.onComplete({ fileName: this.fileName, totalSize: this.totalBytes });
    } catch (err) {
      this.stopSpeedMonitor();
      await this._ensureCleanup();
      if (this.paused) { this.setStatus('paused'); return; }
      this.setStatus('error');
      this.onError(err);
    }
  }

  // ============================================================
  // 暂停时保存已下载部分
  // v4.3.7：先尝试 TS→MP4 转封装（quiet，不覆盖 paused 状态），让产出
  // 至少是合法 MP4 容器（VLC/PotPlayer 通常能播到 EOF）；再统计缺失分片
  // 数返回 warning，UI 弹 toast 告诉用户文件是截断的、可能无法完整播放。
  // ============================================================
  async saveCachedFile() {
    try {
      await this.flushInOrder();
      await this.writeQueue;
      const file = await this.fileHandle.getFile();
      // 缺失分片：含 pending（未开始/下载中）、skipped（失败 ≥5 次已放弃）。
      // 两者都意味着 OPFS 里这段字节是空的，flushInOrder 已在断点处停止写盘。
      const missingSegments = this.segments.filter(s => s.status !== 'done').length;
      const out = await this.remuxTsToMp4(file, { quiet: true });
      await this.saveFile(out);
      return {
        success: true,
        fileName: this.fileName,
        missingSegments,
        warning: missingSegments > 0
          ? `已保存 ${(out.size / 1048576).toFixed(1)}MB，但有 ${missingSegments} 个分片缺失，文件已截断，可能无法播放或只能播放前段`
          : null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  // v4.3.0：MPEG-TS → MP4 转封装（解决 iPhone 等手机对 TS 容器
  // 兼容性极差的问题；纯容器切换，不重编码、零画质损失）
  // 失败降级：转封装器缺失 / 超过体积上限 / 转换出错 → 原样返回 .ts
  // v4.3.7：新增 quiet 选项。暂停保存部分分片时跳过 setStatus('converting')
  // 与 30ms 让帧，避免把"已暂停"覆盖成"转封装中"误导 UI。
  // ============================================================
  async remuxTsToMp4(file, { quiet = false } = {}) {
    this._remuxedToMp4 = false;
    if (this.isFMP4) return file;   // fMP4 流本就直接存 .mp4
    const remux = (typeof window !== 'undefined' && window.__VideoSnifferTsRemux__) || null;
    if (!remux || typeof remux.transmuxTsToMp4 !== 'function') return file;
    if (file.size > (remux.REMUX_MAX_BYTES || Infinity)) {
      console.warn(`[VideoSniffer] 文件 ${(file.size / 1048576).toFixed(0)}MB 超过转封装体积上限，按原始 TS 保存（避免内存溢出）`);
      return file;
    }
    // TS 魔数探测：偏移 0 与 188 均为 0x47 同步字节（188 字节包对齐）。
    // 非 TS 流（直连 MP4/FLV 等）直接跳过，避免无谓的转封装尝试
    try {
      const head = new Uint8Array(await file.slice(0, 189).arrayBuffer());
      if (head.length < 1 || head[0] !== 0x47 ||
          (head.length >= 189 && head[188] !== 0x47)) {
        return file;
      }
    } catch { return file; }
    if (!quiet) {
      this.setStatus('converting');
      // 先让 UI 渲染一次状态再进入同步密集计算（转封装期间主线程阻塞）
      await new Promise(r => setTimeout(r, 30));
    }
    try {
      const r = await remux.transmuxTsToMp4(file);
      if (r && r.blob) {
        this._remuxedToMp4 = true;
        // v4.3.6：日志带版本标记与产出总时长——用户核对时长是否覆盖
        // 广告+正片即可确认负时长修复是否生效（修复前只剩广告时长）
        const ds = r.durationSec || 0;
        const durTxt = ds > 0
          ? `，总时长 ${Math.floor(ds / 60)}分${Math.round(ds % 60).toString().padStart(2, '0')}秒`
          : '';
        console.log(`[VideoSniffer] TS→MP4 转封装完成(v4.3.6)：${(file.size / 1048576).toFixed(1)}MB → ${(r.blob.size / 1048576).toFixed(1)}MB${durTxt}`);
        return r.blob;
      }
      console.warn('[VideoSniffer] TS→MP4 转封装失败，按原始 TS 保存：', r?.error);
    } catch (e) {
      console.warn('[VideoSniffer] TS→MP4 转封装异常，按原始 TS 保存：', e?.message || e);
    }
    return file;
  }

  // ============================================================
  // 保存
  // ============================================================
  async saveFile(file) {
    if (this._forceRuleApplied && chrome?.runtime?.sendMessage) {
      try { await chrome.runtime.sendMessage({ type: 'remove-force-rule', ruleId: this._forceRuleId }); } catch {}
      this._forceRuleApplied = false;
      this._forceRuleId = null;
    }
    // 根据真实容器格式决定扩展名与 MIME：
    // fMP4 / 已成功转封装的 TS → .mp4（iPhone 原生可播）；
    // 未转封装的纯 MPEG-TS → .ts（仅电脑播放器可播）
    const isMp4 = this.isFMP4 || this._remuxedToMp4;
    const finalExt = isMp4 ? 'mp4' : 'ts';
    this.fileName = this.fileName.replace(/\.(ts|mp4|m4s|m3u8|mpd)$/i, '') + '.' + finalExt;
    const mime = isMp4 ? 'video/mp4' : 'video/mp2t';
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
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      });
    } else {
      this.anchorDownload(url);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  anchorDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async clearCache() {
    this.pendingBlobs.clear();
    this._keyCache.clear();
    this.cryptoKey = null;
    await this.removeOPFSFile();
  }

  async destroy() {
    this.paused = true;
    this.stopSpeedMonitor();
    await this.clearCache();
    await this._ensureCleanup();
    if (this._forceRuleApplied && chrome?.runtime?.sendMessage) {
      try { await chrome.runtime.sendMessage({ type: 'remove-force-rule', ruleId: this._forceRuleId }); } catch {}
      this._forceRuleApplied = false;
      this._forceRuleId = null;
    }
  }

  // ============================================================
  // 请求：优先使用 SW 代理（绕过 CORS 预检）
  // 失败策略：
  //  - SW 端已有硬超时（清单 15s / 分段 60s），失败快速返回而非挂起
  //  - 清单（v4.2.9）：单次代理失败仅本次降级直连，连续 2 次才弃「清单」
  //    代理开关（_useProxyText，独立于分段开关 —— 两者 host 常不同域）
  //  - 分段：单次代理失败只影响当前分段（转直连重试），连续 3 次失败
  //    才全局弃用代理——旧版一次超时就把所有分片打到直连，遇 CORS 预检
  //    拦截即产生海量 "Failed to fetch"
  // ============================================================
  async fetchText(url) {
    // SW 代理路径：绕过 CORS，解决大站清单请求被预检拦截
    if (this._useProxyText && this._useProxy && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const resp = await Promise.race([
          sdSendBgMessage({ type: 'proxy-fetch-text', url, referer: this.referer || undefined }),
          // SW 端 15s 硬超时 + 1s 余量，让 SW 的明确错误（含 DNS 复查原因）
          // 优先于本页竞速超时返回
          new Promise((_, reject) => setTimeout(() => reject(new Error('清单请求超时')), MANIFEST_FETCH_TIMEOUT + 1000)),
        ]);
        if (resp?.error) throw new Error(resp.error);
        if (resp?.text !== undefined) {
          this._proxyTextFailCount = 0;
          this._lastProxyTextError = null;   // 代理成功即清除上次失败原因
          return resp.text;
        }
        throw new Error('代理返回空数据');
      } catch (e) {
        // v4.2.9：单次失败仅本次降级直连，连续 2 次才弃「清单」代理（分段
        // 开关独立保留 —— 清单 host 与分片 host 常不同域）。旧版一次 DNS
        // 复查超时/网络抖动就把全局 _useProxy 永久置 false —— master 清单
        // 一次失败，后续 media 清单/AES key/全部分片全部转直连，再被
        // CORS/防盗链拦截 → "卡在获取流清单很久后报失败"。SW 侧 DNS 超时
        // 有 60s 负缓存，同 host 第二次代理失败是瞬时的，不影响总时长。
        this._proxyTextFailCount = (this._proxyTextFailCount || 0) + 1;
        if (this._proxyTextFailCount >= 2) {
          this._useProxyText = false;
          console.warn('[VideoSniffer] 清单代理连续失败，后续清单/密钥转直连');
        }
        // v4.3.4-2：保存真实原因（如 SW 返回的"网络连接失败 / DNS 安全校验
        // 超时 / HTTP 403"），下方直连被 CSP 拦截（TypeError）时透传它；
        // 若本次仅竞速超时（消息总线层面，message 为"清单请求超时"），不记为
        // 真实原因，避免覆盖更早更有信息量的代理错误。
        this._lastProxyTextError = /代理返回空数据|清单请求超时$/.test(String(e?.message || '')) ? this._lastProxyTextError : e;
        if (e?.message) console.warn('[VideoSniffer] 清单代理失败，本次转直连:', e.message);
      }
    }
    const controller = new AbortController();
    // v4.2.10：超时中断必须携带可读原因。Chrome 对不带 reason 的 abort() 给出的
    // 拒绝原因是 DOMException(AbortError) "signal is aborted without reason"，
    // 下方 catch 不认该名字 → 原样上抛 → 用户界面出现英文系统错误。
    // abort(reason)（Chrome 98+）让 fetch 直接以该 Error 拒绝。
    const timer = setTimeout(() => {
      controller.abort(new Error(t('sd_manifest_timeout')));
    }, MANIFEST_FETCH_TIMEOUT);
    try {
      const resp = await fetch(url, {
        mode: 'cors',
        redirect: 'follow',
        // 修复 v2.2：omit 代替 include —— 不向任意清单 URL 发送用户 CDN Cookie（隐私最小化）
        // 防盗链依赖 Referer（由 DNR 注入）而非 Cookie
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(t('sd_manifest_http', [resp.status]));
      return await resp.text();
    } catch (e) {
      // 兜底：个别路径仍可能产出原生 AbortError（如信号在 fetch 发起前已被打断）
      if (e?.name === 'AbortError' || /aborted without reason/i.test(String(e?.message))) {
        throw new Error(t('sd_manifest_timeout'));
      }
      // TypeError('Failed to fetch') = CORS/网络层拦截，对用户毫无信息量
      if (e instanceof TypeError) {
        // v4.3.4-2：直连被拦截时，若代理失败留下真实原因（DNS 复查超时/
        // 网络中断/HTTP 状态码），透传它替代误导性的"跨域访问"——用户才能
        // 区分"网络/服务器问题"和"链接本身问题"，避免反复重试误解。
        // 真实原因本身已含诊断指导，不再拼接额外后缀（避免文案重复）
        const real = this._lastProxyTextError?.message;
        if (real && !/代理返回空数据|清单请求超时$/.test(real)) {
          throw new Error(t('sd_manifest_failed', [real]));
        }
        throw new Error(t('sd_manifest_cors'));
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchBlob(url, segReqId) {
    // v4.3.13：直连优先（单缓冲：网络→Blob→OPFS 写一次）。SW 代理路径是
    // 双缓冲（SW fetch→SW 写 OPFS→页面读 OPFS→页面再写 OPFS）+ SW 单线程
    // 串行 8-24 并发，吞吐天花板只有几百 KB/s——而原生下载器（Motrix/aria2）
    // 多线程 HTTP 直连写盘，能跑满带宽。直连优先即可贴近原生速度。
    // 前提：DNR 规则已应用（_forceRuleApplied）——它能注入 Referer/Cookie 反
    // 防盗链 + ACAO 响应头放行 CORS，使扩展页 fetch 分片可行。
    // 直连失败（403/CORS/网络）连续 3 次才回退代理；404/410 抛给上层 skip。
    if (this._useDirect && this._forceRuleApplied) {
      try {
        const blob = await this._directFetchBlob(url);
        this._directFailCount = 0;
        return blob;
      } catch (e) {
        if (/HTTP\s+(404|410)\b/i.test(String(e?.message || ''))) throw e;
        this._directFailCount = (this._directFailCount || 0) + 1;
        if (this._directFailCount >= 3) {
          this._useDirect = false;
          console.warn('[VideoSniffer] 分片直连连续失败，转 SW 代理');
        } else if (e?.message) {
          console.warn('[VideoSniffer] 分片直连失败，本分片转代理:', _sdSanitizeErrorMessage(e));
        }
        // fallthrough 到下方代理路径
      }
    }

    // SW 代理路径：SW 流式写入 OPFS 临时文件，本页直读（v4.2.6 起的
    // 「OPFS 手递手」协议：返回 { status, opfsFile, byteLength, actualStart,
    // totalSize }，不再有 data 字段）。
    // P0-1 关键修复：旧代码仍按 v2.x 协议判断 resp?.data —— v4.2.6 之后
    // 该字段恒为 undefined → 代理路径"永远失败"静默转直连 → 大站分片全被
    // CORS 预检拦截 → 整任务下载失败。这正是"流媒体一律下不动"的根因。
    if (this._useProxy && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        // v4.3.7：不再用默认 25s 超时 + 65s race 抢先判负。SW 端 proxy-fetch-
        // segment 已改为 30s 停滞看门狗（数据在流动就不打断），此处显式传入
        // 宽松总上限兜底。旧版 25s 会在慢速大分片仍在正常下载时误判
        // "SW 响应超时"→ 转直连 → 重复下载 + 连续 3 次失败后永久禁用代理
        // → 直连遇 CORS 拦截 → 速度在 MB/s 与几十 B/s 间剧烈抖动。
        const resp = await sdSendBgMessage({ type: 'proxy-fetch-segment', url, segReqId }, SEGMENT_PROXY_TIMEOUT);
        if (resp?.error) throw new Error(resp.error);
        if (!resp?.opfsFile) throw new Error(t('sd_proxy_no_opfs'));
        if (!navigator.storage?.getDirectory) {
          throw new Error(t('sd_opfs_unavailable'));
        }
        let blob;
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
          const fh = await dir.getFileHandle(resp.opfsFile);
          const file = await fh.getFile();
          const expected = resp.byteLength ?? file.size;
          // v4.3.2 S-3：改用 file.stream() 流式读取（浏览器自决分块，
          // 通常 64KB–1MB，远小于旧 8MB slice）。旧版 file.slice().arrayBuffer()
          // 会在中转瞬间持有 slice(Blob 视图) + 新 ArrayBuffer = 2× 块大小，
          // 且 >16MB 时把 4× 8MB ArrayBuffer 全堆在 parts 数组里再 new Blob。
          // 流式读法每块即时塞入 parts（独立 Uint8Array 副本，与 OPFS 文件
          // 解耦），下方 finally 删 OPFS 临时文件不会让 Blob 失效。
          // 说明：stream-downloader 的 pendingBlobs 顺序落盘架构要求整段
          // Blob 在内存中持有到落盘，故 Blob 本身大小不可压减——本优化
          // 仅降读路径峰值，不降持有峰值（download-engine 走 writeAt
          // position 才能做到真零拷贝）。
          const reader = file.stream().getReader();
          const parts = [];
          let read = 0;
          try {
            while (read < expected) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              // 尾部截断到 expected（防多读越界字节进 Blob）
              if (read + value.byteLength > expected) {
                parts.push(value.slice(0, expected - read));
                read = expected;
                break;
              }
              parts.push(value);
              read += value.byteLength;
            }
          } finally {
            try { await reader.cancel(); } catch {}
          }
          blob = new Blob(parts);
          // 长度校验：SW 承诺的 byteLength 与实际读出量必须一致，
          // 不一致说明落盘被截断 → 抛错走本分片重试（绝不产出坏分片）
          if (resp.byteLength != null && blob.size !== resp.byteLength) {
            throw new Error(t('sd_seg_len_check', [resp.byteLength, blob.size]));
          }
        } finally {
          // 无论成败，SW 的 OPFS 临时分片用完即删（异常路径也删，防孤儿堆积）
          try {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
            await dir.removeEntry(resp.opfsFile);
          } catch {}
        }
        this._proxyFailCount = 0;
        return blob;
      } catch (e) {
        // v4.3.12：分片级错误（404/410）与代理机制错误分流。
        // 404/410 = 该分片 URL 已过期（CDN 短链/签名过期常见），与代理无关，
        // 重抛让 _downloadSegment 走"立即 skipped"分支，**不计入 _proxyFailCount**。
        // 旧版一律计入 → 3 个过期分片永久禁用代理 → 所有后续分片转直连也 404
        // → 速度塌陷到几十 B/s（截图实证）。
        if (/HTTP\s+(404|410)\b/i.test(String(e?.message || ''))) {
          throw e;
        }
        // 代理机制错误（网络/CORS/超时/SW 故障）：计入失败计数
        this._proxyFailCount = (this._proxyFailCount || 0) + 1;
        if (this._proxyFailCount >= 3) {
          this._useProxy = false;
          console.warn('[VideoSniffer] 分段代理连续失败，剩余分片转直连');
        }
        if (e?.message) console.warn('[VideoSniffer] 分段代理失败，本分片转直连:', _sdSanitizeErrorMessage(e));
      }
    }
    return await this._directFetchBlob(url);
  }

  // v4.3.13：直连分片抓取（单缓冲，无 SW 代理）。抽取自原 fetchBlob 末尾的
  // 直连兜底逻辑，供"直连优先"路径复用。直连是网络→Blob→OPFS 写一次，
  // 比 SW 代理的双缓冲（网络→SW 写 OPFS→页面读 OPFS→页面再写 OPFS）快
  // 2-3 倍且不受 SW 单线程并发竞争限制——原生下载器（Motrix/aria2）的
  // 速度来源，插件直连路径在 DNR 规则放行 CORS 后也能贴近。
  async _directFetchBlob(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(t('sd_seg_timeout')));
    }, STREAM_FETCH_TIMEOUT);
    try {
      const resp = await fetch(url, {
        mode: 'cors',
        redirect: 'follow',
        // 修复 v2.2：omit 代替 include（隐私最小化，不向任意 URL 发送 CDN Cookie）
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.blob();
    } catch (e) {
      if (e?.name === 'AbortError' || /aborted without reason/i.test(String(e?.message))) {
        throw new Error(t('sd_seg_timeout'));
      }
      if (e instanceof TypeError) {
        throw new Error(t('sd_seg_cors'));
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  resolveUrl(url, baseUrl) {
    try { return new URL(url, baseUrl).href; } catch { return url; }
  }

  // ============================================================
  // AES-128 解密（Web Crypto API，纯本地运算，不上报任何数据）
  // ============================================================

  async fetchEncryptionKey(keyUri) {
    if (!keyUri) return null;
    if (this._keyCache.has(keyUri)) return this._keyCache.get(keyUri);

    try {
      // v4.2.7 修复：密钥 fetch 无超时控制（挂起会卡死 processHLS → manifest 卡 0%）
      // v4.2.9：密钥仅 16 字节，超时 30s → 15s（与清单同口径，缩短"卡清单"时长）
      // v4.2.10：带 reason 中断（防原生 AbortError 文案上屏）
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(t('sd_key_timeout')));
      }, MANIFEST_FETCH_TIMEOUT);
      let resp;
      try {
        // 修复 v2.2：omit 代替 include（隐私最小化，不向任意密钥 URL 发送用户 Cookie）
        resp = await fetch(keyUri, {
          mode: 'cors',
          redirect: 'follow',
          credentials: 'omit',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(t('sd_key_http', [resp.status]));
      const keyBuf = await resp.arrayBuffer();
      if (keyBuf.byteLength !== 16) {
        throw new Error(t('sd_key_len_abnormal', [keyBuf.byteLength]));
      }
      const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']
      );
      this._keyCache.set(keyUri, cryptoKey);
      return cryptoKey;
    } catch (e) {
      // CORS 失败 → 尝试通过 background 代理获取（绕过跨域）
      if (chrome?.runtime?.sendMessage) {
        try {
          const result = await sdSendBgMessage({
            type: 'fetch-key',
            url: keyUri,
            referer: this.referer,
          });
          if (result?.keyData) {
            const keyBuf = this._base64ToArrayBuffer(result.keyData);
            const cryptoKey = await crypto.subtle.importKey(
              'raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']
            );
            this._keyCache.set(keyUri, cryptoKey);
            return cryptoKey;
          }
        } catch {}
      }
      return null;
    }
  }

  _base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // AES-128-CBC 解密单个分段
  async decryptSegment(blob, seg) {
    if (!seg.encryption || seg.encryption.method !== 'AES-128') return blob;

    let cryptoKey = this.cryptoKey;
    // 多密钥场景：不同分段可能用不同密钥
    if (seg.encryption.keyUri && seg.encryption.keyUri !== this.encryption?.keyUri) {
      cryptoKey = await this.fetchEncryptionKey(seg.encryption.keyUri);
      if (!cryptoKey) throw new Error(t('sd_seg_key_failed'));
    }

    // IV 处理：无显式 IV 时用序号（big-endian 16 字节）
    let ivBytes;
    if (seg.encryption.iv) {
      const hex = seg.encryption.iv;
      ivBytes = new Uint8Array(16);
      for (let i = 0; i < Math.min(hex.length, 32); i += 2) {
        ivBytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
    } else {
      ivBytes = new Uint8Array(16);
      // P2 修复：用媒体序号（EXT-X-MEDIA-SEQUENCE 基准），不是数组下标。
      // RFC 8216：无显式 IV 时 IV = 16 字节 big-endian 的媒体序号。
      // 旧版用 seg.index（数组下标）—— 序号不从 0 开始的清单从第二段起
      // 全部解密错位（花屏/只有杂音）。
      const seq = (typeof seg.seq === 'number') ? seg.seq : (seg.index || 0);
      // 序号写为 big-endian 16 字节（高 12 字节为 0）
      const view = new DataView(ivBytes.buffer);
      view.setUint32(12, seq, false); // big-endian
    }

    const encData = await blob.arrayBuffer();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      encData
    );
    return new Blob([decrypted], { type: blob.type });
  }

  formatSpeed(b) {
    if (!b || b < 1024) return `${(b || 0).toFixed(0)} B/s`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB/s`;
    return `${(b / 1048576).toFixed(1)} MB/s`;
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
  window.StreamDownloader = StreamDownloader;
}
