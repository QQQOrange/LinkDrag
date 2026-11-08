'use strict';
/**
 * The detail payload contains a dedicated audio-only DASH track at
 * `video.bit_rate_audio[].audio_meta.url_list`.  Verify the background parser
 * prefers it over the larger muxed video and never treats background music as
 * the spoken track.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');

function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const next = source.indexOf('\nfunction ', start + 10);
  const asyncNext = source.indexOf('\nasync function ', start + 10);
  const ends = [next, asyncNext].filter(index => index > start);
  const end = ends.length ? Math.min(...ends) : source.length;
  return source.slice(start, end).trimEnd();
}

const code = [
  extract('collectDouyinApiUrls'),
  extract('collectDouyinApiAudioUrls'),
  extract('douyinResultFromDetail')
].join('\n');
const api = new Function(code + '\nreturn { douyinResultFromDetail };')();

test('detail parser returns the audio-only DASH track before video', () => {
  const detail = {
    aweme_id: '7674218868219799695',
    desc: '测试视频',
    video: {
      duration: 464468,
      play_addr: { url_list: ['https://cdn.example/main.mp4'], width: 1920, height: 1078, data_size: 20486650 },
      bit_rate_audio: [{
        audio_meta: {
          media_type: 'audio',
          url_list: {
            main_url: 'https://cdn.example/voice-main.m4a',
            backup_url: 'https://cdn.example/voice-backup.m4a',
            fallback_url: 'https://www.douyin.com/aweme/v1/play/?video_id=voice'
          }
        }
      }]
    },
    music: { play_url: { url_list: ['https://cdn.example/background.mp3'] } }
  };
  const result = api.douyinResultFromDetail(detail);
  assert.ok(result);
  assert.equal(result.videoId, detail.aweme_id);
  assert.equal(result.duration, 464);
  assert.deepEqual(result.audio.slice(0, 3), [
    'https://cdn.example/voice-main.m4a',
    'https://cdn.example/voice-backup.m4a',
    'https://www.douyin.com/aweme/v1/play/?video_id=voice'
  ]);
  assert.ok(result.video.includes('https://cdn.example/main.mp4'));
  assert.ok(!result.audio.some(url => /background\.mp3/.test(url)));
});
