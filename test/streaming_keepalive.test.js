'use strict';
/**
 * Regression checks for long SSE summaries that pause after a partial answer.
 * A service worker with no messages for ~30s can be suspended; the stream must
 * send heartbeats and the UI must recover if the port disconnects.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const bg = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');

test('streaming worker sends keepalive pings and resets idle timeout on deltas', () => {
  assert.match(bg, /type: 'ping'/);
  assert.match(bg, /armTimer\(\)/);
  assert.match(bg, /setInterval\(\(\) => \{/);
});

test('both summary streams clear heartbeats and handle port disconnect', () => {
  assert.match(content, /port\.onDisconnect\.addListener\(\(\) => \{/);
  assert.match(content, /keepAlive = setInterval/);
  assert.match(content, /renderTimer/);
});

test('streaming UI ignores unknown ping messages safely', () => {
  assert.match(content, /msg\.type === 'ping'/);
});
