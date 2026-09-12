/**
 * 视频嗅探器 - 后台服务 Worker v2
 *
 * 准确性修复：
 * 1. .ts/.m4s 等流媒体分片不再被当成独立"视频"（旧版导致列表全是垃圾、红点数字爆炸）
 * 2. 按大小过滤广告/预览小视频（<300KB 的直链视频直接忽略）
 * 3. 评分排序：大文件直链 > 流媒体清单 > 页面元素，弹窗按价值排序
 * 4. 去重修复：流媒体忽略查询参数差异
 *
 * 稳定性修复：
 * 1. 所有监听器 try-catch 保护，单条异常不再导致整个嗅探崩溃
 * 2. storage 写入防抖（500ms 批量），消除写入风暴
 * 3. 单标签页视频上限 50 条，防止内存与列表失控
 * 4. 强力下载：declarativeNetRequest 动态注入 Referer/Origin（fetch 无法直接设置）
 */

// O-3 集中化常量：manifest.json 已声明 background.type=module，
// 用静态 import 引入共享常量表（替代散落硬编码）
import {
  DNS_CACHE_TTL,
  PROBE_TIMEOUT,
  KEY_FETCH_TIMEOUT,
  SEGMENT_FETCH_TIMEOUT,
  SEGMENT_STALL_TIMEOUT,
  MAX_DNS_CACHE,
  MAX_HEADER_RULE_CACHE,
  MAX_COOKIE_CACHE,
  MAX_DETECTED_VIDEOS,
  GLOBAL_CONN_BUDGET,
  MIN_CONN_PER_TASK,
  FORCE_RULE_ID_POOL_START,
  FORCE_RULE_ID_POOL_END,
  FORCE_RULE_ID_POOL_SIZE,
  COOKIE_SNAPSHOT_TTL_MS,
} from '../lib/constants.js';

// i18n：SW 无 DOM，lib/i18n.js 仅以侧效应把 VSI18N / t 挂到 globalThis 上。
// 译文缺失时 t() 返回键名本身（开发期信号，绝不返回空串）。
import '../lib/i18n.js';
const t = globalThis.VSI18N.t;

// ============================================================
// 状态
// ============================================================

const STATE = {
  detectedVideos: {},     // tabId -> VideoInfo[]
  activeDownloads: {},
  saveTimers: {},         // tabId -> timer（防抖）
};

const MAX_VIDEOS_PER_TAB = 50;
const MIN_DIRECT_SIZE = 300 * 1024;   // 300KB 以下直链视频按广告过滤

// 直链视频扩展名（可独立下载的完整文件）
const DIRECT_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v',
  'ogg', 'ogv', '3gp', 'f4v', 'm4a',
]);

// 流媒体清单扩展名
const MANIFEST_EXTS = new Set(['m3u8', 'mpd']);

// 流媒体分片扩展名 —— 这些不是完整视频，绝不作为独立条目展示
// （m4s 例外：B站 DASH 单文件轨，见 onHeadersReceived）
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'cmf']);

// 字体扩展名 —— 字体绝不是视频。部分站点（B站 hdslb 等）以
// application/octet-stream 发送 600-800KB 的大图标字体，曾被误识别为
// "直链视频"，用户下载后得到无法播放的文件（实测反馈的直接根因之一）
const FONT_EXTS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot', 'sfnt']);

// 广告/统计关键词
const JUNK_PATTERNS = [
  /\/ad[sv]?[\/._-]/i, /advert/i, /\/banner\//i, /\/pixel[\/.-]/i,
  /\/analytics[\/.-]/i, /\/beacon[\/.-]/i, /doubleclick/i, /\/tracker[\/.-]/i,
  /\/poster[\/.-]/i, /_thumb|thumbnail|preview_/i,
  /preroll|postroll|midroll/i, /adcreative/i, /adserver/i,
  /googlesyndication|googletagservices/i, /pubmatic|rubiconproject|criteo/i,
  /smartadserver|serving-sys|adnxs/i, /\/vast\//i, /\/vmap\//i,
];

// ============================================================
// 安全包装：任何监听器异常都不会导致崩溃
// ============================================================

function safe(fn) {
  return (...args) => {
    try { return fn(...args); }
    catch (err) {
      // 脱敏：将 URL 替换为 [URL]，避免控制台暴露完整地址
      const msg = String(err?.message || err).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
      console.error('[VideoSniffer]', msg);
    }
  };
}

// 判断任意 IP 字面量是否为回环/内网/链路本地(含云元数据 169.254.169.254)/
// CGNAT/组播/保留段。供 isSafeUrl（字面校验）与 dnsSafeUrl（解析结果校验）共用。
function isBlockedIpLiteral(ip) {
  const h = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const oct = h.split('.').map(Number);
    if (oct.some(o => o < 0 || o > 255)) return true;
    const [a, b, c] = oct;
    if (a === 0) return true;                    // 0.0.0.0/8
    if (a === 10) return true;                   // 10.0.0.0/8
    if (a === 127) return true;                  // 127.0.0.0/8
    if (a === 169 && b === 254) return true;     // 169.254.0.0/16 链路本地（含云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;     // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true;  // 192.0.2.0/24 TEST-NET-1（文档保留）
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;  // 203.0.113.0/24 TEST-NET-3
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
    if (a === 255) return true;                  // 广播
    if (a === 224 || a === 240) return true;     // 组播/保留
    return false;
  }
  // IPv6 字面量
  if (/^([0-9a-f:]+)$/.test(h)) {
    try {
      if (h === '::' || h === '::1' || h.startsWith('::ffff')) return true; // 未指定/回环/NAT64
      if (/^fe[89ab]/.test(h)) return true;      // fe80::/10 链路本地
      if (/^fc|^fd/.test(h)) return true;        // fc00::/7 ULA
      if (/^fec/.test(h)) return true;           // fec0::/10 site-local(遗留)
      if (/^ff/.test(h)) return true;            // ff00::/8 组播
      if (/^2001:db8/.test(h)) return true;      // 文档保留
      if (/^64:ff9b/.test(h)) return true;       // 64:ff9b::/96 NAT64
    } catch { return true; }
  }
  return false;
}

// 对主机名为域名的 URL 做一次 DNS 解析，命中内网/保留段即拒绝。
// 浏览器环境无同步 DNS API：优先用 chrome.dns.resolve（若授予权限），
// 不可用时退化为允许（浏览器的实际 fetch 由其自身解析/Secure DNS 兜底，
// 加上 isSafeUrl 的字面 IP 拦截，已构成纵深防线）。
//
// v4.2.7 修复：DNS 复查结果缓存 + 解析超时保护。
// 旧实现每次代理请求（proxy-probe / proxy-fetch-text / proxy-fetch-segment）
// 都无条件执行一次 chrome.dns.resolve，Windows 上该系统调用可能单次耗时
// 数秒（系统 DNS 慢 / DOH 冲突 / IPv6 尝试）。流媒体下载几百个分段 = 对同一
// CDN host 重复解析几百次 → "进度条好几分钟才动"的实测现场。
// 修复：
//  1. 同一 host 首次解析成功后缓存 TTL 10 分钟，后续请求瞬间命中
//     （安全不降级：首次仍完整等待；TTL 过期后重新解析；isSafeUrl 的
//      字面 IP 私有段拦截始终生效）
//  2. 解析加 12s 超时：chrome.dns.resolve 无超时控制，DNS 服务器不响应时
//     可能挂起数分钟。超时按 fail-closed 处理（不放行），旧版超时放行属
//     fail-open，DNS 劫持/挂起时内网地址可绕过复查直达 SW 代理 fetch。
//     v4.2.9 追加：超时写 60s 负缓存（依旧拒绝、只是不再重复挂 12s）+
//     single-flight 并发去重 + dnsBlockReason() 让错误信息说真话。
const DNS_CACHE = new Map();           // host -> { safe: boolean, timeout?: boolean, ts: number }
const DNS_INFLIGHT = new Map();        // host -> Promise<{safe, timeout}>（single-flight）
// DNS_CACHE_TTL 由 lib/constants.js 导入（O-3）
const DNS_TIMEOUT_TTL = 60 * 1000;     // v4.2.9：超时负缓存 60s（仍拒绝，仅不再重复挂 12s）
const DNS_RESOLVE_TIMEOUT = 12000;     // 12s
const DNS_TIMEOUT_MARK = { timeout: true };

async function dnsSafeUrl(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || '').replace(/^\[|\]$/g, '');
    if (!host) return false;
    // IP 字面量不做二次解析（已由 isSafeUrl 按字面判定）
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return isSafeUrl(url);
    if (/^([0-9a-f:]+)$/i.test(host)) return isSafeUrl(url);
    // v4.3.18 P0-2 如实标注：chrome.dns 是 Dev/Beta 渠道专属 API，稳定版 Chrome
    // 完全不注入（连权限页都查不到 dns 权限），因此此处将恒定返回 true → 本 DNS
    // 复查链在生产稳定版上整条失效。这是「浏览器 API 能力边界」，非代码缺陷：
    // 真正兜底的是 isSafeUrl 的字面 IP 私有段拦截 + 浏览器自身 fetch/Secure DNS。
    if (!chrome?.dns?.resolve) return true;      // Dev/Beta 外平台无此 API → 退化放行，仅靠字面拦截

    // v4.2.7：命中缓存直接返回（同一 CDN host 数百次分段下载只解析一次）
    // v4.2.9：超时结果走 60s 短负缓存 —— 安全不降级（依旧拒绝），只是同一
    // host 在 60s 内不再每次都重新挂满 12s（旧版超时不写缓存，master 清单、
    // media 清单、AES key 每个请求都干等 12s 再失败，是"卡清单很久后失败"
    // 的元凶）。60s 后允许重试，DNS 恢复即自愈。
    const now = Date.now();
    const cached = DNS_CACHE.get(host);
    if (cached && now - cached.ts < (cached.timeout ? DNS_TIMEOUT_TTL : DNS_CACHE_TTL)) {
      return cached.safe;
    }

    // v4.2.9 single-flight：多线程分段同时 miss 缓存时共享同一次解析，
    // 避免 N 线程并发各挂 12s（且彼此都写一遍缓存）。
    let p = DNS_INFLIGHT.get(host);
    if (!p) {
      p = (async () => {
        const res = await Promise.race([
          chrome.dns.resolve(host).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(DNS_TIMEOUT_MARK), DNS_RESOLVE_TIMEOUT)),
        ]);
        if (res === DNS_TIMEOUT_MARK) return { safe: false, timeout: true };
        let safe = true;
        if (res && res.address) {
          const addrs = Array.isArray(res.address) ? res.address : [res.address];
          for (const a of addrs) {
            if (isBlockedIpLiteral(a)) { safe = false; break; } // 任一解析结果命中内网即拒绝
          }
        }
        return { safe, timeout: false };
      })().finally(() => DNS_INFLIGHT.delete(host));
      DNS_INFLIGHT.set(host, p);
    }
    const r = await p;
    // H-1：DNS 缓存 LRU 封顶。Map 保持插入序，超 MAX_DNS_CACHE 时删最旧一条
    if (DNS_CACHE.size >= MAX_DNS_CACHE && !DNS_CACHE.has(host)) {
      const oldest = DNS_CACHE.keys().next().value;
      if (oldest) DNS_CACHE.delete(oldest);
    }
    DNS_CACHE.set(host, { safe: r.safe, timeout: r.timeout, ts: Date.now() });
    if (r.timeout) {
      // 安全审计（fail-closed）保持：超时不放行；但写负缓存 + 打原因日志，
      // 调用方经 dnsBlockReason() 能向用户暴露真实原因（不再是误导性的
      // "URL 不合法"）。
      console.warn('[VideoSniffer] DNS 复查超时（fail-closed，60s 内同 host 不再重复等待）');
    }
    return r.safe;
  } catch { return false; }
}

// v4.2.9：查询某 URL 当前被 DNS 复查拒绝的真实原因（供 proxy handler
// 在 ensureSafeRemote 拒绝时给出可读错误，替代一律"URL 不合法"）。
function dnsBlockReason(url) {
  // tests/test-dns-v429.js 会把本函数所在区段截取进独立沙箱运行（沙箱内没有
  // lib/i18n.js，t 不存在），故用 typeof 探测后回落中文原文，两处行为一致。
  const tr = (key, fallback) => (typeof t === 'function' ? t(key) : fallback);
  try {
    const host = (new URL(url).hostname || '').replace(/^\[|\]$/g, '');
    const c = DNS_CACHE.get(host);
    if (c?.timeout && Date.now() - c.ts < DNS_TIMEOUT_TTL) {
      return tr('sw_dns_timeout', 'DNS 安全校验超时：本机 DNS 解析该域名无响应（请检查系统 DNS/代理软件后重试）');
    }
    if (c && !c.safe && Date.now() - c.ts < DNS_CACHE_TTL) {
      return tr('sw_dns_private', '该域名解析到了内网/保留地址，已按 SSRF 防护拒绝');
    }
  } catch {}
  return null;
}

async function ensureSafeRemote(url) {
  return isSafeUrl(url) && await dnsSafeUrl(url);
}

// URL 安全校验：仅允许 http/https，禁止本地地址和内部协议
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    let host = (u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost') return false;
    if (host.endsWith('.localhost')) return false;
    // v4.3.18 P0-3 SSRF 修复：先做"类 IP 字面量归一化"。浏览器 new URL() 会
    // 原样保留整数/十六进制/八进制形式的 IP（如 http://2130706433/ = 127.0.0.1、
    // http://0x7f000001/、http://017700000001/），这些形态不命中点分十进制正则
    // 可被当作"域名"绕过下方 isBlockedIpLiteral。这里把纯数字/0x/前导零形态
    // 归一为点分十进制后再次拦截；正常域名（含字母等非数字字符）不命中该分支。
    const norm = normalizeIpLiteralHost(host);
    if (norm) host = norm;
    // 拦截私有网段 / 链路本地 / 云元数据 / 保留段（SSRF 纵深防御，含 IPv4 与 IPv6）
    if (isBlockedIpLiteral(host)) return false;
    return true;
  } catch { return false; }
}

// v4.3.18 P0-3：把整数/十六进制/八进制形式的 IP 主机名归一为点分十进制。
// 仅当 host 全部由数字 / 0-9a-f / x / 点组成（即"是数字表示、不是域名"）时才归一；
// 任一非此类字符（字母、连字符、下划线等）→ 视为普通域名，返回 null 不做处理。
function normalizeIpLiteralHost(host) {
  if (!host) return null;
  // 已是标准 IPv4 点分十进制或含冒号的 IPv6，无需归一
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /:/.test(host)) return null;
  // 仅当整串只含 [0-9a-f x .] 且不含减号等域名专有字符时才认作数字形式
  if (/[^0-9a-fx.]/.test(host)) return null;

  let val;
  // 十六进制：0x 或 0X 前缀
  if (/^0x[0-9a-f]+$/i.test(host)) {
    val = parseInt(host, 16);
  } else if (/^0+[0-9]+$/.test(host)) {
    // 前导零：按八进制解读（如 017700000001 = 127.0.0.1 的回环区地址）
    val = parseInt(host.replace(/^0+/, ''), 8);
  } else if (/^[0-9]+$/.test(host)) {
    // 纯十进制整数（无前导零）：如 2130706433 = 127.0.0.1
    val = Number(host);
  } else {
    // 含 '.' 的复合/混合形式（如 127.1 之类简化写法）不在此统一处理，
    // 交给 isBlockedIpLiteral 按其既有分支判定；这里不贸然归一
    return null;
  }
  if (!Number.isSafeInteger(val) || val < 0 || val > 0xffffffff) return null;
  return `${(val >>> 24) & 0xff}.${(val >>> 16) & 0xff}.${(val >>> 8) & 0xff}.${val & 0xff}`;
}

// ============================================================
// 下载页敏感载荷中转（生死线：严禁下载内容/密钥泄露）
// 带防盗链签名 URL、Cookie 等敏感数据一律
// 不进入浏览器历史 / URL query，改存 chrome.storage.session
// （会话级、不与云端同步），下载页读取后立即清除。
// ============================================================
const DL_PAYLOAD_PREFIX = 'dldata_';
function dlPayloadKey(id) { return DL_PAYLOAD_PREFIX + id; }

// CSPRNG 随机串：载荷 ID 若只用 Date.now()（毫秒级可预测），同一毫秒内
// 可被枚举猜中进而读取他人生成但未及消费的敏感载荷。追加 crypto 随机段。
function randToken(len = 10) {
  let s = '';
  while (s.length < len) {
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    s += Array.from(buf).map(n => n.toString(36)).join('');
  }
  return s.slice(0, len);
}

