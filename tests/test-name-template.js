// 回归测试：v4.4.1 文件名命名模板 expandNameTemplate
//
// 与 test-dns-v429.js / test-ssrf-p03.js 同套做法：从源码里抽出实现，
// 在纯 Node 下直接断言，不依赖浏览器与下载页上下文。
// 重点保护两条契约：
//   1. 模板里没有 {…} 时行为必须与旧版「固定自定义名」完全一致（不能有回归）；
//   2. 未识别的 {xxx} 原样保留，不做静默删除。
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'download-page', 'download.js'), 'utf8');

const extracted = src.match(/function expandNameTemplate[\s\S]*?\n  \}/);
if (!extracted) {
  console.error('FAIL 未能从 download-page/download.js 抽出 expandNameTemplate');
  process.exit(1);
}
if (!/expandNameTemplate\(safeDecodeName\(settings\.customName\)\)/.test(src)) {
  console.error('FAIL generateFileName 未把自定义名送进 expandNameTemplate');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`}`);
  ok ? pass++ : fail++;
}

const build = ([videoName, videoUrl, videoQuality, videoFormat, videoType]) =>
  new Function('videoName', 'videoUrl', 'videoQuality', 'videoFormat', 'videoType',
    extracted[0] + '; return expandNameTemplate;')(videoName, videoUrl, videoQuality, videoFormat, videoType);

const fn = build(['My Video', 'https://www.example.com/a/b.mp4', '1080p', 'mp4', 'direct']);

// 1. 旧行为不变
check('无变量时原样返回（旧行为）', fn('我的视频'), '我的视频');
check('空串安全', fn(''), '');
check('无 { 时不做替换', fn('a}b{'), 'a}b{');

// 2. 变量展开
check('{title}', fn('{title}'), 'My Video');
check('{site} 去掉 www.', fn('{site}'), 'example.com');
check('{quality}.{format}', fn('{title}-{quality}.{format}'), 'My Video-1080p.mp4');
check('{type}', fn('{type}'), 'direct');
check('变量名大小写不敏感', fn('{TITLE}'), 'My Video');
check('多变量组合', fn('{site}_{title}_{quality}'), 'example.com_My Video_1080p');

// 3. 未知变量与异常输入
check('未识别变量原样保留', fn('{foo}-{title}'), '{foo}-My Video');
check('日期形如 YYYY-MM-DD', /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fn('{date}')), true);
check('时间形如 HHMM', /^[0-9]{4}$/.test(fn('{time}')), true);

const bad = build(['N', 'not a url', '', '', '']);
check('非法 URL 时 {site} 为空且不抛错', bad('{site}'), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
