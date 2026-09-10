/**
 * 视频嗅探器 - 内容脚本（通信层）v4.3.1
 * 处理来自后台/弹窗的消息：手动扫描、录制、MSE 拦截下载、视频元素控制
 *
 * MSE 拦截通信：
 * - mse-hook.js (MAIN 世界) → postMessage → 本脚本 → chrome.runtime → 后台
 * - 后台 → chrome.tabs.sendMessage → 本脚本 → postMessage → mse-hook.js
 *
 * v4.3.1 角色分层（借鉴 MPMux content-listener / content-downloader 思路）：
 * 不拆文件（避免 manifest 大改），但在 IIFE 内部用清晰的"监听层/执行层"
 * 职责边界组织代码。两段用 [Listener Layer] / [Executor Layer] 注释标注。
 *
 * ┌─ Listener Layer（监听层，document_idle 注入即生效，常驻） ────────┐
 * │  - window.message 监听 mse-hook 消息 → 进度上报 / 转发 / 下载触发  │
 * │  - 轻量：只做事件转发与状态上报，不持有大 Blob / 长任务             │
 * │  - 关键：监听层卡住会影响所有后续事件，禁止在此处做长操作           │
 * └────────────────────────────────────────────────────────────────┘
 * ┌─ Executor Layer（执行层，按需被调用，重量级） ───────────────────┐
 * │  - chrome.runtime.onMessage 接收 SW 指令（begin-record 等）        │
 * │  - saveMseBlob / handleRecording / 录制控制                        │
 * │  - 重操作：可能创建 Blob / 触发下载 / 调用 MediaRecorder          │
 * │  - 与监听层隔离：执行层异常不应阻断后续监听（try/catch 包裹）       │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 注：MSE 多分片合并场景未来可走 Offscreen 通道（见 SW mergeBlobsViaOffscreen），
 *     无需打开 download.html，省一跳 UI。
 */