async function storeDownloadPayload(id, payload) {
  // 安全审计修复：session 写入失败时不再回退 chrome.storage.local ——
  // local 持久化（且可随浏览器配置导出），带防盗链签名 URL 属敏感凭据，落盘违反「会话级、读取即清除」的隐私边界。
  // 失败直接返回 false，由调用方走用户可见的错误提示路径（不静默降级）。
  try {
    await chrome.storage.session.set({ [dlPayloadKey(id)]: payload });
    return true;
  } catch (e) {
    console.error('[VideoSniffer] 会话存储不可用，敏感载荷不再降级落盘 local');
    return false;
  }
}
async function clearDownloadPayload(id) {
  try { await chrome.storage.session.remove(dlPayloadKey(id)); } catch (_) {}
  await chrome.storage.local.remove(dlPayloadKey(id)).catch?.(() => {});
}

// ============================================================
// Service Worker 保活：下载页通过 port 长连接维持 SW 存活
// 下载页打开 → connect → SW 保持活跃；下载页关闭 → disconnect → SW 可正常休眠
// ============================================================
chrome.runtime.onConnect.addListener(safe((port) => {
  // 生死线加固：仅接受本扩展上下文的长连接（阻断外部扩展/进程借道保活）
  if (!port.sender || port.sender.id !== chrome.runtime.id) {
    try { port.disconnect(); } catch {}
    return;
  }
  if (port.name === 'keepalive') {
    // 空消息监听：让下载页周期发送的 keepalive-ping 计入 SW 活动计数，
    // 防止 30s 空闲休眠中断长下载（port 上没有任何监听器时，消息会被
    // 静默丢弃，起不到维持 SW 存活的作用）
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {
      // 下载页关闭：port 断开，SW 可进入正常休眠
    });
  }
}));

// ============================================================
// 隐私：定期清理过期下载历史（默认 24h）
// ============================================================
async function purgeExpiredHistory() {
  try {
    const data = await chrome.storage.local.get('settings');
    const settings = data.settings || {};
    if (settings.privacyMode === false) return; // 用户关闭了隐私模式
    const maxAge = (settings.historyTTL || 24) * 60 * 60 * 1000;
    const now = Date.now();
    const history = (await chrome.storage.local.get('history')).history || [];
    const fresh = history.filter(h => now - (h.timestamp || 0) < maxAge);
    if (fresh.length !== history.length) {
      await chrome.storage.local.set({ history: fresh });
    }
    // 修复：内存态进度缓存定期回收（1 小时未更新视为废弃）
    for (const store of [STATE.mseCaptures, STATE.recordProgress]) {
      if (!store) continue;
      for (const id of Object.keys(store)) {
        if (now - (store[id].timestamp || 0) > 3600000) delete store[id];
      }
    }
  } catch {}
}
// ============================================================
// 周期任务（chrome.alarms）：
//  1. privacy-purge  过期下载历史 / 内存进度缓存回收
//  2. opfs-cleanup   OPFS 'vs-downloads' 孤儿临时文件兜底清理
//  3. prune-caches   S-2：SW 全局内存封顶 + LRU 淘汰 + 用量日志（每 5 分钟）
// MV3 中 SW 可直接用 navigator.storage.getDirectory() 访问 OPFS。
// ============================================================
function registerPeriodicAlarms() {
  try {
    chrome.alarms.create('privacy-purge', { periodInMinutes: 30 });
    chrome.alarms.create('opfs-cleanup', { periodInMinutes: 30 });
    chrome.alarms.create('prune-caches', { periodInMinutes: 5 });
  } catch {}
}

// ============================================================
// v4.3.9 下载保活闹钟：下载期间周期性唤醒 SW，防 30s 空闲休眠
// 根因：下载页 keepalive ping 走 setInterval(20s)，Chrome 对后台标签页
// 的定时器做重度节流（1min+/冻结），用户切走下载页后 ping 停摆 → SW 30s
// 空闲后休眠 → 分段代理请求频繁冷启动 + 中断 → 速度下降（"停留在下载页
// 才快，切走就慢"的直接根因）。
// chrome.alarms 由浏览器统一调度、不受标签页前台/后台影响，官方推荐。
// 最小周期 30s（0.5 分钟），与 30s 空闲阈值对齐，刚好在 SW 即将休眠前唤醒。
// ============================================================
const KEEPALIVE_ALARM_NAME = 'download-keepalive';
const KEEPALIVE_PERIOD_MIN = 0.5;   // 30 秒（Chrome 官方最小闹钟周期）

function syncKeepaliveAlarm() {
  try {
    const active = Object.keys(STATE.activeDownloads).length > 0
      || Object.keys(STATE.activeRecordings || {}).length > 0;
    if (active) {
      // 有活跃任务：确保保活闹钟存在（create 同名幂等，重置周期）
      chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
        delayInMinutes: KEEPALIVE_PERIOD_MIN,
        periodInMinutes: KEEPALIVE_PERIOD_MIN,
      });
    } else {
      // 无活跃任务：清掉保活闹钟，让 SW 能正常休眠省电
      chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
  } catch {}
}

// S-2：全局缓存封顶 + 内存用量日志。由 prune-caches alarm 每 5 分钟触发，
// 也供 onSuspend 前调用。强制所有 SW STATE map 不超限，防 MV3 长会话内存累积。
function pruneAllCaches() {
  try {
    const now = Date.now();

    // DNS_CACHE：先清过期，再 LRU 封顶
    for (const [host, entry] of DNS_CACHE) {
      const ttl = entry.timeout ? DNS_TIMEOUT_TTL : DNS_CACHE_TTL;
      if (now - entry.ts > ttl) DNS_CACHE.delete(host);
    }
    if (DNS_CACHE.size > MAX_DNS_CACHE) {
      const excess = DNS_CACHE.size - MAX_DNS_CACHE;
      let removed = 0;
      for (const key of DNS_CACHE.keys()) {
        if (removed++ >= excess) break;
        DNS_CACHE.delete(key);
      }
    }

    // HEADER_RULE_CACHE：仅淘汰无引用条目（活跃规则绝不踢）
    if (HEADER_RULE_CACHE.size > MAX_HEADER_RULE_CACHE) {
      for (const [k, v] of HEADER_RULE_CACHE) {
        if (HEADER_RULE_CACHE.size <= MAX_HEADER_RULE_CACHE) break;
        if (v && v.refCount <= 0) {
          if (v.ruleId) {
            chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [v.ruleId] }).catch?.(() => {});
            freeRuleId(v.ruleId);
          }
          HEADER_RULE_CACHE.delete(k);
        }
      }
    }

    // HEADER_STORE（cookieCache）：LRU 封顶
    if (HEADER_STORE.size > MAX_COOKIE_CACHE) {
      const excess = HEADER_STORE.size - MAX_COOKIE_CACHE;
      const sorted = Array.from(HEADER_STORE.entries())
        .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
      for (let i = 0; i < excess && i < sorted.length; i++) {
        HEADER_STORE.delete(sorted[i][0]);
      }
    }

    // detectedVideos：per-tab 封顶（按 timestamp / firstSeen 淘汰最旧）
    for (const tabId of Object.keys(STATE.detectedVideos)) {
      const list = STATE.detectedVideos[tabId];
      if (Array.isArray(list) && list.length > MAX_DETECTED_VIDEOS) {
        list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        list.splice(0, list.length - MAX_DETECTED_VIDEOS);
      }
    }

    // O-8：清除过期 cookie 快照（storage.local）
    chrome.storage.local.get(null).then((data) => {
      for (const key of Object.keys(data)) {
        if (key.startsWith(COOKIE_SNAPSHOT_PREFIX)) {
          const snap = data[key];
          if (!snap || !snap.ts || now - snap.ts > COOKIE_SNAPSHOT_TTL_MS) {
            chrome.storage.local.remove(key).catch?.(() => {});
          }
        }
      }
    }).catch?.(() => {});

    // 内存用量日志（审计可见性）
    console.log('[VideoSniffer] pruneAllCaches 内存用量:', {
      dns: DNS_CACHE.size,
      headerRules: HEADER_RULE_CACHE.size,
      headerStore: HEADER_STORE.size,
      detectedVideosTabs: Object.keys(STATE.detectedVideos).length,
    });
  } catch {}
}

// OPFS 临时文件兜底回收：proxy-fetch-segment / proxy-fetch-full 写入的
// sw_seg_* / sw_proxy_* 文件由下载页读取后自行删除，但下载页崩溃/关闭时
// 会留下孤儿文件无限累积占满 OPFS 配额。按 lastModified 超过 10 分钟
// （正常读取即删，存活不应超过分钟级）判定为孤儿并删除。
const OPFS_TMP_PREFIXES = ['sw_seg_', 'sw_proxy_'];
const OPFS_TMP_TTL_MS = 10 * 60 * 1000;

async function cleanupOpfsTempFiles() {
  try {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    let dir;
    try {
      dir = await root.getDirectoryHandle('vs-downloads', { create: false });
    } catch { return; }   // 目录不存在 = 无残留
    const now = Date.now();
    for await (const [name, handle] of dir.entries()) {
      try {
        if (handle.kind !== 'file') continue;
        if (!OPFS_TMP_PREFIXES.some(p => name.startsWith(p))) continue;
        const file = await handle.getFile();
        if (now - file.lastModified > OPFS_TMP_TTL_MS) {
          await dir.removeEntry(name);
        }
      } catch {}
    }
  } catch {}
}

registerPeriodicAlarms();
chrome.runtime.onStartup.addListener(safe(() => {
  // 浏览器启动后重注册周期 alarm（alarm 随浏览器关闭失效）
  registerPeriodicAlarms();
  // v4.3.1 兜底：清理上次会话可能残留的 offscreen document
  // （SW 休眠/崩溃后 _offscreenCloseTimer 丢失，offscreen 可能未被关闭）
  if (typeof closeOffscreen === 'function') {
    closeOffscreen().catch?.(() => {});
  }
}));
chrome.alarms.onAlarm.addListener(safe((alarm) => {
  if (alarm.name === 'privacy-purge') {
    purgeExpiredHistory();
  } else if (alarm.name === 'opfs-cleanup') {
    cleanupOpfsTempFiles();
  } else if (alarm.name === 'prune-caches') {
    // S-2：全局缓存封顶 + 内存用量日志（每 5 分钟）
    pruneAllCaches();
  } else if (alarm.name === KEEPALIVE_ALARM_NAME) {
    // 保活心跳：闹钟事件本身已重置 SW 空闲计时器；顺手核对是否还有活跃
    // 任务，无则清理闹钟（下载页异常退出/崩溃未 unregister 时自愈）。
    syncKeepaliveAlarm();
  }
}));

// ============================================================
// 网络嗅探
// ============================================================

function getExt(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{1,5})$/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function isJunkUrl(url) {
  return JUNK_PATTERNS.some(p => p.test(url));
}

// ============================================================
// 请求头嗅探（P1 修复）：腾讯/爱奇艺等大站分片带防盗链签名，
// 缺失 Referer/Cookie 必被 403。此前只抓 URL/响应头，分片下载时
// Referer 只能退化为标签页 URL，Cookie 完全缺失。
// 参照 CocoCut 方案：webRequest.onSendHeaders + EXTRA_HEADERS 抓
// 全量请求头，按 requestId 关联到响应，供下载时经 DNR 注入。
// 隐私：仅内存态缓存（requestId 用后即删），Cookie 绝不落盘。
// ============================================================

const REQUEST_HEADER_CACHE = new Map();   // requestId -> { referer, origin, cookie, tabId }
const REQUEST_HEADER_CACHE_MAX = 2000;    // 防止无限增长

chrome.webRequest.onSendHeaders.addListener(safe((details) => {
  if (!details.requestId || !details.url) return;
  if (!/^https?:/i.test(details.url)) return;

  const headers = details.requestHeaders || [];
  let referer = null, origin = null, cookie = null;
  for (const h of headers) {
    const name = (h.name || '').toLowerCase();
    if (name === 'referer') referer = h.value || null;
    else if (name === 'origin') origin = h.value || null;
    else if (name === 'cookie') cookie = h.value || null;
  }
  // 只缓存携带了有意义请求头的请求（referer/origin/cookie 任一非空）
  if (!referer && !origin && !cookie) return;

  // 容量保护：超限时淘汰最旧一条
  if (REQUEST_HEADER_CACHE.size >= REQUEST_HEADER_CACHE_MAX) {
    const oldest = REQUEST_HEADER_CACHE.keys().next().value;
    if (oldest) REQUEST_HEADER_CACHE.delete(oldest);
  }
  REQUEST_HEADER_CACHE.set(details.requestId, { referer, origin, cookie, tabId: details.tabId });
}), { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

// 取回请求头并立即删除（requestId 只在单次请求内有效）
function takeRequestHeaders(requestId) {
  if (!requestId) return null;
  const h = REQUEST_HEADER_CACHE.get(requestId);
  REQUEST_HEADER_CACHE.delete(requestId);
  return h || null;
}

// 请求头存储：normalizeUrl(url) -> { referer, origin, cookie, updatedAt, stale? }
// 主要为内存态。O-8 修复：为避免 SW 重启导致下载必须从头开始，额外将 per-tab
// 快照持久化到 storage.local（key=cookie_snapshot_${tabId}，TTL 见 COOKIE_SNAPSHOT_TTL_MS）。
// 恢复时标记 stale，proxy-fetch 优先尝试快照，401/403 由引擎回退重嗅（现有行为）。
// 隐私边界：Cookie 等密级载荷不落盘（见 storeDownloadPayload）；
// Cookie 快照属较低密级（浏览器自身 cookie jar 亦持久化），TTL + 范围限定 +
// fullPrivacyCleanup 兜底清除，权衡可接受。
// H-1：容量上限 MAX_COOKIE_CACHE（由 lib/constants.js 导入），LRU 按 updatedAt 淘汰。
const HEADER_STORE = new Map();
const COOKIE_SNAPSHOT_PREFIX = 'cookie_snapshot_';
const COOKIE_SNAPSHOT_PER_TAB_MAX = 20;   // 单 tab 快照条目上限（防膨胀）
const COOKIE_SNAPSHOTS = new Map();       // tabId -> Map<normalizedUrl, {referer,origin,cookie,updatedAt,stale?}>

// O-8：将 per-tab cookie 快照异步落盘到 storage.local（fire-and-forget）
function persistCookieSnapshot(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const snap = COOKIE_SNAPSHOTS.get(tabId);
  const key = `${COOKIE_SNAPSHOT_PREFIX}${tabId}`;
  if (!snap || snap.size === 0) {
    chrome.storage.local.remove(key).catch?.(() => {});
    return;
  }
  const obj = { ts: Date.now(), entries: Array.from(snap.entries()) };
  chrome.storage.local.set({ [key]: obj }).catch?.(() => {});
}

function storeRequestHeaders(url, reqHdr) {
  if (!url || !reqHdr) return;
  if (!reqHdr.referer && !reqHdr.cookie) return;
  try {
    const key = normalizeUrl(url);
    // H-1：LRU 封顶（MAX_COOKIE_CACHE 替代原硬编码 300）
    if (HEADER_STORE.size >= MAX_COOKIE_CACHE && !HEADER_STORE.has(key)) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, v] of HEADER_STORE) {
        if (v.updatedAt < oldestT) { oldestT = v.updatedAt; oldestKey = k; }
      }
      if (oldestKey) HEADER_STORE.delete(oldestKey);
    }
    const entry = { referer: reqHdr.referer || null, origin: reqHdr.origin || null,
                    cookie: reqHdr.cookie || null, updatedAt: Date.now() };
    HEADER_STORE.set(key, entry);

    // O-8：同步 per-tab 快照并落盘（跨 SW 重启续传下载）
    const tabId = reqHdr.tabId;
    if (Number.isInteger(tabId) && tabId > 0) {
      let snap = COOKIE_SNAPSHOTS.get(tabId);
      if (!snap) { snap = new Map(); COOKIE_SNAPSHOTS.set(tabId, snap); }
      if (snap.size >= COOKIE_SNAPSHOT_PER_TAB_MAX && !snap.has(key)) {
        const oldest = snap.keys().next().value;
        if (oldest) snap.delete(oldest);
      }
      snap.set(key, { ...entry });
      persistCookieSnapshot(tabId);
    }
  } catch {}
}

// 下载时反查目标 URL 对应的请求头（含防盗链 Referer/Cookie）
// LRU：读命中时刷新 updatedAt（真正 LRU 语义，避免高频读条目被误淘汰）
function getStoredHeaders(url) {
  if (!url) return null;
  try {
    const key = normalizeUrl(url);
    const v = HEADER_STORE.get(key);
    if (!v) return null;
    v.updatedAt = Date.now();
    return v;
  } catch { return null; }
}

