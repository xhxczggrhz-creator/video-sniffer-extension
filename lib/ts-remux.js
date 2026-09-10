/**
 * 视频嗅探器 - MPEG-TS → MP4 转封装器（v4.3.0）
 *
 * 背景：HLS 流大量使用 MPEG-TS 分片，合并后产出 .ts 文件。电脑播放器
 * （VLC/PotPlayer）能直接播，但 iPhone（文件 App / 相册导入 / 微信预览）
 * 对 MPEG-TS 容器支持极差。本模块把 TS 无损转封装（remux，不重编码）为
 * 标准 MP4（ftyp+moov+mdat），手机原生可播。
 *
 * 管线（两级，全部复用现有模块）：
 *   1. mux.js（lib/ts-mux.min.js，Apache-2.0）Transmuxer：TS → fMP4
 *      （H.264/AAC 解包为 avc1/mp4a 轨，纯容器操作、零画质损失）
 *   2. mp4-merger.js convertSingle / mergeAvToMp4：fMP4 → 标准 MP4
 *
 * 内存策略：TS 输入按 4MB 块流式喂入（不整体驻留）；fMP4 输出与最终 MP4
 * 需驻留内存，故设体积上限（REMUX_MAX_BYTES），超过则放弃转换按 .ts 保存。
 *
 * 失败降级链：标准 MP4 → fMP4（Safari/新播放器可播）→ 调用方回退原始 .ts。
 * 任何失败都不影响原有下载产出。
 *
 * 安全：纯本地计算，不发任何网络请求。
 */

