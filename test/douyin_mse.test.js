'use strict';
/**
 * MSE capture is the fallback when Douyin exposes only a blob player and the
 * detail/API paths do not return a direct URL.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const hook = fs.readFileSync(path.join(ROOT, 'extension/douyin_hook.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

test('MAIN-world hook captures audio-bearing SourceBuffer appends', () => {
  assert.match(hook, /appendBuffer/);
  assert.match(hook, /audio\|video\\\/mp4/);
  assert.match(hook, /LPS_DOUYIN_MSE_RESULT/);
});

test('content script reconstructs and decodes MSE chunks', () => {
  assert.match(content, /requestDouyinMseChunks/);
  assert.match(content, /extractAudioFromMseChunks/);
  assert.match(content, /decodeAudioData/);
});

test('background has the mobile item-info fallback for Douyin', () => {
  assert.match(background, /resolveDouyinItemInfo/);
  assert.match(background, /iteminfo/);
});
