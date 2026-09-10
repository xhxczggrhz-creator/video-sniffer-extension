// test-opfs-aggregate-v429.js
// v4.2.9 SW 分段写盘聚合（proxy-fetch-segment / proxy-fetch-full）等价算法验证：
//   1. 字节守恒：写入 writer 的总字节数 === reader 产出的总字节数
//   2. flush 次数：≈ ceil(total / 1MB)，相比逐 16KB chunk 写下降 16-64 倍
//   3. 边界：空 body、单 chunk、尾部不足 1MB、恰好 1MB 对齐
// 算法与 service-worker.js 的写盘循环保持一致（改动时同步两处）。
// 运行：node test-opfs-aggregate-v429.js

const FLUSH_BYTES = 1024 * 1024;

function makeReader(chunks) {
  let i = 0;
  return {
    read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
  };
}

// 与 SW 写盘循环同构的聚合算法
async function aggregateCopy(reader, writer, onProgress) {
  let written = 0;
  let lastProg = 0;
  let pendingChunks = [];
  let pendingBytes = 0;
  const flushPending = async () => {
    if (!pendingBytes) return;
    let buf;
    if (pendingChunks.length === 1) {
      buf = pendingChunks[0];
    } else {
      buf = new Uint8Array(pendingBytes);
      let off = 0;
      for (const c of pendingChunks) { buf.set(c, off); off += c.byteLength; }
    }
    await writer.write(buf);
    pendingChunks = [];
    pendingBytes = 0;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pendingChunks.push(value);
    pendingBytes += value.byteLength;
    written += value.byteLength;
    if (onProgress && written - lastProg >= 512 * 1024) { lastProg = written; onProgress(written); }
    if (pendingBytes >= FLUSH_BYTES) await flushPending();
  }
  await flushPending();
  return written;
}

async function runCase(name, chunkSpecs, totalExpected) {
  const chunks = chunkSpecs.map(([kb, n]) => {
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(new Uint8Array(kb * 1024));
    return arr;
  }).flat();
  const expectedBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
  if (expectedBytes !== totalExpected) throw new Error(`${name}: 用例构造错误`);

  let writeCalls = 0, writtenTotal = 0;
  const writer = {
    write: async (buf) => { writeCalls++; writtenTotal += buf.byteLength; },
  };
  let progressEvents = 0;
  const written = await aggregateCopy(makeReader(chunks), writer, () => progressEvents++);

  const perChunkWrites = chunks.length;
  const issues = [];
  if (written !== expectedBytes) issues.push(`written=${written} != ${expectedBytes}`);
  if (writtenTotal !== expectedBytes) issues.push(`落盘=${writtenTotal} != ${expectedBytes}`);
  if (expectedBytes > 0 && writeCalls === 0) issues.push('零次写入');
  if (expectedBytes === 0 && writeCalls !== 0) issues.push('空 body 不应有写入');
  const idealWrites = Math.max(1, Math.ceil(expectedBytes / FLUSH_BYTES));
  if (writeCalls > idealWrites) issues.push(`写入次数 ${writeCalls} 超过理想值 ${idealWrites}`);
  if (writeCalls >= perChunkWrites && chunks.length > 64) issues.push(`退化为逐块写（${writeCalls}/${perChunkCallsFix(chunks)}）`);

  function perChunkCallsFix(cs) { return cs.length; }

  if (issues.length) { console.log(`FAIL  ${name} :: ${issues.join('; ')}`); return false; }
  console.log(`PASS  ${name}（${(expectedBytes / 1024 / 1024).toFixed(2)}MB，写入 ${writeCalls} 次 vs 逐块 ${perChunkWrites} 次，进度事件 ${progressEvents}）`);
  return true;
}

(async () => {
  let ok = true;
  ok &= await runCase('16KB×70 + 3KB 尾巴（典型大分段）', [[16, 70], [3, 1]], 16 * 70 * 1024 + 3 * 1024);
  ok &= await runCase('空 body', [], 0);
  ok &= await runCase('单 chunk 64KB（无拷贝路径）', [[64, 1]], 64 * 1024);
  ok &= await runCase('尾部恰好不足 1MB', [[16, 63]], 63 * 16 * 1024);
  ok &= await runCase('恰好 1MB 对齐', [[16, 64]], 1024 * 1024);
  ok &= await runCase('32MB 大分段（模拟 2MB 分片粒度）', [[2048, 16]], 32 * 1024 * 1024);
  const failed = ok ? 0 : 1;
  console.log(`\n${failed ? 0 : 6} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