// 清除指定 tab 的 cookie 快照（标签页关闭 / 隐私清理时调用）
function clearCookieSnapshot(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  if (COOKIE_SNAPSHOTS.has(tabId)) COOKIE_SNAPSHOTS.delete(tabId);
  chrome.storage.local.remove(`${COOKIE_SNAPSHOT_PREFIX}${tabId}`).catch?.(() => {});
}

// ============================================================
// SW 代理下载时的防盗链头注入（P1 修复）
// SW 的 fetch 无法直接设置 Referer/Cookie/Origin（forbidden headers，
// 会被静默忽略），只能通过 DNR urlFilter 规则注入。
// 此函数为单次代理请求建立临时规则，fetch 完成后立即删除 ——
// Cookie 只在极短时间窗口内存在于 session 规则，用完即擦，符合隐私最小化。
//
// v4.2.7 关键修复：DNR updateSessionRules 是经 network service message bus
// 的异步调用，单次调用几百毫秒到几秒。旧版每次代理请求都 await 这一次调用，
// 8 个并发分片在 SW 单线程事件循环里全部阻塞在 DNR → "卡 0% 半天不动"。
// 修复：规则添加 fire-and-forget（让 fetch 立即发起，DNR 后台异步生效），
// 同一 host+referer+cookie 规则引用计数复用（避免每次 add+remove）。
// ============================================================
const HEADER_RULE_CACHE = new Map();   // key -> { ruleId, refCount, headers }
const HEADER_RULE_DELAY_MS = 5000;     // 引用归零后延迟 5s 删除（合并多次 add/remove）

// chrome.tabs.TAB_ID_NONE：非标签页发起的请求（SW 自身的 fetch 即属此类，
// 见 DNR 文档 tabIds 条目：TAB_ID_NONE 匹配不来自任何标签页的请求）
const TAB_ID_NONE = -1;

function applyProxyFetchHeaders(url, referer, tabId) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return () => {};
  let ruleId = null;
  let cacheKey = null;
  try {
    const stored = getStoredHeaders(url);
    const ref = stored?.referer || referer || null;
    const cookie = stored?.cookie || null;
    let origin = '';
    if (ref) { try { origin = new URL(ref).origin; } catch {} }

    const requestHeaders = [];
    if (ref) requestHeaders.push({ header: 'Referer', operation: 'set', value: ref });
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    if (cookie) requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookie });
    if (requestHeaders.length === 0) return () => {};

    const host = new URL(url).hostname;
    const tabKey = (Number.isInteger(tabId) && tabId > 0) ? String(tabId) : '';
    cacheKey = `${host}|${ref||''}|${cookie||''}|${tabKey}`;
    const existing = HEADER_RULE_CACHE.get(cacheKey);
    if (existing && Number.isFinite(existing.refCount)) {
      existing.refCount++;
      ruleId = existing.ruleId;
    } else {
      ruleId = allocRuleId();
      // 安全审计修复（规则 ID 池耗尽）：不再退回固定起始 ID（会覆盖并发
      // 下载的规则导致防盗链头互相踩踏）。无可用 ID 时降级为不注入头，
      // 直接返回空清理函数 —— SW fetch 仍会发起，调用方失败后走备用
      // URL/直连重试路径，仅本次请求缺少防盗链头。
      if (ruleId == null) return () => {};
      // 安全审计修复（tabIds 限定）：原 condition 仅 urlFilter+resourceTypes，
      // 规则会命中「任意标签页」发往该 host 的请求（其他标签页的正常浏览
      // 也会被注入 Cookie/Referer）。现限定为 [发起下载的标签页, TAB_ID_NONE]。
      // 必须包含 TAB_ID_NONE：本函数服务的 proxy-probe/proxy-fetch-* 请求全部
      // 由 SW 自身 fetch 发起（不属于任何标签页），仅写 tabIds:[tabId] 会让
      // 规则永不匹配、防盗链头注入整体失效 → 大站分片全量 403。扩展页无
      // initiator domain，initiatorDomains 不可用；拿不到 tabId 时退化为仅
      // TAB_ID_NONE（只覆盖 SW 自身请求，仍比无 tabIds 的全标签页窄）。
      const tabIds = tabKey ? [tabId, TAB_ID_NONE] : [TAB_ID_NONE];
      const addRule = (ids) => chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders },
          condition: {
            urlFilter: `||${host}`,
            resourceTypes: ['other', 'xmlhttprequest'],
            ...(ids ? { tabIds: ids } : {}),
          },
        }],
        removeRuleIds: [ruleId],
      });
      // v4.2.7：fire-and-forget 添加 DNR 规则（不再 await —— SW 端阻塞主元凶）
      // DNR 异步生效的窗口期通常 < 5ms，足够 fetch 申请头时赶上
      addRule(tabIds).catch(() => {
        // 兜底：个别 Chromium 版本若拒绝 tabIds 内含 TAB_ID_NONE 的规则，
        // 退回无 tabIds 的宽条件（仅 host 匹配）保证注入可用 —— 可用性
        // 优先于范围收窄
        addRule(null).catch(() => {
          if (ruleId) { freeRuleId(ruleId); ruleId = null; }
          if (cacheKey) HEADER_RULE_CACHE.delete(cacheKey);
        });
      });
      // H-1：规则缓存 LRU 封顶（belt-and-suspenders）。已有 refCount+5s 延迟清理，
      // 这里再兜一层：超 MAX_HEADER_RULE_CACHE 时淘汰最旧的「无引用」条目
      // （仅删 refCount<=0 的，绝不踢活跃规则导致防盗链头丢失）。
      if (HEADER_RULE_CACHE.size >= MAX_HEADER_RULE_CACHE && !HEADER_RULE_CACHE.has(cacheKey)) {
        for (const [k, v] of HEADER_RULE_CACHE) {
          if (v && v.refCount <= 0) {
            if (v.ruleId) {
              // v4.3.18 P0-4：确保规则删除完成后再放回 ID 池，避免并发 alloc
              // 复用该 ID 后旧 remove 误删新规则（fire-and-forget，不阻塞淘汰循环）
              removeForceRuleById(v.ruleId).then(() => freeRuleId(v.ruleId));
            }
            HEADER_RULE_CACHE.delete(k);
            break;
          }
        }
      }
      HEADER_RULE_CACHE.set(cacheKey, { ruleId, refCount: 1 });
    }
  } catch {
    if (ruleId) { freeRuleId(ruleId); ruleId = null; }
  }
  return () => {
    if (!ruleId || !cacheKey) return;
    const cached = HEADER_RULE_CACHE.get(cacheKey);
    if (!cached || cached.ruleId !== ruleId) return;
    cached.refCount--;
    // 引用计数归零后延迟删除（合并短时间内多次 add/remove）
    if (cached.refCount <= 0) {
      setTimeout(() => {
        if (cached.refCount <= 0) {
          // v4.3.18 P0-4：确保规则删除完成后再放回 ID 池，避免并发 alloc 复用
          // 该 ID 后旧 remove 误删新规则（fire-and-forget，不阻塞延迟清理）
          removeForceRuleById(ruleId).then(() => freeRuleId(ruleId));
          HEADER_RULE_CACHE.delete(cacheKey);
        }
      }, HEADER_RULE_DELAY_MS);
    }
  };
}

// 代理 fetch 超时：SW 的 fetch 无浏览器级超时，CDN 挂起（防爬虫黑洞、
// 连接建立后不响应）会让下载页干等满 30s 竞态超时才降级直连——这正是
// "准备界面半天不动"的主因。超时后 abort 并返回明确错误，页面快速走降级路径。
// bodyFn 覆盖 body 读取阶段（abort 会同时中断流式 body）
// O-3：超时值由 lib/constants.js 集中管理（原为散落硬编码 15000/15000/60000）
const PROXY_TIMEOUT_PROBE = PROBE_TIMEOUT;          // 探测/清单：小请求
const PROXY_TIMEOUT_KEY = KEY_FETCH_TIMEOUT;        // AES-128 密钥：16 字节
// v4.3.7 起 proxy-fetch-segment 改用 SEGMENT_STALL_TIMEOUT 停滞看门狗，
// 原 PROXY_TIMEOUT_SEGMENT（总超时）已无引用，死代码移除（2026-09-03 清理）。

async function fetchWithTimeout(url, opts, ms, bodyFn) {
  const ctrl = new AbortController();
  // v4.2.11：带 reason 中断。裸 abort() 的拒绝原因是 DOMException(AbortError)
  // "signal is aborted without reason"——各 handler 的 catch 虽有 AbortError→中文
  // 映射，但 body 读取阶段（resp.text()/arrayBuffer/reader.read）在部分 Chrome
  // 版本以 TypeError 形态抛出，映射失配时原生英文文案会经消息总线漏到下载页
  // 上屏。从源头带 reason，任何漏网路径也只会显示中文超时说明。
  const timer = setTimeout(() => ctrl.abort(
    new Error(t('sw_proxy_timeout', [Math.round(ms / 1000)]))), ms);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    return await bodyFn(resp);
  } finally {
    clearTimeout(timer);
  }
}

chrome.webRequest.onBeforeRequest.addListener(safe((details) => {
  if (details.tabId < 0 || !details.url) return;
  if (!/^https?:/i.test(details.url)) return;

  const url = details.url;
  const ext = getExt(url);

  // 关键修复：流媒体分片不算独立视频
  if (SEGMENT_EXTS.has(ext)) return;
  if (isJunkUrl(url)) return;

  // P1 修复：腾讯/爱奇艺清单 URL 常不带标准扩展名
  //（如腾讯 /dash?tvid=xxx），仅靠扩展名会漏识别。兜底按站点特征识别。
  const siteManifest = guessSiteManifest(url);

  if (MANIFEST_EXTS.has(ext) || siteManifest) {
    // 画质识别 + 加权：同名流的多画质变体全部入列，最高画质排最前
    const q = MANIFEST_EXTS.has(ext) ? guessStreamQuality(url) : null;
    addDetectedVideo(details.tabId, {
      url,
      type: 'stream',
      format: siteManifest ? 'mpd' : ext,
      method: 'network',
      quality: q?.label || null,
      score: 90 + (q?.boost || 0),
    });
    return;
  }

  if (DIRECT_EXTS.has(ext)) {
    addDetectedVideo(details.tabId, {
      url,
      type: 'direct',
      format: ext,
      method: 'network',
      score: 70, // 大小确认后在响应头里提升
    });
  }
}), { urls: ['<all_urls>'] });

// B站 DASH 清晰度代码（URL 末段 {cid}-1-{qualityId}.m4s）
// 300xx = 视频轨。关键修正：302xx 全部是音频码（旧代码把 30280 误标为
// "1080p" —— 它实际是 192kbps 音频轨，用户按清晰度标签误下音频轨的帮凶）
const BILI_QUALITY_MAP = {
  '30016': '360p', '30032': '480p', '30064': '720p', '30074': '720p60',
  '30080': '1080p', '300112': t('sw_quality_high_bitrate'), '300116': '1080p60',
  '300120': '4K', '300125': 'HDR', '300126': t('sw_quality_dolby'), '300127': '8K',
};

// B站音频轨码（文件名 {cid}-1-{302xx}.m4s）
const BILI_AUDIO_CODES = new Set(['30216', '30232', '30250', '30251', '30280', '30249']);

// 从 URL 末段提取 qualityId（{cid}-1-{qualityId}.m4s）
function getBiliQualityId(url) {
  try {
    const m = new URL(url).pathname.match(/-(\d{4,6})\.(?:m4s|mp4|flv)$/i);
    return m ? m[1] : null;
  } catch { return null; }
}

// 从 URL 提取 B站 cid —— 同一视频的音轨/视频轨共享 cid，
// 这是 DASH 双轨配对（合并下载）的唯一可靠键
function getBiliCid(url) {
  try {
    const m = new URL(url).pathname.match(/\/(\d+)-1-\d{4,6}\.(?:m4s|mp4|flv)$/i);
    return m ? m[1] : null;
  } catch { return null; }
}

function guessQualityFromUrl(url) {
  const qid = getBiliQualityId(url);
  if (!qid) return null;
  if (BILI_AUDIO_CODES.has(qid)) return null;          // 音频码不是清晰度
  return BILI_QUALITY_MAP[qid] || (qid.startsWith('300') ? t('sw_quality_generic', [qid]) : null);
}

// 从流媒体清单 URL 猜画质。视频站点/CDN 普遍把分辨率写进路径
//（如 /2024/1080P/index.m3u8、_720、1920x1080），无需抓包即可分辨变体。
// 返回 { label, boost }：boost 用于评分加权 —— 播放器自动选中的往往是
// 低画质变体（快启动），加权让最高画质清单排在列表最上面
function guessStreamQuality(url) {
  let s = '';
  try { s = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return null; }
  const boostOf = (h) => Math.max(1, Math.min(6, Math.round(h / 240)));
  if (/(?:^|[^0-9a-z])(?:2160|4k)(?:$|[^0-9a-z])/.test(s)) return { label: '4K', boost: 8 };
  if (/(?:^|[^0-9a-z])2k(?:$|[^0-9a-z])/.test(s)) return { label: '2K', boost: 6 };
  const m = s.match(/(?:^|[^0-9])(1080|720|576|540|480|406|405|402|360|270|240)p?(?:$|[^0-9])/);
  if (m) {
    const h = parseInt(m[1]);
    return { label: `${m[1]}P`, boost: boostOf(h) };
  }
  const r = s.match(/(\d{3,4})x(\d{3,4})/);   // 1920x1080 → 取短边即高度
  if (r) {
    const h = Math.min(parseInt(r[1]), parseInt(r[2]));
    if (h >= 2000) return { label: '4K', boost: 8 };
    if (h >= 1000) return { label: `${h}P`, boost: 6 };
    if (h >= 200) return { label: `${h}P`, boost: boostOf(h) };
  }
  return null;
}

// 腾讯系加密流：cmfv/cmfa 是自有加密容器，直链下载必然无法播放
function isProtectedStream(url, ext) {
  if (ext === 'cmfv' || ext === 'cmfa' || ext === 'cmf') return true;
  return /\/(?:cmfv|cmfa)\b/i.test(url);
}

// ============================================================
// 站点专属识别（P1 修复）：腾讯/爱奇艺等大站的清单与分片特征。
// 参照 CocoCut 的 Regex 规则 —— 这些平台的清单 URL 常不带标准扩展名，
// 或分片 URL 走私有命名，仅靠扩展名/ MIME 会漏识别。
// ============================================================

// 已知视频站点（用于分片/清单的兜底识别）
const KNOWN_VIDEO_SITES = [
  /\.v\.qq\.com$/i,           // 腾讯视频
  /\.video\.qq\.com$/i,       // 腾讯视频 CDN
  /\.iqiyi\.com$/i,           // 爱奇艺
  /\.m\.iqiyi\.com$/i,        // 爱奇艺移动端
  /\.mgtv\.com$/i,            // 芒果 TV
  /\.youku\.com$/i,           // 优酷
  /\.bilivideo\.com$/i,       // B站
  /\.hdslb\.com$/i,           // B站
];

// 腾讯视频 DASH 清单/分片：dash?tvid=... 或 getvinfo 等特征路径（CocoCut 同款）
const TENCENT_DASH_PATTERN = /\/dash\?.*tvid=|\/getvinfo\b|\/getinfo\b/i;

// 爱奇艺分片/清单特征路径
const IQIYI_PATTERN = /\/cmaf\/|\/dash\b|\/videos\/|\.m3u8\?/i;

function isKnownVideoSite(url) {
  try {
    const host = new URL(url).hostname;
    return KNOWN_VIDEO_SITES.some(re => re.test(host));
  } catch { return false; }
}

