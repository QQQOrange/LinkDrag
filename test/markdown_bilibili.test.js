'use strict';
/**
 * Markdown rendering, Bilibili progressive download and Douyin binding guards.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'extension/douyin_hook.js'), 'utf8');

function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const candidates = [source.indexOf('\n  function ', start + 10), source.indexOf('\n  async function ', start + 10)]
    .filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end).trimEnd();
}

const api = new Function(extract('markdownToHtml') + '\nreturn markdownToHtml;')();

test('markdown renders GitHub-style tables with alignment', () => {
  const html = api('| 指标 | 数值 |\n|:---|---:|\n| 时长 | 12:30 |\n| 大小 | 42MB |');
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th style="text-align:left">指标<\/th>/);
  assert.match(html, /<th style="text-align:right">数值<\/th>/);
  assert.match(html, /<td style="text-align:left">时长<\/td><td style="text-align:right">12:30<\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});

test('markdown renders images without breaking links', () => {
  const html = api('![封面](https://example.com/a.png) 和 [链接](https://example.com)');
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png" alt="封面" loading="lazy"/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank"/);
  assert.doesNotMatch(html, /!\[/);
});

test('markdown rejects non-http image sources and renders task lists', () => {
  const html = api('![x](javascript:alert(1))\n\n- [x] 已完成\n- [ ] 未完成');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<ul class="md-tasks">/);
  assert.match(html, /md-task md-task-done[^>]*><input type="checkbox" disabled checked>/);
});

test('Bilibili uses the progressive MP4 endpoint for downloads', () => {
  assert.match(background, /async function resolveBilibiliVideo/);
  assert.match(background, /platform=html5&high_quality=1/);
  assert.match(background, /data\.durl/);
  assert.match(background, /ldp:resolveBilibiliVideo/);
  assert.match(source, /async function bilibiliProgressiveMedia/);
  assert.match(source, /async function downloadBilibiliVideo/);
  assert.match(source, /async function downloadBilibiliAudio/);
  assert.match(source, /downloadOnly: true/);
});

test('Douyin detail requests are bound to an explicit aweme id', () => {
  assert.match(hook, /if \(preferred && \/\^\\d\{10,\}\$\/\.test\(String\(preferred\)\)\) return String\(preferred\);\s*\n\s*function idFromVideo/);
  assert.match(source, /const explicitId = \/\^\\d\{10,\}\$\/\.test\(requested\) \? requested : currentDouyinAwemeId\(anchorVideo\)/);
  assert.match(source, /String\(value\.awemeId\) === String\(explicitId\)/);
  assert.match(source, /awemeId: explicitId \|\| ''/);
});
