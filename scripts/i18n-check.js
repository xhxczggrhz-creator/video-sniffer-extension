/**
 * i18n 门禁：保证「代码里用到的键」与「语言包里的键」永远一致。
 *
 * 检查项：
 * 1. `_locales/zh_CN/messages.json` 与 `_locales/en/messages.json` 键集合完全一致；
 * 2. 每个 message 非空，且两种语言的 `$n` 占位符集合一致（避免译文漏了变量）；
 * 3. 代码中 `t('key')` / `tOr('key', …)` 与 HTML 中 `data-i18n[-*]="key"` 引用的键都存在；
 * 4. `manifest.json` 里的 `__MSG_key__` 都存在；
 * 5. 未合入语言包的 `*.frag.json` 片段必须清零（子代理产出后需合并）。
 *
 * 语言包中定义但代码未引用的键只告警不失败（可能在文档或后续版本使用）。
 *
 * 用法: node scripts/i18n-check.js
 * 退出码: 0 通过；1 有错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['zh_CN', 'en'];
const SCAN_DIRS = ['background', 'content', 'download-page', 'lib', 'offscreen', 'popup'];
const SKIP_FILES = new Set(['mp4box.min.js', 'ts-mux.min.js']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.trae', '.workbuddy', 'drm-service', 'dist', '_locales']);

const errors = [];
const warnings = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`JSON 解析失败 ${path.relative(ROOT, file)}: ${e.message}`);
    return null;
  }
}

// ---- 1/2/5. 语言包 ----
const catalogs = {};
for (const loc of LOCALES) {
  const file = path.join(ROOT, '_locales', loc, 'messages.json');
  if (!fs.existsSync(file)) {
    errors.push(`缺少语言包: _locales/${loc}/messages.json`);
    catalogs[loc] = {};
    continue;
  }
  const json = readJson(file) || {};
  catalogs[loc] = json;
  for (const [key, entry] of Object.entries(json)) {
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      errors.push(`_locales/${loc}/messages.json: 键 "${key}" 缺少非空 message`);
    }
  }
}

const zhKeys = Object.keys(catalogs.zh_CN).sort();
const enKeys = Object.keys(catalogs.en).sort();
for (const k of zhKeys) {
  if (!Object.prototype.hasOwnProperty.call(catalogs.en, k)) errors.push(`en 缺少键: ${k}`);
}
for (const k of enKeys) {
  if (!Object.prototype.hasOwnProperty.call(catalogs.zh_CN, k)) errors.push(`zh_CN 缺少键: ${k}`);
}

// 占位符一致性：两种语言的 $n 集合必须一致
const placeholders = (msg) => (String(msg).match(/\$\d/g) || []).sort().join(',');
for (const k of zhKeys) {
  const zh = catalogs.zh_CN[k]?.message;
  const en = catalogs.en[k]?.message;
  if (typeof zh === 'string' && typeof en === 'string' && placeholders(zh) !== placeholders(en)) {
    errors.push(`键 "${k}" 的占位符不一致: zh=[${placeholders(zh)}] en=[${placeholders(en)}]`);
  }
}

// 片段文件必须已合并
for (const loc of LOCALES) {
  const dir = path.join(ROOT, '_locales', loc);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.frag.json')) {
      errors.push(`未合并的语言包片段: _locales/${loc}/${name}（请合并进 messages.json 后删除）`);
    }
  }
}

// ---- 3. 代码里的键引用 ----
const used = new Map(); // key -> [相对路径, ...]

function record(key, where) {
  if (!used.has(key)) used.set(key, []);
  used.get(key).push(where);
}

function collect(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full));
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) files.push(...collect(full));
}

// lib/i18n.js 自身不调用 t()，只在文档注释里写了用法示例（如 t('popup_download')），
// 扫它会把示例当成真实引用 —— 排除。
const I18N_RUNTIME = path.join('lib', 'i18n.js');

// 已知的取词助手：t() / tOr() / tr()（SW 里 dnsBlockReason 的沙箱安全包装）
const JS_KEY_RE = /\b(?:t|tOr|tr)\(\s*['"]([A-Za-z0-9_]+)['"]/g;
const HTML_ATTR_RE = /data-i18n(?:-[a-z-]+)?\s*=\s*"([A-Za-z0-9_]+)"/g;

for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (rel === I18N_RUNTIME) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const re of [JS_KEY_RE, HTML_ATTR_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) record(m[1], rel);
  }
}

for (const [key, where] of used) {
  if (!Object.prototype.hasOwnProperty.call(catalogs.zh_CN, key)) {
    errors.push(`代码引用了语言包中不存在的键 "${key}"（${where[0]}）`);
  }
}

// ---- 4. manifest 的 __MSG_key__ ----
const manifestPath = path.join(ROOT, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const re = /__MSG_([A-Za-z0-9_]+)__/g;
  let m;
  let found = 0;
  while ((m = re.exec(raw)) !== null) {
    found++;
    record(m[1], 'manifest.json');
    if (!Object.prototype.hasOwnProperty.call(catalogs.zh_CN, m[1])) {
      errors.push(`manifest.json 的 __MSG_${m[1]}__ 在语言包中不存在`);
    }
  }
  if (found === 0) warnings.push('manifest.json 未使用 __MSG_ 本地化（扩展名/描述不会跟随语言）');
  if (JSON.parse(raw).default_locale !== 'zh_CN') {
    errors.push('manifest.json 的 default_locale 应为 zh_CN（缺失时 Chrome 不会加载 _locales）');
  }
} else {
  errors.push('缺少 manifest.json');
}

// ---- 未使用的键（仅告警）----
for (const key of zhKeys) {
  if (!used.has(key)) warnings.push(`语言包键未被代码引用: ${key}`);
}

// ---- 输出 ----
console.log(`i18n 检查：zh_CN ${zhKeys.length} 键 / en ${enKeys.length} 键 / 代码引用 ${used.size} 键`);
if (warnings.length) {
  console.log(`\n告警 ${warnings.length} 条:`);
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.error(`\n错误 ${errors.length} 条:`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('\nOK i18n 语言包与代码引用一致');
