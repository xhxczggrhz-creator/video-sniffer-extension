/**
 * 视频嗅探器 - 内容脚本 v2（页面端嗅探）
 *
 * 性能与稳定性修复：
 * 1. MutationObserver 批处理 + 250ms 节流（旧版每个节点变化都全量查询）
 * 2. 页面标题缓存（旧版每报一个视频查 3 次 DOM）
 * 3. 上报批量合并（300ms 一批，降低消息开销）
 * 4. 移除隔离世界无效的 fetch/XHR/createObjectURL 钩子
 *    （内容脚本运行在隔离世界，钩不到页面 JS 的调用，只会白白消耗性能、
 *     网络层嗅探由后台 webRequest 全量覆盖，比钩子更准）
 * 5. 内联脚本正则扫描每次导航只做一次，限制总量
 * 6. 上限保护：最多 150 条，全函数 try-catch，绝不拖垮页面
 *
 * v4.3.1 DeepSearch（借鉴 CocoCut deepsearch.js）：
 *   旧版 document.querySelectorAll 只能拿到 light DOM 的 video，
 *   漏掉 Web Component 的 open Shadow DOM 与同源 iframe 内的视频。
 *   新增 deepQuerySelectorAll 递归遍历 open shadow root + 同源 iframe。
 *   closed shadow root 因 el.shadowRoot 返回 null 无法访问，
 *   继续由 mse-hook.js MAIN 世界 HTMLMediaElement.prototype.play patch 兜底。
 *   性能：TreeWalker 单次线性扫描 + WeakSet 防重入，单次扫描节点上限 5 万。
 */

