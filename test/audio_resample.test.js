'use strict';
/**
 * Regression test for the 44.1/48 kHz -> 16 kHz WAV conversion used by both
 * the page-side media pipeline (content.js) and the offscreen ASR fallback
 * (offscreen.js).
 *
 * Run with:
 *   node --test test/audio_resample.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' not found');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('Unclosed function ' + name);
}

function loadFunction(file, name) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fnSource = extractFunction(source, name);
  return new Function(fnSource + '\nreturn ' + name + ';')();
}

function makeBuffer(sampleRate, seconds) {
  const length = Math.round(sampleRate * seconds);
  const data = new Float32Array(length);
  // A 0..1 ramp makes an incorrectly scaled source index immediately visible.
  for (let i = 0; i < length; i++) data[i] = i / Math.max(1, length - 1);
  return {
    sampleRate,
    length,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData() { return data; }
  };
}

async function readWav(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  const frames = dataSize / 2;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  return { sampleRate, frames, samples, dataSize };
}

test('content audioBufferToWav keeps duration and source position for a 44.1 kHz chunk', async () => {
  const toWav = loadFunction('extension/content.js', 'audioBufferToWav');
  const buffer = makeBuffer(44100, 2);
  const blob = toWav(buffer, 16000, 1, 16000, 32000);
  const wav = await readWav(blob);
  assert.equal(wav.sampleRate, 16000);
  assert.equal(wav.frames, 16000);
  // One output second starting at output frame 16000 maps to source second 1.
  assert.ok(Math.abs(wav.samples[0] - 0.5) < 0.002, 'first sample should be at source 1.0 s, got ' + wav.samples[0]);
  assert.ok(Math.abs(wav.samples[wav.frames - 1] - (44100 * 2 - 1) / (44100 * 2 - 1)) < 0.002);
  assert.ok(wav.samples[wav.frames - 1] > 0.99, 'last sample should still be real audio, not clamped silence');
});

test('offscreen wavChunk keeps duration and source position for a 48 kHz chunk', async () => {
  const wavChunk = loadFunction('extension/offscreen.js', 'wavChunk');
  const buffer = makeBuffer(48000, 2);
  const blob = wavChunk(buffer, 16000, 16000, 32000);
  const wav = await readWav(blob);
  assert.equal(wav.sampleRate, 16000);
  assert.equal(wav.frames, 16000);
  assert.ok(Math.abs(wav.samples[0] - 0.5) < 0.002, 'first sample should be at source 1.0 s, got ' + wav.samples[0]);
  assert.ok(wav.samples[wav.frames - 1] > 0.99, 'last sample should still be real audio, not clamped silence');
});

test('16 kHz source remains a direct copy', async () => {
  const toWav = loadFunction('extension/content.js', 'audioBufferToWav');
  const buffer = makeBuffer(16000, 1);
  const blob = toWav(buffer, 16000, 1, 0, 16000);
  const wav = await readWav(blob);
  assert.equal(wav.frames, 16000);
  assert.ok(Math.abs(wav.samples[100] - buffer.getChannelData()[100]) < 0.0001);
});
