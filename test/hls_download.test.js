'use strict';
/**
 * HLS playlist parsing and the sniffer's media classification.
 * Both are shared with the service worker (extension/hls.js) so the browser and
 * these tests exercise exactly the same code.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const hls = require(path.join(__dirname, '..', 'extension', 'hls.js'));

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720
high/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg1.ts
#EXTINF:2.5,
seg2.ts
#EXT-X-ENDLIST
`;

const LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
live1.ts
#EXTINF:4.0,
live2.ts
`;

test('parses a media playlist into absolute segment URLs', () => {
  const parsed = hls.parse(MEDIA, 'https://cdn.example.com/vod/index.m3u8');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'media');
  assert.deepEqual(parsed.segments, [
    'https://cdn.example.com/vod/seg1.ts',
    'https://cdn.example.com/vod/seg2.ts'
  ]);
  assert.equal(parsed.duration, 6.5);
  assert.equal(parsed.live, false);
});

test('parses a master playlist and picks the highest resolution variant', () => {
  const parsed = hls.parse(MASTER, 'https://cdn.example.com/vod/master.m3u8');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'master');
  assert.equal(parsed.variants.length, 2);
  // Highest bandwidth first.
  assert.equal(parsed.variants[0].bandwidth, 900000);
  assert.equal(hls.bestVariant(parsed), 'https://cdn.example.com/vod/high/index.m3u8');
});

test('detects live playlists and AES encryption', () => {
  assert.equal(hls.parse(LIVE, 'https://x.test/live.m3u8').live, true);
  const encrypted = hls.parse(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\na.ts\n',
    'https://x.test/e.m3u8'
  );
  assert.equal(encrypted.encrypted, true);
  assert.equal(encrypted.keyMethod, 'AES-128');
});

test('METHOD=NONE is not treated as encrypted', () => {
  const parsed = hls.parse('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n', 'https://x.test/a.m3u8');
  assert.equal(parsed.encrypted, false);
});

test('rejects documents that are not playlists', () => {
  const parsed = hls.parse('<html>nope</html>', 'https://x.test/a.m3u8');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'invalid-hls');
});

test('rejects an empty media playlist', () => {
  const parsed = hls.parse('#EXTM3U\n#EXT-X-ENDLIST\n', 'https://x.test/a.m3u8');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'empty-hls');
});

test('resolves relative and absolute segment URIs against the playlist', () => {
  const parsed = hls.parse(
    '#EXTM3U\n#EXTINF:1,\n/root/abs.ts\n#EXTINF:1,\nsub/rel.ts\n#EXTINF:1,\nhttps://other.test/full.ts\n#EXT-X-ENDLIST\n',
    'https://cdn.example.com/a/b/index.m3u8'
  );
  assert.deepEqual(parsed.segments, [
    'https://cdn.example.com/root/abs.ts',
    'https://cdn.example.com/a/b/sub/rel.ts',
    'https://other.test/full.ts'
  ]);
});

test('the service worker loads the same parser via importScripts', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert.match(source, /importScripts\('hls\.js'\)/);
  assert.match(source, /self\.LinkDragHls/);
  assert.match(source, /parser\.parse\(playlist, target\)/);
  // The sniffer must classify HLS so the panel can offer the right download.
  assert.match(source, /function classifyCapturedMedia/);
  assert.match(source, /onHeadersReceived/);
});

test('the manifest ships the parser with the extension', () => {
  const manifest = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  // A service worker may only importScripts() files that exist alongside it.
  assert.ok(require('node:fs').existsSync(path.join(__dirname, '..', 'extension', 'hls.js')));
  assert.ok(manifest.background && manifest.background.service_worker === 'background.js');
});

test('the content script downloads HLS by concatenating segments', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'extension.content.js'), 'utf8');
  assert.match(source, /async function downloadHlsStream\(item, playlistUrl, options\)/);
  assert.match(source, /ldp:hlsPlaylist/);
  assert.match(source, /ldp:hlsSegment/);
  assert.match(source, /new Blob\(parts, \{ type: 'video\/mp2t' \}\)/);
  // Progress must be per segment so the user sees movement.
  assert.match(source, /正在下载' \+ label \+ '分片/);
  // A blob: player with no direct URL falls back to the network sniffer.
  assert.match(source, /ldp:getCapturedMedia/);
  assert.match(source, /srcKind === 'hls'/);
});
