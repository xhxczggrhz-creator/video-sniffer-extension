/**
 * 视频嗅探器 - 共享常量表（O-3 集中化）
 *
 * 集中管理后台 service worker 与下载引擎使用的魔法数字，
 * 便于审计、调参与避免散落硬编码导致的不一致。
 *
 * 安全约束：
 * - 本文件不含任何外部 URL / 端点 / 主机名
 * - 不含 P2P / BT / magnet 相关配置
 * - 不含任何遥测上报地址
 * - 仅导出纯静态字面量，无副作用、无 I/O
 *
 * MV3 兼容：manifest.json 已声明 background.type=module，
 * service-worker.js 通过静态 import 引用本文件；
 * 其他模块（download-engine.js 等）同样以 ES module 引入。
 */

// ============================================================
// 超时（毫秒）
// ============================================================

/** 清单（m3u8/mpd）抓取超时：小请求，15s 足够 */
export const MANIFEST_FETCH_TIMEOUT = 15000;
/** 分片抓取超时：2-32MB 分片，慢速链路放宽到 65s */
export const SEGMENT_FETCH_TIMEOUT = 65000;
/**
 * 分片停滞看门狗（毫秒）：proxy-fetch-segment 流式落盘期间，连续 N 毫秒
 * 无新数据流入才 abort。区别于总超时——慢速链路（几十~几百 KB/s）下 32MB
 * 分片可能耗时远超 65s，总超时会在数据仍在流动时误杀 → 下载页转直连/重试
 * → 速度在 MB/s 与几十 B/s 间剧烈抖动（"特定网站下载不稳"的根因）。
 * 只要数据在流动（哪怕很慢）就绝不打断。
 */
export const SEGMENT_STALL_TIMEOUT = 30000;
/** AES-128 密钥抓取超时：16 字节小请求 */
export const KEY_FETCH_TIMEOUT = 15000;
/** 探测请求超时（proxy-probe / 清单首探）：小请求 */
export const PROBE_TIMEOUT = 15000;
/** B 站 playurl API 超时 */
export const BILI_API_TIMEOUT = 10000;
/** 默认重试退避基数（指数退避：base * 2^attempt） */
export const DEFAULT_RETRY_BACKOFF = 500;

/** DNS 复查缓存：解析成功结果 TTL（10 分钟） */
export const DNS_CACHE_TTL = 10 * 60 * 1000;

// ============================================================
// 尺寸（字节）
// ============================================================

/** 单分片上限 32MB（超此判异常，防内存爆涨） */
export const MAX_SEG_SIZE = 32 * 1024 * 1024;
/** 单分片下限 2MB（低于此可能非视频分片） */
export const MIN_SEG_SIZE = 2 * 1024 * 1024;
/** OPFS 聚合写入阈值 1MB（小于此走内存聚合） */
export const OPFS_AGGREGATE_THRESHOLD = 1024 * 1024;
/** 录制默认上限 2GB */
export const RECORD_LIMIT_DEFAULT = 2 * 1024 * 1024 * 1024;
/** OPFS 流式写入块大小 8MB */
export const OPFS_STREAM_CHUNK = 8 * 1024 * 1024;

// ============================================================
// 数量上限（H-1 / S-2 缓存与内存封顶）
// ============================================================

/** 单分片最大重试次数 */
export const MAX_RETRIES = 5;
/** 单标签页视频条目上限（内存封顶，防 SW 失控累积） */
export const MAX_DETECTED_VIDEOS = 2000;
/** DNS 复查缓存条目上限（LRU 淘汰） */
export const MAX_DNS_CACHE = 200;
/** DNR 防盗链头规则缓存上限（LRU 淘汰，belt-and-suspenders） */
export const MAX_HEADER_RULE_CACHE = 50;
/** Cookie/Referer 持久缓存上限（HEADER_STORE LRU 淘汰） */
export const MAX_COOKIE_CACHE = 300;

// ============================================================
// 连接数预算（aria2 全局预算模型）
// ============================================================

/** 全局并发连接预算（HTTP/2 多路复用仍足够） */
export const GLOBAL_CONN_BUDGET = 32;
/** 单任务最低连接数（尊重用户低线程设定） */
export const MIN_CONN_PER_TASK = 2;

// ============================================================
// DNR 强力下载规则 ID 池
// ============================================================

/** 规则 ID 池起始（含），用于强力下载注入 Referer/Origin/Cookie */
export const FORCE_RULE_ID_POOL_START = 9500;
/** 规则 ID 池结束（不含） */
export const FORCE_RULE_ID_POOL_END = 9600;
/** 规则 ID 池容量 = END - START */
export const FORCE_RULE_ID_POOL_SIZE = 100;

// ============================================================
// Cookie 快照持久化（O-8：跨 SW 重启续传下载）
// ============================================================

/** Cookie 快照本地存储 TTL：30 分钟后视为过期清除 */
export const COOKIE_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
