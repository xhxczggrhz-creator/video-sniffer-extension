/**
 * lib/mp4-merger.js 离线验证：
 * 构造合成 fMP4 视频轨 + 音频轨（模拟腾讯/爱奇艺 MSE 捕获数据），
 * 调用合并器，校验输出标准 MP4 的 box 结构、样本偏移、时长、轨 ID。
 * 运行：node test-merger.js
 */
'use strict';

// ---- 加载合并器（浏览器环境桩）----
global.window = {};
require('../lib/mp4-merger.js');
const merger = global.window.__VideoSnifferMerger__;
if (!merger || typeof merger.mergeAvToMp4 !== 'function') {
  console.error('FAIL: merger 未正确暴露');
  process.exit(1);
}

// ---- box 构造工具 ----
function readU32(d, o) { return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0; }
function box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const b = new Uint8Array(size);
  writeU32(b, 0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const p of parts) { b.set(p, off); off += p.length; }
  return b;
}
function writeU32(d, o, v) {
  d[o] = (v >>> 24) & 0xFF; d[o + 1] = (v >>> 16) & 0xFF;
  d[o + 2] = (v >>> 8) & 0xFF; d[o + 3] = v & 0xFF;
}
function fullbox(type, version, flags, ...parts) {
  const vf = new Uint8Array(4);
  writeU32(vf, 0, ((version & 0xFF) << 24) | (flags & 0xFFFFFF));
  return box(type, vf, ...parts);
}
function u32(...vals) {
  const b = new Uint8Array(vals.length * 4);
  vals.forEach((v, i) => writeU32(b, i * 4, v));
  return b;
}
function bytes(n, fill) { const b = new Uint8Array(n); b.fill(fill); return b; }

// ---- 构造合成 fMP4 流 ----
// samples: [{data, duration}]
function buildFmp4({ timescale, trackId, handlerType, sampleDurationDefault, samples, codecBox, mvhdTimescale }) {
  // ftyp
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso2'));

  // stsd（内部随便放一个自造 codec box）
  const entry = codecBox || box(handlerType === 'vide' ? 'avc1' : 'mp4a', bytes(78));
  const stsd = fullbox('stsd', 0, 0, u32(1), entry);
  const stbl = box('stbl', stsd, fullbox('stts', 0, 0, u32(0)), fullbox('stsc', 0, 0, u32(0)), fullbox('stsz', 0, 0, u32(0, 0)), fullbox('stco', 0, 0, u32(0)));
  const vmhdOrSmhd = handlerType === 'vide' ? fullbox('vmhd', 0, 1, bytes(8)) : fullbox('smhd', 0, 0, bytes(4));
  const dinf = box('dinf', fullbox('dref', 0, 0, u32(0)));
  const minf = box('minf', vmhdOrSmhd, dinf, stbl);
  const mdhd = fullbox('mdhd', 0, 0, u32(0, 0, timescale, 0, 0x55C40000));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), new TextEncoder().encode(handlerType), bytes(12), new Uint8Array([0]));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullbox('tkhd', 0, 3, u32(0, 0, trackId, 0, 0), bytes(60));
  const trak = box('trak', tkhd, mdia);
  const mvhd = fullbox('mvhd', 0, 0, u32(0, 0, mvhdTimescale || timescale, 0, 0x00010000), bytes(80));
  const trex = fullbox('trex', 0, 0, u32(trackId, 1, 0, 0, 0));
  const mvex = box('mvex', trex);
  const moov = box('moov', mvhd, trak, mvex);

  // moof/mdat 对（每 3 个样本一个分片）
  const segParts = [];
  const chunkSize = 3;
  for (let i = 0; i < samples.length; i += chunkSize) {
    const chunk = samples.slice(i, i + chunkSize);
    const totalSampleBytes = chunk.reduce((s, x) => s + x.data.length, 0);
    // trun: flags = data_offset(0x1) | duration(0x100) | size(0x200) | flags(0x400)
    const trunFlags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
    const trunBody = [u32(chunk.length)];
    const dataOffsetPlaceholder = new Uint8Array(4); // 稍后回填
    trunBody.push(dataOffsetPlaceholder);
    const perSample = new Uint8Array(chunk.length * 12);
    chunk.forEach((s, j) => {
      writeU32(perSample, j * 12, s.duration);
      writeU32(perSample, j * 12 + 4, s.data.length);
      writeU32(perSample, j * 12 + 8, s.key ? 0x02000000 : 0x01010000); // sync / non-sync 标志
    });
    trunBody.push(perSample);
    const trun = fullbox('trun', 0, trunFlags, ...trunBody);
    const tfhd = fullbox('tfhd', 0, 0x020000, u32(trackId)); // default-base-is-moof
    const traf = box('traf', tfhd, trun);
    const mfhd = fullbox('mfhd', 0, 0, u32(i / chunkSize + 1));
    const moof = box('moof', mfhd, traf);
    // box() 是拷贝语义：构造完成后直接回填 moof 字节中的 data_offset
    // 路径：moof(header8) > mfhd > traf(header8) > tfhd > trun(header8) > verflags(4) count(4) data_offset
    const trafOff = 8 + mfhd.length;
    const tfhdOff = trafOff + 8;              // traf 内：跳过 traf header，tfhd 是第一个子 box
    const trunOff = tfhdOff + tfhd.length;    // trun 紧随 tfhd（在 moof 字节中的绝对位置）
    // trun box 内：header(8) + verflags(4) + count(4) → data_offset 在 +16 处
    writeU32(moof, trunOff + 16, moof.length + 8); // data_offset = moof尺寸 + mdat头
    const mdat = box('mdat', ...chunk.map(s => s.data));
    segParts.push(moof, mdat);
  }

  return concat(ftyp, moov, ...segParts);
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- 解析输出用于断言 ----
function parseBoxes(data) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = readU32(data, offset);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    if (size < 8 || offset + size > data.length) break;
    boxes.push({ type, size, offset });
    offset += size;
  }
  return boxes;
}
function findBoxPath(data, path) {
  let cur = data;
  for (const name of path) {
    const b = parseBoxes(cur).find(x => x.type === name);
    if (!b) return null;
    cur = cur.subarray(b.offset + 8, b.offset + b.size);
  }
  return cur;
}

