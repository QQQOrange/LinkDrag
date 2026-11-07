'use strict';
/**
 * Static checks for the opt-in GitHub update notifier.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('manifest allows notifications and the background checks GitHub', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.ok(manifest.permissions.includes('notifications'));
  const bg = read('extension/background.js');
  assert.match(bg, /api\.github\.com\/repos\/\$\{UPDATE_REPO\}\/releases\/latest/);
  assert.match(bg, /Authorization = 'Bearer '/);
  assert.match(bg, /scheduleUpdateCheck\('startup'\)/);
});

test('update UI exposes a token field, manual check and release link', () => {
  const options = read('extension/options.html');
  assert.match(options, /id="updateToken"/);
  assert.match(options, /id="checkUpdate"/);
  assert.match(options, /id="openUpdate"/);
  const popup = read('extension/popup.html');
  assert.match(popup, /id="updateBanner"/);
});

test('update checker never downloads an update automatically', () => {
  const bg = read('extension/background.js');
  assert.doesNotMatch(bg, /chrome\.downloads\.download\([^)]*update/i);
  assert.match(bg, /chrome\.tabs\.create\(\{ url \}\)/);
});
