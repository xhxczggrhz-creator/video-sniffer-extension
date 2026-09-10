/**
 * 视频嗅探器 - fMP4 音视频合并器（MAIN 世界，document_start 注入）
 *
 * 职责：把 MSE 拦截到的视频轨/音频轨 fMP4（ftyp+moov+moof/mdat 序列）
 * 转换为标准 MP4 并合并为「有声有画」的单文件，供腾讯/爱奇艺等
 * 音视频分离站点的「合并下载」使用。
 *
 * 对外 API（window.__VideoSnifferMerger__）：
 *   mergeAvToMp4(videoU8, audioU8) → { blob } 或 { error }
 *   convertSingle(u8)              → { blob } 或 { error }（单轨 fMP4 → 标准 MP4）
 *
 * 与 download.js 旧版合并逻辑的差异（v4.1 重写原因）：
 *   1. replaceStblInTrak 曾把含 header 的 raw trak 传给 findBox →
 *      parseBoxes 只能看到 'trak' 自身 → stbl 替换静默失效，输出必坏
 *   2. adjustStcoInTrak 写回偏移少 8 字节（trak header）→ trak 错位损坏
 *   3. mvhd next_track_id 偏移写错（92/80 应为 104/116），还误写了
 *      不存在的"track count"字段（实际污染 modification_time/timescale）
 *   4. 忽略 trun 的 composition offset（B 帧时序）与 sync 标志 → 本版本
 *      生成 ctts / stss，时序与快进定位正确
 *   5. 样本数据按 trun data_offset 精确定位提取，不再假设
 *      「mdat 载荷 == 样本连续排布」（多 traf/含 padding 的流不会错位）
 *
 * 安全：纯本地计算，不发任何网络请求；全 try-catch，失败返回 { error }。
 */

