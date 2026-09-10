/**
 * 视频嗅探器 - MSE 拦截钩子（MAIN 世界，document_start 注入）
 *
 * 职责：在页面 JS 运行前接管 MediaSource.appendBuffer，拦截所有 MSE 视频分段数据，
 * 不依赖播放速度即可导出完整视频。
 *
 * 通信协议（postMessage）：
 *   ext → hook:  { source:'ext', action:'get-data', captureId }  请求导出数据
 *   ext → hook:  { source:'ext', action:'list-all' }              请求捕获列表
 *   hook → ext:  { source:'mse-hook', type:'source-detected', captureId, mimeType }
 *   hook → ext:  { source:'mse-hook', type:'data-appended', captureId, totalSize, segmentCount }
 *   hook → ext:  { source:'mse-hook', type:'source-ended', captureId, totalSize, segmentCount }
 *   hook → ext:  { source:'mse-hook', type:'capture-reset', captureId }
 *   hook → ext:  { source:'mse-hook', type:'capture-limit', captureId, size, limit }
 *   hook → ext:  { source:'mse-hook', type:'data-response', captureId, blobUrl, size, ext,
 *                  truncated?, error? }   （captureId 从 get-data 请求透传，供防伪造校验）
 *
 * 安全：纯本地拦截，不向任何第三方发送数据。
 * 稳定性：所有钩子 try-catch 全保护，绝不影响页面正常播放。
 */

