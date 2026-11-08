'use strict';
/**
 * Performance regression guards for the hot paths that run on ordinary pages.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('subtitle probes are bounded and Douyin skips the empty subtitle wait', () => {
  const content = read('src/extension.content.js');
  assert.match(content, /function subtitleProbeBudget/);
  assert.match(content, /if \(\/douyin\\\.com\|iesdouyin\\\.com\|tiktok\\\.com\/i\.test\(host\)\) return 0/);
  assert.match(content, /return 3500/);
  assert.match(content, /const subtitleBudget = subtitleProbeBudget/);
  assert.doesNotMatch(content, /setTimeout\(\(\) => resolve\(null\), 20000\)/);
  const start = content.indexOf('  function subtitleProbeBudget(');
  const end = content.indexOf('\n  async function collectVideoTranscript', start);
  const code = content.slice(start, end).trim();
  const budget = new Function('location', code + '\nreturn subtitleProbeBudget;');
  assert.equal(budget({ hostname: 'www.douyin.com' })({}), 0);
  assert.equal(budget({ hostname: 'example.com' })({}), 3500);
  assert.equal(budget({ hostname: 'www.youtube.com' })({}), 12000);
  assert.equal(budget({ hostname: 'example.com' })({ textTracks: { length: 1 } }), 12000);
});

test('long ASR work uses bounded parallelism while preserving chunk order', () => {
  const offscreen = read('extension/offscreen.js');
  assert.match(offscreen, /const concurrency = Math\.min\(2, totalChunks\)/);
  assert.match(offscreen, /Promise\.all\(Array\.from\(\{ length: concurrency \}/);
  assert.match(offscreen, /const parts = new Array\(totalChunks\)/);
  assert.match(offscreen, /parts\[index\] = one\.text/);
  assert.doesNotMatch(offscreen, /for \(let i = 0; i < totalChunks; i\+\+\)/);
});

test('Douyin detail and shell warm work are cached/cancelled', () => {
  const content = read('src/extension.content.js');
  assert.match(content, /const douyinDetailCache = new Map\(\)/);
  assert.match(content, /douyinDetailCache\.get\(cacheKey\)/);
  assert.match(content, /function cancelShellWarm/);
  assert.match(content, /cancelShellWarm\(\);/);
  assert.match(content, /if \(!shell \|\| !shell\.backdrop \|\| !windows\.length\) return/);
});
