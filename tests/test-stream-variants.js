// 回归测试：画质自选 HLS 主清单档位解析 parseHlsVariants
//
// 与 test-name-template.js 同套做法：从源码里抽出实现，在纯 Node 下断言。
// 重点保护三条容易悄悄坏掉的契约：
//   1. 档位顺序（高→低）与 label 推导（RESOLUTION 高度优先，缺省退码率）；
//   2. BANDWIDTH 必须锚定 —— 否则 AVERAGE-BANDWIDTH= 会被抢匹配，档位码率错乱；
//   3. 相对 URI 必须按主清单地址解析 —— 否则选档后下的是不存在的路径。
// （parseDashVariants 依赖 DOMParser，属浏览器环境，不在此测。）
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'popup', 'popup.js'), 'utf8');

// 从 popup.js 抽出被断言的原函数体（项目惯例：不建框架，纯 Node 下直接断言）
function extract(name) {
  const m = src.match(new RegExp('function ' + name + '[\\s\\S]*?\\n  \\}'));
  if (!m) {
    console.error(`FAIL 未能从 popup/popup.js 抽出 ${name}`);
    process.exit(1);
  }
  return m[0];
}

if (!/parseHlsVariants\(text, video\.url\)/.test(src)) {
  console.error('FAIL popup.js 的通用流媒体分支未调用 parseHlsVariants');
  process.exit(1);
}

const parseHlsVariants = new Function(extract('parseHlsVariants') + '; return parseHlsVariants;')();

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`}`);
  ok ? pass++ : fail++;
}

const BASE = 'https://cdn.example.com/hls/master.m3u8';

// 1. 标准三档主清单（顺序故意打乱）
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  '360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
  '1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720',
  '720/index.m3u8',
].join('\n');

const v = parseHlsVariants(master, BASE);
check('档位数', v.length, 3);
check('高→低排序', v.map(x => x.height), [1080, 720, 360]);
check('label 取 RESOLUTION 高度', v.map(x => x.label), ['1080P', '720P', '360P']);
check('AVERAGE-BANDWIDTH 不抢 BANDWIDTH', v[1].bandwidth, 2000000);
check('相对 URI 按主清单地址解析', v[0].url, 'https://cdn.example.com/hls/1080/index.m3u8');

// 2. 缺 RESOLUTION → 退码率 label
const noRes = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\na.m3u8\n';
check('缺 RESOLUTION 时降级 kbps', parseHlsVariants(noRes, BASE)[0].label, '1500kbps');

// 3. 媒体清单（非主清单）/ 单档位
check('媒体清单无档位', parseHlsVariants('#EXTM3U\n#EXTINF:9,\nseg0.ts\n', BASE), []);
const one = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nonly.m3u8\n';
check('单档位仍返回 1 条（调用方据此判定无可选）', parseHlsVariants(one, BASE).length, 1);

// 4. 空行/注释干扰下的变体地址提取 + 同址去重
const dup = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n\n# 注释行\nsame.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nsame.m3u8\n';
check('跳过空行与注释取 URI，同址去重', parseHlsVariants(dup, BASE).length, 1);

// 5. 异常输入不得抛错（popup 里紧跟着 showToast 降级）
check('空文本', parseHlsVariants('', BASE), []);
check('null 文本', parseHlsVariants(null, BASE), []);
check('绝对 URI 不依赖 baseUrl', parseHlsVariants(
  '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=2x2\nhttps://x/a.m3u8\n', 'not a url')[0].url,
  'https://x/a.m3u8');

// 6. B站双轨选档：显式选档必须丢「标准 MP4 直链」且不得污染原条目
//    （直链固定 1080P，下载页策略 1 优先用它 —— 不丢则选择完全失效；
//     弹窗列表是从原数组重绘的，就地改写会让"取消"无从谈起）
const withBiliChoice = new Function(extract('withBiliChoice') + '; return withBiliChoice;')();
const hasQualityOptions = new Function(extract('hasQualityOptions') + '; return hasQualityOptions;')();

const biliEntry = {
  url: 'https://upos.example/best.m4s',
  type: 'bilibili-merged',
  quality: '1080P',
  biliData: {
    videoUrl: 'V-1080', audioUrl: 'A-192', directUrl: 'D-1080',
    directSize: 123, allVideoStreams: [{ url: 'V-1080' }, { url: 'V-720' }],
  },
};
const v2 = { url: 'V-720', height: 720, width: 1280, bandwidth: 2000000, codecs: 'avc1.640028' };
const a2 = { url: 'A-132', bandwidth: 132000, codecs: 'mp4a.40.2' };
const picked = withBiliChoice(biliEntry, v2, a2);

check('选中视频轨写入 videoUrl', picked.biliData.videoUrl, 'V-720');
check('选中音频轨写入 audioUrl', picked.biliData.audioUrl, 'A-132');
check('显式选档丢弃标准 MP4 直链', picked.biliData.directUrl, '');
check('quality 跟随选中档位', picked.quality, '720P');
check('原条目 videoUrl 未被就地改写', biliEntry.biliData.videoUrl, 'V-1080');
check('原条目 directUrl 未被就地改写', biliEntry.biliData.directUrl, 'D-1080');
check('只选音轨时视频轨保持默认', withBiliChoice(biliEntry, null, a2).biliData.videoUrl, 'V-1080');
check('allVideoStreams 仍挂在结果上', picked.biliData.allVideoStreams.length, 2);

// hasQualityOptions：双轨多档 → true；单轨直链 → false
check('双轨多档给出画质入口', hasQualityOptions(biliEntry), true);
check('单档直链条目不给入口', hasQualityOptions({ url: 'https://x/a.mp4', type: 'direct' }), false);
check('音频轨条目不给入口', hasQualityOptions({ url: 'https://x/a.m3u8', type: 'stream', track: 'audio' }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);