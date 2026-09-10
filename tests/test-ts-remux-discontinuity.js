// test-ts-remux-discontinuity.js
// v4.3.6 回归：多流拼接（片头广告 + 正片，PTS 基线各自从 0 起）的 TS → MP4
// 转封装。修复前症状：视频轨负时长样本（PTS 回跳）按 u32 写入 stts →
//   mvhd 总时长回绕成只剩广告时长（进度条只到广告、无法拖动/快进）；
//   单条 ~2^32 时长样本让 iPhone 文件 App 拒播。
// 修复后期望：视频/音频轨时长一致且覆盖全部样本（广告+正片总时长）。
// 素材：mux.dev 主清单取最低/最高两个画质变体各 3 分片拼接，模拟广告+正片。
// 运行：node tests/test-ts-remux-discontinuity.js（需网络拉取测试分片）

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, ok, detail) {
  if (ok) { console.log(`PASS  ${name}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

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
  let tsBlob = null;
  try {
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
    tsBlob = new Blob([...ad, ...main]);
    console.log(`       素材：广告 3 段 + 正片 3 段（不同画质变体），共 ${(tsBlob.size / 1048576).toFixed(1)}MB`);
  } catch (e) {
    console.warn('       [跳过端到端] 测试流不可达：', e?.message);
  }

  if (tsBlob) {
    const r = await remux.transmuxTsToMp4(tsBlob);
    test('【端到端】拼接流转封装成功', !!(r && r.blob && !r.error), r?.error);
    if (r && r.blob) {
      const out = new Uint8Array(await r.blob.arrayBuffer());
      test('【端到端】体积守恒（≥输入 60%）', r.blob.size >= tsBlob.size * 0.6,
        `out=${r.blob.size} in=${tsBlob.size}`);
      // v4.3.6：durationSec 透传（下载页日志据此显示总时长，验证负时长修复）
      test('【端到端】durationSec 透传（≈60s，广告+正片）',
        typeof r.durationSec === 'number' && r.durationSec > 55 && r.durationSec < 65,
        `durationSec=${r.durationSec}`);

      const boxes = parseBoxes(out);
      test('【结构】ftyp+moov+mdat 标准结构、无 moof',
        boxes[0]?.type === 'ftyp' && boxes.some(b => b.type === 'moov') &&
        boxes.some(b => b.type === 'mdat') && !boxes.some(b => b.type === 'moof'),
        boxes.map(b => b.type).join(','));

      const moov = boxes.find(b => b.type === 'moov');
      const moovContent = out.subarray(moov.offset + 8, moov.offset + moov.size);
      const mvhd = parseBoxes(moovContent).find(b => b.type === 'mvhd');
      const mts = readU32(moovContent, mvhd.offset + 8 + 12);
      const mdur = readU32(moovContent, mvhd.offset + 8 + 16);
      const mvhdSec = mdur / mts;

      const trakSecs = {};
      for (const trak of parseBoxes(moovContent).filter(b => b.type === 'trak')) {
        const trakContent = moovContent.subarray(trak.offset + 8, trak.offset + trak.size);
        const mdia = parseBoxes(trakContent).find(b => b.type === 'mdia');
        const mdiaContent = trakContent.subarray(mdia.offset + 8, mdia.offset + mdia.size);
        const hdlr = parseBoxes(mdiaContent).find(b => b.type === 'hdlr');
        const handler = hdlr ? String.fromCharCode(
          mdiaContent[hdlr.offset + 16], mdiaContent[hdlr.offset + 17],
          mdiaContent[hdlr.offset + 18], mdiaContent[hdlr.offset + 19]) : '?';
        const mdhd = parseBoxes(mdiaContent).find(b => b.type === 'mdhd');
        const tts = readU32(mdiaContent, mdhd.offset + 8 + 12);
        const tdur = readU32(mdiaContent, mdhd.offset + 8 + 16);
        trakSecs[handler] = tdur / tts;

        // stts 无天文数字时长条目（负时长按 u32 回绕的典型表现 ~2^32）
        const minf = parseBoxes(mdiaContent).find(b => b.type === 'minf');
        if (minf) {
          const minfContent = mdiaContent.subarray(minf.offset + 8, minf.offset + minf.size);
          const stbl = parseBoxes(minfContent).find(b => b.type === 'stbl');
          if (stbl) {
            const stblContent = minfContent.subarray(stbl.offset + 8, stbl.offset + stbl.size);
            const stts = parseBoxes(stblContent).find(b => b.type === 'stts');
            if (stts) {
              const sttsRaw = stblContent.subarray(stts.offset, stts.offset + stts.size);
              const entryCount = readU32(sttsRaw, 12);
              let maxDur = 0;
              for (let i = 0; i < entryCount; i++) {
                const d = readU32(sttsRaw, 16 + i * 8 + 4);
                if (d > maxDur) maxDur = d;
              }
              // 单条时长 > 5 秒（任意常规时基下都远超一帧）即异常
              test(`【stts】${handler} 轨无异常时长条目`,
                maxDur < 5 * tts, `maxDur=${maxDur} timescale=${tts}`);
            }
          }
        }
      }

      test('【时长】mvhd 覆盖广告+正片（≈60s）',
        mvhdSec >= 50 && mvhdSec <= 70, `mvhd=${mvhdSec.toFixed(1)}s`);
      test('【时长】视频/音频轨齐全', 'vide' in trakSecs && 'soun' in trakSecs,
        JSON.stringify(trakSecs));
      if ('vide' in trakSecs && 'soun' in trakSecs) {
        const ratio = Math.min(trakSecs.vide, trakSecs.soun) / Math.max(trakSecs.vide, trakSecs.soun);
        test('【时长】视频/音频轨一致（差异 <15%，负时长已修复）',
          ratio >= 0.85,
          `video=${trakSecs.vide.toFixed(1)}s audio=${trakSecs.soun.toFixed(1)}s`);
      }
      console.log(`       产物：mvhd ${mvhdSec.toFixed(1)}s（视频 ${trakSecs.vide?.toFixed(1)}s / 音频 ${trakSecs.soun?.toFixed(1)}s）`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
