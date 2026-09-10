// test-dns-v429.js
// v4.2.9 DNS 复查修复专项回归：
//   1. fail-closed 保持：解析超时 → 拒绝（safe:false）
//   2. 超时负缓存 60s：同 host 第二次调用瞬时拒绝，不再重复挂 12s
//   3. 负缓存过期后允许重试（DNS 恢复自愈）
//   4. single-flight：并发调用共享同一次解析
//   5. 解析到内网 IP → 拒绝 + dnsBlockReason 说明原因
//   6. 成功结果缓存 10 分钟（不重复解析）
//   7. dnsBlockReason 对超时给出真实原因（不再是"URL 不合法"）
// 运行：node test-dns-v429.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');

// 截取 isBlockedIpLiteral … isSafeUrl 区段（DNS 复查全部依赖），并把 12s
// 超时缩短到 300ms 以便测试。
const start = src.indexOf('function isBlockedIpLiteral');
const endMarker = '// 下载页敏感载荷中转';
const end = src.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  console.error('FAIL 未能截取 service-worker.js 的 DNS 校验代码段');
  process.exit(1);
}
let code = src.slice(start, end);
code = code.replace('const DNS_RESOLVE_TIMEOUT = 12000', 'const DNS_RESOLVE_TIMEOUT = 300');
if (code.includes('12000')) {
  console.error('FAIL 超时替换失败');
  process.exit(1);
}

// chrome.dns stub：可编程行为 + 调用计数
let resolveCalls = 0;
let resolveBehavior = 'ok';   // ok | timeout | private
let resolveDelay = 0;
const chromeStub = {
  dns: {
    resolve: (host) => new Promise((resolve) => {
      resolveCalls++;
      setTimeout(() => {
        if (resolveBehavior === 'timeout') return; // 永不完成 → 触发竞速超时
        if (resolveBehavior === 'private') return resolve({ address: ['10.0.0.5'] });
        resolve({ address: ['93.184.216.34'] });   // 公网 IP
      }, resolveDelay);
    }),
  },
};

const factory = new Function('chrome',
  // O-3 后 DNS_CACHE_TTL / MAX_DNS_CACHE 由 lib/constants.js 导入到 SW，
  // 但本测试用 new Function 沙箱运行截取代码段，无法访问 import，
  // 故在此注入等值常量（与 lib/constants.js 保持同步）
  'const DNS_CACHE_TTL = ' + (10 * 60 * 1000) + ';\n' +
  'const MAX_DNS_CACHE = 200;\n' +
  code +
  '\nreturn { dnsSafeUrl, dnsBlockReason, DNS_CACHE, DNS_INFLIGHT, isSafeUrl };');
const api = factory(chromeStub);

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    const r = await fn();
    if (r === undefined || r === 'ok') { console.log(`PASS  ${name}`); passed++; }
    else { console.log(`FAIL  ${name} :: ${r}`); failed++; }
  } catch (e) {
    console.log(`FAIL  ${name} :: ${e?.message || e}`);
    failed++;
  }
}

