// make-broken-mp4.js
// 复现用户手中的坏 MP4（v4.3.6 修复前的产物）：
//   广告+正片拼接 → mux.js 转封装 → 模拟旧版 merger 的两个病灶：
//   1. 切换点样本时长按无符号 u32 写入 stts（≈2^32 的巨大条目）
//   2. mvhd/tkhd 总时长 u32 回绕（只剩广告时长）
// 产出：tests/tmp-broken/broken.mp4，供 ffmpeg 修复命令实测
const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
function loadAsBrowserScript(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  new Function('module', 'exports', 'define', code)(undefined, undefined, undefined);
}
loadAsBrowserScript('lib/ts-mux.min.js');
loadAsBrowserScript('lib/mp4-merger.js');
loadAsBrowserScript('lib/ts-remux.js');
const remux = globalThis.window.__VideoSnifferTsRemux__;

function readU32(d, o) {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}
function writeU32(d, o, v) {
  d[o] = (v >>> 24) & 0xFF; d[o + 1] = (v >>> 16) & 0xFF;
  d[o + 2] = (v >>> 8) & 0xFF; d[o + 3] = v & 0xFF;
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
function findAll(data, type) { return parseBoxes(data).filter(b => b.type === type); }

(async () => {
  const MASTER = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const masterText = await (await fetch(MASTER)).text();
  const variants = masterText.split('\n').filter(l => l.trim() && !l.startsWith('#'))
    .map(l => new URL(l.trim(), MASTER).href);
  async function grab(url, n) {
    const text = await (await fetch(url)).text();
    const segs = text.split('\n').filter(l => l.trim() && !l.startsWith('#'))
      .map(l => new URL(l.trim(), url).href).slice(0, n);
    const parts = [];
    for (const s of segs) parts.push(Buffer.from(await (await fetch(s)).arrayBuffer()));
    return parts;
  }
  const ad = await grab(variants[0], 3);
  const main = await grab(variants[variants.length - 1], 3);
  const tsBlob = new Blob([...ad, ...main]);
  console.log(`素材：广告 3 段 + 正片 3 段，共 ${(tsBlob.size / 1048576).toFixed(1)}MB`);

  const r = await remux.transmuxTsToMp4(tsBlob);
  if (!r || !r.blob) { console.error('转封装失败:', r?.error); process.exit(1); }
  console.log(`转封装产物：${(r.blob.size / 1048576).toFixed(1)}MB，时长 ${r.durationSec.toFixed(1)}s（修复版）`);

  // ---- 注入旧版病灶，得到与用户手中一致的坏文件 ----
  const mp4 = Buffer.from(await r.blob.arrayBuffer());

  // 1) mvhd.duration 回绕成“只剩广告”（广告 3 段 ≈ 30s）
  const moov = parseBoxes(mp4).find(b => b.type === 'moov');
  const moovC = mp4.subarray(moov.offset + 8, moov.offset + moov.size);
  const mvhd = parseBoxes(moovC).find(b => b.type === 'mvhd');
  const mvhdRaw = moovC.subarray(mvhd.offset, mvhd.offset + mvhd.size);
  const mvhdTs = readU32(mvhdRaw, 20);
  const AD_ONLY = Math.round(30 * mvhdTs); // 30s 广告
  writeU32(mvhdRaw, 24, AD_ONLY); // version 0 duration @ offset 24

  // 2) 每个 trak 的 stbl/stts 首条时长改为 ≈2^32（模拟负时长按 u32 写入）
  for (const trak of findAll(moovC, 'trak')) {
    const trakC = moovC.subarray(trak.offset + 8, trak.offset + trak.size);
    const mdia = parseBoxes(trakC).find(b => b.type === 'mdia');
    const mdiaC = trakC.subarray(mdia.offset + 8, mdia.offset + mdia.size);
    const mdhd = parseBoxes(mdiaC).find(b => b.type === 'mdhd');
    const mdhdRaw = mdiaC.subarray(mdhd.offset, mdhd.offset + mdhd.size);
    const tkTs = readU32(mdhdRaw, 20);

    const minf = parseBoxes(mdiaC).find(b => b.type === 'minf');
    const minfC = mdiaC.subarray(minf.offset + 8, minf.offset + minf.size);
    const stbl = parseBoxes(minfC).find(b => b.type === 'stbl');
    const stblC = minfC.subarray(stbl.offset + 8, stbl.offset + stbl.size);
    const stts = parseBoxes(stblC).find(b => b.type === 'stts');
    const sttsRaw = stblC.subarray(stts.offset, stts.offset + stts.size);
    // 遍历 run-length 条目（每条 = sample_count + sample_duration），
    // 找累计时长过半（≈30s，广告/正片切换点）的那条注入巨大时长
    const entryCount = readU32(sttsRaw, 12);
    let total = 0;
    for (let i = 0; i < entryCount; i++) total += readU32(sttsRaw, 16 + i * 8) * readU32(sttsRaw, 16 + i * 8 + 4);
    let acc = 0, hit = 0;
    for (let i = 0; i < entryCount; i++) {
      acc += readU32(sttsRaw, 16 + i * 8) * readU32(sttsRaw, 16 + i * 8 + 4);
      if (acc >= total / 2) { hit = i; break; }
    }
    const oldDur = readU32(sttsRaw, 16 + hit * 8);
    writeU32(sttsRaw, 16 + hit * 8, 0xFFF00000); // ≈4.29e9 ticks 的巨大时长
    // tkhd.duration 同步回绕（tkhd 布局：duration 在 box 内偏移 32）
    const tkhd = parseBoxes(trakC).find(b => b.type === 'tkhd');
    const tkhdRaw = trakC.subarray(tkhd.offset, tkhd.offset + tkhd.size);
    writeU32(tkhdRaw, 32, Math.round(30 * tkTs));
    console.log(`trak(ts=${tkTs}) stts 第 ${hit}/${entryCount} 条（切换点）${oldDur} → 0xFFF00000，tkhd → 30s`);
  }

  const outDir = path.join(__dirname, 'tmp-broken');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'broken.mp4'), mp4);
  console.log(`已产出：${path.join(outDir, 'broken.mp4')}（${(mp4.length / 1048576).toFixed(1)}MB）`);
  console.log('病症：mvhd=30s（只剩广告）/ stts 含 ≈2^32 巨大条目 / tkhd=30s');
})();
