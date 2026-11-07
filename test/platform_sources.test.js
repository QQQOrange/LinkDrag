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
