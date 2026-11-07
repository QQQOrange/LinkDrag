'use strict';
/**
 * Static regression checks for the security-sensitive parts of the extension.
 * Run with: node --test test/security_static.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const source = read('src/extension.content.js');
const built = read('extension/content.js');

test('generated content is in sync with the canonical source and manifest version', () => {
  assert.equal(built, source.replaceAll('__LPS_VERSION__', manifest.version));
  assert.ok(!built.includes('__LPS_VERSION__'));
  assert.match(built, new RegExp('v' + manifest.version.replaceAll('.', '\\.')));
});

test('page-hosted settings UI uses a closed shadow root', () => {
  assert.match(built, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/);
});

test('stored AI keys are not written into page-side input values', () => {
  const aiField = built.match(/<div class="settings-ai-field"><span>API Key[\s\S]*?<\/div><\/div>/);
  assert.ok(aiField, 'API key field not found');
  assert.match(aiField[0], /data-ai-key="apiKey"\s+value=""/);
  assert.doesNotMatch(aiField[0], /apiKeys\[/);
});

test('reader sandbox cannot execute scripts', () => {
  assert.match(built, /const READER_SANDBOX = '[^']*'/);
  const match = built.match(/const READER_SANDBOX = '([^']*)'/);
  assert.ok(match);
  assert.doesNotMatch(match[1], /allow-scripts/);
});

test('summary appearance stylesheet is mounted inside the closed shadow root', () => {
  const start = built.indexOf('function ensureSummaryAppearanceCSS()');
  const end = built.indexOf('\n  function ', start + 10);
  assert.ok(start >= 0 && end > start);
  const body = built.slice(start, end);
  assert.match(body, /const root = shell && shell\.root/);
  assert.match(body, /\(root \|\| document\.head/);
  assert.doesNotMatch(body, /\(document\.head \|\| document\.documentElement\)\.appendChild/);
});

test('summary uses one content scroller with actions outside it', () => {
  assert.match(built, /const scroll = el\('div', 'summary-scroll'\)/);
  assert.match(built, /body\.appendChild\(scroll\);\s*body\.appendChild\(actions\);/);
  assert.match(built, /\.summary-scroll\{[^}]*overflow-y:auto!important/);
  assert.doesNotMatch(built, /\.media-summary-answer,\.video-summary-answer\{[^}]*overflow:auto!important/);
});

test('DNR rules only touch media CDN Referer headers', () => {
  const rules = JSON.parse(read('extension/rules.json'));
  assert.ok(rules.length > 0);
  const allowedHosts = /douyinvod|byteicdn|bilivideo|twimg/;
  for (const rule of rules) {
    assert.match(rule.condition.urlFilter, allowedHosts);
    assert.deepEqual(rule.action.requestHeaders.map(h => h.header), ['Referer']);
    assert.ok(!rule.condition.resourceTypes || rule.condition.resourceTypes.includes('xmlhttprequest'));
    assert.ok(!rule.condition.resourceTypes || !rule.condition.resourceTypes.includes('media'));
  }
});
