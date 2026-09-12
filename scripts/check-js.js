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
const os = require('os');
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-check-js-'));
let seq = 0;

/**
 * 跑一次 node --check 并把子进程输出落到临时文件。
 *
 * 为什么不用 stdio:'pipe'：受限沙箱（DSH / CI 容器 / 部分企业策略）下进程之间
 * 无法建立命名管道，spawnSync 默认的 piped stdio 会直接 EPERM，导致门禁把
 * **所有**文件误报为语法失败。改用文件描述符既能拿到真实错误详情，也不依赖管道。
 * ESM 也不再经 stdin 传内容（stdin 同样是管道），而是复制成临时 .mjs 再检查。
 */
function checkFile(f) {
  const content = fs.readFileSync(f, 'utf8');
  const isEsm = ESM_RE.test(content);
  let target = f;
  if (isEsm) {
    target = path.join(TMP, `m${++seq}.mjs`);
    fs.writeFileSync(target, content);
  }
  const outFile = path.join(TMP, `o${++seq}.txt`);
  const fd = fs.openSync(outFile, 'w');
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: ['ignore', fd, fd] });
    return '';
  } catch (e) {
    let detail = '';
    try { detail = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
    return detail || e.message;
  } finally {
    fs.closeSync(fd);
  }
}

const files = collect(ROOT);
const failures = [];
for (const f of files) {
  const detail = checkFile(f);
  if (detail) failures.push({ file: path.relative(ROOT, f), detail });
}

fs.rmSync(TMP, { recursive: true, force: true });

// ============================================================
// 额外门禁：同一页面内多个经典 <script> 的顶层声明冲突
//
// 经典脚本共享同一个全局作用域，同名顶层声明会直接抛
// `SyntaxError: Identifier 'x' has already been declared`
// —— 整个页面脚本全废，而 `node --check` 逐文件检查发现不了。
// 例：A.js `var t = …` + B.js `const t = …`（i18n 兜底 shim 曾踩到）。
//
// 判定：const/let/class 是词法声明，同名只能出现一次；
//       且任一文件用词法声明时，另一文件用 var/function 同名同样报错。
//       var + var、var + function、function + function 均合法。
// 说明：`type="module"` 的 <script> 有独立作用域，跳过。
// ============================================================
const ENTRY_HTML = ['popup/popup.html', 'download-page/download.html', 'offscreen/offscreen.html'];
const SCRIPT_SRC_RE = /<script\b([^>]*)>/g;
const SRC_RE = /\bsrc\s*=\s*"([^"]+)"/;
const TOP_DECL_RE = /^(const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/;
const LEXICAL_KINDS = new Set(['const', 'let', 'class']);

function topLevelDecls(file) {
  const out = new Map();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = TOP_DECL_RE.exec(line);
    if (!m) continue;
    if (!out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

const conflicts = [];
for (const htmlRel of ENTRY_HTML) {
  const htmlPath = path.join(ROOT, htmlRel);
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');

  // [名字] -> [ {file, kind} ]
  const seen = new Map();
  let m;
  SCRIPT_SRC_RE.lastIndex = 0;
  while ((m = SCRIPT_SRC_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\btype\s*=\s*"module"/.test(attrs)) continue;      // 模块作用域独立
    const src = SRC_RE.exec(attrs);
    if (!src) continue;                                     // 内联脚本：本项目没有
    const abs = path.resolve(path.dirname(htmlPath), src[1]);
    if (!fs.existsSync(abs)) {
      conflicts.push(`${htmlRel}: <script src="${src[1]}"> 文件不存在`);
      continue;
    }
    const rel = path.relative(ROOT, abs);
    for (const [name, kind] of topLevelDecls(abs)) {
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push({ file: rel, kind });
    }
  }

  for (const [name, decls] of seen) {
    const lexical = decls.filter(d => LEXICAL_KINDS.has(d.kind));
    const varLike = decls.filter(d => !LEXICAL_KINDS.has(d.kind));
    const clash = lexical.length > 1 || (lexical.length === 1 && varLike.length > 0);
    if (clash) {
      const detail = decls.map(d => `${d.file} (${d.kind} ${name})`).join(' + ');
      conflicts.push(`${htmlRel}: 顶层标识符 "${name}" 重复声明 → 加载即 SyntaxError：${detail}`);
    }
  }
}

if (failures.length || conflicts.length) {
  if (failures.length) {
    console.error(`\n${failures.length}/${files.length} 个 JS 文件语法检查失败:`);
    for (const { file, detail } of failures) {
      console.error('  ✗ ' + file);
      if (detail) console.error(detail.split('\n').map(l => '      ' + l).join('\n'));
    }
  }
  if (conflicts.length) {
    console.error(`\n${conflicts.length} 处全局作用域声明冲突:`);
    for (const c of conflicts) console.error('  ✗ ' + c);
  }
  process.exit(1);
}
console.log(`OK 全部 ${files.length} 个 JS 文件语法检查通过，${ENTRY_HTML.length} 个页面入口无顶层声明冲突`);
