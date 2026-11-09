'use strict';

/* ============================================================================
 * LinkDrag — MV3 service worker
 * ----------------------------------------------------------------------------
 * The content-script core is deliberately self-contained.  This worker only
 * provides the capabilities that a content script cannot reliably provide:
 *   • privileged cross-origin fetch (host permissions, no page CORS)
 *   • tab creation without the page's opener
 *   • context menus, toolbar badge, commands and on-demand script injection
 *   • a single place to rebuild menus when extension-level settings change
 * ========================================================================== */

const VERSION = chrome.runtime.getManifest().version;
const NAMESPACE = 'LPS_EXT';
const SETTINGS_KEY = 'FOX_QQQORANGE_PREVIEW_140_SETTINGS';
const AI_CONFIG_KEY = 'FOX_QQQORANGE_PREVIEW_140_AI';
const UPDATE_CONFIG_KEY = 'LINKDRAG_UPDATE_CONFIG';
const UPDATE_REPO = 'QQQOrange/LinkDrag';
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const UPDATE_NOTIFY_COOLDOWN = 10 * 60 * 1000;
let updateCheckPromise = null;
const DEFAULT_AI_CONFIG = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-chat',
  apiKey: '',
  apiKeys: {},
  models: {},
  providerConfigs: {},
  selectedModels: {},
  mediaApiKey: '',
  mediaModel: 'FunAudioLLM/SenseVoiceSmall',
  mediaEndpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions'
};
const aiStreamControllers = new WeakMap();
try { importScripts('hls.js'); } catch (e) { /* parser unavailable */ }

const CONTEXT_MENU_IDS = ['ldp-preview-link', 'ldp-preview-image', 'ldp-preview-selection', 'ldp-open-settings'];
const MAX_FETCH_BYTES = 12 * 1024 * 1024;
const capturedMediaByTab = new Map();
/** Tab currently receiving proxy-download progress (set per download). */
let lastDownloadTabId = -1;
const MEDIA_REQUEST_RE = /(douyinvod|video\/tos|aweme\/v1\/play|mime_type=video|mime_type=audio|\.mp4(?:$|\?)|\.m4s(?:$|\?)|\.flv(?:$|\?)|\.mp3(?:$|\?)|\.m4a(?:$|\?)|\.webm(?:$|\?)|\.ts(?:$|\?)|\.aac(?:$|\?)|\.m3u8(?:$|\?)|\.mpd(?:$|\?))/i;
const HLS_REQUEST_RE = /\.m3u8(?:$|\?)|[?&](?:format|type)=m3u8/i;
const DASH_REQUEST_RE = /\.mpd(?:$|\?)/i;
/**
 * Classify a captured media request so the content script can offer the right
 * button.  Extensionless CDN URLs are common, so the response content-type from
 * onHeadersReceived is the reliable signal; the URL pattern is the fallback.
 */
function classifyCapturedMedia(url, contentType) {
  const target = String(url || '');
  const type = String(contentType || '').toLowerCase();
  if (HLS_REQUEST_RE.test(target) || /mpegurl/.test(type)) return 'hls';
  if (DASH_REQUEST_RE.test(target) || /dash\+xml/.test(type)) return 'dash';
  if (/^audio\//.test(type) || /\.(?:mp3|m4a|aac|oga|opus|wav)(?:$|\?)/i.test(target)) return 'audio';
  if (/^video\//.test(type) || /\.(?:mp4|m4s|flv|webm|mov|mkv|ts)(?:$|\?)/i.test(target)) return 'video';
  return '';
}
// MV3 workers are evicted aggressively, which used to wipe the in-memory
// capture list; a user who waited a few seconds before opening the summary got
// "no downloadable media".  Mirror it into session storage (cleared when the
// browser closes) so the data survives a worker restart.
const CAPTURE_STORE_PREFIX = 'ldp:capturedMedia:';
let capturePersistTimer = 0;
function scheduleCapturePersist(tabId) {
  if (capturePersistTimer) return;
  capturePersistTimer = setTimeout(() => {
    capturePersistTimer = 0;
    try {
      const payload = {};
      for (const [id, list] of capturedMediaByTab) {
        if (!list || !list.length) continue;
        payload[CAPTURE_STORE_PREFIX + id] = list.slice(0, 32);
      }
      if (chrome.storage && chrome.storage.session) chrome.storage.session.set(payload).catch(() => {});
    } catch (e) { /* ignore */ }
  }, 700);
}
async function loadCapturedMedia(tabId) {
  const memory = capturedMediaByTab.get(tabId);
  if (Array.isArray(memory) && memory.length) return memory;
  try {
    if (!chrome.storage || !chrome.storage.session) return memory || [];
    const key = CAPTURE_STORE_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    const list = stored && Array.isArray(stored[key]) ? stored[key] : [];
    if (list.length) capturedMediaByTab.set(tabId, list);
    return list;
  } catch (e) { return memory || []; }
}
try {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(tabId => {
      capturedMediaByTab.delete(tabId);
      try {
        if (chrome.storage && chrome.storage.session) chrome.storage.session.remove(CAPTURE_STORE_PREFIX + tabId).catch(() => {});
      } catch (e) { /* ignore */ }
    });
  }
} catch (e) { /* ignore */ }

function rememberCapturedMedia(tabId, url, requestType, contentType) {
  if (tabId < 0 || !/^https?:\/\//i.test(String(url || ''))) return;
  const kind = classifyCapturedMedia(url, contentType);
  const list = capturedMediaByTab.get(tabId) || [];
  const existing = list.find(entry => entry && entry.url === url);
  if (existing) {
    if (contentType && !existing.contentType) existing.contentType = String(contentType).slice(0, 80);
    if (kind) existing.kind = kind;
    scheduleCapturePersist(tabId);
    return;
  }
  list.unshift({
    url,
    at: Date.now(),
    type: requestType || '',
    kind,
    contentType: contentType ? String(contentType).slice(0, 80) : ''
  });
  if (list.length > 32) list.length = 32;
  capturedMediaByTab.set(tabId, list);
  scheduleCapturePersist(tabId);
}
if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(details => {
    try {
      if (!MEDIA_REQUEST_RE.test(String(details.url || ''))) return;
      rememberCapturedMedia(details.tabId, details.url, details.type, '');
    } catch (e) { /* ignore */ }
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, []);
}
// Content-type sniffing: catches CDN URLs that carry no file extension, which is
// how most modern Chinese video sites serve their streams.
if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener(details => {
    try {
      const headers = details.responseHeaders || [];
      let contentType = '';
      for (const header of headers) {
        if (String(header.name || '').toLowerCase() !== 'content-type') continue;
        contentType = String(header.value || '');
        break;
      }
      if (!contentType) return;
      if (!/^(?:video|audio)\//i.test(contentType) && !/mpegurl/i.test(contentType)) return;
      rememberCapturedMedia(details.tabId, details.url, details.type, contentType);
    } catch (e) { /* ignore */ }
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
}

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

async function getSettings() {
  const all = await storageGet(SETTINGS_KEY);
  const s = all[SETTINGS_KEY];
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/* ------------------------------------------------------------------------- */
/* Update checker                                                             */
/* ------------------------------------------------------------------------- */

function normalizeUpdateConfig(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const latestVersion = String(raw.latestVersion || '').replace(/^v/i, '');
  return {
    enabled: raw.enabled !== false,
    token: String(raw.token || '').trim(),
    lastCheck: Number(raw.lastCheck) || 0,
    latestVersion,
    latestName: String(raw.latestName || ''),
    releaseUrl: String(raw.releaseUrl || UPDATE_RELEASES_URL),
    publishedAt: String(raw.publishedAt || ''),
    lastError: String(raw.lastError || ''),
    // Never trust the persisted flag: it can be stale after LinkDrag itself
    // was updated.  Availability is always relative to the running version.
    updateAvailable: !!latestVersion && compareVersions(latestVersion, VERSION) > 0,
    lastNotifiedAt: Number(raw.lastNotifiedAt) || 0,
    lastNotifiedVersion: String(raw.lastNotifiedVersion || '')
  };
}

function storageSetLocal(value) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set(value, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

function versionParts(value) {
  return String(value || '').replace(/^v/i, '').split('.').map(part => {
    const match = String(part).match(/^\d+/);
    return match ? Number(match[0]) : 0;
  });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function readUpdateConfig() {
  const all = await storageGet(UPDATE_CONFIG_KEY);
  return normalizeUpdateConfig(all[UPDATE_CONFIG_KEY]);
}

function publicUpdateStatus(config) {
  const latestVersion = config.latestVersion || '';
  return {
    ok: true,
    enabled: config.enabled !== false,
    hasToken: !!config.token,
    currentVersion: VERSION,
    latestVersion,
    latestName: config.latestName || '',
    releaseUrl: config.releaseUrl || UPDATE_RELEASES_URL,
    publishedAt: config.publishedAt || '',
    lastCheck: config.lastCheck || 0,
    lastError: config.lastError || '',
    updateAvailable: !!latestVersion && compareVersions(latestVersion, VERSION) > 0
  };
}

function openUpdateRelease() {
  return readUpdateConfig().then(config => {
    const candidate = String(config.releaseUrl || '');
    const url = /^https:\/\/github\.com\/QQQOrange\/LinkDrag\/releases(?:\/|$)/i.test(candidate)
      ? candidate
      : UPDATE_RELEASES_URL;
    try { chrome.tabs.create({ url }); } catch (e) { /* ignore */ }
    return url;
  });
}

async function fetchAtomRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://github.com/${UPDATE_REPO}/releases.atom`, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Accept': 'application/atom+xml,application/xml,text/xml' },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const xml = await response.text();
    const entry = xml.match(/<entry>[\s\S]*?<\/entry>/i);
    if (!entry) return null;
    const body = entry[0];
    const link = body.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i)
      || body.match(/<link[^>]+href=["']([^"']+)["']/i);
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const updated = body.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    const url = link ? String(link[1]).replace(/&amp;/g, '&') : '';
    const tag = (url.match(/\/tag\/([^/?#]+)/) || [])[1] || '';
    if (!tag) return null;
    return {
      tag_name: decodeURIComponent(tag),
      html_url: url || `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
      name: title ? String(title[1]).replace(/<[^>]+>/g, '').trim() : '',
      published_at: updated ? String(updated[1]).trim() : ''
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkForUpdate(force, manual) {
  const config = await readUpdateConfig();
  if (!config.enabled && !manual) return publicUpdateStatus(config);
  if (!force && config.lastCheck && Date.now() - config.lastCheck < UPDATE_CHECK_INTERVAL) {
    return publicUpdateStatus(config);
  }
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LinkDrag/' + VERSION
    };
    if (config.token) headers.Authorization = 'Bearer ' + config.token;
    let next = Object.assign({}, config, { lastCheck: Date.now() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      let response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      // Fine-grained tokens sometimes have no repository selected, which
      // GitHub reports as 404 for this public repo.  Retry the public endpoint
      // without the token instead of failing a valid token setup outright.
      if (!response.ok && config.token && [401, 403, 404].includes(response.status)) {
        const publicHeaders = Object.assign({}, headers);
        delete publicHeaders.Authorization;
        response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
          headers: publicHeaders,
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal
        });
      }
      let release = null;
      if (response.ok) {
        release = await response.json();
      } else {
        // If the API is rate-limited or the token cannot access this public
        // repository, the public Atom feed still provides the latest tag.
        release = await fetchAtomRelease();
      }
      if (!release) {
        const detail = response.status === 401 || response.status === 403
          ? 'GitHub 令牌无效或 API 限流（HTTP ' + response.status + '）'
          : response.status === 404
            ? '没有找到 LinkDrag 的 GitHub 发布页'
            : 'GitHub 返回 HTTP ' + response.status;
        next.lastError = detail;
      } else {
        const latestVersion = String(release.tag_name || '').replace(/^v/i, '').trim();
        if (!latestVersion) {
          next.lastError = 'GitHub 发布信息缺少版本号';
        } else {
          const available = compareVersions(latestVersion, VERSION) > 0;
          next = Object.assign(next, {
            latestVersion,
            latestName: String(release.name || release.tag_name || ''),
            releaseUrl: String(release.html_url || (`https://github.com/${UPDATE_REPO}/releases/tag/${release.tag_name || latestVersion}`)),
            publishedAt: String(release.published_at || ''),
            lastError: '',
            updateAvailable: available
          });
          if (!available) {
            next.lastNotifiedVersion = '';
            next.lastNotifiedAt = 0;
            try {
              if (chrome.notifications && chrome.notifications.clear) {
                if (config.lastNotifiedVersion) {
                  chrome.notifications.clear('linkdrag-update-' + config.lastNotifiedVersion);
                }
                if (latestVersion) chrome.notifications.clear('linkdrag-update-' + latestVersion);
              }
            } catch (e) { /* ignore */ }
          } else if (force || config.lastNotifiedVersion !== latestVersion || Date.now() - config.lastNotifiedAt > UPDATE_NOTIFY_COOLDOWN) {
            next.lastNotifiedVersion = latestVersion;
            next.lastNotifiedAt = Date.now();
            try {
              if (chrome.notifications && chrome.notifications.create) {
                const uiSettings = await getSettings();
                const english = uiSettings.language === 'en';
                chrome.notifications.create('linkdrag-update-' + latestVersion, {
                  type: 'basic',
                  iconUrl: chrome.runtime.getURL('icons/128.png'),
                  title: english ? 'LinkDrag update available' : 'LinkDrag 有新版本',
                  message: english
                    ? `Current v${VERSION}, latest v${latestVersion}. Click to open the GitHub release page.`
                    : `当前 v${VERSION}，最新 v${latestVersion}。点击查看 GitHub 发布页。`,
                  buttons: [{ title: english ? 'View update' : '查看更新' }],
                  priority: 2
                });
              }
            } catch (e) { /* notifications may be disabled */ }
          }
        }
      }
    } catch (e) {
      next.lastError = '检查更新失败：' + (e && e.message ? String(e.message).slice(0, 160) : '网络错误');
    } finally {
      clearTimeout(timer);
    }
    await storageSetLocal({ [UPDATE_CONFIG_KEY]: next });
    return publicUpdateStatus(normalizeUpdateConfig(next));
  })().finally(() => { updateCheckPromise = null; });
  return updateCheckPromise;
}

function scheduleUpdateCheck(reason) {
  setTimeout(() => {
    checkForUpdate(reason === 'startup').catch(() => {});
  }, reason === 'startup' ? 2500 : 6000);
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return /^https?:$/.test(u.protocol);
  } catch (e) { return false; }
}

function normalizeUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.href;
  } catch (e) { return ''; }
}

function isPublicHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || host === 'metadata.google.internal') return false;
    if (host === '::1' || host === '0.0.0.0') return false;
    if (/^\[?fc|^\[?fd|^\[?fe8|^\[?fe9|^\[?fea|^\[?feb/i.test(host)) return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    // Browsers also accept hex (0x7f000001), octal and plain-decimal (2130706433)
    // spellings of an IPv4 address, which would slip past the dotted-quad checks.
    if (/^(?:0x[0-9a-f]+|\d{6,})$/i.test(host)) {
      const asNumber = /^0x/i.test(host) ? parseInt(host.slice(2), 16) : Number(host);
      if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 0xffffffff) {
        const a = (asNumber >>> 24) & 255;
        const b = (asNumber >>> 16) & 255;
        if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
          || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
      }
    }
    return true;
  } catch (e) { return false; }
}

function urlFromSelection(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let m = raw.match(/https?:\/\/[^\s"'<>]+/i);
  if (m) return normalizeUrl(m[0].replace(/[),.，。；;]+$/, ''));
  m = raw.match(/\b((?:[\w-]+\.)+[a-z]{2,})(\/[^\s"'<>]*)?/i);
  if (m) return normalizeUrl('https://' + m[0]);
  return '';
}

/* ------------------------------------------------------------------------- */
/* Context menus                                                              */
/* ------------------------------------------------------------------------- */

function removeAllMenus() {
  return new Promise(resolve => {
    try { chrome.contextMenus.removeAll(() => resolve()); }
    catch (e) { resolve(); }
  });
}

function createMenu(props) {
  return new Promise(resolve => {
    try {
      chrome.contextMenus.create(props, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

async function rebuildContextMenus() {
  await removeAllMenus();
  const settings = await getSettings();
  if (settings.contextMenu === false) return;
  await createMenu({
    id: 'ldp-preview-link',
    title: '用 LinkDrag 预览此链接',
    contexts: ['link']
  });
  await createMenu({
    id: 'ldp-preview-image',
    title: '用 LinkDrag 查看高清图片',
    contexts: ['image']
  });
  await createMenu({
    id: 'ldp-preview-selection',
    title: '用 LinkDrag 预览选中的网址',
    contexts: ['selection']
  });
  await createMenu({
    id: 'ldp-open-settings',
    title: 'LinkDrag：打开设置',
    contexts: ['page', 'frame']
  });
}

// Rebuilds can be requested by several lifecycle events at once (worker wake,
// install, startup, storage change).  Serialize them so removeAll() from a
// second request cannot wipe the menus created by the first one.
let menuQueue = Promise.resolve();
function scheduleMenuRebuild() {
  menuQueue = menuQueue.then(rebuildContextMenus, rebuildContextMenus).catch(() => {});
  return menuQueue;
}

/* ------------------------------------------------------------------------- */
/* Tabs / content-script plumbing                                             */
/* ------------------------------------------------------------------------- */

function queryActiveTab() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve(Array.isArray(tabs) && tabs[0] ? tabs[0] : null);
      });
    } catch (e) { resolve(null); }
  });
}

function sendTabMessage(tabId, message, frameId) {
  return new Promise(resolve => {
    const callback = response => {
      const err = chrome.runtime.lastError;
      resolve({ ok: !err, response, error: err ? err.message : '' });
    };
    try {
      // Default to the top frame.  Without an explicit frameId Chrome may pick
      // a responding child frame, which made popup status show an iframe host.
      const targetFrame = Number.isInteger(frameId) ? frameId : 0;
      chrome.tabs.sendMessage(tabId, message, { frameId: targetFrame }, callback);
    } catch (e) {
      resolve({ ok: false, response: null, error: String(e && e.message || e) });
    }
  });
}

async function injectContent(tabId) {
  return new Promise(resolve => {
    try {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ['content.js']
      }, () => {
        const err = chrome.runtime.lastError;
        resolve(!err);
      });
    } catch (e) { resolve(false); }
  });
}

async function ensureContent(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const ping = await sendTabMessage(tabId, { namespace: NAMESPACE, type: 'ldp:ping' });
  if (ping.ok && ping.response && ping.response.ok) return true;
  const injected = await injectContent(tabId);
  if (!injected) return false;
  // executeScript resolves after the file has run; a short yield avoids a race
  // between the injected listener registration and the next message.
  await new Promise(resolve => setTimeout(resolve, 60));
  const again = await sendTabMessage(tabId, { namespace: NAMESPACE, type: 'ldp:ping' });
  return !!(again.ok && again.response && again.response.ok);
}

async function openPreviewInTab(tabId, frameId, url, title) {
  if (!Number.isInteger(tabId) || !isHttpUrl(url)) return { ok: false, reason: 'invalid-url' };
  const message = {
    namespace: NAMESPACE,
    type: 'ldp:open-preview',
    url: normalizeUrl(url),
    title: String(title || '').slice(0, 300)
  };
  let sent = await sendTabMessage(tabId, message, Number.isInteger(frameId) ? frameId : 0);
  if (!sent.ok || !sent.response || !sent.response.ok) {
    // The extension may have been reloaded while this tab stayed open.  Inject
    // the top-frame copy, then retry at frame 0.
    const ready = await ensureContent(tabId);
    if (ready) sent = await sendTabMessage(tabId, message, 0);
  }
  return (sent && sent.response) || { ok: false, reason: sent && sent.error || 'no-response' };
}

async function openImageInTab(tabId, frameId, url, title) {
  if (!Number.isInteger(tabId) || !isHttpUrl(url)) return { ok: false, reason: 'invalid-url' };
  const message = {
    namespace: NAMESPACE,
    type: 'ldp:open-image',
    image: {
      url: normalizeUrl(url),
      title: String(title || '').slice(0, 300),
      candidates: [normalizeUrl(url)]
    }
  };
  let sent = await sendTabMessage(tabId, message, Number.isInteger(frameId) ? frameId : 0);
  if (!sent.ok || !sent.response || !sent.response.ok) {
    const ready = await ensureContent(tabId);
    if (ready) sent = await sendTabMessage(tabId, message, 0);
  }
  return (sent && sent.response) || { ok: false, reason: sent && sent.error || 'no-response' };
}

async function openSettingsInTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  let sent = await sendTabMessage(tabId, { namespace: NAMESPACE, type: 'ldp:open-settings' }, 0);
  if (!sent.ok || !sent.response || !sent.response.ok) {
    const ready = await ensureContent(tabId);
    if (ready) sent = await sendTabMessage(tabId, { namespace: NAMESPACE, type: 'ldp:open-settings' }, 0);
  }
  return !!(sent && sent.response && sent.response.ok);
}

const badgeFlashTimers = new Map();

async function flashBadge(tabId, text) {
  if (!Number.isInteger(tabId)) return;
  clearTimeout(badgeFlashTimers.get(tabId));
  try {
    await chrome.action.setBadgeText({ tabId, text: String(text || '!') });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d9485f' });
    const timer = setTimeout(() => {
      badgeFlashTimers.delete(tabId);
      try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* ignore */ }
    }, 2200);
    badgeFlashTimers.set(tabId, timer);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------------- */
/* Badge                                                                      */
/* ------------------------------------------------------------------------- */

async function updateBadge(tabId, count) {
  if (!Number.isInteger(tabId)) return;
  clearTimeout(badgeFlashTimers.get(tabId));
  badgeFlashTimers.delete(tabId);
  const settings = await getSettings();
  const n = Math.max(0, Math.min(99, Number(count) || 0));
  const show = settings.badgeCount !== false && n > 0;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#5577e8' });
    await chrome.action.setBadgeText({ tabId, text: show ? String(n) : '' });
    await chrome.action.setTitle({
      tabId,
      title: show ? `LinkDrag — 已开 ${n} 个预览` : 'LinkDrag — 链接预览完全体'
    });
  } catch (e) { /* tab may have closed */ }
}

/* ------------------------------------------------------------------------- */
/* Privileged fetch                                                           */
/* ------------------------------------------------------------------------- */

function charsetFromContentType(contentType) {
  const m = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

function sniffCharset(bytes) {
  try {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    let m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>]+)/i);
    if (m) return m[1].trim().toLowerCase();
    m = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;>]+)/i);
    if (m) return m[1].trim().toLowerCase();
  } catch (e) { /* ignore */ }
  return '';
}

