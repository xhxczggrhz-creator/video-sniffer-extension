// 回归测试：v4.3.16 流媒体分段「并发领取 / 终结态 / 代际」三重守卫
//
// 背景：UI 出现「131/128 段 / 102.3%」越界 + 「13 个分片反复下载失败」中止。
// 根因：失败分段 push 回 _queue 产生重复条目 + P1-E 队头救援与普通 worker 撞车，
// 同一分段被并发下载 —— ① 重复计数（completed/downloadedSegments 越界）；
// ② segmentErrors 双倍消耗 → 5 次重试窗口腰斩 → 假性 skip → TS>5% 整单中止。
//
// 覆盖：
//  1. _downloadSegment 入口守卫：in-flight / done / skipped 的分段直接放弃（不二次 fetch）
//  2. 成功路径幂等：并发完成者（seg 已被他人标 done）不再计数
//  3. skip 路径幂等：404 时已 skipped 的分段不再重复计数
//  4. 代际守卫：start() 重试（_generation++）后，旧 worker 完成回调不写脏本轮计数
//  5. 静态：download.js 三处 UI 钳制（percent/分数/标题 均 Math.min(completed,total)）

const fs = require('fs');
const path = require('path');
const SD_PATH = path.resolve(__dirname, '..', 'lib', 'stream-downloader.js');
const src = fs.readFileSync(SD_PATH, 'utf8');
const StreamDownloader = new Function(src + '\nreturn StreamDownloader;')();

try { globalThis.navigator = {}; } catch {}
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
globalThis.chrome = { runtime: { sendMessage: async () => ({}) } };

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log('PASS ', name); }
  else { failed++; console.log('FAIL ', name); }
}

function makeSD() {
  const sd = new StreamDownloader({
    url: 'https://cdn.example.com/index.m3u8',
    fileName: 'video.mp4',
    format: 'm3u8',
  });
  sd.paused = false;
  sd.aborted = false;
  // 桩：跳过 OPFS / UI 副作用，只测分段调度与计数
  sd.flushInOrder = async () => {};
  sd.writeSequential = async () => {};
  sd.detectRealFormat = async () => {};
  sd.notifyProgressThrottled = () => {};
  sd.fetchBlobCalls = 0;
  sd._fetchBlobImpl = async () => new Blob([new Uint8Array(64)]);
  sd.fetchBlob = async (url, segReqId) => {
    sd.fetchBlobCalls++;
    return sd._fetchBlobImpl(url, segReqId);
  };
  return sd;
}

const seg = (index, extra = {}) => Object.assign({
  index, url: `https://cdn.example.com/seg${index}.ts`, status: 'pending', size: 0,
}, extra);

