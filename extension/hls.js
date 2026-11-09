/**
 * HLS (m3u8) playlist parsing — pure functions, no browser APIs.
 *
 * Kept in its own file so it can be unit-tested in Node (`require`) as well as
 * loaded into the MV3 service worker via importScripts().  Reference projects
 * such as res-downloader treat HLS as a first-class case; most Chinese VOD and
 * live sites serve m3u8 rather than a single MP4.
 */
(function (root) {
  'use strict';

  /** Resolve a possibly-relative URI against the playlist URL. */
  function absolute(uri, base) {
    try { return new URL(String(uri || '').trim(), base).toString(); } catch (e) { return ''; }
  }

  /**
   * Parse an m3u8 document.
   * @returns {{
   *   ok: boolean, kind: 'master'|'media'|'', reason?: string,
   *   variants: Array<{uri: string, url: string, bandwidth: number, resolution: string}>,
   *   segments: string[], duration: number, encrypted: boolean, keyMethod: string,
   *   live: boolean
   * }}
   */
  function parse(text, baseUrl) {
    const source = String(text || '');
    if (!/#EXTM3U/i.test(source)) {
      return { ok: false, kind: '', reason: 'invalid-hls', variants: [], segments: [], duration: 0, encrypted: false, keyMethod: '', live: false };
    }
    const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const encrypted = /#EXT-X-KEY:METHOD=(?!NONE)[A-Z0-9-]+/i.test(source);
    const keyMethod = encrypted ? String((/#EXT-X-KEY:METHOD=([A-Z0-9-]+)/i.exec(source) || [])[1] || '') : '';
    const live = !/#EXT-X-ENDLIST/i.test(source);

    if (/#EXT-X-STREAM-INF/i.test(source)) {
      const variants = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
        let uri = '';
        for (let k = i + 1; k < lines.length; k += 1) {
          if (!lines[k].startsWith('#')) { uri = lines[k]; break; }
        }
        if (!uri) continue;
        const bandwidth = Number((/BANDWIDTH=(\d+)/i.exec(lines[i]) || [])[1] || 0);
        const resolution = String((/RESOLUTION=([0-9x]+)/i.exec(lines[i]) || [])[1] || '');
        variants.push({ uri, url: absolute(uri, baseUrl), bandwidth, resolution });
      }
      // Highest bandwidth first, so callers can just take variants[0].
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      if (!variants.length) {
        return { ok: false, kind: 'master', reason: 'empty-hls', variants: [], segments: [], duration: 0, encrypted, keyMethod, live };
      }
      return { ok: true, kind: 'master', variants, segments: [], duration: 0, encrypted, keyMethod, live: false };
    }

    const segments = [];
    let duration = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('#EXTINF:')) {
        const value = parseFloat(line.slice(8).split(',')[0]);
        if (Number.isFinite(value)) duration += value;
        continue;
      }
      if (line.startsWith('#')) continue;
      const url = absolute(line, baseUrl);
      if (url) segments.push(url);
    }
    if (!segments.length) {
      return { ok: false, kind: 'media', reason: 'empty-hls', variants: [], segments: [], duration: 0, encrypted, keyMethod, live };
    }
    return {
      ok: true,
      kind: 'media',
      variants: [],
      segments,
      duration: Math.round(duration * 10) / 10,
      encrypted,
      keyMethod,
      live
    };
  }

  /**
   * Pick the best variant a human would want: highest resolution, then highest
   * bandwidth.  Returns '' when the playlist is not a master playlist.
   */
  function bestVariant(parsed) {
    if (!parsed || !Array.isArray(parsed.variants) || !parsed.variants.length) return '';
    const area = variant => {
      const match = /^(\d+)x(\d+)$/.exec(String(variant.resolution || ''));
      return match ? Number(match[1]) * Number(match[2]) : 0;
    };
    return parsed.variants.slice().sort((a, b) => (area(b) - area(a)) || (b.bandwidth - a.bandwidth))[0].url;
  }

  const api = { parse, absolute, bestVariant };
  root.LinkDragHls = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
