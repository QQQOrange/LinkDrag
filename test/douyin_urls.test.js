'use strict';
/**
 * Regression tests for Douyin page-data URL traversal.
 * Run with: node --test test/douyin_urls.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/extension.content.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const plainEnd = source.indexOf('\n  function ', start + 10);
  const asyncEnd = source.indexOf('\n  async function ', start + 10);
  const end = plainEnd >= 0 && (asyncEnd < 0 || plainEnd < asyncEnd) ? plainEnd : asyncEnd;
  assert.ok(end > start, name + ' end');
  return source.slice(start, end).trimEnd();
}
const code = [
  'const douyinCapturedUrls = [];',
  'pushDouyinUrl',
  'collectDouyinAudioUrls',
  'collectDouyinUrls',
  'douyinAwemeIdFromUrl',
  'douyinUrlMatchesAweme',
  'douyinDurationSeconds',
  'douyinUrlParam',
  'isSafeRemoteUrl',
  'douyinAudioTracksForVideo',
  'douyinAudioTrackForVideo',
  'reactAwemeIdFromNode',
  'awemeIdFromVideo',
  'videoActivityScore',
  'selectMediaCandidate'
].map((name, index) => index === 0 ? name : extract(name)).join('\n');
global.location = { hostname: 'www.douyin.com', href: 'https://www.douyin.com/?recommend=1' };
global.window = { URL, innerHeight: 900 };
const api = new Function(code + '\nreturn { pushDouyinUrl, collectDouyinAudioUrls, collectDouyinUrls, douyinAwemeIdFromUrl, douyinUrlMatchesAweme, douyinDurationSeconds, douyinUrlParam, douyinAudioTrackForVideo, awemeIdFromVideo, selectMediaCandidate };')();

test('collects music.play_url object and string forms', () => {
  const out = [];
  api.collectDouyinAudioUrls({
    music: {
      play_url: { url_list: ['https://cdn.example/music.m4a'] },
      play_url_h264: 'https://cdn.example/music-fallback.mp3'
    }
  }, out, 0, '');
  assert.deepEqual(out, ['https://cdn.example/music.m4a', 'https://cdn.example/music-fallback.mp3']);
});

test('collects all video play_addr variants used by Douyin detail payloads', () => {
  const out = [];
  api.collectDouyinUrls({
    video: {
      play_addr: { url_list: ['https://cdn.example/main.mp4'] },
      play_addr_h264: { url_list: ['https://cdn.example/h264.mp4'] },
      play_addr_bytevc1: { url_list: ['https://cdn.example/hevc.m4s'] },
      bit_rate: [{ play_addr: { url_list: ['https://cdn.example/rate.mp4'] } }]
    }
  }, out, 0);
  assert.ok(out.includes('https://cdn.example/main.mp4'));
  assert.ok(out.includes('https://cdn.example/h264.mp4'));
  assert.ok(out.includes('https://cdn.example/hevc.m4s'));
  assert.ok(out.includes('https://cdn.example/rate.mp4'));
});

test('Douyin candidate selection prefers a playing video over background music', () => {
  const audio = { kind: 'audio', url: 'https://cdn.example/music.mp3' };
  const element = {
    isConnected: true, paused: false, currentTime: 2, readyState: 4, videoWidth: 1080,
    getBoundingClientRect: () => ({ width: 1080, height: 1920, top: 0, bottom: 800 })
  };
  const video = { kind: 'video', url: 'blob:https://www.douyin.com/abc', element };
  assert.equal(api.selectMediaCandidate({ list: [audio, video] }), video);
});

test('Douyin candidate selection binds the exact clicked player', () => {
  const anchor = {
    isConnected: true, paused: true, currentTime: 0, readyState: 2, videoWidth: 720,
    getBoundingClientRect: () => ({ width: 720, height: 1280, top: 0, bottom: 800 })
  };
  const old = {
    isConnected: true, paused: false, currentTime: 4, readyState: 4, videoWidth: 1080,
    getBoundingClientRect: () => ({ width: 1080, height: 1920, top: 0, bottom: 800 })
  };
  const anchorCandidate = { kind: 'video', url: 'blob:https://www.douyin.com/current', element: anchor };
  const oldCandidate = { kind: 'video', url: 'https://cdn.example/previous.mp4', element: old };
  assert.equal(api.selectMediaCandidate({ list: [oldCandidate, anchorCandidate], anchorVideo: anchor }), anchorCandidate);
});

test('Douyin ID lookup is anchored to the clicked player', () => {
  assert.match(source, /currentDouyinAwemeId\(anchorVideo\)/);
  assert.match(source, /awemeIdFromVideo\(anchorVideo\)/);
  assert.match(source, /candidate\.element === anchor/);
  assert.match(source, /data-lps-current-video/);
});

test('aweme ids are read from the exact player container', () => {
  const id = '7696555682748796223';
  const holder = {
    getAttribute: name => (name === 'data-e2e-vid' ? id : null),
    attributes: [{ name: 'data-e2e-vid', value: id }],
    outerHTML: `<div data-e2e-vid="${id}"></div>`,
    parentElement: null
  };
  const video = { poster: '', currentSrc: 'blob:https://www.douyin.com/current', src: '', parentElement: holder };
  assert.equal(api.awemeIdFromVideo(video), id);
});

test('aweme ids are read from the video_<id> player wrapper class', () => {
  const id = '7674218868219799695';
  const holder = {
    getAttribute: () => null,
    attributes: [],
    className: `wgoQOERl dfr1ZVT2 video_${id} video-detail-container newVideoPlayer`,
    outerHTML: `<div class="video_${id}"></div>`,
    parentElement: null
  };
  const video = { poster: '', currentSrc: 'blob:https://www.douyin.com/current', src: '', parentElement: holder };
  assert.equal(api.awemeIdFromVideo(video), id);
});

test('signed media URLs only match when they name the same aweme', () => {
  const id = '7696555682748796223';
  assert.equal(api.douyinAwemeIdFromUrl(`https://www.douyin.com/video/${id}`), id);
  assert.equal(api.douyinUrlMatchesAweme(`https://cdn.example/video.mp4?aweme_id=${id}`, id), true);
  assert.equal(api.douyinUrlMatchesAweme('https://lf6-effectcdn-tos.byteeffecttos.com/obj/effect.mp4', id), false);
  assert.equal(api.douyinUrlMatchesAweme(`https://cdn.example/video.mp4?aweme_id=${id.slice(0, -1)}4`, id), false);
});

test('detail duration is normalized and the returned aweme is checked', () => {
  assert.equal(api.douyinDurationSeconds(60123), 60.123);
  assert.match(source, /detailId === String\(currentId\)/);
  assert.match(source, /Math\.abs\(douyinDurationSeconds\(detailDuration\) - mediaDuration\) < 3/);
});

test('Douyin selection never falls through to an unbound URL', () => {
  const anchor = {
    isConnected: true, paused: false, currentTime: 2, readyState: 4, videoWidth: 1080,
    getBoundingClientRect: () => ({ width: 1080, height: 1920, top: 0, bottom: 800 })
  };
  const exact = { kind: 'video', srcKind: 'blob', url: 'blob:https://www.douyin.com/current', element: anchor };
  const unrelated = { kind: 'video', srcKind: 'direct', url: 'https://cdn.example/effect.mp4', element: null, unbound: true };
  assert.equal(api.selectMediaCandidate({ list: [unrelated, exact], anchorVideo: anchor }), exact);
  assert.equal(api.selectMediaCandidate({ list: [unrelated], anchorVideo: anchor }), null);
});

test('summary no longer calls an unbound Douyin URL resolver', () => {
  assert.doesNotMatch(source, /resolveDouyinMediaUrl\(\)/);
  assert.doesNotMatch(source, /resolveDouyinAudioUrl\(\)/);
  assert.match(source, /resolveDouyinMediaUrl\(anchorVideo\)/);
});

test('paired Douyin audio requests are bound by the current request log token', () => {
  const current = 'https://v26-web.douyinvod.com/video/tos/cn/video.mp4?br=3208&l=LOG-123';
  global.window.performance = {
    getEntriesByType: () => [
      { name: 'https://v26-web.douyinvod.com/video/tos/cn/media-audio-und-mp4a/?l=LOG-999' },
      { name: 'https://v26-web.douyinvod.com/video/tos/cn/media-audio-und-mp4a/?l=LOG-123' }
    ]
  };
  assert.equal(api.douyinAudioTrackForVideo({ currentSrc: current }), 'https://v26-web.douyinvod.com/video/tos/cn/media-audio-und-mp4a/?l=LOG-123');
  delete global.window.performance;
  assert.equal(api.douyinAudioTrackForVideo({ currentSrc: current }), '');
});

test('the video branch tries the bound audio-only track before giving up', () => {
  assert.match(source, /const pairedAudioUrls = douyinHost \? douyinAudioTracksForVideo\(anchorVideo\)/);
  assert.match(source, /const boundAudioCandidates = \(state\.list \|\| \[\]\)\.filter/);
  assert.match(source, /const attempt = await extractAudioFromUrl\(audioEntry\)/);
  assert.match(source, /payload = \{ kind: 'audio', url: boundAudioCandidate\.url, returnTranscript: true/);
  assert.match(source, /payload\.kind === 'audio' && \(payload\.url \|\| payload\.transcript\)/);
});

test('long audio candidates are transcribed in the offscreen worker before in-page decoding', () => {
  assert.match(source, /const remote = await requestRemoteTranscript\(audioEntry\)/);
  assert.match(source, /audioTranscript = remote\.text/);
  assert.match(source, /payload = \{ kind: 'audio', transcript: audioTranscript, returnTranscript: true/);
  assert.match(source, /远程转写超过 900 秒没有返回/);
});