// 判断 URL 是否为腾讯/爱奇艺的清单或分片（兜底识别，扩展名可能缺失）
function guessSiteManifest(url) {
  if (!url) return null;
  if (TENCENT_DASH_PATTERN.test(url)) return 'tencent';
  if (IQIYI_PATTERN.test(url) && /iqiyi/i.test(url)) return 'iqiyi';
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(safe((details) => {
  if (details.tabId < 0 || !details.url) return;

  // P1 修复：关联 onSendHeaders 抓到的请求头（Referer/Cookie），
  // 供分片/清单下载时注入防盗链头。此调用用后即删，无泄漏。
  const reqHdr = takeRequestHeaders(details.requestId);
  if (reqHdr) storeRequestHeaders(details.url, reqHdr);

  const headers = details.responseHeaders || [];
  const ct = headers.find(h => h.name.toLowerCase() === 'content-type');
  if (!ct) return;

  const mime = (ct.value || '').toLowerCase();
  // 字体 MIME（font/woff2、application/font-woff 等）直接排除
  if (/font/i.test(mime)) return;
  const isVideoMime = mime.startsWith('video/') ||
    mime.includes('mpegurl') || mime.includes('dash+xml');
  // octet-stream 也可能是视频（B站等站点用此 MIME 发送视频）
  const isOctetStream = mime.includes('octet-stream');
  // 已知视频 CDN 域名（含腾讯 v.qq.com/video.qq.com、爱奇艺 iqiyi.com 等）
  const urlLower = details.url.toLowerCase();
  const isVideoCdn = /bilivideo|hdslb|bdstatic|pstatp|toutiao|ixigua|kakamissyou|gtimg|txvideo|v\.qq\.com|video\.qq\.com|iqiyi|qiyipic|mgtv|youku/i.test(urlLower);

  if (!isVideoMime && !(isOctetStream && isVideoCdn)) return;

  const ext = getExt(details.url);
  // 字体扩展名兜底过滤（MIME 伪装成 octet-stream/video 也不放行）
  if (FONT_EXTS.has(ext)) return;

  const cl = headers.find(h => h.name.toLowerCase() === 'content-length');
  const size = cl ? parseInt(cl.value) : null;

  // 真实大小回填：B站等站点的 200 响应是 chunked（无 Content-Length），
  // 列表只能显示"大小未知"，用户无法区分 300MB 视频轨和 12MB 音频轨
  //（误下音频轨是"12 分钟视频只有 12MB"的直接根因）。
  // 播放器 seek 时会发 Range 请求，其 206 响应的 Content-Range 自带
  // 完整 total —— 从这里回填，零额外请求、不受防盗链影响。
  let rangeTotal = null;
  if (!size) {
    const cr = headers.find(h => h.name.toLowerCase() === 'content-range');
    const m = cr?.value?.match(/bytes\s+\d+-\d+\/(\d+)/i);
    if (m) {
      rangeTotal = parseInt(m[1]);
      const list0 = STATE.detectedVideos[details.tabId];
      if (list0) {
        const ex0 = list0.find(v => v._norm === dedupKey(details.url));
        if (ex0 && !ex0.size) {
          ex0.size = rangeTotal;
          scheduleSave(details.tabId);
        }
      }
    }
  }

  // 关键修复：分片扩展名不再一刀切过滤 —— B站等 DASH 站点的 m4s 是
  // "单文件 Representation"（一个 m4s 即完整音/视频轨，自带 ftyp+moov，
  // 可独立播放），按直链下载比实时录制快百倍。仅放行视频 CDN 上的
  // 大体积分片（>1MB）；m4s 为单文件轨，无 Content-Length（chunked）时也放行。
  if (SEGMENT_EXTS.has(ext)) {
    const bigEnough = ext === 'm4s'
      ? (size === null || size > 1024 * 1024)
      : (size !== null && size > 1024 * 1024);
    if (isVideoCdn && bigEnough) {
      // B站 DASH 轨道识别（双保险）：新格式 URL 按 /audio/ 路径区分；
      // 老格式 upgcxcode URL 无该路径，按文件名音频码 302xx 判定 ——
      // 旧版只看路径，老格式音频轨被标成"视频轨+1080p"，用户必然下错
      let path = '';
      try { path = new URL(details.url).pathname.toLowerCase(); } catch {}
      const qid = getBiliQualityId(details.url);
      const isAudioTrack = path.includes('/audio/') ||
        (qid !== null && BILI_AUDIO_CODES.has(qid));
      const protectedStream = isProtectedStream(details.url, ext);
      
      // 关键修复 v2.3：B站 DASH 视频轨是纯视频（无音频），下载后无法播放。
      // 必须告知用户这是"视频轨·无声"，建议合并下载或改用 MSE 捕获。
      const isBiliDashVideo = !isAudioTrack && (ext === 'm4s' || /bilivideo|hdslb/i.test(details.url));
      
      addDetectedVideo(details.tabId, {
        url: details.url,
        type: 'direct',
        format: isAudioTrack ? 'm4a' : ext,
        mimeType: mime,
        size: rangeTotal,
        method: 'network',
        track: isAudioTrack ? 'audio' : 'video',
        quality: isAudioTrack ? null : guessQualityFromUrl(details.url),
        protected: protectedStream,
        // 关键修复：B站 DASH 视频轨标记为需要合并（无音频）
        needsMerge: isBiliDashVideo && !isAudioTrack,
        score: isAudioTrack ? 55 : 75,
      });
    }
    return;
  }

  // 分片型 MIME（video/mp2t 的单段、iso segment）忽略
  if (mime === 'video/iso.segment') return;

  // 大小过滤：小直链视频多为广告/贴片
  if (size !== null && size < MIN_DIRECT_SIZE &&
      !mime.includes('mpegurl') && !mime.includes('dash')) {
    return;
  }

  const format = guessFormat(details.url, mime);
  const isStream = mime.includes('mpegurl') || mime.includes('dash+xml') ||
                   MANIFEST_EXTS.has(ext);

  // 流媒体清单：画质识别 + 加权（与 onBeforeRequest 清单分支同一策略）
  const streamQ = isStream ? guessStreamQuality(details.url) : null;

  // 找到同 URL 条目就补充大小信息
  const list = STATE.detectedVideos[details.tabId];
  const norm = dedupKey(details.url);
  if (list) {
    const existing = list.find(v => v._norm === norm);
    if (existing) {
      if (size && !existing.size) existing.size = size;
      if (!existing.mimeType) existing.mimeType = mime;
      if (existing.score < 70 && size > 1024 * 1024) existing.score = 70 + Math.min(30, size / (50 * 1024 * 1024) * 30);
      scheduleSave(details.tabId);
      return;
    }
  }

  addDetectedVideo(details.tabId, {
    url: details.url,
    type: isStream ? 'stream' : 'direct',
    format,
    mimeType: mime,
    size,
    method: 'network',
    quality: streamQ?.label || null,
    // 关键修复 v2.3：按文件大小分级评分，避免小片段/预览获得高分
    // 12 分钟视频通常 >100MB，2.3MB 几乎必然是预览或片段
    score: isStream ? 90 + (streamQ?.boost || 0) :
           (size && size > 50 * 1024 * 1024) ? 95 :   // >50MB：几乎必然是完整视频
           (size && size > 10 * 1024 * 1024) ? 80 :   // 10-50MB：可能是完整视频（短视频）
           (size && size > 1024 * 1024) ? 55 :        // 1-10MB：可能是片段/预览
           40,                                         // <1MB：广告/缩略图
  });
}), { urls: ['<all_urls>'] }, ['responseHeaders']);

function guessFormat(url, mime) {
  const ext = getExt(url);
  if (ext) return ext;
  if (mime.includes('mpegurl')) return 'm3u8';
  if (mime.includes('dash')) return 'mpd';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('matroska')) return 'mkv';
  if (mime.includes('quicktime')) return 'mov';
  return 'mp4';
}

// 注意：不再对检测列表 URL 做参数剥离。
// 旧版 sanitizeUrl 会删除 sign/token/key/auth_key 等防盗链签名参数，
// 导致清单请求 HTTP 400（签名校验失败）。
// 隐私边界改由 Storage.maskUrl 承担：下载历史只存域名，不存完整 URL。

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const ext = getExt(url);
    if (MANIFEST_EXTS.has(ext)) {
      return u.origin + u.pathname;
    }
    return u.origin + u.pathname + u.search;
  } catch { return url; }
}

// 检测列表去重键（与 normalizeUrl 不同——后者仍用于 HEADER_STORE 缓存 key，
// 需按 manifest 去 query 保证防盗链 Cookie/Referer 缓存命中）。
// 根因修复：流媒体清单的清晰度/码率常写在查询串（?level=1080、?quality=720p、
// ?res=1920x1080 等）。normalizeUrl 对 m3u8/mpd 一刀切去 query，会把这些不同
// 清晰度错误合并成同一条——先到的 480p 条目占坑，后续 720p/1080p 因 _norm
// 相同被合并、URL 与 quality 字段都不更新 → "无论选哪个清晰度都只下到 480p"。
// 这里保留 query 中「值看起来像清晰度/分辨率」的参数，剥离签名/时间戳参数
//（sign/token/expires 等值不匹配清晰度模式，保留会让列表被同一视频的重复
// 签名条目刷屏）。
function dedupKey(url) {
  try {
    const u = new URL(url);
    const ext = getExt(url);
    if (!MANIFEST_EXTS.has(ext)) {
      return u.origin + u.pathname + u.search;
    }
    const RES = /(?:^|[^0-9])(?:2160|1440|1080|720|576|540|480|406|405|402|360|270|240)p?(?:[^0-9]|$)|(?:^|[^0-9])\d{3,4}x\d{3,4}(?:[^0-9]|$)/i;
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (RES.test(v)) kept.push(`${k}=${v}`);
    }
    return u.origin + u.pathname + (kept.length ? '?' + kept.join('&') : '');
  } catch { return url; }
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1];
    if (last) {
      const name = decodeURIComponent(last.split('?')[0]).slice(0, 60);
      // 如果是哈希乱码，用域名做占位名（后续会被 fillNameFromTab 替换为真实标题）
      if (/^[a-zA-Z0-9_-]{8,}$/.test(name.replace(/\.\w+$/, ''))) {
        return u.hostname;
      }
      return name;
    }
    return u.hostname;
  } catch {
    return t('sw_untitled');
  }
}

// 标题清理：仅去文件名非法字符，保留原始网页标题
function cleanTitle(raw) {
  if (!raw) return '';
  return raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120);
}

// 判断 URL 末段是否是哈希乱码（纯字母数字、无意义）
function isHashLikeName(name) {
  if (!name) return true;
  // 纯数字+字母，长度≥8，不含空格和中文
  return /^[a-zA-Z0-9_-]{8,}$/.test(name) && !/\s/.test(name);
}

// 异步从标签页获取标题并填充到 videoInfo
async function fillNameFromTab(tabId, videoInfo) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.title) {
      const cleaned = cleanTitle(tab.title);
      if (cleaned && cleaned !== t('sw_untitled')) {
        // DASH 双轨标注：B站等站点音/视频轨分离，视频轨无音是正常现象，
        // 标注出来防止用户误判为"文件损坏"
        if (videoInfo.track === 'video') {
          videoInfo.name = `${cleaned}${t('sw_track_video_silent')}`;
        } else if (videoInfo.track === 'audio') {
          videoInfo.name = `${cleaned}${t('sw_track_audio')}`;
        } else {
          videoInfo.name = cleaned;
        }
        scheduleSave(tabId);
      }
    }
  } catch {}
}

// ============================================================
// 检测注册表
// ============================================================

