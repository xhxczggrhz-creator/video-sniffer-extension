/**
 * 发布打包：把可上架的关键目录打成 zip，并输出 SHA256 校验和。
 * 产出到 dist/video-sniffer-<version>.zip
 *
 * 用法: node scripts/package.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

// 打包清单：与 .gitignore 对齐，排除敏感/生成物
const INCLUDE = [
  'manifest.json',
  'background',
  'content',
  'content-script',
  'download-page',
  'icons',
  'lib',
  'offscreen',
  'popup',
  'LICENSE',
  'README.md',
];
const BLACKLIST = [/\.workbuddy/, /node_modules/, /\.git/, /drm-service/, /^\..*\.md$/];

function src(file) { return path.join(ROOT, file); }

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const zipName = `video-sniffer-${version}.zip`;
const zipPath = path.join(outDir, zipName);

// 收集文件
const entries = [];
function walk(rel) {
  const full = src(rel);
  if (BLACKLIST.some(r => rel.match(r))) return;
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(full)) walk(path.join(rel, n));
  } else {
    entries.push(rel);
  }
}
for (const item of INCLUDE) {
  if (fs.existsSync(src(item))) walk(item);
}

// 用 PowerShell 的 Compress-Archive 创建 zip（Windows 内置）
const tmpDir = path.join(outDir, `_stage-${version}`);
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
for (const rel of entries) {
  const from = src(rel);
  const to = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
const r = spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${zipPath}' -Force`,
], { stdio: 'inherit' });
fs.rmSync(tmpDir, { recursive: true, force: true });

if (r.status !== 0) {
  console.error('打包失败');
  process.exit(1);
}

const buf = fs.readFileSync(zipPath);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`已生成 ${src('dist/') ? 'dist/' : ''}${zipName} (${entries.length} 个文件, ${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`SHA256 ${sha}`);