// 回归测试：v3 引擎数据完整性修复
// 覆盖"文件名对但无法播放"的根因：
//  1. 分段反复失败不再假装完成（final-retry + 串行兜底，绝不留空洞）
//  2. Content-Range 偏移错位拒绝写入
//  3. 超长响应精确截断 + 写入错误不再被吞
const fs = require('fs');
const path = require('path');
// O-6 搬入 tests/ 子目录后源码路径相对项目根（兼容从项目根或 tests/ 目录运行）
const ENGINE_PATH = path.resolve(__dirname, '..', 'lib', 'download-engine.js');
const src = fs.readFileSync(ENGINE_PATH, 'utf8');
const DownloadEngine = new Function(src + '\nreturn DownloadEngine;')();

// ---- 测试环境 ----
// node 21+ 有 navigator（无 storage）；更早版本无 navigator —— 统一确保走内存降级
try { globalThis.navigator = {}; } catch {}
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
// 压缩引擎内的退避/轮次等待，测试提速（不影响逻辑正确性）
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms ?? 0, 2), ...a);

// ---- 模拟数据源（8MB，可预测字节模式）----
function makeMp4Data(size) {
  const data = new Uint8Array(size);
  data.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35], 0);
  for (let i = 16; i < size; i++) data[i] = i & 0xff;
  return data;
}
const DATA = makeMp4Data(8 * 1024 * 1024);

function makeResponse(status, data, contentRange) {
  const chunks = data.byteLength > 0 ? [data] : [];
  const body = new ReadableStream({
    start(c) { chunks.forEach(ch => c.enqueue(ch)); c.close(); },
  });
  const headers = new Map();
  if (contentRange) headers.set('content-range', contentRange);
  headers.set('content-length', String(data.byteLength));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    arrayBuffer: async () => data.buffer.slice(0, data.byteLength),
  };
}

// fetch mock：按 Range 返回数据；可控失败（前 5 次 403）与错位
let failCount = new Map();      // "start-end" → 剩余失败次数
let failForever = new Set();    // 永远失败的 start
let misalign = false;           // Content-Range 错位开关
let overrun = 0;                // 额外返回的字节数（超长响应）
global.fetch = async (url, init) => {
  const range = init?.headers?.Range;
  if (!range) return makeResponse(200, DATA, null);
  const m = String(range).match(/bytes=(\d+)-(\d+)/);
  const start = parseInt(m[1]), end = parseInt(m[2]);
  const key = `${start}-${end}`;
  if (failForever.has(start) || (failCount.get(key) || 0) > 0) {
    if (!failForever.has(start)) failCount.set(key, failCount.get(key) - 1);
    return makeResponse(403, new Uint8Array(0));
  }
  const actualStart = misalign ? 0 : start;
  const slice = DATA.slice(actualStart, end + 1 + (misalign ? 0 : overrun));
  return makeResponse(206, slice, `bytes ${actualStart}-${actualStart + slice.length - 1}/${DATA.length}`);
};

function newEngine() {
  const e = new DownloadEngine({ url: 'https://x/v.m4s', fileName: 't.m4s', threadCount: 4, maxThreads: 4 });
  e.saveFile = async () => {};   // 不触发浏览器下载
  return e;
}

// 拦截 finalizeFile 以拿到内部 Blob（内存降级模式下唯一产物）
function captureBlob(e) {
  let blob = null;
  const orig = e.finalizeFile.bind(e);
  e.finalizeFile = async () => { blob = await orig(); return blob; };
  return () => blob;
}

async function verifyBlob(blob) {
  if (!blob) return '未拿到文件 Blob';
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf.length !== DATA.length) return `长度不符 (${buf.length}/${DATA.length})`;
  for (let i = 16; i < DATA.length; i++) {
    if (buf[i] !== DATA[i]) return `字节错位 @${i}: ${buf[i]} != ${DATA[i]}`;
  }
  return 'ok';
}

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    const r = await fn();
    if (r === 'ok') { console.log(`PASS  ${label}`); pass++; }
    else { console.log(`FAIL  ${label}  → ${r}`); fail++; }
  } catch (e) {
    console.log(`FAIL  ${label}  → ${e.message}`);
    fail++;
  }
}

