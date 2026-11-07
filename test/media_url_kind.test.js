'use strict';
/**
 * Regression test for media URL classification.  A YouTube/DASH audio stream
 * often has no useful extension; its `mime` query is the only truth.
 * Run with: node --test test/media_url_kind.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const start = source.indexOf('  function mediaUrlKind(');
const end = source.indexOf('\n  function ', start + 10);
assert.ok(start >= 0 && end > start);
const fnSource = source.slice(start, end).trimEnd();
global.location = { href: 'https://www.youtube.com/watch?v=test' };
const mediaUrlKind = new Function(fnSource + '\nreturn mediaUrlKind;')();

test('mime=audio marks DASH/YouTube stream as audio even when URL ends .m4s', () => {
  assert.equal(mediaUrlKind('https://rr1.googlevideo.com/videoplayback?mime=audio%2Fmp4&itag=140', 'video'), 'audio');
});

test('mime=video remains video', () => {
  assert.equal(mediaUrlKind('https://rr1.googlevideo.com/videoplayback?mime=video%2Fmp4&itag=137', 'audio'), 'video');
});

test('extension and fallback classification still work', () => {
  assert.equal(mediaUrlKind('https://cdn.example/a.mp3', 'video'), 'audio');
  assert.equal(mediaUrlKind('https://cdn.example/a.mp4', 'audio'), 'video');
  assert.equal(mediaUrlKind('https://cdn.example/stream.m4s', 'video'), 'video');
});

test('video download verifies pixels and video summary captures audio fallback', () => {
  assert.match(source, /await probeVideoCandidate\(candidate\)/);
  assert.match(source, /audio = await captureStreamAudio\(/);
  assert.match(source, /captureMediaElementAudio\(captureElement, item\)/);
  assert.match(source, /不会把原始视频发给模型/);
});