// ---- 用例 ----
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  PASS:', msg);
  else { console.error('  FAIL:', msg); failures++; }
}

async function blobToU8(blob) {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

(async () => {
  console.log('== 用例1：视频轨 + 音频轨 合并 ==');
  // 视频：30fps，15 帧（2 帧非关键帧），每帧 100 字节
  const vSamples = [];
  for (let i = 0; i < 15; i++) {
    vSamples.push({ data: bytes(100, 0x11 + i), duration: 3000, key: i % 5 === 0 });
  }
  const videoFmp4 = buildFmp4({ timescale: 90000, trackId: 1, handlerType: 'vide', samples: vSamples });

  // 音频：10 帧，每帧 32 字节
  const aSamples = [];
  for (let i = 0; i < 10; i++) {
    aSamples.push({ data: bytes(32, 0xA0 + i), duration: 1024, key: true });
  }
  const audioFmp4 = buildFmp4({ timescale: 48000, trackId: 1, handlerType: 'soun', samples: aSamples });

  const result = merger.mergeAvToMp4(videoFmp4, audioFmp4);
  assert(!result.error, `合并成功（无 error）: ${result.error || ''}`);
  if (result.error) process.exit(1);

  const out = await blobToU8(result.blob);
  const top = parseBoxes(out);
  assert(top.map(b => b.type).join(',') === 'ftyp,moov,mdat,mdat', `顶层结构 = ftyp,moov,mdat,mdat（实际 ${top.map(b => b.type).join(',')}）`);

  const moovContent = out.subarray(top[1].offset + 8, top[1].offset + top[1].size);
  const traks = parseBoxes(moovContent).filter(b => b.type === 'trak');
  assert(traks.length === 2, `moov 含 2 个 trak（实际 ${traks.length}）`);
  assert(!parseBoxes(moovContent).some(b => b.type === 'mvex'), 'mvex 已被移除（标准 MP4 不应有）');

  // 校验视频样本数据完整到达 mdat1
  const vMdat = out.subarray(top[2].offset + 8, top[2].offset + top[2].size);
  assert(vMdat.length === 1500, `视频 mdat = 1500B（实际 ${vMdat.length}）`);
  assert(vMdat[0] === 0x11 && vMdat[1499] === 0x11 + 14, '视频样本字节内容完整');

  const aMdat = out.subarray(top[3].offset + 8, top[3].offset + top[3].size);
  assert(aMdat.length === 320, `音频 mdat = 320B（实际 ${aMdat.length}）`);

  // 校验视频 trak 的 stco 指向 mdat1 载荷、音频 trak stco 指向 mdat2 载荷
  const stcoOf = (trakIdx) => {
    const trakRaw = moovContent.subarray(traks[trakIdx].offset, traks[trakIdx].offset + traks[trakIdx].size);
    const stbl = findBoxPath(trakRaw.subarray(8), ['mdia', 'minf', 'stbl']);
    const stco = parseBoxes(stbl).find(b => b.type === 'stco');
    return readU32(stbl, stco.offset + 16);
  };
  assert(stcoOf(0) === top[2].offset + 8, `视频 stco 指向视频 mdat 载荷（${stcoOf(0)} vs ${top[2].offset + 8}）`);
  assert(stcoOf(1) === top[3].offset + 8, `音频 stco 指向音频 mdat 载荷（${stcoOf(1)} vs ${top[3].offset + 8}）`);

  // 校验样本表
  const stszOf = (trakIdx) => {
    const trakRaw = moovContent.subarray(traks[trakIdx].offset, traks[trakIdx].offset + traks[trakIdx].size);
    const stbl = findBoxPath(trakRaw.subarray(8), ['mdia', 'minf', 'stbl']);
    const stsz = parseBoxes(stbl).find(b => b.type === 'stsz');
    return { count: readU32(stbl, stsz.offset + 16) };
  };
  assert(stszOf(0).count === 15, `视频 stsz 样本数 = 15（实际 ${stszOf(0).count}）`);
  assert(stszOf(1).count === 10, `音频 stsz 样本数 = 10（实际 ${stszOf(1).count}）`);

  // stss：视频有非关键帧 → 应有 stss，音频全关键帧 → 无
  const hasStss = (trakIdx) => {
    const trakRaw = moovContent.subarray(traks[trakIdx].offset, traks[trakIdx].offset + traks[trakIdx].size);
    const stbl = findBoxPath(trakRaw.subarray(8), ['mdia', 'minf', 'stbl']);
    return parseBoxes(stbl).some(b => b.type === 'stss');
  };
  assert(hasStss(0) === true, '视频 trak 生成了 stss（含非关键帧）');
  assert(hasStss(1) === false, '音频 trak 无 stss（全同步）');

  // 时长：视频 15*3000=45000（90000 scale = 0.5s），mdhd/mvhd 已修补
  // findBoxPath 返回的是 mdhd 内容（已跳 8 字节 header）：duration 在内容偏移 16
  const mdhdOf = (trakIdx) => {
    const trakRaw = moovContent.subarray(traks[trakIdx].offset, traks[trakIdx].offset + traks[trakIdx].size);
    return findBoxPath(trakRaw.subarray(8), ['mdia', 'mdhd']);
  };
  assert(readU32(mdhdOf(0), 16) === 45000, `视频 mdhd.duration = 45000（实际 ${readU32(mdhdOf(0), 16)}）`);
  assert(readU32(mdhdOf(1), 16) === 10240, `音频 mdhd.duration = 10240（实际 ${readU32(mdhdOf(1), 16)}）`);

  // track id：音频轨 ID 已平移（原 1 → 1 + maxVideoId(1) = 2）
  const tkhdIdOf = (trakIdx) => {
    const trakRaw = moovContent.subarray(traks[trakIdx].offset, traks[trakIdx].offset + traks[trakIdx].size);
    const tkhd = parseBoxes(trakRaw.subarray(8)).find(b => b.type === 'tkhd');
    return readU32(trakRaw, 8 + tkhd.offset + 20);
  };
  assert(tkhdIdOf(0) === 1 && tkhdIdOf(1) === 2, `track ID 无冲突（视频=${tkhdIdOf(0)} 音频=${tkhdIdOf(1)}）`);

  console.log('== 用例2：单轨转换（convertSingle）==');
  const single = merger.convertSingle(videoFmp4);
  assert(!single.error, `单轨转换成功: ${single.error || ''}`);
  const sout = await blobToU8(single.blob);
  const stop = parseBoxes(sout);
  assert(stop.map(b => b.type).join(',') === 'ftyp,moov,mdat', '单轨输出 = ftyp,moov,mdat');

  console.log('== 用例3：加密（pssh）检测 ==');
  // 在 moov 中塞入 pssh
  const pssh = fullbox('pssh', 0, 0, bytes(32));
  const encMoov = box('moov', ...parseBoxesVideoMoov(videoFmp4).kids, pssh);
  const encFmp4 = concat(videoFmp4.subarray(0, parseBoxes(videoFmp4)[1].offset), encMoov, videoFmp4.subarray(parseBoxes(videoFmp4)[1].offset + parseBoxes(videoFmp4)[1].size));
  const encResult = merger.convertSingle(encFmp4);
  assert(encResult.error === 'encrypted', `加密流被识别并拒绝（${encResult.error}）`);

  console.log('== 用例4：mvhd 电影时基 ≠ 轨道时基（v4.3.0 时基换算）==');
  // 常规流：mvhd timescale=1000，视频轨 timescale=90000。视频 15 帧 × 3000 = 45000
  // ticks = 0.5 秒。旧实现把轨道时基的 45000 原样写进 mvhd/tkhd（时基 1000）
  // → 文件显示 45 秒；修复后应换算为 500（0.5 秒）
  const tsFmp4 = buildFmp4({ timescale: 90000, trackId: 1, handlerType: 'vide', samples: vSamples, mvhdTimescale: 1000 });
  const tsResult = merger.convertSingle(tsFmp4);
  assert(!tsResult.error, `时基用例转换成功: ${tsResult.error || ''}`);
  if (!tsResult.error) {
    const tout = await blobToU8(tsResult.blob);
    const ttop = parseBoxes(tout);
    const tmoovContent = tout.subarray(ttop[1].offset + 8, ttop[1].offset + ttop[1].size);
    const tMvhd = parseBoxes(tmoovContent).find(b => b.type === 'mvhd');
    const mvhdTs = readU32(tmoovContent, tMvhd.offset + 20);
    const mvhdDur = readU32(tmoovContent, tMvhd.offset + 24);
    assert(mvhdTs === 1000 && mvhdDur === 500,
      `mvhd.duration 按电影时基换算（timescale=${mvhdTs} duration=${mvhdDur}，应为 1000/500 = 0.5s）`);
    const tTrak = parseBoxes(tmoovContent).find(b => b.type === 'trak');
    const tTrakContent = tmoovContent.subarray(tTrak.offset + 8, tTrak.offset + tTrak.size);
    const tTkhd = parseBoxes(tTrakContent).find(b => b.type === 'tkhd');
    const tkhdDur = readU32(tTrakContent, tTkhd.offset + 28);
    assert(tkhdDur === 500, `tkhd.duration 用电影时基（实际 ${tkhdDur}，应为 500）`);
    const tMdhd = findBoxPath(tTrakContent, ['mdia', 'mdhd']);
    const mdhdDur = readU32(tMdhd, 16);
    assert(mdhdDur === 45000, `mdhd.duration 保持轨道时基（实际 ${mdhdDur}，应为 45000）`);
  }

  console.log('== 用例5：mux.js 形态——音频轨 ID 小于视频轨（v4.3.0 tkhd 匹配）==');
  // mux.js 转封装输出：moov 中音频 trak 在前（trackId 257）且先于视频 trak（258）
  // 出现的 moof 属于音频。旧位置映射会把音频样本配给视频 trak（30s 视频显示
  // 14.7s、无声或无声画错位）；修复后按 tkhd.track_ID 精确匹配
  {
    const mvSamples = [];
    for (let i = 0; i < 12; i++) mvSamples.push({ data: bytes(80, 0x40 + i), duration: 3000, key: i % 4 === 0 });
    const maSamples = [];
    for (let i = 0; i < 9; i++) maSamples.push({ data: bytes(28, 0xB0 + i), duration: 1024, key: true });
    const vF = buildFmp4({ timescale: 90000, trackId: 258, handlerType: 'vide', samples: mvSamples });
    const aF = buildFmp4({ timescale: 44100, trackId: 257, handlerType: 'soun', samples: maSamples });
    const vMoofOff = parseBoxes(vF).find(b => b.type === 'moof').offset;
    const aMoofOff = parseBoxes(aF).find(b => b.type === 'moof').offset;
    // 分离流合并（mergeAvToMp4 输入音视频各一）
    const merged = merger.mergeAvToMp4(vF, aF);
    assert(!merged.error, `分离流合并成功: ${merged.error || ''}`);
    if (!merged.error) {
      const mout = await blobToU8(merged.blob);
      const mtop = parseBoxes(mout);
      const mmoovContent = mout.subarray(mtop[1].offset + 8, mtop[1].offset + mtop[1].size);
      const mtraks = parseBoxes(mmoovContent).filter(b => b.type === 'trak');
      const durOf = (trakBox) => {
        const c = mmoovContent.subarray(trakBox.offset + 8, trakBox.offset + trakBox.size);
        const mdia = parseBoxes(c).find(b => b.type === 'mdia');
        const mdiaContent = c.subarray(mdia.offset + 8, mdia.offset + mdia.size);
        const hdlr = parseBoxes(mdiaContent).find(b => b.type === 'hdlr');
        const hdlrContent = mdiaContent.subarray(hdlr.offset + 8, hdlr.offset + hdlr.size);
        const handler = String.fromCharCode(hdlrContent[8], hdlrContent[9], hdlrContent[10], hdlrContent[11]);
        const mdhd = findBoxPath(c, ['mdia', 'mdhd']);
        const ts = readU32(mdhd, 12);      // mdhd 内容：verflags(4) creation(4) modification(4) timescale(4)
        const dur = readU32(mdhd, 16);     // duration(4)
        return { handler, ts, dur, sec: dur / ts };
      };
      const d0 = durOf(mtraks[0]), d1 = durOf(mtraks[1]);
      // 视频 12×3000/90000 = 0.4s；音频 9×1024/44100 ≈ 0.2095s
      assert(d0.handler === 'vide' && Math.abs(d0.sec - 0.4) < 0.001,
        `第 1 个 trak 是视频且时长 0.4s（实际 ${d0.handler} ${d0.sec.toFixed(3)}s）`);
      assert(d1.handler === 'soun' && Math.abs(d1.sec - 9 * 1024 / 44100) < 0.001,
        `第 2 个 trak 是音频且时长 ${ (9 * 1024 / 44100).toFixed(3) }s（实际 ${d1.handler} ${d1.sec.toFixed(3)}s）`);
      const mMvhd = parseBoxes(mmoovContent).find(b => b.type === 'mvhd');
      const mvhdSec = readU32(mmoovContent, mMvhd.offset + 24) / readU32(mmoovContent, mMvhd.offset + 20);
      assert(Math.abs(mvhdSec - 0.4) < 0.001, `合并后 mvhd 时长 0.4s（实际 ${mvhdSec.toFixed(3)}s）`);
    }
    // 交错形态直接喂 convertSingle：moov 内「视频 trak(258) 在前」但 moof 序列
    // 「音频(257) 在前」——这正是 mux.js 合流输出的真实形态（实测 mux.dev 流）。
    // 旧位置映射会把音频样本配给视频 trak（30s 视频显示 14.7s / 声画错位）
    const bothMoovKids = [];
    {
      const aMoovBox = parseBoxes(aF).find(b => b.type === 'moov');
      const vMoovBox = parseBoxes(vF).find(b => b.type === 'moov');
      const aContent = aF.subarray(aMoovBox.offset + 8, aMoovBox.offset + aMoovBox.size);
      const vContent = vF.subarray(vMoovBox.offset + 8, vMoovBox.offset + vMoovBox.size);
      const aTrak = parseBoxes(aContent).find(b => b.type === 'trak');
      const vTrak = parseBoxes(vContent).find(b => b.type === 'trak');
      const vMvhd = parseBoxes(vContent).find(b => b.type === 'mvhd');
      bothMoovKids.push(
        vContent.subarray(vMvhd.offset, vMvhd.offset + vMvhd.size),
        vContent.subarray(vTrak.offset, vTrak.offset + vTrak.size), // 视频 trak 在前（mux.js 形态）
        aContent.subarray(aTrak.offset, aTrak.offset + aTrak.size), // 音频 trak 在后
      );
    }
    const combinedFmp4 = concat(
      vF.subarray(0, parseBoxes(vF).find(b => b.type === 'moov').offset), // ftyp
      box('moov', ...bothMoovKids),
      aF.subarray(aMoofOff), // 音频 moof+mdat 在前（mux.js 形态）
      vF.subarray(vMoofOff), // 视频 moof+mdat 在后
    );
    const cr = merger.convertSingle(combinedFmp4);
    assert(!cr.error, `mux.js 合流形态转换成功: ${cr.error || ''}`);
    if (!cr.error) {
      const cout = await blobToU8(cr.blob);
      const ctop = parseBoxes(cout);
      const cmoovContent = cout.subarray(ctop[1].offset + 8, ctop[1].offset + ctop[1].size);
      const ctraks = parseBoxes(cmoovContent).filter(b => b.type === 'trak');
      const durOf2 = (trakBox) => {
        const c = cmoovContent.subarray(trakBox.offset + 8, trakBox.offset + trakBox.size);
        const mdia = parseBoxes(c).find(b => b.type === 'mdia');
        const mdiaContent = c.subarray(mdia.offset + 8, mdia.offset + mdia.size);
        const hdlr = parseBoxes(mdiaContent).find(b => b.type === 'hdlr');
        const hdlrContent = mdiaContent.subarray(hdlr.offset + 8, hdlr.offset + hdlr.size);
        const handler = String.fromCharCode(hdlrContent[8], hdlrContent[9], hdlrContent[10], hdlrContent[11]);
        const mdhd = findBoxPath(c, ['mdia', 'mdhd']);
        return { handler, sec: readU32(mdhd, 16) / readU32(mdhd, 12) };
      };
      const c0 = durOf2(ctraks[0]), c1 = durOf2(ctraks[1]);
      // 关键断言：视频 trak（在前）必须配到视频样本（0.4s），
      // 音频 trak（在后）必须配到音频样本（≈0.2095s）——位置映射旧实现会颠倒
      assert(c0.handler === 'vide' && Math.abs(c0.sec - 0.4) < 0.001,
        `前置 trak（视频）时长 0.4s（实际 ${c0.handler} ${c0.sec.toFixed(3)}s）`);
      assert(c1.handler === 'soun' && Math.abs(c1.sec - 9 * 1024 / 44100) < 0.001,
        `后置 trak（音频）时长 ≈0.2095s（实际 ${c1.handler} ${c1.sec.toFixed(3)}s）`);
    }
  }

  console.log(failures === 0 ? '\n✅ 全部测试通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();

function parseBoxesVideoMoov(data) {
  const top = parseBoxes(data);
  const moovBox = top.find(b => b.type === 'moov');
  const content = data.subarray(moovBox.offset + 8, moovBox.offset + moovBox.size);
  return { kids: parseBoxes(content).map(b => content.subarray(b.offset, b.offset + b.size)) };
}
