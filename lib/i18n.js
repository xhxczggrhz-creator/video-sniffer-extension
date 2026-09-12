/**
 * 视频嗅探器 · 国际化（i18n）最小实现
 *
 * 设计原则（长期可维护）：
 * 1. 只用 Chrome 原生机制 —— `_locales/<lang>/messages.json` + `chrome.i18n.getMessage`。
 *    Chrome 会自动按用户界面语言加载对应语言包，缺失的键自动回落到
 *    `manifest.default_locale`（zh_CN），因此**新增语言只需新增一个 JSON 文件，零代码改动**。
 * 2. 失败永不白屏 —— `t()` 在拿不到译文时返回键名本身（明显的开发期信号），
 *    HTML 上的中文原文作为无 JS 兜底保持不变，`data-i18n` 只做替换。
 * 3. 双形态加载 —— 既可作为普通 <script>（定义全局 t），
 *    也可被 ES Module 用 `import '../lib/i18n.js'` 侧效应加载（service worker）。
 *
 * 用法：
 *   t('popup_download')                  → "下载" / "Download"
 *   t('popup_found', [3])                → "已检测到 3 个视频" / "3 video(s) found"
 *   VSI18N.localizeDom(document)         → 替换 [data-i18n] / [data-i18n-title] / [data-i18n-placeholder]
 */

(function (root) {
  'use strict';

  function normalizeSubs(subs) {
    if (subs === undefined || subs === null) return undefined;
    return Array.isArray(subs) ? subs.map(String) : [String(subs)];
  }

  // Chrome 的 $1/$2 替换语义（$$ 表示字面量 $），仅 Node 路径需要自己实现
  function substitute(message, subs) {
    const list = normalizeSubs(subs) || [];
    return String(message).split('$$').map(function (part) {
      return part.replace(/\$(\d)/g, function (whole, d) {
        const v = list[Number(d) - 1];
        return v === undefined ? whole : v;
      });
    }).join('$');
  }

  // Node（单元测试 / 维护脚本）没有 chrome.i18n：直接读默认语言包，
  // 让 lib/*.js 在测试与浏览器里拿到同一份中文文案 —— 顺带让
  // `npm test` 成为「zh_CN 语言包键是否齐全」的真实校验。
  let nodeCatalog;
  let nodeCatalogLoaded = false;
  function getNodeCatalog() {
    if (nodeCatalogLoaded) return nodeCatalog;
    nodeCatalogLoaded = true;
    nodeCatalog = null;
    if (typeof require !== 'function') return nodeCatalog;
    try {
      nodeCatalog = require('../_locales/zh_CN/messages.json');
    } catch { nodeCatalog = null; }
    return nodeCatalog;
  }

  // 取译文；不可用/未命中返回 ''（由调用方决定兜底）
  function getMessage(key, subs) {
    if (!key) return '';
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n &&
          typeof chrome.i18n.getMessage === 'function') {
        const msg = chrome.i18n.getMessage(key, normalizeSubs(subs));
        if (msg) return msg;
      }
    } catch { /* 非扩展上下文（Node 单测 / MAIN world）静默降级 */ }
    const catalog = getNodeCatalog();
    if (catalog && catalog[key] && typeof catalog[key].message === 'string') {
      return substitute(catalog[key].message, subs);
    }
    return '';
  }

  // 主入口：拿不到译文时返回键名（开发期一眼可见，绝不返回空串）
  function t(key, subs) {
    return getMessage(key, subs) || String(key || '');
  }

  // 需要自定义兜底文案时使用（一般不需要，中文原文在 _locales/zh_CN 里）
  function tOr(key, fallback, subs) {
    return getMessage(key, subs) || fallback || String(key || '');
  }

  function currentLocale() {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
        return chrome.i18n.getUILanguage() || '';
      }
    } catch { /* ignore */ }
    try {
      if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    } catch { /* ignore */ }
    return '';
  }

  /**
   * 就地本地化 DOM：把 HTML 里写死的中文原文替换为译文。
   * 约定：
   *   data-i18n="key"              → 替换 textContent
   *   data-i18n-title="key"        → 替换 title 属性
   *   data-i18n-placeholder="key"  → 替换 placeholder 属性
   *   data-i18n-aria-label="key"   → 替换 aria-label 属性
   */
  function localizeDom(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelectorAll) return;
    d.querySelectorAll('[data-i18n]').forEach(function (el) {
      const msg = getMessage(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    const attrPairs = [
      ['title', 'data-i18n-title'],
      ['placeholder', 'data-i18n-placeholder'],
      ['aria-label', 'data-i18n-aria-label'],
    ];
    attrPairs.forEach(function (pair) {
      d.querySelectorAll('[' + pair[1] + ']').forEach(function (el) {
        const msg = getMessage(el.getAttribute(pair[1]));
        if (msg) el.setAttribute(pair[0], msg);
      });
    });
    const lang = currentLocale();
    if (lang && d.documentElement) d.documentElement.lang = lang;
  }

  const api = {
    t: t,
    tOr: tOr,
    getMessage: getMessage,
    localizeDom: localizeDom,
    locale: currentLocale,
    // 供 UI 判断当前是否中文（例如决定是否显示语言切换提示）
    isChinese: function () { return /^zh/i.test(currentLocale()); },
  };

  root.VSI18N = api;
  // 全局简写，方便普通 <script> 直接 t(...)
  if (typeof root.t !== 'function') root.t = t;

  // 页面上下文：DOM 就绪后自动本地化。
  // 仅限扩展自己的页面 —— 本文件也会作为内容脚本注入每个页面的每个 frame，
  // 那种场景下不该去扫/改宿主页面 DOM（无谓开销，且页面自带的同名属性有被误改的风险）。
  const IS_EXT_PAGE = typeof location !== 'undefined'
    && /^(chrome|moz|safari-web)-extension:$/.test(location.protocol);
  if (IS_EXT_PAGE && typeof document !== 'undefined' && !root.__VSI18N_NO_AUTO) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { localizeDom(document); });
    } else {
      localizeDom(document);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
