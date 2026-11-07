  /* ==================================================================================
   *  §20 视频一键总结
   *  字幕优先：HTML5 <track> / YouTube captions / Bilibili subtitle / 页面字幕区域；
   *  取到字幕后交给当前默认 AI 配置生成 Markdown，不需要下载视频。
   * ================================================================================== */
  const VIDEO_AI_CSS = `[hidden]{display:none!important}
.ldp-video-ai{position:fixed;z-index:2147483647;display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 9px;border:1px solid color-mix(in srgb,var(--accent,#396bb5) 45%,#bbb);border-radius:8px;background:color-mix(in srgb,var(--surface,#f5f5f5) 96%,transparent);box-shadow:0 5px 16px -6px rgba(0,0,0,.42);color:var(--accent,#396bb5);font:600 11px/1 "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;pointer-events:auto;white-space:nowrap;transform-origin:top right;animation:ldp-video-in .14s ease-out}
.ldp-video-ai:hover{background:color-mix(in srgb,var(--accent,#396bb5) 14%,var(--surface,#f5f5f5))}
.ldp-video-ai svg{width:14px;height:14px;display:block;pointer-events:none}
@keyframes ldp-video-in{from{opacity:0;transform:scale(.88) translateY(-2px)}}`;

  let videoAIHost = null;
  let videoAIButton = null;
  let videoAICurrent = null;
  let videoAIHideTimer = 0;
  let videoAIPointer = { x: -1, y: -1 };
  const videoAIInRect = (rect, x, y) => !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  function ensureVideoAI() {
    if (videoAIHost && videoAIHost.isConnected) return true;
    const host = document.createElement('div');
    host.id = 'ldp-video-ai-host';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = VIDEO_AI_CSS;
    root.appendChild(style);
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'ldp-video-ai';
    button.title = 'AI 总结视频内容';
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z"/><path d="M5 16.5 5.8 18.2 7.5 19l-1.7.8L5 21.5l-.8-1.7L2.5 19l1.7-.8L5 16.5Z"/><path d="M19 14.5l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5Z"/></svg><span>AI 总结</span>';
    button.hidden = true;
    const isolateButtonEvent = event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    };
    button.addEventListener('keydown', isolateButtonEvent);
    button.addEventListener('pointerup', isolateButtonEvent);
    button.addEventListener('dblclick', isolateButtonEvent);
    button.addEventListener('contextmenu', isolateButtonEvent);
    button.addEventListener('mouseenter', () => { clearTimeout(videoAIHideTimer); });
    button.addEventListener('mouseleave', () => { clearTimeout(videoAIHideTimer); videoAIHideTimer = setTimeout(hideVideoAI, 1200); });
    button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); if (event.stopImmediatePropagation) event.stopImmediatePropagation(); });
    button.addEventListener('click', event => {
      isolateButtonEvent(event);
      const video = videoAICurrent;
      hideVideoAI();
      if (video) openQuickVideoSummary(video);
    });
    root.appendChild(button);
    document.documentElement.appendChild(host);
    videoAIHost = host;
    videoAIButton = button;
    refreshVideoAITheme();
    return true;
  }

  function refreshVideoAITheme() {
    if (!videoAIButton) return;
    let dark = false;
    try { dark = !!(typeof shell !== 'undefined' && shell && shell.host && shell.host.dataset.theme === 'dark'); } catch (e) { dark = false; }
    videoAIButton.style.background = dark ? '#20242c' : '#ffffff';
    videoAIButton.style.color = dark ? '#cfe0ff' : '#2459b8';
    videoAIButton.style.borderColor = dark ? '#3a4658' : '#8fa8cc';
  }

  function videoAIRect(video) {
    try { return video.getBoundingClientRect(); } catch (e) { return null; }
  }

  function positionVideoAI(video) {
    if (!videoAIButton) return false;
    const rect = videoAIRect(video);
    if (!rect || rect.width < 120 || rect.height < 32 || rect.bottom < 0 || rect.top > window.innerHeight) return false;
    const width = 128;
    let left = rect.right - width - 9;
    if (left < 6) left = rect.left + 8;
    left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
    let top = rect.top + 9;
    if (top < 6) top = 6;
    if (top > window.innerHeight - 34) top = window.innerHeight - 34;
    videoAIButton.style.left = Math.round(left) + 'px';
    videoAIButton.style.top = Math.round(top) + 'px';
    return true;
  }

  function showVideoAI(video) {
    if (!settings.videoAI || !video || !/^(VIDEO|AUDIO)$/.test(String(video.tagName || '').toUpperCase())) return;
    if (!ensureVideoAI()) return;
    if (!positionVideoAI(video)) { hideVideoAI(); return; }
    videoAICurrent = video;
    videoAIButton.hidden = false;
    refreshVideoAITheme();
    clearTimeout(videoAIHideTimer);
  }

  function hideVideoAI() {
    clearTimeout(videoAIHideTimer);
    videoAIHideTimer = 0;
    videoAICurrent = null;
    if (videoAIButton) videoAIButton.hidden = true;
  }

  function installVideoSummary() {
    document.addEventListener('mousemove', event => {
      videoAIPointer = { x: event.clientX, y: event.clientY };
      if (!videoAIButton || videoAIButton.hidden || !videoAICurrent) return;
      const buttonRect = videoAIButton.getBoundingClientRect();
      const videoRect = videoAIRect(videoAICurrent);
      if (videoAIInRect(buttonRect, event.clientX, event.clientY) || videoAIInRect(videoRect, event.clientX, event.clientY)) {
        clearTimeout(videoAIHideTimer);
      }
    }, true);
    document.addEventListener('mouseover', event => {
      if (!settings.videoAI) return;
      const target = event.target;
      const video = target && target.closest ? target.closest('video') : null;
      if (video) showVideoAI(video);
    }, true);
    document.addEventListener('mouseout', event => {
      if (!videoAICurrent) return;
      const target = event.target;
      if (target && target.closest && target.closest('video') === videoAICurrent) {
        clearTimeout(videoAIHideTimer);
        videoAIHideTimer = setTimeout(() => {
          if (!videoAICurrent) return;
          const buttonRect = videoAIButton && videoAIButton.getBoundingClientRect();
          const videoRect = videoAIRect(videoAICurrent);
          if (videoAIInRect(buttonRect, videoAIPointer.x, videoAIPointer.y) || videoAIInRect(videoRect, videoAIPointer.x, videoAIPointer.y)) return;
          hideVideoAI();
        }, 1000);
      }
    }, true);
    window.addEventListener('scroll', () => { if (videoAICurrent) positionVideoAI(videoAICurrent); }, true);
    window.addEventListener('resize', () => { if (videoAICurrent) positionVideoAI(videoAICurrent); }, true);
    const scanVisibleVideo = () => {
      if (!settings.videoAI) { hideVideoAI(); return; }
      if (videoAICurrent && !videoAICurrent.isConnected) hideVideoAI();
      if (videoAICurrent) {
        if (positionVideoAI(videoAICurrent)) videoAIButton.hidden = false;
        else hideVideoAI();
      }
      if (videoAICurrent) return;
      const videos = Array.from(document.querySelectorAll('video,audio')).filter(video => {
        const rect = videoAIRect(video);
        return rect && rect.width >= 160 && rect.height >= 40 && rect.bottom > 0 && rect.top < window.innerHeight;
      });
      if (videos.length) showVideoAI(videos[0]);
    };
    setTimeout(scanVisibleVideo, 900);
    window.addEventListener('load', scanVisibleVideo, { once: true });
    document.addEventListener('loadedmetadata', scanVisibleVideo, true);
    document.addEventListener('play', scanVisibleVideo, true);
    setInterval(scanVisibleVideo, 450);
  }

  function videoFetchText(url) {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return Promise.resolve('');
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; resolve(value); };
      const direct = () => {
        fetch(target, { credentials: 'include' }).then(res => res.text()).then(text => finish(text)).catch(() => finish(''));
      };
      const background = () => {
        if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
          try {
            EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: target, timeoutMs: 15000 }, res => {
              if (res && res.ok && typeof res.text === 'string' && res.text) finish(res.text);
              else finish('');
            });
            return;
          } catch (e) { /* ignore */ }
        }
        finish('');
      };
      // Bilibili/YouTube subtitles are often gated by page cookies.  Try the
      // page context first, then the extension fetch as a cross-origin fallback.
      if (/bilibili\.com|youtube\.com|youtu\.be/i.test(target)) {
        let done = false;
        const directTimer = setTimeout(() => {
          if (done) return;
          done = true;
          background();
        }, /bilibili\.com/i.test(target) ? 2200 : 5000);
        fetch(target, { credentials: 'include' })
          .then(res => res.text())
          .then(text => {
            if (done) return;
            clearTimeout(directTimer);
            done = true;
            if (text) finish(text);
            else background();
          })
          .catch(() => {
            if (done) return;
            clearTimeout(directTimer);
            done = true;
            background();
          });
        return;
      }
      const timer = setTimeout(direct, 5000);
      if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: target, timeoutMs: 15000 }, res => {
            clearTimeout(timer);
            if (res && res.ok && typeof res.text === 'string' && res.text) finish(res.text);
            else direct();
          });
          return;
        } catch (e) { clearTimeout(timer); /* fall through */ }
      }
      direct();
    });
  }

  function md5Hex(input) {
    const bytes = new TextEncoder().encode(String(input || ''));
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLength = bytes.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLength >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const constants = new Uint32Array(64);
    for (let i = 0; i < 64; i++) constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    const rotate = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
    for (let offset = 0; offset < padded.length; offset += 64) {
      const m = new Uint32Array(16);
      for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (B & C) | (~B & D); g = i; }
        else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * i) % 16; }
        const next = (A + f + constants[i] + m[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotate(next, shifts[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16); const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true); outView.setUint32(4, b0, true); outView.setUint32(8, c0, true); outView.setUint32(12, d0, true);
    return Array.from(out, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  let biliWbiMixinCache = '';
  async function bilibiliWbiQuery(bvid, cid) {
    try {
      let mixin = biliWbiMixinCache;
      if (!mixin) {
        const nav = JSON.parse(await videoFetchText('https://api.bilibili.com/x/web-interface/nav'));
        const img = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.img_url;
        const sub = nav && nav.data && nav.data.wbi_img && nav.data.wbi_img.sub_url;
        if (!img || !sub) return '';
        const fileName = value => String(value).split('/').pop().split('.')[0];
        const raw = fileName(img) + fileName(sub);
        const table = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
        mixin = table.map(index => raw[index] || '').join('').slice(0, 32);
        biliWbiMixinCache = mixin;
      }
      const params = { bvid, cid: String(cid), wts: String(Math.floor(Date.now() / 1000)) };
      const query = Object.keys(params).sort().map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&');
      return query + '&w_rid=' + md5Hex(query + mixin);
    } catch (e) { return ''; }
  }
  function dedupeTranscript(lines) {
    const out = [];
    const seen = new Set();
    for (const raw of lines) {
      const line = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out.join('\n').trim();
  }

  function parseSubtitleText(raw) {
    const text = String(raw || '').replace(/\r/g, '');
    if (!text.trim()) return '';
    const lines = [];
    const blocks = text.split(/\n{2,}/);
    for (const block of blocks) {
      const parts = block.split('\n').map(x => x.trim()).filter(Boolean);
      const timeIndex = parts.findIndex(x => x.includes('-->'));
      if (timeIndex < 0) continue;
      const payload = parts.slice(timeIndex + 1).join(' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&');
      if (payload.trim()) lines.push(payload);
    }
    return dedupeTranscript(lines);
  }

  function extractYouTubeXml(raw) {
    const source = String(raw || '').trim();
    if (!source || source[0] !== '<') return '';
    try {
      const doc = new DOMParser().parseFromString(source, 'text/xml');
      const nodes = Array.from(doc.querySelectorAll('text'));
      return dedupeTranscript(nodes.map(node => String(node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    } catch (e) { return ''; }
  }

  function extractYouTubeJson(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return ''; }
    const events = data && Array.isArray(data.events) ? data.events : [];
    const lines = [];
    for (const event of events) {
      if (Array.isArray(event.segs)) {
        const text = event.segs.map(seg => seg && seg.utf8 ? seg.utf8 : '').join('');
        if (text.trim()) lines.push(text);
      } else if (event.t) {
        lines.push(event.t);
      }
    }
    return dedupeTranscript(lines);
  }

  function extractBilibiliJson(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return ''; }
    const body = data && Array.isArray(data.body) ? data.body : [];
    return dedupeTranscript(body.map(item => item && item.content ? item.content : ''));
  }

  async function nativeVideoTranscript(video) {
    const tracks = [];
    try {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track && (!track.kind || /caption|subtitle/i.test(track.kind))) {
            if (track.cues && track.cues.length) {
              const text = Array.from(track.cues).map(cue => cue.text || '').join('\n');
              if (text.trim()) return { text: dedupeTranscript(text.split('\n')), source: '视频字幕' };
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
    for (const track of video.querySelectorAll('track')) {
      const kind = String(track.kind || '');
      if (kind && !/caption|subtitle/i.test(kind)) continue;
      const src = track.src || track.getAttribute('src') || '';
      if (src) tracks.push(src);
    }
    for (const src of tracks) {
      const raw = await videoFetchText(new URL(src, location.href).href);
      const text = parseSubtitleText(raw);
      if (text) return { text, source: '视频字幕' };
    }
    return null;
  }

  function youtubePlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse && (window.ytInitialPlayerResponse.captions || window.ytInitialPlayerResponse.streamingData)) return window.ytInitialPlayerResponse;
      const player = document.querySelector('#movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const response = player.getPlayerResponse();
        if (response && (response.captions || response.streamingData)) return response;
      }
      const ytplayer = window.ytplayer || (window.ytcfg && window.ytcfg.get && window.ytcfg.get('PLAYER_CONFIG'));
      const args = ytplayer && ytplayer.config && ytplayer.config.args;
      const raw = args && (args.raw_player_response || args.player_response);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && (parsed.captions || parsed.streamingData)) return parsed;
      }
    } catch (e) { /* ignore */ }
    const readObject = (source, start) => {
      if (start < 0) return null;
      let depth = 0;
      let quote = '';
      let escaped = false;
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(source.slice(start, i + 1)); } catch (e) { return null; }
          }
        }
      }
      return null;
    };
    for (const script of Array.from(document.scripts || [])) {
      const source = String(script.textContent || '');
      const marker = source.indexOf('ytInitialPlayerResponse');
      if (marker < 0) continue;
      const assignment = source.indexOf('=', marker);
      if (assignment < 0) continue;
      const start = source.indexOf('{', assignment);
      const parsed = readObject(source, start);
      if (parsed && (parsed.captions || parsed.streamingData)) return parsed;
    }
    return null;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function youtubePanelTranscript() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname + location.pathname)) return null;
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter(node => {
      const text = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return /transcript|字幕|文字稿|转录/i.test(text) && text.length < 80;
    });
    const button = candidates[0];
    if (!button) return null;
    try { button.click(); } catch (e) { return null; }
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(350);
      const nodes = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer, [class*="transcript-segment"], [class*="transcript"] [class*="segment"]'));
      const lines = nodes.map(node => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const text = dedupeTranscript(lines).slice(0, 24000);
      if (text.length >= 30) return { text, source: 'YouTube 字幕面板' };
    }
    return null;
  }

  function subtitleFailureReason() {
    if (/youtube\.com|youtu\.be/i.test(location.hostname)) {
      const playability = youtubePlayabilityStatus();
      if (playability === 'LOGIN_REQUIRED') return 'YouTube 要求登录验证，字幕接口和视频流都不可用';
      if (playability) return 'YouTube 播放状态：' + playability + '，没有返回可读字幕';
      return 'YouTube 没有返回可读字幕（timedtext 为空或字幕轨道不可用）';
    }
    if (/bilibili\.com/i.test(location.hostname)) return 'B 站播放器接口返回 0 条可用字幕';
    return '页面没有可读取的字幕轨道';
  }

  function youtubePlayabilityStatus() {
    try {
      const player = youtubePlayerResponse();
      return String(player && player.playabilityStatus && player.playabilityStatus.status || '');
    } catch (e) { return ''; }
  }

  function youtubeAudioFromPage() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname)) return Promise.resolve('');
    return new Promise(resolve => {
      const id = 'yt-audio-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); clearTimeout(timer); resolve(String(value || '')); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_YT_AUDIO_RESULT' || event.data.id !== id) return;
        finish(event.data.ok ? event.data.url : '');
      };
      const timer = setTimeout(() => finish(''), 4000);
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_YT_AUDIO', id }, '*'); } catch (e) { finish(''); }
    });
  }

  function youtubeAudioUrl() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname)) return '';
    const player = youtubePlayerResponse();
    const formats = player && player.streamingData && (Array.isArray(player.streamingData.adaptiveFormats) ? player.streamingData.adaptiveFormats : Array.isArray(player.streamingData.formats) ? player.streamingData.formats : []);
    const audio = formats.find(format => /audio\//i.test(String(format.mimeType || '')) && /^https?:\/\//i.test(String(format.url || '')))
      || formats.find(format => /audio\//i.test(String(format.mimeType || '')) && format.signatureCipher);
    if (!audio) return '';
    if (audio.url) return String(audio.url);
    if (audio.signatureCipher) {
      try {
        const cipher = new URLSearchParams(String(audio.signatureCipher));
        const url = cipher.get('url') || '';
        return /^https?:\/\//i.test(url) ? url : '';
      } catch (e) { return ''; }
    }
    return '';
  }

  function youtubeCaptionFromPage() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname + location.pathname)) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = 'yt-cap-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); clearTimeout(timer); resolve(value); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_YT_SUBTITLE_RESULT' || event.data.id !== id) return;
        if (!event.data.ok || !String(event.data.text || '').trim()) { finish(null); return; }
        finish({ text: dedupeTranscript(String(event.data.text).split(/\n+/)), source: 'YouTube 字幕' });
      };
      const timer = setTimeout(() => finish(null), 6000);
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_YT_SUBTITLE', id }, '*'); } catch (e) { finish(null); }
    });
  }

  function youtubeTranscriptFromPage() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname + location.pathname)) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = 'yt-sub-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); clearTimeout(timer); resolve(value); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_YT_TRANSCRIPT_RESULT' || event.data.id !== id) return;
        if (!event.data.ok || !String(event.data.text || '').trim()) { finish(null); return; }
        finish({ text: dedupeTranscript(String(event.data.text).split(/\n+/)), source: 'YouTube 字幕面板' });
      };
      const timer = setTimeout(() => finish(null), 4000);
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_YT_TRANSCRIPT', id }, '*'); } catch (e) { finish(null); }
    });
  }

  async function youtubeTranscript() {
    if (!/youtube\.com|youtu\.be/i.test(location.hostname + location.pathname)) return null;
    const pageCaption = await youtubeCaptionFromPage();
    if (pageCaption && pageCaption.text) return pageCaption;
    const player = youtubePlayerResponse();
    const renderer = player && player.captions && player.captions.playerCaptionsTracklistRenderer;
    const tracks = renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
    if (!tracks.length) return (await youtubeTranscriptFromPage()) || youtubePanelTranscript();
    const score = item => {
      const lang = String(item.languageCode || '');
      const order = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en', 'en-orig'];
      const exact = order.indexOf(lang);
      const rank = exact >= 0 ? exact : (/^zh/i.test(lang) ? 2 : /^en/i.test(lang) ? 5 : 6);
      return rank * 2 + (String(item.kind || '') === 'asr' ? 1 : 0);
    };
    const ordered = tracks.slice().sort((a, b) => score(a) - score(b));
    // subtitle-easy / yt-dlp uses JSON3 (`subtitlesformat='json3'`).
    // Keep JSON3 as the first and authoritative format.
    for (const track of ordered) {
      if (!track || !track.baseUrl) continue;
      const base = String(track.baseUrl);
      const jsonUrl = base + (base.includes('?') ? '&' : '?') + 'fmt=json3';
      const jsonRaw = await videoFetchText(jsonUrl);
      const text = extractYouTubeJson(jsonRaw);
      if (text) return { text, source: 'YouTube 字幕' };
      const xmlRaw = await videoFetchText(base.replace(/&fmt=srv3\b/gi, '').replace(/\bfmt=srv3&?/gi, ''));
      const xmlText = extractYouTubeXml(xmlRaw);
      if (xmlText) return { text: xmlText, source: 'YouTube 字幕' };
    }
    return (await youtubeTranscriptFromPage()) || youtubePanelTranscript();
  }

  async function bilibiliTranscript() {
    if (!/bilibili\.com/i.test(location.hostname)) return null;
    const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!match) return null;
    const bvid = match[1];
    let view = null;
    try { view = JSON.parse(await videoFetchText('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))); } catch (e) { return null; }
    const pageNo = Math.max(1, Number(new URLSearchParams(location.search).get('p')) || 1);
    const page = view && view.data && Array.isArray(view.data.pages) ? view.data.pages[pageNo - 1] || view.data.pages[0] : null;
    const cid = (page && page.cid) || (view && view.data && view.data.cid);
    const aid = (view && view.data && view.data.aid) || '';
    if (!cid) return null;
    let subtitles = [];
    let playerLoaded = false;
    let wbiQuery = '';
    const collect = data => {
      const items = data && data.data && data.data.subtitle && Array.isArray(data.data.subtitle.subtitles)
        ? data.data.subtitle.subtitles : [];
      if (items.length) subtitles = items;
      if (data && data.code === 0) playerLoaded = true;
    };
    let pageSubtitle = await biliPageHookSubtitles(bvid, cid, '');
    if (pageSubtitle.text) return { text: pageSubtitle.text, source: 'Bilibili 字幕' };
    if (pageSubtitle.subtitles && pageSubtitle.subtitles.length) subtitles = pageSubtitle.subtitles;
    if (!subtitles.length) {
      const viewList = view && view.data && view.data.subtitle && Array.isArray(view.data.subtitle.list) ? view.data.subtitle.list : [];
      if (viewList.length) subtitles = viewList;
    }
    if (!subtitles.length) {
      try { wbiQuery = await bilibiliWbiQuery(bvid, cid); } catch (e) { wbiQuery = ''; }
      if (wbiQuery) {
        pageSubtitle = await biliPageHookSubtitles(bvid, cid, wbiQuery);
        if (pageSubtitle.text) return { text: pageSubtitle.text, source: 'Bilibili 字幕' };
        if (pageSubtitle.subtitles && pageSubtitle.subtitles.length) subtitles = pageSubtitle.subtitles;
      }
    }
    if (!subtitles.length) {
      try {
        const stateSubtitle = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData && window.__INITIAL_STATE__.videoData.subtitle;
        const stateList = stateSubtitle && (stateSubtitle.list || stateSubtitle.subtitles);
        if (Array.isArray(stateList) && stateList.length) subtitles = stateList;
      } catch (e) { /* ignore */ }
    }
    if (!subtitles.length) {
      try { collect(JSON.parse(await videoFetchText('https://api.bilibili.com/x/player/wbi/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid)))); } catch (e) { /* try next */ }
    }
    if (!subtitles.length) {
      if (wbiQuery) {
        try { collect(JSON.parse(await videoFetchText('https://api.bilibili.com/x/player/wbi/v2?' + wbiQuery))); } catch (e) { /* try next */ }
      }
    }
    if (!subtitles.length) {
      try {
        const dm = JSON.parse(await videoFetchText('https://api.bilibili.com/x/v2/dm/view?' + (aid ? 'aid=' + encodeURIComponent(aid) : 'bvid=' + encodeURIComponent(bvid)) + '&oid=' + encodeURIComponent(cid) + '&type=1'));
        collect(dm);
      } catch (e) { /* no subtitles */ }
    }
    const orderedSubtitles = subtitles.filter(item => item && item.subtitle_url).slice().sort((a, b) => {
      const label = item => String(item.lan_doc || item.lan || '');
      const score = item => {
        const text = label(item);
        if (/摘要/.test(text)) return 4;
        if (/AI/i.test(text)) return 3;
        if (/中文/.test(text)) return 0;
        return 1;
      };
      return score(a) - score(b);
    });
    const sub = orderedSubtitles[0];
    if (!sub || !sub.subtitle_url) return null;
    let subUrl = String(sub.subtitle_url);
    if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
    const text = extractBilibiliJson(await videoFetchText(subUrl));
    return text ? { text, source: 'Bilibili 字幕' } : null;
  }

  function biliPageHookSubtitles(bvid, cid, wbiQuery) {
    return new Promise(resolve => {
      const id = 'bili-sub-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); resolve(value || {}); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_BILI_SUBTITLE_RESULT' || event.data.id !== id) return;
        finish({ subtitles: Array.isArray(event.data.subtitles) ? event.data.subtitles : [], text: String(event.data.text || '') });
      };
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_BILI_SUBTITLE', id, bvid, cid, wbiQuery: wbiQuery || '' }, '*'); } catch (e) { finish({}); return; }
      setTimeout(() => finish({}), 3500);
    });
  }

  function biliPageHookAudio() {
    return new Promise(resolve => {
      const id = 'bili-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = url => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); resolve(url || ''); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_BILI_AUDIO_RESULT' || event.data.id !== id) return;
        finish(event.data.url || '');
      };
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_BILI_RESOLVE', id, url: location.href }, '*'); } catch (e) { finish(''); return; }
      setTimeout(() => finish(''), 10000);
    });
  }

  async function bilibiliAudioUrl() {
    if (!/bilibili\.com/i.test(location.hostname)) return '';
    const fromPageHook = await biliPageHookAudio();
    if (fromPageHook) return fromPageHook;
    if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
      const resolved = await new Promise(resolve => {
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:resolveBilibili', url: location.href }, res => {
            try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
            resolve(res && res.ok ? res.url : '');
          });
        } catch (e) { resolve(''); }
      });
      if (resolved) return resolved;
    }
    const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!match) return '';
    const bvid = match[1];
    let view = null;
    try { view = JSON.parse(await videoFetchText('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))); } catch (e) { return ''; }
    const pageNo = Math.max(1, Number(new URLSearchParams(location.search).get('p')) || 1);
    const page = view && view.data && Array.isArray(view.data.pages) ? view.data.pages[pageNo - 1] || view.data.pages[0] : null;
    const cid = (page && page.cid) || (view && view.data && view.data.cid);
    if (!cid) return '';
    try {
      const data = JSON.parse(await videoFetchText('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid) + '&fnval=4048&fnver=0&fourk=1'));
      const dash = data && data.data && data.data.dash;
      const audioList = dash && Array.isArray(dash.audio) ? dash.audio.slice() : [];
      const audio = audioList.sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0] || null;
      return audio ? String(audio.baseUrl || audio.base_url || '') : '';
    } catch (e) { return ''; }
  }

  function pageTranscriptFallback(video) {
    const selectors = ['ytd-transcript-renderer', 'ytd-transcript-segment-renderer', '[class*="transcript-panel"]', '[class*="transcript-segment"]', '[data-purpose="transcript"]'];
    const candidates = [];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (node === video || node.contains(video) || (video && video.contains(node))) continue;
        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 100 && text.length <= 24000) candidates.push(text);
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] ? { text: candidates[0], source: '页面字幕区域' } : null;
  }

  async function collectVideoTranscript(video) {
    try {
      const native = await nativeVideoTranscript(video);
      if (native && native.text) return native;
    } catch (e) { /* ignore */ }
    try {
      const youtube = await youtubeTranscript();
      if (youtube && youtube.text) return youtube;
    } catch (e) { /* ignore */ }
    try {
      const bili = await bilibiliTranscript();
      if (bili && bili.text) return bili;
    } catch (e) { /* ignore */ }
    // Bilibili subtitles are authoritative through the player API.  Do not
    // fall back to generic [class*="subtitle"] nodes: Bilibili's player chrome
    // and recommendation sidebar match those selectors and can send unrelated
    // UI text to the text model, which then correctly says the input contains
    // no video content.
    // Douyin/TikTok descriptions, comments, recommendation cards and player
    // chrome are not subtitles.  Never summarize a description as if it were
    // the video transcript; force the media/ASR path instead.
    if (/bilibili\.com|douyin\.com|iesdouyin\.com|tiktok\.com/i.test(location.hostname)) return { text: '', source: '' };
    return pageTranscriptFallback(video) || { text: '', source: '' };
  }

  function openQuickVideoSummary(video) {
    if (!video) return;
    if (String(video.tagName || '').toUpperCase() === 'AUDIO') {
      openMediaSummaryPanel({});
      return;
    }
    const rect = videoAIRect(video);
    const point = rect ? { x: rect.right - 28, y: rect.top + 20 } : undefined;
    const title = String(document.title || '视频总结').slice(0, 180);
    const item = openWindow('', title, null, point, { bare: true });
    if (!item) return;
    item.summaryProtected = true;
    item.videoState = {
      busy: false,
      answer: '',
      transcript: '',
      source: '',
      error: '',
      info: {
        title,
        url: location.href,
        videoUrl: String(video.currentSrc || video.src || ''),
        video
      }
    };
    openPanel(item, 'video');
    if (typeof hideSummaryWindow === 'function') hideSummaryWindow(item);
    if (typeof showSummaryLoading === 'function') showSummaryLoading(item, '正在读取视频字幕…');
    if (typeof ensureGenericMediaHook === 'function') ensureGenericMediaHook();
    startVideoSummary(item);
  }

  function renderVideoSummaryPanel(item) {
    item.panelMode = 'video';
    const body = panelFrame(item, '视频总结', 'close');
    if (typeof configureSummaryWindow === 'function') configureSummaryWindow(item);
    item.ui.panel.classList.add('video-panel');
    const state = item.videoState || { info: {} };
    const source = el('p', 'note', '从当前视频的字幕/转写中提取内容，交给默认 AI 配置生成文字总结；不会下载或上传视频文件。');
    const status = el('div', 'video-summary-status', state.error ? '未能读取字幕' : (state.busy ? '正在准备…' : '准备中…'));
    const out = el('div', 'video-summary-answer markdown');
    const meta = el('div', 'video-summary-meta', '');
    const actions = el('div', 'ai-actions');
    const copy = el('button', 'text-button', '复制总结');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = String((item.videoState && item.videoState.answer) || '').trim();
      if (!text) { toast(item, '还没有可复制的总结'); return; }
      try { navigator.clipboard.writeText(text); toast(item, '已复制总结'); } catch (e) { toast(item, '复制失败'); }
    });
    const retry = el('button', 'text-button', '重新总结');
    retry.type = 'button';
    retry.addEventListener('click', () => startVideoSummary(item));
    actions.appendChild(copy);
    actions.appendChild(retry);
    if (typeof addSummaryAppearance === 'function') addSummaryAppearance(item, actions);
    body.appendChild(source);
    body.appendChild(status);
    if (typeof addSummarySteps === 'function') addSummarySteps(item, body, 'video', ['扫描字幕', 'AI 总结']);
    body.appendChild(out);
    body.appendChild(meta);
    body.appendChild(actions);
    item.ui.videoStatus = status;
    item.ui.videoOut = out;
    item.ui.videoMeta = meta;
    if (typeof applySummaryTextStyle === 'function') applySummaryTextStyle(item, out);
    if (state.answer) out.innerHTML = markdownToHtml(state.answer);
    else if (state.error) { out.textContent = state.error; out.dataset.tone = 'bad'; }
    else out.textContent = '正在读取视频字幕…';
    if (state.error) status.textContent = '未能读取字幕';
  }

  function switchVideoToMediaSummary(item, subtitleError) {
    const info = item && item.videoState && item.videoState.info;
    const video = info && info.video;
    if (!video) return false;
    const candidates = typeof scanMediaCandidates === 'function' ? scanMediaCandidates() : [];
    const src = String((info && info.videoUrl) || (video.currentSrc || video.src) || '');
    const srcKind = src ? (typeof mediaUrlKind === 'function' ? mediaUrlKind(src, 'video') : 'video') : 'stream';
    if (src) info.videoUrl = src;
    item.mediaState = {
      busy: false,
      cancelled: false,
      answer: '',
      error: '',
      subtitleError: String(subtitleError || ''),
      textMode: false,
      list: candidates.length ? candidates : [{ element: video, url: src, kind: 'video', srcKind, duration: Number(video.duration) || 0, title: info.title || '' }],
      candidate: null,
      prompt: ''
    };
    item.mediaState.candidate = item.mediaState.list[0];
    openPanel(item, 'media');
    if (typeof ensureGenericMediaHook === 'function') ensureGenericMediaHook();
    const hasDirect = item.mediaState.list.some(candidate => candidate.url && !/^blob:/i.test(candidate.url));
    setTimeout(() => startMediaSummary(item), hasDirect ? 60 : 320);
    return true;
  }

  function startVideoSummary(item) {
    if (!item || item.closed || !item.videoState) return;
    const state = item.videoState;
    if (state.busy) return;
    if (!state.info) state.info = {};
    if (!state.info.video) {
      const candidate = scanMediaCandidates().find(entry => entry.element && String(entry.element.tagName || '').toUpperCase() === 'VIDEO');
      if (candidate) state.info.video = candidate.element;
    }
    if (!state.info.video) {
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      return;
    }
    state.busy = true;
    state.error = '';
    state.answer = '';
    state.transcript = '';
    state.source = '';
    state.startedAt = Date.now();
    state.summaryResourcesCleared = false;
    if (typeof markSummaryStep === 'function') markSummaryStep(item, 'video', 0, 'active');
    const out = item.ui.videoOut;
    const status = item.ui.videoStatus;
    const meta = item.ui.videoMeta;
    if (out) { out.textContent = '正在读取视频字幕…'; out.classList.remove('markdown'); out.classList.add('streaming'); out.dataset.tone = ''; }
    if (status) status.textContent = '正在读取字幕…';
    if (meta) meta.textContent = '';
    if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 10, '正在读取视频字幕…');
    (async () => {
      let result = null;
      let subtitleTicker = 0;
      try {
        subtitleTicker = setInterval(() => {
          if (!item || item.closed || !state.busy) return;
          const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
          if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, Math.min(48, 10 + elapsed * 2), '正在读取并解析视频字幕…');
        }, 1000);
        result = await Promise.race([
          collectVideoTranscript(state.info.video),
          new Promise(resolve => setTimeout(() => resolve(null), 20000))
        ]);
      } catch (e) { result = null; }
      finally { if (subtitleTicker) clearInterval(subtitleTicker); }
      if (item.closed) return;
      if (!result || !result.text) {
        const playability = /youtube\.com|youtu\.be/i.test(location.hostname) && typeof youtubePlayabilityStatus === 'function' ? youtubePlayabilityStatus() : '';
        if (playability === 'LOGIN_REQUIRED') {
          state.busy = false;
          state.error = 'YouTube 返回 LOGIN_REQUIRED：当前页面要求登录以确认不是机器人，因此既拿不到字幕，也拿不到视频流。请先在浏览器登录 YouTube，再刷新页面重试。';
          if (out) { out.classList.remove('streaming', 'markdown'); out.textContent = state.error; out.dataset.tone = 'bad'; }
          if (status) status.textContent = 'YouTube 要求登录验证';
          if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
          return;
        }
        if (state.info && switchVideoToMediaSummary(item, subtitleFailureReason())) {
          if (item.mediaState) item.mediaState.subtitleError = subtitleFailureReason();
          if (status) status.textContent = '未找到字幕，改用音视频模型…';
          return;
        }
        state.busy = false;
        state.error = '没有找到可读取的字幕：' + subtitleFailureReason() + '；视频也没有可导出的媒体流。请确认视频平台提供字幕，或媒体允许跨域访问。';
        if (out) { out.classList.remove('streaming', 'markdown'); out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '未能读取字幕';
        if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
        return;
      }
      state.transcript = result.text;
      state.source = result.source;
      if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'video', 'AI 总结', 'active');
      if (typeof setSummaryEstimate === 'function') setSummaryEstimate(item, Math.max(20, Math.min(180, result.text.length / 80 + 20)));
      if (typeof revealSummaryWindowKeepLoading === 'function') revealSummaryWindowKeepLoading(item);
      else if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      if (status) status.textContent = '已获取' + result.source + ' · 正在生成总结';
      if (meta) meta.textContent = '字幕 ' + result.text.length + ' 字';
      if (out) out.textContent = '正在请求 AI 接口…';
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 62, '已获取字幕，正在生成总结…');
      streamVideoSummary(item, result.text);
    })();
  }

  function fallbackVideoSummary(item, transcript, reason) {
    const state = item.videoState;
    const out = item.ui.videoOut;
    const meta = item.ui.videoMeta;
    const status = item.ui.videoStatus;
    if (status) status.classList.add('streaming');
    if (!state || !out || item.videoFallbackBusy) return;
    item.videoFallbackBusy = true;
    state.busy = true;
    out.classList.add('streaming');
    out.classList.remove('markdown');
    out.dataset.tone = '';
    out.textContent = '流式连接失败，正在改用普通请求…';
    const vendorId = aiConfig.provider || DEFAULT_AI_CONFIG.provider;
    const cfg = aiProviderConfig(vendorId);
    const selected = (aiConfig.selectedModels && aiConfig.selectedModels[vendorId]) || aiConfig.model || cfg.model;
    if (/SenseVoice|TeleSpeech|audio\/transcriptions/i.test(String(selected || '') + ' ' + String(cfg.endpoint || ''))) {
      state.busy = false;
      out.textContent = '字幕已获取，但当前 AI 配置是 ASR/音频模型，不能处理文本。请在设置 → AI 接口选择普通文本模型（如 deepseek-chat / Qwen 文本模型）。';
      out.dataset.tone = 'bad';
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, 'AI 配置不是文本模型');
      return;
    }
    if (String(transcript || '').trim().length < 20) {
      state.busy = false;
      out.textContent = '字幕接口返回了空文本或过短文本，无法生成总结。';
      out.dataset.tone = 'bad';
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      return;
    }
    const request = {
      action: 'summary',
      text: String(transcript || '').slice(0, 20000),
      title: state.info && state.info.title || '',
      url: state.info && state.info.url || '',
      provider: vendorId,
      endpoint: cfg.endpoint,
      model: selected,
      summaryPrompt: '以下正文实际上是一段完整视频的字幕/语音转写，不是空内容。请直接依据它总结视频主题、要点和结论，不要回答“没有内容”或要求用户补充字幕。'
    };
    try {
      EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:ai', request }, response => {
        let lastError = null;
        try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
        item.videoFallbackBusy = false;
        state.busy = false;
        out.classList.remove('streaming');
        if (lastError || !response) {
          out.textContent = 'AI 请求失败：后台没有响应' + (reason ? '（' + reason + '）' : '');
          out.dataset.tone = 'bad';
          if (status) { status.textContent = '总结失败'; status.classList.remove('streaming'); }
          if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
          return;
        }
        if (!response.ok) {
          out.textContent = 'AI 请求失败：' + (response.detail || response.reason || '请检查 AI 配置');
          out.dataset.tone = 'bad';
          if (status) { status.textContent = '总结失败'; status.classList.remove('streaming'); }
          if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
          return;
        }
        state.answer = String(response.text || '');
        out.innerHTML = markdownToHtml(state.answer);
        out.classList.add('markdown');
        out.dataset.tone = 'good';
        const totalElapsed = state.startedAt ? Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) : '';
        if (meta) meta.textContent = '总结来源：' + (state.source || '字幕') + ' · 模型 ' + (response.model || selected) + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : '');
        if (status) { status.textContent = '已加载完成' + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : ''); status.classList.remove('streaming'); }
        if (typeof revealSummaryWindow === 'function') setTimeout(() => revealSummaryWindow(item), 220);
      });
    } catch (e) {
      item.videoFallbackBusy = false;
      state.busy = false;
      out.textContent = 'AI 请求发送失败：' + (e && e.message ? e.message : '扩展后台不可用');
      out.dataset.tone = 'bad';
      if (status) { status.textContent = '总结失败'; status.classList.remove('streaming'); }
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
    }
  }

  function streamVideoSummary(item, transcript) {
    const state = item.videoState;
    const out = item.ui.videoOut;
    const meta = item.ui.videoMeta;
    const status = item.ui.videoStatus;
    if (!state || !out) return;
    if (status) status.classList.add('streaming');
    if (typeof showStreamDots === 'function') showStreamDots(item, out);
    let finished = false;
    let watchdog = 0;
    const finishOnce = fn => { if (finished) return; finished = true; if (watchdog) clearTimeout(watchdog); fn(); };
    const vendorId = aiConfig.provider || DEFAULT_AI_CONFIG.provider;
    const cfg = aiProviderConfig(vendorId);
    const selected = (aiConfig.selectedModels && aiConfig.selectedModels[vendorId]) || aiConfig.model || cfg.model;
    if (/SenseVoice|TeleSpeech|audio\/transcriptions/i.test(String(selected || '') + ' ' + String(cfg.endpoint || ''))) {
      state.busy = false;
      out.textContent = '字幕已获取，但当前 AI 配置是 ASR/音频模型，不能处理文本。请在设置 → AI 接口选择普通文本模型（如 deepseek-chat / Qwen 文本模型）。';
      out.dataset.tone = 'bad';
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, 'AI 配置不是文本模型');
      return;
    }
    if (String(transcript || '').trim().length < 20) {
      state.busy = false;
      out.textContent = '字幕接口返回了空文本或过短文本，无法生成总结。';
      out.dataset.tone = 'bad';
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      return;
    }
    watchdog = setTimeout(() => finishOnce(() => fallbackVideoSummary(item, transcript, '文本模型 90 秒没有返回')), 90000);
    const request = {
      action: 'video',
      text: String(transcript || '').slice(0, 20000),
      title: state.info.title || '',
      url: state.info.url || '',
      provider: vendorId,
      endpoint: cfg.endpoint,
      model: selected,
      summaryPrompt: '以下文本是完整的视频字幕/语音转写，不是空内容。请直接依据它总结视频主题、要点和结论，不要回答“没有内容”或要求用户补充字幕。'
    };
    if (!EXT || !EXT.runtime || !EXT.runtime.connect) {
      if (watchdog) clearTimeout(watchdog);
      fallbackVideoSummary(item, transcript, '没有流式连接能力');
      return;
    }
    let port = null;
    try { port = EXT.runtime.connect({ name: 'ldp-ai-stream' }); } catch (e) {
      if (watchdog) clearTimeout(watchdog);
      fallbackVideoSummary(item, transcript, '连接失败');
      return;
    }
    item.aiPort = port;
    const started = Date.now();
    state.answer = '';
    port.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.type === 'delta') {
        if (!state.answer) out.textContent = '';
        state.answer += String(msg.text || '');
        out.innerHTML = markdownToHtml(state.answer);
        out.classList.add('markdown');
        if (typeof showStreamDots === 'function') showStreamDots(item, out);
        if (meta) meta.textContent = '生成中 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
        if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, Math.min(94, 64 + Math.min(30, state.answer.length / 80)), '正在生成总结…');
        return;
      }
      if (msg.type === 'done') {
        if (/不包含可识别|无法进行|请提供.{0,12}(字幕|文本)|没有可识别|没有提供.{0,12}(字幕|文本)/i.test(String(state.answer || ''))) {
          finishOnce(() => fallbackVideoSummary(item, transcript, '文本模型误判字幕为空，正在直接重试'));
          return;
        }
        finishOnce(() => {
          state.busy = false;
          out.classList.remove('streaming');
          out.classList.add('markdown');
          out.dataset.tone = 'good';
          if (!state.answer) out.textContent = 'AI 没有返回内容。';
          else out.innerHTML = markdownToHtml(state.answer);
          if (typeof hideStreamDots === 'function') hideStreamDots(item);
          if (meta) meta.textContent = '总结来源：' + (state.source || '字幕') + ' · 生成完成 · 用时 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒' + (msg.model ? ' · ' + msg.model : '') + (state.startedAt ? ' · 总耗时 ' + Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) + ' 秒' : '');
          if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'video', 'AI 总结', 'done');
          const status = item.ui.videoStatus;
          const totalElapsed = state.startedAt ? Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) : '';
          if (status) { status.textContent = '已加载完成' + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : ''); status.classList.remove('streaming'); }
          if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, '总结完成' + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : ''));
          if (typeof revealSummaryWindow === 'function') setTimeout(() => revealSummaryWindow(item), 220);
          try { port.disconnect(); } catch (e) { /* ignore */ }
        });
        return;
      }
      if (msg.type === 'error') {
        finishOnce(() => {
          // A native port can be killed by the MV3 service worker while the
          // request is in flight.  Retry once through the message channel.
          fallbackVideoSummary(item, transcript, String(msg.detail || msg.reason || '流式请求失败'));
        });
      }
    });
    port.onDisconnect.addListener(() => {
      let lastError = null;
      try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
      if (lastError) finishOnce(() => fallbackVideoSummary(item, transcript, '后台连接断开'));
    });
    try { port.postMessage({ type: 'start', request }); } catch (e) {
      finishOnce(() => fallbackVideoSummary(item, transcript, '请求发送失败'));
    }
  }

  installVideoSummary();
