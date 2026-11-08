'use strict';

const NAMESPACE = 'LPS_EXT';
const SETTINGS_KEY = 'FOX_QQQORANGE_PREVIEW_140_SETTINGS';
const HISTORY_KEY = 'FOX_QQQORANGE_PREVIEW_140_HISTORY';

const $ = id => document.getElementById(id);
const ui = {};
const I18N = window.LinkDragI18N;
const tr = (zh, en) => (I18N && I18N.isEnglish && I18N.isEnglish() ? en : zh);

let activeTab = null;
let status = null;
let contentReady = false;

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

function sendTab(type, payload) {
  if (!activeTab || !Number.isInteger(activeTab.id)) return Promise.resolve(null);
  return new Promise(resolve => {
    const message = Object.assign({ namespace: NAMESPACE, type }, payload || {});
    try {
      chrome.tabs.sendMessage(activeTab.id, message, { frameId: 0 }, response => {
        const err = chrome.runtime.lastError;
        resolve(err ? null : response);
      });
    } catch (e) { resolve(null); }
  });
}

function storageGet(key, fallback) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(key, value => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve(value && value[key] !== undefined ? value[key] : fallback);
      });
    } catch (e) { resolve(fallback); }
  });
}

function storageSet(key, value) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

function setMessage(text, tone) {
  ui.message.textContent = text || '';
  ui.message.className = 'message' + (tone ? ' ' + tone : '');
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname || (u.protocol === 'file:' ? tr('本地文件', 'Local file') : u.protocol.replace(':', ''));
  } catch (e) { return ''; }
}

function isSupported(url) {
  return /^https?:/i.test(url) || /^file:/i.test(url);
}

function render() {
  if (!status) return;
  const host = status.host || hostOf(activeTab && activeTab.url) || tr('当前页面', 'Current page');
  ui.siteName.textContent = host;
  ui.siteUrl.textContent = activeTab && activeTab.url ? activeTab.url : '';
  ui.previewCount.textContent = (status.count || 0) + ' ' + tr('个预览', 'previews');

  const globallyOn = status.enabled !== false;
  const sitePaused = !!status.sitePaused;
  if (!globallyOn) {
    ui.statusPill.textContent = tr('全局已暂停', 'Globally paused');
    ui.statusPill.className = 'pill off';
  } else if (sitePaused) {
    ui.statusPill.textContent = tr('本站已暂停', 'Site paused');
    ui.statusPill.className = 'pill off';
  } else {
    ui.statusPill.textContent = tr('运行中', 'Running');
    ui.statusPill.className = 'pill ok';
  }

  ui.globalEnabled.checked = globallyOn;
  ui.sitePaused.checked = sitePaused;
  ui.hoverPeek.checked = status.hoverPeek !== false;
  ui.linkButton.checked = status.linkButton !== false;
  ui.imageDragPreview.checked = status.imageDragPreview !== false;
  ui.openSettings.disabled = !contentReady;
  ui.openHelp.disabled = !contentReady;
}

async function directMergeSetting(name, value) {
  const current = await storageGet(SETTINGS_KEY, {});
  const next = Object.assign({}, current && typeof current === 'object' ? current : {});
  next[name] = value;
  await storageSet(SETTINGS_KEY, next);
}

async function applySetting(name, value) {
  if (!contentReady) {
    await directMergeSetting(name, value);
    status = Object.assign({}, status || {}, { [name]: value });
    if (name === 'enabled') status.enabled = !!value;
    render();
    setMessage(tr('已保存；刷新页面后生效', 'Saved; refresh the page to apply'), 'good');
    return;
  }
  const response = await sendTab('ldp:set-setting', { name, value });
  if (response && response.ok) {
    status = response;
    render();
    setMessage(tr('设置已应用', 'Settings applied'), 'good');
  } else {
    await directMergeSetting(name, value);
    status = Object.assign({}, status || {}, { [name]: value });
    if (name === 'enabled') status.enabled = !!value;
    render();
    setMessage(tr('页面脚本未响应，已保存到扩展设置', 'The page script did not respond; saved to extension settings'), 'bad');
  }
}