(async () => {
  await test('正常解析放行 + 结果缓存（第二次不重复解析）', async () => {
    resolveBehavior = 'ok'; resolveDelay = 0;
    resolveCalls = 0; api.DNS_CACHE.clear(); api.DNS_INFLIGHT.clear();
    if (!(await api.dnsSafeUrl('https://cdn-a.example.com/v.m3u8'))) return '公网 IP 被误拒';
    if (resolveCalls !== 1) return `解析次数异常 (${resolveCalls})`;
    if (!(await api.dnsSafeUrl('https://cdn-a.example.com/v2.m3u8'))) return '缓存命中仍被拒';
    if (resolveCalls !== 1) return `缓存未生效，重复解析 (${resolveCalls})`;
    return 'ok';
  });

  await test('解析超时 fail-closed：拒绝并写 60s 负缓存', async () => {
    resolveBehavior = 'timeout'; resolveDelay = 0;
    resolveCalls = 0; api.DNS_CACHE.clear(); api.DNS_INFLIGHT.clear();
    const t0 = Date.now();
    if (await api.dnsSafeUrl('https://cdn-b.example.com/master.m3u8')) return '超时被放行（fail-open 回归！）';
    const dur = Date.now() - t0;
    if (dur < 250) return `未经历超时竞速 (${dur}ms)`;
    const c = api.DNS_CACHE.get('cdn-b.example.com');
    if (!c?.timeout || c.safe !== false) return `负缓存未写入 (${JSON.stringify(c)})`;
    return 'ok';
  });

  await test('负缓存期内同 host 瞬时拒绝（不再挂 12s）', async () => {
    resolveBehavior = 'ok'; resolveDelay = 0;
    const callsBefore = resolveCalls;
    const t0 = Date.now();
    if (await api.dnsSafeUrl('https://cdn-b.example.com/media.m3u8')) return '负缓存期内被放行';
    const dur = Date.now() - t0;
    if (dur > 50) return `负缓存未命中，耗时 ${dur}ms`;
    if (resolveCalls !== callsBefore) return `负缓存期内重新发起了解析`;
    return 'ok';
  });

  await test('负缓存过期后重试自愈（DNS 恢复 → 放行）', async () => {
    resolveBehavior = 'ok'; resolveDelay = 0;
    const c = api.DNS_CACHE.get('cdn-b.example.com');
    c.ts = Date.now() - 61000; // 60s TTL 已过
    if (!(await api.dnsSafeUrl('https://cdn-b.example.com/media.m3u8'))) return '过期重试仍被拒';
    return 'ok';
  });

  await test('single-flight：并发调用只解析一次', async () => {
    resolveBehavior = 'ok'; resolveDelay = 120;
    resolveCalls = 0; api.DNS_CACHE.clear(); api.DNS_INFLIGHT.clear();
    const [a, b] = await Promise.all([
      api.dnsSafeUrl('https://cdn-c.example.com/s0.ts'),
      api.dnsSafeUrl('https://cdn-c.example.com/s1.ts'),
    ]);
    if (!a || !b) return '并发结果异常';
    if (resolveCalls !== 1) return `并发解析了 ${resolveCalls} 次（应为 1）`;
    if (api.DNS_INFLIGHT.size !== 0) return 'inflight 表未清理';
    return 'ok';
  });

  await test('解析到内网 IP → 拒绝 + dnsBlockReason 给出原因', async () => {
    resolveBehavior = 'private'; resolveDelay = 0;
    resolveCalls = 0; api.DNS_CACHE.clear(); api.DNS_INFLIGHT.clear();
    if (await api.dnsSafeUrl('https://cdn-d.example.com/k.m3u8')) return '内网解析被放行（SSRF 回归！）';
    const reason = api.dnsBlockReason('https://cdn-d.example.com/k.m3u8');
    if (!reason || !reason.includes('内网')) return `原因缺失 (${reason})`;
    return 'ok';
  });

  await test('dnsBlockReason 对超时 host 给出真实原因（非"URL 不合法"）', async () => {
    resolveBehavior = 'timeout'; resolveDelay = 0;
    resolveCalls = 0; api.DNS_CACHE.clear(); api.DNS_INFLIGHT.clear();
    await api.dnsSafeUrl('https://cdn-e.example.com/a.m3u8');
    const reason = api.dnsBlockReason('https://cdn-e.example.com/a.m3u8');
    if (!reason || !reason.includes('DNS 安全校验超时')) return `超时原因缺失 (${reason})`;
    // 安全 host 无原因（返回 null → 调用方回退到通用文案）
    const none = api.dnsBlockReason('https://unknown-host.example.com/x');
    if (none !== null) return `未知 host 不应有原因 (${none})`;
    return 'ok';
  });

  await test('IP 字面量不走 DNS（内网字面量直接拒绝）', async () => {
    resolveBehavior = 'ok'; resolveDelay = 0;
    resolveCalls = 0;
    if (await api.dnsSafeUrl('http://10.1.2.3/v.mp4')) return '内网 IP 字面量被放行';
    if (resolveCalls !== 0) return 'IP 字面量不应触发 DNS 解析';
    if (!(await api.dnsSafeUrl('https://93.184.216.34/v.mp4'))) return '公网 IP 字面量被误拒';
    return 'ok';
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
