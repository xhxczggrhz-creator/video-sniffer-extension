// repro2: 深挖 moof 结构——每个 traf 的 trackId/样本数/时长和/字节和
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
  for (const p of all) t.push(new Uint8Array(p));
  try { const fp = t.flush(); if (fp?.then) await fp; } catch {}
  await new Promise(r => setTimeout(r, 500));

  // moov 轨信息
  const initBoxes = parseBoxes(init);
  const moov = initBoxes.find(b => b.type === 'moov');
  const moovContent = init.subarray(moov.offset + 8, moov.offset + moov.size);
  for (const trak of parseBoxes(moovContent).filter(b => b.type === 'trak')) {
    const tc = moovContent.subarray(trak.offset + 8, trak.offset + trak.size);
    const mdia = parseBoxes(tc).find(b => b.type === 'mdia');
    const mc = tc.subarray(mdia.offset + 8, mdia.offset + mdia.size);
    const mdhd = parseBoxes(mc).find(b => b.type === 'mdhd');
    const tkhd = parseBoxes(tc).find(b => b.type === 'tkhd');
    const trackId = readU32(tc, tkhd.offset + 8 + 20);
    const tts = readU32(mc, mdhd.offset + 8 + 12);
    console.log(`moov trak: trackId=${trackId} timescale=${tts}`);
  }

  // 每个 combined segment 的 moof 明细
  let segIdx = 0;
  for (const segData of combined) {
    const boxes = parseBoxes(segData);
    for (const moof of boxes.filter(b => b.type === 'moof')) {
      const mc = segData.subarray(moof.offset + 8, moof.offset + moof.size);
      for (const traf of parseBoxes(mc).filter(b => b.type === 'traf')) {
        const tc = mc.subarray(traf.offset + 8, traf.offset + traf.size);
        const tfhd = parseBoxes(tc).find(b => b.type === 'tfhd');
        const trun = parseBoxes(tc).find(b => b.type === 'trun');
        if (!tfhd || !trun) continue;
        const tfhdRaw = tc.subarray(tfhd.offset, tfhd.offset + tfhd.size);
        const trackId = readU32(tfhdRaw, 12);
        const trunRaw = tc.subarray(trun.offset, trun.offset + trun.size);
        const flags = readU32(trunRaw, 8) & 0xFFFFFF;
        const count = readU32(trunRaw, 12);
        let p = 16;
        if (flags & 0x000001) p += 4;
        if (flags & 0x000004) p += 4;
        let durSum = 0, sizeSum = 0;
        for (let s = 0; s < count; s++) {
          if (flags & 0x000100) { durSum += readU32(trunRaw, p); p += 4; }
          if (flags & 0x000200) { sizeSum += readU32(trunRaw, p); p += 4; }
          if (flags & 0x000400) p += 4;
          if (flags & 0x000800) p += 4;
        }
        console.log(`seg${segIdx} moof traf: trackId=${trackId} samples=${count} durSum=${durSum} sizeSum=${sizeSum}`);
      }
    }
    const mdat = boxes.find(b => b.type === 'mdat');
    if (mdat) console.log(`seg${segIdx} mdat: ${mdat.size - 8} bytes`);
    segIdx++;
  }
})();
