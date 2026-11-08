'use strict';
/**
 * MSE capture is the fallback when Douyin exposes only a blob player and the
 * detail/API paths do not return a direct URL.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const hook = fs.readFileSync(path.join(ROOT, 'extension/douyin_hook.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

test('MAIN-world hook captures audio-bearing SourceBuffer appends', () => {
  assert.match(hook, /appendBuffer/);
  assert.match(hook, /audio\|video\\\/mp4/);
  assert.match(hook, /LPS_DOUYIN_MSE_RESULT/);
});

test('content script reconstructs and decodes MSE chunks', () => {
  assert.match(content, /requestDouyinMseChunks/);
  assert.match(content, /extractAudioFromMseChunks/);
  assert.match(content, /decodeAudioData/);
});

test('MSE chunks keep separate SourceBuffer ids and MediaSource owners', () => {
  assert.match(hook, /mseBufferSeq/);
  assert.match(hook, /buffer\.__lpsMseId = \+\+mseBufferSeq/);
  assert.match(hook, /buffer\.__lpsMseOwner = this\.__lpsMseOwner/);
  assert.match(hook, /owner: this\.__lpsMseOwner \|\| 0/);
});

test('MSE requests send only the audio track of the current player', () => {
  assert.match(hook, /var audioOnly = owned\.filter/);
  assert.match(hook, /var selected = audioOnly\.length \? audioOnly : owned/);
  assert.match(content, /String\(chunk\.id \|\| 0\) \+ '\|' \+ String\(chunk\.mime \|\| ''\)/);
});

test('detail API reports the aweme id returned by the server', () => {
  assert.match(hook, /var returnedId = String\(detail\.aweme_id \|\| detail\.awemeId \|\| ''\)/);
  assert.match(hook, /awemeId: returnedId/);
  assert.doesNotMatch(hook, /awemeId: awemeId,/);
});

test('background has the mobile item-info fallback for Douyin', () => {
  assert.match(background, /resolveDouyinItemInfo/);
  assert.match(background, /iteminfo/);
});

test('detail API falls back to a cookie-authenticated minimal request when signing is blocked', () => {
  assert.match(hook, /try \{ aBogus = String\(generate_a_bogus/);
  assert.match(hook, /fetchDetailJson\(fullUrl\)\.catch\(function \(\) \{ return fetchDetailJson\(minimalUrl\)/);
  assert.match(hook, /new URLSearchParams\(\{/);
});

test('detail extraction returns the audio-only DASH track before background music', () => {
  assert.match(hook, /videoInfo\.bit_rate_audio/);
  assert.match(hook, /value\.audio_meta/);
  assert.match(hook, /return \{ audio: audio, video: video, music: music \}/);
  assert.match(hook, /music: urls\.music/);
});

test('content accepts a server detail id that matches the canonical video page', () => {
  assert.match(content, /function douyinDetailBoundId/);
  assert.match(content, /pageVideoId && detailId === pageVideoId/);
  assert.match(content, /detail\.audio && detail\.audio\.length/);
  assert.match(content, /candidate\.kind = 'audio'/);
  assert.match(content, /state\.boundAwemeId = detailId/);
});

test('canonical video pages request detail even without a DOM id', () => {
  assert.match(content, /canonicalVideoPage = \/\\\/video\\\/\\d\+\/\.test\(location\.pathname\)/);
  assert.match(content, /\(currentId \|\| canonicalVideoPage\) \? await requestDouyinDetail/);
});

test('detail download keeps the muxed video and audio-only track as candidates', () => {
  assert.match(content, /function appendDouyinDetailCandidates/);
  assert.match(content, /kind: 'video', url: videoUrl/);
  assert.match(content, /kind: 'audio', url: audioUrl/);
  assert.match(content, /verifiedVideo: true/);
  assert.match(content, /candidate\.verifiedVideo \|\| await probeVideoCandidate/);
  assert.match(content, /appendDouyinDetailCandidates\(state\.list/);
});

test('download filename follows the real media container', () => {
  assert.match(content, /const match = path\.match\(\/\\\.\(webm\|mov\|mkv/);
});

test('subtitle summaries expose video and audio downloads', () => {
  assert.match(content, /downloadVideoFromSummary/);
  assert.match(content, /downloadAudioFromSummary/);
  assert.match(content, /ensureMediaForDownload/);
  assert.match(content, /const direct = candidate =>/);
  assert.match(content, /return direct\(b\) - direct\(a\)/);
});
