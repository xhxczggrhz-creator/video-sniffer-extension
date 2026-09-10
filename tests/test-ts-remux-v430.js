// test-ts-remux-v430.js
// v4.3.0 TS→MP4 转封装专项回归：
//   1. 环境：以浏览器全局分支加载 mux.js（lib/ts-mux.min.js，Apache-2.0），
//      与 mp4-merger.js / ts-remux.js（IIFE → window.__VideoSniffer*__）
//   2. 端到端：拉取公开 HLS 测试流（mux.dev，H.264+AAC TS 分片），
//      拼接后经 transmuxTsToMp4 转封装，校验产物为「标准 MP4」：
//      ftyp 起始 / 含 moov+mdat / 无 moof / 含 avc1+mp4a 双轨 / 时长 > 0
//   3. 错误路径：垃圾数据与空数据返回 { error } 而非抛异常
//   4. 静态：download.html 脚本引入 / stream-downloader 钩子与扩展名逻辑 /
//      download.js 状态文案
// 运行：node test-ts-remux-v430.js（需网络拉取测试分片）

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, ok, detail) {
  if (ok) { console.log(`PASS  ${name}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

// ---- 浏览器环境 shim：三个 lib 均按 <script> 方式加载 ----
globalThis.window = globalThis;

function loadAsBrowserScript(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  // 抹掉 CommonJS/AMD 环境特征，走 UMD 全局分支（与 <script src> 等价）
  const load = new Function('module', 'exports', 'define', code);
  load(undefined, undefined, undefined);
}

loadAsBrowserScript('lib/ts-mux.min.js');
loadAsBrowserScript('lib/mp4-merger.js');
loadAsBrowserScript('lib/ts-remux.js');

test('【环境】muxjs 全局可用（mp4.Transmuxer）',
  !!(globalThis.muxjs?.mp4?.Transmuxer));
test('【环境】__VideoSnifferMerger__ 可用',
  typeof globalThis.window.__VideoSnifferMerger__?.convertSingle === 'function' &&
  typeof globalThis.window.__VideoSnifferMerger__?.mergeAvToMp4 === 'function');
const remux = globalThis.window.__VideoSnifferTsRemux__;
test('【环境】__VideoSnifferTsRemux__ 可用',
  typeof remux?.transmuxTsToMp4 === 'function' && remux.REMUX_MAX_BYTES > 0);

// ---- MP4 box 解析（校验产物结构）----
function readU32(d, o) {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | (d[o + 3]) ) >>> 0;
}
function parseBoxes(data) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= data.length) {
    const size = readU32(data, off);
    const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
    if (size < 8 || off + size > data.length) break;
    boxes.push({ type, offset: off, size });
    off += size;
  }
  return boxes;
}
function findBox(data, type) {
  return parseBoxes(data).find(b => b.type === type) || null;
}
function hasBytes(hay, needle) {
  // Uint8Array.indexOf 只支持单元素查找（传 Buffer 会被转成 NaN），
  // 必须逐字节子序列搜索
  const n = Buffer.from(needle, 'latin1');
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (hay[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ---- 1. 端到端：真实 HLS TS 流 → 标准 MP4 ----
(async () => {
  const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  let tsBlob = null;
  try {
    const masterText = await (await fetch(MASTER)).text();
    // 取最低码率的媒体清单（分片小、下载快）
    const mediaList = masterText.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => new URL(l.trim(), MASTER).href)
      .pop();
    const mediaText = await (await fetch(mediaList)).text();
    const segUrls = mediaText.split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => new URL(l.trim(), mediaList).href)
      .slice(0, 5);
    const parts = [];
    for (const u of segUrls) {
      const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
      parts.push(buf);
    }
    tsBlob = new Blob(parts);
    console.log(`       测试素材：${segUrls.length} 个 TS 分片，共 ${(tsBlob.size / 1048576).toFixed(2)}MB`);
  } catch (e) {
    console.warn('       [跳过端到端] 测试流不可达：', e?.message);
  }

  if (tsBlob) {
    test('【素材】TS 分片拉取成功', tsBlob.size > 10000, `size=${tsBlob.size}`);

    const r = await remux.transmuxTsToMp4(tsBlob);
    test('【端到端】转封装成功（无 error）', !!(r && r.blob && !r.error), r?.error);

    if (r && r.blob) {
      const out = new Uint8Array(await r.blob.arrayBuffer());

      // 体积守恒：remux 不重编码，输出应 ≈ 输入
      test('【端到端】体积守恒（≥输入 60%）',
        r.blob.size >= tsBlob.size * 0.6,
        `out=${r.blob.size} in=${tsBlob.size}`);

      const boxes = parseBoxes(out);
      const types = boxes.map(b => b.type);
      test('【结构】ftyp 起始', types[0] === 'ftyp', types.join(','));
      test('【结构】含 moov + mdat（标准 MP4）',
        types.includes('moov') && types.includes('mdat'));
      test('【结构】无 moof（非碎片化，iPhone 相册/文件 App 兼容）',
        !types.includes('moof'));

      // 双轨：avc1 视频 + mp4a 音频
      const moov = boxes.find(b => b.type === 'moov');
      const moovRaw = out.subarray(moov.offset, moov.offset + moov.size);
      test('【轨道】含 H.264 视频轨（avc1）', hasBytes(moovRaw, 'avc1'));
      test('【轨道】含 AAC 音频轨（mp4a）', hasBytes(moovRaw, 'mp4a'));

      // mvhd 时长：5 个分片 × ~10s → 应在 30~70s 区间（v4.3.0 前把轨道时基
      // tick 原样写入 mvhd，50s 视频会显示 4500s）
      const moovContent = moovRaw.subarray(8);
      const mvhd = findBox(moovContent, 'mvhd');
      let duration = 0, timescale = 0;
      if (mvhd) {
        timescale = readU32(moovContent, mvhd.offset + 8 + 12);
        duration = readU32(moovContent, mvhd.offset + 8 + 16);
      }
      const durationSec = timescale ? duration / timescale : 0;
      test('【时长】mvhd duration 在 30~70s 区间（5×10s 分片）',
        durationSec >= 30 && durationSec <= 70,
        `duration=${duration} timescale=${timescale} => ${durationSec.toFixed(1)}s`);

      // 各轨时长：视频/音频应基本一致（差异 <10%）。轨道互换（v4.3.0 修复的
      // tkhd 匹配缺陷）会让两轨时长按错误时基换算，比例约 44100/90000≈0.49
      const trakDurs = [];
      for (const trak of parseBoxes(moovContent).filter(b => b.type === 'trak')) {
        const trakContent = moovContent.subarray(trak.offset + 8, trak.offset + trak.size);
        const mdia = parseBoxes(trakContent).find(b => b.type === 'mdia');
        const mdiaContent = trakContent.subarray(mdia.offset + 8, mdia.offset + mdia.size);
        const hdlr = parseBoxes(mdiaContent).find(b => b.type === 'hdlr');
        const handler = hdlr ? String.fromCharCode(
          mdiaContent[hdlr.offset + 16], mdiaContent[hdlr.offset + 17],
          mdiaContent[hdlr.offset + 18], mdiaContent[hdlr.offset + 19]) : '?';
        const mdhd = parseBoxes(mdiaContent).find(b => b.type === 'mdhd');
        const ts = readU32(mdiaContent, mdhd.offset + 8 + 12);
        const dur = readU32(mdiaContent, mdhd.offset + 8 + 16);
        trakDurs.push({ handler, sec: ts ? dur / ts : 0 });
      }
      const vTrak = trakDurs.find(t => t.handler === 'vide');
      const aTrak = trakDurs.find(t => t.handler === 'soun');
      test('【时长】视频/音频轨齐全（vide + soun）', !!vTrak && !!aTrak,
        trakDurs.map(t => `${t.handler}:${t.sec.toFixed(1)}s`).join(' '));
      if (vTrak && aTrak) {
        const ratio = Math.min(vTrak.sec, aTrak.sec) / Math.max(vTrak.sec, aTrak.sec);
        test('【时长】视频/音频轨时长一致（差异 <10%，防轨道互换）',
          ratio >= 0.9,
          `video=${vTrak.sec.toFixed(1)}s audio=${aTrak.sec.toFixed(1)}s ratio=${ratio.toFixed(3)}`);
      }

      console.log(`       产物：${(r.blob.size / 1048576).toFixed(2)}MB，时长 ${durationSec.toFixed(1)}s` +
        (vTrak && aTrak ? `（视频 ${vTrak.sec.toFixed(1)}s / 音频 ${aTrak.sec.toFixed(1)}s）` : ''));
    }
  }

  // ---- 2. 错误路径 ----
  const garbage = await remux.transmuxTsToMp4(new Blob([Buffer.alloc(64 * 188, 0x00)]));
  test('【错误】垃圾数据返回 error（不抛异常）',
    !garbage?.blob && typeof garbage?.error === 'string', garbage?.error);
  const empty = await remux.transmuxTsToMp4(new Blob([]));
  test('【错误】空数据返回 error', !empty?.blob && typeof empty?.error === 'string');

  // ---- 3. 静态约定 ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'download-page/download.html'), 'utf8');
  test('【静态】download.html 引入 ts-mux.min.js + ts-remux.js',
    html.includes('lib/ts-mux.min.js') && html.includes('lib/ts-remux.js'));

  const sd = fs.readFileSync(path.join(__dirname, '..', 'lib/stream-downloader.js'), 'utf8');
  test('【静态】stream-downloader 收尾接入 remuxTsToMp4',
    /const finalFile = await this\.remuxTsToMp4\(file\);/.test(sd));
  test('【静态】saveFile 按 _remuxedToMp4 决定 .mp4 扩展名',
    /const isMp4 = this\.isFMP4 \|\| this\._remuxedToMp4;/.test(sd));

  const dj = fs.readFileSync(path.join(__dirname, '..', 'download-page/download.js'), 'utf8');
  test('【静态】download.js 含 converting 状态文案', dj.includes("'converting'"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
