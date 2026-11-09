'use strict';
/**
 * DASH (MPD) parsing and the download-channel wiring.
 * DASH keeps video and audio in separate AdaptationSets; the extension saves
 * one file per stream, matching what ffmpeg-based downloaders report.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const hls = require(path.join(__dirname, '..', 'extension', 'hls.js'));

const MPD_BASEURL = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>https://cdn.example.com/vod/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v360" bandwidth="500000" width="640" height="360">
        <BaseURL>video360.mp4</BaseURL>
      </Representation>
      <Representation id="v720" bandwidth="1800000" width="1280" height="720">
        <BaseURL>video720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000">
        <BaseURL>audio.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate media="https://cdn.example.com/v/$RepresentationID$/seg-$Number$.m4s" startNumber="1"/>
      <Representation id="h264" bandwidth="900000" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test('parses a DASH manifest into separate video and audio streams', () => {
  const parsed = hls.parseDash(MPD_BASEURL, 'https://cdn.example.com/vod/manifest.mpd');
  assert.equal(parsed.ok, true);
  assert.ok(parsed.video, 'video stream');
  assert.ok(parsed.audio, 'audio stream');
  // Highest resolution wins.
  assert.equal(parsed.video.best.height, 720);
  assert.equal(parsed.video.best.url, 'https://cdn.example.com/vod/video720.mp4');
  assert.equal(parsed.audio.best.url, 'https://cdn.example.com/vod/audio.m4a');
});

test('expands a SegmentTemplate media URL', () => {
  const parsed = hls.parseDash(MPD_TEMPLATE, 'https://cdn.example.com/m.mpd');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.video.best.url, 'https://cdn.example.com/v/h264/seg-1.m4s');
});

test('rejects documents that are not manifests', () => {
  const parsed = hls.parseDash('<html></html>', 'https://x.test/a.mpd');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'invalid-mpd');
});

test('a manifest with no usable representations is reported, not silently empty', () => {
  const parsed = hls.parseDash('<MPD><Period></Period></MPD>', 'https://x.test/a.mpd');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'empty-mpd');
});

test('the background resolves DASH through the shared parser', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  assert.match(source, /async function resolveDashManifest\(url\)/);
  assert.match(source, /type === 'ldp:dashManifest'/);
  assert.match(source, /parser\.parseDash\(text, target\)/);
  // The sniffer must classify .mpd so the panel can offer a download.
  assert.match(source, /DASH_REQUEST_RE/);
  assert.match(source, /return 'dash'/);
});

test('the content script downloads DASH video and audio separately', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.content.js'), 'utf8');
  assert.match(source, /async function downloadDashStream\(item, manifestUrl, options\)/);
  assert.match(source, /namespace: 'LPS_EXT', type: 'ldp:dashManifest'/);
  // Both tracks are saved through the extension channel.
  assert.match(source, /await proxyDownload\(item, \{ url: video\.url/);
  assert.match(source, /await proxyDownload\(item, \{ url: audio\.url/);
  assert.match(source, /srcKind = 'dash'/);
  assert.match(source, /srcKind === 'dash'/);
});

test('every bridge call carries the namespace the background requires', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.content.js'), 'utf8');
  for (const type of ['ldp:proxyDownload', 'ldp:dashManifest', 'ldp:hlsPlaylist', 'ldp:hlsSegment', 'ldp:getCapturedMedia']) {
    const at = source.indexOf("type: '" + type + "'");
    assert.ok(at > 0, type + ' missing');
    const before = source.slice(Math.max(0, at - 300), at);
    assert.match(before, /namespace: 'LPS_EXT'/, type + ' must carry the namespace');
  }
});