async function toggleSite() {
  if (!contentReady) {
    const current = await storageGet(SETTINGS_KEY, {});
    const list = String(current.disabledSites || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const host = status && status.host;
    if (host) {
      const idx = list.findIndex(rule => host === rule || host.endsWith('.' + rule));
      if (idx >= 0) list.splice(idx, 1); else list.push(host);
      await directMergeSetting('disabledSites', list.join(','));
      status = Object.assign({}, status || {}, {
        sitePaused: list.some(rule => host === rule || host.endsWith('.' + rule))
      });
      render();
    }
    setMessage(tr('已保存；刷新页面后生效', 'Saved; refresh the page to apply'), 'good');
    return;
  }
  const response = await sendTab('ldp:toggle-site');
  if (response && response.ok) {
    status = response;
    render();
    setMessage(status.sitePaused ? tr('已暂停本站', 'This site is paused') : tr('已恢复本站', 'This site is resumed'), 'good');
  } else {
    setMessage(tr('操作失败：页面脚本未响应', 'Action failed: the page script did not respond'), 'bad');
  }
}

async function openInPage(type) {
  if (!contentReady) {
    setMessage(tr('页面脚本尚未连接，请刷新页面后重试', 'The page script is not connected yet. Refresh and try again.'), 'bad');
    return;
  }
  const response = await sendTab(type);
  if (response && response.ok) {
    window.close();
  } else {
    setMessage(tr('无法打开：', 'Cannot open: ') + ((response && response.reason) || tr('页面限制', 'page restriction')), 'bad');
  }
}

async function loadHistory() {
  const list = await storageGet(HISTORY_KEY, []);
  ui.historyList.textContent = '';
  const entries = Array.isArray(list) ? list.filter(h => h && /^https?:/i.test(String(h.url || ''))).slice(0, 5) : [];
  ui.historyEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = entry.title || entry.url;
    title.title = entry.url;
    const host = document.createElement('span');
    host.className = 'h-host';
    host.textContent = hostOf(entry.url);
    btn.append(dot, title, host);
    btn.addEventListener('click', async () => {
      if (!status || status.enabled === false || status.sitePaused) {
        setMessage(tr('请先启用扩展并恢复本站', 'Enable LinkDrag and resume this site first'), 'bad');
        return;
      }
      const response = await sendTab('ldp:open-preview', { url: entry.url, title: entry.title || '' });
      if (response && response.ok) window.close();
      else setMessage(tr('打开失败：', 'Open failed: ') + ((response && response.reason) || tr('页面限制', 'page restriction')), 'bad');
    });
    ui.historyList.appendChild(btn);
  }
}

