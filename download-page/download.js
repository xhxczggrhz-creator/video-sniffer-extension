/**
 * 视频嗅探器 - 下载页逻辑
 * 对接 v2 下载引擎（aria2 动态分段 + OPFS 直写）与流媒体下载器
 */

(function () {
  'use strict';

  // ============================================================
  // 反 iframe 嵌入（v4.2.8 安全加固）
  // manifest 未把 download.html 声明为 web_accessible_resources，外站正常
  // 无法嵌入本页；此处再兜底一层防御纵深：一旦被嵌入（未来配置失误/旧版本
  // 兼容），立即跳出并中止全部初始化 —— 下载页携带签名 URL/Referer 等敏感
  // 上下文，绝不允许在第三方文档里被动运行。
  // ============================================================
  if (window.self !== window.top) {
    try { window.top.location = window.location.href; } catch { /* 跨域拒绝：忽略 */ }
    document.documentElement.style.display = 'none';
    return; // 中止 IIFE：不注册任何监听、不发起任何下载
  }

  // ============================================================
  // 全局异常兜底：未捕获的 Promise 拒绝不再静默崩溃
  // ============================================================
  window.addEventListener('unhandledrejection', (event) => {
    // 阻止控制台噪音和潜在崩溃
    event.preventDefault();
    // 脱敏后记录
    const msg = String(event.reason?.message || event.reason || '').replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    console.error('[VideoSniffer] 未捕获异常:', msg);
  });

  // ============================================================
  // SW 保活：下载期间维持长连接，防止 Service Worker 被浏览器终止
  // 关键：MV3 SW 30s 空闲后会被挂起（不是杀掉，而是进入休眠），
  //       唤醒 SW 需要几百毫秒，且中间的 chrome.runtime.sendMessage
  //       会因为目标端尚未激活而失败/超时——这是"卡在 0% 半天不动"
  //       的最常见元凶。v4.2.7 修复：keepalive 断开后主动重连 + 周期性
  //       ping 防止 SW 进入空闲状态而触发挂起。
  // ============================================================
  let _keepalivePort = null;
  let _keepalivePingTimer = null;
  function startKeepalive() {
    try {
      if (_keepalivePort) return;
      _keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
      _keepalivePort.onDisconnect.addListener(() => {
        _keepalivePort = null;
        stopKeepalivePing();
        // 端口断开：可能是 SW 休眠后被踢。1s 后重连（SW 已重新激活）。
        setTimeout(startKeepalive, 1000);
      });
      // 周期性 ping（每 20s）：延长 SW 的活跃窗口，避免 30s 空闲被挂起
      startKeepalivePing();
    } catch (e) {
      // connect 异常（SWR 已被彻底杀掉）→ 立即重试
      _keepalivePort = null;
      setTimeout(startKeepalive, 1000);
    }
  }
  function startKeepalivePing() {
    stopKeepalivePing();
    _keepalivePingTimer = setInterval(() => {
      // 仅在端口存在时发心跳（receiver 不会真正消费，但消息本身唤醒 SW）
      try {
        _keepalivePort?.postMessage({ type: 'keepalive-ping' });
      } catch {
        // 端口死了 → onDisconnect 已处理重连
      }
    }, 20000);
  }
  function stopKeepalivePing() {
    if (_keepalivePingTimer) {
      clearInterval(_keepalivePingTimer);
      _keepalivePingTimer = null;
    }
  }
  function stopKeepalive() {
    stopKeepalivePing();
    try {
      if (_keepalivePort) { _keepalivePort.disconnect(); _keepalivePort = null; }
    } catch {}
  }

  // ============================================================
  // 全局消息监听：动态线程再分配 + 录制进度
  // （提前注册：任务数变化时 SW 广播的配额不能漏接）
  // ============================================================
  chrome.runtime.onMessage.addListener((msg) => {
    // 多任务公平调度：任务加入/结束时 SW 广播新配额，引擎动态增减 worker
    if (msg.type === 'conn-realloc' && engine?.adjustThreads) {
      // v4.2.7：SW 按 downloadId 精确分配配额，本任务按自身 ID 取。
      // 旧版广播单一 threadCount → 所有下载页被强制设为同一值，
      // 用户拖动高线程 + 多任务时瞬间被砍到几线程，速度断崖。
      const myQuota = (msg.allocations && msg.allocations[downloadId] != null)
        ? msg.allocations[downloadId]
        : msg.threadCount;
      if (myQuota != null) {
        engine.adjustThreads(myQuota);
        const threadsEl = document.getElementById('stat-threads');
        if (threadsEl) threadsEl.textContent = engine.threadCount;
      }
    }
    if (msg.type === 'record-progress' && msg.recordId === recordId) {
      updateRecordProgress(msg);
    }
    if (msg.type === 'record-blackframe') {
      // 画面全黑：录制出的文件没有画面，继续录制毫无意义，立即告知
      document.getElementById('record-status-text').textContent =
        t('dl_record_blackframe');
      const stopBtn = document.getElementById('stop-record-btn');
      if (stopBtn) {
        stopBtn.style.background = '#ff3b30';
        stopBtn.style.borderColor = '#ff3b30';
      }
    }
    // 关键修复 v2.3：CORS 错误警告 —— canvas 被跨域视频污染，无法录制
    if (msg.type === 'record-cors-error') {
      document.getElementById('record-status-text').textContent =
        t('dl_record_cors_warning');
      const stopBtn = document.getElementById('stop-record-btn');
      if (stopBtn) {
        stopBtn.style.background = '#ff3b30';
        stopBtn.style.borderColor = '#ff3b30';
      }
    }
    if (msg.type === 'record-complete' && msg.recordId === recordId) {
      handleRecordComplete(msg);
    }
  });

  const params = new URLSearchParams(window.location.search);
  const downloadId = params.get('id');
  const pid = params.get('pid');            // player 模式载荷键
  const mode = params.get('mode') || 'normal';

  // ---------- 元数据（非敏感，可经 URL 展示） ----------
  let videoName = params.get('name') || '';
  // v4.2.8 扩展名白名单：format 会拼进最终保存文件名与 RegExp，非白名单值
  // 一律回退 mp4（防扩展名注入 / 正则注入 / 离奇双扩展名社工文件名）
  const EXT_WHITELIST = new Set([
    'mp4', 'm3u8', 'mpd', 'ts', 'm4a', 'm4s', 'webm',
    'mkv', 'flv', 'mp3', 'aac', 'mov', 'avi', 'ogg', 'wav',
  ]);
  const _rawFormat = String(params.get('format') || 'mp4').trim().toLowerCase();
  const videoFormat = EXT_WHITELIST.has(_rawFormat) ? _rawFormat : 'mp4';
  const videoSize = parseInt(params.get('size')) || 0;
  let videoType = params.get('type') || 'direct';
  const videoTrack = params.get('track') || null;    // video | audio（DASH 双轨站点）
  const videoQuality = params.get('quality') || null; // 清晰度（如 1080p）
  const isPlayerMode = mode === 'player';
  const isRecordMode = mode === 'record';
  const isBiliMergeMode = mode === 'bili-merge';
  const recordId = params.get('recordId');
  const sourceTabId = params.get('tabId');
  const biliDuration = parseFloat(params.get('duration')) || 0;
  const biliDirectSize = parseInt(params.get('directSize')) || 0;

  // ============================================================
  // 输入消毒（v4.2.8 安全加固）
  // download.html 是扩展页，但其 URL 参数可被任意构造（他站链接/书签/被篡改
  // 的历史记录）。所有将参与 fetch、<video> 源或文件名的字段统一在此消毒：
  //   * 媒体 URL：仅放行 http(s):// 与 blob:（MSE 内存流）—— 阻断 javascript:
  //     data: file: chrome-extension: 等协议被注入到 fetch/播放器/代理
  //   * Referer 类 URL：仅放行 http(s)://
  //   * 文件扩展名：白名单（见 generateFileName），杜绝扩展名注入
  // ============================================================
  const SAFE_MEDIA_URL_RE = /^(https?|blob):/i;
  function sanitizeMediaUrl(u) {
    if (u == null || u === '') return null;
    const s = String(u).trim();
    return SAFE_MEDIA_URL_RE.test(s) ? s : null;
  }
  function sanitizeHttpUrl(u) {
    if (u == null || u === '') return null;
    const s = String(u).trim();
    return /^https?:/i.test(s) ? s : null;
  }
  // 非法 URL 被丢弃时如实告知（静默丢参会让"下载不动"变成无解之谜）
  const _droppedParams = [];
  function dropIfBad(current, sanitized, label) {
    if (current && !sanitized) _droppedParams.push(label);
    return sanitized;
  }

  // ---------- 敏感载荷（生死线：严禁下载内容泄露） ----------
  // 背景将 Cookie / Referer / 带防盗链签名 URL 存入
  // chrome.storage.session（不同步、读取即清除），URL 不再携带——
  // 防止写进浏览器历史或被任意站/扩展读取。这里先以 URL 参数兜底
  // （兼容旧链接），再由 loadPayload() 用存储载荷覆盖。
  // v4.2.8：URL 兜底值全部过消毒函数（协议白名单）。
  let videoUrl = dropIfBad(params.get('url'), sanitizeMediaUrl(params.get('url')), 'url');
  let videoReferer = dropIfBad(params.get('referer'), sanitizeHttpUrl(params.get('referer')), 'referer');
  // ---------- 敏感 B站 载荷（仅从 chrome.storage.session 读取，禁止 URL 兜底）----------
  // 安全审计修复（v4.3.2）：B站防盗链签名 URL 含敏感凭证，绝不能经 URL
  // 查询串传递（会进浏览器历史、被其他扩展读取、被录屏捕获）。
  // 全部初始化为空值，由 loadPayload() 从 storage.session 唯一读取并立即清除。
  // 旧版 URL 参数兜底已彻底移除（硬约束：URL parameter fallbacks must be removed）。
  // B站合并模式（videoUrl/audioUrl 含 CDN 防盗链签名，属敏感凭证）
  let biliVideoUrl = '';
  let biliAudioUrl = '';
  let biliVideoBackupUrl = '';
  let biliAudioBackupUrl = '';
  let biliDirectUrl = '';

  if (_droppedParams.length) {
    console.warn('[VideoSniffer] 已丢弃非法协议参数（仅支持 http/https/blob）:', _droppedParams.join(', '));
  }

  // 从 chrome.storage.session 读取敏感载荷并立即清除
  async function loadPayload() {
    const key = pid || downloadId;
    if (!key) return;
    let got = null;
    const storageKey = 'dldata_' + key;
    try {
      const s = await chrome.storage.session.get(storageKey);
      got = s[storageKey] || null;
    } catch {}
    if (got == null) {
      try {
        const l = await chrome.storage.local.get(storageKey);
        got = l[storageKey] || null;
      } catch {}
    }
    if (!got) return;
    // 读取即清除，杜绝敏感数据在存储中长期驻留
    try { await chrome.storage.session.remove(storageKey); } catch {}
    await chrome.storage.local.remove(storageKey).catch?.(() => {});
    if (got.url != null) videoUrl = got.url;
    if (got.referer != null) videoReferer = got.referer || null;
    if (got.videoUrl != null) biliVideoUrl = got.videoUrl;
    if (got.audioUrl != null) biliAudioUrl = got.audioUrl;
    if (got.videoBackupUrl != null) biliVideoBackupUrl = got.videoBackupUrl;
    if (got.audioBackupUrl != null) biliAudioBackupUrl = got.audioBackupUrl;
    if (got.directUrl != null) biliDirectUrl = got.directUrl;
    // videoName 兜底推导（原先依赖 videoUrl）
    if (!videoName && videoUrl) {
      try {
        const u = new URL(videoUrl);
        let last = u.pathname.split('/').filter(Boolean).pop() || '';
        last = decodeURIComponent(last.split('?')[0]).slice(0, 60);
        if (/^[a-zA-Z0-9_-]{8,}$/.test(last.replace(/\.\w+$/, ''))) videoName = u.hostname;
        else videoName = last || u.hostname;
      } catch { videoName = t('dl_unnamed_video'); }
    }
    if (!videoName) videoName = t('dl_unnamed_video');
  }

  let engine = null;
  let settings = {};
  let isPaused = false;
  let saveModeManualPending = false; // 手动保存模式：完成后等待用户点击
  let _displayedPercent = 0;         // 当前显示的进度（用于平滑动画插值）
  let _targetPercent = 0;            // 目标进度
  let _rafId = null;                 // requestAnimationFrame 句柄

  // ============================================================
  // OPFS 残留清理：清除上次异常退出遗留的临时文件
  // ============================================================
  function cleanupLeftoverOPFS() {
    try {
      if (!navigator.storage?.getDirectory) return;
      navigator.storage.getDirectory().then(async (root) => {
        try {
          const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
          // @ts-ignore - OPFS 异步迭代器
          for await (const [name, handle] of dir.entries()) {
            // 只清除超过 1 小时的残留文件（避免清掉正在进行的下载）
            try {
              const file = await handle.getFile();
              const age = Date.now() - file.lastModified;
              if (age > 3600000) {  // 1 小时
                await dir.removeEntry(name);
              }
            } catch {}
          }
        } catch {}
      }).catch(() => {});
    } catch {}
  }

  // ============================================================
  // 初始化
  // ============================================================
  async function init() {
    settings = await Storage.getSettings();
    // 读取并立即清除背景写入的敏感载荷（Cookie/签名 URL 等）
    await loadPayload();

    // OPFS 残留清理：每次打开下载页时清除上次可能泄漏的临时文件
    cleanupLeftoverOPFS();

    if (isPlayerMode) {
      initPlayer();
      return;
    }

    if (isRecordMode) {
      initRecordMode();
      return;
    }

    if (isBiliMergeMode) {
      initBiliMergeMode();
      return;
    }

    setupUI();
    applySettingsToUI();

    const callbacks = {
      onProgress: handleProgress,
      onStatusChange: handleStatusChange,
      onSpeedUpdate: handleSpeedUpdate,
      onComplete: handleComplete,
      onError: handleError,
    };

    const isStream = videoType === 'stream' ||
                     videoFormat === 'm3u8' ||
                     videoFormat === 'mpd' ||
                     /\.m3u8|\.mpd/i.test(videoUrl);

    if (isStream) {
      engine = new StreamDownloader({
        url: videoUrl,
        fileName: generateFileName('mp4'),  // 默认 mp4，最终按真实容器格式（fMP4/TS）修正
        format: videoFormat,
        downloadId: downloadId,
        threadCount: settings.threadCount,  // v4.2.7：尊重用户设定，不再强制最低 12
        maxThreads: 24,
        mode: mode,
        referer: videoReferer,
        ...callbacks,
      });
    } else {
      engine = new DownloadEngine({
        url: videoUrl,
        fileName: generateFileName(videoFormat),
        format: videoFormat,
        downloadId: downloadId,
        totalSize: videoSize,
        threadCount: settings.threadCount,
        maxThreads: 16,
        mode: mode,
        referer: videoReferer,
        speedBoost: settings.speedBoost,
        ...callbacks,
      });
    }

    // 统一入口：v2 引擎内部处理普通/强力两种模式
    startKeepalive();  // 下载期间保活 SW
    // B站等 DASH 站点音视频轨分离，同名条目里视频轨（300MB 级）与音频轨
    //（12MB 级）极易混淆 —— 误下音频轨正是"12 分钟视频只有 12MB"的根因，
    // 下载前后都明确告知
    const isAudioTrack = videoTrack === 'audio' || videoFormat === 'm4a';
    const isVideoTrack = videoTrack === 'video' || videoFormat === 'm4s';
    
    // 关键修复 v2.3：小文件（<10MB）可能是预览/片段，警告用户
    const isSmallFile = videoSize > 0 && videoSize < 10 * 1024 * 1024;
    if (isSmallFile && !isAudioTrack) {
      showToast(t('dl_warn_small_file', [Storage.formatSize(videoSize)]));
    } else if (isAudioTrack) {
      showToast(t('dl_note_audio_track'));
    } else if (isVideoTrack) {
      showToast(t('dl_note_video_track'));
    }
    await engine.start();
    stopKeepalive();   // 下载完成后释放
  }

  // ============================================================
  // 录制模式
  // ============================================================
  function initRecordMode() {
    document.getElementById('download-card').style.display = 'none';
    document.getElementById('record-card').style.display = '';
    document.getElementById('record-name').textContent = safeDecodeName(videoName);

    // 停止录制按钮
    document.getElementById('stop-record-btn').addEventListener('click', async () => {
      const btn = document.getElementById('stop-record-btn');
      btn.disabled = true;
      btn.querySelector('span').textContent = t('dl_saving');
      document.getElementById('record-status-text').textContent = t('dl_record_saving');
      try {
        await chrome.runtime.sendMessage({ type: 'stop-record', recordId });
      } catch {}
    });

    // 录制进度/完成消息已由顶层统一监听器处理（conn-realloc + record-*）

    // 提示录制本质：MediaRecorder 是实时捕获，速率 ≈ 视频码率（几百 KB/s 属正常），
    // 与直链/分段下载的"网速"不是一个概念 —— 引导用户优先使用更快的下载方式。
    // 关键修正 v4.1.2：受加密保护的内容录制必然黑屏；
    // 浏览器输出保护无法绕过，MSE 拦截拿到的也是密文，均无法导出，
    // 如实告知用户并引导官方离线下载。
    document.getElementById('record-status-text').textContent =
      t('dl_record_status_hint');
  }

  // ============================================================
  // B站合并下载模式：优先使用API直链（标准MP4），降级为DASH合并
  // 借鉴 bilibili下载助手 方案：调用/x/player/playurl获取durl直链，直接下载完整MP4
  // ============================================================
  async function initBiliMergeMode() {
    // 隐藏录制卡片，显示B站合并专用UI
    const downloadCard = document.getElementById('download-card');
    const recordCard = document.getElementById('record-card');
    if (recordCard) recordCard.style.display = 'none';
    if (downloadCard) {
      downloadCard.style.display = '';
    }

    const nameEl = document.getElementById('video-name');
    const statusEl = document.getElementById('status-text');
    const barEl = document.getElementById('progress-bar');
    const formatEl = document.getElementById('video-format');
    if (nameEl) nameEl.textContent = safeDecodeName(videoName);
    if (formatEl) formatEl.textContent = 'MP4';
    if (statusEl) statusEl.textContent = t('dl_preparing');

    startKeepalive();

    try {
      // ============================================================
      // 策略1：API直链下载（标准MP4，无需合并）
      // 借鉴 bilibili下载助手 方案：/x/player/playurl 返回 durl 直链
      // ============================================================
      if (biliDirectUrl) {
        console.log('[VideoSniffer] 使用B站API直链下载（标准MP4，无需合并）');
        if (statusEl) statusEl.textContent = t('dl_downloading_video');
        if (barEl) barEl.style.width = '5%';

        // P2 内存优化（v4.2.8）：旧实现 file.arrayBuffer() 把整个视频读进堆，
        // 再 new Blob([videoBuf]) 又复制一份 —— 1GB 视频内存峰值 2GB+，大文件
        // 直接把下载页 OOM 崩掉。现在 asFile 返回 OPFS File 句柄：
        //   * 校验只读前 16 字节
        //   * Blob([file]) 由磁盘背书（Chrome 不做整份堆拷贝）
        // 临时 OPFS 文件在下载触发 60s 后（与 revokeObjectURL 同窗口）回收。
        const direct = await downloadViaProxy(biliDirectUrl, '', videoReferer, { asFile: true });
        if (!direct || !direct.file || direct.file.size === 0) {
          throw new Error(t('dl_err_bili_direct_failed'));
        }
        const videoFile = direct.file;
        console.log(`[VideoSniffer] 视频下载成功: ${Storage.formatSize(videoFile.size)}`);

        // 验证文件格式（只切片头部 16 字节，不整读）
        const head = new Uint8Array(await videoFile.slice(0, 16).arrayBuffer());
        const hasFtyp = head.length >= 8 && head[4]===0x66 && head[5]===0x74 && head[6]===0x79 && head[7]===0x70;
        console.log('[VideoSniffer] 文件格式诊断:', { size: videoFile.size, isMP4: hasFtyp });
        if (!hasFtyp) {
          console.warn('[VideoSniffer] 直链响应不是 MP4（可能被 CDN 拦截返回错误页），转 DASH 合并策略');
          await removeOpfsTemp(direct.name);
          biliDirectUrl = ''; // 落入下方策略2
        } else {
          if (barEl) barEl.style.width = '95%';

          // 触发下载（Blob 引用 OPFS 文件，零整读、零堆拷贝）
          const safeTitle = safeDecodeName(videoName || t('dl_bili_video')).replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);
          const finalBlob = new Blob([videoFile], { type: 'video/mp4' });
          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${safeTitle}.mp4`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          // 60s 后回收对象 URL 与 OPFS 临时文件（下载已由浏览器接管）
          setTimeout(() => {
            URL.revokeObjectURL(url);
            removeOpfsTemp(direct.name);
          }, 60000);

          if (statusEl) statusEl.textContent = t('dl_done_file_size', [Storage.formatSize(finalBlob.size)]);
          if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#34C759'; }
          chrome.runtime.sendMessage({ type: 'unregister-download', downloadId }).catch?.(() => {});
          stopKeepalive();
          return;
        }
      }

      // ============================================================
      // 策略2：DASH合并降级（API未返回直链时）
      // 下载fMP4视频轨+音频轨，合并为标准MP4
      // ============================================================
      console.log('[VideoSniffer] API直链不可用，降级为DASH合并方案');
      if (formatEl) formatEl.textContent = t('dl_format_merged');

      // 0. 验证 URL 有效性
      if (!biliVideoUrl) throw new Error(t('dl_err_no_stream_url'));

      // 1. 通过 SW 代理下载视频流
      if (statusEl) statusEl.textContent = t('dl_downloading_video_stream');
      if (barEl) barEl.style.width = '10%';
      let videoBuf = await downloadViaProxy(biliVideoUrl, biliVideoBackupUrl, videoReferer);
      if (!videoBuf || videoBuf.byteLength === 0) {
        throw new Error(t('dl_err_bili_stream_failed'));
      }
      console.log(`[VideoSniffer] 视频流下载成功: ${Storage.formatSize(videoBuf.byteLength)}`);

      // 2. 通过 SW 代理下载音频流（如果有）
      let audioBuf = null;
      if (biliAudioUrl) {
        if (statusEl) statusEl.textContent = t('dl_downloading_audio_stream');
        if (barEl) barEl.style.width = '40%';
        audioBuf = await downloadViaProxy(biliAudioUrl, biliAudioBackupUrl, videoReferer);
        if (!audioBuf || audioBuf.byteLength === 0) {
          console.warn('[VideoSniffer] 音频流下载失败，仅保存视频轨');
          audioBuf = null;
        }
      }

      // 3. 合并音视频
      if (statusEl) statusEl.textContent = t('dl_merging_av');
      if (barEl) barEl.style.width = '70%';

      let finalBlob;
      if (audioBuf) {
        // P0-2（v4.2.8）：改用 lib/mp4-merger.js（window.__VideoSnifferMerger__）。
        // 旧版页内合并器（已删除）存在 stbl 替换静默失效、stco 偏移少写 8
        // 字节、mvhd next_track_id 写错字段等多处必坏文件缺陷，且与 lib 版
        // 重复维护 —— 合并失败的"有声无画/放不出来"多数源自它。
        finalBlob = mergeAvToMp4Blob(videoBuf, audioBuf);
        // P2 内存：合并结果是独立拷贝，源缓冲立即断引用，
        // 1GB 视频轨场景可提前回收约一半峰值内存
        videoBuf = null;
        audioBuf = null;
      } else {
        // 仅有视频轨：fMP4 的 moof/mdat 序列多数播放器不认，
        // 单轨也转成标准 MP4（已是标准 MP4 则原样保存）
        finalBlob = convertSingleToBlob(videoBuf);
        videoBuf = null;
      }

      if (barEl) barEl.style.width = '95%';

      // 4. 触发下载
      const safeTitle = safeDecodeName(videoName || t('dl_bili_video')).replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);
      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeTitle}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      if (statusEl) statusEl.textContent = t('dl_merge_done_file_size', [Storage.formatSize(finalBlob.size)]);
      if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#34C759'; }

      // 通知 SW 清理下载记录
      chrome.runtime.sendMessage({ type: 'unregister-download', downloadId }).catch?.(() => {});
    } catch (err) {
      console.error('[VideoSniffer] B站合并下载失败:', err);
      // 脱敏：错误文本里的 URL 一律替换（B站直链带签名参数，不能外泄到页面）
      const safeMsg = String(err?.message || t('dl_unknown_error')).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
      if (statusEl) statusEl.textContent = t('dl_download_failed_msg', [safeMsg]);
      if (barEl) { barEl.style.width = '100%'; barEl.style.background = '#FF3B30'; }
      // P1-D（v4.2.8）：B站合并模式没有 engine 实例，setupUI 也未执行，
      // 旧版"失败后点暂停按钮=重试"对本模式完全无效（按钮无监听）——
      // 显式把暂停按钮绑定为重试入口，失败可一键重跑全流程
      bindBiliRetry(statusEl);
    }

    stopKeepalive();
  }

  // P1-D：B站合并失败后的重试按钮（once: 单次绑定，重试失败会再绑）
  function bindBiliRetry(statusEl) {
    const pauseBtn = document.getElementById('pause-btn');
    if (!pauseBtn) return;
    pauseBtn.disabled = false;
    const label = document.getElementById('pause-label');
    if (label) label.textContent = t('dl_retry');
    pauseBtn.addEventListener('click', () => {
      if (label) label.textContent = t('dl_retrying');
      pauseBtn.disabled = true;
      if (statusEl) statusEl.textContent = t('dl_retry_in_progress');
      // 重新走完整流程（直链策略会因上轮清空 biliDirectUrl 直接进 DASH 合并，
      // 避免在同一失败直链上原地打转）
      initBiliMergeMode();
    }, { once: true });
  }

  // 通过 Service Worker 代理下载文件（绕过 CORS）
  // SW 写入 OPFS → 下载页从 OPFS 读取（避免大数组通过消息传递损坏）
  // v4.2.8（P1-C 超时对齐 + P2 asFile）：
  //   * SW 端 proxy-fetch-full 用的是「30s 停滞看门狗」而非总超时 —— 只要
  //     数据在流动（大文件慢速链路可能持续数分钟）就不打断。本页对齐为
  //     15 分钟兜底上限：正常大文件永远跑不到，但 SW 被杀/消息通道假死时
  //     不再无限挂起（旧版无任何超时，"卡在正在下载视频流"半天无解）。
  //   * 直连兜底 fetch 补 60s AbortController + credentials:'omit'
  //     （隐私最小化：不给任意 CDN 发 Cookie）。
  //   * opts.asFile=true 时不整读进堆，返回 { file, name }（磁盘背书 Blob，
  //     由调用方在用完后 removeOpfsTemp(name) 回收）。
  const PROXY_FULL_HARD_CAP_MS = 15 * 60 * 1000;
  const DIRECT_FALLBACK_TIMEOUT_MS = 60000;

  async function downloadViaProxy(url, backupUrl, referer, opts = {}) {
    const asFile = !!(opts && opts.asFile);
    const tryFetch = async (targetUrl) => {
      // 策略 1：通过 SW 代理下载（携带 Referer，写入 OPFS）
      let response;
      try {
        response = await Promise.race([
          chrome.runtime.sendMessage({
            type: 'proxy-fetch-full',
            url: targetUrl,
            referer: referer || 'https://www.bilibili.com/',
          }),
          // P1-C：兜底硬上限（对齐 SW 停滞看门狗语义，见上方注释）
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('SW 代理下载超时（15 分钟兜底上限）')),
            PROXY_FULL_HARD_CAP_MS
          )),
        ]);
      } catch (e) {
        console.warn('[VideoSniffer] SW 代理通信失败:', e?.message);
      }

      // 消息中枢包装了一层：response = { success, data: handlerResult }
      const handlerResult = response?.data || response;

      if (handlerResult?.success && handlerResult.opfsFileName) {
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
          const fh = await dir.getFileHandle(handlerResult.opfsFileName);
          const file = await fh.getFile();
          if (asFile) {
            // P2：不整读。临时文件交由调用方在下载落盘后回收（removeOpfsTemp）
            console.log(`[VideoSniffer] OPFS 文件就绪: ${handlerResult.opfsFileName}, ${file.size} bytes`);
            return { file, name: handlerResult.opfsFileName };
          }
          const buf = await file.arrayBuffer();
          console.log(`[VideoSniffer] OPFS 读取成功: ${handlerResult.opfsFileName}, ${buf.byteLength} bytes`);
          try { await dir.removeEntry(handlerResult.opfsFileName); } catch {}
          return buf;
        } catch (e) {
          console.warn('[VideoSniffer] OPFS 读取失败:', e?.message);
          // 读取失败也要清掉 SW 落盘的临时文件，防孤儿堆积
          removeOpfsTemp(handlerResult.opfsFileName);
        }
      }

      // 策略 2：SW 代理失败，尝试直接 fetch（某些 CDN 允许跨域）
      if (!handlerResult?.success) {
        console.warn('[VideoSniffer] SW 代理失败:', handlerResult?.error || '未知错误');
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => {
          ctrl.abort(new Error('直连回退请求超时'));
        }, DIRECT_FALLBACK_TIMEOUT_MS);
        try {
          const directResp = await fetch(targetUrl, {
            mode: 'cors',
            redirect: 'follow',
            credentials: 'omit', // 隐私最小化：不向 CDN 发送 Cookie
            signal: ctrl.signal,
          });
          if (directResp.ok) {
            console.log('[VideoSniffer] 直接 fetch 成功（回退模式）');
            const buf = await directResp.arrayBuffer();
            return asFile ? { file: new File([buf], 'direct.bin', { type: 'video/mp4' }), name: null } : buf;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.warn('[VideoSniffer] 直接 fetch 也失败:', e?.message);
      }

      return null;
    };

    let result = await tryFetch(url);
    if (!result && backupUrl) {
      console.warn('[VideoSniffer] 主URL下载失败，尝试备用URL');
      result = await tryFetch(backupUrl);
    }
    return result;
  }

  // 删除 vs-downloads 目录下的 SW 代理临时文件（asFile 模式的回收通道）
  async function removeOpfsTemp(name) {
    if (!name) return;
    try {
      if (!navigator.storage?.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
      await dir.removeEntry(name);
    } catch { /* 已不存在/并发删除：幂等 */ }
  }

  // ============================================================
  // v4.2.8（P0-2）：fMP4 合并统一收敛到 lib/mp4-merger.js
  // 本页原内嵌合并器（parseBoxes / convertFmp4ToStandard / rebuildMoov /
  // mergeStandardMp4 / adjustStcoInTrak 等约 600 行）已整体删除。旧实现
  // 存在多处必然产出坏文件的缺陷：stbl 替换静默失效（含 header 的 raw trak
  // 直接传 parseBoxes）、stco 偏移写回少 8 字节、mvhd next_track_id 写错
  // 字段位置、忽略 trun composition offset（B 帧时序错乱）、样本提取假设
  // 「mdat 载荷 == 样本连续排布」。与 lib 版双份维护只会让「合并出的文件
  // 放不出来」反复回归。lib 版经 content script 与本页 <script> 双通道注入，
  // 暴露为 window.__VideoSnifferMerger__。
  // ============================================================
  function mergeAvToMp4Blob(videoBuf, audioBuf) {
    const merger = window.__VideoSnifferMerger__;
    if (!merger || typeof merger.mergeAvToMp4 !== 'function') {
      throw new Error(t('dl_err_merger_missing'));
    }
    const r = merger.mergeAvToMp4(new Uint8Array(videoBuf), new Uint8Array(audioBuf));
    if (r && r.error) throw new Error(explainMergeError(r.error));
    if (!r || !r.blob) throw new Error(t('dl_err_merge_no_output'));
    return r.blob;
  }

  // 单轨 fMP4 → 标准 MP4；输入已是标准 MP4（无 moof）则原样返回
  function convertSingleToBlob(buf) {
    const merger = window.__VideoSnifferMerger__;
    if (!merger || typeof merger.convertSingle !== 'function') {
      return new Blob([buf], { type: 'video/mp4' });
    }
    const r = merger.convertSingle(new Uint8Array(buf));
    if (r && r.blob) return r.blob;
    // 不是 fMP4 / 结构不完整：按原始数据保存（用户至少拿到原轨）
    console.warn('[VideoSniffer] 单轨转换失败，按原始数据保存:', r?.error);
    return new Blob([buf], { type: 'video/mp4' });
  }

  function explainMergeError(err) {
    if (err === 'encrypted') {
      return t('dl_err_merge_encrypted');
    }
    return String(err || t('dl_unknown_merge_error'));
  }

  function updateRecordProgress(data) {
    const elapsed = data.elapsed || 0;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    document.getElementById('record-elapsed').textContent =
      `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    document.getElementById('record-size').textContent =
      Storage.formatSize(data.dataSize || 0);
    document.getElementById('record-rate').textContent =
      `${Storage.formatSize(data.dataRate || 0)}/s`;

    // 关键修复 v2.3：区分不同类型的警告
    const statusText = document.getElementById('record-status-text');
    if (data.warning) {
      if (data.warningType === 'black-screen') {
        // <50KB/s：几乎必然是黑屏内容
        statusText.textContent =
          t('dl_record_warn_low_rate');
      } else if (data.warningType === 'low-speed') {
        // <200KB/s：可能是 canvas 污染或低码率视频
        let msg;
        if (data.canvasTainted) {
          msg = t('dl_record_warn_cors');
        } else if (data.videoPaused) {
          msg = t('dl_record_warn_paused');
        } else {
          msg = t('dl_record_warn_generic');
        }
        statusText.textContent = msg;
      }
    }
  }

  function handleRecordComplete(data) {
    const bar = document.getElementById('record-bar');
    const statusText = document.getElementById('record-status-text');
    const btn = document.getElementById('stop-record-btn');
    
    // 关键修复 v2.3：处理录制失败情况
    if (data.error === 'no-data') {
      bar.style.animation = 'none';
      bar.style.background = '#ff3b30';
      bar.style.width = '100%';
      statusText.textContent = t('dl_record_failed', [data.message || t('dl_no_data_captured')]);
      btn.disabled = true;
      btn.querySelector('span').textContent = t('dl_failed');
      return;
    }
    
    bar.style.animation = 'none';
    bar.style.background = '#4caf50';
    bar.style.width = '100%';
    statusText.textContent = t('dl_record_done', [
      data.fileName || t('dl_record_default_name'),
      Storage.formatSize(data.size || 0),
    ]);
    btn.disabled = true;
    btn.querySelector('span').textContent = t('dl_saved');

    Storage.addHistory({
      id: recordId,
      fileName: data.fileName || t('dl_record_default_name'),
      url: t('dl_record_tag'),
      size: data.size || 0,
      status: 'completed',
    }).catch?.(() => {});

    if (chrome.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: t('dl_notification_record_done'),
        message: t('dl_notification_record_saved', [data.fileName || t('dl_record_default_name')]),
      }).catch?.(() => {});
    }
  }

  // ============================================================
  // UI
  // ============================================================
  function setupUI() {
    document.getElementById('video-name').textContent = safeDecodeName(videoName);
    document.getElementById('video-format').textContent = videoFormat.toUpperCase();
    document.getElementById('video-size').textContent =
      videoSize ? Storage.formatSize(videoSize) : t('dl_detect_on_download');
    const urlEl = document.getElementById('video-url-display');
    urlEl.textContent = truncateURL(videoUrl, 60);
    urlEl.title = videoUrl;

    // v4.2.7：标签页标题初始化为视频名（下载中会被 handleProgress 替换为带进度）
    resetTabTitle();

    document.getElementById('stat-total').textContent =
      videoSize ? Storage.formatSize(videoSize) : '--';
    document.getElementById('stat-threads').textContent = settings.threadCount;

    document.getElementById('pause-btn').addEventListener('click', togglePause);
    document.getElementById('settings-btn').addEventListener('click', toggleSettings);
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('settings-close').addEventListener('click', toggleSettings);
    document.getElementById('clear-cache-btn').addEventListener('click', clearCache);
    document.getElementById('save-cache-btn').addEventListener('click', saveCachedFile);

    document.getElementById('setting-filename-mode').addEventListener('change', (e) => {
      document.getElementById('setting-custom-name').style.display =
        e.target.value === 'custom' ? 'block' : 'none';
    });

    // v4.2.7 修复：所有设置控件「拖动/切换即生效」，无需手动点保存按钮。
    // 旧 bug：oninput 只改 <span> 显示数字，没存 storage、没通知引擎，
    // 用户以为拖了就有用、其实 storage.threadCount 还是默认 8，
    // SW 按 8 分配线程 → 滑块"跟假的一样" + 用户感受多任务卡顿。
    setupLiveSettingsBindings();

    // 退出页面：清理缓存（用户需求：退出自动清除）
    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);

    // 兼容保存模式
    if (settings.saveMode === 'manual') {
      // 引擎完成时不自动保存 —— onComplete 里处理
    }
  }

  function applySettingsToUI() {
    document.getElementById('setting-threads').value = settings.threadCount;
    document.getElementById('threads-display').textContent = settings.threadCount;
    document.getElementById('setting-filename-mode').value = settings.fileNameMode;
    document.getElementById('setting-save-location').value = settings.saveLocation;
    document.getElementById('setting-save-mode').value = settings.saveMode;
    document.getElementById('setting-clear-on-exit').checked = settings.clearCacheOnExit;
    document.getElementById('setting-speed-boost').checked = settings.speedBoost;
    document.getElementById('setting-privacy-mode').checked = settings.privacyMode !== false;

    if (settings.fileNameMode === 'custom') {
      document.getElementById('setting-custom-name').style.display = 'block';
      document.getElementById('setting-custom-name').value = settings.customName || '';
    }
  }

  // v4.2.7：实时绑定 — 拖动/切换即生效（无需点保存按钮）
  // 旧实现：所有 form 控件只挂到 DOM，change 事件只更新 <span> 显示数字，
  // 必须点底部"保存设置"按钮才把表单值写入 storage。
  // → 用户拖了滑块、看到数字变了，但 storage.threadCount 还是默认 8，
  //   SW 按 8 分配线程（与用户拖到 12/16 完全无关）— "自由滑动跟假一样"。
  let _liveSettingsTimer = null;
  function applySettingsLive() {
    // 1. 收集表单当前值
    const newSettings = {
      threadCount: parseInt(document.getElementById('setting-threads').value),
      fileNameMode: document.getElementById('setting-filename-mode').value,
      saveLocation: document.getElementById('setting-save-location').value,
      saveMode: document.getElementById('setting-save-mode').value,
      clearCacheOnExit: document.getElementById('setting-clear-on-exit').checked,
      speedBoost: document.getElementById('setting-speed-boost').checked,
      privacyMode: document.getElementById('setting-privacy-mode').checked,
    };
    const customName = document.getElementById('setting-custom-name').value.trim();
    if (customName) newSettings.customName = customName;

    // 2. 即时更新内存中的 settings，供后续逻辑使用
    settings = { ...settings, ...newSettings };

    // 3. 即时写 storage（用 fire-and-forget：不阻塞 UI、保存按钮用户可点可不点）
    Storage.saveSettings(newSettings).catch?.(() => {});

    // 4. 即时通知引擎调线程（核心：以前这一步被锁在"保存"按钮里、
    //    现在拖动滑块松手 engine.threadCount 立即同步）
    if (engine) {
      engine._userThreadCount = settings.threadCount;
      engine.speedBoost = settings.speedBoost;  // speedBoost 也是实时生效
      if (typeof engine.adjustThreads === 'function') {
        engine.adjustThreads(settings.threadCount);
      }
      if (document.getElementById('stat-threads')) {
        document.getElementById('stat-threads').textContent = engine.threadCount;
      }
    }
  }

  function setupLiveSettingsBindings() {
    const threadsEl = document.getElementById('setting-threads');
    const displayEl = document.getElementById('threads-display');
    if (threadsEl) {
      // 拖动过程：实时刷新显示数字（不每次都调引擎，避免 worker spawn 风暴）
      threadsEl.addEventListener('input', () => {
        if (displayEl) displayEl.textContent = threadsEl.value;
      });
      // 松手/键盘步进：debounce 150ms 后真正生效（写 storage + 调引擎）
      threadsEl.addEventListener('change', () => {
        clearTimeout(_liveSettingsTimer);
        _liveSettingsTimer = setTimeout(applySettingsLive, 150);
      });
    }
    // 其余控件（select / checkbox）：change 即时生效
    ['setting-filename-mode', 'setting-save-location', 'setting-save-mode',
     'setting-clear-on-exit', 'setting-speed-boost', 'setting-privacy-mode']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', applySettingsLive);
      });
    // 自定义文件名：input 事件即时生效（debounce 300ms）
    const customNameEl = document.getElementById('setting-custom-name');
    if (customNameEl) {
      let _customTimer = null;
      customNameEl.addEventListener('input', () => {
        clearTimeout(_customTimer);
        _customTimer = setTimeout(applySettingsLive, 300);
      });
    }
  }

  // ============================================================
  // 进度（引擎已节流至 200ms 一次，这里直接更新即可）
  // ============================================================
  // 平滑进度动画：用 requestAnimationFrame 插值，避免数字跳动
  function startProgressAnimation() {
    if (_rafId) return;
    const animate = () => {
      const diff = _targetPercent - _displayedPercent;
      if (Math.abs(diff) < 0.1) {
        _displayedPercent = _targetPercent;
      } else {
        _displayedPercent += diff * 0.15; // 缓动系数
      }
      const bar = document.getElementById('progress-bar');
      const glow = document.getElementById('progress-glow');
      const pct = document.getElementById('progress-percentage');
      if (bar) bar.style.width = `${_displayedPercent}%`;
      if (glow) glow.style.left = `${_displayedPercent}%`;
      if (pct) pct.textContent = `${_displayedPercent.toFixed(1)}%`;

      if (_displayedPercent < _targetPercent || Math.abs(diff) >= 0.1) {
        _rafId = requestAnimationFrame(animate);
      } else {
        _rafId = null;
      }
    };
    _rafId = requestAnimationFrame(animate);
  }

  function handleProgress(data) {
    const downloaded = data.downloaded || 0;

    let percent = 0;
    if (data.segmentProgress) {
      const { completed, total: segTotal } = data.segmentProgress;
      // v4.3.16 UI 保险丝：completed 理论 ≤ total，任何越界（引擎计数 bug /
      // 旧页面旧 JS 竞态）只钳到 100%，不再显示 131/128 段 / 102.3%
      const clamped = Math.min(completed, segTotal);
      percent = segTotal > 0 ? Math.min(100, (clamped / segTotal) * 100) : 0;
    } else if (data.total > 0) {
      percent = Math.min(100, (downloaded / data.total) * 100);
    }

    _targetPercent = percent;
    startProgressAnimation();

    // v4.2.7：标签页标题实时显示进度（任务卡可见性）
    updateTabTitle(percent, data);

    if (data.segmentProgress) {
      const { completed, total: segTotal } = data.segmentProgress;
      // v4.3.16：与 percent 同口径钳制（completed ≤ total）
      const clamped = Math.min(completed, segTotal);
      document.getElementById('progress-fraction').textContent = t('dl_progress_fraction_segments', [clamped, segTotal]);
      document.getElementById('stat-total').textContent = t('dl_stat_total_segments', [segTotal]);
    } else {
      document.getElementById('progress-fraction').textContent =
        `${Storage.formatSize(downloaded)} / ${Storage.formatSize(data.total)}`;
      document.getElementById('stat-total').textContent =
        data.total > 0 ? Storage.formatSize(data.total) : '--';
    }

    document.getElementById('stat-downloaded').textContent = Storage.formatSize(downloaded);

    if (data.connections !== undefined) {
      document.getElementById('stat-threads').textContent = data.connections;
    }

    renderChunks(data.pieces);
  }

  // ============================================================
  // v4.2.7 新增：下载页标签卡实时显示下载进度（几分之几）
  // 流媒体 → "(23/200) 视频名"；直链 → "(45%) 视频名"
  // 内部节流：title 只在进度变化 ≥1% 或段数变化时才更新，
  // 避免 200ms 节流下仍频繁重绘标签标题
  // ============================================================
  let _lastTitleSig = '';
  function updateTabTitle(percent, data) {
    try {
      const seg = data?.segmentProgress;
      const segTotal = seg?.total || 0;
      // v4.3.16：标签页标题同步钳制（completed ≤ total）
      const completed = Math.min(seg?.completed || 0, segTotal);
      const totalBytes = data?.total || 0;
      const downloaded = data?.downloaded || 0;

      // 进度签名：段数模式用 "段/总段"，直链模式用 整数百分比 + 已下载字节高两位
      let progress = '';
      let sig;
      if (segTotal > 0) {
        progress = `(${completed}/${segTotal}) `;
        sig = `s${completed}/${segTotal}`;
      } else if (totalBytes > 0) {
        const pct = Math.min(99, Math.max(0, Math.round(percent)));
        progress = `(${pct}%) `;
        // 直链用百分比 + 已下载高两位字节做变化检测（避免巨文件每 200ms 都更新 title）
        sig = `b${pct}:${Math.floor(downloaded / 1024 / 1024)}`;
      } else {
        sig = 'p' + Math.min(99, Math.round(percent));
      }
      if (sig === _lastTitleSig) return;  // 无变化不重绘
      _lastTitleSig = sig;

      const name = safeDecodeName(videoName || t('dl_downloading')).slice(0, 40);
      document.title = `${progress}${name}`;
    } catch {}
  }

  // 标题复位（完成/错误/暂停时调用）
  function resetTabTitle(suffix = '') {
    try {
      _lastTitleSig = '';
      const name = safeDecodeName(videoName || t('dl_video_download')).slice(0, 40);
      document.title = suffix ? `${suffix} ${name}` : name;
    } catch {}
  }

  function handleSpeedUpdate(data) {
    document.getElementById('stat-speed').textContent = data.speedFormatted || '0 B/s';
    document.getElementById('stat-eta').textContent = data.eta || '--:--';
  }

  function handleStatusChange(status) {
    const pauseBtn = document.getElementById('pause-btn');
    const pauseLabel = document.getElementById('pause-label');
    const pauseIcon = document.getElementById('pause-icon');
    const saveCacheBtn = document.getElementById('save-cache-btn');

    document.getElementById('status-indicator').className = 'status-indicator ' + status;

    const statusMessages = {
      'idle': t('dl_status_idle'),
      'preparing': t('dl_status_preparing'),
      'probing': t('dl_status_probing'),
      'manifest': t('dl_status_manifest'),
      'downloading': t('dl_status_downloading'),
      'paused': t('dl_status_paused'),
      'merging': t('dl_status_merging'),
      'converting': t('dl_status_converting'),
      'done': t('dl_status_done'),
      'error': t('dl_status_error'),
    };
    document.getElementById('status-text').textContent = statusMessages[status] || status;

    // v4.2.7：标签页标题随状态复位（downloading 阶段由 handleProgress 持续更新）
    if (status === 'done') {
      resetTabTitle(t('dl_tab_title_done'));
    } else if (status === 'error') {
      resetTabTitle(t('dl_tab_title_failed'));
    } else if (status === 'paused') {
      resetTabTitle(t('dl_tab_title_paused'));
    } else if (status === 'merging') {
      resetTabTitle(t('dl_tab_title_merging'));
    } else if (status === 'converting') {
      resetTabTitle(t('dl_tab_title_converting'));
    } else if (status === 'downloading') {
      // 进入下载阶段：清掉旧签名，让 handleProgress 重新开始带进度更新
      _lastTitleSig = '';
    }

    if (status === 'downloading') {
      pauseBtn.disabled = false;
      pauseLabel.textContent = t('dl_pause');
      pauseIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      saveCacheBtn.style.display = 'none';
    } else if (status === 'paused') {
      pauseBtn.disabled = false;
      pauseLabel.textContent = t('dl_resume');
      pauseIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
      saveCacheBtn.style.display = 'inline-flex';
    } else if (status === 'done') {
      pauseBtn.disabled = true;
      pauseLabel.textContent = t('dl_completed');
      saveCacheBtn.style.display = 'none';
    } else if (status === 'merging' || status === 'converting') {
      pauseBtn.disabled = true;
    } else {
      pauseBtn.disabled = false;
    }
  }

  async function handleComplete(result) {
    _targetPercent = 100;
    _displayedPercent = 100;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    document.getElementById('progress-bar').style.width = '100%';
    document.getElementById('progress-glow').style.left = '100%';
    document.getElementById('progress-percentage').textContent = '100%';
    // v4.2.7：下载完成 → 标签标题复位
    resetTabTitle(t('dl_tab_title_done'));

    Storage.addHistory({
      id: downloadId,
      fileName: result.fileName,
      url: videoUrl,
      size: result.totalSize,
      status: 'completed',
    }).catch?.(() => {});

    if (chrome.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: t('dl_notification_done'),
        message: t('dl_notification_saved', [result.fileName]),
      }).catch?.(() => {});
    }

    if (settings.saveMode === 'manual' && engine?.saveCachedFile) {
      saveModeManualPending = true;
      showToast(t('dl_manual_save_hint'));
    }

    // 轨道说明：完成后再次强调，防止用户拿纯音频轨/纯视频轨误判为损坏
    const isAudioTrack = videoTrack === 'audio' || videoFormat === 'm4a';
    const isVideoTrack = videoTrack === 'video' || /视频轨/.test(result.fileName || '') ||
      /视频轨/.test(videoName) || videoFormat === 'm4s';
    const statusText = document.getElementById('status-text');
    if (isAudioTrack) {
      statusText.textContent =
        t('dl_done_audio_track');
    } else if (isVideoTrack) {
      statusText.textContent =
        t('dl_done_video_track');
    }
  }

  function handleError(err) {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    const statusText = document.getElementById('status-text');
    // 脱敏：错误消息中的 URL 替换为 [URL]
    let safeMsg = String(err.message || t('dl_unknown_error')).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    // v4.2.10 兜底防线：任何路径漏出的原生 abort 文案（Chrome 对不带 reason
    // 的 abort() 给出 "signal is aborted without reason"）不允许原样上屏
    if (err?.name === 'AbortError' || /aborted without reason/i.test(safeMsg)) {
      safeMsg = t('dl_err_aborted');
    }
    statusText.textContent = t('dl_error_prefix', [safeMsg]);
    // v4.2.7：下载失败 → 标签标题显示失败状态（多任务卡时一眼可见）
    resetTabTitle(t('dl_tab_title_failed'));
    // 显示重试提示
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.disabled = false;
      const label = document.getElementById('pause-label');
      if (label) label.textContent = t('dl_retry');
    }
  }

  // ============================================================
  // 分段可视化
  // ============================================================
  function renderChunks(pieces) {
    const container = document.getElementById('chunk-viz');
    if (!pieces || pieces.length === 0) return;

    // 分段可能很多（几百段），可视化最多渲染 120 格，每格代表多段
    const MAX_CELLS = 120;
    let cells;
    if (pieces.length <= MAX_CELLS) {
      cells = pieces.map(p => ({ done: p.status === 'done' || p.downloaded >= p.size, active: p.status === 'active' }));
    } else {
      const per = pieces.length / MAX_CELLS;
      cells = [];
      for (let i = 0; i < MAX_CELLS; i++) {
        const from = Math.floor(i * per);
        const to = Math.min(pieces.length, Math.floor((i + 1) * per));
        let done = 0;
        let active = false;
        for (let j = from; j < to; j++) {
          if (pieces[j].status === 'done') done++;
          if (pieces[j].status === 'active') active = true;
        }
        cells.push({ done, total: to - from, active });
      }
    }

    if (container.children.length !== cells.length) {
      container.innerHTML = cells.map(() => '<div class="chunk-segment"></div>').join('');
    }

    const children = container.children;
    cells.forEach((cell, i) => {
      const el = children[i];
      if (!el) return;
      el.className = 'chunk-segment';
      if (cell.done === true || (cell.total && cell.done >= cell.total)) {
        el.classList.add('done');
      } else if (cell.active) {
        el.classList.add('downloading');
      }
      if (typeof cell.done === 'number' && cell.total) {
        el.style.opacity = 0.25 + (cell.done / cell.total) * 0.75;
      }
    });
  }

  // ============================================================
  // 暂停 / 继续
  // ============================================================
  function togglePause() {
    if (!engine) return;
    // 错误状态下点击 = 重试
    if (engine.status === 'error') {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      engine.destroy?.().then(() => {
        _displayedPercent = 0;
        _targetPercent = 0;
        engine.start();
      });
      return;
    }
    if (!isPaused) {
      engine.pause();
      isPaused = true;
    } else {
      isPaused = false;
      engine.resume();
    }
  }

  // ============================================================
  // 设置
  // ============================================================
  function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  async function saveSettings() {
    const newSettings = {
      threadCount: parseInt(document.getElementById('setting-threads').value),
      fileNameMode: document.getElementById('setting-filename-mode').value,
      saveLocation: document.getElementById('setting-save-location').value,
      saveMode: document.getElementById('setting-save-mode').value,
      clearCacheOnExit: document.getElementById('setting-clear-on-exit').checked,
      speedBoost: document.getElementById('setting-speed-boost').checked,
      privacyMode: document.getElementById('setting-privacy-mode').checked,
    };

    const customName = document.getElementById('setting-custom-name').value.trim();
    if (customName) newSettings.customName = customName;

    settings = await Storage.saveSettings(newSettings);

    // v4.2.7：保存设置后同步更新引擎的用户线程上限
    if (engine && !isPaused) {
      engine._userThreadCount = settings.threadCount;
      // v4.2.7 修复：原代码只设 engine.threadCount（不生效，需要 adjustThreads
      // 才会真正 spawn/stop worker）；同步调用 adjustThreads 让保存按钮也立刻生效，
      // speedBoost 状态也要同步
      engine.speedBoost = settings.speedBoost;
      if (typeof engine.adjustThreads === 'function') {
        engine.adjustThreads(settings.threadCount);
      } else {
        engine.threadCount = settings.threadCount;  // 兜底
      }
    }
    document.getElementById('stat-threads').textContent = engine?.threadCount ?? settings.threadCount;

    toggleSettings();
    showToast(t('dl_settings_saved'));
  }

  async function clearCache() {
    if (engine?.clearCache) {
      await engine.clearCache();
    }
    showToast(t('dl_cache_cleared'));
  }

  async function saveCachedFile() {
    if (!engine) return;
    const result = await engine.saveCachedFile();
    if (result.success) {
      saveModeManualPending = false;
      showToast(t('dl_saved_file', [result.fileName]));
      // v4.3.7：缺失分片警告（截断文件无法完整播放）
      if (result.warning) showToast(result.warning);
    } else {
      showToast(t('dl_save_failed', [result.error || t('dl_no_data_to_save')]));
    }
  }

  // ============================================================
  // 退出清理
  // ============================================================
  function handlePageExit() {
    try {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      stopKeepalive();  // 断开保活连接
      if (engine) {
        if (settings.clearCacheOnExit && !saveModeManualPending) {
          engine.destroy?.(); // 中止下载 + 清除 OPFS 缓存 + DNR 规则 + 注销注册
        } else {
          engine.pause?.();
          if (!saveModeManualPending) engine.clearCache?.();
          engine.removeForceHeaders?.();
          engine.unregisterDownload?.(); // 注销下载注册，释放连接配额
        }
      }
      chrome.runtime.sendMessage({
        type: 'download-page-closed',
        downloadId,
      }).catch?.(() => {});
    } catch {}
  }

  // ============================================================
  // 播放器模式
  // ============================================================
  function initPlayer() {
    document.getElementById('download-card').style.display = 'none';
    document.querySelector('.settings-panel').style.display = 'none';
    const playerSection = document.getElementById('player-section');
    playerSection.style.display = 'block';

    const video = document.getElementById('player-video');
    const src = videoUrl || '';
    // MSE 捕获生成的是 blob://<原站> 内存流，作用域只限捕获它的原页面（content 脚本上下文）。
    // download.html 是 chrome-extension 来源，跨 scope 无法直读该 blob → video 会无限转圈；
    // 刷新下载页仍是同一失效源，只有回原视频页让它重新捕获/重嗅探才恢复。
    const isMemoryStream = /^blob:/i.test(src);

    // 播放提速：为预览播放应用 DNR 防盗链放行规则（注入 Referer/Origin，
    // resourceTypes 含 media，<video> 元素请求才不会被 CDN 403 拒绝而无限转圈）。
    // 页面离开时移除，规则绑定本标签页，影响面最小。
    let playerRuleId = null;
    if (!isMemoryStream && /^https?:/i.test(src) &&
        typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'apply-force-rule',
        url: src,
        referer: videoReferer || null,
      }).then((resp) => {
        if (resp && typeof resp === 'object' && 'applied' in resp && resp.applied) {
          playerRuleId = resp.ruleId;
        }
      }).catch(() => {});
      window.addEventListener('pagehide', () => {
        if (playerRuleId !== null) {
          chrome.runtime.sendMessage({
            type: 'remove-force-rule',
            ruleId: playerRuleId,
          }).catch(() => {});
        }
      }, { once: true });
    }

    if (isMemoryStream) {
      showToast(t('dl_player_memory_stream'), 5000);
    }
    video.onerror = () => {
      showToast(t('dl_player_load_failed'), 5000);
    };
    document.getElementById('player-video').preload = 'auto';
    document.getElementById('player-video').controls = true;
    const readyTimeout = setTimeout(() => {
      if (video.readyState === 0) {
        showToast(isMemoryStream
          ? t('dl_player_not_ready_memory')
          : t('dl_player_not_ready_generic'), 6000);
      }
    }, 8000);
    video.addEventListener('loadedmetadata', () => clearTimeout(readyTimeout), { once: true });
    video.addEventListener('error', () => clearTimeout(readyTimeout), { once: true });
    video.src = src;

    // 播放器模式：logo 与标签标题换成播放态文案。
    // 摘掉 data-i18n：localizeDom 若在本函数之后才跑，会把通用标题覆盖回来。
    const logoEl = document.querySelector('.logo span');
    logoEl.removeAttribute('data-i18n');
    logoEl.textContent = t('dl_player_logo');
    const titleEl = document.querySelector('title');
    if (titleEl) titleEl.removeAttribute('data-i18n');
    document.title = t('dl_player_tab_title', [safeDecodeName(videoName)]);
  }

  // ============================================================
  // 工具
  // ============================================================
  // v4.2.8：decodeURIComponent 对畸形 %XX 会抛 URIError（URL 参数是外部
  // 输入），直接裸调会让初始化整体中断 —— 统一容错，失败时原样返回
  function safeDecodeName(s) {
    if (s == null) return '';
    try { return decodeURIComponent(s); } catch { return String(s); }
  }

  // v4.4.1 命名模板：借鉴 N_m3u8DL-RE --save-pattern / yt-dlp -o 的变量占位思路。
  // 模板里没有 {…} 时原样返回，行为与旧版「固定自定义名」完全一致；
  // 未识别的 {xxx} 原样保留，不做静默删除。
  function expandNameTemplate(tpl) {
    const s = String(tpl || '');
    if (s.indexOf('{') === -1) return s;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const vars = {
      title: videoName || '',
      site: (() => {
        try { return new URL(videoUrl).hostname.replace(/^www\./i, ''); } catch { return ''; }
      })(),
      quality: videoQuality || '',
      format: videoFormat || '',
      type: videoType || '',
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    };
    return s.replace(/\{(\w+)\}/g, (whole, key) => {
      const k = key.toLowerCase();
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole;
    });
  }

  function generateFileName(defaultExt) {
    // v4.2.8：扩展名只认白名单（EXT_WHITELIST 在参数解析处定义）。
    // ext 会参与 `new RegExp(\`\\.${ext}$\`)` 与最终文件名，白名单外
    // 一律回退 mp4，杜绝构造畸形扩展名做正则注入/双扩展名文件名。
    let ext = String(defaultExt || videoFormat || 'mp4').trim().toLowerCase();
    if (!EXT_WHITELIST.has(ext)) ext = 'mp4';
    if (settings.fileNameMode === 'custom' && settings.customName) {
      // 自定义名同样消毒 + 限长（防止超长路径写入失败与目录穿越）
      let name = expandNameTemplate(safeDecodeName(settings.customName))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, 80)
        .trim();
      if (!name || name === '.') name = 'video';
      if (!new RegExp(`\\.${ext}$`, 'i').test(name)) name += '.' + ext;
      return name;
    }
    let name = safeDecodeName(videoName)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '.')
      .slice(0, 80)
      .trim();
    if (!name || name === '.') name = 'video';
    if (!new RegExp(`\\.${ext}$`, 'i').test(name)) name += '.' + ext;
    return name;
  }

  function truncateURL(url, maxLen) {
    if (!url) return '';
    if (url.length <= maxLen) return url;
    return url.substring(0, maxLen - 3) + '...';
  }

  function showToast(message, duration = 2500) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.85); color: white; padding: 10px 20px;
      border-radius: 8px; font-size: 14px; z-index: 10000;
      animation: toastIn 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // ============================================================
  // v4.2.7 诊断工具：卡 0% 时在下载页 Console 执行 __diag()
  // 一条命令输出引擎全量状态 + SW 存活 ping（不再靠猜）
  // ============================================================
  window.__diag = async function () {
    const out = {
      engineType: engine?.constructor?.name || 'null',
      status: engine?.status || 'null',
      paused: !!engine?.paused,
      aborted: !!engine?.aborted,
      useProxy: engine?._useProxy,
      proxyFailCount: engine?._proxyFailCount || 0,
      threadCount: engine?.threadCount,
      userThreadCount: engine?._userThreadCount,
      maxThreads: engine?.maxThreads,
      activeConnections: engine?.activeConnections ?? engine?.activeWorkers ?? 0,
      segmentsTotal: engine?.segments?.length,
      segmentsDone: engine?.segments?.filter(s => s.status === 'done').length,
      segmentsFailed: engine?.segmentErrors?.size,
      downloadedBytes: engine?.downloadedBytes ?? 0,
      downloadedSegments: engine?.downloadedSegments,
      flushIndex: engine?.flushIndex,
      pendingBlobs: engine?.pendingBlobs?.size,
      initSegment: engine?.initSegment ? 'yes' : 'no',
      isFMP4: engine?.isFMP4,
      settingsThread: settings?.threadCount,
      urlHost: (() => { try { return new URL(videoUrl).hostname; } catch { return videoUrl; } })(),
    };
    console.log('[VideoSniffer-DIAG] 引擎状态:', JSON.stringify(out, null, 2));
    // SW 存活 ping（带 8s 超时，SW 休眠/挂起会在此暴露）
    try {
      const t0 = performance.now();
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: 'diag-ping' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping 超时 8s')), 8000)),
      ]);
      console.log(`[VideoSniffer-DIAG] SW 存活: ${(performance.now() - t0).toFixed(0)}ms 响应`, resp);
    } catch (e) {
      console.warn('[VideoSniffer-DIAG] SW 无响应:', e?.message);
    }
    return out;
  };
  window.__diagInfo = '在下载页 Console 输入 __diag() 查看引擎与 SW 状态';

  init().catch((e) => {
    // init() 内部任何步骤抛错（storage 读取失败、SW 未激活、构造异常等）
    // 会被全局 unhandledrejection 静默吞掉 → UI 卡在"正在初始化…"无解。
    // 此处兜底：让错误可见，用户能立即看到具体原因而非一直卡住。
    const statusText = document.getElementById('status-text');
    if (statusText) {
      const msg = String(e?.message || e || t('dl_unknown_error')).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
      statusText.textContent = t('dl_init_failed', [msg]);
    }
    console.error('[VideoSniffer] init 失败:', e);
  });
})();
