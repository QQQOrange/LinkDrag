'use strict';

const NAMESPACE = 'LPS_EXT';
const SETTINGS_KEY = 'FOX_QQQORANGE_PREVIEW_140_SETTINGS';
const AI_CONFIG_KEY = 'FOX_QQQORANGE_PREVIEW_140_AI';
const UPDATE_CONFIG_KEY = 'LINKDRAG_UPDATE_CONFIG';
const AI_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { id: 'siliconflow', label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'qwen', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { id: 'kimi', label: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { id: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2' },
  { id: 'custom', label: '自定义接口', endpoint: '', model: '' }
];
const AI_DEFAULTS = { provider: 'deepseek', endpoint: AI_PROVIDERS[0].endpoint, model: AI_PROVIDERS[0].model, apiKey: '', apiKeys: {}, models: {}, providerConfigs: {}, selectedModels: {}, mediaApiKey: '', mediaModel: 'FunAudioLLM/SenseVoiceSmall', mediaEndpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions', summaryPrompt: '请总结下面网页正文的核心观点、关键事实和结论，控制在简洁的要点中。' };
const $ = id => document.getElementById(id);
const I18N = window.LinkDragI18N;
const tr = (zh, en) => (I18N && I18N.isEnglish ? I18N.isEnglish() ? en : zh : zh);

function storageGet(keys) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(keys, value => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve(value && typeof value === 'object' ? value : {});
      });
    } catch (e) { resolve({}); }
  });
}

function storageSet(value) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set(value, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

function sendBackground(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(Object.assign({ namespace: NAMESPACE }, message), response => {
        const err = chrome.runtime.lastError;
        resolve(err ? null : response);
      });
    } catch (e) { resolve(null); }
  });
}

function sendTab(tabId, message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, Object.assign({ namespace: NAMESPACE }, message), { frameId: 0 }, response => {
        const err = chrome.runtime.lastError;
        resolve(err ? null : response);
      });
    } catch (e) { resolve(null); }
  });
}

function setState(id, text, tone) {
  const node = $(id);
  node.textContent = text || '';
  node.className = 'save-state' + (tone ? ' ' + tone : '');
}

