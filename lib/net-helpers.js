/**
 * 视频嗅探器 - 共享网络助手 v1.0（O-4 抽取）
 *
 * 抽取 stream-downloader.js / download-engine.js 中重复的网络/错误处理逻辑，
 * 统一维护，避免两处实现漂移。
 *
 * 暴露方式：window.__VideoSnifferNetHelpers__（与 mp4-merger.js / ts-remux.js
 * 一致的 <script> 注入模式，便于 download.html 按现有 script 顺序加载，
 * 也兼容 test-engine-v3.js 的 new Function(src) 加载方式——后者不会加载本
 * 文件，引擎/下载器内部各有「未注入则本地兜底」的回退定义，测试零改动）。
 *
 * 隐私：所有助手纯本地运算，不向任何第三方发送数据；错误脱敏只剥离 URL，
 * 不向控制台/上层泄漏完整地址。
 */

(function () {
  'use strict';

  // Node/非扩展上下文兜底（无 chrome.i18n 时返回键名），避免单测 ReferenceError
  const t = (typeof globalThis.t === 'function') ? globalThis.t : ((k) => k);

  // ============================================================
  // 错误脱敏：剥离 URL（防 CDN 签名/查询串泄漏到控制台或上层 UI）
  // 同时把非字符串错误归一为字符串，便于日志/上报统一处理。
  // ============================================================
  function sanitizeErrorMessage(err) {
    const raw = String(err?.message ?? err ?? '');
    return raw.replace(/https?:\/\/[^\s'"]+/g, '[URL]');
  }

  // ============================================================
  // 后台消息发送（带竞速超时 + SW 唤醒）
  // 旧版 chrome.runtime.sendMessage 在 MV3 无内置超时——SW 休眠或事件循环
  // 被 OPFS 写大文件阻塞时，sendMessage 会挂起直到报错 "Could not establish
  // connection"。本助手用 Promise.race 给一个默认 25s 硬超时，让上层能
  // 立即降级。唤醒 SW 用 connect/disconnect（幂等，对工作中的 SW 无副作用）。
  // ============================================================
  async function sendBgMessage(message, timeoutMs = 25000) {
    // 唤醒 SW：connect/disconnect 强制激活休眠中的 SW（幂等，对工作 SW 无影响）
    try {
      const wakeUp = chrome.runtime.connect({ name: 'keepalive' });
      setTimeout(() => { try { wakeUp.disconnect(); } catch {} }, 50);
    } catch {}

    const raw = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(t('nh_sw_timeout', [timeoutMs / 1000, message?.type]))),
        timeoutMs,
      )),
    ]).catch((e) => {
      // 错误脱敏 + 控制台输出（卡 0% 时必须能看到日志，不能静默）
      console.warn('[VideoSniffer] sendBgMessage 失败:', sanitizeErrorMessage(e), 'type=', message?.type);
      throw e;
    });

    // v4.2.1 信封协议：SW 把所有处理器结果包装为 { success, data } / { success: false, error }
    if (raw && typeof raw === 'object' && 'success' in raw) {
      return raw.success ? (raw.data ?? {}) : { error: raw.error || t('nh_bg_failed') };
    }
    return raw;
  }

  // ============================================================
  // 指数退避 + 抖动（避免多连接同时重试导致惊群）
  // 参数：
  //   attempt  当前已失败次数（从 0 开始）
  //   base     基础退避毫秒（默认 300）
  //   cap      退避上限毫秒（默认 10000）
  // 返回：建议等待毫秒数（含 ±250ms 抖动）
  // ============================================================
  function exponentialBackoff(attempt, base = 300, cap = 10000) {
    const exp = Math.min(cap, base * Math.pow(2, attempt));
    return exp + Math.random() * 250;
  }

  const api = {
    sendBgMessage,
    exponentialBackoff,
    sanitizeErrorMessage,
  };

  // 同时挂到 window 与 globalThis，兼容浏览器扩展页 / Node 测试环境
  if (typeof window !== 'undefined') window.__VideoSnifferNetHelpers__ = api;
  if (typeof globalThis !== 'undefined') globalThis.__VideoSnifferNetHelpers__ = api;
})();
