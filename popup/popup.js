/**
 * 视频嗅探器 - 弹窗逻辑 v4.4.0
 * 视频列表展示与交互（列表已按价值分数排序，最优结果在最上面）
 *
 * v4.4.0：
 * - 国际化：所有用户可见文案走 t()，语言包见 _locales/
 * - 借鉴同类扩展（猫抓 / Video DownloadHelper）：
 *   · 列表搜索过滤 + 排序（条目多时不必再逐条找）
 *   · 「更多复制方式」：链接 / curl / aria2c / ffmpeg 命令（便于交给外部下载器）
 *
 * 安全加固：
 * - URL 验证：所有操作前校验视频 URL 合法性
 * - XSS 防护：所有用户可控内容均经 HTML 转义
 * - 隐私清除：一键清除所有痕迹
 */

(function () {
  'use strict';

  // i18n 兜底：i18n.js 未加载时退化为键名，绝不让弹窗白屏
  const t = (key, subs) => (typeof globalThis.t === 'function' ? globalThis.t(key, subs) : key);

  // v4.4.1 粘贴下载：能从 URL 判定的媒体扩展名（其余按 mp4 交给下载页自行判定）
  const EXT_HINTS = new Set(['m3u8', 'mpd', 'mp4', 'm4s', 'ts', 'webm', 'mkv', 'flv', 'mov', 'm4a', 'mp3']);

  let currentTabId = null;
  let currentTabUrl = null;
  let videos = [];
  let renderedVideos = [];   // 当前实际渲染顺序（筛选 + 排序后）
  let filterText = '';
  let sortMode = 'score';
  let scanTimeout = null;
  let filterTimer = null;
  let copyMenuEls = null;

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

    await loadPrefs();
    // #status-text 的初始文案由 JS 写（不能放 data-i18n：localizeDom 会在
    // DOMContentLoaded 覆盖 JS 已写入的扫描状态）
    document.getElementById('status-text').textContent = t('popup_scanning');

    await loadVideos();
    setupStorageListener();
    setupListeners();

    // 触发一次手动扫描（内容脚本可能加载较晚）
    chrome.tabs.sendMessage(currentTabId, { type: 'manual-scan' }).catch?.(() => {});
  }

  async function loadPrefs() {
    try {
      const stored = await chrome.storage.local.get('popupPrefs');
      const sort = stored?.popupPrefs?.sort;
      if (typeof sort === 'string') sortMode = sort;
    } catch {}
    const sel = document.getElementById('sort-select');
    if (sel) sel.value = sortMode;
  }

  function savePrefs() {
    try { chrome.storage.local.set({ popupPrefs: { sort: sortMode } }); } catch {}
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

  function displayName(video) {
    return video.name || guessNameFromURL(video.url);
  }

  function matchesFilter(video, query) {
    const hay = [video.name, video.url, video.format, video.type, video.quality];
    return hay.some(v => String(v == null ? '' : v).toLowerCase().includes(query));
  }

  function sortVideos(list) {
    const arr = [...list];
    switch (sortMode) {
      case 'size': arr.sort((a, b) => (b.size || 0) - (a.size || 0)); break;
      case 'name': arr.sort((a, b) => displayName(a).localeCompare(displayName(b))); break;
      case 'type':
        arr.sort((a, b) => String(a.type || '').localeCompare(String(b.type || ''))
          || (b.score || 0) - (a.score || 0));
        break;
      default: arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    return arr;
  }

  function renderVideos() {
    const list = document.getElementById('video-list');
    const emptyState = document.getElementById('empty-state');
    const statusBar = document.getElementById('status-bar');
    const statusText = document.getElementById('status-text');
    const statusDot = statusBar.querySelector('.status-dot');
    const toolbar = document.getElementById('toolbar');

    if (videos.length === 0) {
      list.innerHTML = '';
      emptyState.style.display = 'flex';
      statusBar.style.display = 'none';
      toolbar.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    statusBar.style.display = 'flex';
    toolbar.style.display = 'flex';
    statusDot.classList.remove('scanning');
    statusDot.classList.add('found');

    const query = filterText.trim().toLowerCase();
    renderedVideos = sortVideos(query ? videos.filter(v => matchesFilter(v, query)) : videos);

    statusText.textContent = query
      ? t('popup_found_filtered', [renderedVideos.length, videos.length])
      : t('popup_found_count', [videos.length]);

    if (renderedVideos.length === 0) {
      list.innerHTML = `<div class="filter-empty">${escapeHTML(t('popup_filter_empty'))}</div>`;
      return;
    }

    list.innerHTML = renderedVideos.map((video, index) => createVideoCard(video, index)).join('');
    attachCardListeners();
  }

  function createVideoCard(video, index) {
    const name = displayName(video);
    // 流媒体清单（m3u8/mpd）显示的 KB 数只是清单文件本身的大小，不是视频
    // 体积 —— 直接展示会让人误以为"35KB 的零碎"而错过真正的完整视频
    const isStreamManifest = video.type === 'stream' && (!video.size || video.size < 1048576);
    const sizeText = isStreamManifest ? t('popup_full_video') : formatSize(video.size);
    // format/type 均来自页面嗅探数据（用户可控），渲染前必须转义
    const format = escapeHTML((video.format || 'video').toUpperCase());
    const typeBadge = createTypeBadge(video.type);
    const durationText = formatDuration(video.duration);
    const isMseCapture = video.type === 'mse-capture';
    const isBlobUrl = video.type === 'mse' || (video.url && video.url.startsWith('blob:'));
    const isMseType = isMseCapture || isBlobUrl;
    const isBiliMerged = video.type === 'bilibili-merged';
    const mseBadge = isMseCapture ? `<span class="video-type-badge mse-capture-badge" title="${escapeAttr(t('popup_badge_mse_title'))}">${escapeHTML(t('popup_badge_mse'))}</span>` : '';
    // B站合并下载徽章
    const biliBadge = isBiliMerged ? `<span class="video-type-badge" style="background:#00a1d6;color:#fff" title="${escapeAttr(t('popup_badge_bili_title'))}">${escapeHTML(t('popup_badge_bili'))}</span>` : '';

    // 轨道徽章 + 清晰度 + 受保护标注：
    // B站等 DASH 站点音视频轨分离，同页多条同名条目（视频轨 300MB / 音频轨 12MB），
    // 不标注的话用户极易误下音频轨（"12 分钟视频只有 12MB"的直接根因）
    let trackBadge = '';
    if (video.track === 'video') {
      trackBadge = `<span class="video-type-badge track-video" title="${escapeAttr(t('popup_track_video_title'))}">${escapeHTML(t('popup_track_video'))}</span>`;
    } else if (video.track === 'audio') {
      trackBadge = `<span class="video-type-badge track-audio" title="${escapeAttr(t('popup_track_audio_title'))}">${escapeHTML(t('popup_track_audio'))}</span>`;
    }
    const qualityBadge = video.quality
      ? `<span class="video-type-badge track-quality">${escapeHTML(video.quality)}</span>` : '';
    const protectBadge = video.protected
      ? `<span class="video-type-badge protected-badge" title="${escapeAttr(t('popup_protected_title'))}">${escapeHTML(t('popup_protected'))}</span>` : '';

    // v4.4.0 每条都有「更多复制方式」，不必复制后自己拼下载命令
    const moreBtn = `
      <button class="btn btn-more" data-action="more" title="${escapeAttr(t('popup_menu_more_title'))}">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>`;

    return `
      <div class="video-card" data-index="${index}">
        <div class="video-card-header">
          ${isMseType ? `
            <button class="play-btn play-btn-disabled" disabled title="${escapeAttr(t('popup_play_disabled_title'))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.4">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </button>
          ` : `
            <button class="play-btn" data-action="play" title="${escapeAttr(t('popup_play_title'))}">
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
              <span class="video-size">${escapeHTML(sizeText)}</span>
              ${durationText ? `<span class="video-size">${escapeHTML(durationText)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="video-actions">
          ${isBiliMerged ? `
            <button class="btn btn-primary" data-action="bili-merge-download" style="background:linear-gradient(135deg,#00a1d6,#fb7299)" title="${escapeAttr(t('popup_merge_title_bili'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_merge_download'))}</span>
            </button>
            <button class="btn btn-copy" data-action="copy" title="${escapeAttr(t('popup_copy_title'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_copy'))}</span>
            </button>
            ${hasQualityOptions(video) ? `
              <button class="btn btn-copy" data-action="quality" title="${escapeAttr(t('popup_quality_title'))}">
                <span class="btn-label">${escapeHTML(t('popup_btn_quality'))}</span>
              </button>
            ` : ''}
            ${moreBtn}
          ` : isMseType ? `
            ${isMseCapture ? `
              <button class="btn btn-mse-download" data-action="mse-download" title="${escapeAttr(t('popup_mse_download_title'))}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                <span class="btn-label">${escapeHTML(t('popup_btn_mse_download'))}</span>
              </button>
            ` : ''}
            ${isMseCapture && video.track === 'video' ? `
              <button class="btn btn-mse-merge" data-action="mse-merge-download" title="${escapeAttr(t('popup_merge_title_mse'))}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M23 7l-7 5 7 5V7z"/>
                  <rect x="1" y="5" width="15" height="14" rx="2"/>
                </svg>
                <span class="btn-label">${escapeHTML(t('popup_btn_merge_download'))}</span>
              </button>
            ` : ''}
            <button class="btn btn-record" data-action="record" title="${escapeAttr(t('popup_record_title'))}">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="6"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_record'))}</span>
            </button>
            ${moreBtn}
          ` : `
            <button class="btn btn-copy" data-action="copy" title="${escapeAttr(t('popup_copy_title'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_copy'))}</span>
            </button>
            <button class="btn btn-primary" data-action="download" title="${escapeAttr(video.track === 'audio' ? t('popup_download_audio_title') : t('popup_download_title'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              <span class="btn-label">${escapeHTML(video.track === 'audio' ? t('popup_download_audio') : t('popup_btn_download'))}</span>
            </button>
            <button class="btn btn-force" data-action="force-download" title="${escapeAttr(t('popup_force_title'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_force'))}</span>
            </button>
            <button class="btn btn-record" data-action="record" title="${escapeAttr(t('popup_record_title'))}">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="6"/>
              </svg>
              <span class="btn-label">${escapeHTML(t('popup_btn_record'))}</span>
            </button>
            ${moreBtn}
          `}
        </div>
      </div>
    `;
  }

  function createTypeBadge(type) {
    // Blob / MSE 是语言中立的缩写，保留字面量
    const labels = {
      'stream': t('popup_badge_stream'),
      'direct': t('popup_badge_direct'),
      'blob': 'Blob',
      'mse': 'Blob',
      'mse-capture': 'MSE',
      'audio': t('popup_badge_audio'),
      'iframe': t('popup_badge_iframe'),
    };
    // v4.2.8：hasOwnProperty 校验 —— labels[type] 直取会命中原型链键
    //（type 来自页面嗅探数据、用户可控，如 "constructor"/"toString"），
    // 旧写法在 type 为原型链属性名时取到非字符串值并被渲染
    const label = Object.prototype.hasOwnProperty.call(labels, type)
      ? labels[type]
      : t('popup_badge_video');
    const isBlob = type === 'mse' || type === 'blob';
    const tip = isBlob ? `title="${escapeAttr(t('popup_blob_tip'))}"` : '';
    // type 来自页面嗅探数据（用户可控），注入 class/文本前转义
    return `<span class="video-type-badge ${escapeAttr(type || 'direct')}" ${tip}>${escapeHTML(label)}</span>`;
  }

  function attachCardListeners() {
    document.querySelectorAll('.video-card').forEach(card => {
      const index = parseInt(card.dataset.index);
      const video = renderedVideos[index];
      if (!video) return;

      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleAction(btn.dataset.action, video, btn);
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
      return { error: t('popup_err_comm', [err?.message || t('popup_err_bg_down')]) };
    }
  }

  async function handleAction(action, video, btnEl) {
    // 确保视频有名称（后台和下载页依赖此字段命名文件）
    if (!video.name) {
      video.name = guessNameFromURL(video.url);
    }

    // Blob/MSE 视频（blob: 或 mse:// 协议）无法通过常规 HTTP 下载
    const isBlobUrl = video.url && video.url.startsWith('blob:');
    const isMseUrl = video.url && video.url.startsWith('mse://');
    const isMseAction = action === 'mse-download' || isMseUrl || isBlobUrl;

    // 非特殊协议的操作需要 URL 安全校验
    if (!isMseAction && action !== 'record' && action !== 'more' && action !== 'quality' && !isSafeUrl(video.url)) {
      showToast(t('popup_err_invalid_url'));
      return;
    }

    // 优先用条目自带的帧来源 Referer（站内 iframe 内嗅探的流，
    // 防盗链校验的是播放器所在页而非顶层页），兜底顶层页 URL
    // tabId：让后台把下载页开在原视频标签页右侧（而非标签栏末尾）
    const msgBase = { video, referer: video.referer || currentTabUrl, tabId: currentTabId };

    switch (action) {
      case 'more':
        openCopyMenu(btnEl, video);
        break;

      case 'quality':
        // 画质/音质自选：B站双轨用后台已存轨道，流媒体抓一次主清单
        await openQualityMenu(btnEl, video);
        break;

      case 'play':
        // Blob/MSE 视频无法在独立播放页打开
        if (isBlobUrl || isMseUrl) {
          showToast(t('popup_toast_no_preview'));
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
          showToast(t('popup_err_no_capture'));
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
          showToast(t('popup_toast_mse_exporting'));
          setTimeout(() => window.close(), 1200);
        }
        break;

      case 'mse-merge-download':
        // v4.1：音视频轨合并下载
        if (!video.captureId) {
          showToast(t('popup_err_no_capture_merge'));
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
          showToast(t('popup_toast_merging'));
          setTimeout(() => window.close(), 1200);
        }
        break;

      case 'copy':
        await copyText(video.url);
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
            ? t('popup_toast_record_started_speed', [recordSpeed])
            : t('popup_toast_record_started'));
          setTimeout(() => window.close(), 800);
        }
        break;

      case 'bili-merge-download':
        // B站下载：通过API获取标准MP4直链，直接下载（无需合并）
        if (!video.biliData?.videoUrl) {
          showToast(t('popup_err_no_bili'));
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
          showToast(t('popup_toast_bili_downloading'));
          setTimeout(() => window.close(), 1200);
        }
        break;
    }
  }

  // ============================================================
  // v4.4.0 复制：链接 / curl / aria2c / ffmpeg 命令
  // 借鉴猫抓、Video DownloadHelper 的「复制为命令行」能力：
  // 嗅探到的地址往往需要带上 Referer 才能被外部下载器拉取。
  // ============================================================

  // shell 双引号转义（bash/PowerShell 通用够用）
  function shq(value) {
    return '"' + String(value == null ? '' : value).replace(/(["\\$`])/g, '\\$1') + '"';
  }

  function refererOf(video) {
    return video.referer || currentTabUrl || '';
  }

  function buildCurl(video) {
    const ref = refererOf(video);
    return `curl -L -o ${shq(displayName(video))}${ref ? ' -e ' + shq(ref) : ''} ${shq(video.url)}`;
  }

  function buildAria2c(video) {
    const ref = refererOf(video);
    return `aria2c -x8 -s8 -k1M${ref ? ' --referer=' + shq(ref) : ''} -o ${shq(displayName(video))} ${shq(video.url)}`;
  }

  function buildFfmpeg(video) {
    const ref = refererOf(video);
    // ffmpeg -headers 需要字面量 \r\n（shell 引号内保留反斜杠）
    const headers = ref ? ' -headers ' + shq('Referer: ' + ref + '\\r\\n') : '';
    const out = displayName(video).replace(/\.[a-z0-9]{1,5}$/i, '') + '.mp4';
    return `ffmpeg${headers} -i ${shq(video.url)} -c copy ${shq(out)}`;
  }

  function closeCopyMenu() {
    if (!copyMenuEls) return;
    copyMenuEls.backdrop.remove();
    copyMenuEls.menu.remove();
    copyMenuEls = null;
  }

  // 通用浮动菜单：items = [[label, onClick|null], ...]。
  // onClick 非函数 → 渲染成不可点击的分节标题（画质/音质分组用）。
  function openMenu(btnEl, items) {
    if (!btnEl) return;
    closeCopyMenu();

    const backdrop = document.createElement('div');
    backdrop.className = 'menu-backdrop';
    backdrop.addEventListener('click', closeCopyMenu);

    const menu = document.createElement('div');
    menu.className = 'copy-menu';
    for (const [label, onClick] of items) {
      if (typeof onClick !== 'function') {
        const head = document.createElement('div');
        head.className = 'copy-menu-header';
        head.textContent = label;
        menu.appendChild(head);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeCopyMenu();
        onClick();
      });
      menu.appendChild(b);
    }

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    menu.classList.add('open');

    // fixed 定位 + 按需翻转，避免被 .video-list 的滚动容器裁切
    const rect = btnEl.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(Math.max(6, rect.right - mw), Math.max(6, window.innerWidth - mw - 6));
    let top = rect.top - mh - 4;
    if (top < 6) top = Math.min(rect.bottom + 4, window.innerHeight - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = Math.max(6, top) + 'px';

    copyMenuEls = { backdrop, menu };
  }

  function openCopyMenu(btnEl, video) {
    const items = [
      [t('popup_copy_url'), () => video.url],
      [t('popup_copy_curl'), () => buildCurl(video)],
      [t('popup_copy_aria2c'), () => buildAria2c(video)],
      [t('popup_copy_ffmpeg'), () => buildFfmpeg(video)],
      [t('popup_copy_name'), () => displayName(video)],
    ].map(([label, getValue]) => [label, () => copyText(getValue())]);
    if (hasQualityOptions(video)) {
      items.unshift([t('popup_quality_pick'), () => openQualityMenu(btnEl, video)]);
    }
    openMenu(btnEl, items);
  }

  // ============================================================
  // 画质 / 音质自选
  //  · B站等 DASH 双轨条目：嗅探期后台已存下全部轨道
  //    （service-worker.js 的 biliData.allVideoStreams / allAudioStreams），
  //    这里直接列选项 —— 零额外请求，选中即换 URL 下载。
  //  · 通用 HLS/DASH：档位只在主清单里，点选时经 SW 代理抓一次清单文本
  //    （复用 SW 已验证的裸请求→防盗链补头→超时路径），解析出档位。
  //    HLS 选中档位的清单地址本身就是可下载地址（引擎零改动）；
  //    DASH 档位在清单内部，只能把高度作为偏好透传给引擎。
  // ============================================================

  // 解析 HLS 主清单档位（纯函数：tests/test-stream-variants.js 直接抽出断言）
  function parseHlsVariants(text, baseUrl) {
    const out = [];
    const seen = new Set();
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
      const attrs = line.slice(line.indexOf(':') + 1);
      // 紧跟其后的第一个非注释行才是变体地址
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const cand = lines[j].trim();
        if (!cand || cand.charAt(0) === '#') continue;
        uri = cand;
        break;
      }
      if (!uri) continue;
      let url;
      // 先按绝对地址解析（不依赖 baseUrl），失败再按主清单地址拼相对路径
      try { url = new URL(uri).href; }
      catch {
        try { url = new URL(uri, baseUrl).href; } catch { continue; }
      }
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      // (?:^|,) 锚定：避免把 AVERAGE-BANDWIDTH= 也当成 BANDWIDTH
      const bw = parseInt((attrs.match(/(?:^|,)\s*BANDWIDTH=(\d+)/i) || [])[1] || '0', 10) || 0;
      const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
      const height = res ? Math.min(parseInt(res[1], 10), parseInt(res[2], 10)) : 0;
      out.push({
        url,
        bandwidth: bw,
        height,
        label: height ? `${height}P` : (bw ? `${Math.round(bw / 1000)}kbps` : ''),
      });
    }
    // 高→低，与「最高画质排最前」的既有策略一致
    out.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return out;
  }

  // 解析 DASH MPD 档位（popup 有 DOM，用 DOMParser 精确取属性）
  function parseDashVariants(text) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(text || ''), 'application/xml'); }
    catch { return []; }
    if (!doc || doc.querySelector('parsererror')) return [];
    const byHeight = new Map();
    for (const rep of doc.querySelectorAll('Representation')) {
      const height = parseInt(rep.getAttribute('height') || '0', 10) || 0;
      // 只要视频档位：下载引擎也只挑带 height 的 Representation
      if (!height) continue;
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10) || 0;
      if (!byHeight.has(height) || (byHeight.get(height).bandwidth || 0) < bandwidth) {
        byHeight.set(height, {
          height,
          bandwidth,
          label: `${height}P` + (bandwidth ? ` · ${(bandwidth / 1e6).toFixed(1)}Mbps` : ''),
        });
      }
    }
    return [...byHeight.values()].sort((a, b) => b.height - a.height);
  }

  // 是否值得给出「画质」入口（避免给纯直链/音频轨加一个点开就空的面板）
  function hasQualityOptions(video) {
    if (!video) return false;
    if ((video.biliData?.allVideoStreams?.length || 0) > 1) return true;
    if ((video.biliData?.allAudioStreams?.length || 0) > 1) return true;
    return video.type === 'stream' && !video.track && /\.m3u8|\.mpd/i.test(video.url || '');
  }

  function videoTrackLabel(s) {
    const parts = [s.height ? `${s.height}P` : (s.id != null ? String(s.id) : '?')];
    if (s.bandwidth) parts.push(`${(s.bandwidth / 1e6).toFixed(1)}Mbps`);
    if (s.codecs) parts.push(s.codecs);
    return parts.join(' · ');
  }

  function audioTrackLabel(s) {
    const parts = [];
    if (s.bandwidth) parts.push(`${Math.round(s.bandwidth / 1000)}kbps`);
    // 无损/杜比只能靠 codecs 认（B站 30250=ec-3、30251=flac）
    if (/flac/i.test(s.codecs || '')) parts.push('FLAC 无损');
    else if (/ec-3|eac3|ac-3/i.test(s.codecs || '')) parts.push(t('sw_quality_dolby'));
    else if (s.codecs) parts.push(s.codecs);
    if (!parts.length && s.id != null) parts.push(String(s.id));
    return parts.join(' · ');
  }

  // 用选中轨道替换条目默认轨道。显式选档必须丢掉「标准 MP4 直链」——
  // 那条直链固定 1080P，且下载页策略 1 会优先用它，会让选择失效。
  function withBiliChoice(video, vTrack, aTrack) {
    const bd = { ...(video.biliData || {}) };
    if (vTrack) {
      bd.videoUrl = vTrack.url;
      bd.videoBackupUrl = vTrack.backupUrl || '';
      bd.videoCodecs = vTrack.codecs || '';
      bd.videoWidth = vTrack.width || 0;
      bd.videoHeight = vTrack.height || 0;
      bd.videoBandwidth = vTrack.bandwidth || 0;
    }
    if (aTrack) {
      bd.audioUrl = aTrack.url;
      bd.audioBackupUrl = aTrack.backupUrl || '';
      bd.audioCodecs = aTrack.codecs || '';
      bd.audioBandwidth = aTrack.bandwidth || 0;
    }
    bd.directUrl = '';
    bd.directSize = 0;
    return {
      ...video,
      biliData: bd,
      quality: vTrack?.height ? `${vTrack.height}P` : video.quality,
    };
  }

  async function openQualityMenu(btnEl, video) {
    const bd = video?.biliData || {};
    const vTracks = [...(bd.allVideoStreams || [])].sort((a, b) =>
      ((b.height || 0) - (a.height || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
    const aTracks = [...(bd.allAudioStreams || [])].sort((a, b) =>
      (b.bandwidth || 0) - (a.bandwidth || 0));

    // ---- 双轨条目：后台已有全部轨道，勾选后一键下载 ----
    if (vTracks.length > 1 || aTracks.length > 1) {
      const cur = { v: bd.videoUrl || '', a: bd.audioUrl || '' };
      const render = () => {
        const items = [[t('popup_quality_section_video'), null]];
        for (const s of vTracks) {
          const mark = cur.v && s.url === cur.v ? '✓ ' : '　';
          items.push([mark + videoTrackLabel(s), () => { cur.v = s.url; render(); }]);
        }
        if (aTracks.length > 1) {
          items.push([t('popup_quality_section_audio'), null]);
          for (const s of aTracks) {
            const mark = cur.a && s.url === cur.a ? '✓ ' : '　';
            items.push([mark + audioTrackLabel(s), () => { cur.a = s.url; render(); }]);
          }
        }
        items.push([t('popup_quality_start'), () => {
          handleAction('bili-merge-download',
            withBiliChoice(video, vTracks.find(s => s.url === cur.v), aTracks.find(s => s.url === cur.a)),
            btnEl);
        }]);
        openMenu(btnEl, items);
      };
      render();
      return;
    }

    // ---- 通用 HLS/DASH：抓一次主清单，列出档位 ----
    if (video.type !== 'stream' || !/\.m3u8|\.mpd/i.test(video.url || '')) return;
    showToast(t('popup_quality_loading'));
    const r = await safeSend({
      type: 'proxy-fetch-text',
      url: video.url,
      referer: video.referer || currentTabUrl,
    });
    const text = r?.data?.text ?? r?.text;
    if (!text) { showToast(r?.error || t('popup_quality_none')); return; }

    const isDash = /\.mpd/i.test(video.url);
    const list = isDash ? parseDashVariants(text) : parseHlsVariants(text, video.url);
    if (list.length < 2) { showToast(t('popup_quality_none')); return; }

    const items = [[t('popup_quality_section_video'), null]];
    for (const v of list) {
      const label = `${v.label}${v.bandwidth ? ` · ${(v.bandwidth / 1e6).toFixed(1)}Mbps` : ''}`;
      items.push([label, () => {
        if (v.url) {
          // HLS：档位清单本身就是可下载地址，引擎按媒体清单正常处理
          handleAction('download', { ...video, url: v.url, quality: v.label }, btnEl);
        } else {
          // DASH：档位在清单内部，把高度作为偏好透传给引擎
          handleAction('download', { ...video, preferredHeight: v.height, quality: v.label }, btnEl);
        }
      }]);
    }
    openMenu(btnEl, items);
  }

  async function copyText(text) {
    const value = String(text == null ? '' : text);
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      showToast(t('popup_toast_copied'));
      return true;
    } catch {
      // 剪贴板 API 不可用时退回后台路径（沿用它已验证的写入实现）
      const r = await safeSend({ type: 'copy-url', url: value });
      if (r?.error) { showToast(r.error); return false; }
      showToast(t('popup_toast_copied'));
      return true;
    }
  }

  function setupListeners() {
    document.getElementById('rescan-btn').addEventListener('click', () => {
      const statusText = document.getElementById('status-text');
      const statusDot = document.querySelector('.status-dot');
      statusDot.classList.remove('found');
      statusDot.classList.add('scanning');
      statusText.textContent = t('popup_rescanning');

      // 真正的重扫：后台先清空该页记录，再让内容脚本从零嗅探
      chrome.runtime.sendMessage({ type: 'rescan-page', tabId: currentTabId }).catch?.(() => {});

      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(loadVideos, 1500);
    });

    // v4.4.1 粘贴链接下载（回车触发）
    const pasteInput = document.getElementById('paste-input');
    if (pasteInput) {
      pasteInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        handlePasteDownload();
      });
    }

    // v4.4.0 搜索 / 排序
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => {
          filterText = searchInput.value || '';
          renderVideos();
        }, 150);
      });
    }

    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        sortMode = sortSelect.value;
        savePrefs();
        renderVideos();
      });
    }

    // 菜单是 fixed 定位，滚动后位置会失准，直接收起
    document.getElementById('video-list').addEventListener('scroll', closeCopyMenu, { passive: true });
    window.addEventListener('resize', closeCopyMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCopyMenu(); });

    document.getElementById('clear-btn').addEventListener('click', async () => {
      // v4.2.8：包 try/catch —— 后台不可用时不再抛未处理 rejection
      try {
        await chrome.runtime.sendMessage({ type: 'clear-videos', tabId: currentTabId });
      } catch (err) {
        showToast(t('popup_err_clear', [err?.message || t('popup_err_bg_down')]));
        return;
      }
      videos = [];
      filterText = '';
      if (searchInput) searchInput.value = '';
      renderVideos();
    });

    const privacyBtn = document.getElementById('privacy-btn');
    if (privacyBtn) {
      privacyBtn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ type: 'privacy-cleanup' });
        } catch (err) {
          showToast(t('popup_err_clear', [err?.message || t('popup_err_bg_down')]));
          return;
        }
        videos = [];
        renderVideos();
        showToast(t('popup_toast_cleared'));
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
    if (!bytes || bytes === 0) return t('popup_size_unknown');
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
    if (h > 0) return t('popup_dur_hm', [h, m]);
    if (m > 0) return t('popup_dur_ms', [m, s]);
    return t('popup_dur_s', [s]);
  }

  // v4.4.1 粘贴链接下载：复用既有 start-download 链路（后台校验 URL 后开下载页），
  // 不新增消息通道，也不改动任何嗅探逻辑。
  async function handlePasteDownload() {
    const input = document.getElementById('paste-input');
    const raw = String(input?.value || '').trim();
    if (!raw) return;
    if (!isSafeUrl(raw)) {
      showToast(t('popup_err_invalid_url'));
      return;
    }
    const format = guessFormatFromURL(raw);
    const r = await safeSend({
      type: 'start-download',
      video: {
        url: raw,
        name: guessNameFromURL(raw),
        format,
        type: (format === 'm3u8' || format === 'mpd') ? 'stream' : 'direct',
      },
      referer: currentTabUrl,
      tabId: currentTabId,
    });
    if (r?.error) { showToast(r.error); return; }
    input.value = '';
    window.close();
  }

  // 从 URL 猜格式：先看路径扩展名，再看查询串里的 m3u8 / mpd 提示
  function guessFormatFromURL(url) {
    try {
      const m = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
      if (m && EXT_HINTS.has(m[1])) return m[1];
    } catch { /* 非法 URL 由后台 isSafeUrl 拒绝 */ }
    const s = String(url || '').toLowerCase();
    if (s.includes('m3u8')) return 'm3u8';
    if (/[./=]mpd\b/.test(s)) return 'mpd';
    return 'mp4';
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
      return t('popup_name_unnamed');
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
