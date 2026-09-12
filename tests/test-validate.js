// 回归测试：内容校验 _validateMagic 的拦截与识别逻辑
const fs = require('fs');
const path = require('path');
// i18n 运行时先行加载（等价于 download.html 里 lib/i18n.js 排在最前的 <script>）：
// 下面用 new Function 加载的 download-engine.js 里 t() 才能拿到 zh_CN 文案。
// Node 下 lib/i18n.js 直接读 _locales/zh_CN/messages.json，因此本测试同时
// 校验了该语言包中内容校验相关键是否存在。
require('../lib/i18n.js');
// O-6 搬入 tests/ 子目录后源码路径相对项目根（兼容从项目根或 tests/ 目录运行）
const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'download-engine.js'), 'utf8');
const DownloadEngine = new Function(src + '\nreturn DownloadEngine;')();

const bytes = (strOrArr) => {
  if (typeof strOrArr === 'string') return Uint8Array.from(strOrArr, c => c.charCodeAt(0));
  return Uint8Array.from(strOrArr);
};

let pass = 0, fail = 0;
async function expect(label, fn, check) {
  try {
    const r = await fn();
    const ok = check(r);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(r)}`}`);
    ok ? pass++ : fail++;
  } catch (e) {
    const ok = check(null, e);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  → ${e.name}: ${e.message}`);
    ok ? pass++ : fail++;
  }
}

(async () => {
  // 1. woff2 字体 → 拦截
  await expect('woff2 字体拦截', () => {
    const e = new DownloadEngine({ url: 'https://x/v.mp4' });
    e._validateMagic(bytes('wOF2xxxx'));
    return null;
  }, (r, e) => e?.name === 'ContentError' && e.message.includes('字体'));

  // 2. HTML → 拦截
  await expect('HTML 拦截', () => {
    const e = new DownloadEngine({ url: 'https://x/v.mp4' });
    e._validateMagic(bytes('<!DOCTYPE'));
    return null;
  }, (r, e) => e?.name === 'ContentError' && e.message.includes('HTML'));

  // 3. JSON → 拦截
  await expect('JSON 拦截', () => {
    const e = new DownloadEngine({ url: 'https://x/v.mp4' });
    e._validateMagic(bytes('{"code":-404'));
    return null;
  }, (r, e) => e?.name === 'ContentError' && e.message.includes('JSON'));

  // 4. B站 m4s 真实头（ftyp iso5）→ 识别 mp4
  await expect('B站 m4s ftyp 识别 mp4', () => {
    const e = new DownloadEngine({ url: 'https://x/v.m4s' });
    e._validateMagic(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x35]));
    return e._detectedContainer;
  }, c => c === 'mp4');

  // 5. M4A 音频轨 → 识别 m4a
  await expect('M4A 音频轨识别', () => {
    const e = new DownloadEngine({ url: 'https://x/a.m4a' });
    e._validateMagic(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]));
    return e._detectedContainer;
  }, c => c === 'm4a');

  // 6. webm EBML → 识别 webm
  await expect('EBML 识别 webm', () => {
    const e = new DownloadEngine({ url: 'https://x/v.mp4' });
    e._validateMagic(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0xb0]));
    return e._detectedContainer;
  }, c => c === 'webm');

  // 7. TS 同步字节 → 识别 ts
  await expect('TS 同步字节识别', () => {
    const e = new DownloadEngine({ url: 'https://x/v.ts' });
    e._validateMagic(Uint8Array.from([0x47, 0x40, 0x11, 0x10]));
    return e._detectedContainer;
  }, c => c === 'ts');

  // 8. saveFile 扩展名修正（m4s→mp4）
  await expect('m4s 文件名修正为 mp4', async () => {
    const e = new DownloadEngine({ url: 'https://x/v.m4s', fileName: '视频（视频轨·无声）.m4s' });
    e._detectedContainer = 'mp4';
    e.anchorDownload = () => {};
    global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    global.Blob = class {};
    await e.saveFile({});
    return e.fileName;
  }, n => /\.mp4$/.test(n));

  // 9. 未知格式 → 放行不报错
  await expect('未知格式放行', () => {
    const e = new DownloadEngine({ url: 'https://x/v.bin' });
    e._validateMagic(bytes('\x00\x01\x02\x03'));
    return 'ok';
  }, r => r === 'ok');

  // 10. 空数据 → 放行
  await expect('空数据放行', () => {
    const e = new DownloadEngine({ url: 'https://x/v.mp4' });
    e._validateMagic(null);
    e._validateMagic(new Uint8Array(2));
    return 'ok';
  }, r => r === 'ok');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