function addDetectedVideo(tabId, videoInfo) {
  if (!STATE.detectedVideos[tabId]) {
    STATE.detectedVideos[tabId] = [];
  }
  const list = STATE.detectedVideos[tabId];

  const norm = dedupKey(videoInfo.url);
  const existing = list.find(v => v._norm === norm);
  if (existing) {
    // 合并信息（保留更高分数与更全字段）
    if (videoInfo.size && !existing.size) existing.size = videoInfo.size;
    if (videoInfo.mimeType && !existing.mimeType) existing.mimeType = videoInfo.mimeType;
    if (videoInfo.duration && !existing.duration) existing.duration = videoInfo.duration;
    if (videoInfo.captureId && !existing.captureId) existing.captureId = videoInfo.captureId;
    if (videoInfo.track && !existing.track) existing.track = videoInfo.track;
    if (videoInfo.quality && !existing.quality) existing.quality = videoInfo.quality;
    if (videoInfo.protected && !existing.protected) existing.protected = true;
    if ((videoInfo.score || 0) > (existing.score || 0)) {
      existing.score = videoInfo.score;
    }
    // 如果已有名字是哈希乱码而新名字更好，替换
    if (videoInfo.name && isHashLikeName(existing.name) && !isHashLikeName(videoInfo.name)) {
      existing.name = videoInfo.name;
    }
    scheduleSave(tabId);
    return;
  }

  // 上限保护（UX 优先：保留高分条目）
  if (list.length >= MAX_VIDEOS_PER_TAB) {
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    list.length = MAX_VIDEOS_PER_TAB - 1;
  }
  // S-2：内存封顶兜底（MAX_VIDEOS_PER_TAB=50 已更严，此处 belt-and-suspenders，
  // 防极端情况如恢复态/竞态导致 list 异常膨胀）。超限按 timestamp 淘汰最旧
  if (list.length >= MAX_DETECTED_VIDEOS) {
    list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    list.splice(0, list.length - MAX_DETECTED_VIDEOS + 1);
  }

  videoInfo.id = `vid_${tabId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  videoInfo.tabId = tabId;
  videoInfo._norm = norm;
  videoInfo.timestamp = Date.now();

  // 网络检测的视频：name 是 URL 末段或域名占位符，用页面标题替换为可读名称
  // （修复：旧版仅当名字是"哈希乱码"才替换，域名占位符（含点号）永远不被替换，
  //  B站 m4s 条目一直显示 CDN 域名而非视频标题）
  if (!videoInfo.name) videoInfo.name = guessNameFromUrl(videoInfo.url);
  if (videoInfo.method === 'network' || isHashLikeName(videoInfo.name)) {
    fillNameFromTab(tabId, videoInfo);
  }

  list.push(videoInfo);
  scheduleSave(tabId);
}

// ============================================================
// B站音视频轨配对（合并下载的前提）
// 同 cid 的视频轨 + 音频轨 → 视频轨条目获得 audioUrl/audioSize，
// popup 据此显示「合并下载」按钮（两轨并行下载 + 本地无损合成有声 MP4）
// ============================================================
function pairBiliTracks(tabId) {
  const list = STATE.detectedVideos[tabId];
  if (!list || list.length === 0) return;

  // 每个 cid 选体积最大的音频轨（多码率并存时取最高音质）
  const audioByCid = new Map();
  for (const v of list) {
    if (v.track !== 'audio') continue;
    const cid = getBiliCid(v.url);
    if (!cid) continue;
    const prev = audioByCid.get(cid);
    if (!prev || (v.size || 0) > (prev.size || 0)) audioByCid.set(cid, v);
  }
  if (audioByCid.size === 0) return;

  let changed = false;
  for (const v of list) {
    if (v.track !== 'video') continue;
    const cid = getBiliCid(v.url);
    if (!cid) continue;
    const audio = audioByCid.get(cid);
    if (audio && v.audioUrl !== audio.url) {
      v.audioUrl = audio.url;
      v.audioSize = audio.size || 0;
      v.mergeable = true;
      changed = true;
    }
  }
  if (changed) {
    // 音频轨就位后视频轨分数提升到流媒体之上（列表首选合并下载）
    for (const v of list) {
      if (v.mergeable && (v.score || 0) < 96) v.score = 96;
    }
  }
  return changed;
}

// 防抖保存：500ms 内的多次检测合并为一次 storage 写入（消除写入风暴）
function scheduleSave(tabId) {
  if (STATE.saveTimers[tabId]) return;
  STATE.saveTimers[tabId] = setTimeout(() => {
    delete STATE.saveTimers[tabId];
    try {
      const list = STATE.detectedVideos[tabId] || [];
      // 保存前完成 B站双轨配对（音/视频轨到达顺序不定，每次都重算）
      pairBiliTracks(tabId);
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
      // 关键修复：检测列表必须保存完整 URL（含防盗链签名参数）。
      // 旧版 sanitizeUrl 剥离 sign/token/key 等参数，导致清单请求 HTTP 400。
      // 隐私边界改由「下载历史只存域名」（Storage.maskUrl）承担，检测列表是会话工作数据。
      const saved = list.map(v => ({
        ...v,
        _norm: undefined,
      }));
      chrome.storage.local.set({ [`videos_${tabId}`]: saved }).catch?.(() => {});
      updateBadge(tabId);
    } catch {}
  }, 500);
}

function updateBadge(tabId) {
  try {
    const list = STATE.detectedVideos[tabId] || [];
    // 只统计有价值的视频（分数 >= 40），分片垃圾已被过滤
    const count = list.filter(v => (v.score || 0) >= 40).length;

    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#FF3B30', tabId });
      chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count), tabId });
      chrome.action.setTitle({ title: t('sw_action_title_count', [count]), tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
      chrome.action.setTitle({ title: t('sw_action_title'), tabId });
    }
  } catch {}
}

// ============================================================
// 消息中枢
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 生死线加固：仅接受本扩展上下文发送的消息（内容脚本/弹窗/下载页均带
  // 本扩展 sender.id），阻断任意页面/外部进程驱动后台代理、伪造嗅探/DNR。
  // 安全审计修复：sender.id 缺失时也一律拒绝（旧版 `sender.id &&` 的写法
  // 在 id 缺失时放行，校验形同虚设）。
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, error: 'unauthorized' });
    return false;
  }
  const handler = MessageHandlers[message?.type];
  if (!handler) return false;
  // v4.3.18 P1-7 安全审计修复：handler 若同步抛错，会在 Promise.resolve 求值
  // 参数时提前冒泡，.catch 来不及挂上 → sendResponse 永不调用 → 发起端挂起、
  // SW 生命周期被拖长。此处用 try/catch 把同步异常并入统一错误路径。
  let p;
  try {
    p = Promise.resolve(handler(message, sender));
  } catch (err) {
    // 脱敏：错误消息中的 URL 替换为 [URL]
    const msg = String(err?.message || err).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    sendResponse({ success: false, error: msg });
    return false; // sendResponse 已同步调用
  }
  p.then(result => sendResponse({ success: true, data: result }))
    .catch(err => {
      // 脱敏：错误消息中的 URL 替换为 [URL]
      const msg = String(err?.message || err).replace(/https?:\/\/[^\s'"]+/g, '[URL]');
      sendResponse({ success: false, error: msg });
    });
  return true;
});

const MessageHandlers = {
  // ============================================================
  // B站 API 数据接收（借鉴 bilibili下载助手 方案）
  // content-script 调用 /x/player/playurl 获取标准MP4直链（durl）
  // 直链下载即可播放，无需fMP4合并
  // ============================================================
  'bilibili-api-data': (msg, sender) => {
    const tabId = sender.tab?.id;
    if (!tabId || !msg.data?.bestVideo) return;

    const d = msg.data;
    const bestVideo = d.bestVideo;
    const bestAudio = d.bestAudio;

    // B站清晰度映射
    const qualityMap = {
      127: '8K', 126: t('sw_quality_dolby'), 125: 'HDR', 120: '4K',
      116: '1080P60', 112: t('sw_quality_high_bitrate'), 80: '1080P',
      74: '720P60', 64: '720P', 32: '480P', 16: '360P',
    };
    const quality = qualityMap[bestVideo.id] || `${bestVideo.id}p`;

    // 创建"合并下载"条目 —— 包含音视频完整地址
    // score=99 确保排在所有其他条目之前
    addDetectedVideo(tabId, {
      url: bestVideo.url,
      name: d.title || msg.pageTitle || t('sw_bili_video'),
      type: 'bilibili-merged',
      format: 'mp4',
      duration: d.duration || null,
      quality,
      method: 'api',
      score: 99,
      // 关键：存储完整的音视频地址，供下载页使用
      biliData: {
        videoUrl: bestVideo.url,
        videoBackupUrl: bestVideo.backupUrl || '',
        audioUrl: bestAudio?.url || '',
        audioBackupUrl: bestAudio?.backupUrl || '',
        videoCodecs: bestVideo.codecs || '',
        audioCodecs: bestAudio?.codecs || '',
        videoWidth: bestVideo.width || 0,
        videoHeight: bestVideo.height || 0,
        videoBandwidth: bestVideo.bandwidth || 0,
        audioBandwidth: bestAudio?.bandwidth || 0,
        bvid: d.bvid || '',
        aid: d.aid || 0,
        cid: d.cid || 0,
        title: d.title || '',
        duration: d.duration || 0,
        // 所有可用清晰度
        allVideoStreams: (d.videoStreams || []).slice(0, 6),
        allAudioStreams: (d.audioStreams || []).slice(0, 3),
        // 标准MP4直链（API获取，无需合并）
        directUrl: d.directUrl || '',
        directSize: d.directSize || 0,
      },
    });
  },

  // 内容脚本上报 DOM 检测结果
  'video-found': (msg, sender) => {
    const tabId = sender.tab?.id;
    if (!tabId || !msg.videos?.length) return;
    const ALLOWED_TYPES = new Set(['direct', 'stream', 'hls', 'dash', 'mse', 'blob', 'mse-capture']);
    for (const v of msg.videos) {
      if (!v?.url || typeof v.url !== 'string') continue;
      // 字段验证：限制字符串长度、类型枚举、数值范围
      const type = ALLOWED_TYPES.has(v.type) ? v.type : 'direct';
      const name = typeof v.name === 'string' ? v.name.slice(0, 200) : undefined;
      const format = typeof v.format === 'string' ? v.format.slice(0, 20) : 'video';
      const size = typeof v.size === 'number' && v.size > 0 ? v.size : null;
      const duration = typeof v.duration === 'number' && v.duration > 0 && v.duration < 86400 ? v.duration : null;
      const captureId = typeof v.captureId === 'string' ? v.captureId.slice(0, 50) : null;
      const mimeType = typeof v.mimeType === 'string' ? v.mimeType.slice(0, 100) : null;
      // v4.1.1 修复：track 字段（video/audio）必须透传，否则 popup 的
      // 「合并下载」按钮（仅对视频轨显示）永远不出现 → 腾讯/爱奇艺无法合并下载
      const track = (v.track === 'audio' || v.track === 'video') ? v.track : null;
      addDetectedVideo(tabId, {
        url: v.url,
        name,
        type,
        format,
        size,
        duration,
        mimeType,
        captureId,
        ...(track ? { track } : {}),
        // 帧绑定信息：MSE 导出必须路由回捕获所在的 frame（嵌套 iframe 场景
        // 广播到所有 frame 会让顶层页误报「未找到 MSE 捕获数据」）
        ...(typeof sender.frameId === 'number' ? { frameId: sender.frameId } : {}),
        ...(typeof sender.url === 'string' && /^https?:/i.test(sender.url)
          ? { frameUrl: sender.url.slice(0, 500) } : {}),
        // 帧来源 Referer 兜底（MSE 捕获条目 url 是 mse:// 占位符，无网络头可查）
        ...(typeof v.referer === 'string' && /^https?:/i.test(v.referer)
          ? { referer: v.referer.slice(0, 500) } : {}),
        method: 'dom',
        score: typeof v.score === 'number' ? v.score :
               (type === 'stream' ? 88 :
                type === 'mse' || type === 'blob' ? 60 :  // 关键修复 v2.3：MSE 分数 30→60（真实视频通过 MSE 传输）
                type === 'mse-capture' ? 90 : 60),
      });
    }
  },

  'get-videos': async (msg) => {
    const tabId = msg.tabId || await getActiveTabId();
    // 关键修复：MV3 SW 会被浏览器随时终止（30s 空闲即回收），内存态
    // detectedVideos 随之丢失 —— 弹窗打开时机稍晚就"什么都检测不到"。
    // 内存为空时从 storage 恢复（含 B站双轨配对结果 audioUrl/mergeable）
    if (!STATE.detectedVideos[tabId] || STATE.detectedVideos[tabId].length === 0) {
      try {
        const saved = (await chrome.storage.local.get(`videos_${tabId}`))[`videos_${tabId}`];
        if (Array.isArray(saved) && saved.length > 0) {
          // 重建 _norm 去重键（与 restoreState 同因）
          STATE.detectedVideos[tabId] = saved.map(v => ({
            ...v, _norm: dedupKey(v.url),
          }));
          updateBadge(tabId);
        }
      } catch {}
    }
    return STATE.detectedVideos[tabId] || [];
  },

  'start-download': async (msg, sender) => {
    if (!msg.video?.url || !isSafeUrl(msg.video.url)) {
      throw new Error(t('sw_badurl'));
    }
    if (!msg.video.name) msg.video.name = guessNameFromUrl(msg.video.url);
    return startDownload(msg.video, 'normal', msg.referer, msg.tabId ?? sender.tab?.id);
  },

  'start-force-download': async (msg, sender) => {
    if (!msg.video?.url || !isSafeUrl(msg.video.url)) {
      throw new Error(t('sw_badurl'));
    }
    if (!msg.video.name) msg.video.name = guessNameFromUrl(msg.video.url);
    return startDownload(msg.video, 'force', msg.referer, msg.tabId ?? sender.tab?.id);
  },

  // ============================================================
  // B站下载：通过API获取标准MP4直链，直接下载（无需合并）
  // 借鉴 bilibili下载助手 方案：/x/player/playurl 返回 durl 完整MP4
  // ============================================================
  'start-bili-merge-download': async (msg, sender) => {
    const video = msg.video || {};
    const biliData = video.biliData || {};
    if (!biliData.videoUrl || !isSafeUrl(biliData.videoUrl)) {
      throw new Error(t('sw_badurl_bili'));
    }
    if (!video.name) video.name = biliData.title || guessNameFromUrl(biliData.videoUrl);

    const downloadId = `bili_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    STATE.activeDownloads[downloadId] = {
      id: downloadId,
      video,
      mode: 'bili-merge',
      status: 'pending',
      createdAt: Date.now(),
      tabId: null,
    };

    // 带防盗链签名/直链 URL 走会话存储，不入浏览器历史
    const stored = await storeDownloadPayload(downloadId, {
      videoUrl: biliData.videoUrl,
      audioUrl: biliData.audioUrl || '',
      videoBackupUrl: biliData.videoBackupUrl || '',
      audioBackupUrl: biliData.audioBackupUrl || '',
      directUrl: biliData.directUrl || '',
      referer: msg.referer || '',
    });
    if (!stored) {
      delete STATE.activeDownloads[downloadId];
      throw new Error(t('sw_session_unavailable_params'));
    }
    const pageUrl = chrome.runtime.getURL('download-page/download.html') +
      `?id=${downloadId}&mode=bili-merge` +
      `&name=${encodeURIComponent(video.name)}` +
      `&quality=${encodeURIComponent(video.quality || '')}` +
      `&duration=${biliData.duration || 0}` +
      `&directSize=${biliData.directSize || 0}`;

    const tab = await createTabAdjacent(pageUrl, msg.tabId ?? sender.tab?.id);
    if (STATE.activeDownloads[downloadId]) {
      STATE.activeDownloads[downloadId].tabId = tab.id;
    }
    return { downloadId, opened: true };
  },

  'register-download': async (msg) => {
    // 幂等注册：同一 downloadId 重复注册只更新状态，不重复计数
    const id = msg.downloadId || `dl_${Date.now().toString(36)}`;
    if (!STATE.activeDownloads[id]) {
      STATE.activeDownloads[id] = { id, status: 'active', createdAt: Date.now() };
    } else {
      STATE.activeDownloads[id].status = 'active';
    }
    if (msg.url && !STATE.activeDownloads[id].url) {
      STATE.activeDownloads[id].url = msg.url;
    }
    // v4.2.7：保存用户设定线程数，广播时传递给各下载页作为上限
    if (msg.userThreadCount) {
      STATE.activeDownloads[id].userThreadCount = msg.userThreadCount;
    }
    // v4.2.7：保存 maxThreads（直链 16 / 流媒体 24），用于 SW 端硬上限
    if (msg.maxThreads) {
      STATE.activeDownloads[id].maxThreads = msg.maxThreads;
    }
    // 清理已失效的僵尸条目（SW 存活期间残留的崩溃下载）
    pruneStaleDownloads();
    // v4.2.7：新任务加入时按 downloadId 广播精确配额（不再粗暴砍所有老任务）。
    // 旧版广播单一 threadCount（floor(32/n)）→ 老任务的 userThreadCount 上限被无视、
    // 多任务时速度瞬间断崖（"自由滑动没用 + 同站不同任务速度差"）。
    // 新版按比例缩分，老任务从 16 → 12 → 10 平滑下降而非被砍到 6。
    broadcastReallocation();
    // v4.3.9：有任务加入 → 拉起保活闹钟（下载期间防 SW 30s 空闲休眠）
    syncKeepaliveAlarm();
    const count = Object.keys(STATE.activeDownloads).length;
    const maxThreads = Math.max(1, msg.maxThreads || 16);
    // v4.2.7 关键修复：返回的 threadCount 必须反映用户设定 + 全局预算约束。
    // 旧版 allocateThreads(count, maxThreads) 完全忽略 userThreadCount → 用户
    // 拖到 12 线程、5 任务时被砍到 6，"自由滑动线程没用"的根因。
    return {
      downloadId: id,
      concurrentCount: count,
      threadCount: allocateThreads(count, maxThreads, msg.userThreadCount || 0),
    };
  },

  'unregister-download': async (msg) => {
    // 关键修复：必须用 downloadId 精确删除（旧版不传 id 导致永远删不掉、连接数只增不减）
    if (msg.downloadId && STATE.activeDownloads[msg.downloadId]) {
      delete STATE.activeDownloads[msg.downloadId];
    }
    pruneStaleDownloads();
    const count = Object.keys(STATE.activeDownloads).length;
    // 任务结束：通知剩余下载页回收释放出的配额（动态扩展线程）
    broadcastReallocation();
    // v4.3.9：任务退出 → 若无其他活跃任务则清掉保活闹钟
    syncKeepaliveAlarm();
    return { concurrentCount: count, threadCount: allocateThreads(count) };
  },

  // v4.2.7 诊断：SW 存活探测 + 活跃下载状态（下载页卡 0% 时定位用）
  'diag-ping': async () => ({
    ok: true,
    ts: Date.now(),
    activeDownloads: Object.keys(STATE.activeDownloads).length,
    activeRecordings: Object.keys(STATE.activeRecordings || {}).length,
  }),

  'get-connection-allocation': async () => {
    pruneStaleDownloads();
    const count = Object.keys(STATE.activeDownloads).length;
    return { concurrentCount: count, threadCount: allocateThreads(count) };
  },

  // S-1：线程重分配竞态修复 —— 握手协议。
  // 引擎收到旧 quota_epoch 的 conn-realloc 时发此消息请求重同步。
  // SW 立即重算当前配额并单播回请求 tab（带最新 epoch，不等下次分配事件）。
  'conn-realloc-resync': async (msg, sender) => {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: false };
    pruneStaleDownloads();
    const { count, allocations } = computeAllocations();
    // 单调递增 epoch，与广播同口径（引擎据此更新 last-applied）
    quotaEpoch++;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'conn-realloc',
        quota_epoch: quotaEpoch,
        concurrentCount: count,
        allocations,
        threadCount: allocateThreads(count),
        resync: true,
      });
    } catch {}
    return { ok: true, epoch: quotaEpoch };
  },

  'start-record': async (msg) => {
    return startRecording(msg.video, msg.tabId, msg.recordSpeed);
  },

  'copy-url': async (msg) => {
    if (!msg.url || !isSafeUrl(msg.url)) {
      throw new Error(t('sw_badurl_copy'));
    }
    await navigator.clipboard.writeText(msg.url);
    return { copied: true };
  },

  'play-video': async (msg, sender) => {
    const video = msg.video || {};
    // Blob/MSE 视频无法在独立播放页打开
    if (!video.url || video.url.startsWith('blob:') || video.url.startsWith('mse://')) {
      throw new Error(t('sw_preview_unsupported'));
    }
    if (!isSafeUrl(video.url)) {
      throw new Error(t('sw_badurl_play'));
    }
    const name = video.name || guessNameFromUrl(video.url);
    // 安全审计修复：载荷 ID 追加 CSPRNG 随机段（Date.now() 可预测可枚举）
    const pid = `play_${Date.now().toString(36)}_${randToken(8)}`;
    const stored = await storeDownloadPayload(pid, { url: video.url });
    if (!stored) {
      throw new Error(t('sw_session_unavailable_play'));
    }
    const url = chrome.runtime.getURL('download-page/download.html') +
      `?mode=player&pid=${pid}&name=${encodeURIComponent(name)}`;
    await createTabAdjacent(url, msg.tabId ?? sender.tab?.id);
    return { opened: true };
  },

  'clear-videos': async (msg) => {
    const tabId = msg.tabId;
    delete STATE.detectedVideos[tabId];
    if (STATE.saveTimers[tabId]) {
      clearTimeout(STATE.saveTimers[tabId]);
      delete STATE.saveTimers[tabId];
    }
    await chrome.storage.local.remove(`videos_${tabId}`);
    updateBadge(tabId);
    return { cleared: true };
  },

  // 真正的「重新嗅探本页」：先清空该页记录，再让内容脚本从零扫一遍。
  // 旧版只转发 manual-scan，重报的同一批 URL 在 addDetectedVideo 被去重，
  // 列表纹丝不动 —— 用户看到的就是"点了没反应"。
  // 只清视频列表、不动 cookie 快照（下载防盗链头仍可复用）。
  'rescan-page': async (msg, sender) => {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false };
    await MessageHandlers['clear-videos']({ tabId });
    await chrome.tabs.sendMessage(tabId, { type: 'manual-scan' }).catch?.(() => {});
    return { ok: true };
  },

  'get-download-status': async (msg) => {
    return STATE.activeDownloads[msg.downloadId] || null;
  },

  'download-page-closed': async (msg) => {
    cleanupDownloadCache(msg.downloadId);
    // 隐私保证：彻底擦除下载元数据
    if (STATE.activeDownloads[msg.downloadId]) {
      const dl = STATE.activeDownloads[msg.downloadId];
      if (dl.video) { dl.video.url = null; dl.video.name = null; }
      delete STATE.activeDownloads[msg.downloadId];
    }
    return { cleaned: true };
  },

  // ============================================================
  // 下载放行规则：DNR 会话规则
  // 1. 请求头注入 Referer/Origin（fetch 规范禁止直接设置这两个头）
  // 2. 响应头 CORS 覆盖（关键修复）：B站/腾讯/爱奇艺等大站 CDN 不返回
  //    Access-Control-Allow-Origin，从扩展下载页（chrome-extension://）发起的
  //    fetch 会被浏览器 CORS 直接拦截 —— 这是"大站只能录制"的根因。
  //    覆盖 ACAO 为扩展自身 origin + ACAC:true，与请求的 credentials:'include'
  //    组合合法（credentialed 请求禁止 ACAO:*，必须精确回显 origin）。
  //    Range 属于 CORS-safelisted 请求头，不触发预检，GET+Range 只需放行响应头。
  // ============================================================
  'apply-force-rule': async (msg, sender) => {
    if (!chrome.declarativeNetRequest?.updateSessionRules) {
      return { applied: false };
    }
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      return { applied: false, error: dnsBlockReason(msg.url) || t('sw_badurl_generic') };
    }

    // 为本次下载分配唯一规则 ID；池耗尽时返回 applied:false 让调用方
    // 降级（下载页走 SW 代理路径，不带 DNR 规则直连重试）
    const ruleId = allocRuleId();
    if (ruleId == null) {
      return { applied: false, error: t('sw_rule_pool_exhausted') };
    }

    // 请求头注入：与 applyProxyFetchHeaders 同口径 —— 优先用 webRequest 嗅探抓到的
    // Referer/Cookie（更精确），其次用调用方传入的 referer 兜底。顺序不能反：
    // 站内 iframe 场景，调用方 referer 可能是所在页 URL，而流的真实防盗链
    // Referer 是播放器页 —— 反了会被 CDN 403。
    // 关键修复 v4.2.6：Cookie 保护的大站 CDN（B站 upos 等）直连缺 Cookie 必被
    // 403 打回 → 每段都降级到慢速消息总线代理路径（"强力下载也没用"的主因）。
    // 此处与代理同口径注入嗅探到的 Cookie，让直连一次命中，不再回退代理。
    const stored = getStoredHeaders(msg.url);
    const ref = (stored?.referer && isSafeUrl(stored.referer)) ? stored.referer
              : (msg.referer && isSafeUrl(msg.referer)) ? msg.referer : null;
    const cookie = stored?.cookie || null;
    let origin = '';
    if (ref) { try { origin = new URL(ref).origin; } catch {} }

    const requestHeaders = [];
    if (ref) requestHeaders.push({ header: 'Referer', operation: 'set', value: ref });
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    if (cookie) requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookie });

    // 扩展自身 origin：credentialed CORS 放行必须精确回显
    let extOrigin = '';
    try { extOrigin = new URL(chrome.runtime.getURL('/')).origin; } catch {}

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders,
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: extOrigin },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Content-Type, Accept' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          // 暴露 Content-Range/Length/Accept-Ranges：分段引擎依赖这些头判断 Range 支持
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges' },
        ],
      },
      condition: {
        // 关键修复：不用 urlFilter 匹配 host —— 流媒体清单与分片常在不同域
        //（B站清单在 bilivideo、分片在 upos-* 镜像），按 host 匹配会漏放行。
        // 改为精确限定下载页标签页的请求，影响面最小且覆盖所有分片域。
        // resourceTypes 含 media：预览播放模式的 <video> 元素请求类型为 media，
        // 需注入 Referer/Origin 才不会被防盗链 403 拒绝导致无限转圈。
        //（CORS 放行对 media 无害但对 XHR 必需；两者共扫互不影响）
        resourceTypes: ['xmlhttprequest', 'media'],
        ...(sender.tab?.id ? { tabIds: [sender.tab.id] } : {}),
      },
    };

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [rule],
        removeRuleIds: [ruleId],
      });
      return { applied: true, ruleId };
    } catch {
      freeRuleId(ruleId);
      return { applied: false };
    }
  },

  'remove-force-rule': async (msg) => {
    // 仅移除指定 ruleId 的规则，不影响其他并发下载
    // v4.3.18 P0-4 安全审计修复：先异步移除规则、成功后再放回 ID 池。
    // 旧实现先同步 freeRuleId 再 await removeForceRuleById —— 两种调用之间
    // 存在 await 边界，并发下载可能在 free 后 allocRuleId 拿到同一 ID 并
    // 建立自己的新规则，随后旧 remove 执行，误删新下载的规则 → 突然 403
    // 降级到慢速代理（TOCTOU 竞态）。
    if (msg.ruleId) {
      await removeForceRuleById(msg.ruleId);
      freeRuleId(msg.ruleId);
    }
    return { removed: true };
  },

  'privacy-cleanup': async () => {
    await fullPrivacyCleanup();
    return { cleaned: true };
  },

  // AES-128 密钥获取代理（绕过 CORS，纯本地中转，不存储密钥）
  'fetch-key': async (msg) => {
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      throw new Error(dnsBlockReason(msg.url) || t('sw_badurl_key'));
    }
    try {
      // 注：SW 的 fetch 禁止设置 Referer/Origin（forbidden headers，静默忽略），
      // 旧代码注入这两个头是无效的死代码，已移除。
      // credentials 用 omit：不把用户站点 Cookie 发给任意密钥 URL（隐私最小化），
      // 也避免 ACAO:* + include 组合在未授权路径下被 CORS 拒绝。
      const buf = await fetchWithTimeout(msg.url, {
        mode: 'cors',
        redirect: 'follow',
        credentials: 'omit',
      }, PROXY_TIMEOUT_KEY, async (resp) => {
        if (!resp.ok) throw new Error(t('sw_key_http', [resp.status]));
        return resp.arrayBuffer();
      });
      if (buf.byteLength !== 16) throw new Error(t('sw_key_bad_length', [buf.byteLength]));
      // 返回 base64（不持久化，仅内存中转）
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { keyData: btoa(binary) };
    } catch (e) {
      return { error: e?.name === 'AbortError' ? t('sw_key_timeout') : e.message };
    }
  },

  // 录制进度路由：content script → 所有打开的下载页
  'record-progress': async (msg) => {
    STATE.recordProgress = STATE.recordProgress || {};
    STATE.recordProgress[msg.recordId] = {
      elapsed: msg.elapsed,
      dataSize: msg.dataSize,
      dataRate: msg.dataRate,
      timestamp: Date.now(),
    };
    // 转发给下载页（如果打开）
    broadcastToDownloadPages({ type: 'record-progress', ...msg });
    return { ok: true };
  },

  // 录制完成路由
  'record-complete': async (msg) => {
    if (STATE.recordProgress) delete STATE.recordProgress[msg.recordId];
    broadcastToDownloadPages({ type: 'record-complete', ...msg });
    // 通知弹窗刷新
    return { ok: true };
  },

  // 录制黑帧警告路由：加密内容 drawImage 输出全黑画面（VBR 下仅几十 kbps，
  // 这正是"录制只有 100 多 KB/s 且画面全黑"的确定信号），转发给录制下载页
  'record-blackframe': async (msg, sender) => {
    broadcastToDownloadPages({ type: 'record-blackframe', tabId: sender?.tab?.id });
    return { ok: true };
  },

  // 关键修复 v2.3：录制 CORS 错误路由 —— canvas 被跨域视频污染，
  // drawImage 抛出 SecurityError，导致录制只有黑帧/无帧。
  // 转发给录制下载页警告用户
  'record-cors-error': async (msg, sender) => {
    broadcastToDownloadPages({ type: 'record-cors-error', tabId: sender?.tab?.id });
    return { ok: true };
  },

  // 查询录制状态
  'get-record-status': async (msg) => {
    const p = STATE.recordProgress?.[msg.recordId];
    return p || { idle: true };
  },

  // ============================================================
  // 下载代理：SW 的 fetch 拥有 <all_urls> 主机权限，完全不受 CORS 约束。
  // 下载页（chrome-extension://）发起带 Range 头的 fetch 会触发 OPTIONS 预检，
  // 大站 CDN 对 OPTIONS 返回 403/405 或无 CORS 头 → 预检失败 → 下载被浏览器拦截。
  // DNR modifyHeaders 只能改响应头、不能改状态码，无法修复 403/405 的预检。
  // 解决方案：将实际 HTTP 请求下沉到 SW 执行，彻底绕过 CORS。
  // ============================================================

  // 代理探测：Range 支持 + 文件大小 + 首块内容校验
  'proxy-probe': async (msg, sender) => {
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      return { error: dnsBlockReason(msg.url) || t('sw_badurl_generic') };
    }
    const cleanup = await applyProxyFetchHeaders(msg.url, msg.referer, sender?.tab?.id);
    try {
      // SW fetch：无 CORS 约束，无需 mode:'cors'，不触发预检
      return await fetchWithTimeout(msg.url, {
        method: 'GET',
        headers: { Range: 'bytes=0-15' },
        redirect: 'follow',
      }, PROXY_TIMEOUT_PROBE, async (resp) => {
        if (resp.status === 206 || resp.headers.get('content-range')) {
          const buf = new Uint8Array(await resp.arrayBuffer().catch(() => new ArrayBuffer(0)));
          return {
            status: resp.status,
            totalSize: parseInt(resp.headers.get('content-range')?.match(/\/(\d+)/)?.[1] || '0') || null,
            supportsRange: true,
            contentLength: parseInt(resp.headers.get('content-length') || '0') || null,
            firstBytes: Array.from(buf),
          };
        }

        if (resp.ok && resp.body) {
          const reader = resp.body.getReader();
          const { value } = await reader.read();
          try { await reader.cancel(); } catch {}
          return {
            status: resp.status,
            totalSize: parseInt(resp.headers.get('content-length') || '0') || null,
            supportsRange: false,
            firstBytes: value ? Array.from(new Uint8Array(value)) : [],
            // 服务器忽略 Range 返回 200：body 已消费，后续需重新 fetch
          };
        }
        return { error: `HTTP ${resp.status}` };
      });
    } catch (e) {
      return { error: e?.name === 'AbortError' ? t('sw_probe_timeout') : e.message };
    } finally {
      cleanup();
    }
  },

  // 代理分段抓取：SW 流式写入 OPFS 临时文件，返回文件名给下载页读取。
  // v4.2.6 根治：不再经 chrome.runtime.sendMessage 传 1–16MB 大 ArrayBuffer
  // （structured clone 序列化慢、消息总线易超限，是"强力下载也没用"的主因）。
  // SW 与下载页共享 OPFS 存储空间，通过文件名"手递手"零拷贝交付分段数据。
  'proxy-fetch-segment': async (msg, sender) => {
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      return { error: dnsBlockReason(msg.url) || t('sw_badurl_generic') };
    }
    // v4.3.4-3（与 proxy-fetch-text 同策略）：先「裸请求」——不注入
    // Referer/Cookie。部分机器/Chrome 版本上 DNR 注入头可能让网络服务拒绝
    // 整条请求（curl 通、页面通、唯独 SW fetch 败的潜在根因）；仅当响应为
    // 401/403/407（真防盗链挡路）才建立注入头规则、补带头重试一次。
    let cleanup = () => {};
    let cleanupApplied = false;
    const headers = {};
    if (msg.rangeStart !== undefined && msg.rangeEnd !== undefined) {
      headers.Range = `bytes=${msg.rangeStart}-${msg.rangeEnd}`;
    }

    let opfsFile = null;
    let writer = null;
    const tryCleanup = () => {
      try { writer?.abort?.(); } catch {}
      if (opfsFile) {
        navigator.storage.getDirectory().then(async (root) => {
          try {
            const dir = await root.getDirectoryHandle('vs-downloads', { create: false });
            await dir.removeEntry(opfsFile);
          } catch {}
        }).catch(() => {});
      }
    };

    try {
      const ctrl = new AbortController();
      // v4.3.7：停滞看门狗替代总超时。慢速链路（几十~几百 KB/s）下 32MB
      // 分片可能耗时远超 65s，总超时会在数据仍在流动时误杀 → 下载页转直连/
      // 重试 → 速度在 MB/s 与几十 B/s 间剧烈抖动（正是"特定网站下载不稳"的
      // 根因）。改为与 proxy-fetch-full 同款的停滞看门狗：仅当连续
      // SEGMENT_STALL_TIMEOUT 无新数据才 abort，数据在流动就绝不打断。
      const stallReason = new Error(t('sw_seg_stalled'));
      let watchdog = setTimeout(() => ctrl.abort(stallReason), SEGMENT_STALL_TIMEOUT);
      const feedWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ctrl.abort(stallReason), SEGMENT_STALL_TIMEOUT);
      };
      try {
        let resp = await fetch(msg.url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: ctrl.signal,
        });

        // 防盗链状态码：建注入头规则补带头重试一次（防死循环：仅一次）
        if ((resp.status === 401 || resp.status === 403 || resp.status === 407) && !cleanupApplied) {
          cleanupApplied = true;
          try { await resp.body?.cancel(); } catch {}
          cleanup = await applyProxyFetchHeaders(msg.url, msg.referer, sender?.tab?.id);
          resp = await fetch(msg.url, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: ctrl.signal,
          });
        }

        if (resp.status !== 200 && resp.status !== 206) {
          try { await resp.body?.cancel(); } catch {}
          return { error: `HTTP ${resp.status}` };
        }

        // 流式写入 OPFS 临时文件（边下边写，内存占用恒定）
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('vs-downloads', { create: true });
        opfsFile = `sw_seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fh = await dir.getFileHandle(opfsFile, { create: true });
        writer = await fh.createWritable({ keepExistingData: false });

        const reader = resp.body.getReader();
        let written = 0;
        let lastProg = 0;
        // v4.2.9 聚合写：reader 默认 chunk 仅 16-64KB，逐块 await writer.write()
        // 的 OPFS 事务开销是代理路径吞吐瓶颈（实测明显慢于直连）。聚合到
        // ≥1MB 再一次写入，OPFS 写调用次数下降 16-64 倍，代理速度贴近直连。
        let pendingChunks = [];
        let pendingBytes = 0;
        const FLUSH_BYTES = 1024 * 1024;
        const flushPending = async () => {
          if (!pendingBytes) return;
          let buf;
          if (pendingChunks.length === 1) {
            buf = pendingChunks[0];
          } else {
            buf = new Uint8Array(pendingBytes);
            let off = 0;
            for (const c of pendingChunks) { buf.set(c, off); off += c.byteLength; }
          }
          await writer.write(buf);
          pendingChunks = [];
          pendingBytes = 0;
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          feedWatchdog();   // 有数据流入即续期看门狗（停滞 30s 才会真正 abort）
          pendingChunks.push(value);
          pendingBytes += value.byteLength;
          written += value.byteLength;
          // P2 进度推送：SW 抓取+落盘期间（32MB 分段可长达 25-60s）下载页
          // 此前零进度事件 → 进度条长时间冻结、速度掉 0（"卡 0%"观感元凶）。
          // 每 512KB 推一条小消息，由下载页 DownloadEngine 计入在途分段字节。
          if (msg.segReqId && written - lastProg >= 512 * 1024) {
            lastProg = written;
            try {
              chrome.runtime.sendMessage({ type: 'seg-progress', segReqId: msg.segReqId, written }).catch?.(() => {});
            } catch {}
          }
          if (pendingBytes >= FLUSH_BYTES) await flushPending();
        }
        await flushPending();
        await writer.close();
        writer = null;

        const crHeader = resp.headers.get('content-range');
        let actualStart = null;
        let total = null;
        if (crHeader) {
          const m = crHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
          if (m) {
            actualStart = parseInt(m[1]);
            total = parseInt(m[3]);
          }
        }
        return {
          status: resp.status,
          opfsFile,   // 下载页读取后自行删除临时文件
          byteLength: written,
          actualStart,
          totalSize: total,
        };
      } finally {
        clearTimeout(watchdog);
      }
    } catch (e) {
      tryCleanup();
      opfsFile = null;
      return { error: e?.name === 'AbortError' ? t('sw_seg_stalled_short') : e.message };
    } finally {
      cleanup();
    }
  },

  // 代理单流下载：SW 抓取文件并写入 OPFS，下载页从 OPFS 读取
  // 关键：不通过消息传递大 ArrayBuffer（structured clone 会损坏 50MB+ 数据）
  // 通过 DNR 注入 Referer/Origin/Cookie，解决大站 CDN 防盗链拒绝问题
  'proxy-fetch-full': async (msg, sender) => {
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      return { error: dnsBlockReason(msg.url) || t('sw_badurl_generic') };
    }

    // 统一防盗链头注入（Referer/Origin/Cookie，含嗅探抓到的 Cookie）
    const cleanup = await applyProxyFetchHeaders(msg.url, msg.referer, sender?.tab?.id);

    // 停滞看门狗（而非总超时）：单流可能持续数分钟，只要数据在流动就不打断；
    // 连续 30s 无新数据（CDN 半途挂起）→ abort，让下载页快速走备用 URL/直连
    const ctrl = new AbortController();
    // v4.2.11：带 reason 中断（防原生 abort 文案经消息总线漏到下载页）
    const stallReason = new Error(t('sw_dl_stalled'));
    let watchdog = setTimeout(() => ctrl.abort(stallReason), 30000);
    const feedWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ctrl.abort(stallReason), 30000);
    };

    try {
      const resp = await fetch(msg.url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        // v4.3.18 P1-6 安全审计修复：早退分支必须清看门狗，否则残留 30s
        // 计时器并可能延长 SW 存活（每个 return 分支都须清理）
        clearTimeout(watchdog);
        cleanup();
        return { error: `HTTP ${resp.status}` };
      }

      const ct = resp.headers.get('content-type') || 'unknown';
      const cl = resp.headers.get('content-length') || 'unknown';
      // 隐私：日志只记域名，不落完整 URL（含防盗链签名参数）
      let logHost = '';
      try { logHost = new URL(msg.url).hostname; } catch {}
      console.log(`[VideoSniffer] SW fetch 响应: status=${resp.status}, content-type=${ct}, content-length=${cl}, host=${logHost}`);

      // 流式写入 OPFS（边读边写，避免 50MB+ 全放内存）
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('vs-downloads', { create: true });
      const safeName = `sw_proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const fh = await dir.getFileHandle(safeName, { create: true });
      const writer = await fh.createWritable();

      const reader = resp.body.getReader();
      let totalWritten = 0;
      let lastLog = 0;
      // v4.2.9 聚合写（同 proxy-fetch-segment）：16-64KB 小 chunk 聚合到
      // ≥1MB 再写 OPFS，消除逐块写的事务开销瓶颈。
      let pendingChunks = [];
      let pendingBytes = 0;
      const FLUSH_BYTES = 1024 * 1024;
      const flushPending = async () => {
        if (!pendingBytes) return;
        let buf;
        if (pendingChunks.length === 1) {
          buf = pendingChunks[0];
        } else {
          buf = new Uint8Array(pendingBytes);
          let off = 0;
          for (const c of pendingChunks) { buf.set(c, off); off += c.byteLength; }
        }
        await writer.write(buf);
        pendingChunks = [];
        pendingBytes = 0;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          feedWatchdog();
          pendingChunks.push(value);
          pendingBytes += value.byteLength;
          totalWritten += value.length;
          // 每 5MB 打印一次进度
          if (totalWritten - lastLog > 5 * 1024 * 1024) {
            console.log(`[VideoSniffer] 下载进度: ${Math.round(totalWritten / 1024 / 1024)}MB / ${cl !== 'unknown' ? Math.round(parseInt(cl) / 1024 / 1024) + 'MB' : 'unknown'}`);
            lastLog = totalWritten;
          }
          if (pendingBytes >= FLUSH_BYTES) await flushPending();
        }
        await flushPending();
      } finally {
        clearTimeout(watchdog);
        await writer.close();
        // 关键：body 完全读取后才清理 DNR 规则
        cleanup();
      }

      console.log(`[VideoSniffer] OPFS 写入完成: ${safeName}, ${totalWritten} bytes`);

      return {
        success: true,
        opfsFileName: safeName,
        totalSize: totalWritten,
      };
    } catch (e) {
      clearTimeout(watchdog);
      // 确保异常时也清理 DNR 规则
      cleanup();
      return { error: e?.name === 'AbortError' ? t('sw_dl_stalled_short') : e.message };
    }
  },

  // 代理清单文本抓取（HLS/DASH m3u8/mpd）
  'proxy-fetch-text': async (msg, sender) => {
    if (!msg.url || !(await ensureSafeRemote(msg.url))) {
      return { error: dnsBlockReason(msg.url) || t('sw_badurl_generic') };
    }
    // v4.3.4-3 关键改动：清单属公开资源，先「裸请求」——不注入 Referer/
    // Cookie。理由：
    //  1. 本机 curl 不带任何头已实测可达（服务器响应 Access-Control-Allow-
    //     Origin: *，无防盗链挡路）
    //  2. DNR modifyHeaders 注入头在某些机器/Chrome 版本上可能让网络服务
    //     拒绝整条请求（异常头/超大 Cookie 都会导致连 fetch 都发不出去），
    //     这正是「curl 通、浏览器页面通、唯独 SW fetch 败」的潜在根因
    //  3. 仅当响应为 401/403/407（真防盗链挡路）才建立注入头规则、补带头
    //     重试一次。这样行为等价于"不依赖注入头的可用路径"（即老版本体验）
    const bareFetch = () => fetchWithTimeout(msg.url, {
      method: 'GET',
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    }, PROXY_TIMEOUT_PROBE, async (resp) => {
      if (!resp.ok) {
        return { error: `HTTP ${resp.status}` };
      }
      return { text: await resp.text() };
    });
    let cleanup = () => {};
    let cleanupApplied = false;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let r;
        try {
          r = await bareFetch();
        } catch (e) {
          const em = String(e?.message || '');
          if (e?.name === 'AbortError' || /超时|aborted|已被中断/i.test(em)) {
            return { error: t('sw_manifest_timeout') };
          }
          // console 保留技术细节（含 cause 与所在 attempt），页面文案不含完整 URL
          let host = '';
          try { host = new URL(msg.url).hostname; } catch {}
          console.error('[VideoSniffer] proxy-fetch-text 网络层失败，原因=', {
            name: e?.name,
            message: e?.message,
            cause: e?.cause?.message || (e?.cause ? String(e.cause) : null),
          }, 'host=', host, 'attempt=', attempt);
          if (attempt < 2) {
            await new Promise((ww) => setTimeout(ww, 300 * (attempt + 1)));
          }
          continue;
        }
        // 防盗链状态码：建注入头规则补带头重试一次（防死循环：仅一次）
        if (/^HTTP (401|403|407)$/.test(r?.error || '') && !cleanupApplied) {
          cleanupApplied = true;
          cleanup = await applyProxyFetchHeaders(msg.url, msg.referer, sender?.tab?.id);
          continue;
        }
        return r;
      }
      // 3 次全败：先清掉注入头规则，再跑 no-cors 探针——探针必须与注入头
      // 隔离，否则异常头会让探针同样失败、误判成「网络层失败」。
      cleanup();
      cleanup = () => {};
      let diag = '';
      try {
        const probe = await fetch(msg.url, {
          method: 'GET',
          mode: 'no-cors',
          redirect: 'follow',
          signal: AbortSignal.timeout(3000),
        });
        diag = (probe?.type === 'opaque')
          ? t('sw_diag_intercepted')
          : t('sw_diag_network_fail');
      } catch { diag = t('sw_diag_network_fail'); }
      let host = '';
      try { host = new URL(msg.url).hostname; } catch {}
      return { error: t('sw_manifest_connect_failed', [host || t('sw_target_site'), diag]) };
    } finally {
      cleanup();
    }
  },

  // 停止录制：转发到源标签页的 content script
  'stop-record': async (msg) => {
    const rec = STATE.activeRecordings?.[msg.recordId];
    if (rec) {
      await chrome.tabs.sendMessage(rec.tabId, {
        type: 'stop-record',
      }).catch?.(() => {});
      delete STATE.activeRecordings[msg.recordId];
    }
    return { stopped: true };
  },

  // MSE 捕获下载：路由到源标签页
  // 带 frameId 时只发给捕获所在的 frame（iframe 播放器场景：广播会让
  // 顶层页误报「未找到 MSE 捕获数据」，即使 iframe 内数据完好）
  'mse-download': async (msg) => {
    const tabId = msg.tabId || STATE.lastActiveTab;
    if (!tabId) return { error: t('sw_no_active_tab') };
    const frameId = typeof msg.frameId === 'number' ? msg.frameId
      : (typeof msg.video?.frameId === 'number' ? msg.video.frameId : undefined);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'mse-download',
        captureId: msg.captureId,
        ...(frameId !== undefined ? { targetFrame: frameId } : {}),
      }, frameId !== undefined ? { frameId } : {});
      return { success: true };
    } catch (e) {
      // frame 已销毁（页面刷新/iframe 被移除）→ 捕获数据随之丢失
      return { error: /frame|Receiving end/.test(String(e.message))
        ? t('sw_capture_stale')
        : e.message };
    }
  },

  // v4.1 新增：MSE 音视频轨合并下载（路由到源标签页）
  'mse-merge-download': async (msg) => {
    const tabId = msg.tabId || STATE.lastActiveTab;
    if (!tabId) return { error: t('sw_no_active_tab') };
    const frameId = typeof msg.frameId === 'number' ? msg.frameId
      : (typeof msg.video?.frameId === 'number' ? msg.video.frameId : undefined);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'mse-merge-download',
        captureId: msg.captureId,
        ...(frameId !== undefined ? { targetFrame: frameId } : {}),
      }, frameId !== undefined ? { frameId } : {});
      return { success: true };
    } catch (e) {
      return { error: /frame|Receiving end/.test(String(e.message))
        ? t('sw_capture_stale')
        : e.message };
    }
  },

  // （安全审计）'mse-save-file' handler 已删除：全仓无任何发送方（content
  // script 的 MSE/录制产物均直接在页面侧经 chrome.downloads/a[download]
  // 落盘），属死代码且包含 content-script 可控的 URL/文件名直通
  // chrome.downloads.download 的攻击面。

  // MSE 进度上报（从 content script 转发）
  'mse-progress': async (msg) => {
    STATE.mseCaptures = STATE.mseCaptures || {};
    STATE.mseCaptures[msg.captureId] = {
      totalSize: msg.totalSize,
      segmentCount: msg.segmentCount,
      timestamp: Date.now(),
    };
    return { ok: true };
  },

  // MSE 捕获完成
  'mse-complete': async (msg) => {
    STATE.mseCaptures = STATE.mseCaptures || {};
    if (STATE.mseCaptures[msg.captureId]) {
      STATE.mseCaptures[msg.captureId].complete = true;
      // 修复：完成即回收。此前条目永不清理，SW 长会话内存持续增长
      delete STATE.mseCaptures[msg.captureId];
    }
    // 通知弹窗
    try {
      const tabs = await chrome.tabs.query({ active: true });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'mse-capture-complete',
          captureId: msg.captureId,
          totalSize: msg.totalSize,
        }).catch?.(() => {});
      }
    } catch {}
    return { ok: true };
  },
};

