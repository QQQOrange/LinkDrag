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


  /**
   * Parse an MPEG-DASH manifest (MPD) into downloadable representations.
   *
   * DASH is how Bilibili, YouTube-like sites and most modern players deliver
   * media: video and audio live in separate AdaptationSets.  A browser cannot
   * mux them, so the caller saves one file per stream — the same split that
   * res-downloader/ffmpeg-based tools report to their users.
   *
   * Handles the shapes that matter in practice:
   *   - SegmentBase + BaseURL   -> one file, download whole
   *   - SegmentList/BaseURL     -> one file per representation
   *   - SegmentTemplate + media -> expand $Number$ / $RepresentationID$
   */
  function parseDash(text, baseUrl) {
    const source = String(text || '');
    if (!/<MPD[\s>]/i.test(source)) return { ok: false, reason: 'invalid-mpd', streams: [] };
    const attr = (tag, name) => {
      const m = new RegExp(name + '="([^"]*)"', 'i').exec(tag);
      return m ? m[1] : '';
    };
    const num = (tag, name) => Number(attr(tag, name) || 0) || 0;
    const tagBlocks = (source, tag) => {
      const out = [];
      const re = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
      let m;
      while ((m = re.exec(source))) out.push({ tag: m[0], index: m.index });
      return out;
    };
    // NOTE: the offset must be applied to the SAME string it came from; using
    // the document offsets on a sub-block picked the wrong representation.
    const blockOf = (haystack, from, endTag) => {
      const end = haystack.indexOf('</' + endTag, from);
      return end > from ? haystack.slice(from, end) : haystack.slice(from);
    };

    // Global BaseURL (first one after <MPD ...>)
    const mpdTag = /<MPD\b[^>]*>/i.exec(source) || [];
    let globalBase = '';
    if (mpdTag.length) {
      const afterMpd = source.slice(mpdTag.index + mpdTag[0].length);
      const gm = /<BaseURL>([^<]*)<\/BaseURL>/i.exec(afterMpd);
      if (gm) globalBase = gm[1].trim();
    }
    const resolveBase = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return String(baseUrl || '');
      return absolute(raw, String(baseUrl || ''));
    };

    const streams = [];
    const sets = [];
    const setRe = /<AdaptationSet\b[^>]*>/gi;
    let setMatch;
    while ((setMatch = setRe.exec(source))) {
      const body = blockOf(source, setMatch.index + setMatch[0].length, 'AdaptationSet');
      sets.push({ tag: setMatch[0], body });
    }

    for (const set of sets) {
      const mimeType = (attr(set.tag, 'mimeType') || attr(set.tag, 'contentType') || '').toLowerCase();
      const reps = [];
      const repRe = /<Representation\b[^>]*>/gi;
      let rep;
      while ((rep = repRe.exec(set.body))) {
        const repTag = rep[0];
        const repBody = blockOf(set.body, rep.index + repTag.length, 'Representation');
        const repBase = /<BaseURL>([^<]*)<\/BaseURL>/i.exec(repBody);
        const setBase = /<BaseURL>([^<]*)<\/BaseURL>/i.exec(set.body);
        const segTemplate = /<SegmentTemplate\b[^>]*>/i.exec(repBody) || /<SegmentTemplate\b[^>]*>/i.exec(set.body);
        const repId = attr(repTag, 'id') || '';
        let url = '';
        if (repBase) url = resolveBase(repBase[1]);
        else if (setBase) url = resolveBase(setBase[1]);
        else if (globalBase) url = resolveBase(globalBase);
        // SegmentTemplate: expand the common $Number$ form so at least the first
        // media segment can be fetched when no single BaseURL exists.
        if (!url && segTemplate) {
          const media = attr(segTemplate[0], 'media');
          if (media) {
            const start = num(segTemplate[0], 'startNumber') || 1;
            url = resolveBase(media
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Number\$/g, String(start))
              .replace(/\$Number%0(\d+)d\$/g, (all, width) => String(start).padStart(Number(width), '0')));
          }
        }
        if (!url || !/^https?:/i.test(url)) continue;
        reps.push({
          id: repId,
          url,
          bandwidth: num(repTag, 'bandwidth'),
          width: num(repTag, 'width'),
          height: num(repTag, 'height'),
          mimeType
        });
      }
      if (!reps.length) continue;
      reps.sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.bandwidth - a.bandwidth);
      const kind = /^audio/.test(mimeType) || /audio/i.test(set.tag) ? 'audio'
        : /^video/.test(mimeType) || /video/i.test(set.tag) ? 'video' : '';
      streams.push({ kind, mimeType, best: reps[0], all: reps });
    }

    const video = streams.find(s => s.kind === 'video') || null;
    const audio = streams.find(s => s.kind === 'audio') || null;
    if (!video && !audio) return { ok: false, reason: 'empty-mpd', streams: [] };
    return { ok: true, video, audio, streams };
  }

  const api = { parse, parseDash, absolute, bestVariant };
  root.LinkDragHls = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
