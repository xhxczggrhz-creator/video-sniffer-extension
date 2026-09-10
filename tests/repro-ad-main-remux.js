// repro-ad-main-remux.js
// 复现「广告 TS + 正片 TS（不同编码参数）拼接 → 转封装」场景：
// mux.dev 主清单含多画质变体，取两个不同分辨率的媒体清单各 3 个分片拼接，
// 模拟盗版站「开头广告 + 正片」结构。观察：
//   1. mux.js 输出的 data 事件类型与 initSegment 数量
//   2. 产物 mvhd/tkhd 时长是否覆盖全部样本
const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
function loadAsBrowserScript(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const load = new Function('module', 'exports', 'define', code);
  load(undefined, undefined, undefined);
}
loadAsBrowserScript('lib/ts-mux.min.js');
loadAsBrowserScript('lib/mp4-merger.js');
loadAsBrowserScript('lib/ts-remux.js');
const remux = globalThis.window.__VideoSnifferTsRemux__;
const muxjs = globalThis.muxjs;

function readU32(d, o) {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | (d[o + 3])) >>> 0;
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

(async () => {
  const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const masterText = await (await fetch(MASTER)).text();
  const variantLines = masterText.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  // 全部变体（不同分辨率），取第一个与最后一个分别当「广告」和「正片」
  const variantUrls = variantLines.map(l => new URL(l.trim(), MASTER).href);
  console.log('变体清单数:', variantUrls.length);

  async function grab(url, n) {
    const text = await (await fetch(url)).text();
    const segs = text.split('\n').filter(l => l.trim() && !l.startsWith('#'))
      .map(l => new URL(l.trim(), url).href).slice(0, n);
    const parts = [];
    for (const s of segs) parts.push(Buffer.from(await (await fetch(s)).arrayBuffer()));
    return parts;
  }

  const adParts = await grab(variantUrls[0], 3);       // 「广告」= 低画质变体
  const mainParts = await grab(variantUrls[variantUrls.length - 1], 3); // 「正片」= 高画质变体
  const all = [...adParts, ...mainParts];
  const tsBlob = new Blob(all);
  console.log(`素材：广告 ${adParts.length} 段 + 正片 ${mainParts.length} 段，共 ${(tsBlob.size / 1048576).toFixed(1)}MB`);

  // ---- 直接监听 mux.js 原始行为 ----
  const t = new muxjs.mp4.Transmuxer();
  let evtCount = 0;
  const typeCount = {};
  const initSegs = [];
  t.on('data', (seg) => {
    evtCount++;
    typeCount[seg.type] = (typeCount[seg.type] || 0) + 1;
    if (seg.initSegment && seg.initSegment.byteLength) initSegs.push(seg.initSegment.length);
  });
  for (const p of all) t.push(new Uint8Array(p));
  try { const fp = t.flush(); if (fp && fp.then) await fp; } catch {}
  await new Promise(r => setTimeout(r, 500));
  console.log('mux.js 原始输出: data 事件数=', evtCount,
    '类型分布=', JSON.stringify(typeCount),
    'initSegment 事件数=', initSegs.length, '长度=', initSegs.join(','));

  // ---- 走产品管线 ----
  const r = await remux.transmuxTsToMp4(tsBlob);
  if (!r.blob) { console.log('产品管线结果: error =', r.error); process.exit(0); }
  console.log(`产品管线结果: ${(r.blob.size / 1048576).toFixed(1)}MB (输入 ${(tsBlob.size / 1048576).toFixed(1)}MB)`);

  const out = new Uint8Array(await r.blob.arrayBuffer());
  const top = parseBoxes(out);
  console.log('顶层 box:', top.map(b => b.type).join(','));
  const moov = top.find(b => b.type === 'moov');
  if (!moov) { console.log('无 moov（fMP4 降级产物）'); process.exit(0); }
  const moovContent = out.subarray(moov.offset + 8, moov.offset + moov.size);
  const mvhd = parseBoxes(moovContent).find(b => b.type === 'mvhd');
  const ts = readU32(moovContent, mvhd.offset + 8 + 12);
  const dur = readU32(moovContent, mvhd.offset + 8 + 16);
  console.log(`mvhd: timescale=${ts} duration=${dur} => ${(dur / ts).toFixed(1)}s`);
  for (const trak of parseBoxes(moovContent).filter(b => b.type === 'trak')) {
    const trakContent = moovContent.subarray(trak.offset + 8, trak.offset + trak.size);
    const mdia = parseBoxes(trakContent).find(b => b.type === 'mdia');
    const mdiaContent = trakContent.subarray(mdia.offset + 8, mdia.offset + mdia.size);
    const mdhd = parseBoxes(mdiaContent).find(b => b.type === 'mdhd');
    const tts = readU32(mdiaContent, mdhd.offset + 8 + 12);
    const tdur = readU32(mdiaContent, mdhd.offset + 8 + 16);
    console.log(`trak: timescale=${tts} duration=${tdur} => ${(tdur / tts).toFixed(1)}s`);
  }
  console.log('（期望：两轨均 ≈ 60s——3+3 个 ~10s 分片）');
})();