(async () => {
  // 1. 正常分段下载 → 字节级完整
  await test('正常分段下载字节级完整', async () => {
    const e = newEngine();
    const getBlob = captureBlob(e);
    await e.start();
    if (e.status !== 'done') return `状态 ${e.status}`;
    return await verifyBlob(getBlob());
  });

  // 2. 某分段前 5 次 403（模拟 CDN 限流）→ final-retry 串行兜底成功 → 数据仍完整
  await test('分段限流重试后数据完整', async () => {
    // v4.2.7 起 minPieceSize=2MB：8MB 文件分段起点 0/2097152/4194304/6291456
    failCount.set('2097152-4194303', 5);  // 第 2 段前 5 次失败
    const e = newEngine();
    const getBlob = captureBlob(e);
    await e.start();
    if (e.status !== 'done') return `状态 ${e.status}`;
    return await verifyBlob(getBlob());
  });

  // 3. 某分段永远失败 → 整体报错，绝不产出损坏文件
  await test('分段永久失败→整体报错不产文件', async () => {
    failForever.add(2 * 1024 * 1024);   // 第 2 段起点（minPieceSize=2MB）
    const e = newEngine();
    let errCaught = null, completed = false;
    e.onError = (err) => { errCaught = err; };
    e.onComplete = () => { completed = true; };
    await e.start();
    if (e.status !== 'error') return `状态应为 error，实际 ${e.status}`;
    if (completed) return '不应触发 onComplete';
    if (!errCaught || !/分段/.test(errCaught.message)) return `错误信息异常: ${errCaught?.message}`;
    return 'ok';
  });

  // 4. Content-Range 错位 → fetchPiece 拒绝写入
  await test('Content-Range 错位拒绝写入', async () => {
    misalign = true;
    const e = newEngine();
    e.pieces = [{ index: 0, start: 100, end: 199, size: 100, downloaded: 0, status: 'active' }];
    try {
      await e.fetchPiece(e.pieces[0]);
      return '未抛出异常';
    } catch (err) {
      return /错位/.test(err.message) ? 'ok' : `异常信息不符: ${err.message}`;
    } finally { misalign = false; }
  });

  // 5. 超长响应精确截断到分段边界
  await test('超长响应精确截断', async () => {
    overrun = 500;
    const e = newEngine();
    e._useOPFS = false;   // 单元级调用：直接走内存分支
    e.pieces = [{ index: 0, start: 100, end: 199, size: 100, downloaded: 0, status: 'active' }];
    await e.fetchPiece(e.pieces[0]);
    const bytes = e._memChunks.reduce((s, c) => s + c.data.byteLength, 0);
    return bytes === 100 ? 'ok' : `写入 ${bytes} 字节（应 100）`;
  });

  // 6. 写入失败不再被吞 → finalizeFile 硬失败
  await test('写入失败→finalize 硬失败', async () => {
    const e = newEngine();
    e._useOPFS = true;
    e.fileHandle = {};
    e.writer = { write: async () => { throw new Error('disk full'); }, close: async () => {} };
    await e.writeAt(0, new Uint8Array(10));
    await e.writeAt(10, new Uint8Array(10));
    try {
      await e.finalizeFile();
      return '未抛出异常';
    } catch (err) {
      return /写入失败/.test(err.message) ? 'ok' : `异常信息不符: ${err.message}`;
    }
  });

  // 7. SW 分段进度推送（seg-progress）记账：在途字节计入、不重复、不越界
  await test('SW分段进度推送记账正确', async () => {
    const e = newEngine();
    const MB = 1024 * 1024;
    e.totalSize = 8 * MB;
    e.pieces = [
      { index: 0, start: 0, end: 2 * MB - 1, size: 2 * MB, downloaded: 0, status: 'done' },
      { index: 1, start: 2 * MB, end: 4 * MB - 1, size: 2 * MB, downloaded: 0, status: 'active' },
    ];
    e.completedBytes = 2 * MB;
    e.downloadedBytes = e.completedBytes;
    const pieceB = e.pieces[1];
    const reqId = 'seg_test_1';
    e._segInflight.set(reqId, pieceB);

    e._onSegProgress(reqId, 512 * 1024);
    if (e.downloadedBytes !== 2 * MB + 512 * 1024) return `在途字节未计入 (${e.downloadedBytes})`;

    e._onSegProgress(reqId, 512 * 1024);  // 同值重复推送（SW 512KB 节流边界）
    if (e.downloadedBytes !== 2 * MB + 512 * 1024) return `重复推送被重复计数 (${e.downloadedBytes})`;

    e._onSegProgress(reqId, 5 * MB);      // 超过分段大小 → 截断到 piece.size
    if (e.downloadedBytes !== 4 * MB) return `越界值未截断 (${e.downloadedBytes})`;

    e._onSegProgress('seg_unknown', 1024); // 未知 reqId（迟到消息）→ 忽略
    if (e.downloadedBytes !== 4 * MB) return `未知 reqId 被计入 (${e.downloadedBytes})`;

    if (pieceB.downloaded !== 2 * MB) return `piece.downloaded 异常 (${pieceB.downloaded})`;
    e._segInflight.delete(reqId);
    return 'ok';
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