(function () {
  'use strict';

  // 仅在存在 MediaSource 的页面注入（减少无意义开销）
  if (typeof MediaSource === 'undefined' && !window.WebKitMediaSource) return;

  const MS = window.MediaSource || window.WebKitMediaSource;
  if (!MS) return;

  // ============================================================
  // 捕获注册表
  // ============================================================
  const captures = new Map();   // captureId → CaptureEntry

  // 每个 SourceBuffer 建立时分配一个 captureId
  // 多个 SourceBuffer 可属于同一个 MediaSource（视频+音频分别 buffer）
  const bufferToCapture = new WeakMap();
  const sourceToCaptures = new WeakMap();  // MediaSource → Set<captureId>
  const captureToSource = new Map();       // captureId → MediaSource（v4.1 新增，供音视频配对）
  const closeHookedSources = new WeakSet(); // MediaSource → 是否已挂 sourceclose 监听（v4.2.8）

  // v4.2.8：captureId 改为高熵随机值（每次 MSE 捕获会话生成一次）。
  // 旧版自增计数器 id（mse_cap_1/2/3…）可被页面枚举猜测，配合 content-script
  // 的 pendingCapture 窗口校验（task: data-response 防伪造），随机 id 使
  // 伪造的 data-response 难以命中未过期窗口内的合法请求。
  // 长度 24 字符 < SW 侧存储时的 50 字符截断上限（service-worker.js captureId.slice(0,50)）。
  function randomCaptureId() {
    try {
      if (typeof crypto !== 'undefined' && crypto?.randomUUID) {
        return `mse_cap_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      }
    } catch {}
    let hex = '';
    for (let i = 0; i < 16; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return `mse_cap_${hex}`;
  }

  const MAX_SEGMENTS = 2000;    // 防内存爆炸
  const MAX_TOTAL_SIZE = 800 * 1024 * 1024; // 800MB 上限
  // v4.2.3 安全加固（E/MSE 内存）：单 capture 已有上限，但仍可能出现多个
  // SourceBuffer 同时各占 800MB → 页面 OOM。增加全局累计预算（1.5GB），
  // 超限后暂停新增捕获，防止整页内存无限增长。
  const MAX_TOTAL_GLOBAL = 1536 * 1024 * 1024; // 1.5GB
  let globalCapturedSize = 0;

  // 统一回收入口：整合 segments 并扣减全局记账（防止只清 segments 忘记扣账）
  function releaseSegments(entry) {
    if (!entry) return;
    clearReleaseTimer(entry);   // v4.2.8：任何释放路径都取消 pending 的自动回收计时器（防重复释放）
    globalCapturedSize -= entry.totalSize;
    if (globalCapturedSize < 0) globalCapturedSize = 0; // 防御性兜底
    entry.segments = [];
    entry.totalSize = 0;
    entry.segmentCount = 0;
    entry.epochs = [];
  }

  // ============================================================
  // v4.2.8：ended 捕获回收。source-ended 后数据仅剩「等待用户导出」价值，
  // 30 分钟内无人下载即自动释放（旧版 ended 后无限期驻留内存 →
  // 长会话/连看多集场景内存持续增长）。
  // 手动导出（get-data / get-merged-data）与 sourceclose 会 clearTimeout；
  // pagehide 兜底全量释放。
  // ============================================================
  const ENDED_RELEASE_DELAY = 30 * 60 * 1000; // 30 分钟
  function armReleaseTimer(entry) {
    if (!entry) return;
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; } // clear 已有引用防止重复释放
    entry.releaseTimer = setTimeout(() => {
      entry.releaseTimer = null;
      try { releaseSegments(entry); } catch {}
    }, ENDED_RELEASE_DELAY);
  }
  function clearReleaseTimer(entry) {
    if (entry && entry.releaseTimer) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
  }

  // ============================================================
  // 修复 v2.2：安全 postMessage —— 不再回退到 '*' 通配（通配可被任意嵌套 frame 截获）。
  // 同 frame 内 MAIN 世界 ↔ 扩展隔离世界 origin 相同，精确匹配足够。
  // sandboxed frame（opaque origin）的消息不被隔离世界信任，应静默放弃。
  // ============================================================
  function postToExt(msg) {
    try {
      window.postMessage(msg, location.origin);
    } catch {
      // 不再回退到 '*' —— 环境异常时静默放弃
    }
  }

  // ============================================================
  // CaptureEntry
  // ============================================================
  function createCapture(sourceBuffer, mimeType) {
    const id = randomCaptureId();
    const entry = {
      id,
      segments: [],           // ArrayBuffer[]
      totalSize: 0,
      segmentCount: 0,
      mimeType: mimeType || '',
      // 推断容器格式
      ext: detectFormat(sourceBuffer, mimeType),
      // 推断轨道类型（v4.1 新增）：音视频轨配对合并需要区分 video/audio
      track: detectTrack(mimeType),
      ended: false,
      reset: false,           // 是否被 abort 重置过
      // v4.1+：epoch 分组。每检测到一个 init segment 就新开一组；
      // 导出时选数据量最大的一组（正片），丢弃广告/旧清晰度分片。
      // 旧的单个 initIndex 方案在「视频中途切清晰度」时只会保留尾部几秒，
      // 改用最大分组启发式更稳。
      epochs: [],             // [{ startIndex, size }]
    };
    captures.set(id, entry);
    return entry;
  }

  // 从 MIME 推断轨道类型（avc1/hevc/vp9/av1 → video；mp4a/opus/flac/ec-3 → audio）
  function detectTrack(mimeType) {
    const mt = (mimeType || '').toLowerCase();
    if (/mp4a|opus|flac|ec-3|ac-3|vorbis|aac/i.test(mt)) return 'audio';
    return 'video';
  }

  // 根据 MIME 类型或首段 magic bytes 推断格式
  function detectFormat(sourceBuffer, mimeType) {
    const mt = (mimeType || '').toLowerCase();
    if (mt.includes('mp4') || mt.includes('fmp4') || mt.includes('iso')) return 'mp4';
    if (mt.includes('mp2t') || mt.includes('mpeg')) return 'ts';
    if (mt.includes('webm')) return 'webm';
    return 'mp4'; // 默认
  }

  // 识别 fMP4 初始化段（init segment）：以 ftyp 或 moov box 开头。
  // 关键修复 v4.1.1：MP4 box 结构是 [4字节 size][4字节 type]，
  // 类型字节在偏移 4-7！旧版检查偏移 0-3（那是 size 字段），
  // 导致 init 永远检测不到 → 广告与正片的多个 init 混拼成非法文件 →
  // 播放器只认第一组（广告）→ 用户反馈「下载的要么是广告要么是开头片段」。
  function isFtypInitSegment(buf) {
    if (!buf || buf.byteLength < 8) return false;
    const v = new Uint8Array(buf, 0, 8);
    const t = ((v[4] << 24) | (v[5] << 16) | (v[6] << 8) | v[7]) >>> 0;
    // 'ftyp' = 0x66747970；'moov' = 0x6D6F6F76
    // （部分 CDN 的 init segment 不含 ftyp，直接以 moov 开头）
    return t === 0x66747970 || t === 0x6D6F6F76;
  }

  // ============================================================
  // 钩子：SourceBuffer.addSourceBuffer
  // ============================================================
  const origAddSourceBuffer = MS.prototype.addSourceBuffer;
  MS.prototype.addSourceBuffer = function (mimeType) {
    let sb;
    try {
      sb = origAddSourceBuffer.call(this, mimeType);
    } catch (e) {
      throw e; // 让页面正常处理异常
    }

    try {
      const entry = createCapture(sb, mimeType);

      // 记录 MediaSource → captures 映射
      if (!sourceToCaptures.has(this)) {
        sourceToCaptures.set(this, new Set());
      }
      sourceToCaptures.get(this).add(entry.id);
      captureToSource.set(entry.id, this);   // v4.1：反向映射，供音视频配对
      bufferToCapture.set(sb, entry);

      // v4.2.8：sourceclose 时取消该 source 下所有 entry 的自动回收计时器。
      // 页面关闭 source 后用户仍可能手动导出（segments 与 source 生命周期
      // 解耦），数据保留至 pagehide 兜底清理，不在 close 时抢跑释放。
      if (!closeHookedSources.has(this)) {
        closeHookedSources.add(this);
        try {
          this.addEventListener('sourceclose', () => {
            try {
              const set = sourceToCaptures.get(this);
              if (set) for (const capId of set) clearReleaseTimer(captures.get(capId));
            } catch {}
          });
        } catch {}
      }

      // 通知内容脚本
      postToExt({
        source: 'mse-hook',
        type: 'source-detected',
        captureId: entry.id,
        mimeType: mimeType,
        track: entry.track,   // v4.1：附带轨道类型
      });
    } catch {}

    return sb;
  };

  // ============================================================
  // 钩子：SourceBuffer.appendBuffer（核心拦截点）
  // ============================================================
  const proto = SourceBuffer.prototype;
  const origAppend = proto.appendBuffer;

  proto.appendBuffer = function (data) {
    // 先调用原始方法（保证页面正常播放）
    try {
      origAppend.call(this, data);
    } catch (e) {
      throw e; // 透传异常
    }

    try {
      const entry = bufferToCapture.get(this);
      if (!entry || entry.ended) return;

      // data 可能是 ArrayBuffer 或 ArrayBufferView
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = data;
      } else if (data && data.buffer instanceof ArrayBuffer) {
        buf = data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + (data.byteLength || 0));
      } else {
        return;
      }

      // 内存上限保护（单源 + 全局累计双重）
      if (entry.segments.length >= MAX_SEGMENTS ||
          entry.totalSize + buf.byteLength > MAX_TOTAL_SIZE ||
          globalCapturedSize + buf.byteLength > MAX_TOTAL_GLOBAL) {
        // 超限后停止捕获，但仍允许播放。
        // v4.2.8：不再静默截断 —— 每个 entry 只通知一次（limitNotified 标志），
        // 向内容脚本（进而后台/弹窗）发 capture-limit，导出时会带 truncated:true。
        if (!entry.limitNotified) {
          entry.limitNotified = true;
          let size, limit;
          if (entry.segments.length >= MAX_SEGMENTS) {
            size = entry.segments.length; limit = MAX_SEGMENTS;
          } else if (entry.totalSize + buf.byteLength > MAX_TOTAL_SIZE) {
            size = entry.totalSize; limit = MAX_TOTAL_SIZE;
          } else {
            size = globalCapturedSize; limit = MAX_TOTAL_GLOBAL;
          }
          postToExt({
            source: 'mse-hook',
            type: 'capture-limit',
            captureId: entry.id,
            size,
            limit,
          });
        }
        return;
      }

      entry.segments.push(buf);
      globalCapturedSize += buf.byteLength;
      entry.totalSize += buf.byteLength;
      entry.segmentCount++;

      // v4.1.1：epoch 分组。新 init → 新开一组（广告/清晰度切换）；
      // 后续分片计入当前组大小。导出时选最大组（正片）。
      if (entry.ext === 'mp4' && isFtypInitSegment(buf)) {
        entry.epochs.push({ startIndex: entry.segments.length - 1, size: buf.byteLength });
      } else if (entry.epochs.length > 0) {
        entry.epochs[entry.epochs.length - 1].size += buf.byteLength;
      }

      // 首段 magic bytes 推断格式
      if (entry.segmentCount === 1 && buf.byteLength >= 8) {
        const view = new Uint8Array(buf, 0, Math.min(buf.byteLength, 12));
        // ftyp box: 长度4字节 + 'ftyp'
        if (view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
          entry.ext = 'mp4';
        }
        // MPEG-TS: 0x47 同步字节
        else if (view[0] === 0x47) {
          entry.ext = 'ts';
        }
        // WebM: 0x1A 0x45 0xDF 0xA3
        else if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDF && view[3] === 0xA3) {
          entry.ext = 'webm';
        }
      }

      // 通知进度（每 5 段通知一次，降低消息开销）
      if (entry.segmentCount % 5 === 0 || entry.segmentCount === 1) {
        postToExt({
          source: 'mse-hook',
          type: 'data-appended',
          captureId: entry.id,
          totalSize: entry.totalSize,
          segmentCount: entry.segmentCount,
        });
      }
    } catch {}
  };

  // ============================================================
  // 钩子：SourceBuffer.abort（检测内容切换：广告→正片）
  // ============================================================
  const origAbort = proto.abort;
  proto.abort = function () {
    try {
      const entry = bufferToCapture.get(this);
      if (entry && !entry.ended) {
        // v4.1.1：保留 v2.3 的阈值策略（中途 seek/切清晰度不能丢正片），
        // 配合 epoch 分组导出（选最大组）即可正确丢弃广告。
        // 「下载到广告」的根因是 init 检测偏移错误（已修），不是这里。
        const PRESERVE_THRESHOLD = 10 * 1024 * 1024; // 10MB

        if (entry.totalSize > PRESERVE_THRESHOLD) {
          // 已捕获大量数据 → 保留（大概率是正片）
          entry.reset = true;
        } else {
          // 数据量小 → 可能是广告，清除后继续捕获正片
          releaseSegments(entry);
          entry.reset = true;
        }

        postToExt({
          source: 'mse-hook',
          type: 'capture-reset',
          captureId: entry.id,
        });
      }
    } catch {}

    try {
      return origAbort.call(this);
    } catch (e) {
      throw e;
    }
  };

  // ============================================================
  // 钩子：SourceBuffer.remove（数据被移除时同步清理）
  // ============================================================
  const origRemove = proto.remove;
  proto.remove = function (start, end) {
    try {
      // 不清除已捕获数据——remove 是播放器内部清理，
      // 我们保存的是完整分段用于下载，与播放器缓冲管理无关
    } catch {}
    try {
      return origRemove.call(this, start, end);
    } catch (e) {
      throw e;
    }
  };

  // ============================================================
  // 钩子：MediaSource.endOfStream（标记捕获结束）
  // ============================================================
  const origEOS = MS.prototype.endOfStream;
  MS.prototype.endOfStream = function () {
    try {
      const capSet = sourceToCaptures.get(this);
      if (capSet) {
        for (const capId of capSet) {
          const entry = captures.get(capId);
          if (entry && !entry.ended) {
            entry.ended = true;
            postToExt({
              source: 'mse-hook',
              type: 'source-ended',
              captureId: entry.id,
              totalSize: entry.totalSize,
              segmentCount: entry.segmentCount,
            });
            // v4.2.8：ended 后 30 分钟无人导出即自动回收（见 armReleaseTimer）
            armReleaseTimer(entry);
          }
        }
      }
    } catch {}

    try {
      return origEOS.call(this);
    } catch (e) {
      throw e;
    }
  };

  // ============================================================
  // 消息处理：响应内容脚本的请求
  // ============================================================

  // v4.2.8：get-data 限频（最小 5 秒间隔），防伪造高频导出请求造成内存 DoS
  const GET_DATA_MIN_INTERVAL = 5000;
  let lastGetDataTs = 0;

  // v4.1.1：把 entry 的分段按「数据量最大的 epoch」拼接为 Uint8Array。
  // 直接 concat 全部分段会得到「多个 ftyp/moov 混入」的非法文件——
  // 广告切换/清晰度切换都会 append 新的 init segment，混入后播放器
  // 只能解析到第一组（通常是广告）→ 「下载下来是广告」。
  // 选最大 epoch：广告（小）被丢弃；中途切清晰度时保留数据最多的那段。
  function pickBestEpoch(entry) {
    if (entry.ext !== 'mp4' || entry.epochs.length === 0) return { startIndex: 0, epochCount: 0 };
    let best = entry.epochs[0];
    for (const ep of entry.epochs) if (ep.size >= best.size) best = ep; // 平手取最后一组（当前播放中）
    return { startIndex: best.startIndex, epochCount: entry.epochs.length };
  }

  function exportEntryAsU8(entry) {
    const { startIndex, epochCount } = pickBestEpoch(entry);
    const exportSegments = entry.segments.slice(startIndex);

    // 合并为单个连续 Uint8Array（零拷贝拼接）
    let total = 0;
    for (const seg of exportSegments) total += seg.byteLength;
    const u8 = new Uint8Array(total);
    let off = 0;
    for (const seg of exportSegments) {
      u8.set(new Uint8Array(seg), off);
      off += seg.byteLength;
    }
    // v4.2.8：导出结果带 truncated —— 该 entry 曾因内存上限被静默截断过
    return { u8, size: total, startIndex, epochCount, truncated: !!entry.limitNotified };
  }

  // v4.2.8：导出内存优化（单轨导出路径）。旧路径先把全部分段拷贝进一个
  // 连续 Uint8Array 再 new Blob([u8])，峰值内存 = 2× 数据量（800MB 捕获
  // 要瞬时占 1.6GB，直接触发 OOM）。Blob 构造原生支持 BufferSource 数组，
  // 直接用分段 ArrayBuffer 构造，零中间拷贝。
  // mergeAvToMp4 需要连续 Uint8Array 输入，合并路径仍走 exportEntryAsU8。
  // head：首段前 8 字节的零拷贝视图，供容器头校验（替代旧版对整包 u8 的检查）。
  function exportEntryAsBlob(entry) {
    const { startIndex, epochCount } = pickBestEpoch(entry);
    const exportSegments = entry.segments.slice(startIndex);
    const mimeType = entry.ext === 'ts' ? 'video/mp2t' :
                     entry.ext === 'webm' ? 'video/webm' :
                     'video/mp4';
    let head = null;
    try {
      const first = exportSegments[0];
      if (first && first.byteLength >= 8) head = new Uint8Array(first, 0, 8);
    } catch {}
    const blob = new Blob(exportSegments, { type: mimeType });
    return { blob, size: blob.size, startIndex, epochCount, head, truncated: !!entry.limitNotified };
  }

  // v4.1 新增：音视频轨配对合并。找到与 videoCaptureId 同属一个 MediaSource
  // 的音频轨，两个轨分别导出 fMP4，再调用 lib/mp4-merger.js 合并成标准 MP4。
  function mergeAvCaptures(videoCaptureId) {
    const videoEntry = captures.get(videoCaptureId);
    if (!videoEntry) return { error: 'not-found' };
    if (videoEntry.segments.length === 0) return { error: 'empty' };

    // 找到同 MediaSource 的音频轨 capture
    const source = captureToSource.get(videoCaptureId);
    let audioEntry = null;
    if (source && sourceToCaptures.has(source)) {
      for (const cid of sourceToCaptures.get(source)) {
        const e = captures.get(cid);
        if (e && e !== videoEntry && e.track === 'audio' && e.segments.length > 0) {
          audioEntry = e;
          break;
        }
      }
    }
    if (!audioEntry) return { error: 'no-audio-track' };

    // 两个轨分别导出
    const v = exportEntryAsU8(videoEntry);
    const a = exportEntryAsU8(audioEntry);

    // 调用 MAIN 世界的合并器
    const merger = window.__VideoSnifferMerger__;
    if (!merger || typeof merger.mergeAvToMp4 !== 'function') {
      return { error: 'no-merger' };
    }
    return merger.mergeAvToMp4(v.u8, a.u8);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'ext') return;

    const msg = event.data;
    switch (msg.action) {
      case 'get-data': {
        // v4.2.8：get-data 限频（最小 5 秒间隔）。MAIN 世界的页面脚本可伪造
        // ext 请求（postMessage 同 window 可见），高频 get-data 会让本钩子
        // 反复构造数百 MB 的 Blob → 内存 DoS。过频请求直接忽略并回 error。
        const now = Date.now();
        if (now - lastGetDataTs < GET_DATA_MIN_INTERVAL) {
          postToExt({
            source: 'mse-hook',
            type: 'data-response',
            captureId: msg.captureId,
            error: 'rate-limited',
          });
          return;
        }
        lastGetDataTs = now;

        const captureId = msg.captureId;
        const entry = captures.get(captureId);
        if (!entry) {
          postToExt({
            source: 'mse-hook',
            type: 'data-response',
            captureId,
            error: 'not-found',
          });
          return;
        }
        if (entry.segments.length === 0) {
          postToExt({
            source: 'mse-hook',
            type: 'data-response',
            captureId,
            error: 'empty',
          });
          return;
        }

        try {
          // v4.2.8：单轨导出改走 Blob 直接构造（峰值内存 2× → 1×，见 exportEntryAsBlob）
          const { blob, size, startIndex, epochCount, head, truncated } = exportEntryAsBlob(entry);

          // 验证导出首段是否包含有效容器头
          // fMP4 需要 ftyp box，MPEG-TS 需要 0x47 同步字节，WebM 需要 EBML 头
          if (head && head.length >= 8) {
            const hasFtyp = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
            const hasTsSync = head[0] === 0x47;
            const hasEbml = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
            if (!hasFtyp && !hasTsSync && !hasEbml) {
              console.warn('[VideoSniffer] MSE 首段无有效容器头，文件可能无法播放');
            }
          }

          const blobUrl = URL.createObjectURL(blob);

          // 修复 v2.2：导出数据后立即释放 segments 内存（含全局记账）
          //（v4.2.8 同时取消 ended 自动回收计时器，防止 30 分钟后二次释放）
          releaseSegments(entry);

          postToExt({
            source: 'mse-hook',
            type: 'data-response',
            captureId,
            blobUrl,
            size,
            ext: entry.ext,
            // v4.1.1：诊断信息（丢弃了多少广告/旧清晰度分片、共几组）
            // v4.2.8：修复 —— 旧代码此处引用了未解构的 epochCount（ReferenceError
            // 被 catch 吞掉后回发 error:'merge-failed'，单轨 MSE 下载必然失败）
            droppedSegments: startIndex > 0 ? startIndex : 0,
            epochCount,
            // v4.2.8：超限截断标记（capture-limit 曾触发），供上层提示用户
            truncated: truncated || undefined,
          });

          // 5 分钟后自动回收 blob URL（给浏览器足够时间下载）
          setTimeout(() => {
            try { URL.revokeObjectURL(blobUrl); } catch {}
          }, 300000);
        } catch (e) {
          postToExt({
            source: 'mse-hook',
            type: 'data-response',
            captureId,
            error: 'merge-failed',
          });
        }
        break;
      }

      case 'get-merged-data': {
        // v4.1 新增：音视频轨合并导出（腾讯/爱奇艺 DASH 音视频分离场景）
        const captureId = msg.captureId;
        const result = mergeAvCaptures(captureId);

        if (result.error) {
          postToExt({
            source: 'mse-hook',
            type: 'merged-data-response',
            captureId,
            error: result.error,
          });
          return;
        }

        try {
          const blobUrl = URL.createObjectURL(result.blob);

          // 导出后释放两轨内存（v4.2.8：releaseSegments 内部会一并取消
          // ended 自动回收计时器，防止二次释放）
          let anyTruncated = false;
          const source = captureToSource.get(captureId);
          if (source && sourceToCaptures.has(source)) {
            for (const cid of sourceToCaptures.get(source)) {
              const e = captures.get(cid);
              if (e) {
                if (e.limitNotified) anyTruncated = true;
                releaseSegments(e);
              }
            }
          }

          postToExt({
            source: 'mse-hook',
            type: 'merged-data-response',
            captureId,
            blobUrl,
            size: result.blob.size,
            ext: 'mp4',
            // v4.2.8：超限截断标记（任一轨道曾触发 capture-limit）
            truncated: anyTruncated || undefined,
          });

          setTimeout(() => {
            try { URL.revokeObjectURL(blobUrl); } catch {}
          }, 300000);
        } catch (e) {
          postToExt({
            source: 'mse-hook',
            type: 'merged-data-response',
            captureId,
            error: 'merge-failed',
          });
        }
        break;
      }

      case 'list-all': {
        const list = [];
        for (const [id, entry] of captures) {
          list.push({
            captureId: id,
            segmentCount: entry.segmentCount,
            totalSize: entry.totalSize,
            ext: entry.ext,
            mimeType: entry.mimeType,
            ended: entry.ended,
          });
        }
        postToExt({
          source: 'mse-hook',
          type: 'capture-list',
          captures: list,
        });
        break;
      }
    }
  });

  // ============================================================
  // B站 __playinfo__ 提取（借鉴 bilibili下载助手 方案）
  // 在 MAIN 世界直接读取页面变量，获取完整 DASH 音视频地址
  // 这是解决"2.3MB 文件无法播放"和"MSE 只播放 40s"的根本方案
  // ============================================================
  function extractBiliData() {
    try {
      const pi = window.__playinfo__;
      if (!pi || !pi.data) return null;
      const data = pi.data;
      const dash = data.dash;
      if (!dash) return null;

      // 提取视频流地址（选最高清晰度）
      const videoStreams = (dash.video || []).map(v => ({
        url: v.baseUrl || v.base_url,
        backupUrl: (v.backupUrl || v.backup_url || [])[0],
        id: v.id,
        codecs: v.codecs,
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
      })).filter(v => v.url);

      // 提取音频流地址（选最高音质）
      // 合并普通音频 + FLAC + 杜比（高音质）
      let audioStreams = (dash.audio || []).map(a => ({
        url: a.baseUrl || a.base_url,
        backupUrl: (a.backupUrl || a.backup_url || [])[0],
        id: a.id,
        codecs: a.codecs,
        bandwidth: a.bandwidth,
      })).filter(a => a.url);

      // FLAC 无损音频（dash.flac 可能是对象 {audio:[...]} 或直接是数组）
      const flacAudio = dash.flac?.audio || (Array.isArray(dash.flac) ? dash.flac : []);
      for (const a of flacAudio) {
        const url = a.baseUrl || a.base_url;
        if (url) audioStreams.push({
          url, backupUrl: (a.backupUrl || a.backup_url || [])[0],
          id: a.id, codecs: a.codecs, bandwidth: a.bandwidth,
        });
      }
      // 杜比音频（类似结构）
      const dolbyAudio = dash.dolby?.audio || (Array.isArray(dash.dolby) ? dash.dolby : []);
      for (const a of dolbyAudio) {
        const url = a.baseUrl || a.base_url;
        if (url) audioStreams.push({
          url, backupUrl: (a.backupUrl || a.backup_url || [])[0],
          id: a.id, codecs: a.codecs, bandwidth: a.bandwidth,
        });
      }
      // 按 bandwidth 降序排列，最高音质在前
      audioStreams.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

      if (videoStreams.length === 0) return null;

      // 提取 bvid/aid
      const state = window.__INITIAL_STATE__ || {};
      const bvid = state.videoData?.bvid ||
        (location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/) || [])[1] || '';
      const aid = state.videoData?.aid || state.aid || 0;
      const cid = state.videoData?.cid || state.cid ||
        (data.videoData?.cid) || 0;
      const title = state.videoData?.title || document.title || '';
      const duration = data.timelength ? data.timelength / 1000 :
        (state.videoData?.duration || 0);

      return {
        type: 'bilibili-dash',
        title,
        bvid,
        aid,
        cid,
        duration,
        videoStreams,
        audioStreams,
        bestVideo: videoStreams[0],
        bestAudio: audioStreams[0] || null,
      };
    } catch (e) {
      console.warn('[VideoSniffer] B站数据提取失败:', e?.message);
      return null;
    }
  }

  // 页面加载完成后尝试提取（__playinfo__ 通常在 document_start 之后才注入）
  // v4.2.8：精确域名匹配 —— 旧正则 /bilibili\.com/i 会命中
  // bilibili.com.evil.example / xxbilibili.com 等仿冒/后缀域，泄漏 __playinfo__ 提取意图
  if (/(^|\.)bilibili\.com$/.test(location.hostname)) {
    const tryExtract = () => {
      const data = extractBiliData();
      if (data) {
        postToExt({
          source: 'mse-hook',
          type: 'bilibili-data',
          data,
        });
      }
    };
    // 多次尝试：SPA 路由可能延迟加载 playinfo
    setTimeout(tryExtract, 1500);
    setTimeout(tryExtract, 4000);
    setTimeout(tryExtract, 8000);

    // 监听来自扩展的请求（内容脚本可请求重新提取）
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.source !== 'ext') return;
      if (event.data.action === 'get-bilibili-data') {
        const data = extractBiliData();
        if (data) {
          postToExt({
            source: 'mse-hook',
            type: 'bilibili-data',
            data,
          });
        }
      }
    });
  }

  // ============================================================
  // 页面卸载：释放所有捕获数据
  // ============================================================
  window.addEventListener('pagehide', () => {
    try {
      for (const [, entry] of captures) releaseSegments(entry);
      captures.clear();
      globalCapturedSize = 0;
    } catch {}
  });
})();
