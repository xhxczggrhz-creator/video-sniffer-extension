// 回归测试：v4.3.15 直链引擎「直连优先、代理兜底」调度契约
//
// 覆盖：
//  1. DNR 已生效（_forceRuleApplied）时 fetchPiece 首选 _directFetchPiece（单缓冲提速）
//  2. 直连成功 → _directFailCount 归零，代理零调用
//  3. 直连 TypeError（CORS/网络）→ 本分段立即转 _proxyFetchPiece，_useDirect 仍保持
//  4. 直连连续 3 次失败 → _useDirect=false 整体回退，后续分段不再尝试直连
//  5. NoRangeError / AbortError 直接抛出（转单流/暂停语义，不与代理计数混淆）
//  6. DNR 未生效（_forceRuleApplied=false）→ 调度与 v4.2.6 代理优先完全一致（回退保障）
//  7. 静态扫描：无裸 abort()（沿用 v4.2.10 语义契约）

const fs = require('fs');
const path = require('path');
const ENGINE_PATH = path.resolve(__dirname, '..', 'lib', 'download-engine.js');
const src = fs.readFileSync(ENGINE_PATH, 'utf8');
const DownloadEngine = new Function(src + '\nreturn DownloadEngine;')();

try { globalThis.navigator = {}; } catch {}
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
// 模拟扩展环境：fetchPiece 的调度分支以 canProxy（chrome.runtime.sendMessage）为前提。
// _proxyFetchPiece / _directFetchPiece 均已打桩，sendMessage 不会被真正调用。
globalThis.chrome = { runtime: { sendMessage: async () => ({}) } };

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log('PASS ', name); }
  else { failed++; console.log('FAIL ', name); }
}

function makeEngine() {
  const eng = new DownloadEngine({
    url: 'https://cdn.example.com/video.mp4',
    fileName: 'video.mp4',
    totalSize: 16 * 1024 * 1024,
  });
  // 沙箱无 chrome → canProxy=false；这里用打桩绕过环境判断，
  // 只测 fetchPiece 的调度逻辑（_directFetchPiece/_proxyFetchPiece 均为桩）。
  eng._directCalls = 0;
  eng._proxyCalls = 0;
  eng._directFailCount = 0;
  eng._useDirect = true;
  eng._forceRuleApplied = true;
  eng.paused = false;                          // 构造后默认暂停态，测试中视为运行中
  eng.aborted = false;
  eng._directFetchPiece = async (piece) => {
    eng._directCalls++;
    if (eng._directBehavior === 'ok') { piece.status = 'done'; return 'direct-ok'; }
    if (eng._directBehavior === 'typeerror') { const e = new TypeError('Failed to fetch'); throw e; }
    if (eng._directBehavior === 'norange') { const e = new Error('服务器不支持 Range 分段'); e.name = 'NoRangeError'; throw e; }
    if (eng._directBehavior === 'abort') { const e = new Error('paused'); e.name = 'AbortError'; throw e; }
    if (eng._directBehavior === 'http500') { throw new Error('HTTP 500'); }
    throw new Error('unknown behavior');
  };
  eng._proxyFetchPiece = async (piece) => {
    eng._proxyCalls++;
    piece.status = 'done';
    return 'proxy-ok';
  };
  return eng;
}