(function () {
  'use strict';

  // 转封装只换容器不重编码，输出 ≈ 输入体积。超过该体积时输出全量驻留
  // 内存有 OOM 风险，宁可退回 .ts 原样保存（下载本身不受影响）。
  const REMUX_MAX_BYTES = 800 * 1024 * 1024;
  const READ_CHUNK_BYTES = 4 * 1024 * 1024;
  // 兜底：个别 mux.js 版本 flush 不触发 'done' 事件时不永久挂起
  const FLUSH_GUARD_MS = 150000;

  function concatU8(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // fMP4 → 标准 MP4；合并器缺失/失败时退回 fMP4 原样输出（iOS Safari 可播）
  // v4.3.6：随产物透传 durationSec（电影总时长，秒），供上游日志验证
  function finalizeFmp4(fmp4U8, merger) {
    if (merger && typeof merger.convertSingle === 'function') {
      const r = merger.convertSingle(fmp4U8);
      if (r && r.blob) return { blob: r.blob, durationSec: r.durationSec || 0 };
      console.warn('[VideoSniffer][ts-remux] fMP4→标准MP4 转换失败，退回 fMP4 容器:', r?.error);
    }
    return { blob: new Blob([fmp4U8], { type: 'video/mp4' }), durationSec: 0 };
  }

  /**
   * TS（Blob/File，单个或多个分片拼接）→ MP4
   * @returns {Promise<{blob: Blob, durationSec: number} | {error: string}>}
   */
  async function transmuxTsToMp4(tsBlob) {
    const muxjs = (typeof window !== 'undefined' && window.muxjs) ||
                  (typeof globalThis !== 'undefined' && globalThis.muxjs);
    if (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
      return { error: '转封装模块未加载（ts-mux.min.js 缺失）' };
    }
    if (!tsBlob || !tsBlob.size) return { error: 'TS 数据为空' };

    const transmuxer = new muxjs.mp4.Transmuxer();

    // combined = 音视频合流（mux.js 默认输出形态）；video/audio 分离输出
    // 是 remux:false 形态，防御性一并收集
    const combined = [], videos = [], audios = [];
    let initCombined = null, initVideo = null, initAudio = null;

    transmuxer.on('data', (seg) => {
      if (!seg) return;
      if (seg.type === 'video') {
        if (seg.data && seg.data.byteLength) videos.push(seg.data);
        if (seg.initSegment && seg.initSegment.byteLength) initVideo = seg.initSegment;
      } else if (seg.type === 'audio') {
        if (seg.data && seg.data.byteLength) audios.push(seg.data);
        if (seg.initSegment && seg.initSegment.byteLength) initAudio = seg.initSegment;
      } else {
        if (seg.data && seg.data.byteLength) combined.push(seg.data);
        if (seg.initSegment && seg.initSegment.byteLength) initCombined = seg.initSegment;
      }
    });

    try {
      // 流式喂入：4MB 块读取，TS 输入不整体驻留内存
      if (typeof tsBlob.stream === 'function') {
        const reader = tsBlob.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) transmuxer.push(new Uint8Array(value));
        }
      } else {
        for (let off = 0; off < tsBlob.size; off += READ_CHUNK_BYTES) {
          const chunk = await tsBlob.slice(off, off + READ_CHUNK_BYTES).arrayBuffer();
          transmuxer.push(new Uint8Array(chunk));
        }
      }

      const flushDone = new Promise((resolve) => {
        transmuxer.on('done', () => resolve());
        setTimeout(resolve, FLUSH_GUARD_MS);
      });
      let flushPromise = null;
      try {
        flushPromise = transmuxer.flush();
      } catch (e) {
        return { error: `TS 解析失败：${e?.message || e}` };
      }
      // v7 的 flush 可能返回 Promise（异步完成），两种形态都等
      await Promise.all([
        flushDone,
        (flushPromise && typeof flushPromise.then === 'function')
          ? flushPromise.catch(() => {}) : Promise.resolve(),
      ]);
    } finally {
      try { transmuxer.dispose?.(); } catch {}
    }

    const merger = (typeof window !== 'undefined' && window.__VideoSnifferMerger__) || null;

    let result = null;
    let durationSec = 0;
    try {
      const hasCombined = combined.length > 0;
      const hasVideo = videos.length > 0;
      const hasAudio = audios.length > 0;

      if (hasCombined || (hasVideo !== hasAudio)) {
        // 单一 fMP4 流：合流（音视频都在）或仅单轨（TS 本就只有一轨）
        const init = hasCombined ? initCombined : (hasVideo ? initVideo : initAudio);
        if (!init) return { error: 'fMP4 init 段缺失（未能从 TS 识别出轨信息）' };
        const payload = hasCombined ? combined : (hasVideo ? videos : audios);
        const fmp4 = concatU8([init, ...payload]);
        const fin = finalizeFmp4(fmp4, merger);
        result = fin.blob;
        durationSec = fin.durationSec || 0;
      } else if (hasVideo && hasAudio) {
        // 音视频分离输出：双轨合并
        if (!merger || typeof merger.mergeAvToMp4 !== 'function') {
          return { error: '合并模块未加载（mp4-merger.js 缺失）' };
        }
        if (!initVideo || !initAudio) return { error: 'fMP4 init 段缺失（分离轨）' };
        const r = merger.mergeAvToMp4(
          concatU8([initVideo, ...videos]),
          concatU8([initAudio, ...audios]),
        );
        if (r && r.error) return { error: r.error };
        result = r ? r.blob : null;
        durationSec = (r && r.durationSec) || 0;
      } else {
        return { error: '未能从 TS 中识别出可转换的音视频轨道（可能是不支持的编码，如 H.265/AC3）' };
      }
    } catch (e) {
      return { error: `转封装异常：${e?.message || e}` };
    }

    if (!result) return { error: '转封装未产出数据' };

    // 体积守恒校验：转封装只换容器，输出应 ≈ 输入（TS 容器开销 2-6%，
    // fMP4 更省）。输出 < 输入 60% 极可能丢轨（不识别的编码被静默丢弃）——
    // 宁可退回原始 .ts，也不产出"只有声音没画面"的坏 MP4。
    if (result.size < tsBlob.size * 0.6) {
      return { error: `输出体积异常（${result.size} / ${tsBlob.size}），疑似丢轨，已放弃转换` };
    }

    return { blob: result, durationSec };
  }

  window.__VideoSnifferTsRemux__ = { transmuxTsToMp4, REMUX_MAX_BYTES };
})();