async function parseAtomRelease() {
  const response = await fetch('https://github.com/QQQOrange/LinkDrag/releases.atom', {
    cache: 'no-store',
    headers: { 'Accept': 'application/atom+xml,application/xml,text/xml' }
  });
  if (!response.ok) throw new Error('GitHub Atom HTTP ' + response.status);
  const xml = await response.text();
  const entry = xml.match(/<entry>[\s\S]*?<\/entry>/i);
  if (!entry) throw new Error('GitHub Atom 没有发布记录');
  const body = entry[0];
  const link = body.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i);
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const updated = body.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
  const url = link ? link[1].replace(/&amp;/g, '&') : '';
  const tag = (url.match(/\/tag\/([^/?#]+)/) || [])[1] || '';
  if (!tag) throw new Error('GitHub Atom 没有版本号');
  return {
    tag: decodeURIComponent(tag),
    name: title ? title[1].replace(/<[^>]+>/g, '').trim() : '',
    url: url || 'https://github.com/QQQOrange/LinkDrag/releases',
    publishedAt: updated ? updated[1].trim() : ''
  };
}

function isNewerVersion(latest, current) {
  const parts = value => String(value).replace(/^v/i, '').split('.').map(x => Number((String(x).match(/^\d+/) || [0])[0]) || 0);
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function directUpdateCheck() {
  const token = $('updateToken').dataset.clear === '1' ? '' : $('updateToken').value.trim();
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  let response = await fetch('https://api.github.com/repos/QQQOrange/LinkDrag/releases/latest', {
    cache: 'no-store',
    headers
  });
  if (!response.ok && token) {
    const publicHeaders = Object.assign({}, headers);
    delete publicHeaders.Authorization;
    response = await fetch('https://api.github.com/repos/QQQOrange/LinkDrag/releases/latest', {
      cache: 'no-store',
      headers: publicHeaders
    });
  }
  let release = null;
  if (response.ok) {
    const data = await response.json();
    release = {
      tag: String(data.tag_name || ''),
      name: String(data.name || data.tag_name || ''),
      url: String(data.html_url || ''),
      publishedAt: String(data.published_at || '')
    };
  } else {
    release = await parseAtomRelease();
  }
  const latest = String(release.tag || '').replace(/^v/i, '').trim();
  if (!latest) throw new Error('GitHub 没有返回版本号');
    const newer = isNewerVersion(latest, chrome.runtime.getManifest().version);
  return {
    latestVersion: latest,
    latestName: release.name || release.tag,
    releaseUrl: release.url || 'https://github.com/QQQOrange/LinkDrag/releases',
    publishedAt: release.publishedAt,
    updateAvailable: newer
  };
}

function renderUpdateStatus(config, fallback) {
  const node = $('updateStatus');
  const open = $('openUpdate');
  if (!node) return;
  const c = config || {};
  const current = chrome.runtime.getManifest().version;
  const latest = String(c.latestVersion || '');
  const hasNewer = !!latest && isNewerVersion(latest, current);
  if (hasNewer) {
    node.className = 'update-status good';
    node.textContent = tr(`发现新版本 v${latest}（当前 v${current}）`, `New version v${latest} (current v${current})`);
    if (open) {
      open.hidden = false;
      open.dataset.url = c.releaseUrl || 'https://github.com/QQQOrange/LinkDrag/releases';
    }
  } else if (c.lastError) {
    node.className = 'update-status warn';
    node.textContent = c.lastError;
    if (open) open.hidden = true;
  } else if (latest) {
    node.className = 'update-status';
    node.textContent = tr(`已是最新版本 v${current}`, `Up to date: v${current}`);
    if (open) open.hidden = true;
  } else {
    node.className = 'update-status';
    node.textContent = fallback || '尚未检查';
    if (open) open.hidden = true;
  }
}

async function saveUpdateConfig() {
  const current = await storageGet(UPDATE_CONFIG_KEY);
  const prev = current[UPDATE_CONFIG_KEY] && typeof current[UPDATE_CONFIG_KEY] === 'object' ? current[UPDATE_CONFIG_KEY] : {};
  const tokenInput = $('updateToken');
  const token = tokenInput.dataset.clear === '1' ? '' : tokenInput.value.trim();
  await storageSet({
    [UPDATE_CONFIG_KEY]: Object.assign({}, prev, {
      enabled: $('updateEnabled').checked,
      token
    })
  });
  tokenInput.dataset.clear = '';
  setState('updateState', tr('更新设置已保存。', 'Update settings saved.'), 'good');
}

async function checkUpdateNow() {
  await saveUpdateConfig();
  const state = $('updateState');
  state.className = 'save-state';
  state.textContent = tr('正在检查 GitHub 最新版本…', 'Checking GitHub for the latest release…');
  let result = await sendBackground({ type: 'ldp:checkUpdate', force: true });
  if (!result) {
    // A service worker can be asleep or restarting right after installation.
    // Retry once before reporting a misleading network/token failure.
    await new Promise(resolve => setTimeout(resolve, 450));
    result = await sendBackground({ type: 'ldp:checkUpdate', force: true });
  }
  if (!result || !result.ok) {
    // The options page is a normal extension document with host permissions;
    // checking directly here also survives a broken/sleeping service worker.
    try {
      const direct = await directUpdateCheck();
      const all = await storageGet(UPDATE_CONFIG_KEY);
      const current = all[UPDATE_CONFIG_KEY] && typeof all[UPDATE_CONFIG_KEY] === 'object' ? all[UPDATE_CONFIG_KEY] : {};
      const saved = Object.assign({}, current, direct, {
        enabled: $('updateEnabled').checked,
        token: $('updateToken').dataset.clear === '1' ? '' : $('updateToken').value.trim(),
        lastCheck: Date.now(),
        lastError: ''
      });
      await storageSet({ [UPDATE_CONFIG_KEY]: saved });
      $('updateToken').dataset.clear = '';
      renderUpdateStatus(saved);
      const savedNewer = isNewerVersion(saved.latestVersion, chrome.runtime.getManifest().version);
      setState('updateState', savedNewer
        ? tr('发现新版本；点击「打开 GitHub 发布页」自行下载。', 'A new version is available. Open the GitHub release page to download it.')
        : tr('当前已是最新版本。', 'You are up to date.'), 'good');
      return;
    } catch (e) {
      renderUpdateStatus({ lastError: (e && e.message) || tr('检查失败，请检查网络或令牌。', 'Check failed. Verify your network or token.') });
      setState('updateState', '', 'bad');
      return;
    }
  }
  const all = await storageGet(UPDATE_CONFIG_KEY);
  const config = all[UPDATE_CONFIG_KEY] || result;
  renderUpdateStatus(config);
  if (config.lastError) {
    setState('updateState', config.lastError, 'bad');
    return;
  }
  const configNewer = isNewerVersion(config.latestVersion, chrome.runtime.getManifest().version);
  setState('updateState', configNewer
    ? tr('发现新版本；点击「打开 GitHub 发布页」自行下载。', 'A new version is available. Open the GitHub release page to download it.')
    : tr('当前已是最新版本。', 'You are up to date.'), 'good');
}

function isSupported(url) {
  return /^https?:/i.test(String(url || '')) || /^file:/i.test(String(url || ''));
}

async function findTargetTab() {
  const tabs = await new Promise(resolve => {
    try { chrome.tabs.query({ currentWindow: true }, value => resolve(Array.isArray(value) ? value : [])); }
    catch (e) { resolve([]); }
  });
  const usable = tabs.filter(tab => Number.isInteger(tab.id) && isSupported(tab.url));
  usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return usable[0] || null;
}

async function ensureContent(tabId) {
  const res = await sendBackground({ type: 'ldp:ensureContent', tabId });
  return !!(res && res.ok);
}

async function openPageSettings() {
  const tab = await findTargetTab();
  if (!tab) {
    setState('diagState', '没有可用的 http/https 页面，请先打开一个普通网页。', 'bad');
    return;
  }
  if (!(await ensureContent(tab.id))) {
    setState('diagState', '无法向该标签页注入内容脚本，请刷新页面后重试。', 'bad');
    return;
  }
  const res = await sendTab(tab.id, { type: 'ldp:open-settings' });
  if (res && res.ok) {
    setState('diagState', '已向当前网页发出打开设置请求。', 'good');
  } else {
    setState('diagState', '打开失败：' + ((res && res.reason) || '页面未响应'), 'bad');
  }
}

async function checkActiveTab() {
  const tab = await findTargetTab();
  if (!tab) {
    setState('diagState', '没有可检查的普通网页。', 'bad');
    return;
  }
  const ensured = await ensureContent(tab.id);
  if (!ensured) {
    setState('diagState', '当前页 ' + (tab.url || '') + ' 无法注入内容脚本。', 'bad');
    return;
  }
  const res = await sendTab(tab.id, { type: 'ldp:get-status' });
  if (res && res.ok) {
    const host = res.host || '未知站点';
    setState('diagState', `已连接：${host} · 运行中 ${res.enabled && !res.sitePaused ? '是' : '否'} · 已开 ${res.count || 0} 个预览`, 'good');
  } else {
    setState('diagState', '内容脚本已注入但未响应，建议刷新页面。', 'bad');
  }
}

async function load() {
  if (I18N) await I18N.init();
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = 'v' + version;
  $('footerVersion').textContent = 'v' + version;
  $('factVersion').textContent = 'v' + version;
  $('welcome').hidden = new URLSearchParams(location.search).get('welcome') !== '1';

  const all = await storageGet(SETTINGS_KEY);
  const s = all[SETTINGS_KEY] && typeof all[SETTINGS_KEY] === 'object' ? all[SETTINGS_KEY] : {};
  $('enabled').checked = s.enabled !== false;
  $('contextMenu').checked = s.contextMenu !== false;
  $('badgeCount').checked = s.badgeCount !== false;
  $('language').value = s.language === 'en' ? 'en' : 'zh-CN';
  $('disabledSites').value = String(s.disabledSites || '');

  const updateAll = await storageGet(UPDATE_CONFIG_KEY);
  const updateConfig = updateAll[UPDATE_CONFIG_KEY] && typeof updateAll[UPDATE_CONFIG_KEY] === 'object'
    ? updateAll[UPDATE_CONFIG_KEY] : {};
  $('updateEnabled').checked = updateConfig.enabled !== false;
  $('updateToken').value = String(updateConfig.token || '');
  $('updateToken').dataset.clear = '';
  renderUpdateStatus(updateConfig);

  const aiAll = await storageGet(AI_CONFIG_KEY);
  const ai = aiAll[AI_CONFIG_KEY] && typeof aiAll[AI_CONFIG_KEY] === 'object' ? aiAll[AI_CONFIG_KEY] : {};
  const providerSelect = $('aiProvider');
  providerSelect.innerHTML = '';
  for (const p of AI_PROVIDERS) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.label;
    providerSelect.appendChild(option);
  }
  const activeProvider = AI_PROVIDERS.find(p => p.id === ai.provider) || AI_PROVIDERS[0];
  const savedFor = id => (ai.providerConfigs && ai.providerConfigs[id]) || {};
  const modelFor = (id, fallback) => (ai.selectedModels && ai.selectedModels[id])
    || savedFor(id).model
    || (id === ai.provider ? ai.model : '')
    || fallback;
  providerSelect.value = activeProvider.id;
  $('aiEndpoint').value = String(savedFor(activeProvider.id).endpoint
    || (ai.provider === activeProvider.id ? ai.endpoint : '')
    || activeProvider.endpoint);
  $('aiModel').value = String(modelFor(activeProvider.id, activeProvider.model));
  $('aiKey').value = String((ai.apiKeys && ai.apiKeys[activeProvider.id]) || ai.apiKey || '');
  $('aiKey').dataset.clear = '';
  $('mediaApiKey').dataset.clear = '';
  $('mediaApiKey').value = String(ai.mediaApiKey || (ai.apiKeys && ai.apiKeys.siliconflow) || '');
  $('mediaModel').value = String(ai.mediaModel || AI_DEFAULTS.mediaModel || 'FunAudioLLM/SenseVoiceSmall');
  $('mediaEndpoint').value = String(ai.mediaEndpoint || AI_DEFAULTS.mediaEndpoint);
  $('mediaAudioPrompt').value = String(ai.mediaAudioPrompt || '');
  $('mediaVideoPrompt').value = String(ai.mediaVideoPrompt || '');
  $('aiModelState').textContent = '可手动输入，或填写 Key 后从云端拉取';
  $('aiModelSearch').hidden = true;
  $('aiModelPick').hidden = true;
  $('aiModelList').hidden = true;
  providerSelect.addEventListener('change', () => {
    const p = AI_PROVIDERS.find(x => x.id === providerSelect.value) || AI_PROVIDERS[0];
    // Switching away and back must not discard per-provider endpoint/model
    // values the user already saved.
    $('aiEndpoint').value = String(savedFor(p.id).endpoint
      || (ai.provider === p.id ? ai.endpoint : '')
      || p.endpoint);
    $('aiModel').value = String(modelFor(p.id, p.model));
    $('aiKey').value = String((ai.apiKeys && ai.apiKeys[p.id]) || (ai.provider === p.id ? ai.apiKey : '') || '');
    $('aiKey').dataset.clear = '';
    $('aiModelState').textContent = '已切换服务商，填写 Key 后可拉取模型';
    $('aiModelState').className = 'hint';
    $('aiModelSearch').hidden = true;
    $('aiModelPick').hidden = true;
    $('aiModelPick').innerHTML = '';
    $('aiModelList').hidden = true;
    $('aiModelList').innerHTML = '';
  });
  $('fetchModels').addEventListener('click', async () => {
    const selectedProvider = AI_PROVIDERS.find(x => x.id === providerSelect.value) || AI_PROVIDERS[0];
    const endpoint = $('aiEndpoint').value.trim() || selectedProvider.endpoint;
    const key = $('aiKey').value.trim();
    const state = $('aiModelState');
    state.className = 'hint';
    state.textContent = '正在拉取模型…';
    const res = await sendBackground({ type: 'ldp:listModels', endpoint, apiKey: key });
    if (!res || !res.ok) {
      state.className = 'hint bad';
      state.textContent = '拉取失败：' + (res && (res.detail || res.reason) || '后台没有响应');
      return;
    }
    const models = Array.isArray(res.models) ? res.models : [];
    const latestAll = await storageGet(AI_CONFIG_KEY);
    const latest = latestAll[AI_CONFIG_KEY] && typeof latestAll[AI_CONFIG_KEY] === 'object'
      ? latestAll[AI_CONFIG_KEY] : ai;
    const mergedModels = Object.assign({}, latest.models || {}, { [providerSelect.value]: models });
    await storageSet({ [AI_CONFIG_KEY]: Object.assign({}, latest, { models: mergedModels }) });
    ai.models = mergedModels;
    const list = $('aiModelOptions');
    const pick = $('aiModelPick');
    const modelList = $('aiModelList');
    list.innerHTML = '';
    pick.innerHTML = '';
    modelList.innerHTML = '';
    for (const id of models) {
      const option = document.createElement('option');
      option.value = id;
      list.appendChild(option);
      const row = document.createElement('option');
      row.value = id;
      row.textContent = id;
      pick.appendChild(row);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-model-chip';
      chip.dataset.aiModelChip = id;
      chip.textContent = id;
      chip.title = id;
      chip.addEventListener('click', () => {
        $('aiModel').value = id;
        pick.value = id;
        modelList.querySelectorAll('[data-ai-model-chip]').forEach(x => x.classList.toggle('active', x === chip));
      });
      if (id === $('aiModel').value) chip.classList.add('active');
      modelList.appendChild(chip);
    }
    if (models.length) {
      const current = $('aiModel').value.trim();
      const chosen = models.includes(current) ? current : models[0];
      $('aiModel').value = chosen;
      pick.value = chosen;
      pick.hidden = true;
      modelList.hidden = false;
      const search = $('aiModelSearch');
      search.hidden = false;
      search.value = '';
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        pick.querySelectorAll('option').forEach(opt => {
          opt.hidden = !!q && !String(opt.textContent || '').toLowerCase().includes(q);
        });
        modelList.querySelectorAll('[data-ai-model-chip]').forEach(chip => {
          chip.hidden = !!q && !String(chip.textContent || '').toLowerCase().includes(q);
        });
      };
      pick.onchange = () => { $('aiModel').value = pick.value; };
      state.className = 'hint good';
      state.textContent = '已拉取 ' + models.length + ' 个模型，可搜索或选择';
    } else {
      pick.hidden = true;
      modelList.hidden = true;
      $('aiModelSearch').hidden = true;
      state.className = 'hint bad';
      state.textContent = '接口没有返回模型，可手动填写模型名';
    }
  });

  const bytes = await new Promise(resolve => {
    try { chrome.storage.local.getBytesInUse(null, value => resolve(Number(value) || 0)); }
    catch (e) { resolve(0); }
  });
  $('factStorage').textContent = bytes > 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(2) + ' MB'
    : (bytes / 1024).toFixed(1) + ' KB';

  $('saveBasic').addEventListener('click', async () => {
    const current = await storageGet(SETTINGS_KEY);
    const next = Object.assign({}, current[SETTINGS_KEY] && typeof current[SETTINGS_KEY] === 'object' ? current[SETTINGS_KEY] : {});
    next.enabled = $('enabled').checked;
    next.contextMenu = $('contextMenu').checked;
    next.badgeCount = $('badgeCount').checked;
    next.language = $('language').value === 'en' ? 'en' : 'zh-CN';
    next.disabledSites = $('disabledSites').value.trim();
    await storageSet({ [SETTINGS_KEY]: next });
    if (I18N) {
      I18N.setLanguage(next.language, false);
      I18N.localizeDocument(document);
    }
    setState('saveState', tr('已保存，所有已打开网页会即时收到更新。', 'Saved. Open pages will receive the update immediately.'), 'good');
  });

  $('saveAI').addEventListener('click', async () => {
    const provider = $('aiProvider').value || AI_DEFAULTS.provider;
    const providerMeta = AI_PROVIDERS.find(x => x.id === provider) || AI_PROVIDERS[0];
    const endpoint = $('aiEndpoint').value.trim() || providerMeta.endpoint;
    const model = $('aiModel').value.trim() || providerMeta.model;
    if (!endpoint || !model) {
      setState('aiState', '自定义接口必须填写接口地址和模型名。', 'bad');
      return;
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      setState('aiState', '接口地址必须以 http:// 或 https:// 开头。', 'bad');
      return;
    }
    // Merge against the latest storage snapshot, not the load-time `ai` object:
    // the page-side AI panel may have changed a key/model/prompt meanwhile.
    const latestAll = await storageGet(AI_CONFIG_KEY);
    const latest = latestAll[AI_CONFIG_KEY] && typeof latestAll[AI_CONFIG_KEY] === 'object'
      ? latestAll[AI_CONFIG_KEY] : {};
    const clearKey = $('aiKey').dataset.clear === '1';
    const loadedKey = String((ai.apiKeys && ai.apiKeys[provider]) || (ai.provider === provider ? ai.apiKey : '') || '');
    const typedKey = $('aiKey').value.trim();
    const latestKey = String((latest.apiKeys && latest.apiKeys[provider]) || (latest.provider === provider ? latest.apiKey : '') || '');
    const apiKey = clearKey ? '' : (typedKey && typedKey !== loadedKey ? typedKey : latestKey);
    const apiKeys = Object.assign({}, ai.apiKeys || {}, latest.apiKeys || {});
    apiKeys[provider] = apiKey;
    const providerConfigs = Object.assign({}, ai.providerConfigs || {}, latest.providerConfigs || {});
    providerConfigs[provider] = { endpoint, model };
    const selectedModels = Object.assign({}, ai.selectedModels || {}, latest.selectedModels || {});
    selectedModels[provider] = model;
    const clearMediaKeyFlag = $('mediaApiKey').dataset.clear === '1';
    const loadedMediaKey = String(ai.mediaApiKey || (ai.apiKeys && ai.apiKeys.siliconflow) || '');
    const typedMediaKey = $('mediaApiKey').value.trim();
    const latestMediaKey = String(latest.mediaApiKey || (latest.apiKeys && latest.apiKeys.siliconflow) || '');
    const mediaApiKey = clearMediaKeyFlag ? '' : (typedMediaKey && typedMediaKey !== loadedMediaKey ? typedMediaKey : latestMediaKey);
    const nextConfig = Object.assign({}, latest, {
      provider,
      endpoint,
      model,
      apiKey,
      apiKeys,
      models: latest.models || ai.models || {},
      providerConfigs,
      selectedModels,
      mediaApiKey,
      mediaModel: $('mediaModel').value.trim() || latest.mediaModel || AI_DEFAULTS.mediaModel,
      mediaEndpoint: $('mediaEndpoint').value.trim() || latest.mediaEndpoint || AI_DEFAULTS.mediaEndpoint,
      mediaAudioPrompt: $('mediaAudioPrompt').value.trim(),
      mediaVideoPrompt: $('mediaVideoPrompt').value.trim(),
      summaryPrompt: latest.summaryPrompt || ai.summaryPrompt || AI_DEFAULTS.summaryPrompt
    });
    await storageSet({ [AI_CONFIG_KEY]: nextConfig });
    // Keep the local snapshot in sync so a provider switch in the same page
    // session sees the just-saved key/endpoint instead of the stale load-time
    // values.
    Object.assign(ai, nextConfig);
    $('aiKey').dataset.clear = '';
    $('mediaApiKey').dataset.clear = '';
    setState('aiState', 'AI 设置已保存，打开预览窗口即可使用。', 'good');
  });

  $('aiKey').addEventListener('input', () => { $('aiKey').dataset.clear = ''; });
  $('mediaApiKey').addEventListener('input', () => { $('mediaApiKey').dataset.clear = ''; });
  $('clearAIKey').addEventListener('click', () => {
    $('aiKey').value = '';
    $('aiKey').dataset.clear = '1';
    setState('aiState', '已标记清除当前服务商 Key；点击「保存 AI 设置」后生效。', '');
  });
  $('clearMediaKey').addEventListener('click', () => {
    $('mediaApiKey').value = '';
    $('mediaApiKey').dataset.clear = '1';
    setState('aiState', '已标记清除媒体 Key；点击「保存 AI 设置」后生效。', '');
  });

  $('testAI').addEventListener('click', async () => {
    const selectedProvider = AI_PROVIDERS.find(x => x.id === providerSelect.value) || AI_PROVIDERS[0];
    const endpoint = $('aiEndpoint').value.trim() || selectedProvider.endpoint;
    const model = $('aiModel').value.trim() || selectedProvider.model;
    const apiKey = $('aiKey').value.trim();
    setState('aiState', '正在测试连接…', '');
    const res = await sendBackground({ type: 'ldp:testAI', endpoint, model, apiKey });
    if (!res || !res.ok) {
      setState('aiState', '测试失败：' + (res && (res.reason === 'missing-key' ? '请先填写 API Key' : (res.detail || res.reason)) || '后台没有响应'), 'bad');
      return;
    }
    setState('aiState', '连接成功 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒 · ' + (res.model || model), 'good');
  });

  $('testAIKey').addEventListener('click', async () => {
    const selectedProvider = AI_PROVIDERS.find(x => x.id === providerSelect.value) || AI_PROVIDERS[0];
    const endpoint = $('aiEndpoint').value.trim() || selectedProvider.endpoint;
    const model = $('aiModel').value.trim() || selectedProvider.model;
    const apiKey = $('aiKey').value.trim();
    setState('aiState', '正在测试普通 API Key…', '');
    const res = await sendBackground({ type: 'ldp:testAI', endpoint, model, apiKey });
    if (!res || !res.ok) {
      setState('aiState', '普通 API Key 测试失败：' + (res && (res.reason === 'missing-key' ? '请先填写 API Key' : (res.detail || res.reason)) || '后台没有响应'), 'bad');
      return;
    }
    setState('aiState', '普通 API Key 可用 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒', 'good');
  });

  $('testMediaKey').addEventListener('click', async () => {
    const endpoint = $('mediaEndpoint').value.trim() || AI_DEFAULTS.mediaEndpoint;
    const model = $('mediaModel').value.trim() || AI_DEFAULTS.mediaModel;
    const apiKey = $('mediaApiKey').value.trim();
    setState('aiState', '正在测试媒体 API Key…', '');
    const res = await sendBackground({ type: 'ldp:testMediaAI', endpoint, model, apiKey });
    if (!res || !res.ok) {
      setState('aiState', '媒体 API Key 测试失败：' + (res && (res.reason === 'missing-key' ? '请先填写媒体 API Key' : (res.detail || res.reason)) || '后台没有响应'), 'bad');
      return;
    }
    setState('aiState', '媒体 API Key 可用 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒', 'good');
  });

  $('saveUpdate').addEventListener('click', saveUpdateConfig);
  $('checkUpdate').addEventListener('click', checkUpdateNow);
  $('clearUpdateToken').addEventListener('click', () => {
    $('updateToken').value = '';
    $('updateToken').dataset.clear = '1';
    setState('updateState', tr('已标记清除令牌；点击「保存更新设置」后生效。', 'Token will be cleared after saving.'), '');
  });
  $('updateToken').addEventListener('input', () => { $('updateToken').dataset.clear = ''; });
  $('openUpdate').addEventListener('click', () => {
    const url = $('openUpdate').dataset.url || 'https://github.com/QQQOrange/LinkDrag/releases';
    try {
      chrome.tabs.create({ url }, () => {
        if (chrome.runtime.lastError) {
          try { window.open(url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      try { window.open(url, '_blank', 'noopener'); } catch (e2) { /* ignore */ }
    }
  });

  $('language').addEventListener('change', () => {
    if (!I18N) return;
    I18N.setLanguage($('language').value, false);
    I18N.localizeDocument(document);
  });

  $('openPageSettings').addEventListener('click', openPageSettings);
  $('openActiveTab').addEventListener('click', checkActiveTab);

  $('openShortcuts').addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: 'edge://extensions/shortcuts' }, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }, () => {
            if (chrome.runtime.lastError) setState('diagState', '请在地址栏打开 edge://extensions/shortcuts 或 chrome://extensions/shortcuts。', 'bad');
          });
        }
      });
    } catch (e) {
      setState('diagState', '请在地址栏打开 edge://extensions/shortcuts 或 chrome://extensions/shortcuts。', 'bad');
    }
  });

  $('openExtensions').addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: 'edge://extensions/?id=' + chrome.runtime.id }, () => {
        if (chrome.runtime.lastError) {
          chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }, () => {
            if (chrome.runtime.lastError) setState('diagState', '请在地址栏打开扩展管理页。', 'bad');
          });
        }
      });
    } catch (e) {
      setState('diagState', '请在地址栏打开扩展管理页。', 'bad');
    }
  });

  $('clearData').addEventListener('click', async () => {
    if (!window.confirm('会清除所有设置、布局、历史、会话与站点暂停记录。确定继续？')) return;
    await new Promise(resolve => {
      try { chrome.storage.local.clear(() => resolve()); }
      catch (e) { resolve(); }
    });
    location.reload();
  });
}

document.addEventListener('DOMContentLoaded', load);
