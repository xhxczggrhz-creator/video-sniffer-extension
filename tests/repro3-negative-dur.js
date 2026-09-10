// repro3: 正确等待 'done' 事件，dump 全部 trun 样本时长，验证「负时长样本」理论
const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
function loadAsBrowserScript(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  new Function('module', 'exports', 'define', code)(undefined, undefined, undefined);
}
loadAsBrowserScript('lib/ts-mux.min.js');
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
  const all = [...ad, ...main];

  const t = new muxjs.mp4.Transmuxer();
  const combined = [];
  let init = null;
  t.on('data', (seg) => {
    if (seg.initSegment?.byteLength) init = seg.initSegment;
    if (seg.data?.byteLength) combined.push(seg.data);
  });
  const donePromise = new Promise((resolve) => {
    t.on('done', () => resolve());
    setTimeout(resolve, 30000);
  });
  for (const p of all) t.push(new Uint8Array(p));
  const fp = t.flush();
  if (fp && fp.then) await fp.catch(() => {});
  await donePromise;

  console.log('combined 段数:', combined.length,
    '总字节:', combined.reduce((s, d) => s + d.length, 0));

  // 汇总每个 trackId 的样本时长（带符号视角）
  const trackDurs = new Map(); // trackId -> {count, sumSigned, negatives: [{idx, val}]}
  let segIdx = 0;
  for (const segData of combined) {
    for (const moof of parseBoxes(segData).filter(b => b.type === 'moof')) {
      const mc = segData.subarray(moof.offset + 8, moof.offset + moof.size);
      for (const traf of parseBoxes(mc).filter(b => b.type === 'traf')) {
        const tc = mc.subarray(traf.offset + 8, traf.offset + traf.size);
        const tfhd = parseBoxes(tc).find(b => b.type === 'tfhd');
        const trun = parseBoxes(tc).find(b => b.type === 'trun');
        const tfdt = parseBoxes(tc).find(b => b.type === 'tfdt');
        if (!tfhd || !trun) continue;
        const tfhdRaw = tc.subarray(tfhd.offset, tfhd.offset + tfhd.size);
        const trackId = readU32(tfhdRaw, 12);
        let tfdtVal = null;
        if (tfdt) {
          const tr = tc.subarray(tfdt.offset, tfdt.offset + tfdt.size);
          tfdtVal = tr[8] === 1
            ? tr[9] * 2 ** 32 + readU32(tr, 13)  // 近似（高 32 位*2^32）
            : readU32(tr, 12);
        }
        const trunRaw = tc.subarray(trun.offset, trun.offset + trun.size);
        const flags = readU32(trunRaw, 8) & 0xFFFFFF;
        const count = readU32(trunRaw, 12);
        let p = 16;
        if (flags & 0x000001) p += 4;
        if (flags & 0x000004) p += 4;
        if (!trackDurs.has(trackId)) trackDurs.set(trackId, { count: 0, sumSigned: 0, negatives: [], tfdts: [] });
        const rec = trackDurs.get(trackId);
        rec.tfdts.push(tfdtVal);
        for (let s = 0; s < count; s++) {
          let dur = 0;
          if (flags & 0x000100) { dur = readU32(trunRaw, p) | 0; p += 4; }
          if (flags & 0x000200) p += 4;
          if (flags & 0x000400) p += 4;
          if (flags & 0x000800) p += 4;
          rec.count++;
          rec.sumSigned += dur;
          if (dur < 0) rec.negatives.push({ seg: segIdx, sample: s, val: dur });
        }
      }
    }
    segIdx++;
  }
  for (const [trackId, rec] of trackDurs) {
    console.log(`trackId=${trackId}: samples=${rec.count} sumSigned=${rec.sumSigned} ` +
      `negatives=${rec.negatives.length} tfdts=${JSON.stringify(rec.tfdts)}`);
    rec.negatives.slice(0, 5).forEach(n => console.log(`  负时长样本: seg${n.seg} #${n.sample} = ${n.val}`));
  }
})();