// 向所有打开的下载页广播消息
async function broadcastToDownloadPages(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('download-page/download.html') });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg).catch?.(() => {});
    }
  } catch {}
}

// DNR 规则 ID 池：每个强力下载分配唯一 ID，避免并发时互相覆盖
// O-3：池范围由 lib/constants.js 导入（FORCE_RULE_ID_POOL_START/END/SIZE）
const usedRuleIds = new Set();

function allocRuleId() {
  for (let id = FORCE_RULE_ID_POOL_START; id < FORCE_RULE_ID_POOL_END; id++) {
    if (!usedRuleIds.has(id)) {
      usedRuleIds.add(id);
      return id;
    }
  }
  // 安全审计修复：池耗尽返回 null（旧版兜底返回固定起始 ID 9500，
  // 会静默覆盖并发下载已占用的规则，防盗链/CORS 放行互相踩踏）。
  // 调用方须处理 null 并降级（无规则直连重试 / 拒绝本次放行）。
  // H-1：池耗尽时打 warning 日志（池容量 FORCE_RULE_ID_POOL_SIZE=100，
  // 正常并发下载不会触达；触达通常意味着规则未正确释放，需排查 freeRuleId 遗漏）
  console.warn(`[VideoSniffer] DNR 规则 ID 池耗尽（容量 ${FORCE_RULE_ID_POOL_SIZE}），本次降级为无规则直连`);
  return null;
}

