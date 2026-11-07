'use strict';
/**
 * Theme auto-detection must look at UI surfaces, not media pixels.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.content.js'), 'utf8');

test('auto theme samples UI surfaces and excludes media stages', () => {
  assert.match(source, /UI_COLOR_SELECTORS/);
  assert.match(source, /isMediaSurface\(node\)/);
  assert.match(source, /UI ' \+ sel/);
  assert.match(source, /mediaArea \/ area > 0\.55/);
});

test('explicit light/dark still wins over automatic sampling', () => {
  assert.match(source, /settings\.theme === 'light'\) return false/);
  assert.match(source, /settings\.theme === 'dark'\) return true/);
});

test('streaming status uses dots but has no blinking block cursor', () => {
  assert.match(source, /ldp-stream-dots/);
  assert.doesNotMatch(source, /▋/);
  assert.doesNotMatch(source, /ldp-stream-cursor/);
});
