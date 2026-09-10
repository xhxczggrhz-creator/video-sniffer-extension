// 验证 mp4box.min.js 关键 API：AudioSampleEntry.write、sampleEntryCodes 注册表
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mp4box.min.js'), 'utf8');

const MP4Box = require('../lib/mp4box.min.js');
console.log('exports:', Object.keys(MP4Box));

// AudioSampleEntry.write 序列化（确认 samplerate 是否定点）
const w = src.indexOf('AudioSampleEntry.prototype.write');
console.log('\n--- AudioSampleEntry.write ---');
console.log(src.slice(w, w + 600));

// sampleEntryCodes 注册表
const m = src.indexOf('sampleEntryCodes.Audio');
console.log('\nsampleEntryCodes.Audio idx:', m);
if (m > 0) console.log(src.slice(m - 200, m + 200));

// createFile 后的 writeFile / save 接口
console.log('\n--- createFile API ---');
const f = MP4Box.createFile();
console.log('has addTrack:', typeof f.addTrack);
console.log('has addSample:', typeof f.addSample);
console.log('has getBuffer:', typeof f.getBuffer);
console.log('has onReady setter: yes (property)');