function freeRuleId(id) {
  usedRuleIds.delete(id);
}

// 仅移除指定 ID 的规则（不再一刀切清除所有规则）
async function removeForceRuleById(ruleId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch {}
}

// 清除所有规则（仅用于隐私清理、扩展卸载等场景）
async function removeAllForceRules() {
  try {
    const ids = Array.from(usedRuleIds);
    usedRuleIds.clear();
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ids,
      });
    }
  } catch {}
}

// ============================================================
// 连接数分配（aria2 全局预算模型）
// ============================================================

// v4.2.7：全局连接预算从 64 降到 32。
// 64 的预算在代理优先模式下导致 SW 事件循环处理过多并发
// proxy-fetch-segment 请求（每请求含 fetch + OPFS 流写），
// SW 单线程 I/O 竞争 → 多任务卡顿。32 仍足够 HTTP/2 多路复用。
// O-3：GLOBAL_CONN_BUDGET / MIN_CONN_PER_TASK 由 lib/constants.js 导入

// 计算当前活跃下载数，并按全局预算公平分配线程数
// v4.2.7 关键修复：userThreadCount 作为硬上限传入（用户在设置面板拖动的值）。
// 旧版完全忽略 userThreadCount → "自由滑动线程没用"的根因：
//   用户拖到 12 线程、5 个并发任务 → SW 给的是 min(16, 6)=6，
//   不管用户怎么拖都被强压到 6。
// userThreadCount 也作为下限兜底：尊重用户设的低值（如 1-2 线程）。
function allocateThreads(count, maxThreads = 16, userThreadCount = 0) {
  const n = Math.max(1, count);
  // 用户的「我最多要这么多」是硬上限：下载引擎侧已在 adjustThreads 里 clamp，
  // 这里也保持一致语义，避免 SW 与引擎对同一规则的认知分裂
  const effectiveMax = userThreadCount > 0
    ? Math.min(maxThreads, userThreadCount)
    : maxThreads;
  // 用户设的低值（如 1-3）不能被 MIN_CONN_PER_TASK 强行拉高：
  // 用户既然拖低了，说明对这个下载有特定偏好（如减少 OPFS 压力），尊重
  const floor = userThreadCount > 0 && userThreadCount < MIN_CONN_PER_TASK
    ? userThreadCount
    : MIN_CONN_PER_TASK;
  // 全局预算按任务数均分（仍受上面硬上限钳制）
  const fairShare = Math.floor(GLOBAL_CONN_BUDGET / n);
  return Math.max(floor, Math.min(effectiveMax, fairShare));
}

// 关键修复：任务数变化时向所有活跃下载页按 downloadId 精确广播配额。
// 旧版 threadCount 在注册时一次性固化，任务结束后配额无法回收给
// 其他运行中的任务 —— 这是"多任务速度断崖式下降"的根因之一。
//
// v4.2.7：进一步按下载ID分发，每个任务拿到「自己应得」的份额，
// 不再被全局平均数绑架。新任务加入时，老任务不会瞬间被砍到几线程
// （20+MB/s → 几百kB/s 的现场），而是按用户设定和总预算各自分配。
//
// S-1 修复：每次广播附带单调递增的 quota_epoch。下载引擎侧记录
// last-applied epoch；若收到旧 epoch 的 conn-realloc（乱序/重放），
// 引擎向 SW 发 conn-realloc-resync 请求重同步。SW 侧由 computeAllocations()
// 统一计算配额，广播与 resync 单播共用同一逻辑（避免两套口径分裂）。
let quotaEpoch = 0;

// 计算当前所有活跃任务的配额分配（广播与 resync 共用）
function computeAllocations() {
  const ids = Object.keys(STATE.activeDownloads);
  const count = ids.length;
  if (count === 0) return { count: 0, allocations: {} };

  const totalUserWanted = ids.reduce((sum, id) => {
    return sum + (STATE.activeDownloads[id]?.userThreadCount || 0);
  }, 0);

  const allocations = {};
  for (const id of ids) {
    const dl = STATE.activeDownloads[id];
    if (!dl) continue;
    const userTC = dl.userThreadCount || 0;
    const maxT = dl.maxThreads || 16;

    let quota = (totalUserWanted > 0 && totalUserWanted > GLOBAL_CONN_BUDGET)
      ? Math.floor(userTC * GLOBAL_CONN_BUDGET / totalUserWanted)
      : (userTC || maxT);

    const effectiveMax = userTC > 0 ? Math.min(maxT, userTC) : maxT;
    const minFloor = userTC > 0 && userTC < MIN_CONN_PER_TASK
      ? userTC
      : MIN_CONN_PER_TASK;
    quota = Math.max(minFloor, Math.min(effectiveMax, quota));

    allocations[id] = quota;
  }
  return { count, allocations };
}

function broadcastReallocation() {
  const { count, allocations } = computeAllocations();
  if (count === 0) return;

  // S-1：单调递增 epoch，引擎据此丢弃乱序/重放的旧配额
  quotaEpoch++;
  broadcastToDownloadPages({
    type: 'conn-realloc',
    quota_epoch: quotaEpoch,
    concurrentCount: count,
    // 按 downloadId 精确分配（新协议）：下载页按自身 ID 取配额
    allocations,
    // 兼容兜底：单个 threadCount（仅当下载页未实现按 ID 取配额时使用）
    threadCount: allocateThreads(count),
  });
}

