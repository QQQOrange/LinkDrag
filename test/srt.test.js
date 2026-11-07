'use strict';
/**
 * Regression tests for SRT subtitle generation.
 * Run with: node --test test/srt.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');

function extractFunction(name) {
  const marker = '  function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, name + ' not found');
  const next = source.indexOf('\n  function ', start + marker.length);
  assert.notEqual(next, -1, name + ' end not found');
  return source.slice(start, next).trimEnd();
}

const code = [
  'decodeSubtitleEntities',
  'subtitleTimeValue',
  'parseSubtitleCues',
  'srtTimestamp',
  'normalizeSrtText',
  'splitTranscriptSegments',
  'buildSrtDocument'
].map(name => extractFunction(name)).join('\n');
const api = new Function(code + '\nreturn { parseSubtitleCues, buildSrtDocument, srtTimestamp };')();

test('parses WebVTT timestamps and keeps cue text', () => {
  const cues = api.parseSubtitleCues(`WEBVTT

00:00:01.000 --> 00:00:03.200
第一句 &amp; 第二句

00:00:03.400 --> 00:00:05.000 align:start
<b>第三条</b>
`);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.2);
  assert.equal(cues[0].text, '第一句 & 第二句');
  assert.equal(cues[1].text, '第三条');
});

test('builds a valid SRT from known cues', () => {
  const srt = api.buildSrtDocument('第一句\n第二句', [
    { start: 1, end: 3.2, text: '第一句' },
    { start: 3.4, end: 5, text: '第二句' }
  ], 5);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,200\n第一句\n\n2\n/);
  assert.match(srt, /00:00:03,400 --> 00:00:05,000\n第二句\n$/);
});

test('builds monotonic fallback cues when a transcript has no timestamps', () => {
  const srt = api.buildSrtDocument('第一段内容。\n第二段内容。\n第三段内容。', [], 9);
  const blocks = srt.trim().split(/\n\n/);
  assert.equal(blocks.length, 3);
  const times = blocks.map(block => block.split('\n')[1]).map(line => {
    const match = line.match(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/);
    assert.ok(match, line);
    return [Number(match[1].slice(0, 2)) * 3600 + Number(match[1].slice(3, 5)) * 60 + Number(match[1].slice(6, 8)), Number(match[2].slice(0, 2)) * 3600 + Number(match[2].slice(3, 5)) * 60 + Number(match[2].slice(6, 8))];
  });
  assert.ok(times[0][0] < times[1][0] && times[1][0] < times[2][0]);
  assert.ok(times[2][1] <= 9.01);
});

test('formats hour-scale timestamps', () => {
  assert.equal(api.srtTimestamp(3661.234), '01:01:01,234');
});