(async () => {
  // ---- 用例 1：直连成功 ----
  {
    const eng = makeEngine();
    eng._directBehavior = 'ok';
    const r = await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 });
    assert('直连成功返回直连结果', r === 'direct-ok');
    assert('直连成功不调代理', eng._proxyCalls === 0);
    assert('直连成功失败计数归零', eng._directFailCount === 0);
  }

  // ---- 用例 2：直连 TypeError → 本分段立即转代理，_useDirect 保持 ----
  {
    const eng = makeEngine();
    eng._directBehavior = 'typeerror';
    const r = await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 });
    assert('直连 TypeError 本分段转代理成功', r === 'proxy-ok');
    assert('直连失败计数 +1', eng._directFailCount === 1);
    assert('未达阈值仍保持直连优先', eng._useDirect === true);
    assert('直连与代理各调用一次', eng._directCalls === 1 && eng._proxyCalls === 1);
  }

  // ---- 用例 3：连续 3 次失败 → 整体回退代理 ----
  {
    const eng = makeEngine();
    eng._directBehavior = 'typeerror';
    const piece = () => ({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 });
    await eng.fetchPiece(piece()); // 失败 1
    await eng.fetchPiece(piece()); // 失败 2
    assert('第 2 次失败后仍未回退', eng._useDirect === true);
    await eng.fetchPiece(piece()); // 失败 3 → 回退
    assert('第 3 次失败后整体回退代理', eng._useDirect === false);
    const r = await eng.fetchPiece(piece()); // 第 4 段：直接走代理
    assert('回退后不再尝试直连', r === 'proxy-ok' && eng._directCalls === 3 && eng._proxyCalls === 4);
  }

  // ---- 用例 4：直连成功重置失败计数（抖动场景自愈）----
  {
    const eng = makeEngine();
    const piece = () => ({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 });
    eng._directBehavior = 'typeerror';
    await eng.fetchPiece(piece());
    await eng.fetchPiece(piece());
    eng._directBehavior = 'ok';
    await eng.fetchPiece(piece());
    assert('成功后失败计数归零（抖动自愈）', eng._directFailCount === 0 && eng._useDirect === true);
  }

  // ---- 用例 5：NoRangeError / AbortError 直接抛出 ----
  {
    const eng = makeEngine();
    eng._directBehavior = 'norange';
    let threw = false;
    try { await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 }); }
    catch (e) { threw = e?.name === 'NoRangeError'; }
    assert('NoRangeError 直接上抛（转单流）', threw && eng._proxyCalls === 0);

    eng._directBehavior = 'abort';
    threw = false;
    try { await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 }); }
    catch (e) { threw = e?.name === 'AbortError'; }
    assert('AbortError 直接上抛（用户暂停语义）', threw && eng._proxyCalls === 0);
  }

  // ---- 用例 6：DNR 未生效 → 与 v4.2.6 代理优先行为一致 ----
  {
    const eng = makeEngine();
    eng._forceRuleApplied = false;
    eng._directBehavior = 'ok';
    const r = await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 });
    assert('DNR 未生效不走直连（回退保障）', r === 'proxy-ok' && eng._directCalls === 0);
  }

  // ---- 用例 7：非鉴权类 HTTP 错误（500）不上抛为代理问题，直接抛出走原重试 ----
  {
    const eng = makeEngine();
    eng._directBehavior = 'http500';
    let threw = false;
    try { await eng.fetchPiece({ index: 0, start: 0, end: 1023, size: 1024, status: 'active', downloaded: 0 }); }
    catch (e) { threw = /^HTTP 500$/.test(e?.message || ''); }
    assert('HTTP 500 不转代理直接抛出（交由 connectionWorker 重试）', threw && eng._proxyCalls === 0);
  }

  // ---- 用例 8：静态扫描 —— download-engine.js 无裸 abort() ----
  {
    const bare = (src.match(/\.abort\(\s*\)/g) || []).filter(m => true);
    // OPFS writer.abort() 允许（资源清理），fetch AbortController.abort() 必须带 reason。
    // 区分方式：writer.abort 调用形如 `this.writer.abort()` / `writer.abort()`，
    // 其余 `.abort()` 均视为裸 abort。全库既有约定见 test-abort-reason-v4210.js。
    const nakedFetchAbort = (src.match(/(?<!writer)\.abort\(\s*\)/g) || []).length;
    assert('无裸 fetch abort()（语义契约不回退）', nakedFetchAbort === 0 && Array.isArray(bare));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
