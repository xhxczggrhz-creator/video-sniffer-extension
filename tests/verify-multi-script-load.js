// verify-multi-script-load.js
// v4.3.4 回归：模拟 download.html 的多 <script> 顺序加载（共享全局词法作用域），
// 验证 net-helpers.js + download-engine.js + stream-downloader.js 顺序执行后
// window.StreamDownloader / window.DownloadEngine 均已定义（无顶层 const 重名冲突）。
// 运行：node tests/verify-multi-script-load.js

const fs = require('fs');
const path = require('path');

const lib = path.join(__dirname, '..', 'lib');
const net = fs.readFileSync(path.join(lib, 'net-helpers.js'), 'utf8');
const eng = fs.readFileSync(path.join(lib, 'download-engine.js'), 'utf8');
const stream = fs.readFileSync(path.join(lib, 'stream-downloader.js'), 'utf8');
const merger = fs.readFileSync(path.join(lib, 'mp4-merger.js'), 'utf8');
const tsMux = fs.readFileSync(path.join(lib, 'ts-mux.min.js'), 'utf8');
const tsRemux = fs.readFileSync(path.join(lib, 'ts-remux.js'), 'utf8');
const storage = fs.readFileSync(path.join(lib, 'storage.js'), 'utf8');

// 与 download.html 完全一致的加载顺序
const combo = [net, eng, stream, merger, tsMux, tsRemux, storage].join('\n;\n');

function buildChromeStub() {
  const noop = () => {};
  return {
    runtime: {
      id: 'test-ext-id',
      onMessage: { addListener: noop },
      onConnect: { addListener: noop },
      connect: noop,
      sendMessage: noop,
      lastError: null,
    },
    storage: {
      local: { get: noop, set: noop, remove: noop },
      session: { get: noop, set: noop, remove: noop },
      onChanged: { addListener: noop },
    },
    downloads: { onChanged: { addListener: noop }, onDeterminingFilename: { addListener: noop } },
    tabs: { onRemoved: { addListener: noop }, onUpdated: { addListener: noop } },
    webRequest: { onSendHeaders: { addListener: noop } },
  };
}

const sandboxWindow = {
  location: { href: 'chrome-extension://test/download-page/download.html', origin: 'chrome-extension://test' },
  postMessage: () => {},
  addEventListener: () => {},
};

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS  ${name}`); }
  else { console.log(`FAIL  ${name} :: ${detail ?? ''}`); failed++; }
}

try {
  // 用 vm 模拟多个 script 标签在共享全局上下文依次执行
  const vm = require('vm');
  const ctx = vm.createContext({ window: sandboxWindow, globalThis: undefined, chrome: buildChromeStub(), console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Blob: class { constructor(p, o) { this.parts = p; this.type = o?.type || ''; } arrayBuffer() { return Promise.resolve(new Uint8Array(0).buffer); } stream() { throw new Error('no stream in sandbox'); } }, Uint8Array, Uint32Array, Int32Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, crypto: { subtle: {} }, DOMException: class { constructor(m) { this.message = m; } }, performance: { now: () => Date.now() }, AbortController, Promise, Map, Set, Error, TypeError, ReferenceError, SyntaxError, Number, Math, Date, JSON, Object, String, Array, RegExp, Symbol, Reflect, Proxy, WeakMap, WeakSet, Event });
  ctx.globalThis = ctx;
  sandboxWindow.window = sandboxWindow;
  ctx.window = sandboxWindow;

  vm.runInContext(combo, ctx, { filename: 'lib-all.js' });

  const hasStream = typeof ctx.window.StreamDownloader === 'function';
  const hasEngine = typeof ctx.window.DownloadEngine === 'function';
  check('window.StreamDownloader 已定义（无顶层重名冲突）', hasStream, `actual=${typeof ctx.window.StreamDownloader}`);
  check('window.DownloadEngine 已定义', hasEngine, `actual=${typeof ctx.window.DownloadEngine}`);
} catch (e) {
  console.log(`FAIL  多脚本顺序加载 :: ${e.name}: ${e.message}`);
  failed++;
}

if (failed > 0) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过：多脚本加载无顶层重名冲突');