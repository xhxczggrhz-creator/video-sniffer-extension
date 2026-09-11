/**
 * P0-3 SSRF 安全回归测试：验证 "类 IP 字面量归一化" 能封堵十进制/十六进制/八进制
 * 形式的回环/内网 IP 绕过，同时不误杀正常域名。
 *
 * 实现：从 background/service-worker.js 提取真实的 isBlockedIpLiteral、
 * normalizeIpLiteralHost、isSafeUrl 三个函数并实跑（避免复制粘贴漂移）。
 *
 * 用法: node tests/test-ssrf-p03.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SW = path.resolve(__dirname, '../background/service-worker.js');
const src = fs.readFileSync(SW, 'utf8');

function extractDecl(reley) {
  const m = reley.exec(src);
  if (!m) throw new Error('未找到声明: ' + reley);
  let d = 0, started = false;
  for (let j = m.index; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('括号不平衡: ' + reley);
}
const isBlockedIpLiteral = eval('(' + extractDecl(/function isBlockedIpLiteral/) + ')');
const normalizeIpLiteralHost = eval('(' + extractDecl(/function normalizeIpLiteralHost/) + ')');
const isSafeUrl = eval('(' + extractDecl(/function isSafeUrl/) + ')');

let pass = true, n = 0;
function check(label, cond) {
  n++;
  if (!cond) { pass = false; console.log('FAIL', label); }
}

// isSafeUrl：期望 false=拦截，true=放行
const urlCases = [
  ['decimal-int 127.0.0.1', 'https://2130706433/x', false],
  ['hex 127.0.0.1', 'https://0x7f000001/x', false],
  ['octal 127.0.0.1', 'https://017700000001/x', false],
  ['hex 10.0.0.1（大写）', 'https://0x0A000001/x', false],
  ['纯公网IP', 'https://202.108.22.5/x', true],
  ['正常域名', 'https://www.example.com/x', true],
  ['带数字域名', 'https://foo-bar-123.com/x', true],
];
for (const [label, url, expect] of urlCases) {
  check(label + ' → ' + (expect ? '放行' : '拦截'), isSafeUrl(url) === expect);
}

// normalize：期望归一化结果
const normCases = [
  ['2130706433', '127.0.0.1'],
  ['0x7f000001', '127.0.0.1'],
  ['017700000001', '127.0.0.1'],
  ['0x0a000001', '10.0.0.1'],
  ['16777343', '1.0.0.127'],
  ['www.example.com', null],
];
for (const [h, expect] of normCases) {
  check('normalize ' + h + ' → ' + expect, normalizeIpLiteralHost(String(h).toLowerCase()) === expect);
}

console.log(pass ? `\nP0-3 SSRF 防护通过（${n} 项）` : `\nP0-3 SSRF 防护失败（${n} 项）`);
process.exit(pass ? 0 : 1);