'use strict';
/**
 * Static checks for the platform discovery additions inspired by Videdown.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Douyin detail API and bit_rate play_addr are part of the resolver', () => {
  const background = read('extension/background.js');
  assert.match(background, /aweme\/v1\/web\/aweme\/detail/);
  assert.match(background, /bit_rate/);
  assert.match(background, /collectDouyinApiUrls/);
});

test('Douyin detail resolver keeps audio-only tracks and reuses a first-party tab', () => {
  const background = read('extension/background.js');
  const content = read('src/extension.content.js');
  assert.match(background, /collectDouyinApiAudioUrls/);
  assert.match(background, /bit_rate_audio/);
  assert.match(background, /audio_meta/);
  assert.match(background, /resolveDouyinViaTab/);
  assert.match(background, /chrome\.tabs\.create\(\{ url: 'https:\/\/www\.douyin\.com\/video\/'/);
  assert.match(background, /chrome\.tabs\.query\(\{ url: \['https:\/\/\*\.douyin\.com\/\*'/);
  assert.match(content, /requestDouyinResolve/);
  assert.match(content, /openDouyinLinkSummary/);
  assert.match(content, /ldp:summary-link/);
});

test('video downloads send a first-party Referer', () => {
  const background = read('extension/background.js');
  const content = read('src/extension.content.js');
  const rules = JSON.parse(read('extension/rules.json'));
  assert.match(content, /type: 'ldp:downloadMedia'/);
  assert.match(content, /fetch\(url, \{ credentials: 'same-origin' \}\)/);
  assert.match(background, /saveAs: false/);
  assert.ok(rules.some(rule => /douyinvod/.test(rule.condition.urlFilter)
    && rule.condition.resourceTypes.includes('other')));
});

test('platform page declarations and CDN patterns are covered', () => {
  const source = read('src/extension.content.js');
  assert.match(source, /pageDeclaredMediaUrls/);
  assert.match(source, /og:video/);
  assert.match(source, /application\/ld\+json/);
  assert.match(source, /kwimgs/);
  assert.match(source, /xhscdn/);
  assert.match(source, /cdninstagram/);
});

test('Kuaishou GraphQL resolver is wired into the background worker', () => {
  const background = read('extension/background.js');
  assert.match(background, /visionVideoDetail/);
  assert.match(background, /ldp:resolveKuaishou/);
  assert.match(read('src/extension.content.js'), /requestKuaishouResolve/);
});
