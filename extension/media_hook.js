/* Injected on demand into the page MAIN world before media extraction.
   Captures signed media URLs that later become blob/MediaSource URLs. */
(function () {
  'use strict';
  if (window.__LPS_MEDIA_URL_HOOK__) return;
  window.__LPS_MEDIA_URL_HOOK__ = true;
  var seen = Object.create(null);
  var seenCount = 0;
  var observedTimedTextUrls = [];
  function recordTimedText(url) {
    try {
      var raw = String(url || '');
      if (!/\/api\/timedtext(?:\?|$)/i.test(raw)) return;
      var abs = new URL(raw, location.href).href;
      if (observedTimedTextUrls.indexOf(abs) < 0) {
        observedTimedTextUrls.push(abs);
        if (observedTimedTextUrls.length > 40) observedTimedTextUrls.shift();
      }
    } catch (e) { /* ignore */ }
  }
  function installTimedTextRecorder() {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function' && !originalFetch.__lpsTimedTextWrapped) {
      var wrappedFetch = function () {
        try { recordTimedText(typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || ''); } catch (e) { /* ignore */ }
        return originalFetch.apply(this, arguments);
      };
      wrappedFetch.__lpsTimedTextWrapped = true;
      window.fetch = wrappedFetch;
    }
    if (window.XMLHttpRequest && !XMLHttpRequest.prototype.__lpsTimedTextWrapped) {
      var originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { recordTimedText(url); } catch (e) { /* ignore */ }
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.__lpsTimedTextWrapped = true;
    }
  }
  installTimedTextRecorder();
  function findYtPoToken(value, seenValues) {
    if (!value || typeof value !== 'object') return '';
    var seen = seenValues || [];
    if (seen.indexOf(value) >= 0) return '';
    seen.push(value);
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var child = value[key];
      if (/po.?token|player.?po.?token/i.test(key) && typeof child === 'string' && child.length > 20) return child;
      var found = findYtPoToken(child, seen);
      if (found) return found;
    }
    return '';
  }
  function ytPoToken(player) {
    return findYtPoToken(player) || findYtPoToken(window.ytcfg && window.ytcfg.data_) || (player && player.serviceIntegrityDimensions && player.serviceIntegrityDimensions.poToken) || '';
  }
  function ytClientParams() {
    try {
      var ctx = window.ytcfg && window.ytcfg.get ? window.ytcfg.get('INNERTUBE_CONTEXT') : null;
      var client = ctx && ctx.client || {};
      return { c: client.clientName || 'WEB', cver: client.clientVersion || '', hl: client.hl || '' };
    } catch (e) { return { c: 'WEB', cver: '', hl: '' }; }
  }
  function observedTimedText(language) {
    var videoId = new URL(location.href).searchParams.get('v') || '';
    var urls = observedTimedTextUrls.slice().reverse();
    var same = urls.find(function (url) {
      try { var u = new URL(url); return (!videoId || u.searchParams.get('v') === videoId) && u.searchParams.get('lang') === language && u.searchParams.has('pot'); } catch (e) { return false; }
    });
    var anyPot = urls.find(function (url) { try { return new URL(url).searchParams.has('pot'); } catch (e) { return false; } });
    return same || anyPot || '';
  }
  function buildYtSubtitleUrl(track, player) {
    var base = track.baseUrl || '';
    var observed = observedTimedText(track.languageCode || '');
    if (observed) base = observed;
    var u = new URL(base, location.href);
    var videoId = new URL(location.href).searchParams.get('v') || '';
    u.searchParams.set('v', videoId);
    u.searchParams.set('lang', track.languageCode || '');
    u.searchParams.set('fmt', 'json3');
    var sourceParams = new URL(track.baseUrl || base, location.href).searchParams;
    ['name', 'kind', 'tlang', 'variant'].forEach(function (key) { if (sourceParams.get(key)) u.searchParams.set(key, sourceParams.get(key)); });
    var client = ytClientParams();
    u.searchParams.set('c', client.c); if (client.cver) u.searchParams.set('cver', client.cver); if (client.hl) u.searchParams.set('hl', client.hl);
    u.searchParams.set('cplayer', 'UNIPLAYER'); u.searchParams.set('cplatform', 'DESKTOP');
    var pot = ytPoToken(player);
    if (pot) { u.searchParams.set('potc', '1'); u.searchParams.set('pot', pot); }
    return u.toString();
  }
  function ytSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function forceYtTimedText(track) {
    var player = document.getElementById('movie_player');
    var response = window.ytInitialPlayerResponse || (player && player.getPlayerResponse ? player.getPlayerResponse() : null);
    var rawTracks = response && response.captions && response.captions.playerCaptionsTracklistRenderer && response.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!player || !Array.isArray(rawTracks)) return '';
    var raw = rawTracks.find(function (item) { return item.languageCode === track.languageCode; });
    if (!raw) return '';
    var previous = null;
    try { previous = player.getOption ? player.getOption('captions', 'track') : null; } catch (e) { /* ignore */ }
    try {
      var playerTrack = { languageCode: raw.languageCode || track.languageCode, kind: raw.kind || track.kind || '', vss_id: raw.vssId || raw.vss_id || track.vssId || '' };
      player.setOption('captions', 'track', playerTrack);
      for (var i = 0; i < 5; i++) {
        await ytSleep(180);
        var captured = observedTimedText(track.languageCode || '');
        if (captured) {
          // Do not leave the user's caption selection silently changed just
          // because we needed one timedtext request.
          try { if (previous && previous.languageCode) player.setOption('captions', 'track', previous); } catch (e2) { /* ignore */ }
          return captured;
        }
      }
    } catch (e) { /* ignore */ }
    try { if (previous && previous.languageCode) player.setOption('captions', 'track', previous); } catch (e) { /* ignore */ }
    return '';
  }
  function report(url) {
    url = String(url || '');
    if (!/^https?:\/\//i.test(url) || seen[url]) return;
    if (!/(\.mp4(?:$|\?)|\.m4s(?:$|\?)|\.webm(?:$|\?)|\.mp3(?:$|\?)|\.m4a(?:$|\?)|\.m3u8(?:$|\?)|\.ts(?:$|\?)|video\/tos|audio\/tos|douyinvod|mime_type=video|mime_type=audio|aweme\/v1\/play|googlevideo|videoplayback)/i.test(url)) return;
    seen[url] = true;
    seenCount++;
    if (seenCount > 1000) { seen = Object.create(null); seenCount = 0; }
    try { window.postMessage({ source: 'LPS_MEDIA_URL', url: url }, '*'); } catch (e) { /* ignore */ }
  }
  function scanText(text) {
    if (!text || typeof text !== 'string') return;
    if (text.length > 2 * 1024 * 1024) return;
    var re = /https?:\/\/[^"'\\\s<>]+/g;
    var match, count = 0;
    while ((match = re.exec(text)) && count++ < 20) report(match[0]);
  }
  window.addEventListener('message', async function (event) {
    if (event.source !== window || !event.data) return;
    if (event.data.source === 'LPS_MEDIA_URL_CLEAR') {
      seen = Object.create(null);
      seenCount = 0;
      return;
    }
    if (event.data.source !== 'LPS_BILI_RESOLVE' && event.data.source !== 'LPS_BILI_SUBTITLE' && event.data.source !== 'LPS_YT_SUBTITLE' && event.data.source !== 'LPS_YT_AUDIO' && event.data.source !== 'LPS_YT_TRANSCRIPT') return;
    var requestId = event.data.id || '';
    function reply(url, detail) {
      try { window.postMessage({ source: 'LPS_BILI_AUDIO_RESULT', id: requestId, url: url || '', detail: detail || '' }, '*'); } catch (e) { /* ignore */ }
    }
    if (event.data.source === 'LPS_YT_AUDIO') {
      try {
        var audioPlayer = window.ytInitialPlayerResponse || null;
        if (!audioPlayer) {
          var audioEl = document.getElementById('movie_player');
          if (audioEl && typeof audioEl.getPlayerResponse === 'function') audioPlayer = audioEl.getPlayerResponse();
        }
        var audioFormats = audioPlayer && audioPlayer.streamingData
          ? (Array.isArray(audioPlayer.streamingData.adaptiveFormats) ? audioPlayer.streamingData.adaptiveFormats : (Array.isArray(audioPlayer.streamingData.formats) ? audioPlayer.streamingData.formats : []))
          : [];
        var audioFormat = audioFormats.find(function (f) { return /audio\//i.test(String(f && f.mimeType || '')) && /^https?:\/\//i.test(String(f.url || '')); })
          || audioFormats.find(function (f) { return /audio\//i.test(String(f && f.mimeType || '')) && f.signatureCipher; });
        var audioUrl = '';
        if (audioFormat) {
          if (audioFormat.url) audioUrl = String(audioFormat.url);
          else if (audioFormat.signatureCipher) {
            try {
              var cipher = new URLSearchParams(String(audioFormat.signatureCipher));
              // A signatureCipher with `s` needs player-side deciphering.
              // Returning the unsigned URL only produces a guaranteed 403.
              audioUrl = cipher.get('s') ? '' : String(cipher.get('url') || '');
            } catch (e6) { audioUrl = ''; }
          }
        }
        window.postMessage({ source: 'LPS_YT_AUDIO_RESULT', id: requestId, ok: !!audioUrl, url: audioUrl }, '*');
      } catch (e) {
        try { window.postMessage({ source: 'LPS_YT_AUDIO_RESULT', id: requestId, ok: false, url: '' }, '*'); } catch (e2) { /* ignore */ }
      }
      return;
    }
    if (event.data.source === 'LPS_YT_SUBTITLE') {
      try {
        var ytPlayer = window.ytInitialPlayerResponse || null;
        if (!ytPlayer) {
          var playerEl = document.getElementById('movie_player');
          if (playerEl && typeof playerEl.getPlayerResponse === 'function') ytPlayer = playerEl.getPlayerResponse();
        }
        if (!ytPlayer && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
          ytPlayer = window.ytplayer.config.args.player_response || null;
          if (typeof ytPlayer === 'string') { try { ytPlayer = JSON.parse(ytPlayer); } catch (e7) { ytPlayer = null; } }
        }
        var ytRenderer = ytPlayer && ytPlayer.captions && ytPlayer.captions.playerCaptionsTracklistRenderer;
        var ytTracks = ytRenderer && Array.isArray(ytRenderer.captionTracks) ? ytRenderer.captionTracks.slice() : [];
        var ytOrder = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en', 'en-orig'];
        var ytScore = function (track) {
          var lang = String(track.languageCode || '');
          var rank = ytOrder.indexOf(lang);
          if (rank < 0) rank = /^zh/i.test(lang) ? 2 : /^en/i.test(lang) ? 5 : 6;
          return rank * 2 + (String(track.kind || '') === 'asr' ? 1 : 0);
        };
        ytTracks.sort(function (a, b) { return ytScore(a) - ytScore(b); });
        var ytText = '';
        var ytTried = [];
        // Chrono also uses the player's native textTracks before HTTP requests.
        try {
          var ytVideo = document.querySelector('video');
          if (ytVideo && ytVideo.textTracks && ytVideo.textTracks.length) {
            var nativeTrack = Array.prototype.find.call(ytVideo.textTracks, function (item) {
              return !ytTracks.length || item.language === ytTracks[0].languageCode || item.language === ytTracks[0].language;
            }) || Array.prototype.find.call(ytVideo.textTracks, function (item) { return item.mode === 'showing' || item.mode === 'hidden'; });
            if (nativeTrack) {
              var oldMode = nativeTrack.mode;
              nativeTrack.mode = 'hidden';
              var nativeLines = Array.prototype.map.call(nativeTrack.cues || [], function (cue) { return String(cue && cue.text || '').trim(); }).filter(Boolean);
              nativeTrack.mode = oldMode;
              ytText = nativeLines.join('\n').trim();
            }
          }
        } catch (e11) { /* ignore */ }
        for (var ti = 0; ti < ytTracks.length && !ytText; ti++) {
          var ytTrack = ytTracks[ti];
          if (!ytTrack || !ytTrack.baseUrl) continue;
          var ytUrls = [];
          try { ytUrls.push(buildYtSubtitleUrl(ytTrack, ytPlayer)); } catch (e8) { /* ignore */ }
          var rawBase = String(ytTrack.baseUrl || '').replace(/&fmt=srv3\b/gi, '').replace(/\bfmt=srv3&?/gi, '');
          ytUrls.push(rawBase + (rawBase.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3');
          ytUrls.push(rawBase);
          for (var ui = 0; ui < ytUrls.length; ui++) {
            var ytUrl = ytUrls[ui];
            if (!ytUrl || ytTried.indexOf(ytUrl) >= 0) continue;
            ytTried.push(ytUrl);
            try {
              var ytResponse = await fetch(ytUrl, { credentials: 'include' });
              if (!ytResponse.ok) continue;
              var rawYt = await ytResponse.text();
              var ytPayload = null;
              try { ytPayload = JSON.parse(rawYt); } catch (e9) { ytPayload = null; }
              var ytEvents = ytPayload && Array.isArray(ytPayload.events) ? ytPayload.events : [];
              var ytLines = [];
              ytEvents.forEach(function (ev) {
                if (ev && Array.isArray(ev.segs)) {
                  var line = ev.segs.map(function (seg) { return seg && seg.utf8 ? seg.utf8 : ''; }).join('');
                  if (line.trim()) ytLines.push(line);
                } else if (ev && ev.t && String(ev.t).trim()) {
                  ytLines.push(String(ev.t));
                }
              });
              ytText = ytLines.join('\n').trim();
              if (ytText) break;
            } catch (e10) { /* try next */ }
          }
          if (ytText) break;
        }
        if (!ytText && ytTracks.length) {
          try {
            var forcedUrl = await forceYtTimedText(ytTracks[0]);
            if (forcedUrl) {
              var forcedResponse = await fetch(forcedUrl, { credentials: 'include' });
              var forcedRaw = await forcedResponse.text();
              var forcedJson = null;
              try { forcedJson = JSON.parse(forcedRaw); } catch (e12) { forcedJson = null; }
              var forcedEvents = forcedJson && Array.isArray(forcedJson.events) ? forcedJson.events : [];
              var forcedLines = [];
              forcedEvents.forEach(function (ev) {
                if (ev && Array.isArray(ev.segs)) {
                  var forcedLine = ev.segs.map(function (seg) { return seg && seg.utf8 ? seg.utf8 : ''; }).join('');
                  if (forcedLine.trim()) forcedLines.push(forcedLine);
                } else if (ev && ev.t && String(ev.t).trim()) forcedLines.push(String(ev.t));
              });
              ytText = forcedLines.join('\n').trim();
            }
          } catch (e13) { /* ignore */ }
        }
        window.postMessage({ source: 'LPS_YT_SUBTITLE_RESULT', id: requestId, ok: !!ytText, text: ytText, detail: ytText ? '' : 'no caption tracks', tried: ytTried.length }, '*');
      } catch (e) {
        try { window.postMessage({ source: 'LPS_YT_SUBTITLE_RESULT', id: requestId, ok: false, text: '', detail: String(e) }, '*'); } catch (e2) { /* ignore */ }
      }
      return;
    }
    if (event.data.source === 'LPS_YT_TRANSCRIPT') {
      try {
        var ytData = window.ytInitialData;
        var ytToken = '';
        var findToken = function (node) {
          if (!node || typeof node !== 'object' || ytToken) return;
          if (node.panelIdentifier === 'engagement-panel-searchable-transcript') {
            var scan = function (value) {
              if (!value || typeof value !== 'object' || ytToken) return;
              if (value.continuationCommand && value.continuationCommand.token) { ytToken = String(value.continuationCommand.token); return; }
              if (value.getTranscriptEndpoint && value.getTranscriptEndpoint.params) { ytToken = decodeURIComponent(String(value.getTranscriptEndpoint.params)); return; }
              for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) scan(value[key]);
            };
            scan(node);
            return;
          }
          for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) findToken(node[k]);
        };
        findToken(ytData);
        if (!ytToken) { window.postMessage({ source: 'LPS_YT_TRANSCRIPT_RESULT', id: requestId, ok: false, detail: 'no transcript panel' }, '*'); return; }
        var ytKey = window.ytcfg && window.ytcfg.get ? window.ytcfg.get('INNERTUBE_API_KEY') : '';
        var ytContext = window.ytcfg && window.ytcfg.get ? window.ytcfg.get('INNERTUBE_CONTEXT') : null;
        if (!ytKey || !ytContext) { window.postMessage({ source: 'LPS_YT_TRANSCRIPT_RESULT', id: requestId, ok: false, detail: 'no ytcfg' }, '*'); return; }
        var ytRes = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=' + encodeURIComponent(ytKey), {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: ytContext, params: ytToken })
        });
        if (!ytRes.ok) { window.postMessage({ source: 'LPS_YT_TRANSCRIPT_RESULT', id: requestId, ok: false, detail: 'HTTP ' + ytRes.status }, '*'); return; }
        var ytJson = await ytRes.json();
        var ytLines = [];
        var collectYt = function (node) {
          if (!node || typeof node !== 'object') return;
          if (node.transcriptSegmentRenderer) {
            var snippet = node.transcriptSegmentRenderer.snippet || {};
            var runs = Array.isArray(snippet.runs) ? snippet.runs : [];
            var line = runs.map(function (run) { return run && run.text ? run.text : ''; }).join('');
            if (line.trim()) ytLines.push(line);
          }
          for (var yk in node) if (Object.prototype.hasOwnProperty.call(node, yk)) collectYt(node[yk]);
        };
        collectYt(ytJson);
        window.postMessage({ source: 'LPS_YT_TRANSCRIPT_RESULT', id: requestId, ok: true, text: ytLines.join('\n') }, '*');
      } catch (e) {
        try { window.postMessage({ source: 'LPS_YT_TRANSCRIPT_RESULT', id: requestId, ok: false, detail: String(e) }, '*'); } catch (e2) { /* ignore */ }
      }
      return;
    }
    if (event.data.source === 'LPS_BILI_SUBTITLE') {
      try {
        var subBvid = String(event.data.bvid || '').match(/BV[0-9A-Za-z]{10}/);
        var subCid = String(event.data.cid || '');
        if (!subBvid || !subCid) { reply('', 'no-bvid-cid'); return; }
        var subUrl = event.data.wbiQuery
          ? 'https://api.bilibili.com/x/player/wbi/v2?' + String(event.data.wbiQuery)
          : 'https://api.bilibili.com/x/player/wbi/v2?bvid=' + encodeURIComponent(subBvid[0]) + '&cid=' + encodeURIComponent(subCid);
        var subData = await (await fetch(subUrl, { credentials: 'include' })).json();
        var subs = subData && subData.data && subData.data.subtitle && Array.isArray(subData.data.subtitle.subtitles) ? subData.data.subtitle.subtitles : [];
        if (!subs.length && event.data.wbiQuery) {
          try {
            var plainUrl = 'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(subBvid[0]) + '&cid=' + encodeURIComponent(subCid);
            var plainData = await (await fetch(plainUrl, { credentials: 'include' })).json();
            var plainSubs = plainData && plainData.data && plainData.data.subtitle && Array.isArray(plainData.data.subtitle.subtitles) ? plainData.data.subtitle.subtitles : [];
            if (plainSubs.length) { subs = plainSubs; subData = plainData; }
          } catch (e5) { /* ignore */ }
        }
        if (!subs.length) {
          try {
            var state = window.__INITIAL_STATE__;
            var stateSubtitle = state && state.videoData && state.videoData.subtitle;
            var stateList = stateSubtitle && (stateSubtitle.list || stateSubtitle.subtitles);
            if (Array.isArray(stateList) && stateList.length) subs = stateList;
          } catch (e3) { /* ignore */ }
        }
        var subText = '';
        var subCues = [];
        try {
          var picked = subs.find(function (item) { return String(item && item.lan || '') === 'ai-zh'; })
            || subs.find(function (item) { return /中文/.test(String(item && item.lan_doc || '')); })
            || subs[0];
          if (picked && picked.subtitle_url) {
            var subtitleUrl = String(picked.subtitle_url);
            if (subtitleUrl.indexOf('//') === 0) subtitleUrl = 'https:' + subtitleUrl;
            var subtitleRes = await fetch(subtitleUrl, { credentials: 'include' });
            if (subtitleRes.ok) {
              var subtitleJson = await subtitleRes.json();
              var subtitleBody = subtitleJson && Array.isArray(subtitleJson.body) ? subtitleJson.body : [];
              subText = subtitleBody.map(function (line) { return String(line && line.content || ''); }).filter(Boolean).join('\n');
              subCues = subtitleBody.map(function (line) {
                var start = Number(line && (line.from != null ? line.from : line.start)) || 0;
                var end = Number(line && (line.to != null ? line.to : line.end)) || (start + 2);
                return { start: start, end: Math.max(start + 0.2, end), text: String(line && line.content || '').replace(/\s+/g, ' ').trim() };
              }).filter(function (cue) { return cue.text; });
            }
          }
        } catch (e4) { /* text fetch can fall back to content fetch */ }
        try { window.postMessage({ source: 'LPS_BILI_SUBTITLE_RESULT', id: requestId, subtitles: subs, text: subText, cues: subCues, data: subData }, '*'); } catch (e) { /* ignore */ }
      } catch (e) {
        try { window.postMessage({ source: 'LPS_BILI_SUBTITLE_RESULT', id: requestId, subtitles: [], detail: String(e) }, '*'); } catch (e2) { /* ignore */ }
      }
      return;
    }
    try {
      var href = String(event.data.url || location.href);
      var bvidMatch = href.match(/\/video\/(BV[0-9A-Za-z]+)/i) || href.match(/\b(BV[0-9A-Za-z]+)\b/);
      if (!bvidMatch) { reply('', 'no-bvid'); return; }
      var bvid = bvidMatch[1];
      var pageNo = 1;
      try { pageNo = Math.max(1, Number(new URL(href, location.href).searchParams.get('p')) || 1); } catch (eP) { pageNo = 1; }
      var view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { credentials: 'include' })).json();
      var pages = view && view.data && Array.isArray(view.data.pages) ? view.data.pages : [];
      var cid = (pages[pageNo - 1] && pages[pageNo - 1].cid) || (view && view.data && view.data.cid) || (pages[0] && pages[0].cid);
      if (!cid) { reply('', 'no-cid'); return; }
      var play = await (await fetch('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid) + '&fnval=4048&fnver=0&fourk=1', { credentials: 'include' })).json();
      var audio = play && play.data && play.data.dash && play.data.dash.audio && play.data.dash.audio.length
        ? play.data.dash.audio.slice().sort(function (a, b) { return (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0); })[0]
        : null;
      reply(audio ? String(audio.baseUrl || audio.base_url || '') : '', audio ? '' : 'no-audio');
    } catch (e) { reply('', String(e)); }
  });
  try {
    performance.getEntriesByType('resource').forEach(function (entry) { report(entry.name); });
  } catch (e) { /* ignore */ }
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      var input = arguments[0];
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      report(url);
      var result = originalFetch.apply(this, arguments);
      try {
        result.then(function (response) {
          try {
            if (!response || !response.clone) return;
            var type = String(response.headers && response.headers.get ? response.headers.get('content-type') || '' : '');
            var length = Number(response.headers && response.headers.get ? response.headers.get('content-length') || 0 : 0);
            if (length > 2 * 1024 * 1024) return;
            if (type && !/(json|text|javascript|ecmascript)/i.test(type)) return;
            response.clone().text().then(scanText, function () {});
          } catch (e) { /* ignore */ }
        }, function () {});
      } catch (e) { /* ignore */ }
      return result;
    };
  }
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lpsMediaUrl = url;
    report(url);
    this.addEventListener('load', function () {
      try {
        if (this.responseType && this.responseType !== 'text') return;
        var type = String(this.getResponseHeader('content-type') || '');
        var length = Number(this.getResponseHeader('content-length') || 0);
        if (length > 2 * 1024 * 1024) return;
        if (type && !/(json|text|javascript|ecmascript)/i.test(type)) return;
        scanText(this.responseText);
      } catch (e) { /* ignore */ }
    });
    return originalOpen.apply(this, arguments);
  };
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    report(this.__lpsMediaUrl || '');
    return originalSend.apply(this, arguments);
  };
})();
