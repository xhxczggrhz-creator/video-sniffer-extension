/**
 * v4.3.1 Offscreen Document 处理器（借鉴 FetchV offscreen 模式）
 * ============================================================
 * 设计原则（与 FetchV 关键区别）：
 * - FetchV 的 OFFSCREEN_FETCH_DATA：fetch 外部 URL → blob → 回传 URL
 *   （用于绕过 SW 无 DOM 限制做跨域抓取）
 * - 我们硬约束"隐私零外泄"+"不做外部 fetch"，因此**只处理本地 blob**：
 *   SW/content 把已捕获的 blob: URL 传入 → 这里读取合并 → 回传新 blob URL
 * - 不读 navigator/cookie/UA，不上传任何字节，输出仍走扩展内部
 *
 * 安全检查：
 * - 每个传入的 URL 必须是 blob: 协议（拒绝 http/file/data 等）
 * - 单次合并总大小上限 2GB（防 OOM）
 * - 单个 blob 读取超时 60s（防挂起）
 * - 任何异常都不向上层泄漏 blob 内容，只回传错误码
 */

(() => {
  'use strict';

  // v4.3.1 修订：上限对齐 mp4-merger 的 800MB 防止 OOM
  // （offscreen document 是网页，内存上限通常 1-2GB，累积 2GB Blob 数组会崩溃）
  const MAX_TOTAL_BYTES = 800 * 1024 * 1024;       // 800MB 总大小上限
  const SINGLE_FETCH_TIMEOUT_MS = 60 * 1000;      // 单个 blob 读取 60s 超时

  /**
   * 校验传入 URL 是否为本扩展本地 blob:
   * 拒绝一切非 blob 协议（防止被 SW 转发或页面伪造触发外部 fetch）
   */
  function isSafeBlobUrl(u) {
    if (typeof u !== 'string') return false;
    try {
      const url = new URL(u);
      return url.protocol === 'blob:';
    } catch {
      return false;
    }
  }

  /**
   * 带超时地读取一个 blob URL 为 Blob
   */
  async function fetchBlobWithTimeout(blobUrl, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort(new Error('Offscreen: blob 读取超时（60s）'));
    }, timeoutMs);
    try {
      const resp = await fetch(blobUrl, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error(`Offscreen: blob 读取失败 status=${resp.status}`);
      return await resp.blob();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 合并多个 blob URL 为单个 Blob，返回新的 blob URL
   * @param {string[]} blobUrls
   * @returns {Promise<{ok: true, blobURL: string, size: number} | {ok: false, error: string}>}
   */
  async function mergeBlobs(blobUrls) {
    if (!Array.isArray(blobUrls) || blobUrls.length === 0) {
      return { ok: false, error: '空 blob 列表' };
    }
    // 安全校验：全部必须是 blob: 协议
    for (const u of blobUrls) {
      if (!isSafeBlobUrl(u)) {
        return { ok: false, error: '非法 URL（仅允许 blob: 协议）' };
      }
    }

    const blobs = [];
    let total = 0;
    for (const u of blobUrls) {
      try {
        const b = await fetchBlobWithTimeout(u, SINGLE_FETCH_TIMEOUT_MS);
        total += b.size;
        if (total > MAX_TOTAL_BYTES) {
          // 防止内存爆炸：超出立即终止，已读 Blob 留给 GC
          return { ok: false, error: `合并总大小超限（>${MAX_TOTAL_BYTES}B）` };
        }
        blobs.push(b);
      } catch (e) {
        const reason = e?.name === 'AbortError'
          ? (e?.message || 'blob 读取超时')
          : (e?.message || 'blob 读取失败');
        return { ok: false, error: reason };
      }
    }

    if (blobs.length === 1) {
      // 单个 blob 无需合并，直接新建 URL 引用（避免修改原 blob）
      return { ok: true, blobURL: URL.createObjectURL(blobs[0]), size: blobs[0].size };
    }

    const merged = new Blob(blobs, { type: blobs[0].type || 'application/octet-stream' });
    return { ok: true, blobURL: URL.createObjectURL(merged), size: merged.size };
  }

  // ============================================================
  // 消息入口：仅响应本扩展 SW 的指令
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 严格来源校验：只接受同扩展 SW 发来的消息
    if (!msg || !sender || sender.id !== chrome.runtime.id) return;
    const { cmd } = msg;

    if (cmd === 'OFFSCREEN_MERGE_BLOBS') {
      const { blobUrls } = msg;
      mergeBlobs(blobUrls)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e?.message || '未知错误' }));
      return true; // 保持异步 sendResponse
    }

    if (cmd === 'OFFSCREEN_PING') {
      sendResponse({ ok: true, pong: true, ts: Date.now() });
      return false;
    }

    // 未知指令静默丢弃（不回传，避免触发 SW 异常）
    return false;
  });

  // 启动标记
  console.log('[VideoSniffer] Offscreen document ready (v4.3.1)');
})();