function decodeHtmlBuffer(buffer, contentType) {
  const raw = String(contentType || '').toLowerCase();
  let label = charsetFromContentType(contentType) || sniffCharset(buffer) || 'utf-8';
  // WHATWG aliases.  GB2312/GBK pages are overwhelmingly served as GB18030 in
  // practice; TextDecoder('gb18030') handles the superset correctly.
  if (label === 'gb2312' || label === 'gbk' || label === 'x-gbk') label = 'gb18030';
  if (label === 'utf8') label = 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch (e) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(buffer); }
    catch (e2) { return ''; }
  }
}

/* ------------------------------------------------------------------------- */
/* Media content summary (SiliconFlow Qwen3-Omni)                             */
/* ------------------------------------------------------------------------- */

const MEDIA_ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const MEDIA_CHAT_MODEL = 'Qwen/Qwen3-Omni-30B-A3B-Thinking';
const MEDIA_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const MEDIA_CHAT_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const MEDIA_MAX_BYTES = 80 * 1024 * 1024;
const mediaBytesCache = new Map();

function cacheMediaBytes(url, value) {
  mediaBytesCache.set(url, Object.assign({ time: Date.now() }, value));
  while (mediaBytesCache.size > 3) mediaBytesCache.delete(mediaBytesCache.keys().next().value);
}

