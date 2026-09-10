/**
 * 视频嗅探器 - 弹窗逻辑 v2.1
 * 视频列表展示与交互（列表已按价值分数排序，最优结果在最上面）
 *
 * 安全加固：
 * - URL 验证：所有操作前校验视频 URL 合法性
 * - XSS 防护：所有用户可控内容均经 HTML 转义
 * - 隐私清除：一键清除所有痕迹
 */

(function () {
  'use strict';

  let currentTabId = null;
  let currentTabUrl = null;
  let videos = [];
  let scanTimeout = null;

  // v4.2.8：与后台 isBlockedIpLiteral 同口径的简化版（弹窗侧字面校验）。
  // 旧版只拦 localhost/127.0.0.1，弹窗放行 10.x/192.168.x/::1 等内网地址
  // 而后台拦截 → 用户看到「URL 不合法」之外的静默差异。此处补齐
  // 回环/私有段/链路本地（含 IPv6）；深度校验（DNS 解析私有段）仍由后台负责。
  // blob:/mse:// 与录制路径的豁免逻辑在 handleAction，不受此函数影响。
  function isBlockedHostLiteral(hostname) {
    const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127) return true;          // 0/8, 10/8, 127/8
      if (a === 169 && b === 254) return true;                     // 169.254/16 链路本地
      if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16/12
      if (a === 192 && b === 168) return true;                     // 192.168/16
      return false;
    }
    if (/^([0-9a-f:]+)$/.test(h)) {
      return h === '::' || h === '::1' || h.startsWith('::ffff')   // 未指定/回环/NAT64
        || /^fe[89ab]/.test(h)                                     // fe80::/10 链路本地
        || /^f[cd]/.test(h)                                        // fc00::/7 ULA
        || /^ff/.test(h);                                          // ff00::/8 组播
    }
    return false;
  }

  function isSafeUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (isBlockedHostLiteral(u.hostname)) return false;
      return true;
    } catch { return false; }
  }

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    currentTabId = tab.id;
    currentTabUrl = tab.url || '';

    await loadVideos();
    setupStorageListener();
    setupListeners();

    // 触发一次手动扫描（内容脚本可能加载较晚）
    chrome.tabs.sendMessage(currentTabId, { type: 'manual-scan' }).catch?.(() => {});
  }

  async function loadVideos() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'get-videos',
        tabId: currentTabId,
      });
      if (response?.success) {
        videos = response.data || [];
        renderVideos();
      }
    } catch {}
  }

  // storage 变更监听（只注册一次，避免重复绑定）
  let _storageListenerAdded = false;
  function setupStorageListener() {
    if (_storageListenerAdded) return;
    _storageListenerAdded = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[`videos_${currentTabId}`]) {
        videos = changes[`videos_${currentTabId}`].newValue || [];
        renderVideos();
      }
    });
  }

  function renderVideos() {
    const list = document.getElementById('video-list');
    const emptyState = document.getElementById('empty-state');
    const statusBar = document.getElementById('status-bar');
    const statusText = document.getElementById('status-text');
    const statusDot = statusBar.querySelector('.status-dot');

    if (videos.length === 0) {
      list.innerHTML = '';
      emptyState.style.display = 'flex';
      statusBar.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    statusBar.style.display = 'flex';
    statusDot.classList.remove('scanning');
    statusDot.classList.add('found');
    statusText.textContent = `已检测到 ${videos.length} 个视频`;

    // 后台已按分数排序，这里再保险排一次
    const sorted = [...videos].sort((a, b) => (b.score || 0) - (a.score || 0));

    list.innerHTML = sorted.map((video, index) => createVideoCard(video, index)).join('');
    attachCardListeners();
  }

  function createVideoCard(video, index) {
    const name = video.name || guessNameFromURL(video.url);
    // 流媒体清单（m3u8/mpd）显示的 KB 数只是清单文件本身的大小，不是视频
    // 体积 —— 直接展示会让人误以为"35KB 的零碎"而错过真正的完整视频
    const isStreamManifest = video.type === 'stream' && (!video.size || video.size < 1048576);
    const sizeText = isStreamManifest ? '完整视频(分片下载)' : formatSize(video.size);
    // format/type 均来自页面嗅探数据（用户可控），渲染前必须转义
    const format = escapeHTML((video.format || 'video').toUpperCase());
    const typeBadge = createTypeBadge(video.type);
    const durationText = formatDuration(video.duration);
    const isMseCapture = video.type === 'mse-capture';
    const isBlobUrl = video.type === 'mse' || (video.url && video.url.startsWith('blob:'));
    const isMseType = isMseCapture || isBlobUrl;
    const isBiliMerged = video.type === 'bilibili-merged';
    const mseBadge = isMseCapture ? '<span class="video-type-badge mse-capture-badge" title="MSE 数据流拦截：直接截获原始分段，不依赖播放速度">MSE 捕获</span>' : '';
    // B站合并下载徽章
    const biliBadge = isBiliMerged ? '<span class="video-type-badge" style="background:#00a1d6;color:#fff" title="从B站API获取标准MP4直链，直接下载无需合并">B站下载</span>' : '';

    // 轨道徽章 + 清晰度 + 受保护标注：
    // B站等 DASH 站点音视频轨分离，同页多条同名条目（视频轨 300MB / 音频轨 12MB），
    // 不标注的话用户极易误下音频轨（"12 分钟视频只有 12MB"的直接根因）
    let trackBadge = '';
    if (video.track === 'video') {
      trackBadge = '<span class="video-type-badge track-video" title="DASH 纯视频轨：无声音是正常现象（站点音视频分离存储）。下载后可用 VLC 播放，或配合音频轨合并">视频轨·无声</span>';
    } else if (video.track === 'audio') {
      trackBadge = '<span class="video-type-badge track-audio" title="这是纯音频（无画面）。12 分钟约 11-29MB，与视频轨（同时长数百 MB）差异巨大，请勿误下">音频轨</span>';
    }
    const qualityBadge = video.quality
      ? `<span class="video-type-badge track-quality">${escapeHTML(video.quality)}</span>` : '';
    const protectBadge = video.protected
      ? '<span class="video-type-badge protected-badge" title="该站点使用私有加密流（如腾讯 cmfv），直链下载的文件无法播放，只能录制或 MSE 捕获">受保护</span>' : '';

    return `
      <div class="video-card" data-index="${index}">
        <div class="video-card-header">
          ${isMseType ? `
            <button class="play-btn play-btn-disabled" disabled title="Blob/MSE 视频无法预览播放，请直接下载">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.4">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
          ` : `
            <button class="play-btn" data-action="play" title="预览播放">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
          `}
          <div class="video-info">
            <div class="video-name" title="${escapeAttr(name)}">${escapeHTML(name)}</div>
            <div class="video-meta">
              <span class="video-format">${format}</span>
              ${typeBadge}
              ${biliBadge}
              ${mseBadge}
              ${trackBadge}
              ${qualityBadge}
              ${protectBadge}
              <span class="video-size">${sizeText}</span>
              ${durationText ? `<span class="video-size">${durationText}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="video-actions">
          ${isBiliMerged ? `
            <button class="btn btn-primary" data-action="bili-merge-download" style="background:linear-gradient(135deg,#00a1d6,#fb7299)" title="从B站API提取完整音视频流，下载后自动合并为单个MP4文件（有声有画面）">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              <span class="btn-label">合并下载</span>
            </button>
            <button class="btn btn-copy" data-action="copy" title="复制视频链接">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              <span class="btn-label">复制</span>
            </button>
          ` : isMseType ? `
            ${isMseCapture ? `
              <button class="btn btn-mse-download" data-action="mse-download" title="MSE 直下载：截获原始媒体分段，不受播放速度限制">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                <span class="btn-label">MSE 下载</span>
              </button>
            ` : ''}
            ${isMseCapture && video.track === 'video' ? `
              <button class="btn btn-mse-merge" data-action="mse-merge-download" title="合并下载：自动配对音视频轨，合并为有声有画的完整 MP4（腾讯/爱奇艺等音视频分离站点适用）">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M23 7l-7 5 7 5V7z"/>
                  <rect x="1" y="5" width="15" height="14" rx="2"/>
                </svg>
                <span class="btn-label">合并下载</span>
              </button>
            ` : ''}
            <button class="btn btn-record" data-action="record" title="录屏模式：捕获播放中的画面">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="6"/>
              </svg>
              <span class="btn-label">录制</span>
            </button>
          ` : `
            <button class="btn btn-copy" data-action="copy" title="复制视频链接">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              <span class="btn-label">复制</span>
            </button>
            <button class="btn btn-primary" data-action="download" title="${video.track === 'audio' ? '注意：这是纯音频轨（无画面）' : '普通下载：多线程分段直连下载'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              <span class="btn-label">${video.track === 'audio' ? '下音频' : '下载'}</span>
            </button>
            <button class="btn btn-force" data-action="force-download" title="强力下载：携带源页面凭证绕过防盗链">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              <span class="btn-label">强力</span>
            </button>
            <button class="btn btn-record" data-action="record" title="录屏模式：捕获播放中的画面">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="6"/>
              </svg>
              <span class="btn-label">录制</span>
            </button>
          `}
        </div>
      </div>
    `;
  }

  function createTypeBadge(type) {
    const labels = {
      'stream': '流媒体',
      'direct': '直链',
      'blob': 'Blob',
      'mse': 'Blob 流',
      'mse-capture': 'MSE',
      'audio': '音频',
      'iframe': '内嵌',
    };
    // v4.2.8：hasOwnProperty 校验 —— labels[type] 直取会命中原型链键
    //（type 来自页面嗅探数据、用户可控，如 "constructor"/"toString"），
    // 旧写法在 type 为原型链属性名时取到非字符串值并被渲染
    const label = Object.prototype.hasOwnProperty.call(labels, type)
      ? labels[type]
      : '视频';
    const isBlob = type === 'mse' || type === 'blob';
    const tip = isBlob ? 'title="Blob/MSE 视频，无法直接下载，请用录制模式"' : '';
    // type 来自页面嗅探数据（用户可控），注入 class/文本前转义
    return `<span class="video-type-badge ${escapeAttr(type || 'direct')}" ${tip}>${escapeHTML(label)}</span>`;
  }

  function attachCardListeners() {
    document.querySelectorAll('.video-card').forEach(card => {
      const index = parseInt(card.dataset.index);
      const video = [...videos].sort((a, b) => (b.score || 0) - (a.score || 0))[index];
      if (!video) return;

      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleAction(btn.dataset.action, video);
        });
      });
    });
  }

  // v4.2.8：sendMessage 统一异常包装。后台休眠唤醒失败/扩展更新导致接收端
  // 不可用时，旧代码各分支的 await 直接抛未处理 rejection，用户无任何反馈。
  // 失败时返回 { error }，交由各分支既有的错误提示路径展示。
  async function safeSend(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { error: `通信失败：${err?.message || '后台服务不可用'}` };
    }
  }

  async function handleAction(action, video) {
    // 确保视频有名称（后台和下载页依赖此字段命名文件）
    if (!video.name) {
      video.name = guessNameFromURL(video.url);
    }

    // Blob/MSE 视频（blob: 或 mse:// 协议）无法通过常规 HTTP 下载
    const isBlobUrl = video.url && video.url.startsWith('blob:');
    const isMseUrl = video.url && video.url.startsWith('mse://');
    const isMseAction = action === 'mse-download' || isMseUrl || isBlobUrl;

    // 非特殊协议的操作需要 URL 安全校验
    if (!isMseAction && !isSafeUrl(video.url) && action !== 'record') {
      showToast('URL 不合法，拒绝操作');
      return;
    }

    // 优先用条目自带的帧来源 Referer（站内 iframe 内嗅探的流，
    // 防盗链校验的是播放器所在页而非顶层页），兜底顶层页 URL
    // tabId：让后台把下载页开在原视频标签页右侧（而非标签栏末尾）
    const msgBase = { video, referer: video.referer || currentTabUrl, tabId: currentTabId };

    switch (action) {
      case 'play':
        // Blob/MSE 视频无法在独立播放页打开
        if (isBlobUrl || isMseUrl) {
          showToast('此视频无法预览播放，请直接下载或录制');
          return;
        }
        {
          const r = await safeSend({ type: 'play-video', video, tabId: currentTabId });
          if (r?.error) { showToast(r.error); return; }
          window.close();
        }
        break;

      case 'mse-download':
        if (!video.captureId) {
          showToast('缺少捕获 ID，无法导出 MSE 数据');
          return;
        }
        {
          const resp = await safeSend({
            type: 'mse-download',
            captureId: video.captureId,
            tabId: currentTabId,
            frameId: typeof video.frameId === 'number' ? video.frameId : undefined,
            video,
          });
          if (resp?.error) { showToast(resp.error); return; }
          showToast('正在导出 MSE 捕获数据…');
          setTimeout(() => window.close(), 1200);
        }
        break;

      case 'mse-merge-download':
        // v4.1：音视频轨合并下载
        if (!video.captureId) {
          showToast('缺少捕获 ID，无法合并下载');
          return;
        }
        {
          const mergeResp = await safeSend({
            type: 'mse-merge-download',
            captureId: video.captureId,
            tabId: currentTabId,
            frameId: typeof video.frameId === 'number' ? video.frameId : undefined,
            video,
          });
          if (mergeResp?.error) { showToast(mergeResp.error); return; }
          showToast('正在合并音视频轨…请保持视频页打开');
          setTimeout(() => window.close(), 1200);
        }
        break;

      case 'copy':
        {
          const r = await safeSend({ type: 'copy-url', url: video.url });
          if (r?.error) { showToast(r.error); return; }
          showToast('链接已复制到剪贴板');
        }
        break;

      case 'download':
        {
          const r = await safeSend({ type: 'start-download', ...msgBase });
          if (r?.error) { showToast(r.error); return; }
          window.close();
        }
        break;

      case 'force-download':
        {
          const r = await safeSend({ type: 'start-force-download', ...msgBase });
          if (r?.error) { showToast(r.error); return; }
          window.close();
        }
        break;

      case 'record':
        {
          // v4.3.1 读取倍速选择(借鉴 CocoCut timectr.js 思路):
          // 加速 playbackRate 缩短实际录制时长,源码率不变但总耗时 ÷ N
          const speedSelect = document.getElementById('record-speed');
          const recordSpeed = parseInt(speedSelect?.value || '1', 10);
          const r = await safeSend({
            type: 'start-record',
            video,
            tabId: currentTabId,
            recordSpeed: recordSpeed > 1 ? recordSpeed : 1,
          });
          if (r?.error) { showToast(r.error); return; }
          showToast(recordSpeed > 1
            ? `录制已开始（${recordSpeed}x 加速），请在页面上播放视频`
            : '录制已开始，请在页面上播放视频');
          setTimeout(() => window.close(), 800);
        }
        break;

      case 'bili-merge-download':
        // B站下载：通过API获取标准MP4直链，直接下载（无需合并）
        if (!video.biliData?.videoUrl) {
          showToast('缺少B站视频流地址');
          return;
        }
        {
          const r = await safeSend({
            type: 'start-bili-merge-download',
            video,
            referer: currentTabUrl,
            tabId: currentTabId,
          });
          if (r?.error) { showToast(r.error); return; }
          showToast('正在下载B站视频…');
          setTimeout(() => window.close(), 1200);
        }
        break;
    }
  }

  function setupListeners() {
    document.getElementById('rescan-btn').addEventListener('click', () => {
      const statusText = document.getElementById('status-text');
      const statusDot = document.querySelector('.status-dot');
      statusDot.classList.remove('found');
      statusDot.classList.add('scanning');
      statusText.textContent = '正在重新扫描…';

      chrome.tabs.sendMessage(currentTabId, { type: 'manual-scan' }).catch?.(() => {});

      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(loadVideos, 1500);
    });

    document.getElementById('clear-btn').addEventListener('click', async () => {
      // v4.2.8：包 try/catch —— 后台不可用时不再抛未处理 rejection
      try {
        await chrome.runtime.sendMessage({ type: 'clear-videos', tabId: currentTabId });
      } catch (err) {
        showToast(`清除失败：${err?.message || '后台服务不可用'}`);
        return;
      }
      videos = [];
      renderVideos();
    });

    const privacyBtn = document.getElementById('privacy-btn');
    if (privacyBtn) {
      privacyBtn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'privacy-cleanup' });
        } catch (err) {
          showToast(`清除失败：${err?.message || '后台服务不可用'}`);
          return;
        }
        videos = [];
        renderVideos();
        showToast('已清除所有下载痕迹');
      });
    }
  }

  // ============================================================
  // 工具
  // ============================================================
  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '大小未知';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function guessNameFromURL(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const last = parts[parts.length - 1];
      if (last) {
        const name = decodeURIComponent(last.split('?')[0]).slice(0, 60);
        // 如果是哈希乱码（纯字母数字≥8位），用域名代替
        if (/^[a-zA-Z0-9_-]{8,}$/.test(name.replace(/\.\w+$/, ''))) {
          return u.hostname;
        }
        return name;
      }
      return u.hostname;
    } catch {
      return '未命名视频';
    }
  }

  function escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  init();
})();
