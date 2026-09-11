/**
 * 轻量语法/lint 检查：对扩展所有手写 JS 逐个执行 `node --check`。
 * 项目暂无 eslint 配置（0 第三方运行时依赖），此脚本作为 CI 的基线门禁，
 * 覆盖 node --check 无法覆盖的即可。
 *
 * 用法: node scripts/check-js.js
 * 退出码: 0 全部通过；1 有语法错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 跳过第三方 min 文件、已下线/生成目录
const SKIP_DIRS = new Set(['node_modules', '.git', '.trae', '.workbuddy', 'drm-service', 'dist']);
const SKIP_FILES = new Set(['mp4box.min.js', 'ts-mux.min.js']);

function collect(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.js') && !SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

// 判定是否为 ES Module：顶层出现 import...from 或 export <声明>
const ESM_RE = /(^|\n)\s*(?:import\s+[\s\S]*?\s+from\s+['"]|export\s+(?:\{|\*|\s*(?:const|let|var|function|class|default|async)))/m;

function checkFile(f) {
  const content = fs.readFileSync(f, 'utf8');
  // ESM 走 `--input-type=module` + stdin（node --check 默认按 CJS 解析，会误报 export）
  if (ESM_RE.test(content)) {
    execFileSync(process.execPath, ['--input-type=module', '--check', '-'], {
      input: content, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }
}

const files = collect(ROOT);
let failed = 0;
const failedList = [];
for (const f of files) {
  try {
    checkFile(f);
  } catch (e) {
    failed++;
    failedList.push(path.relative(ROOT, f));
  }
}
if (failed) {
  console.error(`\n${failed}/${files.length} 个 JS 文件语法检查失败:`);
  for (const f of failedList) console.error('  ' + f);
  process.exit(1);
}
console.log(`OK 全部 ${files.length} 个 JS 文件语法检查通过`);