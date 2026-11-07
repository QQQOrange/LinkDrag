'use strict';
/**
 * Regression tests for Douyin page-data URL traversal.
 * Run with: node --test test/douyin_urls.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const plainEnd = source.indexOf('\n  function ', start + 10);
  const asyncEnd = source.indexOf('\n  async function ', start + 10);
  const end = plainEnd >= 0 && (asyncEnd < 0 || plainEnd < asyncEnd) ? plainEnd : asyncEnd;
  assert.ok(end > start, name + ' end');
  return source.slice(start, end).trimEnd();
}
const code = ['pushDouyinUrl', 'collectDouyinAudioUrls', 'collectDouyinUrls', 'videoActivityScore', 'selectMediaCandidate'].map(extract).join('\n');
global.location = { hostname: 'www.douyin.com' };
global.window = { innerHeight: 900 };
const api = new Function(code + '\nreturn { pushDouyinUrl, collectDouyinAudioUrls, collectDouyinUrls, selectMediaCandidate };')();

test('collects music.play_url object and string forms', () => {
  const out = [];
  api.collectDouyinAudioUrls({
    music: {
      play_url: { url_list: ['https://cdn.example/music.m4a'] },
      play_url_h264: 'https://cdn.example/music-fallback.mp3'
    }
  }, out, 0, '');
  assert.deepEqual(out, ['https://cdn.example/music.m4a', 'https://cdn.example/music-fallback.mp3']);
});

test('collects all video play_addr variants used by Douyin detail payloads', () => {
  const out = [];
  api.collectDouyinUrls({
    video: {
      play_addr: { url_list: ['https://cdn.example/main.mp4'] },
      play_addr_h264: { url_list: ['https://cdn.example/h264.mp4'] },
      play_addr_bytevc1: { url_list: ['https://cdn.example/hevc.m4s'] },
      bit_rate: [{ play_addr: { url_list: ['https://cdn.example/rate.mp4'] } }]
    }
  }, out, 0);
  assert.ok(out.includes('https://cdn.example/main.mp4'));
  assert.ok(out.includes('https://cdn.example/h264.mp4'));
  assert.ok(out.includes('https://cdn.example/hevc.m4s'));
  assert.ok(out.includes('https://cdn.example/rate.mp4'));
});

test('Douyin candidate selection prefers a playing video over background music', () => {
  const audio = { kind: 'audio', url: 'https://cdn.example/music.mp3' };
  const element = {
    isConnected: true, paused: false, currentTime: 2, readyState: 4, videoWidth: 1080,
    getBoundingClientRect: () => ({ width: 1080, height: 1920, top: 0, bottom: 800 })
  };
  const video = { kind: 'video', url: 'blob:https://www.douyin.com/abc', element };
  assert.equal(api.selectMediaCandidate({ list: [audio, video] }), video);
});