function isNewerVersion(latest, current) {
  const parts = value => String(value || '').replace(/^v/i, '').split('.').map(x => Number((String(x).match(/^\d+/) || [0])[0]) || 0);
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function loadUpdateBanner() {
  if (!ui.updateBanner) return;
  const status = await sendBackground({ type: 'ldp:getUpdateStatus' });
  const current = chrome.runtime.getManifest().version;
  const latest = String((status && status.latestVersion) || '');
  if (!status || !status.ok || !latest || !isNewerVersion(latest, current)) {
    ui.updateBanner.hidden = true;
    return;
  }
  const releaseUrl = /^https:\/\/github\.com\/QQQOrange\/LinkDrag\/releases(?:\/|$)/i.test(String(status.releaseUrl || ''))
    ? status.releaseUrl
    : 'https://github.com/QQQOrange/LinkDrag/releases';
  ui.updateVersion.textContent = `v${latest}（当前 v${current}）`;
  ui.openUpdate.dataset.url = releaseUrl;
  ui.updateBanner.hidden = false;
}

async function ensureAndReadStatus() {
  const injected = await sendBackground({ type: 'ldp:ensureContent', tabId: activeTab.id });
  contentReady = !!(injected && injected.ok);
  if (!contentReady) return;
  await new Promise(resolve => setTimeout(resolve, 70));
  const response = await sendTab('ldp:get-status');
  if (response && response.ok) {
    status = response;
    contentReady = true;
  } else {
    contentReady = false;
  }
}

async function init() {
  if (I18N) await I18N.init();
  ui.version = $('version');
  ui.unsupported = $('unsupported');
  ui.main = $('main');
  ui.siteName = $('siteName');
  ui.siteUrl = $('siteUrl');
  ui.statusPill = $('statusPill');
  ui.previewCount = $('previewCount');
  ui.globalEnabled = $('globalEnabled');
  ui.sitePaused = $('sitePaused');
  ui.hoverPeek = $('hoverPeek');
  ui.linkButton = $('linkButton');
  ui.imageDragPreview = $('imageDragPreview');
  ui.openSettings = $('openSettings');
  ui.summaryPage = $('summaryPage');
  ui.summaryMedia = $('summaryMedia');
  ui.openSidePanel = $('openSidePanel');
  ui.openHelp = $('openHelp');
  ui.openOptions = $('openOptions');
  ui.footerOptions = $('footerOptions');
  ui.historyList = $('historyList');
  ui.historyEmpty = $('historyEmpty');
  ui.message = $('message');
  ui.updateBanner = $('updateBanner');
  ui.updateVersion = $('updateVersion');
  ui.openUpdate = $('openUpdate');
  ui.openUpdate.addEventListener('click', () => {
    const url = ui.openUpdate.dataset.url || 'https://github.com/QQQOrange/LinkDrag/releases';
    try {
      chrome.tabs.create({ url }, () => {
        if (chrome.runtime.lastError) {
          try { window.open(url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        }
        window.close();
      });
    } catch (e) {
      try { window.open(url, '_blank', 'noopener'); } catch (e2) { /* ignore */ }
      window.close();
    }
  });

  ui.version.textContent = 'v' + chrome.runtime.getManifest().version;
  ui.footerOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  loadUpdateBanner();

  const tabResponse = await sendBackground({ type: 'ldp:getActiveTab' });
  activeTab = tabResponse && tabResponse.tab;
  if (!activeTab || !isSupported(activeTab.url || '')) {
    ui.unsupported.hidden = false;
    return;
  }

  ui.main.hidden = false;
  await ensureAndReadStatus();
  if (!status) {
    const stored = await storageGet(SETTINGS_KEY, {});
    const host = hostOf(activeTab.url).toLowerCase();
    const sites = String(stored.disabledSites || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    status = {
      enabled: stored.enabled !== false,
      sitePaused: !!host && sites.some(rule => host === rule || host.endsWith('.' + rule)),
      count: 0,
      hoverPeek: stored.hoverPeek !== false,
      linkButton: stored.linkButton !== false,
      imageDragPreview: stored.imageDragPreview !== false,
      host: hostOf(activeTab.url)
    };
    setMessage(tr('页面脚本未连接。可刷新页面，或点击下方「选项与诊断」检查权限。', 'The page script is not connected. Refresh the page or open Options & diagnostics to check permissions.'), 'bad');
  }
  render();
  if (/^file:/i.test(activeTab.url || '')) {
    setMessage(tr('file:// 页面需要在扩展详情里开启“允许访问文件网址”。', 'For file:// pages, enable “Allow access to file URLs” in the extension details.'), '');
  }
  loadHistory();

  ui.globalEnabled.addEventListener('change', () => applySetting('enabled', ui.globalEnabled.checked));
  ui.sitePaused.addEventListener('change', () => toggleSite());
  ui.hoverPeek.addEventListener('change', () => applySetting('hoverPeek', ui.hoverPeek.checked));
  ui.linkButton.addEventListener('change', () => applySetting('linkButton', ui.linkButton.checked));
  ui.imageDragPreview.addEventListener('change', () => applySetting('imageDragPreview', ui.imageDragPreview.checked));
  ui.openSettings.addEventListener('click', () => openInPage('ldp:open-settings'));
  ui.summaryPage.addEventListener('click', () => openInPage('ldp:summary-page'));
  ui.summaryMedia.addEventListener('click', () => openInPage('ldp:summary-media'));
  ui.openSidePanel.addEventListener('click', async () => {
    try {
      const win = await new Promise(resolve => chrome.windows.getCurrent(resolve));
      if (chrome.sidePanel && chrome.sidePanel.open && win && win.id != null) {
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
      }
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
    }
  });
  ui.openHelp.addEventListener('click', () => openInPage('ldp:open-help'));
  ui.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

document.addEventListener('DOMContentLoaded', init);