(function () {
  'use strict';

  // ============================================================
  // 基础读写
  // ============================================================
  function readU32(d, o) {
    return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
  }
  function readU64(d, o) {
    return readU32(d, o) * 0x100000000 + readU32(d, o + 4);
  }
  function writeU32(d, o, v) {
    d[o] = (v >>> 24) & 0xFF;
    d[o + 1] = (v >>> 16) & 0xFF;
    d[o + 2] = (v >>> 8) & 0xFF;
    d[o + 3] = v & 0xFF;
  }
  function writeU64(d, o, v) {
    writeU32(d, o, Math.floor(v / 0x100000000));
    writeU32(d, o + 4, v >>> 0);
  }
  function writeType(d, o, type) {
    for (let i = 0; i < 4; i++) d[o + i] = type.charCodeAt(i);
  }

  // ============================================================
  // Box 解析
  // 约定：传入的 data 的顶层即为待枚举的 box 序列。
  // 下探容器 box 时，调用方先 slice(8) 跳过该 box 的 header。
  // ============================================================
  function parseBoxes(data) {
    const boxes = [];
    let offset = 0;
    while (offset + 8 <= data.length) {
      let size = readU32(data, offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
      let headerLen = 8;
      if (size === 1) {
        if (offset + 16 > data.length) break;
        size = readU64(data, offset + 8);
        headerLen = 16;
      } else if (size === 0) {
        size = data.length - offset;
      }
      if (size < headerLen || offset + size > data.length) break;
      boxes.push({ type, size, offset, headerLen });
      offset += size;
    }
    return boxes;
  }

  function findBox(data, type) {
    return parseBoxes(data).find(b => b.type === type) || null;
  }
  function findAllBoxes(data, type) {
    return parseBoxes(data).filter(b => b.type === type);
  }
  // 取容器 box 的内容（跳过自身 header）
  function boxContent(parentData, box) {
    return parentData.subarray(box.offset + box.headerLen, box.offset + box.size);
  }
  // 取完整 raw box（含 header）
  function boxRaw(parentData, box) {
    return parentData.subarray(box.offset, box.offset + box.size);
  }

  function concatU8(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // ============================================================
  // trak 内定位工具（mdia/minf/stbl/mdhd/tkhd 等）
  // ============================================================
  function findInTrak(trakRaw, path) {
    // path 形如 ['mdia', 'minf', 'stbl']，逐层下探，返回 { data, box }
    // data 为该层内容（已跳父级 header），逐层传入
    let data = trakRaw.subarray(8); // trak 内容
    let found = null;
    for (const name of path) {
      found = findBox(data, name);
      if (!found) return null;
      data = boxContent(data, found);
    }
    return { data, box: found };
  }

  function getMaxTrackId(moovRaw) {
    let maxId = 0;
    const content = moovRaw.subarray(8);
    for (const trak of findAllBoxes(content, 'trak')) {
      const trakRaw = boxRaw(content, trak);
      const tkhd = findInTrak(trakRaw, ['tkhd']);
      if (!tkhd) continue;
      const raw = trakRaw;
      const version = raw[8 + tkhd.box.offset + 8];
      const idOff = 8 + tkhd.box.offset + 8 + (version === 0 ? 12 : 20);
      const id = readU32(raw, idOff);
      if (id > maxId) maxId = id;
    }
    return maxId;
  }

  // ============================================================
  // fMP4 → 标准 MP4 转换器
  // ============================================================
  function convertFmp4ToStandard(data) {
    const top = parseBoxes(data);
    const ftypBox = top.find(b => b.type === 'ftyp');
    const moovBox = top.find(b => b.type === 'moov');
    if (!moovBox) return { error: '缺少 moov，不是有效的 fMP4' };
    const ftypRaw = ftypBox ? boxRaw(data, ftypBox) : buildMinimalFtyp();
    const moovRaw = boxRaw(data, moovBox);
    const moovContent = moovRaw.subarray(8);

    // 加密检测：moov 内含 pssh 或 stsd 内含 tenc → 样本是加密的，
    // 合并出的文件无法播放，直接明确报错（不浪费用户时间）
    if (findBox(moovContent, 'pssh')) return { error: 'encrypted' };
    {
      // 在 moov 字节流中精确搜 'tenc'（加密声明）
      const scanLen = Math.min(moovRaw.length, 131072);
      for (let i = 0; i + 4 <= scanLen; i++) {
        if (moovRaw[i] === 0x74 && moovRaw[i + 1] === 0x65 &&
            moovRaw[i + 2] === 0x6E && moovRaw[i + 3] === 0x63) {
          return { error: 'encrypted' };
        }
      }
    }

    const mvhdBox = findBox(moovContent, 'mvhd');
    const trakBoxes = findAllBoxes(moovContent, 'trak');
    if (!mvhdBox || trakBoxes.length === 0) return { error: 'moov 结构不完整' };

    const moofs = top.filter(b => b.type === 'moof');
    if (moofs.length === 0) return { error: '无 moof 分片，不是 fMP4（可能已是标准 MP4）' };

    // ---- 遍历所有 moof，按 trackId 收集样本 ----
    // trackId → { samples: [{duration,size,cto,sync}], dataParts: [Uint8Array] }
    const tracks = new Map();
    // 越界/无效而被跳过的样本：这些样本无法安全提取，若静默忽略会让后续
    // 载荷错位、stsz/stco 与数据不一致 → 输出坏文件。任何跳过都必须整体报错
    let skippedSamples = 0;

    for (const moofBox of moofs) {
      const moofRaw = boxRaw(data, moofBox);
      const moofContent = moofRaw.subarray(8);
      const trafs = findAllBoxes(moofContent, 'traf');

      for (const traf of trafs) {
        const trafRaw = boxRaw(moofContent, traf);
        const trafContent = trafRaw.subarray(8);
        const tfhd = findBox(trafContent, 'tfhd');
        const trun = findBox(trafContent, 'trun');
        if (!tfhd || !trun) continue;

        const tfhdRaw = boxRaw(trafContent, tfhd);
        const tfhdFlags = readU32(tfhdRaw, 8) & 0xFFFFFF;
        const trackId = readU32(tfhdRaw, 12);
        // tfhd 可选字段按标志位顺序排布，逐个跳过才能定位 default 值
        let tf = 16;
        if (tfhdFlags & 0x000001) tf += 8; // base_data_offset
        if (tfhdFlags & 0x000002) tf += 4; // sample_description_index
        const defaultDuration = (tfhdFlags & 0x000008) ? readU32(tfhdRaw, tf) : 0;
        if (tfhdFlags & 0x000008) tf += 4;
        const defaultSize = (tfhdFlags & 0x000010) ? readU32(tfhdRaw, tf) : 0;
        if (tfhdFlags & 0x000010) tf += 4;
        const defaultFlags = (tfhdFlags & 0x000020) ? readU32(tfhdRaw, tf) : 0;

        const trunRaw = boxRaw(trafContent, trun);
        const trunVersion = trunRaw[8];
        const trunFlags = readU32(trunRaw, 8) & 0xFFFFFF;
        const sampleCount = readU32(trunRaw, 12);

        // data_offset：从 moof 起点到首个样本的字节偏移
        let dataOffset = moofBox.size + 8; // 缺省：紧随 moof 之后的 mdat 载荷
        let p = 16;
        if (trunFlags & 0x000001) { dataOffset = readU32(trunRaw, 16) | 0; p = 20; }
        if (trunFlags & 0x000004) p += 4; // first_sample_flags

        const absStart = moofBox.offset + dataOffset;
        if (absStart < 0 || absStart > data.length) continue;

        if (!tracks.has(trackId)) tracks.set(trackId, { samples: [], dataParts: [] });
        const track = tracks.get(trackId);

        let pos = absStart;
        for (let s = 0; s < sampleCount; s++) {
          let duration = defaultDuration, size = defaultSize, cto = 0, flags = defaultFlags;
          // v4.3.6：样本时长按带符号解释。多流拼接（站点在 HLS 前插广告、
          // 广告与正片 PTS 基线各自从 0 起）时，切换点样本的 PTS 回跳产生
          // 负时长——若按无符号 u32 读入，会把后续负时长修复逻辑绕过。
          if (trunFlags & 0x000100) { duration = readU32(trunRaw, p) | 0; p += 4; }
          if (trunFlags & 0x000200) { size = readU32(trunRaw, p); p += 4; }
          if (trunFlags & 0x000400) { flags = readU32(trunRaw, p); p += 4; }
          if (trunFlags & 0x000800) {
            cto = readU32(trunRaw, p);
            if (trunVersion === 1) cto = (cto << 8) >> 8; // 有符号
            p += 4;
          }
          if (size <= 0 || pos + size > data.length) { skippedSamples++; continue; }
          track.samples.push({ duration, size, cto, sync: !(flags & 0x10000) });
          track.dataParts.push(data.subarray(pos, pos + size));
          pos += size;
        }
      }
    }

    // 任何样本越界/无效都必须整体报错，避免产出数据错位的坏文件
    if (skippedSamples > 0) {
      return { error: `样本数据不连续或越界（${skippedSamples} 个），无法安全合并，已中止` };
    }
    if (tracks.size === 0) return { error: '未找到有效样本（无 trun 或数据越界）' };

    // ---- v4.3.6：负时长样本修复（广告+正片多流拼接的 PTS 回跳）----
    // 症状：站点在 HLS 清单前插入广告分片，广告与正片是两次独立编码、
    // PTS 基线各自从 0 起。mux.js 转封装时切换点样本时长 = 正片首帧PTS −
    // 广告尾帧PTS ≈ −正片总时长。负值按 u32 写进 stts 后：
    //   1. mvhd/tkhd 总时长 u32 回绕 = 只剩广告时长 → 播放器进度条只到
    //      广告结束，正片数据都在但被压到「时长之外」（无法拖动/快进）
    //   2. 单条 ~2^32 的 stts 时长 → iPhone 文件 App 严格校验直接拒播
    // 修复：负时长 = 流不连续点，用前一个有效样本时长补齐（广告尾帧多
    // 停一帧，视觉无感），时间线衔接为「广告 0~30s + 正片 30s~」。
    let repairedNegDurations = 0;
    for (const track of tracks.values()) {
      const samples = track.samples;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].duration < 0) {
          repairedNegDurations++;
          const prev = i > 0 ? samples[i - 1].duration : 0;
          const next = i + 1 < samples.length ? samples[i + 1].duration : 0;
          samples[i].duration = prev > 0 ? prev : (next > 0 ? next : 0);
        }
      }
    }
    if (repairedNegDurations > 0) {
      console.warn(`[VideoSniffer][merger] 检测到 ${repairedNegDurations} 个负时长样本（多流拼接/PTS 回跳，常见于片头广告），已按邻帧时长修复`);
    }

    // ---- 按 tkhd 的真实 track_id 匹配每轨数据 ----
    // v4.3.0 修复：旧实现假设「moov trak 顺序 = moof traf 首次出现顺序」。
    // MSE 捕获流（视频 traf 在前）恰好成立，但 mux.js 等转封装器输出
    // 「音频 moof 在前、视频 moof 在后」的分离片段时映射颠倒——视频 trak
    // 配上音频样本：时长按错误时基换算（30 秒视频显示 14.7 秒）、stsd 与
    // 载荷不符，文件必然无法播放。改为读 tkhd.track_ID 精确匹配，与
    // moof/traf 出现顺序无关。
    const trackIds = [...tracks.keys()];
    const trackIdFromTrak = (trakBox) => {
      try {
        const trakContent = boxRaw(moovContent, trakBox).subarray(8);
        const tkhdBox = findBox(trakContent, 'tkhd');
        if (!tkhdBox) return null;
        const tkhdRaw = boxRaw(trakContent, tkhdBox);
        const ver = tkhdRaw[8];
        // v0: track_ID 在 box 起始 +20；v1: +28
        return readU32(tkhdRaw, 8 + (ver === 0 ? 12 : 20));
      } catch { return null; }
    };
    const orderedTracks = trakBoxes.map((trakBox, idx) => {
      const realId = trackIdFromTrak(trakBox);
      // 按 ID 匹配；tkhd 缺失/无命中时退回位置映射（防御非常规流）
      const track = (realId !== null && tracks.has(realId))
        ? tracks.get(realId)
        : (tracks.get(trackIds[idx]) || tracks.values().next().value);
      return { trakBox, track, samples: track.samples };
    });
    // ---- v4.3.0 修复：mvhd/tkhd 时长必须用「电影时基」（mvhd.timescale）书写 ----
    // 旧实现把轨道时基下的样本总时长（如视频 90000 时基的 4499998 ticks）原样
    // 写进 mvhd/tkhd。mux.js 的 mvhd 时基恰为 90000 时侥幸正确；但常规流 mvhd
    // 时基多为 1000（MSE 捕获路径），50 秒视频会显示成 4500 秒——iOS 文件 App
    // /相册的时长、进度条全部错乱。此处统一换算：电影时长 = 轨道时长 ÷ 轨道
    // 时基 × 电影时基。
    const mvhdRaw0 = boxRaw(moovContent, mvhdBox);
    const mvhdTimescale = mvhdRaw0[8] === 0 ? readU32(mvhdRaw0, 20) : readU32(mvhdRaw0, 28);
    const toMovieScale = (durInTrackScale, trackTimescale) => {
      if (!trackTimescale || !mvhdTimescale) return durInTrackScale;
      return Math.round(durInTrackScale / trackTimescale * mvhdTimescale);
    };
    const totalDurationByTrak = orderedTracks.map(t => {
      const trakRaw = boxRaw(moovContent, t.trakBox);
      const total = t.samples.reduce((s, x) => s + x.duration, 0);
      return { trakRaw, totalDuration: toMovieScale(total, mdhdTimescaleOf(trakRaw)) };
    });
    // v4.3.6：电影总时长（秒）随产物一并返回，供上游日志验证
    // 负时长修复效果（修复前 u32 回绕只剩广告时长）
    const movieDurationSec = mvhdTimescale
      ? totalDurationByTrak.reduce((m, d) => Math.max(m, d.totalDuration), 0) / mvhdTimescale
      : 0;

    // 每轨数据在 mdat 载荷内的起始偏移（多轨流：数据按 trak 顺序依次排布）
    const mdatOffsetsInPayload = [];
    {
      let acc = 0;
      for (const t of orderedTracks) {
        mdatOffsetsInPayload.push(acc);
        acc += t.track.dataParts.reduce((s, p) => s + p.length, 0);
      }
    }

    // ---- 两遍构建 moov（先算大小，再回填 stco 真实偏移）----
    const buildMoov = (mdatStart) => {
      const rebuilt = orderedTracks.map((t, idx) => {
        const trakRaw = boxRaw(moovContent, t.trakBox);
        const stblInfo = findInTrak(trakRaw, ['mdia', 'minf', 'stbl']);
        let stsd = new Uint8Array(16);
        if (stblInfo) {
          const s = findBox(stblInfo.data, 'stsd');
          if (s) stsd = boxRaw(stblInfo.data, s);
        }
        // stco 指向本轨首个样本：mdat 载荷起点(8 字节 mdat header) + 本轨偏移 + 文件内 mdat 起点 - 8（stco 指向载荷）
        const stco = buildStco(mdatStart + 8 + mdatOffsetsInPayload[idx]);
        const stbl = buildStbl(stsd, buildStts(t.samples), buildCtts(t.samples), buildStss(t.samples), buildStsc(t.samples.length), buildStsz(t.samples), stco);
        const trak = replaceStblInTrak(trakRaw, stbl);
        const total = t.samples.reduce((s2, x) => s2 + x.duration, 0);
        return patchTrakDuration(trak, total, toMovieScale(total, mdhdTimescaleOf(trakRaw)));
      });
      return assembleMoov(moovRaw, moovContent, mvhdBox, rebuilt, totalDurationByTrak);
    };

    const tempMoov = buildMoov(0);
    const mdatStart = ftypRaw.length + tempMoov.length;
    const newMoov = buildMoov(mdatStart);

    // ---- 拼接 mdat（各轨样本数据按 trak 顺序依次排布，与 stco 对应）----
    const mdatPayload = concatU8(orderedTracks.flatMap(t => t.track.dataParts));
    const mdat = new Uint8Array(8 + mdatPayload.length);
    writeU32(mdat, 0, mdat.length);
    writeType(mdat, 4, 'mdat');
    mdat.set(mdatPayload, 8);

    return { ftyp: ftypRaw, moov: newMoov, mdat, error: null, durationSec: movieDurationSec };
  }

  function buildMinimalFtyp() {
    const b = new Uint8Array(24);
    writeU32(b, 0, 24); writeType(b, 4, 'ftyp');
    writeType(b, 8, 'isom'); writeU32(b, 12, 512);
    writeType(b, 16, 'isom'); writeType(b, 20, 'iso2');
    return b;
  }

  // ---- 样本表 box 构建 ----
  function buildStts(samples) {
    const runs = [];
    for (const s of samples) {
      if (runs.length && runs[runs.length - 1].duration === s.duration) runs[runs.length - 1].count++;
      else runs.push({ count: 1, duration: s.duration });
    }
    const size = 16 + runs.length * 8;
    const b = new Uint8Array(size);
    writeU32(b, 0, size); writeType(b, 4, 'stts'); writeU32(b, 8, 0);
    writeU32(b, 12, runs.length);
    runs.forEach((r, i) => { writeU32(b, 16 + i * 8, r.count); writeU32(b, 20 + i * 8, r.duration); });
    return b;
  }

  function buildCtts(samples) {
    if (!samples.some(s => s.cto !== 0)) return null;
    const runs = [];
    for (const s of samples) {
      if (runs.length && runs[runs.length - 1].cto === s.cto) runs[runs.length - 1].count++;
      else runs.push({ count: 1, cto: s.cto });
    }
    const size = 16 + runs.length * 8;
    const b = new Uint8Array(size);
    writeU32(b, 0, size); writeType(b, 4, 'ctts');
    writeU32(b, 8, 1); // version 1（支持负偏移）
    writeU32(b, 12, runs.length);
    runs.forEach((r, i) => { writeU32(b, 16 + i * 8, r.count); writeU32(b, 20 + i * 8, r.cto >>> 0); });
    return b;
  }

  function buildStss(samples) {
    const hasNonSync = samples.some(s => !s.sync);
    if (!hasNonSync) return null; // 全部是同步样本则无需 stss
    const syncIdx = [];
    samples.forEach((s, i) => { if (s.sync) syncIdx.push(i + 1); });
    const size = 16 + syncIdx.length * 4;
    const b = new Uint8Array(size);
    writeU32(b, 0, size); writeType(b, 4, 'stss'); writeU32(b, 8, 0);
    writeU32(b, 12, syncIdx.length);
    syncIdx.forEach((n, i) => writeU32(b, 16 + i * 4, n));
    return b;
  }

  function buildStsc(sampleCount) {
    const b = new Uint8Array(28);
    writeU32(b, 0, 28); writeType(b, 4, 'stsc'); writeU32(b, 8, 0);
    writeU32(b, 12, 1);
    writeU32(b, 16, 1);               // first_chunk
    writeU32(b, 20, sampleCount);     // samples_per_chunk
    writeU32(b, 24, 1);               // sample_description_index
    return b;
  }

  function buildStsz(samples) {
    const allSame = samples.length > 0 && samples.every(s => s.size === samples[0].size);
    const size = allSame ? 20 : 20 + samples.length * 4;
    const b = new Uint8Array(size);
    writeU32(b, 0, size); writeType(b, 4, 'stsz'); writeU32(b, 8, 0);
    if (allSame) {
      writeU32(b, 12, samples[0].size);
      writeU32(b, 16, samples.length);
    } else {
      writeU32(b, 12, 0);
      writeU32(b, 16, samples.length);
      samples.forEach((s, i) => writeU32(b, 20 + i * 4, s.size));
    }
    return b;
  }

  function buildStco(mdatStart) {
    const b = new Uint8Array(20);
    writeU32(b, 0, 20); writeType(b, 4, 'stco'); writeU32(b, 8, 0);
    writeU32(b, 12, 1);
    writeU32(b, 16, mdatStart);
    return b;
  }

  function buildStbl(stsd, stts, ctts, stss, stsc, stsz, stco) {
    const children = [stsd, stts, ctts, stss, stsc, stsz, stco].filter(Boolean);
    const size = 8 + children.reduce((s, c) => s + c.length, 0);
    const b = new Uint8Array(size);
    writeU32(b, 0, size); writeType(b, 4, 'stbl');
    let off = 8;
    for (const c of children) { b.set(c, off); off += c.length; }
    return b;
  }

  // 在 trak 中替换 stbl（修正版：严格用 content 下探，偏移全部相对正确）
  function replaceStblInTrak(trakRaw, newStbl) {
    const trakContent = trakRaw.subarray(8);
    const mdiaBox = findBox(trakContent, 'mdia');
    if (!mdiaBox) return trakRaw;
    const mdiaRaw = boxRaw(trakContent, mdiaBox);
    const mdiaContent = mdiaRaw.subarray(8);
    const minfBox = findBox(mdiaContent, 'minf');
    if (!minfBox) return trakRaw;
    const minfRaw = boxRaw(mdiaContent, minfBox);
    const minfContent = minfRaw.subarray(8);
    const stblBox = findBox(minfContent, 'stbl');
    if (!stblBox) return trakRaw;

    // 新 minf = header + (stbl 前内容) + 新 stbl + (stbl 后内容)
    const beforeStbl = minfRaw.subarray(8, 8 + stblBox.offset);
    const afterStbl = minfRaw.subarray(8 + stblBox.offset + stblBox.size);
    const newMinf = new Uint8Array(8 + beforeStbl.length + newStbl.length + afterStbl.length);
    writeU32(newMinf, 0, newMinf.length); writeType(newMinf, 4, 'minf');
    let o = 8;
    newMinf.set(beforeStbl, o); o += beforeStbl.length;
    newMinf.set(newStbl, o); o += newStbl.length;
    newMinf.set(afterStbl, o);

    // 新 mdia = header + (minf 前) + 新 minf + (minf 后)
    const beforeMinf = mdiaRaw.subarray(8, 8 + minfBox.offset);
    const afterMinf = mdiaRaw.subarray(8 + minfBox.offset + minfBox.size);
    const newMdia = new Uint8Array(8 + beforeMinf.length + newMinf.length + afterMinf.length);
    writeU32(newMdia, 0, newMdia.length); writeType(newMdia, 4, 'mdia');
    o = 8;
    newMdia.set(beforeMinf, o); o += beforeMinf.length;
    newMdia.set(newMinf, o); o += newMinf.length;
    newMdia.set(afterMinf, o);

    // 新 trak = header + (mdia 前) + 新 mdia + (mdia 后)
    const beforeMdia = trakRaw.subarray(8, 8 + mdiaBox.offset);
    const afterMdia = trakRaw.subarray(8 + mdiaBox.offset + mdiaBox.size);
    const newTrak = new Uint8Array(8 + beforeMdia.length + newMdia.length + afterMdia.length);
    writeU32(newTrak, 0, newTrak.length); writeType(newTrak, 4, 'trak');
    o = 8;
    newTrak.set(beforeMdia, o); o += beforeMdia.length;
    newTrak.set(newMdia, o); o += newMdia.length;
    newTrak.set(afterMdia, o);
    return newTrak;
  }

  // 读取 trak 内 mdhd 的轨道时基
  function mdhdTimescaleOf(trakRaw) {
    try {
      const trakContent = trakRaw.subarray(8);
      const mdiaBox = findBox(trakContent, 'mdia');
      if (!mdiaBox) return 0;
      const mdiaContent = boxRaw(trakContent, mdiaBox).subarray(8);
      const mdhdBox = findBox(mdiaContent, 'mdhd');
      if (!mdhdBox) return 0;
      const mdhdRaw = boxRaw(mdiaContent, mdhdBox);
      const ver = mdhdRaw[8];
      return ver === 0 ? readU32(mdhdRaw, 20) : readU32(mdhdRaw, 28);
    } catch { return 0; }
  }

  // 修补 trak 时长：mdhd.duration 用轨道时基；tkhd.duration 用电影时基（ISO 规范）
  function patchTrakDuration(trakRaw, durationInTrackScale, durationInMovieScale) {
    const out = new Uint8Array(trakRaw);
    try {
      const trakContent = out.subarray(8);
      const mdiaBox = findBox(trakContent, 'mdia');
      if (mdiaBox) {
        const mdiaRaw = out.subarray(8 + mdiaBox.offset, 8 + mdiaBox.offset + mdiaBox.size);
        const mdiaContent = mdiaRaw.subarray(8);
        const mdhdBox = findBox(mdiaContent, 'mdhd');
        if (mdhdBox) {
          const base = 8 + mdiaBox.offset + 8 + mdhdBox.offset; // mdhd box 起点（相对 out）
          const ver = out[base + 8];
          // mdhd v0: size(4)type(4)ver+flags(4)@8 creation(4)@12 modification(4)@16
          //          timescale(4)@20 duration(4)@24
          // v1 的 creation/modification 各 8 字节 → timescale@28 duration@32
          if (ver === 0) writeU32(out, base + 24, durationInTrackScale >>> 0);
          else writeU64(out, base + 32, durationInTrackScale);
        }
      }
      const tkhdBox = findBox(trakContent, 'tkhd');
      if (tkhdBox) {
        const base = 8 + tkhdBox.offset;
        const ver = out[base + 8];
        const dur = durationInMovieScale ?? durationInTrackScale;
        if (ver === 0) writeU32(out, base + 28, dur >>> 0);
        else writeU64(out, base + 36, dur);
      }
    } catch {}
    return out;
  }

  // 组装新 moov：保留 mvhd（修补时长/next_track_id）+ 新 traks + 其他子 box，丢弃 mvex
  function assembleMoov(moovRaw, moovContent, mvhdBox, rebuiltTraks, durations) {
    const mvhdRaw = new Uint8Array(boxRaw(moovContent, mvhdBox));
    const ver = mvhdRaw[8];
    // next_track_id：正确偏移（v0: box 内 104；v1: 116）
    const maxId = getMaxTrackId(moovRaw);
    if (ver === 0 && mvhdRaw.length >= 108) writeU32(mvhdRaw, 104, maxId + 1);
    else if (ver === 1 && mvhdRaw.length >= 120) writeU32(mvhdRaw, 116, maxId + 1);
    // mvhd.duration：取各轨换算后的最大值
    patchMvhdDuration(mvhdRaw, durations);

    const others = parseBoxes(moovContent)
      .filter(b => b.type !== 'mvhd' && b.type !== 'trak' && b.type !== 'mvex')
      .map(b => boxRaw(moovContent, b));

    let size = 8 + mvhdRaw.length;
    for (const t of rebuiltTraks) size += t.length;
    for (const oth of others) size += oth.length;

    const moov = new Uint8Array(size);
    writeU32(moov, 0, size); writeType(moov, 4, 'moov');
    let off = 8;
    moov.set(mvhdRaw, off); off += mvhdRaw.length;
    for (const t of rebuiltTraks) { moov.set(t, off); off += t.length; }
    for (const oth of others) { moov.set(oth, off); off += oth.length; }
    return moov;
  }

  function patchMvhdDuration(mvhdRaw, durations) {
    try {
      const ver = mvhdRaw[8];
      const ts = ver === 0 ? readU32(mvhdRaw, 20) : readU32(mvhdRaw, 28);
      if (!ts) return;
      // durations 已由调用方换算为电影时基（轨道时长 ÷ 轨道时基 × mvhd 时基），
      // 取各轨最大值写入 mvhd.duration
      let maxDur = 0;
      for (const d of durations) {
        if (d.totalDuration > maxDur) maxDur = d.totalDuration;
      }
      if (ver === 0) writeU32(mvhdRaw, 24, maxDur >>> 0);
      else writeU64(mvhdRaw, 32, maxDur);
    } catch {}
  }

  // ============================================================
  // 标准 MP4 双轨合并
  // ============================================================
  function mergeStandardMp4(v, a) {
    const vContent = v.moov.subarray(8);
    const aContent = a.moov.subarray(8);
    const vMvhd = findBox(vContent, 'mvhd');
    if (!vMvhd) return { error: '视频轨 moov 缺少 mvhd' };

    const vTraksRaw = findAllBoxes(vContent, 'trak').map(b => boxRaw(vContent, b));
    const vMaxId = Math.max(1, getMaxTrackId(v.moov));
    const aMaxId = Math.max(1, getMaxTrackId(a.moov));

    // 音频 trak：tkhd ID 平移避免冲突（stco 平移需等合并 moov 尺寸确定后计算）
    const aTraksRaw = findAllBoxes(aContent, 'trak').map(b =>
      shiftTrackId(new Uint8Array(boxRaw(aContent, b)), vMaxId)
    );

    // 视频 mvhd：修补 next_track_id
    const mvhdRaw = new Uint8Array(boxRaw(vContent, vMvhd));
    const ver = mvhdRaw[8];
    if (ver === 0 && mvhdRaw.length >= 108) writeU32(mvhdRaw, 104, vMaxId + aMaxId + 1);
    else if (ver === 1 && mvhdRaw.length >= 120) writeU32(mvhdRaw, 116, vMaxId + aMaxId + 1);

    const vOthers = parseBoxes(vContent)
      .filter(b => b.type !== 'mvhd' && b.type !== 'trak' && b.type !== 'mvex')
      .map(b => boxRaw(vContent, b));

    let moovSize = 8 + mvhdRaw.length;
    for (const t of vTraksRaw) moovSize += t.length;
    for (const t of aTraksRaw) moovSize += t.length;
    for (const o of vOthers) moovSize += o.length;

    // 音频 stco 精确平移：原指向 (a.ftyp+a.moov+8)，现指向 (v.ftyp+合并moov+v.mdat+8)
    // 修正旧版 bug：旧版只加 v.mdat 长度，忽略了前后 moov/ftyp 尺寸差异 → 音轨错位无声/无法播放
    const stcoDelta = v.ftyp.length + moovSize + v.mdat.length - a.ftyp.length - a.moov.length;
    // v4.3.0：音频 tkhd.duration 按源/目标电影时基换算（两源 MP4 的 mvhd
    // timescale 不同时，直接沿用会把时长写错时基）
    const vMvhdTs = ver === 0 ? readU32(mvhdRaw, 20) : readU32(mvhdRaw, 28);
    const aMvhdBox = findBox(aContent, 'mvhd');
    const aMvhdRaw = aMvhdBox ? boxRaw(aContent, aMvhdBox) : null;
    const aMvhdTs = aMvhdRaw ? (aMvhdRaw[8] === 0 ? readU32(aMvhdRaw, 20) : readU32(aMvhdRaw, 28)) : 0;
    const aTraksAdjusted = aTraksRaw.map(t =>
      rescaleTkhdDuration(shiftStcoInTrak(t, stcoDelta), aMvhdTs, vMvhdTs));

    // v4.1.1 修复：视频轨 stco 同样要平移——合并后 moov 尺寸变化（多了一个音频
    // trak），视频 mdat 整体后移；不平移则画面错位/无法播放（旧版遗漏）
    const vStcoDelta = moovSize - v.moov.length;
    const vTraksAdjusted = vTraksRaw.map(t =>
      vStcoDelta === 0 ? t : shiftStcoInTrak(new Uint8Array(t), vStcoDelta)
    );

    const moov = new Uint8Array(moovSize);
    writeU32(moov, 0, moovSize); writeType(moov, 4, 'moov');
    let off = 8;
    moov.set(mvhdRaw, off); off += mvhdRaw.length;
    for (const t of vTraksAdjusted) { moov.set(t, off); off += t.length; }
    for (const t of aTraksAdjusted) { moov.set(t, off); off += t.length; }
    for (const o of vOthers) { moov.set(o, off); off += o.length; }

    const total = v.ftyp.length + moov.length + v.mdat.length + a.mdat.length;
    const out = new Uint8Array(total);
    let p = 0;
    out.set(v.ftyp, p); p += v.ftyp.length;
    out.set(moov, p); p += moov.length;
    out.set(v.mdat, p); p += v.mdat.length;
    out.set(a.mdat, p);
    return { blob: new Blob([out], { type: 'video/mp4' }), error: null };
  }

  // tkhd.duration 时基换算（合并两轨来自不同电影时基的 MP4 时使用；
  // 0 / 0xFFFFFFFF 是「未知时长」哨兵值，跳过不换算）
  function rescaleTkhdDuration(trakRaw, fromTs, toTs) {
    if (!fromTs || !toTs || fromTs === toTs) return trakRaw;
    const out = new Uint8Array(trakRaw);
    try {
      const trakContent = out.subarray(8);
      const tkhdBox = findBox(trakContent, 'tkhd');
      if (!tkhdBox) return out;
      const base = 8 + tkhdBox.offset;
      const ver = out[base + 8];
      if (ver === 0) {
        const dur = readU32(out, base + 28);
        if (dur === 0 || dur >= 0xFFFFFFFF) return out;
        writeU32(out, base + 28, Math.round(dur / fromTs * toTs) >>> 0);
      } else {
        const dur = readU64(out, base + 36);
        if (dur === 0 || dur >= 0xFFFFFFFFFFFFFFFF) return out;
        writeU64(out, base + 36, Math.round(dur / fromTs * toTs));
      }
    } catch {}
    return out;
  }

  // tkhd 中的 track_id 平移
  function shiftTrackId(trakRaw, delta) {
    const out = new Uint8Array(trakRaw);
    const trakContent = out.subarray(8);
    const tkhdBox = findBox(trakContent, 'tkhd');
    if (!tkhdBox) return out;
    const base = 8 + tkhdBox.offset;
    const ver = out[base + 8];
    const idOff = base + 8 + (ver === 0 ? 12 : 20);
    const oldId = readU32(out, idOff);
    writeU32(out, idOff, oldId + delta);
    return out;
  }

  // trak 内 stbl.stco 的全部 chunk 偏移平移（修正版：写回偏移含 8 字节 trak header）
  function shiftStcoInTrak(trakRaw, delta) {
    const out = new Uint8Array(trakRaw);
    try {
      const trakContent = out.subarray(8);
      const mdiaBox = findBox(trakContent, 'mdia');
      if (!mdiaBox) return out;
      const mdiaRaw = out.subarray(8 + mdiaBox.offset, 8 + mdiaBox.offset + mdiaBox.size);
      const mdiaContent = mdiaRaw.subarray(8);
      const minfBox = findBox(mdiaContent, 'minf');
      if (!minfBox) return out;
      const minfRaw = mdiaContent.subarray(minfBox.offset, minfBox.offset + minfBox.size);
      const minfContent = minfRaw.subarray(8);
      const stblBox = findBox(minfContent, 'stbl');
      if (!stblBox) return out;
      const stblRaw = minfContent.subarray(stblBox.offset, stblBox.offset + stblBox.size);
      const stblContent = stblRaw.subarray(8);
      const stcoBox = findBox(stblContent, 'stco');
      if (!stcoBox) return out;

      // stco box 起点相对 out 的偏移：
      // 8(trak) + mdiaBox.offset + 8 + minfBox.offset + 8 + stblBox.offset + 8 + stcoBox.offset
      const stcoBase = 8 + mdiaBox.offset + 8 + minfBox.offset + 8 + stblBox.offset + 8 + stcoBox.offset;
      const count = readU32(out, stcoBase + 12);
      for (let i = 0; i < count; i++) {
        const old = readU32(out, stcoBase + 16 + i * 4);
        writeU32(out, stcoBase + 16 + i * 4, (old + delta) >>> 0);
      }
    } catch {}
    return out;
  }

  // ============================================================
  // 对外 API
  // ============================================================
  function mergeAvToMp4(videoU8, audioU8) {
    try {
      const v = convertFmp4ToStandard(videoU8);
      if (v.error) return { error: v.error === 'encrypted' ? 'encrypted' : `视频轨转换失败：${v.error}` };
      const a = convertFmp4ToStandard(audioU8);
      if (a.error) return { error: a.error === 'encrypted' ? 'encrypted' : `音频轨转换失败：${a.error}` };
      const merged = mergeStandardMp4(v, a);
      if (merged.error) return merged;
      // v4.3.6：双轨取最大时长（电影时长以最长轨为准）
      merged.durationSec = Math.max(v.durationSec || 0, a.durationSec || 0);
      return merged;
    } catch (e) {
      console.error('[VideoSniffer][merger]', e);
      return { error: `合并异常：${e?.message || e}` };
    }
  }

  // 单轨 fMP4 → 标准 MP4（可选：供未来「转换为标准格式」按钮使用）
  function convertSingle(u8) {
    try {
      const r = convertFmp4ToStandard(u8);
      if (r.error) return { error: r.error };
      const out = concatU8([r.ftyp, r.moov, r.mdat]);
      return { blob: new Blob([out], { type: 'video/mp4' }), error: null, durationSec: r.durationSec || 0 };
    } catch (e) {
      return { error: `转换异常：${e?.message || e}` };
    }
  }

  window.__VideoSnifferMerger__ = { mergeAvToMp4, convertSingle };
})();
