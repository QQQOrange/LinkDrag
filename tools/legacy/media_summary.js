  /* ==================================================================================
   *  §21 网页音视频内容总结
   *  媒体候选 -> 直链 / Blob / HLS 提取 -> SiliconFlow Qwen3-Omni -> 文字总结。
   *  当前页没有媒体时自动降级到网页文本总结。
   * ================================================================================== */
  const MEDIA_VIDEO_PROMPT = `你是专业的视频内容分析师。我会提供一段视频的字幕或语音转录文本，请总结这个视频讲了什么。

【输入说明】
文本来自自动语音识别，可能有错别字、标点缺失、口语重复，请自行理解修正；若带时间戳，请利用它定位关键内容。

【请依次输出】
1. 一句话概括：不超过 30 字，说明视频核心内容。
2. 内容概要：200–400 字，讲清主题、讲述者的主要观点，以及支撑观点的论据、案例或数据。
3. 关键要点：3–7 条，每条一句话，按视频出现顺序排列，句末标注时间戳（如 [03:12]）。
4. 结论：视频给出的结论、建议或号召；若无，写“视频未给出明确结论”。
5. 观看价值：这个视频适合谁看，看完能获得什么。

【要求】
- 只依据我提供的文本，不引入外部信息，不推测未提及的画面内容。
- 信息不足或含义模糊处，标注“原文未说明”，不要编造。
- 使用书面化中文，去除口语废话，不要逐句复述原文。

字幕如下：
（在此粘贴字幕）`;
  const MEDIA_AUDIO_PROMPT = MEDIA_VIDEO_PROMPT;
  const MEDIA_MAX_BYTES = 80 * 1024 * 1024;
  const SIDE_PANEL_KEY = 'LPS_SIDE_PANEL';
  const SUMMARY_LAYOUT_KEY = 'LPS_SUMMARY_LAYOUT';
  const summaryLayoutMemory = { tabTop: 42, width: 0, height: 0 };
  function readSummaryLayout() {
    try {
      if (EXT && EXT.storage && EXT.storage.local) {
        EXT.storage.local.get(SUMMARY_LAYOUT_KEY, value => {
          const saved = value && value[SUMMARY_LAYOUT_KEY];
          if (!saved || typeof saved !== 'object') return;
          if (Number.isFinite(Number(saved.tabTop))) summaryLayoutMemory.tabTop = Math.max(6, Math.min(94, Number(saved.tabTop)));
          if (Number(saved.width) > 0) summaryLayoutMemory.width = Number(saved.width);
          if (Number(saved.height) > 0) summaryLayoutMemory.height = Number(saved.height);
        });
      }
    } catch (e) { /* ignore */ }
  }
  function saveSummaryLayout() {
    try {
      if (EXT && EXT.storage && EXT.storage.local) {
        EXT.storage.local.set({ [SUMMARY_LAYOUT_KEY]: {
          tabTop: summaryLayoutMemory.tabTop,
          width: summaryLayoutMemory.width,
          height: summaryLayoutMemory.height
        } });
      }
    } catch (e) { /* ignore */ }
  }
  readSummaryLayout();
  const SUMMARY_LOADING_CSS = `[hidden]{display:none!important}.card{position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;min-width:390px;max-width:calc(100vw - 32px);padding:11px 14px;border:1px solid rgba(120,130,150,.35);border-radius:12px;background:rgba(247,248,251,.97);color:#20242c;box-shadow:0 12px 32px -14px rgba(0,0,0,.42);font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;pointer-events:auto;backdrop-filter:blur(12px)}.spinner{width:16px;height:16px;flex:0 0 16px;border:2px solid rgba(57,107,181,.2);border-top-color:#396bb5;border-radius:50%;animation:spin .8s linear infinite}.text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.percent{flex:0 0 auto;color:#396bb5;font-weight:700;font-variant-numeric:tabular-nums}.eta{flex:0 0 auto;color:#6c7280;font-size:11px;font-variant-numeric:tabular-nums}.track{position:absolute;left:10px;right:10px;bottom:5px;height:3px;border-radius:999px;background:rgba(57,107,181,.13);overflow:hidden}.bar{display:block;width:0;height:100%;border-radius:999px;background:#396bb5;transition:width .25s ease}.close{border:0;background:transparent;color:#6c7280;font:16px/1 sans-serif;cursor:pointer;padding:3px}.close:hover{color:#b33b4b}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-color-scheme:dark){.card{background:rgba(32,35,43,.97);color:#e9ebf0;border-color:#404552}.close{color:#a1a8b5}.eta{color:#a1a8b5}}`;
  let summaryLoadingHost = null;
  let summaryLoadingText = null;
  let summaryLoadingBar = null;
  let summaryLoadingPercent = null;
  let summaryLoadingEta = null;
  let summaryLoadingStartedAt = 0;
  let summaryLoadingEstimate = 30;
  let summaryLoadingRemaining = 0;
  let summaryLoadingItem = null;
  const douyinCapturedUrls = [];
  const genericCapturedUrls = [];

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    const source = event.data.source;
    if (source === 'LPS_DOUYIN_MEDIA') {
      const url = String(event.data.url || '');
      if (/^https?:\/\//i.test(url) && !douyinCapturedUrls.includes(url)) {
        douyinCapturedUrls.unshift(url);
        if (douyinCapturedUrls.length > 30) douyinCapturedUrls.length = 30;
      }
    } else if (source === 'LPS_MEDIA_URL') {
      const url = String(event.data.url || '');
      if (/^https?:\/\//i.test(url) && !genericCapturedUrls.includes(url)) {
        genericCapturedUrls.unshift(url);
        if (genericCapturedUrls.length > 30) genericCapturedUrls.length = 30;
      }
    }
  });

  function ensureGenericMediaHook() {
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) return;
    try { EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:installMediaHook' }, () => { try { void EXT.runtime.lastError; } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
  }

  function ensureSummaryLoading() {
    if (summaryLoadingHost && summaryLoadingHost.isConnected) return;
    const host = document.createElement('div');
    host.id = 'ldp-summary-loading';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important';
    host.hidden = true;
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SUMMARY_LOADING_CSS;
    root.appendChild(style);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<span class="spinner"></span><span class="text"></span><span class="percent">0%</span><span class="eta">正在估算…</span><button type="button" class="close" title="取消">×</button><div class="track"><i class="bar"></i></div>';
    const cancel = card.querySelector('.close');
    cancel.addEventListener('click', () => {
      const item = summaryLoadingItem;
      if (item) {
        if (item.mediaState) item.mediaState.cancelled = true;
        if (item.videoState) item.videoState.cancelled = true;
        hideSummaryLoading(item);
        if (item.ui && item.ui.win) item.ui.win.style.display = '';
      }
    });
    card.querySelector('.text').textContent = '正在准备总结…';
    root.appendChild(card);
    document.documentElement.appendChild(host);
    summaryLoadingHost = host;
    summaryLoadingText = card.querySelector('.text');
    summaryLoadingBar = card.querySelector('.bar');
    summaryLoadingPercent = card.querySelector('.percent');
    summaryLoadingEta = card.querySelector('.eta');
  }

  function formatSummaryEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return Math.ceil(seconds) + ' 秒';
    return Math.floor(seconds / 60) + ' 分 ' + Math.ceil(seconds % 60) + ' 秒';
  }

  function showSummaryLoading(item, text) {
    ensureSummaryLoading();
    summaryLoadingItem = item;
    summaryLoadingStartedAt = Date.now();
    summaryLoadingEstimate = 30;
    summaryLoadingRemaining = 30;
    summaryLoadingText.textContent = text || '正在准备总结…';
    summaryLoadingPercent.textContent = '4%';
    summaryLoadingEta.textContent = '正在估算…';
    summaryLoadingBar.style.width = '4%';
    if (summaryLoadingHost) {
      summaryLoadingHost.hidden = false;
      summaryLoadingHost.style.setProperty('display', 'block', 'important');
    }
  }

  function setSummaryEstimate(item, seconds) {
    if (summaryLoadingItem !== item) return;
    summaryLoadingEstimate = Math.max(8, Math.min(600, Number(seconds) || 30));
    summaryLoadingRemaining = Math.max(summaryLoadingRemaining || 0, summaryLoadingEstimate);
  }

  function updateSummaryLoading(item, percent, text) {
    if (summaryLoadingItem !== item) return;
    const value = Math.max(4, Math.min(100, Number(percent) || 0));
    if (text) summaryLoadingText.textContent = text;
    summaryLoadingBar.style.width = value + '%';
    if (summaryLoadingPercent) summaryLoadingPercent.textContent = Math.round(value) + '%';
    if (summaryLoadingEta) {
      const elapsed = Math.max(0.1, (Date.now() - (summaryLoadingStartedAt || Date.now())) / 1000);
      if (value >= 100) {
        summaryLoadingRemaining = 0;
        summaryLoadingEta.textContent = '完成';
      } else if (value <= 8) {
        summaryLoadingRemaining = Math.max(0, summaryLoadingEstimate - elapsed);
        summaryLoadingEta.textContent = '预计剩余 ' + formatSummaryEta(summaryLoadingRemaining);
      } else {
        // Estimate from actual progress velocity, but only allow the estimate
        // to move downward.  This makes the displayed ETA follow the bar
        // instead of jumping upward when a phase percentage changes.
        const velocityRemaining = Math.max(0, elapsed * (100 - value) / Math.max(1, value));
        const estimateRemaining = Math.max(0, summaryLoadingEstimate * (100 - value) / 100);
        const targetRemaining = Math.max(velocityRemaining, estimateRemaining);
        summaryLoadingRemaining = summaryLoadingRemaining
          ? Math.min(summaryLoadingRemaining, targetRemaining)
          : targetRemaining;
        summaryLoadingEta.textContent = summaryLoadingRemaining > 0
          ? '预计剩余 ' + formatSummaryEta(summaryLoadingRemaining)
          : '已用 ' + formatSummaryEta(elapsed);
      }
    }
    if (item.ui) {
      if (item.ui.mediaPercent) item.ui.mediaPercent.textContent = Math.round(value) + '%';
      if (item.ui.videoPercent) item.ui.videoPercent.textContent = Math.round(value) + '%';
    }
  }

  function hideSummaryLoading(item) {
    if (item && summaryLoadingItem !== item) return;
    summaryLoadingItem = null;
    if (summaryLoadingHost) {
      summaryLoadingHost.hidden = true;
      summaryLoadingHost.style.setProperty('display', 'none', 'important');
    }
  }

  function destroySummaryLoading() {
    hideSummaryLoading();
    if (summaryLoadingHost) {
      try { summaryLoadingHost.remove(); } catch (e) { /* ignore */ }
    }
    summaryLoadingHost = null;
    summaryLoadingItem = null;
    summaryLoadingText = null;
    summaryLoadingBar = null;
  }

  function hideSummaryWindow(item) {
    if (!item || !item.ui || !item.ui.win) return;
    item.summaryHidden = true;
    item.ui.win.style.display = 'none';
  }

  function cleanupMediaResources(item) {
    if (!item || item.summaryResourcesCleared) return;
    item.summaryResourcesCleared = true;
    if (item.aiPort) { try { item.aiPort.disconnect(); } catch (e) { /* ignore */ } item.aiPort = null; }
    if (item.ui && item.ui.summaryEdgeTab) { try { item.ui.summaryEdgeTab.remove(); } catch (e) { /* ignore */ } item.ui.summaryEdgeTab = null; }
    douyinCapturedUrls.length = 0;
    genericCapturedUrls.length = 0;
    try { window.postMessage({ source: 'LPS_DOUYIN_MEDIA_CLEAR' }, '*'); } catch (e) { /* ignore */ }
    try { window.postMessage({ source: 'LPS_MEDIA_URL_CLEAR' }, '*'); } catch (e) { /* ignore */ }
    if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
      try { EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:mediaClear' }, () => { try { void EXT.runtime.lastError; } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
    }
    destroySummaryLoading();
    if (item.mediaState) {
      item.mediaState.list = [];
      item.mediaState.transcript = '';
      if (item.mediaState.candidate) item.mediaState.candidate.element = null;
    }
    if (item.videoState) {
      item.videoState.transcript = '';
      if (item.videoState.info) item.videoState.info.video = null;
    }
  }

  function revealSummaryWindow(item) {
    hideSummaryLoading(item);
    if (!item || item.closed || !item.ui || !item.ui.win) return;
    item.summaryHidden = false;
    item.ui.win.style.display = '';
    if (item.ui.panel) item.ui.panel.hidden = false;
    cleanupMediaResources(item);
    installSummaryEdgeCollapse(item);
  }

  function revealSummaryWindowKeepLoading(item) {
    if (!item || item.closed || !item.ui || !item.ui.win) return;
    item.summaryHidden = false;
    item.ui.win.style.display = '';
    if (item.ui.panel) item.ui.panel.hidden = false;
  }

  function publishSidePanel(item, status, tone) {
    if (!EXT || !EXT.storage || !EXT.storage.local) return;
    const state = item && item.mediaState;
    if (!state) return;
    const candidate = state.candidate || (state.list && state.list[0]) || null;
    const data = {
      time: Date.now(),
      title: document.title || '内容总结',
      kind: state.textMode ? '网页' : (candidate && candidate.kind === 'audio' ? '音频' : '视频'),
      status: status || (state.busy ? '处理中…' : (state.error ? '失败' : '完成')),
      tone: tone || '',
      answer: state.answer || '',
      source: candidate && candidate.url ? candidate.url : location.href
    };
    try { EXT.storage.local.set({ [SIDE_PANEL_KEY]: data }); } catch (e) { /* ignore */ }
  }

  function mediaUrlKind(url, fallback) {
    const value = String(url || '');
    if (/\.m3u8(?:$|\?)/i.test(value)) return 'hls';
    if (/\.mpd(?:$|\?)/i.test(value)) return 'dash';
    if (/^blob:/i.test(value)) return 'blob';
    if (/\.(mp3|m4a|aac|wav|ogg|opus)(?:$|\?)/i.test(value)) return 'audio';
    if (/\.(mp4|webm|mov|mkv|ts|m4s)(?:$|\?)/i.test(value)) return 'video';
    return fallback || 'video';
  }

  function twitterDirectMediaUrls() {
    if (!/x\.com|twitter\.com/i.test(location.hostname)) return [];
    const urls = [];
    const add = raw => {
      const value = String(raw || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
      if (!/^https:\/\/video\.twimg\.com\//i.test(value)) return;
      if (!/\.(mp4|m3u8)(?:$|\?)/i.test(value)) return;
      if (urls.indexOf(value) < 0 && urls.length < 8) urls.push(value);
    };
    const patterns = [
      /https?:\\?\/\\?\/video\.twimg\.com\\?\/[^"'\\\s<>]+/ig,
      /"url"\s*:\s*"([^"]*video\.twimg\.com[^"]+)"/ig
    ];
    try {
      const html = String(document.documentElement.innerHTML || '');
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html))) add(match[1] || match[0]);
      }
    } catch (e) { /* ignore */ }
    try {
      for (const script of Array.from(document.scripts || [])) {
        const text = String(script.textContent || '');
        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(text))) add(match[1] || match[0]);
        }
      }
    } catch (e) { /* ignore */ }
    return urls;
  }

  function scanMediaCandidates() {
    const list = [];
    if (/x\.com|twitter\.com/i.test(location.hostname)) {
      const directTwitter = twitterDirectMediaUrls();
      for (const url of directTwitter) {
        list.push({ element: null, kind: 'video', url, srcKind: mediaUrlKind(url, 'video'), duration: 0, title: document.title || '', visible: true });
      }
    }
    const nodes = Array.from(document.querySelectorAll('video,audio'));
    for (const node of nodes) {
      if (!node || !node.isConnected) continue;
      const tag = String(node.tagName || '').toLowerCase();
      const kind = tag === 'audio' ? 'audio' : 'video';
      let src = String(node.currentSrc || node.src || '');
      if (!src) {
        const source = node.querySelector('source[src]');
        if (source) src = String(source.src || source.getAttribute('src') || '');
      }
      if (!src && /douyin\.com/i.test(location.hostname)) src = resolveDouyinMediaUrl();
      const rect = (() => { try { return node.getBoundingClientRect(); } catch (e) { return null; } })();
      if (kind === 'video') {
        if (!rect || rect.width < 160 || rect.height < 80 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      }
      if (!src) {
        if (node.srcObject) {
          list.push({ element: node, kind, url: '', srcKind: 'stream', duration: Number(node.duration) || 0, title: document.title || '', reason: '媒体来自 MediaStream/Canvas，无法直接导出为文件' });
        }
        continue;
      }
      const srcKind = mediaUrlKind(src, kind);
      list.push({
        element: node,
        kind: srcKind === 'audio' ? 'audio' : kind,
        url: src,
        srcKind,
        duration: Number(node.duration) || 0,
        title: String(node.getAttribute('aria-label') || node.getAttribute('title') || document.title || '').slice(0, 180),
        visible: !!rect && rect.width > 0 && rect.height > 0
      });
    }
    list.sort((a, b) => (a.kind === 'audio' && b.kind !== 'audio' ? -1 : a.kind !== 'audio' && b.kind === 'audio' ? 1 : 0));
    if (!list.some(candidate => candidate.url && !/^blob:/i.test(candidate.url))) {
      const baseElement = list.find(candidate => candidate.element)?.element || null;
      const youtubeAudio = typeof youtubeAudioUrl === 'function' ? youtubeAudioUrl() : '';
      if (youtubeAudio) list.push({ element: baseElement, kind: 'audio', url: youtubeAudio, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
      const capturedList = genericCapturedUrls.filter(url => !/^blob:/i.test(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 8);
      const douyinList = /douyin\.com|iesdouyin\.com/i.test(location.hostname)
        ? douyinCapturedUrls.filter(url => !/^blob:/i.test(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 8)
        : [];
      for (const captured of capturedList.concat(douyinList)) {
        if (list.some(candidate => candidate.url === captured)) continue;
        list.push({ element: baseElement, kind: /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(captured) ? 'audio' : 'video', url: captured, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
      }
      try {
        const perfList = performance.getEntriesByType('resource').map(entry => String(entry.name || '')).filter(name =>
          /\.(mp3|m4a|aac|wav|ogg|opus|mp4|webm|mov|m4s)(?:$|\?)/i.test(name) ||
          /(douyinvod|video\/tos|mime_type=video|audio\/tos|mime_type=audio|googlevideo|videoplayback)/i.test(name));
        for (const perf of perfList.slice(0, 8)) {
          if (list.some(candidate => candidate.url === perf)) continue;
          list.push({ element: baseElement, kind: /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(perf) ? 'audio' : 'video', url: perf, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
        }
      } catch (e) { /* ignore */ }
    }
    // Audio candidates must win over video-only DASH streams.
    if (/douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
      const baseElement = list.find(candidate => candidate.element)?.element || null;
      for (const captured of douyinCapturedUrls.filter(url => !/^blob:/i.test(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 12)) {
        if (list.some(candidate => candidate.url === captured)) continue;
        const isAudio = /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|media-audio|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(captured);
        list.push({ element: baseElement, kind: isAudio ? 'audio' : 'video', url: captured, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
      }
    }
    list.sort((a, b) => (a.kind === 'audio' && b.kind !== 'audio' ? -1 : a.kind !== 'audio' && b.kind === 'audio' ? 1 : 0));
    return list;
  }

  function parseJsonSafe(text) {
    try { return JSON.parse(String(text || '')); } catch (e) { return null; }
  }

  function collectDouyinAudioUrls(value, out, depth, parentKey) {
    if (!value || depth > 12 || out.length >= 8) return;
    if (Array.isArray(value)) {
      for (const item of value) collectDouyinAudioUrls(item, out, depth + 1, parentKey);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'music' || ((key === 'play_url' || key === 'play_url_h265') && parentKey === 'music')) {
        const urls = child && (Array.isArray(child.url_list) ? child.url_list : (typeof child.url === 'string' ? [child.url] : []));
        for (const raw of urls) {
          if (typeof raw === 'string' && /^https?:\/\//i.test(raw) && !out.includes(raw)) out.push(raw);
        }
      }
      collectDouyinAudioUrls(child, out, depth + 1, key);
    }
  }

  function collectDouyinUrls(value, out, depth) {
    if (!value || depth > 10 || out.length >= 8) return;
    if (Array.isArray(value)) {
      for (const item of value) collectDouyinUrls(item, out, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'play_addr' && child && Array.isArray(child.url_list)) {
        for (const raw of child.url_list) {
          if (typeof raw === 'string' && /^https?:\/\//i.test(raw) && !out.includes(raw)) out.push(raw);
        }
      }
      if (key === 'video' && child && child.play_addr) collectDouyinUrls(child.play_addr, out, depth + 1);
      collectDouyinUrls(child, out, depth + 1);
    }
  }

  function douyinPageDataUrls() {
    if (!/douyin\.com/i.test(location.hostname)) return [];
    const roots = [];
    const add = value => { if (value) roots.push(value); };
    try { add(window._ROUTER_DATA); } catch (e) { /* ignore */ }
    try { add(window.__INITIAL_STATE__); } catch (e) { /* ignore */ }
    try { add(window._SSR_DATA); } catch (e) { /* ignore */ }
    const ids = ['RENDER_DATA', '__NEXT_DATA__', '__NUXT_DATA__'];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node) continue;
      let text = String(node.textContent || '').trim();
      if (id === 'RENDER_DATA') {
        try { text = decodeURIComponent(text); } catch (e) { /* keep raw */ }
      }
      add(parseJsonSafe(text));
    }
    for (const script of Array.from(document.scripts || [])) {
      const text = String(script.textContent || '');
      if (!text || !/play_addr|aweme_detail|_ROUTER_DATA|__INITIAL_STATE__/.test(text)) continue;
      const router = text.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?/);
      if (router) add(parseJsonSafe(router[1]));
      const initial = text.match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?/);
      if (initial) add(parseJsonSafe(initial[1]));
      const play = text.match(/"play_addr"\s*:\s*(\{[\s\S]{0,3000}?\})\s*[,}]/);
      if (play) add(parseJsonSafe('{"play_addr":' + play[1] + '}'));
    }
    const urls = [];
    const audioUrls = [];
    for (const root of roots) {
      collectDouyinUrls(root, urls, 0);
      collectDouyinAudioUrls(root, audioUrls, 0, '');
    }
    return { urls, audioUrls };
  }

  function resolveDouyinAudioUrl() {
    if (!/douyin\.com/i.test(location.hostname)) return '';
    const captured = douyinCapturedUrls.find(url => !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(String(url || '')) && /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|music|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(String(url || '')));
    if (captured) return captured;
    const page = douyinPageDataUrls();
    return page.audioUrls.find(url => !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)) || '';
  }

  function resolveDouyinMediaUrl() {
    if (!/douyin\.com/i.test(location.hostname)) return '';
    const isImage = url => /\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(String(url || ''));
    const captured = douyinCapturedUrls.find(url => !isImage(url) && !/\.m4s(?:$|\?)/i.test(url));
    if (captured) return captured;
    const pageData = douyinPageDataUrls();
    const urls = (pageData.urls || []).filter(url => !isImage(url));
    if (urls.length) return urls[0];
    for (const video of Array.from(document.querySelectorAll('video'))) {
      const attrs = [video.currentSrc, video.src, video.getAttribute('data-src'), video.getAttribute('data-url')];
      for (const value of attrs) {
        if (value && /^https?:\/\//i.test(value) && !isImage(value)) return value;
      }
    }
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const name = String(entry.name || '');
        if (isImage(name)) continue;
        if (/\.(mp4|m4s|flv|mp3|m4a)(?:$|\?)/i.test(name) || /douyinvod|video\/tos|mime_type=video|mime_type=audio/i.test(name)) return name;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function probeMediaFromPage(pageUrl, callback) {    const done = value => { try { callback(value || ''); } catch (e) { /* ignore */ } };
    if (!/^https?:\/\//i.test(String(pageUrl || '')) || !EXT || !EXT.runtime) { done(''); return; }
    try {
      EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: pageUrl, timeoutMs: 15000 }, response => {
        if (!response || !response.ok || !response.text) { done(''); return; }
        const html = String(response.text);
        const candidates = [];
        const patterns = [
          /<video[^>]+src=["']([^"']+)["']/ig,
          /<audio[^>]+src=["']([^"']+)["']/ig,
          /<source[^>]+src=["']([^"']+)["']/ig,
          /<meta[^>]+(?:property|name)=["']og:(?:video|audio)(?::url)?["'][^>]+content=["']([^"']+)["']/ig
        ];
        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(html))) {
            const raw = String(match[1] || '').replace(/&amp;/gi, '&');
            if (!raw || /^(blob:|data:|javascript:)/i.test(raw)) continue;
            try {
              const resolved = new URL(raw, pageUrl).toString();
              if (/^https?:\/\//i.test(resolved)) candidates.push(resolved);
            } catch (e) { /* ignore */ }
          }
        }
        done(candidates[0] || '');
      });
    } catch (e) { done(''); }
  }

  function mediaBytesToDataUrl(buffer, mime) {    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return 'data:' + (mime || 'application/octet-stream') + ';base64,' + btoa(binary);
  }

  async function readBlobMedia(candidate) {
    if (!/^blob:/i.test(candidate.url)) return null;
    try {
      const response = await fetch(candidate.url);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MEDIA_MAX_BYTES) throw new Error('媒体超过 ' + Math.round(MEDIA_MAX_BYTES / 1024 / 1024) + 'MB');
      const mime = response.headers.get('content-type') || (candidate.kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      return { dataUrl: mediaBytesToDataUrl(buffer, mime), mime, size: buffer.byteLength };
    } catch (e) {
      if (/douyin\.com/i.test(location.hostname)) {
        throw new Error('抖音视频的 Blob 是 MediaSource 临时流，浏览器不能直接 fetch。已尝试从页面 RENDER_DATA / _ROUTER_DATA / play_addr 中查找真实视频地址，但未找到；请刷新视频页后重试。');
      }
      throw new Error('Blob 读取失败：' + (e && e.message ? e.message : '权限不足或媒体已被释放'));
    }
  }

  function requestMediaAI(payload) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: '媒体总结超过 300 秒没有返回，已停止等待' }), 300000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) {
        finish({ ok: false, reason: 'no-extension', detail: '当前页面不能连接扩展后台' });
        return;
      }
      try {
        const request = Object.assign({ referer: location.href, title: document.title || '', url: location.href }, payload || {});
        const sendToWorker = value => {
          EXT.runtime.sendMessage(Object.assign({ namespace: 'LPS_EXT', type: 'ldp:media' }, value), response => {
            let lastError = null;
            try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
            if (lastError) {
              const detail = /context invalidated|extension context/i.test(String(lastError.message || lastError))
                ? '扩展已重新加载，当前页面仍是旧脚本。请刷新当前网页后重试。'
                : '扩展后台连接失败：' + String(lastError.message || lastError);
              finish({ ok: false, reason: 'network', detail });
              return;
            }
            finish(response || { ok: false, reason: 'network', detail: '后台没有返回结果' });
          });
        };
        // Chrome messaging cannot carry a multi-megabyte audio DataURL.
        // Put large inline audio in extension storage, then send only its key.
        let serialized = '';
        try { serialized = JSON.stringify(request); } catch (e) { serialized = ''; }
        const hasInlineAudio = !!(request.dataUrl || (Array.isArray(request.audioChunks) && request.audioChunks.length));
        if (hasInlineAudio && serialized.length > 8 * 1024 * 1024) {
          const storage = EXT.storage && EXT.storage.local ? EXT.storage.local : (globalThis.chrome && chrome.storage && chrome.storage.local);
          if (!storage) {
            finish({ ok: false, reason: 'too-large', detail: '音频数据过大，当前环境无法暂存到扩展存储' });
            return;
          }
          const key = 'LPS_MEDIA_PAYLOAD_' + Date.now() + '_' + Math.random().toString(36).slice(2);
          const stored = { dataUrl: request.dataUrl || '', audioChunks: Array.isArray(request.audioChunks) ? request.audioChunks : [] };
          storage.set({ [key]: stored }, () => {
            try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
            const slim = Object.assign({}, request, { payloadKey: key, dataUrl: '', audioChunks: [] });
            sendToWorker(slim);
          });
          return;
        }
        sendToWorker(request);
      } catch (e) {
        const message = String(e && e.message || '未知错误');
        const detail = /context invalidated|extension context/i.test(message)
          ? '扩展已重新加载，当前页面仍是旧脚本。请刷新当前网页后重试。'
          : '扩展后台连接失败：' + message;
        finish({ ok: false, reason: 'network', detail });
      }
    });
  }

  function requestMediaBytes(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(null), 120000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish(null); return; }
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:mediaBytes', url, referer: location.href, timeoutMs: 60000 }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          finish(response && response.ok ? response : null);
        });
      } catch (e) { finish(null); }
    });
  }

  function requestRemoteTranscript(candidate) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: '远程转写超过 300 秒没有返回' }), 300000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish(null); return; }
      const endpoint = aiConfig.mediaEndpoint || '';
      const key = aiConfig.mediaApiKey || (aiConfig.apiKeys && aiConfig.apiKeys.siliconflow) || '';
      const model = aiConfig.mediaModel || 'FunAudioLLM/SenseVoiceSmall';
      try {
        EXT.runtime.sendMessage({
          namespace: 'LPS_EXT',
          type: 'ldp:transcribeRemote',
          url: candidate.url,
          referer: location.href,
          title: document.title || '',
          endpoint,
          key,
          model,
          chunkSeconds: 300
        }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          finish(response || null);
        });
      } catch (e) { finish(null); }
    });
  }

  function requestDouyinDetail() {
    return new Promise(resolve => {
      if (!/douyin\.com|iesdouyin\.com/i.test(location.hostname)) { resolve(null); return; }
      let settled = false;
      const id = 'dy-detail-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const finish = value => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(value || null);
      };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_DOUYIN_DETAIL_RESULT' || event.data.id !== id) return;
        finish(event.data.ok ? { audio: event.data.audio || [], video: event.data.video || [], title: event.data.title || '' } : null);
      };
      const timer = setTimeout(() => finish(null), 9000);
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_DOUYIN_DETAIL', id }, '*'); } catch (e) { finish(null); }
    });
  }

  function requestDouyinResolve(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(null), 20000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish(null); return; }
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:resolveDouyin', url }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          finish(response && response.ok ? response : null);
        });
      } catch (e) { finish(null); }
    });
  }

  function dataUrlToArrayBuffer(dataUrl) {
    const comma = String(dataUrl || '').indexOf(',');
    if (comma < 0) return null;
    const base64 = String(dataUrl).slice(comma + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function audioBufferToWav(buffer, sampleRate, channels, startFrame, endFrame) {
    const sourceRate = buffer.sampleRate;
    const sourceChannels = Math.max(1, buffer.numberOfChannels || 1);
    const outRate = sampleRate || sourceRate;
    const outChannels = channels || Math.min(2, sourceChannels);
    const start = Math.max(0, Math.floor(startFrame || 0));
    const end = Math.min(buffer.length, Math.ceil(endFrame == null ? buffer.length : endFrame));
    const frames = Math.max(0, end - start);
    const out = new ArrayBuffer(44 + frames * outChannels * 2);
    const view = new DataView(out);
    const writeString = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + frames * outChannels * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, outChannels, true);
    view.setUint32(24, outRate, true);
    view.setUint32(28, outRate * outChannels * 2, true);
    view.setUint16(32, outChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, frames * outChannels * 2, true);
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      const sourceIndex = Math.min(buffer.length - 1, Math.floor((start + i) * sourceRate / outRate));
      for (let c = 0; c < outChannels; c++) {
        const sample = buffer.getChannelData(Math.min(c, sourceChannels - 1))[sourceIndex] || 0;
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  async function audioBufferToWavChunks(buffer, chunkSeconds = 300) {
    if (!buffer || !buffer.length) return [];
    const outRate = 16000;
    const framesPerChunk = Math.max(1, Math.round(outRate * Math.max(30, chunkSeconds)));
    const chunks = [];
    for (let start = 0; start < buffer.length; start += Math.round(framesPerChunk * buffer.sampleRate / outRate)) {
      const blob = audioBufferToWav(buffer, outRate, 1, start, Math.min(buffer.length, start + Math.round(framesPerChunk * buffer.sampleRate / outRate)));
      if (blob.size > 44) chunks.push(await blobToDataUrl(blob));
    }
    return chunks;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('音频编码失败'));
      reader.readAsDataURL(blob);
    });
  }

  async function extractAudioFromVideo(candidate) {
    if (!candidate || candidate.kind !== 'video' || !candidate.url) return null;
    if (candidate.srcKind === 'dash' || candidate.srcKind === 'stream') return null;
    let arrayBuffer = null;
    try {
      if (candidate.srcKind === 'blob') {
        const response = await fetch(candidate.url);
        arrayBuffer = await response.arrayBuffer();
      } else {
        const data = await requestMediaBytes(candidate.url);
        if (!data || !data.dataUrl) return null;
        arrayBuffer = dataUrlToArrayBuffer(data.dataUrl);
      }
    } catch (e) { return null; }
    if (!arrayBuffer || arrayBuffer.byteLength > MEDIA_MAX_BYTES) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    const context = new AudioCtor();
    try {
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      const channel = audioBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < channel.length; i += 16) peak = Math.max(peak, Math.abs(channel[i]));
      if (peak < 0.0005) return null;
      const chunks = await audioBufferToWavChunks(audioBuffer);
      if (!chunks.length) return null;
      const fullBlob = audioBufferToWav(audioBuffer, 16000, 1, 0, audioBuffer.length);
      return { dataUrl: chunks[0], chunks, fullBlob, mime: 'audio/wav', duration: audioBuffer.duration };
    } catch (e) {
      return null;
    } finally {
      try { context.close(); } catch (e) { /* ignore */ }
    }
  }

  async function extractAudioFromUrl(candidate) {
    if (!candidate || candidate.kind !== 'audio' || !candidate.url) return null;
    if (candidate.srcKind === 'blob' || candidate.srcKind === 'stream') return null;
    let arrayBuffer = null;
    try {
      const data = await requestMediaBytes(candidate.url);
      if (data && data.dataUrl) arrayBuffer = dataUrlToArrayBuffer(data.dataUrl);
    } catch (e) { return null; }
    if (!arrayBuffer || arrayBuffer.byteLength > MEDIA_MAX_BYTES) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    const context = new AudioCtor();
    try {
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      const channel = audioBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < channel.length; i += 16) peak = Math.max(peak, Math.abs(channel[i]));
      if (peak < 0.0005) return null;
      const chunks = await audioBufferToWavChunks(audioBuffer);
      if (!chunks.length) return null;
      return { dataUrl: chunks[0], chunks, mime: 'audio/wav', duration: audioBuffer.duration };
    } catch (e) {
      return null;
    } finally {
      try { context.close(); } catch (e) { /* ignore */ }
    }
  }

  async function captureStreamAudioWebAudio(video, item) {
    if (!video || typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    let stream = null;
    let context = null;
    try {
      stream = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
      if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return null;
      context = new AudioCtor();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;
      const samples = [];
      processor.onaudioprocess = event => {
        const data = event.inputBuffer.getChannelData(0);
        samples.push(new Float32Array(data));
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      if (item && item.ui && item.ui.mediaStatus) item.ui.mediaStatus.textContent = '正在从播放器捕获音频…';
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 30, '正在从播放器捕获音频…');
      const wasPaused = !!video.paused;
      const oldTime = Number(video.currentTime) || 0;
      const oldRate = Number(video.playbackRate) || 1;
      const oldMuted = !!video.muted;
      const oldVolume = Number(video.volume);
      video.muted = false;
      video.volume = Math.max(0.2, Number(video.volume) || 1);
      video.currentTime = 0;
      video.playbackRate = 1.25;
      try { video.preservesPitch = true; } catch (e) { /* ignore */ }
      try { await video.play(); } catch (e) { /* ignore */ }
      const duration = Number(video.duration) || 0;
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / 1.25 + 2000)) : 35 * 60 * 1000;
      await new Promise(resolve => {
        let done = false;
        let lastTime = video.currentTime;
        const onProgress = () => { lastTimeWall = Date.now(); };
        const onTimeUpdate = () => { lastTimeWall = Date.now(); };
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearInterval(progressTimer);
          video.removeEventListener('ended', finish);
          video.removeEventListener('progress', onProgress);
          video.removeEventListener('timeupdate', onTimeUpdate);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        const progressTimer = setInterval(() => {
          if (video.currentTime > lastTime + 0.05) lastTime = video.currentTime;
          else if (video.currentTime === lastTime && Date.now() - lastTimeWall > 5000) finish();
        }, 1000);
        let lastTimeWall = Date.now();
        video.addEventListener('progress', onProgress, { passive: true });
        video.addEventListener('timeupdate', onTimeUpdate, { passive: true });
        video.addEventListener('ended', finish, { once: true });
      });
      try { processor.disconnect(); source.disconnect(); silent.disconnect(); } catch (e) { /* ignore */ }
      try { stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      video.playbackRate = oldRate;
      video.muted = oldMuted;
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      if (wasPaused) { try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ } }
      if (!samples.length) { try { context.close(); } catch (e) { /* ignore */ } return null; }
      const total = samples.reduce((sum, part) => sum + part.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const part of samples) { merged.set(part, offset); offset += part.length; }
      let peak = 0;
      for (let i = 0; i < merged.length; i += 8) peak = Math.max(peak, Math.abs(merged[i]));
      if (peak < 0.0005) { try { context.close(); } catch (e) { /* ignore */ } return null; }
      const audioBuffer = context.createBuffer(1, total, context.sampleRate);
      audioBuffer.copyToChannel(merged, 0);
      const chunks = await audioBufferToWavChunks(audioBuffer);
      try { context.close(); } catch (e) { /* ignore */ }
      if (!chunks.length) return null;
      return { dataUrl: chunks[0], chunks, mime: 'audio/wav', duration: audioBuffer.duration };
    } catch (e) {
      try { if (stream) stream.getTracks().forEach(track => track.stop()); } catch (e2) { /* ignore */ }
      try { if (context) context.close(); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  async function blobHasAudio(blob) {
    if (!blob || !blob.size) return false;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return true;
    let context = null;
    try {
      const buffer = await blob.arrayBuffer();
      context = new AudioCtor();
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const channel = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < channel.length; i += 16) peak = Math.max(peak, Math.abs(channel[i]));
      return peak >= 0.0005;
    } catch (e) {
      return true;
    } finally {
      try { if (context) context.close(); } catch (e) { /* ignore */ }
    }
  }

  async function captureStreamAudio(candidate, item) {
    const video = candidate && candidate.element;
    if (!video || typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') return null;
    let stream = null;
    try { stream = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream(); } catch (e) { return null; }
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return null;
    if (typeof MediaRecorder === 'undefined') return captureStreamAudioWebAudio(video, item);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''].find(type => !type || MediaRecorder.isTypeSupported(type));
    if (mime == null) return captureStreamAudioWebAudio(video, item);
    const chunks = [];
    let recorder = null;
    const wasPaused = !!video.paused;
    const oldTime = Number(video.currentTime) || 0;
    const oldRate = Number(video.playbackRate) || 1;
    const oldMuted = !!video.muted;
    const oldVolume = Number(video.volume);
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; recorder.onerror = resolve; });
      recorder.start(1000);
      video.muted = false;
      video.volume = Math.max(0.2, Number(video.volume) || 1);
      if (item && item.ui && item.ui.mediaStatus) item.ui.mediaStatus.textContent = '正在从播放器录制音频…';
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 28, '正在从播放器录制音频…');
      video.currentTime = 0;
      video.playbackRate = 1.25;
      try { video.preservesPitch = true; } catch (e) { /* ignore */ }
      try { await video.play(); } catch (e) { /* autoplay may still work after gesture */ }
      const duration = Number(video.duration) || 0;
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / 1.25 + 2000)) : 35 * 60 * 1000;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('ended', finish); resolve(); };
        const timer = setTimeout(finish, waitMs);
        video.addEventListener('ended', finish, { once: true });
      });
      try { recorder.stop(); } catch (e) { /* ignore */ }
      await stopped;
      try { stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      video.playbackRate = oldRate;
      video.muted = oldMuted;
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      if (wasPaused) { try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ } }
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      if (!blob.size || !(await blobHasAudio(blob))) return captureStreamAudioWebAudio(video, item);
      return { dataUrl: await blobToDataUrl(blob), mime: blob.type || 'audio/webm', duration };
    } catch (e) {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e2) { /* ignore */ }
      try { stream.getTracks().forEach(track => track.stop()); } catch (e2) { /* ignore */ }
      video.playbackRate = oldRate;
      if (wasPaused) { try { video.pause(); video.currentTime = oldTime; } catch (e2) { /* ignore */ } }
      return captureStreamAudioWebAudio(video, item);
    }
  }

  function mediaErrorText(result) {
    const reason = String((result && result.reason) || '');
    const detail = String((result && result.detail) || '');
    if (reason === 'missing-key') return '缺少硅基流动 API Key：设置 → AI 接口 → 硅基流动 API Key。';
    if (reason === 'missing-config') return '没有配置媒体接口地址。';
    if (reason === 'encrypted') return '这是加密媒体流（AES/DRM），浏览器无法解密导出。' + (detail ? '\n' + detail : '');
    if (reason === 'too-large') return '媒体体积过大，无法一次上传。' + (detail ? '\n' + detail : '');
    if (reason === 'cors') return '媒体跨域读取失败，站点禁止了跨域下载。' + (detail ? '\n' + detail : '');
    if (reason === 'timeout') return '媒体请求超时，可能是文件过大或网络被阻断。';
    if (reason === 'dash' || reason === 'invalid-hls' || reason === 'empty-hls') return '暂不支持解析这个流媒体格式：' + detail;
    if (reason === 'no-media' || reason === 'invalid-url') return '没有拿到可上传的媒体文件。' + (detail ? '\n' + detail : '');
    if (reason === 'asr') return '音频转写失败：' + (detail || '请检查媒体 API Key、ASR 接口和音频格式。');
    if (reason === 'audio-required') return '视频必须先转为音频再总结：' + (detail || '没有拿到可用音轨。');
    if (reason === 'decode' || reason === 'decode-media') return '音频解码失败：' + (detail || '浏览器无法解码该媒体格式。');
    if (reason === 'empty-asr') return 'ASR 返回空文本：音频可能没有声音，或转写模型不支持该语言/格式。';
    if (reason === 'network') return '网络请求失败：' + (detail || '请检查网络或接口域名。');
    if (reason === 'http' || /HTTP\s+403/i.test(detail)) {
      if (/ASR HTTP/i.test(detail)) return '音频转写接口返回 403：请检查设置里的硅基流动 API Key 是否有语音转写权限，以及账号额度。';
      return '媒体文件下载被拒绝（HTTP 403）：可能是 CDN 防盗链/登录限制，或视频地址已过期。';
    }
    if (reason === 'empty') return '接口没有返回可用文本。' + (detail ? '\n' + detail : '');
    if (/50507|Unknown error/i.test(detail)) return 'Qwen 视频接口返回 50507：该视频流未被接口接受，通常是只有 blob/MediaSource 或没有独立音频。已尝试音频捕获；若仍失败请不要把视频直接交给 Qwen，而应使用音频链路。';
    return '媒体总结失败：' + (detail || reason || '未知错误');
  }

  function bindSummaryDrag(item) {
    if (!item || !item.ui || !item.ui.panel || item.ui.panel.dataset.summaryDragBound) return;
    const head = item.ui.panel.querySelector('.panel-head');
    if (!head) return;
    item.ui.panel.dataset.summaryDragBound = '1';
    head.addEventListener('pointerdown', event => {
      if (event.target && event.target.closest && event.target.closest('button')) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = Object.assign({}, item.rect);
      item.summaryFree = true;
      item.summaryDock = 'free';
      item.ui.win.dataset.summaryDock = 'free';
      try { head.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      const move = ev => {
        const v = viewport();
        const width = startRect.w || item.rect.w || 420;
        const height = startRect.h || item.rect.h || v.h;
        item.rect = Object.assign({}, item.rect, {
          x: clamp(startRect.x + ev.clientX - startX, 0, Math.max(0, v.w - width)),
          y: clamp(startRect.y + ev.clientY - startY, 0, Math.max(0, v.h - height))
        });
        renderGeometry(item, true);
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  function syncSummaryBackdrop() {
    if (!shell || !shell.backdrop) return;
    guardSummaryBackdrop();
    // Do NOT hide a summary merely because its panel is momentarily hidden
    // while renderTextAISummaryPanel() is still building.  That race left the
    // window display:none (and the page scroll-locked) with no visible popup.
    const hasSummary = windows.some(w => !w.closed && w.ui && w.ui.win && w.ui.win.classList.contains('summary-window'));
    const hasOtherWindow = windows.some(w => !w.closed && w.ui && w.ui.win && !w.ui.win.classList.contains('summary-window'));
    if (hasSummary) {
      shell.backdrop.hidden = true;
      shell.backdrop.dataset.summaryNoBlur = '1';
      shell.backdrop.style.background = 'transparent';
      shell.backdrop.style.backdropFilter = 'none';
      shell.backdrop.style.webkitBackdropFilter = 'none';
      shell.backdrop.style.pointerEvents = 'none';
    } else if (shell.backdrop.dataset.summaryNoBlur) {
      delete shell.backdrop.dataset.summaryNoBlur;
      shell.backdrop.style.background = '';
      shell.backdrop.style.backdropFilter = '';
      shell.backdrop.style.webkitBackdropFilter = '';
      shell.backdrop.style.pointerEvents = '';
      if (!hasOtherWindow) shell.backdrop.hidden = true;
    }
  }

  function guardSummaryBackdrop() {
    if (!shell || !shell.backdrop || shell.backdrop.dataset.ldpSummaryGuard) return;
    shell.backdrop.dataset.ldpSummaryGuard = '1';
    const guard = event => {
      const hasSummary = windows.some(w => !w.closed && w.ui && w.ui.win && w.ui.win.classList.contains('summary-window'));
      if (!hasSummary) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    };
    shell.backdrop.addEventListener('pointerdown', guard, true);
    shell.backdrop.addEventListener('click', guard, true);
  }

  function summaryThemeDark() {
    try { return !!(typeof shell !== 'undefined' && shell && shell.host && shell.host.dataset.theme === 'dark'); } catch (e) { return false; }
  }

  function applySummaryTabTheme(item) {
    const tab = item && item.ui && item.ui.summaryEdgeTab;
    if (!tab) return;
    const dark = summaryThemeDark();
    tab.style.setProperty('background', dark ? '#20242c' : '#ffffff', 'important');
    tab.style.setProperty('color', dark ? '#cfe0ff' : '#2459b8', 'important');
    tab.style.setProperty('border-color', dark ? '#3a4658' : '#8fa8cc', 'important');
    tab.style.setProperty('box-shadow', dark ? '-5px 5px 20px -8px rgba(0,0,0,.7)' : '-5px 5px 20px -8px rgba(0,0,0,.45)', 'important');
  }

  function refreshSummaryTheme(themeName) {
    const dark = themeName ? themeName === 'dark' : summaryThemeDark();
    for (const item of windows) {
      if (!item || item.closed || !item.ui || !item.ui.win || !item.ui.win.classList.contains('summary-window')) continue;
      try { applySummaryTabTheme(item); } catch (e) { /* ignore */ }
      if (!item.summaryCollapsed && !item.summaryHidden) {
        try { applySummaryWindow(item, false); } catch (e) { /* ignore */ }
      }
    }
    // The video AI launcher lives outside the shadow host.
    try { if (typeof refreshVideoAITheme === 'function') refreshVideoAITheme(); } catch (e) { /* ignore */ }
    try {
      document.querySelectorAll('.ldp-video-ai').forEach(button => {
        button.style.background = dark ? '#20242c' : '#ffffff';
        button.style.color = dark ? '#cfe0ff' : '#2459b8';
        button.style.borderColor = dark ? '#3a4658' : '#8fa8cc';
      });
    } catch (e) { /* ignore */ }
  }

  function installSummaryEdgeCollapse(item) {
    if (!item || !item.ui || !item.ui.win || !item.ui.panel) return;
    const win = item.ui.win;
    const head = item.ui.panel.querySelector('.panel-head');
    if (!head) return;
    if (item.ui.summaryCollapseBtn && item.ui.summaryCollapseBtn.isConnected && item.ui.summaryCollapseBtn.parentNode === head && item.ui.summaryEdgeTab && item.ui.summaryEdgeTab.isConnected) return;
    if (item.ui.summaryCollapseBtn) { try { item.ui.summaryCollapseBtn.remove(); } catch (e) { /* ignore */ } item.ui.summaryCollapseBtn = null; }
    if (item.ui.summaryEdgeTab && !item.ui.summaryEdgeTab.isConnected) { try { item.ui.summaryEdgeTab.remove(); } catch (e) { /* ignore */ } item.ui.summaryEdgeTab = null; }
    const btn = el('button', 'btn panel-collapse');
    btn.type = 'button';
    btn.title = '贴边收起';
    btn.setAttribute('aria-label', '贴边收起');
    btn.textContent = '‹';
    btn.style.cssText = 'font-size:18px;line-height:1;padding:0 7px;height:26px;color:var(--muted);cursor:pointer;background:transparent;border:0';
    let tab = item.ui.summaryEdgeTab;
    if (!tab) {
      tab = el('button', 'summary-edge-tab');
      tab.type = 'button';
      tab.title = '展开 AI 总结';
      tab.setAttribute('aria-label', '展开 AI 总结');
      tab.innerHTML = '<span class="summary-edge-spark">✦</span><span class="summary-edge-label">AI</span><span class="summary-edge-arrow">展开 ›</span>';
      tab.style.cssText = 'display:none!important;position:fixed!important;left:auto!important;right:0!important;top:44%!important;transform:translateY(-50%)!important;z-index:2147483647!important;width:48px!important;height:92px!important;padding:8px 3px!important;border:1px solid #8fa8cc!important;border-right:0!important;border-left:1px solid #8fa8cc!important;border-radius:12px 0 0 12px!important;background:#ffffff!important;color:#2459b8!important;box-shadow:-5px 5px 20px -8px rgba(0,0,0,.45)!important;cursor:pointer!important;font:700 11px/1.1 sans-serif!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:4px!important;pointer-events:auto!important;visibility:visible!important;opacity:1!important;';
      tab.querySelector('.summary-edge-spark').style.cssText = 'font-size:18px;line-height:1';
      tab.querySelector('.summary-edge-label').style.cssText = 'font-size:10px;letter-spacing:.05em';
      tab.querySelector('.summary-edge-arrow').style.cssText = 'font-size:9px;line-height:1;margin-top:2px;white-space:nowrap';
      document.documentElement.appendChild(tab);
    }
    const wasCollapsed = !!item.summaryCollapsed;
    item.ui.summaryCollapseBtn = btn;
    item.ui.summaryEdgeTab = tab;
    item.summaryCollapsed = wasCollapsed;

    const tabSide = () => {
      let dock = item.summaryDock;
      if (!dock || dock === 'free') {
        const v = viewport();
        const rect = item.rect || { x: 0, w: 0 };
        dock = rect.x + rect.w / 2 < v.w / 2 ? 'left' : 'right';
      }
      return dock === 'left' ? 'left' : 'right';
    };
    const placeTab = () => {
      const side = tabSide();
      const top = Number(item.summaryTabTop == null ? summaryLayoutMemory.tabTop : item.summaryTabTop);
      tab.dataset.side = side;
      tab.style.setProperty('left', side === 'left' ? '0' : 'auto', 'important');
      tab.style.setProperty('right', side === 'right' ? '0' : 'auto', 'important');
      tab.style.setProperty('top', Math.max(6, Math.min(94, Number.isFinite(top) ? top : 42)) + '%', 'important');
      tab.style.setProperty('border-left', side === 'left' ? '0' : '1px solid #8fa8cc', 'important');
      tab.style.setProperty('border-right', side === 'right' ? '0' : '1px solid #8fa8cc', 'important');
      tab.style.setProperty('border-radius', side === 'right' ? '12px 0 0 12px' : '0 12px 12px 0', 'important');
      tab.style.setProperty('box-shadow', side === 'right' ? '-5px 5px 20px -8px rgba(0,0,0,.45)' : '5px 5px 20px -8px rgba(0,0,0,.45)', 'important');
      applySummaryTabTheme(item);
    };
    placeTab();
    let tabPressTimer = 0;
    let tabDragging = false;
    let tabWasDragged = false;
    let tabPressY = 0;
    tab.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      tabPressY = event.clientY;
      clearTimeout(tabPressTimer);
      tabPressTimer = setTimeout(() => {
        tabDragging = true;
        tabWasDragged = true;
        tab.style.cursor = 'grabbing';
        try { tab.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
      }, 350);
    });
    tab.addEventListener('pointermove', event => {
      if (!tabDragging) {
        if (Math.abs(event.clientY - tabPressY) > 6) clearTimeout(tabPressTimer);
        return;
      }
      event.preventDefault();
      const v = viewport();
      const pct = Math.max(6, Math.min(94, (event.clientY / Math.max(1, v.h)) * 100));
      item.summaryTabTop = pct;
      summaryLayoutMemory.tabTop = pct;
      tab.style.setProperty('top', pct + '%', 'important');
    });
    const endTabPress = cancelled => {
      clearTimeout(tabPressTimer);
      if (tabDragging) {
        tabDragging = false;
        tab.style.cursor = 'pointer';
        summaryLayoutMemory.tabTop = Number(item.summaryTabTop || summaryLayoutMemory.tabTop);
        saveSummaryLayout();
        setTimeout(() => { tabWasDragged = false; }, 420);
      } else if (!cancelled) {
        // pointerdown preventDefault() can suppress the synthetic click, so
        // expand from pointerup as well.
        expand();
      }
    };
    tab.addEventListener('pointerup', () => endTabPress(false));
    tab.addEventListener('pointercancel', () => endTabPress(true));
    if (wasCollapsed) {
      tab.hidden = false;
      tab.style.setProperty('display', 'flex', 'important');
      win.style.display = 'none';
    }
    const expand = () => {
      if (!item || item.closed || !item.summaryCollapsed) return;
      item.summaryCollapsed = false;
      item.summaryHidden = false;
      tab.hidden = true;
      tab.style.setProperty('display', 'none', 'important');
      win.style.display = '';
      if (typeof applySummaryWindow === 'function') applySummaryWindow(item, false);
      const v = viewport();
      const rect = item.rect || { x: 0, w: 400 };
      const side = tabSide();
      const dx = side === 'right' ? (v.w - rect.x + 24) : -(rect.x + rect.w + 24);
      win.style.transition = 'none';
      win.style.transform = 'translateX(' + Math.round(dx) + 'px)';
      win.style.opacity = '0';
      requestAnimationFrame(() => {
        win.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1), opacity .2s ease';
        win.style.transform = 'translateX(0)';
        win.style.opacity = '';
      });
      setTimeout(() => {
        if (!item.closed && !item.summaryCollapsed) {
          win.style.transition = '';
          win.style.transform = '';
        }
      }, 300);
    };
    const collapse = () => {
      if (!item || item.closed || item.summaryCollapsed) return;
      item.summaryCollapsed = true;
      const v = viewport();
      const rect = item.rect || { x: 0, w: 400 };
      const dx = rect.x < v.w / 2 ? -(rect.x + rect.w + 24) : (v.w - rect.x + 24);
      win.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1), opacity .2s ease';
      win.style.transform = 'translateX(' + Math.round(dx) + 'px)';
      win.style.opacity = '0';
      placeTab();
      tab.hidden = false;
      tab.style.setProperty('display', 'flex', 'important');
      tab.style.setProperty('transform', 'translateY(-50%)', 'important');
      try {
        const side = tabSide();
        tab.animate([
          { opacity: 0, transform: 'translateY(-50%) translateX(' + (side === 'right' ? '100%' : '-100%') + ')' },
          { opacity: 1, transform: 'translateY(-50%) translateX(0)' }
        ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
      } catch (e) { /* older engine */ }
      try { if (typeof toast === 'function') toast(item, '已贴边隐藏，点击左侧 AI 按钮展开'); } catch (e) { /* ignore */ }
      setTimeout(() => {
        if (item.summaryCollapsed) {
          win.style.display = 'none';
          win.style.transform = '';
          win.style.opacity = '';
          win.style.transition = '';
        }
      }, 250);
    };
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      collapse();
    });
    tab.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      if (tabWasDragged) { tabWasDragged = false; return; }
      expand();
    });
    head.insertBefore(btn, head.querySelector('.panel-close') || null);
  }

  function bindSummaryResize(item) {
    if (!item || !item.ui || !item.ui.win) return;
    if (item.ui.summaryResizeHandles && item.ui.summaryResizeHandles.every(handle => handle.isConnected)) return;
    const win = item.ui.win;
    if (item.ui.summaryResizeHandles) {
      item.ui.summaryResizeHandles.forEach(handle => { try { handle.remove(); } catch (e) { /* ignore */ } });
    }
    item.ui.summaryResizeHandles = [];
    const edgeStyle = {
      n: 'top:-4px;left:14px;right:14px;height:8px;cursor:ns-resize',
      s: 'bottom:-4px;left:14px;right:14px;height:8px;cursor:ns-resize',
      e: 'right:-4px;top:14px;bottom:14px;width:8px;cursor:ew-resize',
      w: 'left:-4px;top:14px;bottom:14px;width:8px;cursor:ew-resize',
      ne: 'right:-5px;top:-5px;width:14px;height:14px;cursor:nesw-resize',
      nw: 'left:-5px;top:-5px;width:14px;height:14px;cursor:nwse-resize',
      se: 'right:-5px;bottom:-5px;width:14px;height:14px;cursor:nwse-resize',
      sw: 'left:-5px;bottom:-5px;width:14px;height:14px;cursor:nesw-resize'
    };
    Object.keys(edgeStyle).forEach(dir => {
      const handle = el('div', 'summary-resize summary-resize-' + dir);
      handle.dataset.dir = dir;
      handle.title = '拖动调整总结窗口大小';
      handle.style.cssText = 'position:absolute!important;z-index:45!important;touch-action:none!important;' + edgeStyle[dir] + '!important';
      win.appendChild(handle);
      item.ui.summaryResizeHandles.push(handle);
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !item.rect) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const start = Object.assign({}, item.rect);
        item.summaryFree = true;
        item.summaryDock = 'free';
        item.ui.win.dataset.summaryDock = 'free';
        try { handle.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        const move = ev => {
          const v = viewport();
          let x = start.x, y = start.y, w = start.w, h = start.h;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (dir.includes('e')) w = start.w + dx;
          if (dir.includes('s')) h = start.h + dy;
          if (dir.includes('w')) { w = start.w - dx; x = start.x + dx; }
          if (dir.includes('n')) { h = start.h - dy; y = start.y + dy; }
          w = Math.max(320, Math.min(v.w - 8, w));
          h = Math.max(220, Math.min(v.h - 8, h));
          if (dir.includes('w')) x = Math.max(0, Math.min(v.w - w, x));
          if (dir.includes('n')) y = Math.max(0, Math.min(v.h - h, y));
          if (dir.includes('e') || dir.includes('s')) {
            x = Math.max(0, Math.min(x, v.w - w));
            y = Math.max(0, Math.min(y, v.h - h));
          }
          item.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
          renderGeometry(item, true);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          summaryLayoutMemory.width = Number(item.rect.w) || 0;
          summaryLayoutMemory.height = Number(item.rect.h) || 0;
          saveSummaryLayout();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    });
  }

  function applySummaryWindow(item, forceDock) {
    if (!item || !item.ui || !item.ui.win) return;
    ensureSummaryAppearanceCSS();
    const win = item.ui.win;
    if (item.summaryHidden) {
      win.style.display = 'none';
      installSummaryEdgeCollapse(item);
      return;
    }
    if (item.summaryCollapsed) return;
    win.classList.add('summary-window');
    if (forceDock || !item.summaryFree) {
      const v = viewport();
      const rememberedWidth = Number(summaryLayoutMemory.width) > 0 ? Number(summaryLayoutMemory.width) : 0;
      const rememberedHeight = Number(summaryLayoutMemory.height) > 0 ? Number(summaryLayoutMemory.height) : 0;
      const width = Math.min(v.w - 8, Math.max(320, rememberedWidth || Math.min(500, Math.max(340, Math.round(v.w * 0.34)))));
      const height = Math.min(v.h - 8, Math.max(220, rememberedHeight || v.h));
      const dock = settings.summaryDock === 'left' ? 'left' : 'right';
      item.rect = { x: dock === 'left' ? 0 : Math.max(0, v.w - width), y: rememberedHeight ? Math.max(0, Math.round((v.h - height) / 2)) : 0, w: width, h: height };
      item.summaryDock = dock;
      item.summaryFree = false;
      win.dataset.summaryDock = dock;
      renderGeometry(item, true);
    }
    const storedOpacity = item.summaryOpacity == null ? (settings.summaryOpacity == null ? 100 : settings.summaryOpacity) : item.summaryOpacity;
    const opacityValue = Number(storedOpacity) === 92 ? 100 : storedOpacity;
    const opacity = Math.max(0.4, Math.min(1, Number(opacityValue) / 100));
    win.style.opacity = String(opacity);
    win.style.background = 'var(--surface)';
    win.style.color = 'var(--text)';
    const fontSize = Math.max(12, Math.min(22, Number(item.summaryFontSize == null ? (settings.summaryFontSize == null ? 14 : settings.summaryFontSize) : item.summaryFontSize) || 14));
    win.style.setProperty('--summary-font-size', fontSize + 'px');
    win.dataset.summaryFontSize = String(fontSize);
    win.querySelectorAll('.video-summary-answer,.media-summary-answer,.text-ai-answer,.ai-answer').forEach(node => { node.style.fontSize = fontSize + 'px'; });
    // The summary is a page-side panel.  Use the extension palette instead of
    // the translucent glass fill, otherwise the page tint shows through and
    // the panel looks different from the rest of the light/dark UI.
    if (item.ui.panel) {
      const themeHost = typeof shell !== 'undefined' && shell && shell.host ? shell.host : null;
      const dark = themeHost ? themeHost.dataset.theme === 'dark' : false;
      const surface = dark ? '#20242c' : '#ffffff';
      const bg = dark ? '#171a20' : '#f7f8fa';
      const text = dark ? '#eef1f7' : '#1c2330';
      const muted = dark ? '#aab2c0' : '#6b7280';
      const border = dark ? '#3a404b' : '#d9dee8';
      win.style.setProperty('--surface', surface);
      win.style.setProperty('--bg', bg);
      win.style.setProperty('--text', text);
      win.style.setProperty('--muted', muted);
      win.style.setProperty('--border', border);
      win.style.setProperty('--hover', dark ? '#2b3039' : '#f0f3f8');
      win.style.background = surface;
      win.style.setProperty('background-color', surface, 'important');
      item.ui.panel.style.background = surface;
      item.ui.panel.style.setProperty('background-color', surface, 'important');
      item.ui.panel.style.color = text;
      item.ui.panel.style.setProperty('backdrop-filter', 'none');
      item.ui.panel.style.setProperty('-webkit-backdrop-filter', 'none');
      const panelHead = item.ui.panel.querySelector('.panel-head');
      if (panelHead) {
        panelHead.style.background = surface;
        panelHead.style.setProperty('background-color', surface, 'important');
        panelHead.style.borderBottomColor = border;
        panelHead.style.color = text;
      }
      const panelBody = item.ui.panel.querySelector('.panel-body');
      if (panelBody) {
        panelBody.style.background = bg;
        panelBody.style.setProperty('background-color', bg, 'important');
        panelBody.style.color = text;
      }
      const closeBtn = item.ui.panel.querySelector('.panel-close,[data-action="close"],[data-action="closePanel"]');
      if (closeBtn && !closeBtn.dataset.ldpSummaryCloseBound) {
        closeBtn.dataset.ldpSummaryCloseBound = '1';
        closeBtn.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          item.summaryCloseRequested = true;
          try { if (typeof closeWindow === 'function') closeWindow(item); } catch (e) { /* ignore */ }
        });
      }
      const header = win.querySelector('.header');
      if (header) {
        header.style.background = surface;
        header.style.setProperty('background-color', surface, 'important');
        header.style.color = text;
        header.style.borderBottomColor = border;
      }
      const contentNode = win.querySelector('.content');
      if (contentNode) contentNode.style.background = bg;
      if (themeHost) win.dataset.theme = dark ? 'dark' : 'light';
    }
    const content = win.querySelector('.content');
    if (content) content.style.background = 'var(--bg)';
    bindSummaryDrag(item);
    bindSummaryResize(item);
    installSummaryEdgeCollapse(item);
    syncSummaryBackdrop();
  }

  let summaryAppearanceStyle = null;
  function ensureSummaryAppearanceCSS() {
    if (summaryAppearanceStyle && summaryAppearanceStyle.isConnected) return;
    const style = document.createElement('style');
    style.id = 'ldp-summary-appearance-style';
    style.textContent = '.summary-window .video-summary-answer,.summary-window .media-summary-answer,.summary-window .text-ai-answer,.summary-window .ai-answer{font-size:var(--summary-font-size,14px)!important;line-height:1.72}.summary-window .video-summary-answer.streaming::after,.summary-window .media-summary-answer.streaming::after,.summary-window .text-ai-answer.streaming::after,.summary-window .ai-answer.streaming::after{content:"▋";display:inline-block;margin-left:3px;color:var(--accent);animation:ldp-stream-cursor .75s steps(1,end) infinite}.summary-window .video-summary-status.streaming::after,.summary-window .media-summary-status.streaming::after{content:"";display:inline-block;width:8px;height:8px;margin-left:6px;border:1.5px solid color-mix(in srgb,var(--accent) 25%,transparent);border-top-color:var(--accent);border-radius:50%;animation:ldp-status-spin .8s linear infinite;vertical-align:-1px}.ldp-stream-dots{display:inline-flex;gap:1px;margin-left:3px;color:var(--accent);vertical-align:bottom}.ldp-stream-dots[hidden]{display:none!important}.ldp-stream-dots i{font-style:normal;line-height:1;animation:ldp-dot-blink 1.2s infinite}.ldp-stream-dots i:nth-child(2){animation-delay:.2s}.ldp-stream-dots i:nth-child(3){animation-delay:.4s}.summary-window .video-summary-answer.streaming,.summary-window .media-summary-answer.streaming{min-height:24px}.summary-appearance{display:inline-flex;align-items:center;gap:5px;margin-left:auto;color:var(--muted);font-size:10px;white-space:nowrap}.summary-appearance-label{font-size:10px}.summary-appearance-btn{height:24px;padding:0 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:11px/1 sans-serif;cursor:pointer}.summary-appearance-btn:hover{border-color:var(--accent);color:var(--accent)}.summary-opacity-range{width:64px;accent-color:var(--accent);height:14px}.summary-appearance-value{min-width:60px;font-variant-numeric:tabular-nums;text-align:right}@keyframes ldp-stream-cursor{0%,49%{opacity:1}50%,100%{opacity:.15}}@keyframes ldp-dot-blink{0%,70%,100%{opacity:.18}35%{opacity:1}}@keyframes ldp-status-spin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(style);
    summaryAppearanceStyle = style;
  }

  function applySummaryTextStyle(item, node) {
    if (!item || !node) return;
    const fs = Math.max(12, Math.min(22, Number(item.summaryFontSize == null ? (settings.summaryFontSize || 14) : item.summaryFontSize) || 14));
    node.style.fontSize = fs + 'px';
  }

  function requestMediaDownload(item, candidate, kindOverride) {
    const url = String(candidate && candidate.url || '');
    if (!url) { toast(item, '没有可下载的媒体地址'); return; }
    const filename = cleanDownloadName(item, candidate, kindOverride);
    if (/^blob:/i.test(url)) {
      fetch(url).then(response => response.blob()).then(blob => {
        downloadBlob(blob, filename);
      }).catch(() => toast(item, 'Blob 媒体无法下载'));
      return;
    }
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { toast(item, '扩展后台不可用'); return; }
    EXT.runtime.sendMessage({
      namespace: 'LPS_EXT',
      type: 'ldp:downloadMedia',
      url,
      filename
    }, response => {
      try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
      if (!response || !response.ok) toast(item, '下载启动失败：' + String(response && (response.detail || response.reason) || '未知原因'));
    });
  }

  function downloadBlob(blob, filename) {
    if (!blob || !blob.size) { return false; }
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'media';
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    setTimeout(() => { try { anchor.remove(); } catch (e) { /* ignore */ } URL.revokeObjectURL(objectUrl); }, 30000);
    return true;
  }

  async function downloadMediaAudio(item) {
    const state = item && item.mediaState;
    if (!state) return;
    const audioCandidate = (state.list || []).find(candidate => candidate.kind === 'audio' && candidate.url)
      || (state.candidate && state.candidate.kind === 'audio' ? state.candidate : null);
    if (audioCandidate) { requestMediaDownload(item, audioCandidate, 'audio'); return; }
    const videoCandidate = (state.list || []).find(candidate => candidate.kind === 'video' && candidate.url) || state.candidate;
    if (!videoCandidate || videoCandidate.kind !== 'video') { toast(item, '当前没有可提取的音轨'); return; }
    toast(item, '正在提取音频，请稍候…');
    const audio = await extractAudioFromVideo(videoCandidate);
    if (audio && audio.fullBlob) {
      downloadBlob(audio.fullBlob, cleanDownloadName(item, videoCandidate, 'audio') .replace(/\.[^.]+$/, '.wav'));
      toast(item, '音频已开始下载');
    } else {
      toast(item, '音频提取失败：没有可下载的独立音轨');
    }
  }

  function downloadMediaVideo(item) {
    const state = item && item.mediaState;
    if (!state) return;
    const videoCandidate = (state.list || []).find(candidate => candidate.kind === 'video' && candidate.url)
      || (state.candidate && state.candidate.kind === 'video' ? state.candidate : null);
    if (!videoCandidate) { toast(item, '当前没有可下载的视频文件'); return; }
    requestMediaDownload(item, videoCandidate, 'video');
  }

  function cleanDownloadName(item, candidate, kindOverride) {
    const raw = String((item && item.title) || document.title || 'media').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 90);
    const kind = kindOverride || (candidate && candidate.kind === 'audio' ? 'audio' : 'video');
    const ext = kind === 'audio' ? 'm4a' : 'mp4';
    return raw + '.' + ext;
  }

  function addSummaryAppearance(item, actions) {
    if (!actions) return;
    ensureSummaryAppearanceCSS();
    const tools = document.createElement('span');
    tools.className = 'summary-appearance';
    const label = document.createElement('span');
    label.className = 'summary-appearance-label';
    label.textContent = '字号';
    const small = document.createElement('button');
    small.type = 'button';
    small.className = 'summary-appearance-btn';
    small.textContent = 'A−';
    small.title = '减小总结文字';
    const large = document.createElement('button');
    large.type = 'button';
    large.className = 'summary-appearance-btn';
    large.textContent = 'A+';
    large.title = '增大总结文字';
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '40';
    opacity.max = '100';
    opacity.step = '2';
    opacity.className = 'summary-opacity-range';
    opacity.title = '窗口透明度';
    const value = document.createElement('span');
    value.className = 'summary-appearance-value';
    const read = () => {
      const fs = Math.max(12, Math.min(22, Number(item.summaryFontSize || settings.summaryFontSize || 14) || 14));
      const raw = Number(item.summaryOpacity == null ? (settings.summaryOpacity == null ? 100 : settings.summaryOpacity) : item.summaryOpacity);
      const op = raw === 92 ? 100 : Math.max(40, Math.min(100, raw || 100));
      value.textContent = fs + 'px · ' + op + '%';
      opacity.value = String(op);
    };
    const apply = (font, alpha) => {
      if (font != null) item.summaryFontSize = Math.max(12, Math.min(22, font));
      if (alpha != null) item.summaryOpacity = (Number(alpha) === 92 ? 100 : Math.max(40, Math.min(100, alpha)));
      if (item.ui && item.ui.win) {
        const effective = Number(item.summaryOpacity == null ? 100 : item.summaryOpacity);
        item.ui.win.style.opacity = String((effective === 92 ? 100 : effective) / 100);
        item.ui.win.style.setProperty('--summary-font-size', String(item.summaryFontSize || settings.summaryFontSize || 14) + 'px');
        item.ui.win.querySelectorAll('.video-summary-answer,.media-summary-answer,.text-ai-answer,.ai-answer').forEach(node => { node.style.fontSize = String(item.summaryFontSize || settings.summaryFontSize || 14) + 'px'; });
      }
      try { updateSetting(item, 'summaryFontSize', item.summaryFontSize || settings.summaryFontSize || 14); } catch (e) { /* ignore */ }
      try { updateSetting(item, 'summaryOpacity', item.summaryOpacity == null ? 100 : item.summaryOpacity); } catch (e) { /* ignore */ }
      read();
    };
    small.addEventListener('click', () => apply(Number(item.summaryFontSize || settings.summaryFontSize || 14) - 1));
    large.addEventListener('click', () => apply(Number(item.summaryFontSize || settings.summaryFontSize || 14) + 1));
    opacity.addEventListener('input', () => apply(null, Number(opacity.value)));
    tools.appendChild(label);
    tools.appendChild(small);
    tools.appendChild(large);
    tools.appendChild(opacity);
    tools.appendChild(value);
    actions.appendChild(tools);
    read();
    apply(Number(item.summaryFontSize || settings.summaryFontSize || 14), Number(item.summaryOpacity == null ? (settings.summaryOpacity == null ? 100 : settings.summaryOpacity) : item.summaryOpacity));
  }

  function configureSummaryWindow(item) {
    applySummaryWindow(item, true);
  }

  window.addEventListener('resize', () => {
    for (const w of windows) {
      if (!w.closed && !w.summaryFree && w.ui && w.ui.win && w.ui.win.classList.contains('summary-window')) applySummaryWindow(w, false);
    }
  });
  setInterval(syncSummaryBackdrop, 700);

  function addSummarySteps(item, body, bucket, labels) {
    const box = el('div', 'summary-steps');
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin:7px 0;font-size:10px';
    const items = Array.isArray(labels) && labels.length ? labels : ['扫描字幕', '选择音频', '视频转音频', '语音转写', 'AI 总结'];
    const nodes = items.map((label, index) => {
      const node = el('span', 'summary-step', (index + 1) + '. ' + label);
      node.style.cssText = 'padding:2px 6px;border:1px solid var(--border);border-radius:999px;color:var(--muted);background:var(--bg)';
      box.appendChild(node);
      return node;
    });
    body.appendChild(box);
    item.ui[bucket + 'Steps'] = nodes;
    item.ui[bucket + 'StepLabels'] = items;
    return nodes;
  }

  function markSummaryStepLabel(item, bucket, label, state) {
    const labels = item && item.ui && item.ui[bucket + 'StepLabels'];
    if (!Array.isArray(labels)) return;
    const index = labels.indexOf(label);
    if (index >= 0) markSummaryStep(item, bucket, index, state);
  }

  function markSummaryStep(item, bucket, index, state) {
    const nodes = item && item.ui && item.ui[bucket + 'Steps'];
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node, i) => {
      const done = i < index || (i === index && state === 'done');
      const active = i === index && state !== 'done';
      const error = i === index && state === 'error';
      const color = error ? '#b33b4b' : (active || done ? 'var(--accent)' : 'var(--muted)');
      node.style.borderColor = active || done || error ? color : 'var(--border)';
      node.style.color = color;
      node.style.fontWeight = active ? '700' : '400';
      node.style.background = done ? 'color-mix(in srgb,var(--accent) 10%,var(--bg))' : 'var(--bg)';
    });
  }

  function renderMediaSummaryPanel(item) {
    item.panelMode = 'media';
    const body = panelFrame(item, '音视频内容总结', 'close');
    configureSummaryWindow(item);
    item.ui.panel.classList.add('media-panel');
    const state = item.mediaState || {};
    const sourceText = state.candidate
      ? (state.candidate.kind === 'audio' ? '音频链路' : '视频链路') + ' · ' + (state.candidate.srcKind || '直链') + (state.candidate.duration ? ' · ' + Math.round(state.candidate.duration) + ' 秒' : '')
      : '正在扫描页面媒体…';
    const noteHtml = state.textMode
      ? '当前页面没有可提取的音视频，已降级为网页正文总结。'
      : '优先提取音频；没有独立音轨时使用视频链路。媒体只发送到你配置的硅基流动接口。';
    const subtitleNote = state.subtitleError ? '\n字幕不可用：' + state.subtitleError : '';
    const source = el('p', 'note', noteHtml + subtitleNote + (state.candidate ? '\n来源：' + sourceText : ''));
    const status = el('div', 'media-summary-status', state.error ? '未能提取媒体' : (state.busy ? '正在处理…' : '准备中…'));
    const progress = el('div', 'media-progress');
    const progressBar = el('span', 'media-progress-bar');
    const progressPercent = el('span', 'media-progress-percent', '0%');
    progress.appendChild(progressBar);
    progress.appendChild(progressPercent);
    progress.style.position = 'relative';
    progressPercent.style.cssText = 'position:absolute;right:0;top:-17px;color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums';
    const out = el('div', 'media-summary-answer markdown');
    const meta = el('div', 'media-summary-meta', '');
    const actions = el('div', 'ai-actions');
    const copy = el('button', 'text-button', '复制总结');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = String((item.mediaState && item.mediaState.answer) || '').trim();
      if (!text) { toast(item, '还没有可复制的总结'); return; }
      try { navigator.clipboard.writeText(text); toast(item, '已复制总结'); } catch (e) { toast(item, '复制失败'); }
    });
    const videoDownload = el('button', 'text-button', '下载视频');
    videoDownload.type = 'button';
    videoDownload.hidden = true;
    videoDownload.addEventListener('click', () => downloadMediaVideo(item));
    const audioDownload = el('button', 'text-button', '下载音频');
    audioDownload.type = 'button';
    audioDownload.hidden = true;
    audioDownload.addEventListener('click', () => downloadMediaAudio(item));
    const retry = el('button', 'text-button', '重新总结');
    retry.type = 'button';
    retry.addEventListener('click', () => startMediaSummary(item));
    const cancel = el('button', 'text-button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      if (item.mediaState) item.mediaState.cancelled = true;
      if (status) status.textContent = '已取消';
      if (out) { out.classList.remove('streaming'); out.textContent = '已取消本次总结。'; out.dataset.tone = ''; }
      publishSidePanel(item, '已取消', '');
      toast(item, '已取消');
    });
    actions.appendChild(videoDownload);
    actions.appendChild(audioDownload);
    actions.appendChild(copy);
    actions.appendChild(retry);
    actions.appendChild(cancel);
    if (typeof addSummaryAppearance === 'function') addSummaryAppearance(item, actions);
    body.appendChild(source);
    body.appendChild(status);
    body.appendChild(progress);
    if (typeof addSummarySteps === 'function') {
      const stepLabels = state.candidate && state.candidate.kind === 'audio'
        ? ['扫描字幕', '选择音频', '语音转写', 'AI 总结']
        : ['扫描字幕', '选择视频', '视频转音频', '语音转写', 'AI 总结'];
      addSummarySteps(item, body, 'media', stepLabels);
    }
    body.appendChild(out);
    body.appendChild(meta);
    body.appendChild(actions);
    item.ui.mediaStatus = status;
    item.ui.mediaProgress = progressBar;
    item.ui.mediaPercent = progressPercent;
    item.ui.mediaOut = out;
    item.ui.mediaMeta = meta;
    item.ui.mediaDownload = videoDownload;
    item.ui.mediaAudioDownload = audioDownload;
    if (typeof applySummaryTextStyle === 'function') applySummaryTextStyle(item, out);
    publishSidePanel(item, state.error ? '未能提取媒体' : (state.busy ? '正在处理…' : '准备中…'), state.error ? 'bad' : '');
    if (state.answer) out.innerHTML = markdownToHtml(state.answer);
    else if (state.error) { out.textContent = state.error; out.dataset.tone = 'bad'; }
    else out.textContent = state.textMode ? '正在读取网页正文…' : '正在读取媒体…';
  }

  function openMediaSummaryPanel(options) {
    const opts = options || {};
    const candidates = scanMediaCandidates();
    const item = openWindow('', document.title || '音视频内容总结', null, undefined, { bare: true });
    if (!item) return null;
    item.summaryProtected = true;
    item.mediaState = {
      busy: false,
      cancelled: false,
      answer: '',
      error: '',
      textMode: !candidates.length,
      list: candidates,
      candidate: candidates[0] || null,
      prompt: ''
    };
    openPanel(item, 'media');
    hideSummaryWindow(item);
    showSummaryLoading(item, '正在扫描页面媒体…');
    ensureGenericMediaHook();
    const hasDirect = candidates.some(candidate => candidate.url && !/^blob:/i.test(candidate.url));
    setTimeout(() => startMediaSummary(item), hasDirect ? 60 : 320);
    return item;
  }

  function openMediaSummaryFromUrl(url, title, point) {
    const source = String(url || '');
    if (!/^https?:\/\//i.test(source)) return null;
    const item = openWindow('', title || '媒体内容总结', null, point, { bare: true });
    if (!item) return null;
    item.summaryProtected = true;
    const srcKind = mediaUrlKind(source, 'video');
    item.mediaState = {
      busy: false,
      cancelled: false,
      answer: '',
      error: '',
      textMode: false,
      list: [{ url: source, kind: srcKind === 'audio' ? 'audio' : 'video', srcKind, duration: 0, title: title || '' }],
      candidate: null,
      prompt: ''
    };
    item.mediaState.candidate = item.mediaState.list[0];
    openPanel(item, 'media');
    hideSummaryWindow(item);
    showSummaryLoading(item, '正在准备媒体总结…');
    startMediaSummary(item);
    return item;
  }

  function openPageOrMediaSummary() {
    const candidates = scanMediaCandidates();
    const candidateVideo = candidates.find(candidate => candidate.element && String(candidate.element.tagName || '').toUpperCase() === 'VIDEO');
    const domVideo = Array.from(document.querySelectorAll('video')).find(video => {
      const rect = video.getBoundingClientRect();
      return rect && rect.width >= 160 && rect.height >= 40 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const videoElement = candidateVideo ? candidateVideo.element : domVideo;
    if (videoElement) {
      // Always probe subtitles first.  If none are available, the video panel
      // switches to the audio/video media path automatically.
      return openQuickVideoSummary(videoElement);
    }
    return openMediaSummaryPanel({});
  }

  async function startTextSummary(item) {
    const state = item.mediaState;
    if (!state || state.busy) return;
    state.busy = true;
    state.error = '';
    state.answer = '';
    state.startedAt = Date.now();
    const out = item.ui.mediaOut;
    const status = item.ui.mediaStatus;
    const meta = item.ui.mediaMeta;
    if (out) { out.textContent = '正在读取网页正文…'; out.classList.add('streaming'); }
    if (status) status.textContent = '正在读取网页正文…';
    updateSummaryLoading(item, 22, '正在读取网页正文…');
    fetchPageText(location.href, (text, sourceStatus) => {
      if (!item || item.closed || state.cancelled) return;
      if (!text) {
        state.busy = false;
        state.error = '无法读取当前网页正文。';
        if (out) { out.classList.remove('streaming'); out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '读取正文失败';
        publishSidePanel(item, '读取正文失败', 'bad');
        revealSummaryWindow(item);
        return;
      }
      if (status) status.textContent = '正在生成网页总结…';
      if (meta) meta.textContent = '正文 ' + text.length + ' 字';
      updateSummaryLoading(item, 55, '正在生成网页总结…');
      if (!EXT || !EXT.runtime) {
        state.busy = false;
        if (out) out.textContent = '当前环境不支持 AI 请求。';
        revealSummaryWindow(item);
        return;
      }
      try {
        EXT.runtime.sendMessage({
          namespace: 'LPS_EXT',
          type: 'ldp:ai',
          request: {
            action: 'summary',
            text: text.slice(0, 20000),
            title: document.title || '',
            url: location.href,
            provider: aiConfig.provider,
            endpoint: aiProviderConfig(aiConfig.provider).endpoint,
            model: (aiConfig.selectedModels && aiConfig.selectedModels[aiConfig.provider]) || aiConfig.model,
            summaryPrompt: aiConfig.summaryPrompt || ''
          }
        }, response => {
          if (!item || item.closed || state.cancelled) return;
          state.busy = false;
          if (!response || !response.ok) {
            state.error = '网页总结失败：' + ((response && (response.detail || response.reason)) || '接口错误');
            if (out) { out.classList.remove('streaming'); out.textContent = state.error; out.dataset.tone = 'bad'; }
            if (status) status.textContent = '总结失败';
            publishSidePanel(item, '总结失败', 'bad');
            revealSummaryWindow(item);
            return;
          }
          state.answer = String(response.text || '');
          if (out) { out.classList.remove('streaming'); out.classList.add('markdown'); out.innerHTML = markdownToHtml(state.answer); out.dataset.tone = 'good'; }
          const elapsed = state.startedAt ? Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) : '';
          if (meta) meta.textContent = (response.model ? '模型 · ' + response.model : '') + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : '');
          if (status) status.textContent = '已加载完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : '');
          publishSidePanel(item, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''), 'good');
          updateSummaryLoading(item, 100, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''));
          setTimeout(() => revealSummaryWindow(item), 220);
        });
      } catch (e) {
        state.busy = false;
        const message = String(e && e.message || '');
        const detail = /context invalidated|extension context/i.test(message)
          ? '扩展已重新加载，当前页面仍是旧脚本。请刷新当前网页后重试。'
          : '扩展后台连接失败。';
        if (out) { out.classList.remove('streaming'); out.textContent = detail; out.dataset.tone = 'bad'; }
        revealSummaryWindow(item);
      }
    });
  }

  function showStreamDots(item, out) {
    if (!item || !out) return;
    let dots = item.ui && item.ui.streamDots;
    if (!dots) {
      dots = el('span', 'ldp-stream-dots');
      dots.innerHTML = '<i>.</i><i>.</i><i>.</i>';
      if (item.ui) item.ui.streamDots = dots;
    }
    if (dots.parentNode !== out) out.appendChild(dots);
    dots.hidden = false;
  }

  function hideStreamDots(item) {
    const dots = item && item.ui && item.ui.streamDots;
    if (dots) dots.hidden = true;
  }

  function streamMediaTextSummary(item, transcript, asrResult) {
    const state = item.mediaState;
    const out = item.ui.mediaOut;
    const status = item.ui.mediaStatus;
    const meta = item.ui.mediaMeta;
    if (!state || !out) return;
    const text = String(transcript || '').trim();
    if (!text) {
      state.busy = false;
      state.error = 'ASR 返回空文本，无法生成总结。';
      if (out) { out.textContent = state.error; out.dataset.tone = 'bad'; }
      if (status) status.textContent = '转写为空';
      revealSummaryWindow(item);
      return;
    }
    const finishWithFallback = detail => {
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) {
        state.busy = false;
        if (out) { out.textContent = '当前环境不支持文本模型请求。'; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '总结失败';
        revealSummaryWindow(item);
        return;
      }
      try {
        EXT.runtime.sendMessage({
          namespace: 'LPS_EXT', type: 'ldp:ai',
          request: {
            action: 'video', text: text.slice(0, 24000), title: document.title || '', url: location.href,
            provider: aiConfig.provider,
            endpoint: aiProviderConfig(aiConfig.provider).endpoint,
            model: (aiConfig.selectedModels && aiConfig.selectedModels[aiConfig.provider]) || aiConfig.model,
            summaryPrompt: '以下文本是完整视频的 ASR 转写，不是空内容。请直接总结，不要要求用户补充文本。'
          }
        }, response => {
          if (!response || !response.ok) {
            state.busy = false;
            state.error = '文本总结失败：' + ((response && (response.detail || response.reason)) || detail || '接口错误');
            if (out) { out.textContent = state.error; hideStreamDots(item); out.dataset.tone = 'bad'; }
            if (status) { status.textContent = '总结失败'; status.classList.remove('streaming'); }
            if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'error');
            revealSummaryWindow(item);
            return;
          }
          state.answer = String(response.text || '');
          state.busy = false;
          if (out) { out.classList.remove('streaming'); out.classList.add('markdown'); out.innerHTML = markdownToHtml(state.answer); hideStreamDots(item); out.dataset.tone = 'good'; }
          if (status) { status.textContent = '已加载完成'; status.classList.remove('streaming'); }
          if (meta) meta.textContent = '已加载完成 · 总结来源：音频（ASR） · 文本模型 ' + (response.model || '');
          if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'done');
          revealSummaryWindow(item);
        });
      } catch (e) {
        state.busy = false;
        if (out) { out.textContent = '文本总结请求失败：' + (e.message || '后台不可用'); out.dataset.tone = 'bad'; }
        if (status) status.textContent = '总结失败';
        revealSummaryWindow(item);
      }
    };
    if (!EXT || !EXT.runtime || !EXT.runtime.connect) { finishWithFallback('没有流式连接'); return; }
    let port = null;
    try { port = EXT.runtime.connect({ name: 'ldp-ai-stream' }); } catch (e) { finishWithFallback('连接失败'); return; }
    item.aiPort = port;
    let streamDone = false;
    const streamWatchdog = setTimeout(() => {
      if (streamDone) return;
      streamDone = true;
      try { port.disconnect(); } catch (e) { /* ignore */ }
      finishWithFallback('流式总结 90 秒没有返回');
    }, 90000);
    const endStream = () => { streamDone = true; clearTimeout(streamWatchdog); };
    const started = Date.now();
    let answer = '';
    const request = {
      action: 'video',
      text: text.slice(0, 24000),
      title: document.title || '',
      url: location.href,
      provider: aiConfig.provider,
      endpoint: aiProviderConfig(aiConfig.provider).endpoint,
      model: (aiConfig.selectedModels && aiConfig.selectedModels[aiConfig.provider]) || aiConfig.model,
      summaryPrompt: '以下文本是完整视频的 ASR 转写，不是空内容。请直接总结，不要要求用户补充文本。'
    };
    if (typeof revealSummaryWindowKeepLoading === 'function') revealSummaryWindowKeepLoading(item);
    if (status) { status.textContent = 'ASR 完成，正在流式生成总结…'; status.classList.add('streaming'); }
    if (out) { out.textContent = ''; out.classList.add('streaming'); showStreamDots(item, out); }
    if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'active');
    port.onMessage.addListener(msg => {
      if (!msg) return;      if (msg.type === 'delta') {
        answer += String(msg.text || '');
        if (out) { out.classList.add('markdown'); out.innerHTML = markdownToHtml(answer); showStreamDots(item, out); }
        if (status) status.textContent = '正在生成总结 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
        if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, Math.min(96, 82 + Math.min(14, answer.length / 100)), '正在生成总结…');
        return;
      }
      if (msg.type === 'done') {
        endStream();
        state.answer = answer;
        state.busy = false;
        if (out) { out.classList.remove('streaming'); out.classList.add('markdown'); out.innerHTML = markdownToHtml(answer); hideStreamDots(item); out.dataset.tone = 'good'; }
        if (status) { status.textContent = '已加载完成'; status.classList.remove('streaming'); }
        if (item.ui && item.ui.mediaProgress) item.ui.mediaProgress.style.width = '100%';
        if (item.ui && item.ui.mediaPercent) item.ui.mediaPercent.textContent = '100%';
        if (meta) meta.textContent = '已加载完成 · 总结来源：音频（ASR） · 文本模型 ' + (msg.model || '') + ' · 总耗时 ' + Math.max(0.1, (Date.now() - (state.startedAt || started)) / 1000).toFixed(1) + ' 秒';
        if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'done');
        if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, '总结完成');
        setTimeout(() => revealSummaryWindow(item), 120);
        try { port.disconnect(); } catch (e) { /* ignore */ }
        item.aiPort = null;
        return;
      }
      if (msg.type === 'error') {
        endStream();
        try { port.disconnect(); } catch (e) { /* ignore */ }
        item.aiPort = null;
        finishWithFallback(String(msg.detail || msg.reason || '流式请求失败'));
      }
    });
    try { port.postMessage({ type: 'start', request }); } catch (e) { endStream(); finishWithFallback('请求发送失败'); }
  }

  async function startMediaSummary(item) {
    if (!item || item.closed || !item.mediaState) return;
    if (item.aiPort) { try { item.aiPort.disconnect(); } catch (e) { /* ignore */ } item.aiPort = null; }
    const state = item.mediaState;
    if (state.busy) return;
    state.busy = true;
    state.cancelled = false;
    state.error = '';
    state.answer = '';
    state.startedAt = Date.now();
    state.summaryResourcesCleared = false;
    if (typeof markSummaryStep === 'function') markSummaryStep(item, 'media', 0, 'active');
    if (!state.list || !state.list.length) state.list = scanMediaCandidates();
    if (/douyin\.com|iesdouyin\.com/i.test(location.hostname) && !state.list.some(candidate => candidate.url && !/^blob:/i.test(candidate.url))) {
      updateSummaryLoading(item, 14, '正在解析抖音音频地址…');
      const douyinAudio = resolveDouyinAudioUrl();
      if (douyinAudio) {
        state.list.unshift({ element: null, kind: 'audio', url: douyinAudio, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
        state.textMode = false;
      } else {
        const resolved = await requestDouyinResolve(location.href);
        if (resolved && resolved.url) {
          state.list.unshift({ element: null, kind: /audio|music|\.mp3|\.m4a|\.aac|\.wav|\.ogg/i.test(resolved.url) ? 'audio' : 'video', url: resolved.url, srcKind: 'direct', duration: 0, title: resolved.title || document.title || '', visible: true });
          state.textMode = false;
        }
      }
    }
    if (/bilibili\.com/i.test(location.hostname) && typeof bilibiliAudioUrl === 'function') {
      updateSummaryLoading(item, 14, '正在解析 B 站音频地址…');
      const biliAudio = await bilibiliAudioUrl();
      if (biliAudio) {
        state.list.unshift({ element: null, kind: 'audio', url: biliAudio, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
        state.textMode = false;
      }
    }
    if (/youtube\.com|youtu\.be/i.test(location.hostname) && typeof youtubeAudioUrl === 'function') {
      let ytAudio = youtubeAudioUrl();
      if (!ytAudio && typeof youtubeAudioFromPage === 'function') {
        updateSummaryLoading(item, 14, '正在解析 YouTube 音频地址…');
        ytAudio = await youtubeAudioFromPage();
      }
      if (ytAudio) {
        state.list.unshift({ element: null, kind: 'audio', url: ytAudio, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
        state.textMode = false;
      }
    }
    updateSummaryLoading(item, 8, '正在扫描页面媒体…');
    publishSidePanel(item, '正在处理媒体…', '');
    const out = item.ui.mediaOut;
    const status = item.ui.mediaStatus;
    const progress = item.ui.mediaProgress;
    const meta = item.ui.mediaMeta;
    if (progress) progress.style.width = '12%';
    if (state.textMode) {
      state.busy = false;
      startTextSummary(item);
      return;
    }
    const candidate = (state.list && (state.list.find(item => item.url && !/^blob:/i.test(item.url)) || state.list[0])) || null;
    if (!candidate) {
      state.busy = false;
      state.error = (state.subtitleError ? '字幕不可用：' + state.subtitleError + '；' : '') + '没有检测到可提取的 <video>、<audio> 或媒体流。若是 Canvas / DRM / 跨域媒体，浏览器无法读取。';
      if (out) { out.textContent = state.error; out.dataset.tone = 'bad'; }
      if (status) status.textContent = '没有可提取媒体';
      revealSummaryWindow(item);
      return;
    }
    state.candidate = candidate;
    if (typeof markSummaryStep === 'function') markSummaryStep(item, 'media', candidate.kind === 'audio' ? 1 : 2, 'active');
    if (typeof setSummaryEstimate === 'function') setSummaryEstimate(item, candidate.duration ? Math.max(20, Math.min(300, candidate.duration / 8 + 20)) : 60);
    if (item.ui && item.ui.mediaDownload) item.ui.mediaDownload.hidden = true;
    if (item.ui && item.ui.mediaAudioDownload) item.ui.mediaAudioDownload.hidden = true;
    if (/douyin\.com/i.test(location.hostname) && (!candidate.url || candidate.srcKind === 'blob')) {
      updateSummaryLoading(item, 16, '正在读取抖音详情并优先解析音频…');
      const detail = await requestDouyinDetail();
      if (detail && detail.audio && detail.audio.length) {
        candidate.url = detail.audio[0];
        candidate.srcKind = 'direct';
        candidate.kind = 'audio';
      } else if (detail && detail.video && detail.video.length) {
        candidate.url = detail.video[0];
        candidate.srcKind = 'direct';
        candidate.kind = 'video';
      } else {
        const douyinAudio = resolveDouyinAudioUrl();
        const douyinUrl = douyinAudio || resolveDouyinMediaUrl();
        if (douyinUrl) {
          candidate.url = douyinUrl;
          candidate.srcKind = 'direct';
          candidate.kind = douyinAudio ? 'audio' : 'video';
        }
      }
    }
    if (item.ui && item.ui.mediaDownload) {
      item.ui.mediaDownload.hidden = !((state.list || []).some(value => value.kind === 'video' && value.url) || candidate.kind === 'video');
    }
    if (item.ui && item.ui.mediaAudioDownload) {
      item.ui.mediaAudioDownload.hidden = !((state.list || []).some(value => value.kind === 'audio' && value.url) || candidate.kind === 'audio' || candidate.kind === 'video');
    }
    updateSummaryLoading(item, 18, candidate.kind === 'audio' ? '已找到音频，正在准备…' : '已找到视频，正在准备本地音频…');
    if (status) status.textContent = candidate.kind === 'audio' ? '正在准备音频链路…' : '正在准备视频链路…';
    if (meta) meta.textContent = candidate.duration ? '时长 ' + Math.round(candidate.duration) + ' 秒' : '';
    try {
      let payload = { kind: candidate.kind === 'audio' ? 'audio' : 'video', prompt: candidate.kind === 'audio' ? (aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT) : (aiConfig.mediaVideoPrompt || MEDIA_VIDEO_PROMPT) };
      if (candidate.kind === 'audio' && candidate.srcKind !== 'blob' && candidate.srcKind !== 'stream') {
        if (status) status.textContent = '正在离线解码并分段转写音频…';
        updateSummaryLoading(item, 32, '正在离线解码并分段转写音频…');
        if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', '语音转写', 'active');
        const remote = await requestRemoteTranscript(candidate);
        if (remote && remote.ok && remote.text) {
          payload = { kind: 'audio', transcript: remote.text, returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          if (meta) meta.textContent = '音频已分段转写 · ' + remote.chunks + ' 段 · ' + Math.round(remote.duration || 0) + ' 秒';
          updateSummaryLoading(item, 68, '音频转写完成，正在生成总结…');
        } else {
          // Never put a multi-megabyte data URL into chrome.runtime.sendMessage.
          // Direct media URLs are fetched by the background worker itself.
          payload = { kind: 'audio', url: candidate.url, returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          if (meta) meta.textContent = '音频地址已获取，交给后台下载并转写…';
          updateSummaryLoading(item, 55, '音频地址已获取，正在后台下载并转写…');
        }
      }
      if (candidate.kind === 'video') {
        if (status) status.textContent = candidate.srcKind === 'blob' ? '正在读取本地视频…' : (candidate.srcKind === 'hls' ? '正在下载 HLS 视频…' : '正在下载视频…');
        if (progress) progress.style.width = '28%';
        const audio = await extractAudioFromVideo(candidate);
        if (audio && !state.cancelled) {
          payload = { kind: 'audio', dataUrl: audio.dataUrl, audioChunks: audio.chunks || [audio.dataUrl], returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          state.candidate.kind = 'audio';
          updateSummaryLoading(item, 58, '音频提取完成，正在上传到硅基流动…');
          if (meta && audio.duration) meta.textContent = '本地音轨已转为 WAV · ' + Math.round(audio.duration) + ' 秒';
          if (status) status.textContent = '音频提取完成，正在上传到硅基流动…';
        } else if (status) {
          updateSummaryLoading(item, 45, '没有可下载的独立音轨；不进行播放器录制');
          status.textContent = '没有可下载的独立音轨，已停止（不从播放器录制）';
        }
      }
      if (candidate.kind === 'video' && payload.kind !== 'audio') {
        // Never send a raw video to the text/ASR worker.  If audio extraction
        // failed, report the real local failure instead of the misleading
        // "视频必须先转为音频" backend error.
        state.busy = false;
        state.error = '没有拿到可用音轨：视频是 blob/MediaSource，无法直接下载；已尝试从页面数据解析独立音频但未找到。';
        if (out) { out.classList.remove('streaming'); out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '没有可用音轨';
        if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
        return;
      }
      if (candidate.srcKind === 'dash' && payload.kind !== 'audio') {
        state.busy = false;
        state.error = mediaErrorText({ reason: 'dash', detail: 'DASH（.mpd）需要先合并分片' });
        if (out) { out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '格式暂不支持';
        revealSummaryWindow(item);
        return;
      }
      if (candidate.srcKind === 'stream' && payload.kind !== 'audio') {
        state.busy = false;
        state.error = /youtube\.com|youtu\.be/i.test(location.hostname)
          ? 'YouTube 没有返回可下载的音频/视频流（页面只给出 MediaStream/Canvas）。请确认视频已登录并可正常播放，或稍后重试。'
          : '这个媒体来自 MediaStream/Canvas，浏览器不能直接导出为文件。';
        if (out) { out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '媒体不可导出';
        revealSummaryWindow(item);
        return;
      }
      if (!payload.dataUrl) {
        if (candidate.srcKind === 'blob') {
          if (status) status.textContent = '正在读取 Blob 媒体…';
          const blob = await readBlobMedia(candidate);
          payload.dataUrl = blob.dataUrl;
          if (progress) progress.style.width = '45%';
        } else {
          payload.url = candidate.url;
          if (status) status.textContent = candidate.srcKind === 'hls' ? '正在下载 HLS 分片…' : '正在下载媒体…';
        }
      }
      if (state.cancelled || item.closed) return;
      if (progress) progress.style.width = '62%';
      if (status) status.textContent = '正在上传到硅基流动并生成总结…';
      updateSummaryLoading(item, 76, '正在上传到硅基流动并生成总结…');
      if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'active');
      const progressTicker = setInterval(() => {
        if (!item || item.closed || state.cancelled) return;
        const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
        updateSummaryLoading(item, Math.min(94, 76 + Math.min(18, elapsed / 8)), '正在转写/生成总结…');
      }, 1200);
      let result;
      try {
        result = await requestMediaAI(payload);
      } finally {
        clearInterval(progressTicker);
      }
      if (!item || item.closed || state.cancelled) return;
      if (!result || !result.ok) {
        const reason = String(result && result.reason || '');
        if (/^(asr|empty-asr)$/.test(reason) && state.list && state.list.length > 1 && Number(state.mediaRetry || 0) < 2) {
          state.mediaRetry = Number(state.mediaRetry || 0) + 1;
          const failed = state.candidate;
          state.list = state.list.filter(candidate => candidate !== failed);
          state.candidate = null;
          state.busy = false;
          if (status) status.textContent = '当前音轨转写为空，正在尝试其他媒体源…';
          updateSummaryLoading(item, 70, '当前音轨转写为空，正在尝试其他媒体源…');
          setTimeout(() => startMediaSummary(item), 120);
          return;
        }
        state.busy = false;
        state.error = mediaErrorText(result);
        if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'error');
        if (out) { out.classList.remove('streaming'); out.textContent = state.error; out.dataset.tone = 'bad'; }
        if (status) status.textContent = '总结失败';
        if (progress) progress.style.width = '0';
        publishSidePanel(item, '总结失败', 'bad');
        revealSummaryWindow(item);
        return;
      }
      if (result.transcript) {
        state.transcript = String(result.transcript || '');
        if (status) status.textContent = 'ASR 转写完成，正在生成总结…';
        if (meta) meta.textContent = 'ASR 已得到 ' + state.transcript.length + ' 字，正在交给文本模型…';
        if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', '语音转写', 'done');
        streamMediaTextSummary(item, state.transcript, result);
        return;
      }
      state.answer = String(result.text || '');
      if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'done');
      if (out) { out.classList.remove('streaming'); out.classList.add('markdown'); out.innerHTML = markdownToHtml(state.answer); out.dataset.tone = 'good'; }
      const elapsed = state.startedAt ? Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) : '';
      if (status) status.textContent = '已加载完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : '');
      if (progress) progress.style.width = '100%';
      if (meta) meta.textContent = '总结来源：' + (result.kind === 'audio' ? '音频（ASR）' : '视频') + ' · 模型 ' + (result.model || 'Qwen3-Omni') + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : '') + (result.size ? ' · ' + Math.round(result.size / 1024 / 1024) + 'MB' : '');
      publishSidePanel(item, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''), 'good');
      updateSummaryLoading(item, 100, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''));
      setTimeout(() => revealSummaryWindow(item), 220);
    } catch (e) {
      state.busy = false;
      state.error = e && e.message ? String(e.message) : '媒体处理失败';
      if (out) { out.classList.remove('streaming'); out.textContent = state.error; out.dataset.tone = 'bad'; }
      if (status) status.textContent = '处理失败';
      if (progress) progress.style.width = '0';
      publishSidePanel(item, '处理失败', 'bad');
      revealSummaryWindow(item);
    }
  }