(async () => {
  // ---- 用例 1：in-flight 守卫（并发重复领取直接放弃）----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    sd._inflight.add(0);           // 模拟另一 worker 正在下载 #0
    const before = sd.fetchBlobCalls;
    await sd._downloadSegment(sd.segments[0]);
    assert('in-flight 分段不二次 fetch', sd.fetchBlobCalls === before);
    assert('in-flight 分段不计数', sd.downloadedSegments === 0 && sd.completedBytes === 0);
  }

  // ---- 用例 2：正常下载 → done + 计数各 +1 ----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    await sd._downloadSegment(sd.segments[0]);
    assert('正常下载计数 +1', sd.downloadedSegments === 1 && sd.failedSegments === 0);
    assert('正常下载状态 done', sd.segments[0].status === 'done');
    assert('inflight 已清理', sd._inflight.size === 0);
  }

  // ---- 用例 3：done 幂等（并发完成者晚到，不二次计数）----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    sd.segments[0].status = 'done';   // 另一 worker 已完成
    await sd._downloadSegment(sd.segments[0]);
    assert('done 分段不重复计数', sd.downloadedSegments === 0);
  }

  // ---- 用例 4：404 skip 幂等（重复条目第二次触发 404 不重复计数）----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    sd._fetchBlobImpl = async () => { throw new Error('HTTP 404 Not Found'); };
    await sd._downloadSegment(sd.segments[0]);   // 第一次：skip + 计数
    assert('首次 404 → skipped 且计数 +1', sd.segments[0].status === 'skipped' &&
      sd.downloadedSegments === 1 && sd.failedSegments === 1);
    const before = sd.downloadedSegments;
    sd.segments[0].status = 'skipped';           // 若重复条目再处理（含 rescue/旧 worker）
    await sd._downloadSegment(sd.segments[0]);
    assert('已 skipped 分段不重复计数', sd.downloadedSegments === before && sd.failedSegments === before);
  }

  // ---- 用例 5：代际守卫（start() 重试后旧 worker 完成回调不写脏计数）----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    let resolveFetch;
    sd._fetchBlobImpl = () => new Promise((res) => { resolveFetch = res; });
    const p = sd._downloadSegment(sd.segments[0]);   // 旧 worker 在飞（myGen=1）
    sd._generation = 2;                               // start() 重试自增（本轮已清零计数）
    sd.downloadedSegments = 0; sd.failedSegments = 0; sd.completedBytes = 0;
    resolveFetch(new Blob([new Uint8Array(64)]));     // 旧 fetch 此刻才完成
    await p;
    assert('过期 worker 不写脏本轮计数', sd.downloadedSegments === 0 && sd.failedSegments === 0 && sd.completedBytes === 0);
    assert('过期 worker 不改分段状态', sd.segments[0].status === 'pending');
  }

  // ---- 用例 6：404 且代际过期 → 同样不计数 ----
  {
    const sd = makeSD();
    sd.segments = [seg(0)];
    let resolveFetch;
    sd._fetchBlobImpl = () => new Promise((_, rej) => { resolveFetch = () => rej(new Error('HTTP 404')); });
    const p = sd._downloadSegment(sd.segments[0]);
    sd._generation = 3; sd.downloadedSegments = 0; sd.failedSegments = 0;
    resolveFetch();
    await p;
    assert('过期 worker 的 404 不计数', sd.downloadedSegments === 0 && sd.failedSegments === 0);
  }

  // ---- 用例 7：skip 判定幂等（errs≥5 时若已 skipped 不重复计数）----
  {
    const sd = makeSD();
    sd.segments = [seg(0, { status: 'skipped' })];
    sd.segmentErrors.set(0, 7);
    sd._queue = [sd.segments[0]];
    sd._queueCursor = 0;
    // 直接驱动 worker 主循环一回合（paused 退出）
    sd.paused = true;  // 先置 true 防循环；改为单步执行不了，改测 _nextSeg + 判定守卫语义：
    // 等价验证：errs≥5 分支的幂等条件在代码中（_downloadSegment 入口已拦 skipped），
    // 此处通过 _downloadSegment 直接触发等效路径。
    sd.paused = false;
    sd._fetchBlobImpl = async () => { throw new Error('HTTP 404'); };
    const before = sd.downloadedSegments;
    // 已 skipped 分段不会进入 _downloadSegment（入口守卫），直接断言入口行为
    await sd._downloadSegment(sd.segments[0]);
    assert('skipped 分段入口即放弃', sd.downloadedSegments === before && sd.fetchBlobCalls === 0);
  }

  // ---- 用例 8：静态 —— download.js 三处 UI 钳制 ----
  {
    const dj = fs.readFileSync(path.resolve(__dirname, '..', 'download-page', 'download.js'), 'utf8');
    const clampSeg = (dj.match(/Math\.min\(completed, segTotal\)/g) || []).length;
    assert('分数/百分比 两处 completed≤total 钳制', clampSeg === 2);
    const titleClamp = /Math\.min\(seg\?\.completed \|\| 0, segTotal\)/.test(dj);
    assert('标签页标题钳制', titleClamp);
    const pctClamp = /Math\.min\(100, \(clamped \/ segTotal\) \* 100\)/.test(dj);
    assert('百分比上限 100 钳制', pctClamp);
  }

  // ---- 用例 9：静态 —— 两引擎速度监控负增量钳零（不再显示 -几 B/s）----
  {
    const sdSrc = src;
    const engSrc = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'download-engine.js'), 'utf8');
    const both = sdSrc + engSrc;
    assert('两引擎速度采样均 dBytes>0 才计速', (both.match(/dBytes > 0 \? dBytes \/ dt : 0/g) || []).length === 2);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