(function () {
  'use strict';

  // ============================================================
  // [Listener Layer] 监听层（借鉴 MPMux content-listener 思路）
  // ------------------------------------------------------------
  // 职责：监听 MAIN 世界的 postMessage，转发到 SW；上报进度
  // 约束：轻量、无长任务、不持有大 Blob，监听层卡住会阻断所有后续事件
  // 边界：以下到 [Executor Layer] 标记前的所有 addEventListener / 转发
  //       均属于监听层
  // ============================================================

  // ============================================================
  // MSE Hook 消息监听（从 MAIN 世界接收）
  // ============================================================
  const mseCaptures = new Map(); // captureId → { info, pendingDownload }
  const mseTimeouts = new Map(); // captureId → timeoutId（超时检测）

  // v4.2.8：data-response / merged-data-response 防伪造。
  // MAIN 世界的页面脚本同样能看到 window.postMessage 流量并可伪造
  // 'mse-hook' 消息（source 字段可随意写）。此处记录最近一次向 mse-hook
  // 请求导出的 captureId + 时间戳（10 分钟窗口）；响应的 captureId 不匹配
  // 或超窗即丢弃。配合 mse-hook 侧高熵随机 captureId，可挡住
  // 「无请求盲发 / 过期重放 / 错位 captureId」三类伪造 blob 导出。
  const DATA_RESPONSE_WINDOW = 10 * 60 * 1000;
  let pendingCapture = null; // { id, ts }

  // 页面通知：在页面右上角显示浮动提示
  function showMseNotification(text, isError) {
    const existing = document.getElementById('vs-mse-notify');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'vs-mse-notify';
    div.style.cssText = `
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      background: ${isError ? '#FF3B30' : '#34C759'}; color: white;
      padding: 12px 20px; border-radius: 8px; font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 360px;
      word-break: break-word; transition: opacity 0.3s;
    `;
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 300);
    }, 5000);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'mse-hook') return;
    // 修复 v2.2：收紧 origin 检查 —— 不再接受空 origin（sandboxed frame 的 opaque origin）
    // 仅接受同源消息，防止嵌套 iframe 中的恶意脚本伪造扩展消息
    if (event.origin !== location.origin) return;
    const msg = event.data;

    switch (msg.type) {
      case 'source-detected': {
        // 新 MSE 源检测到 → 上报为视频
        // B站等 DASH 站点的 MSE 用两个 SourceBuffer 分别承载视频流/音频流，
        // 按 codecs 推断轨道（avc1/hevc→视频，mp4a/opus→音频），标注给列表
        const mt = msg.mimeType || '';
        const isAudioStream = /mp4a|opus|flac|ec-3/i.test(mt);
        const videoInfo = {
          url: `mse://${msg.captureId}`,
          name: document.title || 'MSE 捕获视频',
          type: 'mse-capture',
          format: isAudioStream ? 'm4a' : 'mp4', // 统一用 mp4/m4a 扩展名（iPhone 兼容）
          mimeType: mt,
          track: isAudioStream ? 'audio' : 'video',
          score: 90,
          captureId: msg.captureId,
        };

        if (window.__VideoSnifferInternal__) {
          window.__VideoSnifferInternal__.queueReport(videoInfo);
        }
        chrome.runtime.sendMessage({
          type: 'video-found',
          videos: [videoInfo],
        }).catch?.(() => {});
        break;
      }

      case 'bilibili-data': {
        // B站 __playinfo__ 数据提取成功
        // 借鉴 bilibili下载助手 方案：调用API获取标准MP4直链（durl），避免fMP4合并
        if (msg.data && msg.data.bestVideo) {
          const d = msg.data;
          // 调用B站API获取标准MP4直链（fnval不传=默认非DASH，返回durl）
          // 这解决了fMP4合并失败的根本问题：直接下载完整MP4，无需合并
          const apiParams = new URLSearchParams({
            bvid: d.bvid || '',
            cid: String(d.cid || ''),
            qn: '80',
            otype: 'json',
          });
          const apiUrl = `https://api.bilibili.com/x/player/playurl?${apiParams.toString()}`;

          // v4.3.2 H-2：B站直链 API 加 10s 超时。旧版无超时——B站 API 偶发
          // 挂起时，content-script 的 fetch 会一直 pending，清单页"卡在等待
          // 直链"数十秒后才走降级。用 AbortController 兜底。
          // 关键：abort(new Error(中文))——按项目规则，超时 reason 必须是普通
          // Error（.name='Error'），不能用 AbortError 名字（专属"用户暂停"，
          // connectionWorker 据此静默跳出不重试；超时应走 catch 降级路径）。
          const BILI_API_TIMEOUT_MS = 10000;
          const biliAbort = new AbortController();
          const biliTimer = setTimeout(
            () => biliAbort.abort(new Error('B站直链 API 超时（10 秒）——服务器无响应，已降级 DASH 合并')),
            BILI_API_TIMEOUT_MS,
          );

          fetch(apiUrl, {
            method: 'GET',
            credentials: 'include',
            signal: biliAbort.signal,
          })
          .then(r => { clearTimeout(biliTimer); return r.json(); })
          .then(apiResp => {
            let directUrl = '';
            let directSize = 0;
            // 普通视频: data.durl[0].url, 番剧: result.durl[0].url
            const durl = apiResp?.data?.durl?.[0] || apiResp?.result?.durl?.[0];
            if (durl?.url) {
              directUrl = durl.url;
              directSize = durl.size || 0;
              // v4.2.8：只打印长度不打印内容 —— 该直链含 CDN 防盗链签名参数，
              // 打印前 80 字符会把签名泄漏到控制台（页面/录屏可见）
              console.log('[VideoSniffer] B站API返回标准MP4直链，长度:', directUrl.length);
            } else {
              console.warn('[VideoSniffer] B站API未返回durl，将使用DASH合并降级方案');
            }
            chrome.runtime.sendMessage({
              type: 'bilibili-api-data',
              data: { ...d, directUrl, directSize },
              pageUrl: location.href,
              pageTitle: document.title || '',
            }).catch?.(() => {});
          })
          .catch(err => {
            clearTimeout(biliTimer);
            console.warn('[VideoSniffer] B站API调用失败，使用DASH合并降级方案:', err?.message);
            // API失败，仍然发送DASH数据作为降级
            chrome.runtime.sendMessage({
              type: 'bilibili-api-data',
              data: { ...d, directUrl: '', directSize: 0 },
              pageUrl: location.href,
              pageTitle: document.title || '',
            }).catch?.(() => {});
          });
        }
        break;
      }

      case 'capture-reset': {
        // abort() 触发：广告内容已清除，通知用户
        showMseNotification('检测到内容切换（广告→正片），已清除广告数据，请重新点击 MSE 下载', false);
        break;
      }

      case 'data-appended': {
        // 数据追加 → 更新进度
        mseCaptures.set(msg.captureId, {
          ...(mseCaptures.get(msg.captureId) || {}),
          totalSize: msg.totalSize,
          segmentCount: msg.segmentCount,
        });

        chrome.runtime.sendMessage({
          type: 'mse-progress',
          captureId: msg.captureId,
          totalSize: msg.totalSize,
          segmentCount: msg.segmentCount,
        }).catch?.(() => {});
        break;
      }

      case 'source-ended': {
        // MSE 源结束
        chrome.runtime.sendMessage({
          type: 'mse-complete',
          captureId: msg.captureId,
          totalSize: msg.totalSize,
          segmentCount: msg.segmentCount,
        }).catch?.(() => {});
        break;
      }

      case 'capture-limit': {
        // v4.2.8：MSE 捕获超限截断通知（mse-hook 超限静默丢段的可见化）。
        // 转发给后台，供弹窗/系统通知侧消费；后台暂不处理也无副作用（fire-and-forget）。
        console.warn('[VideoSniffer] MSE 捕获已达上限，后续分段未保存:', {
          captureId: msg.captureId,
          size: msg.size,
          limit: msg.limit,
        });
        chrome.runtime.sendMessage({
          type: 'capture-limit',
          captureId: msg.captureId,
          size: msg.size,
          limit: msg.limit,
        }).catch?.(() => {});
        break;
      }

      case 'data-response': {
        // v4.2.8：防伪造校验 —— 必须命中 pendingCapture 窗口内的合法请求
        if (!pendingCapture || msg.captureId !== pendingCapture.id ||
            Date.now() - pendingCapture.ts > DATA_RESPONSE_WINDOW) {
          console.warn('[VideoSniffer] 丢弃可疑 data-response（captureId 不匹配或已超窗）');
          return;
        }

        // 清除超时检测
        if (mseTimeouts.has(msg.captureId)) {
          clearTimeout(mseTimeouts.get(msg.captureId));
          mseTimeouts.delete(msg.captureId);
        }

        // MSE hook 返回错误
        if (msg.error) {
          const errMsg = msg.error === 'empty'
            ? 'MSE 捕获数据为空，请先播放视频再下载'
            : msg.error === 'rate-limited'
              ? 'MSE 数据请求过于频繁，请稍候几秒再试'
              : '未找到 MSE 捕获数据，请确保视频已开始播放';
          showMseNotification(errMsg, true);
          return;
        }

        // MSE hook 在 MAIN 世界创建了 Blob，传回 blob: URL
        if (!msg.blobUrl) {
          showMseNotification('数据传输失败', true);
          return;
        }

        // v4.2.8：超限截断提示（mse-hook 侧 capture-limit 曾触发）
        if (msg.truncated) {
          showMseNotification('该捕获已达大小上限，导出的文件不含超出部分（视频可能不完整）', true);
        }

        saveMseBlob(msg.blobUrl, msg.ext || 'mp4', msg.size || 0);
        break;
      }

      case 'merged-data-response': {
        // v4.1 新增：音视频轨合并导出结果
        // v4.2.8：与 data-response 相同的防伪造校验
        if (!pendingCapture || msg.captureId !== pendingCapture.id ||
            Date.now() - pendingCapture.ts > DATA_RESPONSE_WINDOW) {
          console.warn('[VideoSniffer] 丢弃可疑 merged-data-response（captureId 不匹配或已超窗）');
          return;
        }

        if (mseTimeouts.has(msg.captureId)) {
          clearTimeout(mseTimeouts.get(msg.captureId));
          mseTimeouts.delete(msg.captureId);
        }

        if (msg.error) {
          const errMap = {
            'not-found': '未找到 MSE 捕获数据，请确保视频已开始播放',
            'empty': 'MSE 捕获数据为空，请先播放视频再下载',
            'no-audio-track': '未找到配对的音频轨，无法合并。请直接下载视频轨（无声）或改用录制',
            'no-merger': '合并器未就绪，请刷新页面后重试',
            'merge-failed': '音视频合并失败，已降级：请分别下载视频轨和音频轨后手动合并',
            'encrypted': '该流为加密内容（付费内容），MSE 数据本身是密文，导出无法播放。免费内容可正常下载',
          };
          // v4.2.8：hasOwnProperty 查表 —— msg.error 可控，直取会命中原型链键
          const errText = Object.prototype.hasOwnProperty.call(errMap, msg.error)
            ? errMap[msg.error]
            : '合并失败，请重试';
          showMseNotification(errText, true);
          return;
        }

        if (!msg.blobUrl) {
          showMseNotification('合并数据传输失败', true);
          return;
        }

        saveMseBlob(msg.blobUrl, 'mp4', msg.size || 0);
        break;
      }
    }
  });

  // ============================================================
  // [Executor Layer] 执行层（借鉴 MPMux content-downloader 思路）
  // ------------------------------------------------------------
  // 职责：接收 SW 指令、执行下载 / 录制 / Blob 合并
  // 约束：重操作必须 try/catch 包裹，异常不向监听层传染
  // 边界：saveMseBlob / chrome.runtime.onMessage / handleRecording 等
  // 注：未来多分片合并可走 SW.mergeBlobsViaOffscreen（Offscreen 通道）
  // ============================================================

  // v4.1 抽出：MSE 数据保存（单轨导出与音视频合并共用）
  function saveMseBlob(blobUrl, ext, size) {
    try {
      const rawTitle = (document.title || 'video').replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
      const ts = new Date().toISOString().slice(0, 10);
      const fileName = `${rawTitle}_${ts}.${ext}`;

      showMseNotification(`正在保存 ${formatBytes(size)} 数据…`, false);

      // 用 anchor 下载（blob: URL 由 MAIN 世界创建，同源可访问）
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();

      showMseNotification(`已保存: ${fileName}`, false);
    } catch (e) {
      // 脱敏：不输出完整 URL 到控制台
      console.error('[VideoSniffer] MSE save error:', String(e?.message || e).replace(/https?:\/\/[^\s'"]+/g, '[URL]'));
      showMseNotification('保存失败，请重试', true);
    }
  }

  // ============================================================
  // 后台/弹窗消息处理
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      // 来源校验（v4.2.3）：仅接受本扩展后台/弹窗的指令。
      // 页面无法伪造 sender.id，防止其它注入脚本冒充扩展驱动本脚本动作。
      if (!message || !sender || sender.id !== chrome.runtime.id) {
        try { sendResponse({ success: false, error: 'unauthorized' }); } catch {}
        return;
      }
      switch (message.type) {
        case 'manual-scan': {
          if (window.__VideoSnifferInternal__) {
            window.__VideoSnifferInternal__.manualScan();
            // 同时请求 MSE hook 的捕获列表
            window.postMessage({ source: 'ext', action: 'list-all' }, location.origin);
            sendResponse({
              success: true,
              count: window.__VideoSnifferInternal__.foundVideos.size +
                     window.__VideoSnifferInternal__.pendingReport.size,
            });
          } else {
            sendResponse({ success: false, error: '嗅探器未就绪' });
          }
          break;
        }

        case 'begin-record':
          handleRecording(message, sendResponse);
          return true;

        case 'stop-record': {
          if (window.__VideoSnifferInternal__) {
            window.__VideoSnifferInternal__.stopRecording();
            sendResponse({ success: true });
          }
          break;
        }

        // MSE 捕获下载：请求 MSE hook 传输截获的数据
        case 'mse-download': {
          const captureId = message.captureId;
          if (!captureId) {
            sendResponse({ success: false, error: '缺少 captureId' });
            break;
          }
          // v4.2.8：记录本次导出请求（data-response 防伪造校验用）
          pendingCapture = { id: captureId, ts: Date.now() };
          // 向 MAIN 世界的 MSE hook 请求数据
          window.postMessage({
            source: 'ext',
            action: 'get-data',
            captureId,
          }, location.origin);

          // 超时检测：10 秒内未收到 data-response 则提示用户
          if (mseTimeouts.has(captureId)) {
            clearTimeout(mseTimeouts.get(captureId));
          }
          const timeout = setTimeout(() => {
            showMseNotification('MSE 数据请求超时，请确保视频已开始播放后再试', true);
            mseTimeouts.delete(captureId);
          }, 10000);
          mseTimeouts.set(captureId, timeout);

          sendResponse({ success: true, message: '已请求数据传输' });
          break;
        }

        // v4.1 新增：MSE 音视频轨合并下载（腾讯/爱奇艺 DASH 音视频分离场景）
        case 'mse-merge-download': {
          const captureId = message.captureId;
          if (!captureId) {
            sendResponse({ success: false, error: '缺少 captureId' });
            break;
          }
          // v4.2.8：记录本次导出请求（merged-data-response 防伪造校验用）
          pendingCapture = { id: captureId, ts: Date.now() };
          // 向 MAIN 世界的 MSE hook 请求合并导出
          window.postMessage({
            source: 'ext',
            action: 'get-merged-data',
            captureId,
          }, location.origin);

          // 超时检测：合并大文件可能较慢，给 30 秒
          if (mseTimeouts.has(captureId)) {
            clearTimeout(mseTimeouts.get(captureId));
          }
          const timeout = setTimeout(() => {
            showMseNotification('音视频合并请求超时，请确保视频已开始播放后再试', true);
            mseTimeouts.delete(captureId);
          }, 30000);
          mseTimeouts.set(captureId, timeout);

          sendResponse({ success: true, message: '已请求音视频合并导出' });
          break;
        }

        case 'get-video-element-info': {
          const video = document.querySelector('video');
          if (video) {
            sendResponse({
              found: true,
              src: video.currentSrc || video.src,
              duration: video.duration,
              width: video.videoWidth,
              height: video.videoHeight,
              paused: video.paused,
            });
          } else {
            sendResponse({ found: false });
          }
          break;
        }

        case 'force-play-video': {
          const v = document.querySelector('video');
          if (v) {
            v.muted = true;
            v.play().catch(() => {});
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: '页面上没有视频元素' });
          }
          break;
        }
      }
    } catch (err) {
      try { sendResponse({ success: false, error: err.message }); } catch {}
    }
    return false;
  });

  function handleRecording(message, sendResponse) {
    const sniffer = window.__VideoSnifferInternal__;
    if (!sniffer) {
      sendResponse({ success: false, error: '嗅探器未初始化' });
      return;
    }

    const videoEl = document.querySelector('video');
    if (!videoEl) {
      sendResponse({ success: false, error: '页面上没有找到视频元素' });
      return;
    }

    if (videoEl.paused) {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // v4.3.1 透传 recordSpeed(借鉴 CocoCut timectr.js 加速思路)
    const result = sniffer.startRecording(videoEl, message.recordId, message.recordSpeed);
    // 加密保护内容直接返回明确错误（而非进入录制后黑屏）
    if (result?.success === false && result?.error === 'encrypted-protected') {
      showMseNotification(result.message || '该视频受加密保护，录制会黑屏且无合法导出途径，请使用平台官方离线下载', true);
    }
    sendResponse(result);
  }
})();
