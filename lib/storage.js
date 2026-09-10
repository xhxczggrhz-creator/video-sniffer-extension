/**
 * 视频嗅探器 - 存储管理 v2.2
 * 封装 chrome.storage.local 与 IndexedDB，管理持久化状态
 *
 * 隐私加固：
 * - privacyMode（默认开启）：历史记录只存域名不存完整 URL
 * - historyTTL（默认 24h）：自动过期清理下载历史
 * - purgeAll：一键清除所有痕迹
 */

const Storage = {
  // ============================================================
  // chrome.storage.local 封装
  // ============================================================
  async get(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve(result[key]);
      });
    });
  },

  async set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  },

  async remove(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, () => resolve());
    });
  },

  async getAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => resolve(result));
    });
  },

  // ============================================================
  // 设置管理
  // ============================================================
  DEFAULT_SETTINGS: {
    threadCount: 8,
    fileNameMode: 'auto',     // 'auto' = from video title, 'custom' = user specified
    saveLocation: 'browser',  // 'browser' = follow browser setting
    saveMode: 'auto',         // 'auto' = download on complete, 'manual' = user triggers
    clearCacheOnExit: true,
    speedBoost: true,         // Enable adaptive thread scaling
    privacyMode: true,        // 历史记录只存域名不存完整 URL
    historyTTL: 24,           // 下载历史自动过期（小时）
  },

  async getSettings() {
    const settings = await this.get('settings');
    return { ...this.DEFAULT_SETTINGS, ...settings };
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    const merged = { ...current, ...settings };
    await this.set('settings', merged);
    return merged;
  },

  // ============================================================
  // 下载历史（轻量，不存视频内容）
  // 隐私模式：URL 脱敏为域名，不保留完整地址
  // ============================================================
  maskUrl(url) {
    try {
      return new URL(url).hostname;
    } catch { return '(未知来源)'; }
  },

  async addHistory(record) {
    const settings = await this.getSettings();
    const history = (await this.get('history')) || [];
    history.unshift({
      id: record.id,
      fileName: record.fileName,
      url: settings.privacyMode ? this.maskUrl(record.url) : record.url,
      size: record.size,
      timestamp: Date.now(),
      status: record.status,
    });
    if (history.length > 100) history.length = 100;
    await this.set('history', history);
  },

  async getHistory() {
    return (await this.get('history')) || [];
  },

  async clearHistory() {
    await this.remove('history');
  },

  // 一键清除所有痕迹：视频记录、下载历史、临时缓存
  async purgeAll() {
    try {
      const data = await this.getAll();
      const keys = Object.keys(data).filter(k =>
        k.startsWith('videos_') || k.startsWith('download_') ||
        k.startsWith('parse_') || k.startsWith('dldata_') ||
        k === 'history' || k.startsWith('chunks')
      );
      await this.remove(keys);
      // 清除 OPFS 下载目录
      if (navigator.storage?.getDirectory) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry('vs-downloads', { recursive: true }).catch?.(() => {});
        } catch {}
      }
    } catch {}
  },

  // ============================================================
  // IndexedDB 大数据块缓存（OPFS 降级方案）
  // ============================================================
  async initDB(dbName = 'VideoSnifferDB', storeName = 'chunks') {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async putBlob(db, storeName, key, blob) {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ key, data: blob });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async getBlob(db, storeName, key) {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => resolve(null);
    });
  },

  async clearStore(db, storeName) {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  // ============================================================
  // 格式化工具
  // ============================================================
  formatSize(bytes) {
    if (!bytes || bytes === 0) return '大小未知';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  },

  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 1024) return `${(bytesPerSec || 0).toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    if (bytesPerSec < 1024 * 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  },

  formatTime(seconds) {
    if (!seconds || seconds < 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  formatProgress(downloaded, total) {
    if (!total || total === 0) {
      return this.formatSize(downloaded);
    }
    const percent = (downloaded / total) * 100;
    return `${percent.toFixed(1)}% (${this.formatSize(downloaded)} / ${this.formatSize(total)})`;
  },
};

if (typeof window !== 'undefined') {
  window.Storage = Storage;
}