async function transcribeMediaAudio(dataUrl, endpoint, key, model) {
  if (!dataUrl || !/^data:/i.test(dataUrl) || !key) return { ok: false, reason: 'no-audio' };
  if (dataUrl.length > 120 * 1024 * 1024) return { ok: false, reason: 'too-large', detail: '音频超过 90MB 转写上限' };
  let blob = null;
  try {
    const comma = dataUrl.indexOf(',');
    const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : '';
    const mime = (header.match(/^data:([^;]+)/i) || [])[1] || 'audio/wav';
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: mime });
  } catch (e) { return { ok: false, reason: 'decode-media', detail: '音频数据无法读取' }; }
  if (!blob || !blob.size) return { ok: false, reason: 'empty-audio' };
  const base = String(endpoint || '').replace(/\/chat\/completions\/?$/i, '').replace(/\/audio\/transcriptions\/?$/i, '').replace(/\/+$/, '');
  const transcribeUrl = base ? base + '/audio/transcriptions' : 'https://api.siliconflow.cn/v1/audio/transcriptions';
  const form = new FormData();
  form.append('file', blob, 'audio.wav');
  form.append('model', String(model || 'FunAudioLLM/SenseVoiceSmall').trim() || 'FunAudioLLM/SenseVoiceSmall');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch(transcribeUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: 'http', detail: 'ASR HTTP ' + res.status + (raw ? '：' + raw.slice(0, 180) : '') };
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    const text = String((data && data.text) || (!data ? raw : '') || '').trim();
    return text ? { ok: true, text, model: String(model || 'FunAudioLLM/SenseVoiceSmall') } : { ok: false, reason: 'empty-asr' };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeTranscribedAudio(transcript, request) {
  const result = await aiChat({
    action: 'video',
    text: String(transcript || '').slice(0, 24000),
    title: request && request.title || '',
    url: request && request.url || '',
    summaryPrompt: request && request.prompt || ''
  });
  if (result && result.ok && result.text) return result;
  return { ok: false, reason: result && result.reason || 'summary-failed' };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlFromBytes(bytes, mime) {
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
}

async function fetchMediaBytes(url, timeoutMs, referer) {
  const target = String(url || '');
  if (!isPublicHttpUrl(target)) return { ok: false, reason: 'invalid-url' };
  const cached = mediaBytesCache.get(target);
  if (cached && Date.now() - cached.time < 120000) return Object.assign({}, cached, { cached: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Math.min(120000, Number(timeoutMs) || 60000)));
  try {
    const isDouyin = /(^|\.)douyin\.com|douyinvod/i.test(target);
    const isBilibili = /bilivideo|bilibili\.com/i.test(target);
    let res;
    try {
      res = await fetch(target, {
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal,
        referrer: referer || (isDouyin ? 'https://www.douyin.com/' : isBilibili ? 'https://www.bilibili.com/' : undefined),
        headers: isDouyin
          ? { 'Accept': '*/*', 'Range': 'bytes=0-' }
          : isBilibili ? { 'Accept': '*/*', 'Range': 'bytes=0-', 'Referer': referer || 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' } : { 'Accept': '*/*', 'Range': 'bytes=0-' }
      });
    } catch (referrerError) {
      if (!isDouyin && !isBilibili) throw referrerError;
      res = await fetch(target, {
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal,
        headers: isBilibili ? { 'Accept': '*/*', 'Range': 'bytes=0-', 'Referer': referer || 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com' } : { 'Accept': '*/*', 'Range': 'bytes=0-' }
      });
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status, detail: 'HTTP ' + res.status };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large', detail: '媒体超过 ' + Math.round(MEDIA_MAX_BYTES / 1024 / 1024) + 'MB' };
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large', detail: '媒体超过 ' + Math.round(MEDIA_MAX_BYTES / 1024 / 1024) + 'MB' };
    const mime = String(res.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream';
    const result = { ok: true, dataUrl: dataUrlFromBytes(new Uint8Array(buffer), mime), size: buffer.byteLength, mime };
    cacheMediaBytes(target, result);
    return result;
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'cors', detail: e && e.message ? String(e.message).slice(0, 200) : '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an HLS playlist into the concrete list of media segments.
 * Master playlists are followed to the best (largest bandwidth) variant so a
 * real download gets real quality instead of the audio rendition.
 */
/**
 * Resolve an MPEG-DASH manifest into concrete stream URLs.
 * DASH keeps video and audio apart, so the caller gets one entry per kind and
 * saves them as two files (a browser cannot mux them; ffmpeg-based tools do).
 */
async function resolveDashManifest(url) {
  const parser = (typeof self !== 'undefined' && self.LinkDragHls) || (typeof LinkDragHls !== 'undefined' ? LinkDragHls : null);
  const target = String(url || '');
  if (!isPublicHttpUrl(target)) return { ok: false, reason: 'invalid-url' };
  if (!parser || typeof parser.parseDash !== 'function') return { ok: false, reason: 'no-parser' };
  let text = '';
  try {
    const res = await fetch(target, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', detail: '清单 HTTP ' + res.status };
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: 'cors', detail: '清单跨域读取失败' };
  }
  const parsed = parser.parseDash(text, target);
  if (!parsed.ok) return { ok: false, reason: parsed.reason || 'invalid-mpd', detail: '无法解析 DASH 清单' };
  const describe = entry => entry && entry.best ? {
    url: entry.best.url,
    height: entry.best.height,
    width: entry.best.width,
    bandwidth: entry.best.bandwidth,
    mimeType: entry.mimeType
  } : null;
  return { ok: true, video: describe(parsed.video), audio: describe(parsed.audio), target };
}

async function resolveHlsSegments(url, depth) {
  const parser = (typeof self !== 'undefined' && self.LinkDragHls) || (typeof LinkDragHls !== 'undefined' ? LinkDragHls : null);
  const target = String(url || '');
  if (!isPublicHttpUrl(target)) return { ok: false, reason: 'invalid-url' };
  if (!parser) return { ok: false, reason: 'no-parser', detail: 'HLS 解析器未加载' };
  if ((Number(depth) || 0) >= 3) return { ok: false, reason: 'invalid-hls', detail: 'HLS 播放列表嵌套过深' };
  let playlist = '';
  try {
    const res = await fetch(target, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', detail: '播放列表 HTTP ' + res.status };
    playlist = await res.text();
  } catch (e) {
    return { ok: false, reason: 'cors', detail: '播放列表跨域读取失败' };
  }
  const parsed = parser.parse(playlist, target);
  if (!parsed.ok) return { ok: false, reason: parsed.reason || 'invalid-hls', detail: parsed.reason === 'empty-hls' ? '播放列表里没有可用内容' : '不是有效的 M3U8 播放列表' };
  if (parsed.kind === 'master') {
    // Follow the best variant so the download gets real quality.
    const best = parser.bestVariant(parsed);
    if (!best) return { ok: false, reason: 'empty-hls', detail: '主播放列表没有可用的码率' };
    return resolveHlsSegments(best, (Number(depth) || 0) + 1);
  }
  return {
    ok: true,
    segments: parsed.segments,
    count: parsed.segments.length,
    duration: parsed.duration,
    encrypted: parsed.encrypted,
    keyMethod: parsed.keyMethod,
    live: parsed.live,
    target
  };
}

async function fetchHlsDataUrl(url, depth) {
  const target = String(url || '');
  if (!isPublicHttpUrl(target)) return { ok: false, reason: 'invalid-url' };
  let playlist = '';
  try {
    const res = await fetch(target, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: 'http', detail: '播放列表 HTTP ' + res.status };
    playlist = await res.text();
  } catch (e) { return { ok: false, reason: 'cors', detail: '播放列表跨域读取失败' }; }
  if (!/#EXTM3U/i.test(playlist)) return { ok: false, reason: 'invalid-hls', detail: '不是有效的 M3U8 播放列表' };
  if (/#EXT-X-KEY:METHOD=AES-128/i.test(playlist)) return { ok: false, reason: 'encrypted', detail: 'HLS 使用 AES-128 加密，无法在浏览器内解密' };
  const lines = playlist.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Master playlists point at variant playlists, not media segments.  Pick an
  // audio rendition when available, otherwise the first variant.
  if (/#EXT-X-STREAM-INF/i.test(playlist) || /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(playlist)) {
    let variant = '';
    const audio = playlist.match(/#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*URI="([^"]+)"/i);
    if (audio) variant = audio[1];
    if (!variant) {
      for (let i = 0; i < lines.length - 1; i++) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
        const next = lines.slice(i + 1).find(line => !line.startsWith('#'));
        if (next) { variant = next; break; }
      }
    }
    if (!variant) return { ok: false, reason: 'empty-hls', detail: '主播放列表没有可用的码率或音轨' };
    const variantUrl = new URL(variant, target).toString();
    if (!isPublicHttpUrl(variantUrl)) return { ok: false, reason: 'invalid-url' };
    if ((Number(depth) || 0) >= 2) return { ok: false, reason: 'invalid-hls', detail: 'HLS 播放列表嵌套过深' };
    return fetchHlsDataUrl(variantUrl, (Number(depth) || 0) + 1);
  }
  const segmentUrls = [];
  let initUrl = '';
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const match = line.match(/URI="([^"]+)"/i);
      if (match) initUrl = new URL(match[1], target).toString();
    } else if (!line.startsWith('#')) {
      segmentUrls.push(new URL(line, target).toString());
    }
  }
  if (!segmentUrls.length) return { ok: false, reason: 'empty-hls', detail: '播放列表没有媒体分片' };
  if (segmentUrls.every(url => /\.ts(?:$|\?)/i.test(url))) {
    return { ok: false, reason: 'unsupported-container', detail: 'HLS 使用 MPEG-TS 分片，浏览器需要先转封装为 MP4 才能解码' };
  }
  const all = [];
  let total = 0;
  const ordered = initUrl ? [initUrl].concat(segmentUrls) : segmentUrls;
  for (const segment of ordered) {
    if (!isPublicHttpUrl(segment)) return { ok: false, reason: 'invalid-url', detail: '播放列表包含本机或内网地址' };
    try {
      const res = await fetch(segment, { credentials: 'include', redirect: 'follow' });
      if (!res.ok) return { ok: false, reason: 'http', detail: '分片 HTTP ' + res.status };
      const buf = await res.arrayBuffer();
      total += buf.byteLength;
      if (total > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large', detail: 'HLS 媒体超过 ' + Math.round(MEDIA_MAX_BYTES / 1024 / 1024) + 'MB' };
      all.push(new Uint8Array(buf));
    } catch (e) { return { ok: false, reason: 'cors', detail: '分片下载失败：' + (e && e.message ? String(e.message).slice(0, 120) : '跨域或网络错误') }; }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of all) { merged.set(part, offset); offset += part.length; }
  const mime = /\.m4s?(?:$|\?)/i.test(segmentUrls[0]) ? 'video/mp4' : 'video/mp2t';
  return { ok: true, dataUrl: dataUrlFromBytes(merged, mime), size: total, mime, segments: segmentUrls.length };
}

function collectDouyinApiUrls(value, out, depth) {
  if (!value || depth > 12 || out.length >= 24) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDouyinApiUrls(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^play_addr(?:_h264|_h265|_bytevc1|_264|_265)?$/i.test(key) || key === 'play_url') {
      const list = child && Array.isArray(child.url_list) ? child.url_list : [];
      for (const url of list.concat(child && typeof child === 'object' ? [child.url] : [child])) {
        if (typeof url === 'string' && /^https?:\/\//i.test(url) && !out.some(item => item.url === url)) {
          out.push({
            url,
            height: Number(child && child.height) || Number(value.height) || 0,
            width: Number(child && child.width) || Number(value.width) || 0
          });
        }
      }
    }
    collectDouyinApiUrls(child, out, depth + 1);
  }
}

// `bit_rate_audio[].audio_meta.url_list` is an object (main_url/backup_url/
// fallback_url), not the usual `url_list` array.  The old walker only read
// arrays, so the clean audio-only DASH track was always missed and the plugin
// downloaded a much larger muxed MP4 just to extract its AAC track.
function collectDouyinApiAudioUrls(value, out, depth) {
  if (!value || depth > 12 || out.length >= 8) return;
  const add = raw => {
    const url = String(raw || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  };
  if (typeof value === 'string') { add(value); return; }
  if (Array.isArray(value)) {
    for (const item of value) collectDouyinApiAudioUrls(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (value.audio_meta) collectDouyinApiAudioUrls(value.audio_meta, out, depth + 1);
  if (value.url_list) {
    if (Array.isArray(value.url_list)) collectDouyinApiAudioUrls(value.url_list, out, depth + 1);
    else collectDouyinApiAudioUrls(value.url_list, out, depth + 1);
  }
  for (const key of ['main_url', 'backup_url', 'fallback_url', 'url', 'play_url', 'play_addr']) {
    if (value[key]) collectDouyinApiAudioUrls(value[key], out, depth + 1);
  }
}

function douyinResultFromDetail(detail) {
  if (!detail || !detail.video) return null;
  const video = detail.video;
  const videos = [];
  const audios = [];
  collectDouyinApiUrls(video.bit_rate || [], videos, 0);
  collectDouyinApiUrls(video, videos, 0);
  collectDouyinApiAudioUrls(video.bit_rate_audio || [], audios, 0);
  collectDouyinApiAudioUrls(video.audio || {}, audios, 0);
  videos.sort((a, b) => (b.height || 0) - (a.height || 0));
  const urls = videos.map(item => item.url);
  if (!urls.length && !audios.length) return null;
  return {
    ok: true,
    url: urls[0] || audios[0] || '',
    urls,
    video: urls,
    audio: audios,
    audioUrls: audios,
    title: String(detail.desc || '').trim(),
    videoId: String(detail.aweme_id || ''),
    duration: Math.round((Number(video.duration) || 0) / 1000)
  };
}

async function resolveDouyinApi(videoId) {
  const apiUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(videoId)
    + '&aid=6383&channel=channel_pc_web&detail_list=1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let res;
  try {
    res = await fetch(apiUrl, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.douyin.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });
  } catch (e) { clearTimeout(timer); return null; }
  clearTimeout(timer);
  if (!res.ok) return null;
  let data = null;
  try { data = await res.json(); } catch (e) { return null; }
  const detail = data && (data.aweme_detail || (Array.isArray(data.aweme_detail_list) ? data.aweme_detail_list[0] : null));
  if (!detail || !detail.video) return null;
  const result = douyinResultFromDetail(detail);
  if (result && !result.videoId) result.videoId = String(videoId);
  return result;
}

async function resolveDouyinItemInfo(videoId) {
  const id = String(videoId || '');
  if (!/^\d{10,}$/.test(id)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${encodeURIComponent(id)}`, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Referer': 'https://www.iesdouyin.com/',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data && Array.isArray(data.item_list) ? data.item_list[0] : null;
    if (!item || !item.video) return null;
    const result = douyinResultFromDetail(item);
    if (!result) return null;
    if (!result.videoId) result.videoId = String(id);
    return result;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveKuaishou(input) {
  const source = String(input || '').trim();
  if (!/^https?:\/\//i.test(source)) return { ok: false, reason: 'invalid-url' };
  try {
    let videoId = (source.match(/\/short-video\/([^?&#/]+)/i) || [])[1] || '';
    const shortCode = (source.match(/\/f\/([^?&#/]+)/i) || [])[1] || '';
    if (!videoId && shortCode) {
      const redirect = await fetch('https://www.kuaishou.com/f/' + encodeURIComponent(shortCode), {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      });
      videoId = ((redirect.url || '').match(/\/short-video\/([^?&#/]+)/i) || [])[1] || '';
    }
    if (!videoId) return { ok: false, reason: 'invalid-url', detail: '无法识别快手视频 ID' };
    const query = 'query VisionVideoDetail($photoId: String!) { visionVideoDetail(photoId: $photoId) { status photo { id duration caption coverUrl photoUrl photoH265Url manifest { adaptationSet { representation { url width height avgBitrate size } } } } } }';
    const res = await fetch('https://www.kuaishou.com/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.kuaishou.com/'
      },
      body: JSON.stringify({ operationName: 'VisionVideoDetail', variables: { photoId: videoId }, query })
    });
    if (!res.ok) return { ok: false, reason: 'http', detail: '快手 HTTP ' + res.status };
    const data = await res.json();
    const photo = data && data.data && data.data.visionVideoDetail && data.data.visionVideoDetail.photo;
    if (!photo) return { ok: false, reason: 'no-media', detail: '快手没有返回视频数据' };
    const urls = [];
    const sets = photo.manifest && photo.manifest.adaptationSet;
    for (const set of Array.isArray(sets) ? sets : (sets ? [sets] : [])) {
      for (const rep of (set && set.representation) || []) {
        if (rep && /^https?:\/\//i.test(String(rep.url || ''))) urls.push({ url: rep.url, height: Number(rep.height) || 0 });
      }
    }
    for (const raw of [photo.photoUrl, photo.photoH265Url]) {
      if (/^https?:\/\//i.test(String(raw || ''))) urls.push({ url: raw, height: 0 });
    }
    urls.sort((a, b) => (b.height || 0) - (a.height || 0));
    if (!urls.length) return { ok: false, reason: 'no-media', detail: '快手没有可下载的视频地址' };
    return { ok: true, url: urls[0].url, title: String(photo.caption || '').trim(), duration: Math.round((Number(photo.duration) || 0) / 1000) };
  } catch (e) {
    return { ok: false, reason: 'network', detail: e && e.message ? String(e.message).slice(0, 180) : '' };
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1000, Number(timeoutMs) || 20000));
    const listener = (id, info) => { if (id === tabId && info && info.status === 'complete') finish(); };
    try { chrome.tabs.onUpdated.addListener(listener); } catch (e) { finish(); return; }
    try {
      chrome.tabs.get(tabId).then(tab => { if (tab && tab.status === 'complete') finish(); }, finish);
    } catch (e) { finish(); }
  });
}

async function resolveDouyinDetailInTab(tabId, videoId, attempts) {
  const id = String(videoId || '');
  let last = null;
  for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 3); attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async awemeId => {
          const query = new URLSearchParams({
            aweme_id: awemeId,
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
            pc_client_type: '1',
            version_code: '290100',
            version_name: '29.1.0',
            browser_language: 'zh-CN',
            browser_platform: 'Win32',
            browser_name: 'Edge',
            browser_version: '131.0.0.0'
          });
          try {
            const response = await fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?' + query.toString(), {
              credentials: 'include',
              headers: { 'Accept': 'application/json, text/plain, */*' }
            });
            const text = await response.text();
            if (!response.ok || /^\s*Blocked by/i.test(text)) {
              return { ok: false, reason: 'http', detail: '抖音详情 HTTP ' + response.status + (text ? '：' + text.slice(0, 120) : '') };
            }
            const data = JSON.parse(text);
            const detail = data && data.aweme_detail;
            return detail ? { ok: true, detail } : { ok: false, reason: 'no-media', detail: '抖音详情没有返回 aweme_detail' };
          } catch (error) {
            return { ok: false, reason: 'network', detail: String(error && error.message || error).slice(0, 180) };
          }
        },
        args: [id]
      });
      const result = results && results[0] && results[0].result;
      if (result && result.ok && result.detail) {
        const parsed = douyinResultFromDetail(result.detail);
        if (parsed) return parsed;
      }
      last = result || last;
    } catch (e) {
      last = { ok: false, reason: 'inject', detail: String(e && e.message || e).slice(0, 180) };
    }
    if (attempt < Math.max(1, Number(attempts) || 3) - 1) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return last;
}

// The detail endpoint requires first-party Douyin cookies (`UIFID` is
// SameSite=Lax), so an extension-origin fetch gets 403 even though the URL is
// public.  Use an already-open Douyin tab when possible; otherwise a
// short-lived inactive tab makes the request and is closed in `finally`.
async function resolveDouyinViaTab(videoId) {
  const id = String(videoId || '');
  if (!/^\d{10,}$/.test(id) || !chrome.tabs || !chrome.tabs.create || !chrome.scripting) return null;
  let created = null;
  try {
    let existing = [];
    try {
      existing = await chrome.tabs.query({ url: ['https://*.douyin.com/*', 'http://*.douyin.com/*'] });
    } catch (e) { existing = []; }
    for (const tab of (existing || []).filter(tab => tab && tab.id && tab.status === 'complete').slice(0, 3)) {
      const result = await resolveDouyinDetailInTab(tab.id, id, 2);
      if (result && result.ok) return result;
    }
    created = await chrome.tabs.create({ url: 'https://www.douyin.com/video/' + id, active: false });
    if (!created || !created.id) return null;
    await waitForTabComplete(created.id, 22000);
    return (await resolveDouyinDetailInTab(created.id, id, 3)) || { ok: false, reason: 'no-media', detail: '抖音页面没有返回视频数据' };
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message || e).slice(0, 180) };
  } finally {
    if (created && created.id) {
      try { chrome.tabs.remove(created.id); } catch (e) { /* ignore */ }
    }
  }
}

async function resolveDouyinShare(input) {
  const source = String(input || '').trim();
  if (!/^https?:\/\//i.test(source)) return { ok: false, reason: 'invalid-url' };
  const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  let apiTried = false;
  try {
    const directId = source.match(/\/(?:video|note)\/(\d+)/i);
    if (directId) {
      apiTried = true;
      try {
        const apiResult = await resolveDouyinApi(directId[1]);
        if (apiResult && apiResult.url) return apiResult;
      } catch (e) { /* fall through */ }
      try {
        const itemResult = await resolveDouyinItemInfo(directId[1]);
        if (itemResult && itemResult.url) return itemResult;
      } catch (e) { /* fall through */ }
    }
    const shortRes = await fetch(source, { redirect: 'follow', headers: { 'User-Agent': mobileUA } });
    const finalUrl = shortRes.url || source;
    const idMatch = finalUrl.match(/\/(?:video|note)\/(\d+)/i) || source.match(/\/(?:video|note)\/(\d+)/i);
    if (!idMatch) return { ok: false, reason: 'invalid-url', detail: '无法从分享链接识别视频 ID' };
    // Direct detail API first: it returns the complete play_addr / bit_rate
    // list, including the audio-bearing MP4, without needing a share page.
    if (!apiTried) {
      try {
        const apiResult = await resolveDouyinApi(idMatch[1]);
        if (apiResult && apiResult.url) return apiResult;
      } catch (e) { /* share-page fallback below */ }
      try {
        const itemResult = await resolveDouyinItemInfo(idMatch[1]);
        if (itemResult && itemResult.url) return itemResult;
      } catch (e) { /* share-page fallback below */ }
    }
    // The mobile share page used to embed the complete `videoInfoRes`; current
    // builds only ship layout metadata, so this is a compatibility path rather
    // than the primary resolver.
    let shareFailure = null;
    try {
      const pageUrl = 'https://www.iesdouyin.com/share/video/' + idMatch[1];
      const res = await fetch(pageUrl, { redirect: 'follow', headers: { 'User-Agent': mobileUA, Referer: 'https://www.iesdouyin.com/' } });
      if (!res.ok) throw new Error('抖音分享页 HTTP ' + res.status);
      const html = await res.text();
      const marker = html.indexOf('window._ROUTER_DATA');
      const start = marker >= 0 ? html.indexOf('{', marker) : -1;
      if (start < 0) throw new Error('未找到 _ROUTER_DATA');
      let depth = 0, quote = '', escaped = false, end = -1;
      for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) throw new Error('抖音页面数据不完整');
      const data = JSON.parse(html.slice(start, end));
      const loader = data && data.loaderData || {};
      const page = loader['video_(id)/page'] || loader['note_(id)/page'] || Object.values(loader).find(value => value && value.videoInfoRes);
      const info = page && page.videoInfoRes;
      const item = info && Array.isArray(info.item_list) ? info.item_list[0] : null;
      const play = item && item.video && item.video.play_addr && Array.isArray(item.video.play_addr.url_list) ? item.video.play_addr.url_list : [];
      const url = play.find(value => /^https?:\/\//i.test(String(value || ''))) || '';
      if (!url) throw new Error('抖音页面没有 play_addr 地址');
      return { ok: true, url: url.replace(/playwm/g, 'play'), urls: [url.replace(/playwm/g, 'play')], audio: [], title: String(item.desc || '').trim(), videoId: idMatch[1], duration: Math.round((Number(item.video.duration) || 0) / 1000) };
    } catch (e) {
      shareFailure = e;
    }
    // The share page no longer contains play_addr.  Fetch the detail from a
    // first-party tab so SameSite cookies and page context are present.
    const viaTab = await resolveDouyinViaTab(idMatch[1]);
    if (viaTab && viaTab.ok) return viaTab;
    return {
      ok: false,
      reason: (viaTab && viaTab.reason) || 'no-media',
      detail: (viaTab && viaTab.detail) || (shareFailure && shareFailure.message) || '抖音没有返回视频地址'
    };
  } catch (e) {
    return { ok: false, reason: 'network', detail: e && e.message ? String(e.message).slice(0, 180) : '' };
  }
}

let offscreenPromise = null;
async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    try {
      const contexts = chrome.runtime.getContexts
        ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
        : [];
      if (!contexts || !contexts.length) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS'],
          justification: 'Decode and transcribe long media audio in a DOM-capable offscreen document.'
        });
      }
      // createDocument() resolves before offscreen.js has registered its
      // message listener; posting immediately produced "no response" and the
      // download looked broken.  Wait until the context exists, then one tick.
      if (chrome.runtime.getContexts) {
        for (let i = 0; i < 12; i += 1) {
          const live = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
          if (live && live.length) break;
          await new Promise(resolve => setTimeout(resolve, 120));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 180));
      return true;
    } catch (e) {
      return false;
    } finally {
      setTimeout(() => { offscreenPromise = null; }, 1200);
    }
  })();
  return offscreenPromise;
}

async function transcribeRemoteAudio(request) {
  const ready = await ensureOffscreen();
  if (!ready) return { ok: false, reason: 'offscreen-unavailable', detail: '浏览器不支持离线音频解码' };
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ target: 'ldp-offscreen', type: 'transcribe', request }, response => {
        try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
        resolve(response || { ok: false, reason: 'network', detail: '离线音频转写没有返回' });
      });
    } catch (e) {
      resolve({ ok: false, reason: 'network', detail: e && e.message ? e.message : '离线音频转写失败' });
    }
  });
}

async function resolveBilibiliAudio(input) {
  const source = String(input || '');
  const match = source.match(/\/video\/(BV[0-9A-Za-z]+)/i) || source.match(/\b(BV[0-9A-Za-z]+)\b/);
  if (!match) return { ok: false, reason: 'invalid-url' };
  const bvid = match[1];
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36', Referer: 'https://www.bilibili.com/' };
  let pageNo = 1;
  try { pageNo = Math.max(1, Number(new URL(source, 'https://www.bilibili.com').searchParams.get('p')) || 1); } catch (e) { pageNo = 1; }
  try {
    const viewRes = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { headers, credentials: 'include' });
    const view = await viewRes.json();
    const pages = view && view.data && Array.isArray(view.data.pages) ? view.data.pages : [];
    const cid = (pages[pageNo - 1] && pages[pageNo - 1].cid) || (view && view.data && view.data.cid) || (pages[0] && pages[0].cid);
    if (!cid) return { ok: false, reason: 'no-cid' };
    const playRes = await fetch('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid) + '&fnval=4048&fnver=0&fourk=1', { headers, credentials: 'include' });
    const play = await playRes.json();
    const audioList = play && play.data && play.data.dash && Array.isArray(play.data.dash.audio) ? play.data.dash.audio.slice() : [];
    const audio = audioList.sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0] || null;
    const url = audio ? String(audio.baseUrl || audio.base_url || '') : '';
    if (!url) return { ok: false, reason: 'no-audio' };
    return { ok: true, url, cid, bvid };
  } catch (e) {
    return { ok: false, reason: 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  }
}

// Bilibili's DASH streams are separate video/audio `.m4s` files; a browser
// cannot save them as one playable MP4 without remuxing.  The `platform=html5`
// progressive endpoint returns a single muxed MP4 (`durl`), which is exactly
// what "download video" should save.  Quality is capped by the account level,
// which is why it is asked with the highest commonly allowed qn.
async function resolveBilibiliVideo(input) {
  const source = String(input || '');
  const match = source.match(/\/video\/(BV[0-9A-Za-z]+)/i) || source.match(/\b(BV[0-9A-Za-z]+)\b/);
  if (!match) return { ok: false, reason: 'invalid-url' };
  const bvid = match[1];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*'
  };
  let pageNo = 1;
  try { pageNo = Math.max(1, Number(new URL(source, 'https://www.bilibili.com').searchParams.get('p')) || 1); } catch (e) { pageNo = 1; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const viewRes = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), {
      headers, credentials: 'include', signal: controller.signal
    });
    const view = await viewRes.json();
    const data = view && view.data;
    if (!data) return { ok: false, reason: 'no-video', detail: view && view.message ? String(view.message) : 'B 站视频信息接口没有返回 data' };
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const page = pages[pageNo - 1] || pages[0] || null;
    const cid = (page && page.cid) || data.cid;
    if (!cid) return { ok: false, reason: 'no-cid' };
    const queries = [
      'platform=html5&high_quality=1&fnval=1&fnver=0&fourk=1&qn=116&bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid),
      'platform=html5&high_quality=1&fnval=0&fnver=0&fourk=1&qn=80&bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid)
    ];
    for (const query of queries) {
      let play = null;
      try {
        const playRes = await fetch('https://api.bilibili.com/x/player/playurl?' + query, {
          headers, credentials: 'include', signal: controller.signal
        });
        play = await playRes.json();
      } catch (e) { continue; }
      const list = play && play.data && Array.isArray(play.data.durl) ? play.data.durl : [];
      const entry = list.find(item => item && /^https?:\/\//i.test(String(item.url || '')));
      if (!entry) continue;
      const url = String(entry.url).replace(/\\u002F/gi, '/');
      const size = Number(entry.size) || 0;
      const duration = Number(entry.length) ? Number(entry.length) / 1000 : (Number(page && page.duration) || Number(data.duration) || 0);
      return {
        ok: true,
        url,
        urls: list.map(item => String(item && item.url || '')).filter(Boolean),
        quality: Number(play.data.quality) || 0,
        acceptQuality: Array.isArray(play.data.accept_quality) ? play.data.accept_quality : [],
        size,
        duration,
        title: String(data.title || '').trim(),
        bvid,
        cid,
        part: String(page && page.part || '').trim(),
        pages: pages.length
      };
    }
    return { ok: false, reason: 'no-media', detail: 'B 站没有返回渐进式 MP4（可能需要登录或该视频仅提供 DASH 流）' };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  } finally {
    clearTimeout(timer);
  }
}

async function mediaSummary(request) {
  if (request && request.payloadKey) {
    const payloadKey = String(request.payloadKey);
    const stored = await storageGet(payloadKey);
    const payload = stored && stored[payloadKey];
    if (payload && typeof payload === 'object') {
      Object.assign(request, payload);
      request.payloadKey = '';
      try { chrome.storage.local.remove(payloadKey); } catch (e) { /* ignore */ }
    }
  }
  const all = await storageGet(AI_CONFIG_KEY);
  const cfg = Object.assign({}, DEFAULT_AI_CONFIG, all[AI_CONFIG_KEY] && typeof all[AI_CONFIG_KEY] === 'object' ? all[AI_CONFIG_KEY] : {});
  const endpoint = normalizeUrl(cfg.mediaEndpoint || MEDIA_ENDPOINT);
  const key = String(cfg.mediaApiKey || (cfg.apiKeys && cfg.apiKeys.siliconflow) || (cfg.provider === 'siliconflow' ? cfg.apiKey : '') || '').trim();
  const mediaModel = String(cfg.mediaModel || MEDIA_ASR_MODEL).trim() || MEDIA_ASR_MODEL;
  if (!endpoint) return { ok: false, reason: 'missing-config', detail: '没有配置媒体接口地址' };
  if (!key) return { ok: false, reason: 'missing-key', detail: '请到设置 → AI 接口填写硅基流动 API Key' };
  const kind = request.kind === 'audio' ? 'audio' : 'video';
  if (kind === 'audio' && request.transcript) {
    const transcript = String(request.transcript || '').trim();
    if (!transcript) return { ok: false, reason: 'empty-asr', detail: '音频转写结果为空' };
    if (request.returnTranscript) return { ok: true, transcript, model: 'ASR', kind };
    const summarized = await summarizeTranscribedAudio(transcript, request);
    return summarized && summarized.ok
      ? { ok: true, text: summarized.text, model: 'ASR + ' + (summarized.model || 'AI'), kind, fallback: 'asr' }
      : { ok: true, text: transcript, model: 'ASR', kind, fallback: 'asr-raw' };
  }
  const audioChunks = Array.isArray(request.audioChunks)
    ? request.audioChunks.map(value => String(value || '')).filter(value => /^data:/i.test(value))
    : [];
  let dataUrl = String(request.dataUrl || '');
  if (!dataUrl && audioChunks.length) dataUrl = audioChunks[0];
  let mime = String(request.mime || '');
  if (!dataUrl && request.url) {
    const fetched = /\.m3u8(?:$|\?)/i.test(String(request.url))
      ? await fetchHlsDataUrl(request.url)
      : await fetchMediaBytes(request.url, 60000, request.referer);
    if (!fetched.ok) return fetched;
    dataUrl = fetched.dataUrl;
    mime = fetched.mime || mime;
  }
  if (!dataUrl || !/^data:/i.test(dataUrl)) return { ok: false, reason: 'no-media', detail: '没有可发送的媒体数据' };
  const prompt = String(request.prompt || '').trim() || (kind === 'audio'
    ? '你是专业的内容分析助手。请完成两件事：1) 完整转写这段音频的文字内容；2) 输出结构化总结，包含：核心主题、3–5 条关键要点、结论或行动项、值得注意的细节。若音频含多人对话，请标注说话人。请用中文回答。'
    : '你是专业的视频内容分析助手。请结合画面与音轨，输出：1) 视频内容概述（不超过 200 字）；2) 分时间点的关键节点（格式：[mm:ss] 内容）；3) 核心结论或要点；4) 画面中出现的文字/字幕原文。若画面与语音信息冲突，以语音为准。请用中文回答。');
  // Audio is uploaded to the ASR endpoint, not the text chat endpoint.
  if (kind === 'audio') {
    const chunks = audioChunks.length ? audioChunks : [dataUrl];
    const transcriptParts = new Array(chunks.length).fill('');
    const transcribeModel = mediaModel.includes('Omni') ? MEDIA_ASR_MODEL : mediaModel;
    // ASR chunks are independent.  Run them in parallel (bounded to 3) so a
    // 10-minute video does not serialize three separate uploads.
    const workers = Math.min(3, chunks.length);
    let nextChunk = 0;
    let asrFailure = null;
    const runChunk = async () => {
      while (!asrFailure) {
        const index = nextChunk++;
        if (index >= chunks.length) return;
        const asr = await transcribeMediaAudio(chunks[index], endpoint, key, transcribeModel);
        if (!asr.ok || !asr.text) {
          asrFailure = Object.assign({ chunk: index + 1, total: chunks.length }, asr || { reason: 'empty-asr' });
          return;
        }
        transcriptParts[index] = asr.text;
      }
    };
    await Promise.all(Array.from({ length: workers }, runChunk));
    if (!asrFailure && transcriptParts.length) {
      const transcript = transcriptParts.join('\n');
      if (request.returnTranscript) return { ok: true, transcript, model: 'ASR', kind, mime, size: dataUrl.length, fallback: 'asr' };
      const summarized = await summarizeTranscribedAudio(transcript, request);
      if (summarized && summarized.ok) {
        return { ok: true, text: summarized.text, model: 'ASR + ' + (summarized.model || 'AI'), kind, mime, size: dataUrl.length, fallback: 'asr' };
      }
      return { ok: true, text: transcript, model: 'ASR', kind, mime, size: dataUrl.length, fallback: 'asr-raw' };
    }
    return { ok: false, reason: 'asr', detail: '音频转写失败（第 ' + String(asrFailure && asrFailure.chunk || 1) + '/' + String(asrFailure && asrFailure.total || chunks.length) + ' 段，' + String(asrFailure && asrFailure.reason || 'unknown') + '）' + (asrFailure && asrFailure.detail ? '：' + asrFailure.detail : '') };
  }
  // A video must be converted to audio in the page before it reaches this
  // service.  Never send a video_url to Qwen: that path returns 50507 and
  // violates the audio-first contract.
  if (kind === 'video') {
    return { ok: false, reason: 'audio-required', detail: '视频必须先转为音频再总结；当前没有拿到可用音轨。' };
  }
  const chatEndpoint = /chat\/completions\/?$/i.test(endpoint)
    ? endpoint
    : endpoint.replace(/\/audio\/transcriptions\/?$/i, '').replace(/\/+$/, '') + '/chat/completions';
  const chatModel = /Omni/i.test(mediaModel) ? mediaModel : MEDIA_CHAT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const content = [{ type: 'text', text: prompt }];
    const mediaPart = {};
    mediaPart[kind + '_url'] = { url: dataUrl };
    content.push({ type: kind + '_url', [kind + '_url']: mediaPart[kind + '_url'] });
    const res = await fetch(chatEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: chatModel,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 2200,
        stream: false
      }),
      signal: controller.signal
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (!res.ok) {
      if (kind === 'audio' && (res.status >= 500 || /50507|unknown error/i.test(raw))) {
        const asr = await transcribeMediaAudio(dataUrl, endpoint, key, MEDIA_ASR_MODEL);
        if (asr && asr.ok && asr.text) {
          const summarized = await summarizeTranscribedAudio(asr.text, request);
          if (summarized && summarized.ok) {
            return { ok: true, text: summarized.text, model: 'SiliconFlow ASR + ' + (summarized.model || 'AI'), kind, mime, size: dataUrl.length, fallback: 'asr' };
          }
          return { ok: true, text: asr.text, model: 'SiliconFlow ASR', kind, mime, size: dataUrl.length, fallback: 'asr-raw' };
        }
      }
      return { ok: false, reason: 'http', detail: 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 300) : '') };
    }
    const text = responseText(data);
    if (!text) return { ok: false, reason: 'empty', detail: '接口没有返回可读总结' };
    return { ok: true, text, model: chatModel, kind, mime, size: dataUrl.length };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 200) : '' };
  } finally { clearTimeout(timer); }
}

async function fetchPage(url, timeoutMs) {  const target = normalizeUrl(url);
  if (!target) return { ok: false, reason: 'invalid', status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Math.min(30000, Number(timeoutMs) || 20000)));
  try {
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.7,*/*;q=0.5'
    };
    if (/bilibili\.com$/i.test(new URL(target).hostname)) headers.Referer = 'https://www.bilibili.com/';
    if (/(^|\.)youtube\.com$/i.test(new URL(target).hostname) || /(^|\.)youtu\.be$/i.test(new URL(target).hostname)) headers.Referer = 'https://www.youtube.com/';
    const res = await fetch(target, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
      headers
    });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FETCH_BYTES) {
      return { ok: false, reason: 'too-large', status: res.status, finalUrl: res.url || target };
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      return { ok: false, reason: 'too-large', status: res.status, finalUrl: res.url || target };
    }
    const contentType = res.headers.get('content-type') || '';
    const text = decodeHtmlBuffer(buffer, contentType);
    return {
      ok: true,
      status: res.status,
      text,
      finalUrl: res.url || target,
      contentType,
      byteLength: buffer.byteLength
    };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- */
/* AI page assistant (OpenAI-compatible, user-configured endpoint)             */
/* ------------------------------------------------------------------------- */

function aiPrompt(request) {
  const title = String(request.title || '').slice(0, 300);
  const url = String(request.url || '').slice(0, 1000);
  const text = String(request.text || '').slice(0, 22000);
  const action = String(request.action || 'summary');
  const sys = action === 'video'
    ? '你是 LinkDrag 的视频内容助手。只根据提供的视频字幕/转写文本回答，不要编造字幕没有的信息。用简体中文输出结构化 Markdown 笔记。'
    : action === 'followup'
      ? '你是 LinkDrag 的总结追问助手。基于给定的总结、原始内容和对话历史回答追问；总结里没写但原文有的细节要答出来，原文也没有就明确说“原文未说明”。用简体中文，回答简洁但完整，必要时用 Markdown 小标题或要点。'
      : '你是 LinkDrag 的网页阅读助手。只根据提供的网页正文回答，不要编造正文没有的信息。用简体中文回答，结构清晰，适合快速阅读。';
  let user = '';
  if (action === 'translate') {
    user = '请把下面网页正文翻译成简体中文，保留段落层级和专有名词。\n\n标题：' + title + '\n网址：' + url + '\n\n正文：\n' + text;
  } else if (action === 'ask') {
    user = '请根据下面网页正文回答问题。问题是：' + String(request.question || '').slice(0, 2000)
      + '\n\n标题：' + title + '\n网址：' + url + '\n\n正文：\n' + text;
  } else if (action === 'video') {
    const videoPrompt = String(request.summaryPrompt || '').trim() || `你是专业的视频内容分析师。我会提供一段视频的字幕或语音转录文本，请总结这个视频讲了什么。

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

字幕如下：`;
    user = videoPrompt + '\n\n【字幕原文开始】\n' + text + '\n【字幕原文结束】\n\n视频标题：' + title + '\n视频网址：' + url;
  } else if (action === 'followup') {
    // 追问：优先依据刚生成的总结回答，同时带上原始字幕/正文，
    // 这样「总结里没展开的细节」也能被回答，而不是被上下文截断。
    const summary = String(request.summary || '').slice(0, 12000);
    const question = String(request.question || '').slice(0, 4000);
    const history = Array.isArray(request.history) ? request.history.slice(-6) : [];
    const historyText = history
      .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
      .map(turn => (turn.role === 'user' ? '用户：' : '助手：') + String(turn.text || '').slice(0, 1200))
      .join('\n');
    user = '下面是这个' + (request.media ? '视频' : '网页') + '的已有总结，请在此基础上回答用户的追问。\n'
      + (summary ? '\n【已有总结】\n' + summary + '\n' : '')
      + (historyText ? '\n【此前的追问与回答】\n' + historyText + '\n' : '')
      + '\n【原始' + (request.media ? '字幕/转写' : '正文') + '（节选）】\n' + text + '\n'
      + '\n用户问题：' + question + '\n\n标题：' + title + '\n网址：' + url;
  } else {
    const summaryPrompt = String(request.summaryPrompt || '').trim();
    user = (summaryPrompt || '请总结下面网页正文的核心观点、关键事实和结论，控制在简洁的要点中。')
      + '\n\n标题：' + title + '\n网址：' + url + '\n\n正文：\n' + text;
  }
  return { system: sys, user };
}

function modelsUrl(endpoint) {
  try {
    const u = new URL(endpoint);
    u.pathname = u.pathname.replace(/\/chat\/completions\/?$/i, '/models').replace(/\/audio\/transcriptions\/?$/i, '/models');
    if (!/\/models\/?$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, '/models');
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (e) { return ''; }
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : (part && (part.text || part.content)) || '').join('');
  return '';
}

function responseText(data) {
  if (!data) return '';
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  let text = '';
  if (choice && choice.message) text = contentText(choice.message.content);
  if (!text && choice && typeof choice.text === 'string') text = choice.text;
  if (!text && typeof data.response === 'string') text = data.response;
  return String(text || '').trim();
}

function deltaText(data) {
  if (!data) return '';
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice && choice.delta) return contentText(choice.delta.content);
  if (choice && choice.message) return contentText(choice.message.content);
  if (choice && typeof choice.text === 'string') return choice.text;
  return '';
}

async function resolvedAIConfig() {
  const all = await storageGet(AI_CONFIG_KEY);
  const stored = all[AI_CONFIG_KEY] && typeof all[AI_CONFIG_KEY] === 'object' ? all[AI_CONFIG_KEY] : {};
  const cfg = Object.assign({}, DEFAULT_AI_CONFIG, stored);
  if (!cfg.apiKey && cfg.apiKeys && cfg.provider) cfg.apiKey = cfg.apiKeys[cfg.provider] || '';
  return cfg;
}

async function listModels(request) {
  const all = await storageGet(AI_CONFIG_KEY);
  const stored = all[AI_CONFIG_KEY] && typeof all[AI_CONFIG_KEY] === 'object' ? all[AI_CONFIG_KEY] : {};
  const cfg = Object.assign({}, DEFAULT_AI_CONFIG, stored);
  const endpoint = normalizeUrl(request.endpoint || cfg.endpoint);
  if (!endpoint) return { ok: false, reason: 'missing-config' };
  const key = String(request.apiKey || cfg.apiKey || (cfg.apiKeys && cfg.apiKeys[cfg.provider]) || '').trim();
  const url = modelsUrl(endpoint);
  if (!url) return { ok: false, reason: 'invalid-url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const headers = { 'Accept': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: 'http', detail: 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 220) : '') };
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    const bag = data && (Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : (data.data && Array.isArray(data.data.models) ? data.data.models : [])));
    const models = [];
    for (const item of bag || []) {
      const id = typeof item === 'string' ? item : (item && (item.id || item.name || item.model));
      if (id) models.push(String(id));
    }
    const unique = Array.from(new Set(models)).sort();
    return { ok: true, models: unique.slice(0, 300), endpoint: url };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function testAIConnection(request) {
  const endpoint = normalizeUrl(request.endpoint || DEFAULT_AI_CONFIG.endpoint);
  if (!endpoint) return { ok: false, reason: 'missing-config' };
  const key = String(request.apiKey || '').trim();
  if (!key && /api\.(?:deepseek|openai)\.com/i.test(endpoint)) return { ok: false, reason: 'missing-key' };
  const model = String(request.model || DEFAULT_AI_CONFIG.model).slice(0, 120);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '这是一次连接测试，请只回复 OK。' }],
        temperature: 0,
        max_tokens: 8,
        stream: false
      })
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: 'http', detail: 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 240) : '') };
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    const text = responseText(data);
    return { ok: true, elapsed: (Date.now() - started) / 1000, model, text: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 180) : '' };
  } finally {
    clearTimeout(timer);
  }
}

function makeSilentWav() {
  const sampleRate = 8000;
  const samples = 800;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

async function testMediaConnection(request) {
  const endpoint = normalizeUrl(request.endpoint || DEFAULT_AI_CONFIG.mediaEndpoint || MEDIA_ENDPOINT);
  if (!endpoint) return { ok: false, reason: 'missing-config' };
  const key = String(request.apiKey || '').trim();
  if (!key) return { ok: false, reason: 'missing-key' };
  const model = String(request.model || DEFAULT_AI_CONFIG.mediaModel || MEDIA_ASR_MODEL).trim();
  const asrBase = endpoint.replace(/\/chat\/completions\/?$/i, '').replace(/\/audio\/transcriptions\/?$/i, '').replace(/\/+$/, '');
  const asrUrl = asrBase ? asrBase + '/audio/transcriptions' : MEDIA_ENDPOINT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = Date.now();
  try {
    const form = new FormData();
    form.append('file', makeSilentWav(), 'test-audio.wav');
    form.append('model', /Omni/i.test(model) ? MEDIA_ASR_MODEL : (model || MEDIA_ASR_MODEL));
    const res = await fetch(asrUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) return { ok: false, reason: 'http', detail: 'ASR HTTP ' + res.status + (raw ? '：' + raw.slice(0, 200) : '') };
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    return { ok: true, elapsed: (Date.now() - started) / 1000, model, text: String((data && data.text) || (!data ? raw : '') || '').slice(0, 80) };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', detail: e && e.message ? String(e.message).slice(0, 160) : '' };
  } finally { clearTimeout(timer); }
}

async function streamAI(request, port) {
  const cfg = await resolvedAIConfig();
  const provider = String(request.provider || cfg.provider || '');
  const endpoint = normalizeUrl(request.endpoint !== undefined ? request.endpoint : cfg.endpoint);
  const key = String((cfg.apiKeys && provider && cfg.apiKeys[provider]) || (provider === cfg.provider ? cfg.apiKey : '') || '').trim();
  let timer = 0;
  let keepAliveTimer = 0;
  const stopTimers = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = 0; }
  };
  const fail = (reason, detail) => {
    stopTimers();
    try { aiStreamControllers.delete(port); port.postMessage({ type: 'error', reason, detail: detail || '' }); } catch (e) { /* disconnected */ }
  };
  if (!endpoint) { fail('missing-config'); return; }
  if (!key && /api\.(?:deepseek|openai)\.com/i.test(endpoint)) { fail('missing-key'); return; }
  const prompt = aiPrompt(request || {});
  const model = String(request.model || cfg.model || DEFAULT_AI_CONFIG.model).slice(0, 120);
  const controller = new AbortController();
  aiStreamControllers.set(port, controller);
  const started = Date.now();
  const startedAt = started;
  // The provider can pause for tens of seconds after a partial answer.  A
  // heartbeat keeps the MV3 worker and its message port alive during that gap.
  keepAliveTimer = setInterval(() => {
    try { port.postMessage({ type: 'ping', elapsed: (Date.now() - started) / 1000 }); } catch (e) { /* disconnected */ }
  }, 15000);
  const armTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 120000);
  };
  armTimer();
  let sent = false;
  let full = '';
  const sendDelta = text => {
    if (!text) return;
    full += text;
    sent = true;
    armTimer();
    try { port.postMessage({ type: 'delta', text, elapsed: (Date.now() - started) / 1000 }); } catch (e) { /* disconnected */ }
  };
  const finish = usage => {
    stopTimers();
    aiStreamControllers.delete(port);
    try { port.postMessage({ type: 'done', elapsed: (Date.now() - startedAt) / 1000, model, usage: usage || null, chars: full.length }); } catch (e) { /* disconnected */ }
  };
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        temperature: 0.2,
        max_tokens: 1400,
        stream: true
      })
    });
    if (!res.ok) {
      const raw = await res.text();
      stopTimers();
      fail('http', 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 240) : ''));
      return;
    }
    const ctype = String(res.headers.get('content-type') || '');
    if (!res.body || !/text\/event-stream/i.test(ctype)) {
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      const text = responseText(data);
      if (!text) { stopTimers(); fail('invalid-response', '接口没有返回可读文本'); return; }
      sendDelta(text);
      finish(data && data.usage);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    const handleLine = line => {
      const value = String(line || '').trim();
      if (!value.startsWith('data:')) return;
      const payload = value.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') return;
      let data = null;
      try { data = JSON.parse(payload); } catch (e) { return; }
      if (data && data.usage) usage = data.usage;
      sendDelta(deltaText(data));
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) handleLine(line);
    stopTimers();
    if (!sent) { fail('invalid-response', '接口没有返回可读文本'); return; }
    finish(usage);
  } catch (e) {
    stopTimers();
    if (e && e.name === 'AbortError') fail('timeout', '流式输出已 120 秒没有新内容');
    else fail('network', e && e.message ? String(e.message).slice(0, 180) : '');
  }
}

async function aiChat(request) {
  const cfg = await resolvedAIConfig();
  const provider = String(request.provider || cfg.provider || '');
  const endpoint = normalizeUrl(request.endpoint || cfg.endpoint);
  if (!endpoint) return { ok: false, reason: 'missing-config' };
  const key = String((cfg.apiKeys && provider && cfg.apiKeys[provider]) || (provider === cfg.provider ? cfg.apiKey : '') || '').trim();
  if (!key && /api\.(?:deepseek|openai)\.com/i.test(endpoint)) {
    return { ok: false, reason: 'missing-key' };
  }
  const prompt = aiPrompt(request || {});
  const model = String(request.model || cfg.model || DEFAULT_AI_CONFIG.model).slice(0, 120);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        temperature: 0.2,
        max_tokens: 1400,
        stream: false
      })
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, reason: 'http', detail: 'HTTP ' + res.status + (raw ? '：' + raw.slice(0, 240) : '') };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    let text = '';
    if (data) {
      const choice = Array.isArray(data.choices) ? data.choices[0] : null;
      if (choice && choice.message) {
        if (typeof choice.message.content === 'string') text = choice.message.content;
        else if (Array.isArray(choice.message.content)) {
          text = choice.message.content.map(part => typeof part === 'string' ? part : (part && part.text) || '').join('');
        }
      }
      if (!text && choice && typeof choice.text === 'string') text = choice.text;
      if (!text && typeof data.response === 'string') text = data.response;
    }
    text = String(text || '').trim();
    if (!text) return { ok: false, reason: 'invalid-response', detail: '接口没有返回可读文本' };
    return { ok: true, text: text.slice(0, 30000) };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- */
/* Messages                                                                   */
/* ------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.namespace !== NAMESPACE) return false;
  // Only this extension's own content scripts / pages may use the privileged
  // bridge.  This also keeps a compromised or spoofed sender from reaching
  // host-permission fetches and downloads.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const type = String(message.type || '');

  if (type === 'ldp:listModels') {
    listModels(message).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:testAI') {
    testAIConnection(message).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:testMediaAI') {
    testMediaConnection(message).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:getUpdateStatus') {
    readUpdateConfig().then(config => sendResponse(publicUpdateStatus(config)), () => sendResponse({ ok: false }));
    return true;
  }

  if (type === 'ldp:checkUpdate') {
    checkForUpdate(message.force === true, message.force === true).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:openUpdate') {
    openUpdateRelease().then(url => sendResponse({ ok: true, url }), () => sendResponse({ ok: false }));
    return true;
  }

  if (type === 'ldp:resolveDouyin') {
    resolveDouyinShare(message.url).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:resolveKuaishou') {
    resolveKuaishou(message.url).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:resolveBilibili') {
    resolveBilibiliAudio(message.url).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:resolveBilibiliVideo') {
    resolveBilibiliVideo(message.url).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:transcribeRemote') {
    transcribeRemoteAudio(message).then(sendResponse, () => sendResponse({ ok: false, reason: 'network' }));
    return true;
  }

  if (type === 'ldp:ai') {
    aiChat(message.request || {}).then(sendResponse, () => {
      sendResponse({ ok: false, reason: 'network' });
    });
    return true;
  }

  if (type === 'ldp:installMediaHook') {
    const tab = sender.tab;
    if (!tab || !Number.isInteger(tab.id)) { sendResponse({ ok: false, reason: 'no-tab' }); return false; }
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
    chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ['media_hook.js'],
      world: 'MAIN'
    }, () => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, reason: 'inject-failed', detail: err.message } : { ok: true });
    });
    return true;
  }

  if (type === 'ldp:mediaClear') {
    mediaBytesCache.clear();
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'downloadProgress' && message.target === 'ldp-background') {
    // Progress relayed from the offscreen document to the page that asked.
    try {
      if (lastDownloadTabId >= 0) {
        chrome.tabs.sendMessage(lastDownloadTabId, {
          type: 'ldp:downloadProgress',
          jobId: message.jobId,
          percent: message.percent,
          received: message.received,
          total: message.total
        }, () => { try { void chrome.runtime.lastError; } catch (e) { /* ignore */ } });
      }
    } catch (e) { /* ignore */ }
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'ldp:getCapturedMedia') {
    const tabId = sender && sender.tab && Number.isInteger(sender.tab.id)
      ? sender.tab.id
      : (Number.isInteger(message.tabId) ? message.tabId : -1);
    if (tabId < 0) { sendResponse({ ok: true, urls: [] }); return false; }
    loadCapturedMedia(tabId).then(urls => sendResponse({ ok: true, urls: urls || [] }),
      () => sendResponse({ ok: true, urls: [] }));
    return true;
  }

  if (type === 'ldp:proxyDownload') {
    // Preferred download path: read the file in the offscreen document (no CORS,
    // cookies included, real progress), then save through the downloads API.
    const url = String(message.url || '');
    if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, reason: 'invalid-url' }); return false; }
    const filename = String(message.filename || 'media-download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 140);
    const tabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : -1;
    lastDownloadTabId = tabId;
    const jobId = 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    (async () => {
      const ready = await ensureOffscreen();
      if (!ready) { sendResponse({ ok: false, reason: 'offscreen-unavailable', detail: '无法建立后台下载通道' }); return; }
      let result = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await new Promise(resolve => {
          try {
            chrome.runtime.sendMessage({
              target: 'ldp-offscreen',
              type: 'download',
              request: { url, jobId, referer: message.referer || '' }
            }, response => {
              try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
              resolve(response || null);
            });
          } catch (e) { resolve({ ok: false, reason: 'exception', detail: String(e && e.message || e) }); }
        });
        if (result && result.ok) break;
        if (result && result.reason === 'network') break;   // real network error, do not retry
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      result = result || { ok: false, reason: 'no-response', detail: '后台下载通道没有响应' };
      if (!result || !result.ok || !result.objectUrl) {
        sendResponse(result || { ok: false, reason: 'failed' });
        return;
      }
      try {
        chrome.downloads.download({ url: result.objectUrl, filename, saveAs: false }, id => {
          const error = chrome.runtime.lastError;
          // The blob URL stays alive inside the offscreen document; it is
          // revoked there on a timer so the download can finish reading it.
          try {
            chrome.runtime.sendMessage({ target: 'ldp-offscreen', type: 'revoke', url: result.objectUrl }, () => { try { void chrome.runtime.lastError; } catch (e) { /* ignore */ } });
          } catch (e) { /* ignore */ }
          if (id) sendResponse({ ok: true, id, size: result.size, mode: 'proxy', jobId, tabId });
          else sendResponse({ ok: false, reason: 'download-failed', detail: error && error.message ? String(error.message).slice(0, 160) : '' });
        });
      } catch (e) {
        sendResponse({ ok: false, reason: 'download-failed', detail: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (type === 'ldp:dashManifest') {
    resolveDashManifest(String(message.url || '')).then(sendResponse,
      err => sendResponse({ ok: false, reason: 'network', detail: String(err && err.message || err || '') }));
    return true;
  }

  if (type === 'ldp:hlsPlaylist') {
    const url = String(message.url || '');
    resolveHlsSegments(url).then(sendResponse, err => sendResponse({ ok: false, reason: 'network', detail: String(err && err.message || err || '') }));
    return true;
  }

  if (type === 'ldp:hlsSegment') {
    // CORS fallback: the service worker can read segments the page cannot.
    const url = String(message.url || '');
    if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, reason: 'invalid-url' }); return false; }
    fetch(url, { credentials: 'include', redirect: 'follow' })
      .then(async res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ ok: true, base64: btoa(binary), size: bytes.length });
      })
      .catch(err => sendResponse({ ok: false, reason: 'network', detail: String(err && err.message || err || '') }));
    return true;
  }

  if (type === 'ldp:downloadMedia') {
    const url = String(message.url || '');
    if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, reason: 'invalid-url' }); return false; }
    const filename = String(message.filename || 'media-download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    try {
      // Downloads initiated by the API are "other" requests.  The media DNR
      // rules add the first-party Referer for Douyin/Bilibili CDNs, which is
      // required or the CDN answers 403.  DownloadOptions.headers cannot be
      // used for Referer: Chromium rejects it as an unsafe request header.
      chrome.downloads.download({
        url,
        filename,
        saveAs: false
      }, id => {
        const error = chrome.runtime.lastError;
        if (id) { sendResponse({ ok: true, id }); return; }
        sendResponse({ ok: false, reason: 'download-failed', detail: error && error.message ? String(error.message).slice(0, 160) : '' });
      });
    } catch (e) {
      sendResponse({ ok: false, reason: 'download-failed', detail: e && e.message ? e.message : '' });
    }
    return true;
  }

  if (type === 'ldp:mediaBytes') {
    const source = String(message.url || '');
    const promise = /\.m3u8(?:$|\?)/i.test(source) ? fetchHlsDataUrl(source) : fetchMediaBytes(source, message.timeoutMs, message.referer);
    promise.then(sendResponse, () => sendResponse({ ok: false, reason: 'network', detail: '媒体读取失败' }));
    return true;
  }

  if (type === 'ldp:media') {
    mediaSummary(message).then(sendResponse, () => {
      sendResponse({ ok: false, reason: 'network', detail: '媒体请求失败' });
    });
    return true;
  }

  if (type === 'ldp:fetch') {
    fetchPage(message.url, message.timeoutMs).then(sendResponse, () => {
      sendResponse({ ok: false, reason: 'network', status: 0 });
    });
    return true;
  }

  if (type === 'ldp:openTab') {
    const target = normalizeUrl(message.url);
    if (!target) { sendResponse({ ok: false, reason: 'invalid-url' }); return false; }
    try {
      chrome.tabs.create({ url: target, active: message.active !== false }, tab => {
        const err = chrome.runtime.lastError;
        if (err || !tab || !Number.isInteger(tab.id)) {
          sendResponse({ ok: false, reason: 'open-failed', detail: err ? err.message : '' });
          return;
        }
        sendResponse({ ok: true, tabId: tab.id });
      });
    } catch (e) { sendResponse({ ok: false, reason: 'open-failed', detail: String(e && e.message || e) }); }
    return true;
  }

  if (type === 'ldp:ensureContent') {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : (sender.tab && sender.tab.id);
    ensureContent(tabId).then(ok => sendResponse({ ok, tabId }));
    return true;
  }

  if (type === 'ldp:getActiveTab') {
    queryActiveTab().then(tab => {
      sendResponse({
        ok: !!tab,
        tab: tab ? { id: tab.id, url: tab.url || '', title: tab.title || '', active: !!tab.active } : null
      });
    });
    return true;
  }

  if (type === 'ldp:openOptions') {
    try { chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); }
    catch (e) { sendResponse({ ok: false }); }
    return false;
  }

  if (type === 'ldp:badge') {
    if (sender.tab && Number.isInteger(sender.tab.id)) {
      updateBadge(sender.tab.id, message.count).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (type === 'ldp:flashBadge') {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : (sender.tab && sender.tab.id);
    flashBadge(tabId, message.text).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

/* ------------------------------------------------------------------------- */
/* Streaming AI port                                                          */
/* ------------------------------------------------------------------------- */

chrome.runtime.onConnect.addListener(port => {
  if (!port || port.name !== 'ldp-ai-stream') return;
  let started = false;
  port.onMessage.addListener(message => {
    if (!message || message.type !== 'start' || started) return;
    started = true;
    streamAI(message.request || {}, port);
  });
  port.onDisconnect.addListener(() => {
    const controller = aiStreamControllers.get(port);
    if (controller) {
      try { controller.abort(); } catch (e) { /* ignore */ }
      aiStreamControllers.delete(port);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Context menu clicks                                                        */
/* ------------------------------------------------------------------------- */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !Number.isInteger(tab.id)) return;
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
  if (info.menuItemId === 'ldp-preview-link') {
    if (isHttpUrl(info.linkUrl)) openPreviewInTab(tab.id, frameId, info.linkUrl, info.linkText || '');
    return;
  }
  if (info.menuItemId === 'ldp-preview-image') {
    if (isHttpUrl(info.srcUrl)) openImageInTab(tab.id, frameId, info.srcUrl, info.alt || info.title || '');
    return;
  }
  if (info.menuItemId === 'ldp-preview-selection') {
    const url = urlFromSelection(info.selectionText);
    if (url) openPreviewInTab(tab.id, frameId, url, '');
    else flashBadge(tab.id, '?');
    return;
  }
  if (info.menuItemId === 'ldp-open-settings') {
    openSettingsInTab(tab.id);
  }
});

/* ------------------------------------------------------------------------- */
/* Commands                                                                   */
/* ------------------------------------------------------------------------- */

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-site') return;
  const tab = await queryActiveTab();
  if (!tab || !Number.isInteger(tab.id)) return;
  if (!/^https?:|^file:/.test(String(tab.url || ''))) { flashBadge(tab.id, '!'); return; }
  const ready = await ensureContent(tab.id);
  if (!ready) { flashBadge(tab.id, '!'); return; }
  const res = await sendTabMessage(tab.id, { namespace: NAMESPACE, type: 'ldp:toggle-site' }, 0);
  if (!res.ok) flashBadge(tab.id, '!');
  else if (res.response && res.response.sitePaused) flashBadge(tab.id, 'P');
});

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* ------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  scheduleMenuRebuild();
  scheduleUpdateCheck('installed');
});

chrome.runtime.onStartup.addListener(() => {
  scheduleMenuRebuild();
  // The user asked for one check each time the browser starts.  GitHub API
  // throttling is avoided by the persisted lastCheck guard for worker restarts.
  scheduleUpdateCheck('startup');
});

if (chrome.notifications && chrome.notifications.onClicked) {
  const handleUpdateNotification = id => {
    if (!String(id || '').startsWith('linkdrag-update-')) return;
    try { chrome.notifications.clear(id); } catch (e) { /* ignore */ }
    openUpdateRelease();
  };
  chrome.notifications.onClicked.addListener(handleUpdateNotification);
  if (chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
      if (buttonIndex === 0) handleUpdateNotification(id);
    });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes[SETTINGS_KEY]) return;
  const oldValue = changes[SETTINGS_KEY].oldValue || {};
  const next = changes[SETTINGS_KEY].newValue || {};
  if (oldValue.contextMenu !== next.contextMenu) scheduleMenuRebuild();
  // If badge display was just disabled, clear every visible badge.
  if (oldValue.badgeCount !== next.badgeCount && next.badgeCount === false) {
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        if (Number.isInteger(tab.id)) {
          try { chrome.action.setBadgeText({ tabId: tab.id, text: '' }); } catch (e) { /* ignore */ }
        }
      }
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* ignore */ }
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* ignore */ }
});

// Create menus on worker startup as well.  onInstalled/onStartup do not fire
// when the service worker is woken by a message after the browser restarted.
scheduleMenuRebuild();
// Worker wake-up fallback: no network call if the six-hour guard is fresh.
scheduleUpdateCheck('worker');

