// test-abort-reason-v4210.js
// v4.2.10/v4.2.11 超时中断错误信息修复专项回归：
//   1. 静态约定：面向用户的四个文件（stream-downloader / download-engine
//      / download.js / service-worker）禁止出现裸 (controller|ctrl).abort() ——
//      Chrome 对不带 reason 的 abort() 给出 "signal is aborted without
//      reason"，任何漏网的 catch 会把这句英文系统错误原样显示给用户。
//      （v4.2.11 起把 SW 纳入：body 读取阶段的 abort 在部分 Chrome 版本以
//      TypeError 形态抛出，SW handler 的 AbortError→中文映射会失配漏出）
//   2. 机制验证：abort(reason) 后 fetch 拒绝原因 === 传入的 Error（Node 18+）
//   3. 语义契约：超时 reason 不得用 AbortError 名字（connectionWorker 把
//      AbortError 视为"用户暂停"→ 静默跳出循环不重试）；真暂停仍用 AbortError
//   4. UI 边界：handleError 的兜底正则可识别原生 abort 文案
// 运行：node test-abort-reason-v4210.js

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, ok, detail) {
  if (ok) { console.log(`PASS  ${name}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

(async () => {
  // ---- 1. 静态约定：四个文件无裸 abort ----
  const targets = [
    'lib/stream-downloader.js',
    'lib/download-engine.js',
    'download-page/download.js',
    'background/service-worker.js',
  ];
  for (const f of targets) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // 裸 abort()：controller/ctrl 变量（AbortController 惯例命名）无参调用。
    // writer.abort()（OPFS FileSystemWritableFileStream）不需要 reason，不匹配本模式。
    const bare = [];
    src.split('\n').forEach((line, i) => {
      if (/(controller|ctrl)\.abort\(\s*\)/.test(line)) bare.push(`L${i + 1}: ${line.trim()}`);
    });
    test(`【静态】${f} 无裸 abort()`, bare.length === 0, bare.join(' | '));
  }

  // ---- 2. 机制验证：abort(reason) → fetch 以该 reason 拒绝 ----
  const reason = new Error('清单获取超时（15 秒）——服务器响应过慢或网络受限');
  const ctrl = new AbortController();
  ctrl.abort(reason);
  test('【机制】signal.reason === 传入的 Error', ctrl.signal.reason === reason);
  let fetchErr = null;
  try {
    // 信号已中止：fetch 立即拒绝。Node 18+ 与 Chrome 98+ 行为一致——
    // 拒绝原因就是 abort(reason) 传入的对象（而非原生 AbortError）。
    await fetch('https://example.com/never-reached', { signal: ctrl.signal });
  } catch (e) {
    fetchErr = e;
  }
  test('【机制】fetch 拒绝原因即友好 reason', fetchErr === reason,
    `实际: ${fetchErr?.constructor?.name}: ${fetchErr?.message}`);
  test('【机制】reason 非原生 AbortError 文案', !/aborted without reason/i.test(String(fetchErr?.message)));

  // ---- 3. 语义契约：connectionWorker 的分发决策 ----
  // 与 download-engine.js connectionWorker catch 分支同构
  const dispatch = (err, paused) => (err.name === 'AbortError' || paused) ? 'break' : 'retry';
  const timeoutErr = new Error('分段下载超时（30 秒）');   // v4.2.10 的超时 reason
  const pauseErr = Object.assign(new Error('paused'), { name: 'AbortError' }); // 真暂停
  test('【契约】超时错误走重试（非静默跳出）', dispatch(timeoutErr, false) === 'retry');
  test('【契约】真暂停仍静默跳出', dispatch(pauseErr, false) === 'break');
  test('【契约】超时中用户点暂停 → 跳出', dispatch(timeoutErr, true) === 'break');

  // ---- 4. UI 边界兜底正则（与 download.js handleError 同构） ----
  const sanitize = (err) => {
    let msg = String(err.message || '未知错误').replace(/https?:\/\/[^\s'"]+/g, '[URL]');
    if (err?.name === 'AbortError' || /aborted without reason/i.test(msg)) {
      msg = '请求超时或被中断，请重试；若持续失败请更换条目或画质';
    }
    return msg;
  };
  const nativeAbort = Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' });
  test('【UI】原生 abort 文案被兜底替换', !/aborted without reason/i.test(sanitize(nativeAbort)));
  test('【UI】友好超时文案原样保留',
    sanitize(new Error('清单获取超时（15 秒）——服务器响应过慢')).includes('清单获取超时'));
  test('【UI】其他错误消息不受影响', sanitize(new Error('HTTP 403')) === 'HTTP 403');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