// 清理僵尸条目：SW 存活期间因崩溃/异常退出残留的下载记录
// 只有「从未激活过」且「超过 10 分钟」的 pending 条目才清理，
// 避免误删正在准备或刚注册的下载。
function pruneStaleDownloads() {
  const now = Date.now();
  for (const [id, dl] of Object.entries(STATE.activeDownloads)) {
    if (dl.status === 'pending' && now - (dl.createdAt || 0) > 10 * 60 * 1000) {
      delete STATE.activeDownloads[id];
    }
  }
}

// ============================================================
// 下载编排
// ============================================================

// v4.3.14：打开下载页时紧跟"触发下载的原标签页"右侧（而非标签栏末尾）。
// 传入 sourceTabId（原视频页 tabId），取其 index+1 作为新标签位置；
// 原标签页已关闭/无法定位时退回默认（末尾）。
async function createTabAdjacent(url, sourceTabId) {
  const opts = { url };
  if (sourceTabId != null) {
    try {
      const src = await chrome.tabs.get(sourceTabId);
      if (typeof src.index === 'number') opts.index = src.index + 1;
    } catch {}
  }
  return chrome.tabs.create(opts);
}

async function startDownload(video, mode, referer, sourceTabId) {
  const downloadId = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  STATE.activeDownloads[downloadId] = {
    id: downloadId,
    video,
    mode,
    status: 'pending',
    createdAt: Date.now(),
    tabId: null, // 下载页标签页 ID（tab.create 回调后填充）
  };

  // 敏感数据（视频 URL 可能含防盗链签名 / referer）不入浏览器历史，走会话存储
  const stored = await storeDownloadPayload(downloadId, { url: video.url, referer: referer || '' });
  if (!stored) {
    delete STATE.activeDownloads[downloadId];
    throw new Error(t('sw_session_unavailable_download'));
  }
  const pageUrl = chrome.runtime.getURL('download-page/download.html') +
    `?id=${downloadId}&mode=${mode}` +
    `&name=${encodeURIComponent(video.name || guessNameFromUrl(video.url))}` +
    `&format=${encodeURIComponent(video.format || 'mp4')}` +
    `&size=${video.size || 0}` +
    `&type=${video.type || 'direct'}` +
    (video.track ? `&track=${encodeURIComponent(video.track)}` : '') +
    (video.quality ? `&quality=${encodeURIComponent(video.quality)}` : '') +
    // 画质自选（DASH）：popup 里选定的档位高度。缺省不带 = 引擎维持
    // "取最高 Representation" 的原行为。
    (video.preferredHeight ? `&preferredHeight=${encodeURIComponent(video.preferredHeight)}` : '');

  const tab = await createTabAdjacent(pageUrl, sourceTabId);
  if (STATE.activeDownloads[downloadId]) {
    STATE.activeDownloads[downloadId].tabId = tab.id;
  }
  return { downloadId, opened: true };
}

async function startRecording(video, tabId, recordSpeed) {
  // 安全审计修复：录制 ID 追加 CSPRNG 随机段（Date.now() 可预测可枚举，
  // 录制进度消息按 recordId 路由，可枚举 ID 便于伪造进度/打断）
  const recId = `rec_${Date.now().toString(36)}_${randToken(8)}`;
  STATE.activeRecordings = STATE.activeRecordings || {};
  STATE.activeRecordings[recId] = {
    tabId, video, startedAt: Date.now(),
    recordSpeed: recordSpeed > 1 ? recordSpeed : 1,
  };

  await chrome.tabs.sendMessage(tabId, {
    type: 'begin-record',
    recordId: recId,
    video,
    recordSpeed: recordSpeed > 1 ? recordSpeed : 1,
  });

  // 打开下载页显示录制进度
  const url = chrome.runtime.getURL('download-page/download.html') +
    `?mode=record&recordId=${recId}&tabId=${tabId}` +
    `&name=${encodeURIComponent(video.name || guessNameFromUrl(video.url) || t('sw_recording_video'))}`;
  await createTabAdjacent(url, tabId);

  return { recordId: recId, started: true };
}

async function cleanupDownloadCache(downloadId) {
  delete STATE.activeDownloads[downloadId];
  if (downloadId) {
    await chrome.storage.local.remove(`download_${downloadId}`).catch?.(() => {});
  }
  // v4.3.9：下载页退出/异常未走 unregister 时兜底清理保活闹钟
  syncKeepaliveAlarm();
}

// ============================================================
// 标签页生命周期
// ============================================================

// 修复：STATE.lastActiveTab 此前从未赋值，mse-download 在 msg.tabId 缺失时
// 永远走到「无活动标签页」分支。现在由 onActivated 持续更新。
chrome.tabs.onActivated.addListener(safe((activeInfo) => {
  STATE.lastActiveTab = activeInfo.tabId;
}));

chrome.tabs.onUpdated.addListener(safe((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTabVideos(tabId);
  } else if (changeInfo.status === 'loading') {
    // 同 URL 刷新（F5）：URL 未变不触发整表清理，但 MSE 捕获数据
    // （MAIN 世界内存）已随页面销毁——条目全部失效。
    // 只清这一类，保留直链/流媒体条目（URL 本身仍有效）。
    purgeEphemeralVideos(tabId);
  }
}));

chrome.tabs.onRemoved.addListener(safe((tabId) => {
  clearTabVideos(tabId);
  // DNR 规则和下载注册由下载页 handlePageExit 自行清理
  // 会话规则在浏览器重启时自动失效，不会泄漏
}));

function clearTabVideos(tabId) {
  delete STATE.detectedVideos[tabId];
  if (STATE.saveTimers[tabId]) {
    clearTimeout(STATE.saveTimers[tabId]);
    delete STATE.saveTimers[tabId];
  }
  chrome.storage.local.remove(`videos_${tabId}`).catch?.(() => {});
  // O-8：清除该 tab 的 cookie 快照（标签页视频清理时一并回收）
  clearCookieSnapshot(tabId);
  updateBadge(tabId);
}

// 清除「随页面存活」的条目：MSE 捕获（mse:// blob 数据在页面内存）。
// 直链/流媒体 URL 与页面无关，保留。
function purgeEphemeralVideos(tabId) {
  const list = STATE.detectedVideos[tabId];
  if (!Array.isArray(list) || list.length === 0) return;
  const kept = list.filter((v) => v.type !== 'mse-capture' && v.type !== 'mse' && v.type !== 'blob');
  if (kept.length === list.length) return;
  STATE.detectedVideos[tabId] = kept;
  try {
    const saved = kept.map(v => ({ ...v, _norm: undefined }));
    chrome.storage.local.set({ [`videos_${tabId}`]: saved }).catch?.(() => {});
  } catch {}
  updateBadge(tabId);
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? -1;
}

// 恢复状态
async function restoreState() {
  try {
    const data = await chrome.storage.local.get(null);
    const now = Date.now();
    for (const key of Object.keys(data)) {
      if (key.startsWith('videos_')) {
        const tabId = parseInt(key.split('_')[1]);
        if (!isNaN(tabId)) {
          // 重建 _norm 去重键（scheduleSave 存储时剥离）：不重建则唤醒后
          // 同 URL 重复上报绕过去重，已降权的官方条目会以高分新条目复活
          let restored = (data[key] || []).map(v => ({
            ...v, _norm: dedupKey(v.url),
          }));
          // S-2：恢复态封顶。存储中可能残留旧版/异常累积的超长列表，
          // 超 MAX_DETECTED_VIDEOS 按 timestamp（firstSeen）淘汰最旧，绝不超限
          if (restored.length > MAX_DETECTED_VIDEOS) {
            restored.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            restored = restored.slice(restored.length - MAX_DETECTED_VIDEOS);
          }
          STATE.detectedVideos[tabId] = restored;
          updateBadge(tabId);
        }
      } else if (key.startsWith(COOKIE_SNAPSHOT_PREFIX)) {
        // O-8：恢复 cookie 快照为「stale 提示」。proxy-fetch 优先尝试快照，
        // 401/403 由引擎回退重嗅（现有行为）。过期快照直接清除不恢复。
        const tabId = parseInt(key.slice(COOKIE_SNAPSHOT_PREFIX.length));
        if (isNaN(tabId)) continue;
        const snap = data[key];
        if (!snap || !snap.ts || now - snap.ts > COOKIE_SNAPSHOT_TTL_MS) {
          chrome.storage.local.remove(key).catch?.(() => {});
          continue;
        }
        const entries = Array.isArray(snap.entries) ? snap.entries : [];
        const map = new Map();
        for (const [k, v] of entries) {
          if (!v) continue;
          const staleEntry = { ...v, stale: true };
          map.set(k, staleEntry);
          // 同步进 HEADER_STORE（仅当无更新鲜条目时填入）
          if (!HEADER_STORE.has(k)) HEADER_STORE.set(k, staleEntry);
        }
        if (map.size > 0) COOKIE_SNAPSHOTS.set(tabId, map);
      }
    }
    // 残留 DNR 规则兜底清理（上次 SW 挂起时可能泄漏）
    removeAllForceRules();
  } catch {}
}
restoreState();

// ============================================================
// 右键菜单 + 生命周期
// ============================================================

chrome.contextMenus.onClicked.addListener(safe(async (info, tab) => {
  if (info.menuItemId === 'sniff-videos' && tab?.id) {
    // 与 popup「重新扫描」同一条路径：先清该页记录再重扫
    await MessageHandlers['rescan-page']({ tabId: tab.id });
  }
}));

// ============================================================
// 隐私保证：SW 挂起/更新时清除 DNR 规则
// ============================================================

chrome.runtime.onSuspend.addListener(safe(async () => {
  await removeAllForceRules();
}));

chrome.runtime.onInstalled.addListener(safe((details) => {
  // 安装/更新后注册周期 alarm（opfs-cleanup 等，详见 registerPeriodicAlarms）
  registerPeriodicAlarms();
  if (details.reason === 'install') {
    chrome.contextMenus.create({
      id: 'sniff-videos',
      title: t('sw_ctx_rescan'),
      contexts: ['page', 'video', 'audio'],
    });
  }
  if (details.reason === 'update') {
    removeAllForceRules();
  }
}));

// 卸载清理：通过 onInstalled uninstall 不可直接监听，
// 但我们通过 storage 清理函数提供手动隐私清除
async function fullPrivacyCleanup() {
  try {
    // 清除所有视频记录（安全审计补漏：chunks*
    // 分片缓存、dldata_* 遗留敏感载荷此前均未被清除）
    const data = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(data).filter(k =>
      k.startsWith('videos_') || k.startsWith('download_') ||
      k.startsWith('chunks') ||
      k.startsWith(DL_PAYLOAD_PREFIX) || k.startsWith(COOKIE_SNAPSHOT_PREFIX) ||
      k === 'history'
    );
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
    // 会话存储中的敏感载荷（Cookie/签名 URL）一并擦除
    try {
      const sess = await chrome.storage.session.get(null);
      const sessKeys = Object.keys(sess || {}).filter(k => k.startsWith(DL_PAYLOAD_PREFIX));
      if (sessKeys.length > 0) await chrome.storage.session.remove(sessKeys);
    } catch {}
    // 清除 DNR 规则
    await removeAllForceRules();
    // 清除 OPFS 下载临时目录（媒体分片落盘数据）
    try {
      if (navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('vs-downloads', { recursive: true }).catch?.(() => {});
      }
    } catch {}
  } catch {}
}

// ============================================================
// v4.3.1 Offscreen API 工具（借鉴 FetchV offscreen 模式）
// ------------------------------------------------------------
// 设计原则（与 FetchV 关键区别）：
// - FetchV 的 OFFSCREEN_FETCH_DATA：fetch 外部 URL → blob → 回传 URL
//   （绕过 SW 无 DOM 限制做跨域抓取）
// - 我们硬约束"隐私零外泄"+"不做外部 fetch"，**只处理本地 blob**：
//   content/SW 把已捕获的 blob: URL 传入 → offscreen 合并 → 回传新 blob URL
// - 不读 Cookie/UA，不上传字节，输出仍走扩展内部
//
// 当前用途：作为"未来扩展点"基础设施
// - 主下载流程仍走 download.html（稳定，不动）
// - 未来若需"无下载页合并 MSE 分片"，可调 mergeBlobsViaOffscreen
// - 已提供的最小能力：OFFSCREEN_MERGE_BLOBS
//
// 生命周期：
// - 按需 create（ensureOffscreen 内部去重 + 等待）
// - 用完 close（释放资源，避免常驻 offscreen document）
// - 5 分钟无活动自动 close（兜底）
// ============================================================

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const OFFSCREEN_REASON = 'BLOBS';   // chrome.offscreen.Reason.BLOBS
const OFFSCREEN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let _offscreenCreating = null;       // 进行中的 create Promise（去重）
let _offscreenCloseTimer = null;     // 兜底关闭定时器

/**
 * 确保 offscreen document 已创建（带并发去重）
 * @returns {Promise<boolean>} true 表示已就绪
 */
async function ensureOffscreen() {
  try {
    // 1. 检查是否已存在
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) {
      _resetOffscreenCloseTimer();
      return true;
    }
    // 2. 并发去重：多个调用方同时请求时只创建一次
    if (!_offscreenCreating) {
      _offscreenCreating = (async () => {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: [chrome.offscreen.Reason?.BLOBS || OFFSCREEN_REASON],
          justification: '合并已捕获的 MSE blob 数据（隐私零外泄，不发起外部请求）',
        });
      })();
    }
    try {
      await _offscreenCreating;
    } finally {
      _offscreenCreating = null;
    }
    _resetOffscreenCloseTimer();
    return true;
  } catch (e) {
    _offscreenCreating = null;
    console.warn('[VideoSniffer] ensureOffscreen 失败:', e?.message);
    return false;
  }
}

/**
 * 主动关闭 offscreen document（释放资源）
 */
async function closeOffscreen() {
  try {
    if (_offscreenCloseTimer) {
      clearTimeout(_offscreenCloseTimer);
      _offscreenCloseTimer = null;
    }
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) {
      await chrome.offscreen.closeDocument();
      console.log('[VideoSniffer] Offscreen document closed');
    }
  } catch (e) {
    // 静默：可能 document 已被关闭
  }
}

/**
 * 重置兜底关闭定时器（5 分钟无活动自动 close）
 */
function _resetOffscreenCloseTimer() {
  if (_offscreenCloseTimer) clearTimeout(_offscreenCloseTimer);
  _offscreenCloseTimer = setTimeout(() => {
    closeOffscreen().catch?.(() => {});
  }, OFFSCREEN_IDLE_TIMEOUT_MS);
}

/**
 * 通过 offscreen 合并多个 blob URL 为单个 blob URL
 * 输入校验：只接受 blob: 协议（防 SSRF / 防外部 fetch）
 *
 * @param {string[]} blobUrls  已捕获的 blob: URL 数组
 * @returns {Promise<{ok:true, blobURL:string, size:number} | {ok:false, error:string}>}
 */
async function mergeBlobsViaOffscreen(blobUrls) {
  try {
    // 入口预校验：必须是 blob: 协议（双重保险，offscreen.js 内部还会再校验一次）
    if (!Array.isArray(blobUrls) || blobUrls.length === 0) {
      return { ok: false, error: '空 blob 列表' };
    }
    for (const u of blobUrls) {
      try {
        const url = new URL(String(u));
        if (url.protocol !== 'blob:') {
          return { ok: false, error: '非法 URL（仅允许 blob: 协议）' };
        }
      } catch {
        return { ok: false, error: 'URL 解析失败' };
      }
    }

    const ready = await ensureOffscreen();
    if (!ready) {
      return { ok: false, error: 'Offscreen document 创建失败' };
    }

    // 发送给 offscreen.js（带 90s 总超时，防 SW 卡死）
    const result = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'Offscreen 响应超时（90s）' });
      }, 90 * 1000);

      try {
        chrome.runtime.sendMessage(
          { cmd: 'OFFSCREEN_MERGE_BLOBS', blobUrls },
          (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // 检查 chrome.runtime.lastError（offscreen 可能已关闭）
            const le = chrome.runtime.lastError;
            if (le) {
              resolve({ ok: false, error: le.message || le.toString() });
              return;
            }
            resolve(resp || { ok: false, error: '空响应' });
          }
        );
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || 'sendMessage 异常' });
      }
    });

    return result || { ok: false, error: '空响应' };
  } catch (e) {
    return { ok: false, error: e?.message || 'mergeBlobsViaOffscreen 异常' };
  }
}

// ============================================================
// v4.3.1 Offscreen 工具块结束
// ============================================================

