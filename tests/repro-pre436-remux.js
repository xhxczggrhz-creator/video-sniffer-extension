// repro-pre436-remux.js
// 还原 v4.3.6 之前 merger 的真实行为：运行时撤销「带符号时长读取」补丁，
// 让负时长样本按无符号 u32 进入 stts（≈4.29e9），mvhd/tkhd 自然回绕——
// 产出与用户手中坏文件完全一致的 authentic broken.mp4，供 ffmpeg 命令实测。
// 运行：node tests/repro-pre436-remux.js
const fs = require('fs');
const path = require('path');

globalThis.window = globalThis;
function loadAsBrowserScript(file, patch) {
  let code = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  if (patch) for (const [from, to] of patch) code = code.split(from).join(to);
  new Function('module', 'exports', 'define', code)(undefined, undefined, undefined);
}
loadAsBrowserScript('lib/ts-mux.min.js');
// 撤销 v4.3.6 补丁：样本时长改回无符号读取（负时长 → 巨大 u32）
loadAsBrowserScript('lib/mp4-merger.js', [
  ['duration = readU32(trunRaw, p) | 0; p += 4;', 'duration = readU32(trunRaw, p); p += 4;'],
]);
loadAsBrowserScript('lib/ts-remux.js');
const remux = globalThis.window.__VideoSnifferTsRemux__;

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
  const outDir = path.join(__dirname, 'tmp-broken');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'authentic-broken.mp4');
  fs.writeFileSync(out, Buffer.from(await r.blob.arrayBuffer()));
  console.log(`已产出（旧版行为）：${out}（${(fs.statSync(out).size / 1048576).toFixed(1)}MB）`);
  console.log(`durationSec（旧版口径，应只剩广告 ≈30s）：${(r.durationSec || 0).toFixed(1)}s`);
})();
