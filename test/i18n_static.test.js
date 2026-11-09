'use strict';
/**
 * Static checks for the LinkDrag 1.0 rename and bilingual UI.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('manifest is LinkDrag 1.1.20', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.name, 'LinkDrag');
  assert.equal(manifest.version, '1.1.20');
  assert.ok(manifest.permissions.includes('webRequest'));
  // Content scripts do not consume LinkDragI18N; loading the 20 KB language
  // layer into every frame duplicated storage work for no UI effect.
  assert.ok(manifest.content_scripts[0].js.includes('content.js'));
  assert.ok(!manifest.content_scripts[0].js.includes('i18n.js'));
});

test('popup, options and side panel load the language layer', () => {
  for (const file of ['popup.html', 'options.html', 'sidepanel.html']) {
    assert.match(read('extension/' + file), /<script src="i18n\.js"><\/script>/);
  }
  assert.match(read('extension/options.html'), /id="language"/);
});

test('default language is Simplified Chinese and English is supported', () => {
  const i18n = read('extension/i18n.js');
  assert.match(i18n, /DEFAULT_LANGUAGE = 'zh-CN'/);
  assert.match(i18n, /'Interface language'/);
  const source = read('src/extension.content.js');
  assert.match(source, /language: 'zh-CN'/);
  assert.match(source, /language: \['zh-CN', 'en'\]/);
});