(function () {
  'use strict';

  const MAX_VIDEOS = 150;

  const VIDEO_EXTS = new Set([
    'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v',
    'm3u8', 'mpd', 'ogg', 'ogv', '3gp', 'f4v', 'm4a',
  ]);

  const JUNK_PATTERNS = [
    /\/ad[sv]?[\/._-]/i, /advert/i, /\/banner\//i, /\/pixel[\/.-]/i,
    /\/analytics[\/.-]/i, /doubleclick/i, /_thumb|thumbnail/i,
  ];

  // DeepSearch 节点上限：防恶意页面构造超大树把嗅探器拖死
  const DEEP_SEARCH_NODE_LIMIT = 50000;

  // ============================================================
  // DeepSearch（v4.3.1）：递归遍历 open shadow root + 同源 iframe
  // 旧版 document.querySelectorAll 漏掉 Web Component 内部与 iframe 里的
  // video 元素。用 TreeWalker 单次线性扫描,遇 shadowRoot / iframe 递归进入。
  // closed shadow root el.shadowRoot === null 无法进入,继续由
  // mse-hook.js MAIN 世界 HTMLMediaElement.prototype.play patch 兜底。
  // WeakSet 防止循环引用导致重入死循环。
  // ============================================================
  function deepQuerySelectorAll(root, selector) {
    const out = [];
    const visited = new WeakSet();
    let nodeCount = 0;

    const visit = (ctx) => {
      if (!ctx || visited.has(ctx)) return;
      visited.add(ctx);

      // 1. 当前层级的直接匹配
      try {
        const matches = ctx.querySelectorAll ? ctx.querySelectorAll(selector) : [];
        for (const el of matches) out.push(el);
      } catch { /* 跨域 iframe 抛 SecurityError */ }

      // 2. TreeWalker 遍历所有元素子节点,递归 shadow root / iframe
      try {
        const walker = (ctx.ownerDocument || ctx).createTreeWalker(
          (ctx.nodeType === Node.DOCUMENT_NODE || ctx.nodeType === Node.DOCUMENT_FRAGMENT_NODE) ? ctx : (ctx.documentElement || ctx),
          NodeFilter.SHOW_ELEMENT, null
        );
        let el;
        while ((el = walker.nextNode())) {
          if (++nodeCount > DEEP_SEARCH_NODE_LIMIT) return;
          // open shadow root:递归进入
          if (el.shadowRoot) visit(el.shadowRoot);
          // 同源 iframe:递归进入 contentDocument
          if (el.tagName === 'IFRAME') {
            try {
              if (el.contentDocument) visit(el.contentDocument);
            } catch { /* 跨域拒绝 */ }
          }
        }
      } catch { /* TreeWalker 创建失败,降级到当前层级结果 */ }
    };

    visit(root);
    return out;
  }

  const Sniffer = {
    foundVideos: new Map(),
    pendingReport: new Map(),   // 批量上报缓冲
    observedElements: new WeakSet(),
    mediaRecorder: null,
    recordChunks: [],
    _recordStartTime: 0,
    _recordDataSize: 0,
    // v4.3.2 S-4：录制容量上限可配置。默认 2GB（保持旧行为），
    // 用户可在 chrome.storage.local 设 recordLimitBytes 覆盖（如
    // recordLimitBytes: 4*1024*1024*1024 提到 4GB）。init() 异步读取
    // 后写入此字段；录制开始时若尚未读到（极短窗口），用默认值兜底。
    _recordLimitBytes: 2 * 1024 * 1024 * 1024,
    _recordProgressTimer: null,
    _titleCache: null,
    _titleCacheTime: 0,
    _mutationQueue: [],
    _mutationTimer: null,
    _reportTimer: null,
    _lastScanUrl: location.href,

    init() {
      try { this.scanDOM(); } catch {}
      try { this.scanInlineScripts(); } catch {}
      try { this.observeDynamicContent(); } catch {}
      // v4.3.2 S-4：异步读取可配置录制上限（不阻塞 init 主路径）。
      // storage.get 不可用（测试环境/权限缺失）时保持默认 2GB 兜底；
      // 上限 64GB 防误设巨型值导致磁盘写爆。
      try {
        chrome.storage.local.get('recordLimitBytes').then((res) => {
          const v = res && res.recordLimitBytes;
          if (typeof v === 'number' && v > 0 && v <= 64 * 1024 * 1024 * 1024) {
            this._recordLimitBytes = v;
          }
        }).catch(() => {});
      } catch {}
    },

    // ============================================================
    // DOM 扫描
    // ============================================================
    scanDOM() {
      // v4.3.1 DeepSearch:递归遍历 open shadow root + 同源 iframe
      deepQuerySelectorAll(document, 'video').forEach(el => {
        try { this.processVideoElement(el); } catch {}
      });
      deepQuerySelectorAll(document, 'video source').forEach(el => {
        try { this.processSourceElement(el); } catch {}
      });
      deepQuerySelectorAll(document, '[data-video], [data-video-url], [data-media]').forEach(el => {
        try {
          const url = el.dataset.video || el.dataset.videoUrl || el.dataset.media;
          if (url && this.isVideoURL(url)) {
            this.queueReport({
              url: this.resolveURL(url),
              type: 'direct',
              format: this.getExtension(url),
              score: 50,
            });
          }
        } catch {}
      });
    },

    processVideoElement(el) {
      if (this.observedElements.has(el)) return;
      this.observedElements.add(el);

      const reportSrc = () => {
        const src = el.currentSrc || el.src;
        if (!src || src.startsWith('data:')) return;

        const isStream = /\.m3u8|\.mpd/i.test(src);
        const isBlob = src.startsWith('blob:');
        
        // 关键修复 v2.3：检测视频是否使用 MSE（MediaSource）
        // 如果是，说明真实视频数据通过 MSE 传输，currentSrc 只是 blob URL
        // 不应报告为"直链下载"（会得到空文件或预览片段）
        const isUsingMSE = isBlob || 
          (el.srcObject instanceof MediaSource) ||
          (typeof HTMLMediaElement !== 'undefined' && el.srcObject?.sourceBuffers?.length > 0);

        if (isBlob || isUsingMSE) {
          // MSE/Blob 视频：无法直接下载，只能录制或 MSE 捕获
          // 关键修复：不报告为 direct 类型（会误导用户下载预览片段）
          this.queueReport({
            url: src,
            type: 'mse',
            format: 'mse',
            duration: isFinite(el.duration) ? el.duration : null,
            width: el.videoWidth || null,
            height: el.videoHeight || null,
            score: 30,
          });
          return;
        }

        // 关键修复 v2.3：如果视频时长 > 60s 但 URL 是普通 HTTP，
        // 可能是预览/片段 URL（真实视频通过 MSE 传输）
        // 降低分数，让 MSE 捕获条目优先展示
        const duration = isFinite(el.duration) ? el.duration : null;
        const isLongVideo = duration && duration > 60;
        const baseScore = el.videoWidth > 0 ? 85 : (isStream ? 80 : 55);
        // 长视频 + 非流媒体 URL → 可能是预览，降低分数
        const finalScore = (isLongVideo && !isStream) ? Math.min(baseScore, 40) : baseScore;

        this.queueReport({
          url: src,
          type: isStream ? 'stream' : 'direct',
          format: this.getExtension(src),
          duration,
          width: el.videoWidth || null,
          height: el.videoHeight || null,
          score: finalScore,
        });
      };

      reportSrc();
      // 只监听一次 loadstart（source 变化时重新上报）
      el.addEventListener('loadstart', () => { try { reportSrc(); } catch {} }, { passive: true });
    },

    processSourceElement(el) {
      const src = el.src || el.getAttribute('src');
      if (!src) return;
      const type = el.type || '';
      const isStream = /\.m3u8|\.mpd/i.test(src) ||
                       type.includes('mpegurl') || type.includes('dash');
      this.queueReport({
        url: this.resolveURL(src),
        type: isStream ? 'stream' : 'direct',
        format: this.getExtension(src),
        mimeType: type || undefined,
        score: isStream ? 82 : 60,
      });
    },

    // ============================================================
    // 动态内容监听（批处理 + 节流）
    // ============================================================
    observeDynamicContent() {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            this._mutationQueue.push(node);
          }
        }
        // 批处理：250ms 合并一次
        if (this._mutationQueue.length && !this._mutationTimer) {
          this._mutationTimer = setTimeout(() => {
            this._mutationTimer = null;
            const nodes = this._mutationQueue.splice(0, 200);
            try { this.processBatch(nodes); } catch {}
          }, 250);
        }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });

      // SPA 路由变化检测
      const spaTimer = setInterval(() => {
        if (location.href !== this._lastScanUrl) {
          this._lastScanUrl = location.href;
          this._titleCache = null;
          setTimeout(() => {
            try { this.scanDOM(); } catch {}
            try { this.scanInlineScripts(); } catch {}
          }, 800);
        }
      }, 2000);

      // 页面卸载时清理所有观察者和定时器（防止内存泄漏）
      window.addEventListener('pagehide', () => {
        observer.disconnect();
        clearInterval(spaTimer);
        if (this._mutationTimer) { clearTimeout(this._mutationTimer); this._mutationTimer = null; }
        if (this._recordProgressTimer) { clearInterval(this._recordProgressTimer); this._recordProgressTimer = null; }
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
          try { this.mediaRecorder.stop(); } catch {}
        }
        this._stopRecordHelpers();
      });
    },

    processBatch(nodes) {
      for (const node of nodes) {
        if (node.tagName === 'VIDEO') {
          this.processVideoElement(node);
        } else if (node.querySelector || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          // v4.3.1 DeepSearch:动态插入的节点也可能含 shadow root / iframe
          deepQuerySelectorAll(node, 'video').forEach(el => this.processVideoElement(el));
          deepQuerySelectorAll(node, 'video source').forEach(el => this.processSourceElement(el));
        }
      }
    },

    // ============================================================
    // 内联脚本扫描（每次导航一次，总量限制）
    // ============================================================
    scanInlineScripts() {
      const patterns = [
        /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi,
        /https?:\/\/[^\s"'<>\\]+\.mpd[^\s"'<>\\]*/gi,
        /https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/gi,
      ];
      const scripts = document.querySelectorAll('script:not([src])');
      let scanned = 0;

      for (const script of scripts) {
        if (scanned >= 30) break; // 最多 30 个脚本
        const text = script.textContent;
        if (!text || text.length < 10) continue;
        scanned++;

        for (const pattern of patterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(text)) !== null) {
            const url = match[0].replace(/\\u002[fF]/g, '/');
            if (!JUNK_PATTERNS.some(p => p.test(url))) {
              const isStream = /\.m3u8|\.mpd/i.test(url);
              this.queueReport({
                url,
                type: isStream ? 'stream' : 'direct',
                format: this.getExtension(url),
                score: isStream ? 78 : 55,
              });
            }
          }
        }
      }
    },

    // ============================================================
    // 批量上报（300ms 一批，附页面标题）
    // ============================================================
    queueReport(info) {
      if (!info.url || info.url.length > 2048) return;
      if (this.foundVideos.has(info.url) || this.pendingReport.has(info.url)) return;

      // 上限保护：淘汰最早的
      if (this.foundVideos.size + this.pendingReport.size >= MAX_VIDEOS) {
        const firstKey = this.foundVideos.keys().next().value;
        if (firstKey) this.foundVideos.delete(firstKey);
      }

      // 直接使用网页标题
      info.name = this.getPageTitle();
      // 帧来源 Referer：iframe 内嗅探的流，防盗链校验的是
      // iframe 所在页。下载时经 msgBase 透传（DNR 注入用）
      if (!info.referer && /^https?:/i.test(location.protocol)) {
        info.referer = location.href;
      }
      this.pendingReport.set(info.url, info);

      if (!this._reportTimer) {
        this._reportTimer = setTimeout(() => {
          this._reportTimer = null;
          this.flushReports();
        }, 300);
      }
    },

    flushReports() {
      if (this.pendingReport.size === 0) return;
      const videos = [...this.pendingReport.values()];
      for (const v of videos) this.foundVideos.set(v.url, v);
      this.pendingReport.clear();

      chrome.runtime.sendMessage({ type: 'video-found', videos }).catch?.(() => {});
    },

    // 页面标题缓存 5 秒
    getPageTitle() {
      const now = Date.now();
      if (this._titleCache && now - this._titleCacheTime < 5000) {
        return this._titleCache;
      }
      let title = '';
      try {
        // 直接使用网页标题
        title = document.title || '未命名视频';
        // 去文件名非法字符
        title = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
      } catch { title = '未命名视频'; }
      this._titleCache = title.slice(0, 120) || '未命名视频';
      this._titleCacheTime = now;
      return this._titleCache;
    },

    // ============================================================
    // 录制（MediaRecorder 捕获）- 流捕获方案
    // 借鉴 FetchV / MPMux / CocoCut 三个参考插件的策略：
    //   不经过 canvas 逐帧绘制，直接从浏览器合成器或 MSE 层获取数据。
    //
    // 关键修正（v4.1）：captureStream() 作用于「渲染输出端」，受浏览器
    // 输出保护约束，对受加密保护的内容同样输出黑帧 —— 无法通过录制导出。
    // MSE 拦截点对加密内容拿到的也是密文，无法播放；此类内容的合法获取
    // 途径只有平台官方离线下载。录制在此场景下明确拒绝并如实告知用户。
    //
    // 录制方案（优先级从高到低，均仅适用于未加密内容）：
    //   1. video.captureStream()：捕获合成器输出，浏览器原生帧率
    //   2. canvas 中介（降级）：captureStream 不可用时回退
    //      到 drawImage + canvas.captureStream(0)
    //
    // 注意：captureStream 模式需要标签页保持可见
    // （后台时浏览器暂停合成器，帧率降低）
    // ============================================================
    startRecording(videoElement, recordId, recordSpeed) {
      try {
        const v = videoElement;
        const w = v.videoWidth || 1280;
        const h = v.videoHeight || 720;

        // 录制前诊断
        const isPlaying = !v.paused && !v.ended && v.readyState >= 2;
        const videoSrc = v.currentSrc || v.src || '';

        // v4.3.1 加速录制(借鉴 CocoCut timectr.js 思路):
        // 加速 playbackRate 让视频在更短时间内播放完毕,源码率不变但
        // 实际录制总耗时 = 视频时长 ÷ speed。不 hook Date/setInterval,
        // 避免被平台 JS 时间流速检测识别(有些站点检测 playbackRate 异常
        // 或 hook 后时间不连续)。用 ratechange 监听重新施加 rate,页面
        // 重置也能恢复。speed 上限 16(CocoCut 实测安全值)。
        const targetRate = (Number.isFinite(recordSpeed) && recordSpeed > 1 && recordSpeed <= 16)
          ? Math.floor(recordSpeed) : 1;
        this._recordTargetRate = targetRate;
        this._recordRateLock = false;

        if (targetRate > 1) {
          try {
            v.playbackRate = targetRate;
            // 关键:页面 JS 可能 reset playbackRate(常见反作弊)
            // ratechange 监听 + 防抖锁定,避免无限触发
            this._rateChangeHandler = () => {
              if (this._recordRateLock) return;
              if (Math.abs(v.playbackRate - targetRate) > 0.05) {
                this._recordRateLock = true;
                try { v.playbackRate = targetRate; } catch {}
                setTimeout(() => { this._recordRateLock = false; }, 200);
              }
            };
            v.addEventListener('ratechange', this._rateChangeHandler, { passive: true });
            console.log(`[VideoSniffer] 录制加速 ${targetRate}x 已启用,实际耗时 ≈ 视频时长 / ${targetRate}`);
          } catch (e) {
            console.warn('[VideoSniffer] playbackRate 设置失败,降级原速录制:', e?.message);
          }
        }

        // 关键修正 v4.1：加密保护预检测。HTMLMediaElement.mediaKeys 非空
        // 表示该元素已附着 MediaKeys（CDM 会话），即受加密保护。
        // 此类内容 captureStream() 与 canvas.drawImage() 均输出黑帧，
        // MSE 拦截得到的也是密文，均无法导出 —— 直接返回明确错误，
        // 引导用户使用平台官方离线下载。
        let isEncryptedProtected = false;
        try {
          isEncryptedProtected = !!(v.mediaKeys || v.getAttribute?.('data-drm'));
        } catch {}
        this._recordProtected = isEncryptedProtected;

        if (isEncryptedProtected) {
          console.warn('[VideoSniffer] 检测到加密保护内容（mediaKeys），captureStream 将输出黑帧，拒绝无意义录制');
          return {
            success: false,
            error: 'encrypted-protected',
            message: '该视频受加密保护，录制会得到黑屏，MSE 拦截拿到的也是加密数据，均无法导出。请使用平台官方离线下载功能',
          };
        }
        
        if (!isPlaying) {
          v.play().catch(() => {
            v.muted = true;
            v.play().catch(() => {});
          });
        }

        this._recordDiag = {
          isPlaying,
          videoSrc: videoSrc.slice(0, 100),
          videoWidth: v.videoWidth,
          videoHeight: v.videoHeight,
          duration: v.duration,
          playbackRate: v.playbackRate,
        };

        // ============================================================
        // 策略1：video.captureStream() 直接捕获（推荐）
        // 优势：捕获浏览器合成器输出，无需 canvas
        // 参考：FetchV 插件使用相同方案
        // ============================================================
        let stream = null;
        let usedCaptureStream = false;
        try {
          const capStream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
          const videoTracks = capStream.getVideoTracks();
          const audioTracks = capStream.getAudioTracks();
          
          if (videoTracks.length > 0) {
            // captureStream 成功获取到视频轨
            stream = capStream;
            usedCaptureStream = true;
            this._recordCaptureStream = capStream; // 保留引用以便清理
            console.log(`[VideoSniffer] 使用 captureStream() 直接捕获，视频轨=${videoTracks.length}，音频轨=${audioTracks.length}`);
          } else {
            // captureStream 可用但无视频轨（罕见），降级到 canvas
            console.warn('[VideoSniffer] captureStream() 无视频轨，降级到 canvas 方案');
            capStream.getTracks().forEach(t => t.stop()); // 清理
          }
        } catch (e) {
          console.warn('[VideoSniffer] captureStream() 不可用:', e.message, '，降级到 canvas 方案');
        }

        // ============================================================
        // 策略2：canvas 中介（降级方案）
        // ============================================================
        if (!stream) {
          this._recordCanvas = document.createElement('canvas');
          this._recordCanvas.width = w;
          this._recordCanvas.height = h;
          this._recordCtx = this._recordCanvas.getContext('2d', { alpha: false });
          
          // 测试 drawImage 是否可用
          let canvasTainted = false;
          try {
            this._recordCtx.drawImage(v, 0, 0, w, h);
            this._recordCtx.getImageData(0, 0, 1, 1);
          } catch (e) {
            if (e?.name === 'SecurityError') {
              canvasTainted = true;
              console.warn('[VideoSniffer] Canvas 被 CORS 污染，录制可能只有黑屏/音频');
            }
          }
          this._canvasTainted = canvasTainted;

          stream = this._recordCanvas.captureStream(0);
          const canvasTrack = stream.getVideoTracks()[0];
          this._recordStream = stream;

          // 音轨从 video.captureStream() 借
          try {
            const vStream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
            vStream.getAudioTracks().forEach(t => stream.addTrack(t));
          } catch {}

          this._recordVideoElement = v;
          // canvas 模式需要帧驱动
          this._canvasTrack = canvasTrack;
        }

        this._recordVideoElement = v;
        const hasAudio = stream.getAudioTracks().length > 0;

        // 自适应码率
        const pixels = w * h;
        let bitrate;
        if (pixels >= 3840 * 2160) bitrate = 50_000_000;
        else if (pixels >= 1920 * 1080) bitrate = 30_000_000;
        else if (pixels >= 1280 * 720) bitrate = 16_000_000;
        else if (pixels >= 854 * 480) bitrate = 8_000_000;
        else bitrate = 4_000_000;

        // 容器优先级：MP4/H.264/AAC → webm/vp9 → vp8 → 兜底
        const candidates = hasAudio ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ] : [
          'video/mp4;codecs=avc1.42E01E',
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm',
        ];
        const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
        const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
        this._recordExt = ext;

        this.recordChunks = [];
        this._recordStartTime = Date.now();
        this._recordDataSize = 0;
        this._recordLimitHit = false;   // v4.2.8：2GB 上限触发标志（防 ondataavailable 连发时重复停止/通知）

        this.mediaRecorder = new MediaRecorder(stream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: bitrate,
          audioBitsPerSecond: 128_000,
        });

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            this.recordChunks.push(e.data);
            this._recordDataSize += e.data.size;
            // v4.2.8：录制累计上限 —— 超限自动停止（旧版无上限，
            // 长视频录制把内存/磁盘写到耗尽）。走已有 stop 逻辑正常落盘，
            // 并页面通知用户截断原因。
            // v4.3.2 S-4：上限改用 _recordLimitBytes（可配置，默认 2GB），
            // 由 init() 从 chrome.storage.local.recordLimitBytes 读取覆盖。
            if (!this._recordLimitHit && this._recordDataSize >= this._recordLimitBytes) {
              this._recordLimitHit = true;
              this._notifyRecordLimit();
              try { this.stopRecording(); } catch {}
            }
          }
        };

        this.mediaRecorder.onstop = () => {
          if (this._recordProgressTimer) {
            clearInterval(this._recordProgressTimer);
            this._recordProgressTimer = null;
          }
          this._stopRecordHelpers();
          
          if (this.recordChunks.length === 0) {
            try {
              chrome.runtime.sendMessage({
                type: 'record-complete',
                recordId,
                error: 'no-data',
                message: '录制未捕获到任何数据。视频可能未播放，或受浏览器输出保护限制',
              });
            } catch {}
            return;
          }
          
          const blob = new Blob(this.recordChunks, { type: mimeType || 'video/webm' });
          
          if (blob.size < 100 * 1024) {
            console.warn(`[VideoSniffer] 录制文件过小 (${blob.size} bytes)，可能无法播放`);
          }
          
          const url = URL.createObjectURL(blob);
          const title = this.getPageTitle();
          const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
          const a = document.createElement('a');
          a.href = url;
          a.download = `录制_${title}_${ts}.${this._recordExt || 'webm'}`;
          a.click();
          // v4.2.8：revoke 5s → 5 分钟，对齐 MSE 导出路径 —— 大文件走浏览器
          // 下载管线时 5 秒内可能尚未读完 blob，提前 revoke 会得到截断文件
          setTimeout(() => URL.revokeObjectURL(url), 300000);
          this.recordChunks = [];
          this._recordDataSize = 0;

          try {
            chrome.runtime.sendMessage({
              type: 'record-complete',
              recordId,
              fileName: a.download,
              size: blob.size,
            });
          } catch {}
        };

        // captureStream 模式不需要分块太频繁（浏览器原生帧率）
        // canvas 模式仍需 500ms 分块
        this.mediaRecorder.start(usedCaptureStream ? 1000 : 500);

        // canvas 模式需要帧驱动 + 保活
        if (!usedCaptureStream) {
          this._startFrameDriver(v, this._canvasTrack, 30);
          this._startKeepAlive();
        }

        // 进度上报：每 3 秒通知录制状态
        this._recordProgressTimer = setInterval(() => {
          try {
            const elapsed = (Date.now() - this._recordStartTime) / 1000;

            // 视频保活
            const ve = this._recordVideoElement;
            if (ve && ve.paused && this.mediaRecorder?.state === 'recording') {
              ve.play().catch(() => {
                ve.muted = true;
                ve.play().catch(() => {});
              });
            }

            const dataRate = this._recordDataSize / Math.max(1, elapsed);
            const isBlackScreen = elapsed > 8 && dataRate < 50 * 1024;
            const isLowSpeed = elapsed > 8 && dataRate < 200 * 1024;

            chrome.runtime.sendMessage({
              type: 'record-progress',
              recordId,
              elapsed: Math.round(elapsed),
              dataSize: this._recordDataSize,
              dataRate,
              captureMode: usedCaptureStream ? 'captureStream' : 'canvas',
              ...(isBlackScreen ? { warning: true, warningType: 'black-screen' } : {}),
              ...(isLowSpeed && !isBlackScreen ? { warning: true, warningType: 'low-speed' } : {}),
              ...(this._canvasTainted ? { canvasTainted: true } : {}),
            });
          } catch {}
        }, 3000);

        return {
          success: true, recordId, bitrate,
          fps: usedCaptureStream ? 'native' : 30,
          codec: mimeType,
          captureMode: usedCaptureStream ? 'captureStream' : 'canvas',
        };
      } catch (err) {
        this._stopRecordHelpers();
        return { success: false, error: err.message };
      }
    },

    // Worker 驱动的 requestFrame 循环；Worker 被页面 CSP 拒绝时退回
    // 主线程 setInterval（后台会被节流到 1s/次，但聊胜于无）
    // draw 内含黑帧采样：受浏览器输出保护的内容经 drawImage 输出全黑画面，
    // VBR 下黑帧压缩后仅几十 kbps —— 这正是"录制只有 100 多 KB/s"却"画面全黑"的原因
    _startFrameDriver(video, canvasTrack, fps) {
      this._blackFrameCount = 0;
      this._blackFrameNotified = false;
      this._lastBlackCheck = 0;
      this._frameCount = 0;  // 关键修复 v2.3：记录实际绘制帧数，用于健康检查
      this._lastFrameTime = Date.now();
      
      const draw = () => {
        try {
          // 关键修复 v2.3：检测 canvas 是否被 CORS 污染
          // 如果视频跨域且无 CORS 头，drawImage 会抛出 SecurityError
          this._recordCtx.drawImage(video, 0, 0, this._recordCanvas.width, this._recordCanvas.height);
          canvasTrack.requestFrame?.();
          this._frameCount++;
          this._lastFrameTime = Date.now();
        } catch (e) {
          // canvas 被污染（CORS）或视频未就绪
          if (e?.name === 'SecurityError' && !this._corsWarned) {
            this._corsWarned = true;
            try {
              chrome.runtime.sendMessage({ type: 'record-cors-error' });
            } catch {}
          }
        }
        // 黑帧检测：每 ~2 秒采样一次（5 点采样，中央+四角内侧）
        const now = Date.now();
        if (now - this._lastBlackCheck > 2000) {
          this._lastBlackCheck = now;
          try {
            const { width: W, height: H } = this._recordCanvas;
            const pts = [[W>>1, H>>1], [W>>2, H>>2], [3*W>>2, H>>2], [W>>2, 3*H>>2], [3*W>>2, 3*H>>2]];
            let allBlack = true;
            for (const [x, y] of pts) {
              const d = this._recordCtx.getImageData(x, y, 1, 1).data;
              // 黑帧容差：保护内容黑帧并非严格 (0,0,0)，含少量压缩噪声
              if (d[0] > 24 || d[1] > 24 || d[2] > 24) { allBlack = false; break; }
            }
            if (allBlack) {
              this._blackFrameCount++;
              // 连续 5 次（≈10 秒）全黑 → 几乎必为保护内容，通知 UI
              if (this._blackFrameCount >= 5 && !this._blackFrameNotified) {
                this._blackFrameNotified = true;
                try {
                  chrome.runtime.sendMessage({ type: 'record-blackframe' });
                } catch {}
              }
            } else {
              this._blackFrameCount = 0;
            }
          } catch {}
        }
      };
      const interval = Math.max(16, Math.round(1000 / fps));
      
      // 关键修复 v2.3：Worker 健康检查
      // 如果 Worker 在 3 秒内没有产生任何帧，回退到主线程定时器
      this._workerHealthTimer = setTimeout(() => {
        if (this._frameCount === 0 && !this._frameTimer) {
          // Worker 未产生帧，回退到主线程定时器
          console.warn('[VideoSniffer] Worker 帧驱动未响应，回退到主线程定时器');
          this._frameTimer = setInterval(draw, interval);
        }
      }, 3000);

      // v4.3.2 S-4：rAF CPU 节流兜底。页面 JS 繁忙时 setInterval 会被
      // 浏览器降级到 ~1Hz，draw 调用骤减导致 canvas 录制丢帧/卡顿。
      // rAF 由浏览器在渲染时机调度，渲染优先级高于定时器，前台时更稳。
      // 6 秒（Worker 健康检查 3s + setInterval 观察 3s）后若仍 0 帧，且
      // 当前在用 setInterval，则切到 rAF 驱动；后台标签 rAF 自动暂停
      // （录制本就要求前台可见，不引入额外行为变化）。
      this._rAfFallbackTimer = setTimeout(() => {
        if (this._frameCount === 0 && this._frameTimer && !this._rAfLoop) {
          console.warn('[VideoSniffer] setInterval 仍被 CPU 节流，切到 rAF 驱动兜底');
          clearInterval(this._frameTimer);
          this._frameTimer = null;
          const rAfLoop = () => {
            // 录制已停止（_recordVideoElement 清空）→ 退出循环，不再调度
            if (!this._recordVideoElement) { this._rAfLoop = null; return; }
            draw();
            this._rAfLoop = requestAnimationFrame(rAfLoop);
          };
          this._rAfLoop = requestAnimationFrame(rAfLoop);
        }
      }, 6000);
      
      try {
        const src = `let t=null;onmessage=e=>{if(e.data==='start'){t=setInterval(()=>postMessage(1),${interval});}else{clearInterval(t);close();}}`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this._frameWorker = new Worker(url);
        // Worker 脚本异步加载，不能立即 revoke；停止时统一回收
        this._frameWorkerUrl = url;
        this._frameWorker.onmessage = draw;
        this._frameWorker.postMessage('start');
      } catch {
        // Worker 创建失败（CSP 限制），直接使用主线程定时器
        this._frameTimer = setInterval(draw, interval);
      }
    },

    _stopFrameDriver() {
      // 关键修复 v2.3：清理健康检查定时器
      if (this._workerHealthTimer) {
        clearTimeout(this._workerHealthTimer);
        this._workerHealthTimer = null;
      }
      // v4.3.2 S-4：清理 rAF 兜底定时器与循环句柄
      if (this._rAfFallbackTimer) {
        clearTimeout(this._rAfFallbackTimer);
        this._rAfFallbackTimer = null;
      }
      if (this._rAfLoop) {
        cancelAnimationFrame(this._rAfLoop);
        this._rAfLoop = null;
      }
      try { this._frameWorker?.postMessage('stop'); } catch {}
      try { this._frameWorker?.terminate(); } catch {}
      this._frameWorker = null;
      if (this._frameWorkerUrl) {
        try { URL.revokeObjectURL(this._frameWorkerUrl); } catch {}
        this._frameWorkerUrl = null;
      }
      if (this._frameTimer) { clearInterval(this._frameTimer); this._frameTimer = null; }
    },

    // 近无声振荡器：让浏览器把页面视为"正在播放音频"，从而
    // 不对后台标签执行媒体节流（视频解码继续 → drawImage 持续有新帧）。
    // autoplay policy：无手势时 AudioContext 创建后是 suspended，
    // 必须 resume() 才真正发声（否则保活无效）
    _startKeepAlive() {
      try {
        const ac = new AudioContext();
        const gain = ac.createGain();
        gain.gain.value = 0.00001;   // 近零增益，实际无声
        const osc = ac.createOscillator();
        osc.frequency.value = 1;     // 1Hz 次声，人耳不可闻
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start();
        ac.resume().catch(() => {});
        this._keepAliveAC = ac;
        this._keepAliveOsc = osc;
      } catch {}
    },

    _stopKeepAlive() {
      try { this._keepAliveOsc?.stop(); } catch {}
      try { this._keepAliveAC?.close(); } catch {}
      this._keepAliveAC = null;
      this._keepAliveOsc = null;
    },

    _stopRecordHelpers() {
      this._stopFrameDriver();
      this._stopKeepAlive();
      try { this._recordStream?.getTracks().forEach(t => t.stop()); } catch {}
      this._recordStream = null;
      this._recordVideoElement = null;
      this._recordCanvas = null;
      this._recordCtx = null;
    },

    // v4.2.8：录制达上限的页面通知（与 MSE 路径的右上角浮层同风格）
    // v4.3.2 S-4：上限可配置，文案按 _recordLimitBytes 换算显示
    _notifyRecordLimit() {
      try {
        const limitGb = (this._recordLimitBytes / (1024 * 1024 * 1024)).toFixed(0);
        const div = document.createElement('div');
        div.textContent = `录制已达 ${limitGb}GB 上限，已自动停止并保存当前已录数据`;
        div.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;'
          + 'background:#FF3B30;color:#fff;padding:12px 20px;border-radius:8px;'
          + 'font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:360px;';
        (document.body || document.documentElement).appendChild(div);
        setTimeout(() => div.remove(), 6000);
      } catch {}
    },

    stopRecording() {
      if (this._recordProgressTimer) {
        clearInterval(this._recordProgressTimer);
        this._recordProgressTimer = null;
      }
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      } else {
        this._stopRecordHelpers();
      }
    },

    // ============================================================
    // 工具
    // ============================================================
    isVideoURL(url) {
      if (JUNK_PATTERNS.some(p => p.test(url))) return false;
      return VIDEO_EXTS.has(this.getExtension(url));
    },

    getExtension(url) {
      const clean = String(url).split('?')[0].split('#')[0];
      const m = clean.match(/\.([a-z0-9]{1,5})$/i);
      return m ? m[1].toLowerCase() : 'video';
    },

    resolveURL(url) {
      try { return new URL(url, document.baseURI).href; } catch { return url; }
    },

    manualScan() {
      this.foundVideos.clear();
      this.pendingReport.clear();
      try { this.scanDOM(); } catch {}
      try { this.scanInlineScripts(); } catch {}
      this.flushReports();
    },
  };

  // v4.3.2 O-5：收窄 window 表面。旧版把完整 Sniffer 对象挂在
  // window.__VideoSniffer__，命名泛化易与第三方脚本/其他扩展注入的同名
  // 属性碰撞，且把 foundVideos / pendingReport / 内部方法全暴露给同域
  // 隔离世界。迁移到 __VideoSnifferInternal__ 明确标记"扩展内部专用，
  // 不对外稳定"，降低被外部依赖与误用的风险。content-script.js 已同步
  // 改用 __VideoSnifferInternal__。
  window.__VideoSnifferInternal__ = Sniffer;

  Sniffer.init();

  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => {
      setTimeout(() => {
        try { Sniffer.scanDOM(); } catch {}
        try { Sniffer.scanInlineScripts(); } catch {}
        try { Sniffer.flushReports(); } catch {}
      }, 500);
    }, { once: true });
  }
})();
