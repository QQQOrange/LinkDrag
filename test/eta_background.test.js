'use strict';
/**
 * Static checks for the summary ETA estimator and background capture fallback.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.content.js'), 'utf8');

test('summary ETA uses live samples, stage floors and a stall allowance', () => {
  assert.match(source, /summaryLoadingSamples/);
  assert.match(source, /summaryLoadingLastProgressAt/);
  assert.match(source, /summaryStageFloor/);
  assert.match(source, /Math\.min\(45, stall\)/);
  assert.match(source, /startSummaryLoadingTicker/);
});

test('MediaSource clone fallback is not rejected solely by duration', () => {
  const start = source.indexOf('async function createBackgroundVideo');
  assert.ok(start >= 0);
  const end = source.indexOf('\n  async function captureMediaElementAudio', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /Number\.isFinite\(Number\(clone\.duration\)\)/);
  assert.match(block, /data-lps-current-video|MediaSource/);
});
