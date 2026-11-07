#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the extension content script from the v20.3.0 userscript source.

The userscript core is intentionally kept as close to the original as possible;
this script only applies the browser-extension compatibility layer, the new
extension settings, and the audited bug fixes.  Every replacement is asserted
so an upstream source change cannot silently produce a half-patched bundle.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "original.user.js"
OUT = ROOT / "extension" / "content.js"

text = SRC.read_text(encoding="utf-8")
original_text = text


def once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"[build] {label}: expected 1 match, got {count}")
    text = text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 0. Strip the userscript metadata block; keep the long design notes.
# ---------------------------------------------------------------------------
meta_start = text.index("// ==UserScript==")
meta_end = text.index("// ==/UserScript==") + len("// ==/UserScript==")
core = text[meta_end:].lstrip("\r\n")
text = core  # all subsequent patch helpers operate on the extracted core

# ---------------------------------------------------------------------------
# 1. Version / schema.
# ---------------------------------------------------------------------------
once("  const SCHEMA_VERSION = 190;", "  const SCHEMA_VERSION = 210;", "schema version")
old_version = """  const SCRIPT_VERSION = (() => {
    try {
      if (typeof GM_info === 'object' && GM_info && GM_info.script && GM_info.script.version) {
        return String(GM_info.script.version);
      }
    } catch (e) { /* 忽略 */ }
    return '20.3.0';
  })();"""
new_version = """  const SCRIPT_VERSION = (() => {
    try {
      if (typeof LPS_MANIFEST === 'object' && LPS_MANIFEST && LPS_MANIFEST.version) {
        return String(LPS_MANIFEST.version);
      }
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof GM_info === 'object' && GM_info && GM_info.script && GM_info.script.version) {
        return String(GM_info.script.version);
      }
    } catch (e) { /* 忽略 */ }
    return '1.9.41';
  })();"""
if text.count(old_version) != 1:
    raise SystemExit("[build] SCRIPT_VERSION block not found")
text = text.replace(old_version, new_version, 1)

# ---------------------------------------------------------------------------
# 2. New settings.  Everything is a scalar so the existing normalizer works.
# ---------------------------------------------------------------------------
once(
    "    showHelpOnce: true\n  };",
    "    showHelpOnce: true,\n"
    "    // v21 extension integration\n"
    "    enabled: true, disabledSites: '', contextMenu: true, badgeCount: true,\n"
    "    imageDragPreview: true\n"
    "  };",
    "extension defaults",
)

# ---------------------------------------------------------------------------
# 3. Extension-native tab opening / clipboard fallback.
# ---------------------------------------------------------------------------
old_open = """    openInTab(url) {
      try {
        if (HAS.gmTab) { GM_openInTab(url, { active: true, insert: true, setParent: true }); return true; }
      } catch (e) { /* 落到别的兜底 */ }
      if (EXT) {
        try { window.dispatchEvent(new window.CustomEvent('ldp-open-tab', { detail: { url } })); return true; }
        catch (e) { /* 继续兜底 */ }
      }
      try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.cssText = 'position:fixed;left:-9999px;top:0';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch (e) { /* 忽略 */ } }, 0);
        return true;
      } catch (e) { return false; }
    },
    copy(text) {
      const value = String(text == null ? '' : text);
      if (!value) return false;
      try { if (HAS.gmClip) { GM_setClipboard(value, 'text'); return true; } } catch (e) { /* 继续兜底 */ }
      try { if (HAS.clipApi) { navigator.clipboard.writeText(value).catch(() => {}); return true; } } catch (e) { /* 忽略 */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e) { return false; }
    }"""
new_open = """    openInTab(url, active) {
      const target = httpUrl(url);
      if (!target) return false;
      // v21: extension background owns tab creation.  This works even when the
      // page has a sandbox/CSP that blocks window.open, and it keeps the new tab
      // out of the host page's opener chain.
      if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
        try {
          EXT.runtime.sendMessage({
            namespace: 'LPS_EXT', type: 'ldp:openTab', url: target,
            active: active !== false
          }, () => { try { void EXT.runtime.lastError; } catch (e) { /* 忽略 */ } });
          return true;
        } catch (e) { /* 落到浏览器兜底 */ }
      }
      try { if (HAS.gmTab) { GM_openInTab(target, { active: active !== false, insert: true, setParent: true }); return true; } } catch (e) { /* 继续兜底 */ }
      try {
        const a = document.createElement('a');
        a.href = target;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.cssText = 'position:fixed;left:-9999px;top:0';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch (e) { /* 忽略 */ } }, 0);
        return true;
      } catch (e) { return false; }
    },
    copy(text) {
      const value = String(text == null ? '' : text);
      if (!value) return false;
      try { if (HAS.gmClip) { GM_setClipboard(value, 'text'); return true; } } catch (e) { /* 继续兜底 */ }
      // document.execCommand('copy') is synchronous, so it gives an honest
      // success/failure answer (the Clipboard API promise is intentionally
      // fire-and-forget).  Try it before the async API.
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        const prevFocus = document.activeElement;
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e2) { /* 忽略 */ }
        if (ok) return true;
      } catch (e) { /* 继续兜底 */ }
      try { if (HAS.clipApi) { navigator.clipboard.writeText(value).catch(() => {}); return true; } } catch (e) { /* 忽略 */ }
      return false;
    }"""
once(old_open, new_open, "T.openInTab/T.copy")

# ---------------------------------------------------------------------------
# 4. Storage init: always settle even when storage is unavailable.
# ---------------------------------------------------------------------------
old_store = """  if (HAS.extStore) {
    try {
      EXT.storage.local.get(null, all => {
        if (!all || typeof all !== 'object') return;
        for (const k of Object.keys(all)) extCache[k] = all[k];
        onExtStoreReady();
      });
    } catch (e) { /* 忽略 */ }
  }"""
new_store = """  if (HAS.extStore) {
    try {
      EXT.storage.local.get(null, all => {
        try { void EXT.runtime.lastError; } catch (e) { /* 忽略 */ }
        if (all && typeof all === 'object') {
          for (const k of Object.keys(all)) extCache[k] = all[k];
        }
        onExtStoreReady();
      });
    } catch (e) { onExtStoreReady(); }
  }"""
once(old_store, new_store, "async storage init")

# Legacy userscript storage is not present in a fresh extension profile.
# Calling GM_getValue here would be a ReferenceError (caught, but noisy).
once(
    "  function migrateLegacy() {\n    let done = true;",
    "  function migrateLegacy() {\n    if (HAS.extStore) return;   // extension uses chrome.storage, not GM_* legacy keys\n    let done = true;",
    "legacy migration guard",
)

# ---------------------------------------------------------------------------
# 5. Background fetch bridge (replaces GM_xmlhttpRequest).
# ---------------------------------------------------------------------------
old_fetch = """  function fetchPageText(url, onDone, onFail) {
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'text', timeout: 20000,
          onload: res => onDone(
            res && typeof res.responseText === 'string' ? res.responseText : '',
            res ? (Number(res.status) || 0) : 0
          ),
          onerror: () => onFail('network'),
          ontimeout: () => onFail('timeout')
        });
        return;
      } catch (e) { /* 落到 fetch */ }
    }
    try {
      fetch(url, { credentials: 'include' })
        .then(res => res.text().then(text => onDone(text || '', res.status || 0)))
        .catch(() => onFail('network'));
    } catch (e) { onFail('network'); }
  }"""
new_fetch = """  function fetchPageText(url, onDone, onFail) {
    const target = httpUrl(url);
    if (!target) { onFail('invalid'); return; }
    const fallback = () => {
      try {
        fetch(target, { credentials: 'include' })
          .then(res => res.text().then(text => onDone(text || '', res.status || 0, res.url || target)))
          .catch(() => onFail('network'));
      } catch (e) { onFail('network'); }
    };
    // v21: privileged fetch in the MV3 service worker.  Host permissions make
    // this independent of the page's CORS policy.  The worker returns the real
    // HTTP status and final (redirected) URL so the caller can diagnose 4xx/5xx
    // instead of rendering an empty error page as if it were content.
    if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
      let settled = false;
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: target, timeoutMs: 20000 }, res => {
          let lastError = null;
          try { lastError = EXT.runtime.lastError; } catch (e) { /* 忽略 */ }
          if (settled) return;
          settled = true;
          if (lastError || !res) { fallback(); return; }
          if (res.ok) onDone(res.text || '', Number(res.status) || 0, httpUrl(res.finalUrl) || target);
          else onFail(res.reason || 'network');
        });
        return;
      } catch (e) { /* 落到 fetch */ }
    }
    fallback();
  }"""
once(old_fetch, new_fetch, "fetchPageText bridge")

# ---------------------------------------------------------------------------
# 6. Keep originalUrl in sync with in-preview navigation.  Several features
#    (reader, snapshot, new-tab, reload) previously used a stale initial URL.
# ---------------------------------------------------------------------------
old_accept = """  function acceptInfo(item, data) {
    const url = httpUrl(data && data.url);
    if (!url) return false;
    if (item.url !== url) item.fallbackTitle = '';
    item.url = url;
    item.title = isStr(data.title) ? data.title.trim().slice(0, 500) : '';
    renderTitle(item);
    return true;
  }"""
new_accept = """  function acceptInfo(item, data) {
    const url = httpUrl(data && data.url);
    if (!url) return false;
    if (item.url !== url) item.fallbackTitle = '';
    item.url = url;
    // v21 bugfix: previews can navigate inside their iframe.  Keeping the
    // original URL forever made reader mode / snapshot / \"open in new tab\"
    // operate on the first page instead of the page the user is looking at.
    item.originalUrl = url;
    item.title = isStr(data.title) ? data.title.trim().slice(0, 500) : '';
    renderTitle(item);
    return true;
  }
  /** The real http(s) page currently represented by a preview item. */
  function currentPageUrl(item) {
    if (!item) return '';
    return httpUrl(item.url) || httpUrl(item.originalUrl) || '';
  }"""
once(old_accept, new_accept, "acceptInfo URL sync")

once(
    """    item.title = '';
    item.url = url;
    item.isReaderMode = false;""",
    """    item.title = '';
    item.url = url;
    if (httpUrl(url)) item.originalUrl = httpUrl(url);
    item.isReaderMode = false;""",
    "navigate URL sync",
)

old_snapshot = """  function renderSnapshot(item) {
    if (item.closed || item.isReaderMode || item.synthetic) return;
    toast(item, '该站点禁止被嵌入，正在抓取只读快照…');
    fetchPageText(item.originalUrl,
      (text, status) => {
        if (item.closed) return;
        if (status >= 400) {
          snapshotFailed(item, '该站点不光拒绝被嵌入，也拒绝被抓取（HTTP ' + status
            + '）—— 拿不到可用的快照。');
          return;
        }
        if (!text) { snapshotFailed(item); return; }
        const doc = snapshotDoc(text, item.originalUrl);
        if (!doc) { snapshotFailed(item); return; }
        try {
          doc.querySelectorAll('script,noscript').forEach(n => n.remove());
          absolutize(doc, item.originalUrl);
        } catch (e) { /* 清洗失败就按原样渲染，总比空白强 */ }
        const html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;"""
new_snapshot = """  function renderSnapshot(item) {
    if (item.closed || item.isReaderMode || item.synthetic) return;
    const pageUrl = currentPageUrl(item);
    if (!pageUrl) { snapshotFailed(item, '拿不到当前预览的有效网址，无法抓取快照。'); return; }
    toast(item, '该站点禁止被嵌入，正在抓取只读快照…');
    fetchPageText(pageUrl,
      (text, status, finalUrl) => {
        if (item.closed) return;
        if (status >= 400) {
          snapshotFailed(item, '该站点不光拒绝被嵌入，也拒绝被抓取（HTTP ' + status
            + '）—— 拿不到可用的快照。');
          return;
        }
        if (!text) { snapshotFailed(item); return; }
        const snapshotUrl = httpUrl(finalUrl) || pageUrl;
        const doc = snapshotDoc(text, snapshotUrl);
        if (!doc) { snapshotFailed(item); return; }
        try {
          doc.querySelectorAll('script,noscript').forEach(n => n.remove());
          absolutize(doc, snapshotUrl);
        } catch (e) { /* 清洗失败就按原样渲染，总比空白强 */ }
        item.url = snapshotUrl;
        item.originalUrl = snapshotUrl;
        const html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;"""
once(old_snapshot, new_snapshot, "renderSnapshot URL/redirect")

# Reader mode must use the current page URL, and its base href must match.
once(
    "      const built = readerBuild(item.readerSource, item.originalUrl, settings.readerHideImages);",
    "      const pageUrl = currentPageUrl(item) || item.originalUrl || location.href;\n"
    "      const built = readerBuild(item.readerSource, pageUrl, settings.readerHideImages);",
    "readerBuild base",
)
once(
    "<base href=\"${item.originalUrl.replace(/\"/g, '&quot;')}\">",
    "<base href=\"${(currentPageUrl(item) || item.originalUrl || location.href).replace(/\"/g, '&quot;')}\">",
    "reader base href",
)
old_reader_toggle = """    fetchPageText(item.originalUrl,
      text => {
        if (item.closed) return;
        item.readerSource = text || '';"""
new_reader_toggle = """    const pageUrl = currentPageUrl(item);
    if (!pageUrl) { item.ui.loader.hidden = true; item.preReaderRect = null; toast(item, '拿不到当前预览的有效网址'); return; }
    fetchPageText(pageUrl,
      (text, status, finalUrl) => {
        if (item.closed) return;
        if (status >= 400) {
          item.ui.loader.hidden = true;
          item.preReaderRect = null;
          toast(item, '抓取正文失败（HTTP ' + status + '）');
          return;
        }
        if (httpUrl(finalUrl)) { item.url = httpUrl(finalUrl); item.originalUrl = httpUrl(finalUrl); }
        item.readerSource = text || '';"""
once(old_reader_toggle, new_reader_toggle, "reader current URL/status")

# ---------------------------------------------------------------------------
# 7. Correct actions that previously fell back to the stale original URL.
# ---------------------------------------------------------------------------
once(
    "          navigate(item, httpUrl(result && result.url) || item.originalUrl);",
    "          navigate(item, httpUrl(result && result.url) || currentPageUrl(item));",
    "reload current URL",
)
old_open_tab = """      case 'openTab': {
        const tabUrl = item.originalUrl || item.url;
        if (tabUrl && !T.openInTab(tabUrl)) toast(item, '打开新标签页失败');
        break;
      }"""
new_open_tab = """      case 'openTab': {
        const tabUrl = currentPageUrl(item) || item.originalUrl || item.url;
        if (tabUrl && !T.openInTab(tabUrl)) toast(item, '打开新标签页失败');
        break;
      }"""
once(old_open_tab, new_open_tab, "openTab current URL")

# Toggle reader off should return to the current page, not necessarily the
# first URL used to open the window.
once(
    "      navigate(item, item.originalUrl);\n      toast(item, '已退出阅读模式');",
    "      navigate(item, currentPageUrl(item) || item.originalUrl);\n      toast(item, '已退出阅读模式');",
    "reader exit current URL",
)

# ---------------------------------------------------------------------------
# 8. maxWindows only counts real preview windows; settings/help windows should
#    never evict a real preview.
# ---------------------------------------------------------------------------
old_max = """    while (windows.length >= settings.maxWindows) {
      const oldest = windows.find(w => !w.pinned && !isEffPip(w)) || windows.find(w => !w.pinned);
      if (!oldest) break;
      closeWindow(oldest, true);
    }"""
new_max = """    if (!bare) {
      // v21 bugfix: bare settings/help windows used to count towards
      // maxWindows, so opening settings could silently evict a real preview.
      while (windows.filter(w => !w.closed && !w.bare).length >= settings.maxWindows) {
        const oldest = windows.find(w => !w.bare && !w.pinned && !isEffPip(w) && !w.summaryProtected && !(w.ui.win && w.ui.win.classList.contains('summary-window')))
          || windows.find(w => !w.bare && !w.pinned && !w.summaryProtected && !(w.ui.win && w.ui.win.classList.contains('summary-window')));
        if (!oldest) break;
        oldest.summaryCloseRequested = true;
        closeWindow(oldest, true);
      }
    }"""
if text.count(old_max) == 1:
    text = text.replace(old_max, new_max, 1)
elif "candidates = windows.filter(w => !w.closed" not in text:
    raise SystemExit("[build] maxWindows bare fix: expected 1 match, got 0")

# Block non-bare windows when the site/extension is disabled.  Bare settings
# and help windows remain available so the user can re-enable the extension.
once(
    "    const url = bare ? '' : httpUrl(value);\n    if (!bare && (!url || isBlacklisted(url))) return null;",
    "    const url = bare ? '' : httpUrl(value);\n    if (!bare && (!url || isBlacklisted(url))) return null;\n    if (!bare && !interactionEnabled()) return null;",
    "openWindow disabled guard",
)

# ---------------------------------------------------------------------------
# 9. Extension settings UI + help.
# ---------------------------------------------------------------------------
once(
    "    ['高级'],\n    ['shortcutsMap', '快捷键设置', 'text', null, '组合=动作，逗号分隔'],",
    "    ['扩展集成'],\n"
    "    ['enabled', '在网页中启用 Link Preview', 'checkbox'],\n"
    "    ['disabledSites', '暂停站点（逗号分隔）', 'text', null, '例如 example.com, news.site'],\n"
    "    ['contextMenu', '右键菜单「预览此链接」', 'checkbox'],\n"
    "    ['badgeCount', '工具栏图标显示窗口数', 'checkbox'],\n"
    "    ['extensionNote', '暂停站点会立即收起本站自动入口；设置/说明窗口仍可打开，便于重新启用', 'note'],\n"
    "    ['高级'],\n    ['shortcutsMap', '快捷键设置', 'text', null, '组合=动作，逗号分隔'],",
    "extension settings fields",
)
once(
    "      const wide = name === 'shortcutsMap';",
    "      const wide = name === 'shortcutsMap' || name === 'disabledSites';",
    "wide text field",
)

# Add a help section before the generic \"其它\" section.
old_help_anchor = "      ['其它', [\n"
new_help_section = """      ['浏览器扩展增强（v21）', [
        '工具栏图标弹出快捷面板：一键全局启用/停用、暂停当前站点、开关悬停小窗与链接按钮，并显示当前页已开预览数',
        '右键菜单：链接上右键可「用 Link Preview 预览此链接」；页面空白处右键可直接打开设置或使用说明，选中的网址也能预览',
        '浏览器命令 Alt+Shift+L：暂停 / 恢复当前站点（可在 edge://extensions/shortcuts 或 chrome://extensions/shortcuts 中改键）',
        '工具栏图标上的数字徽标显示当前标签页已打开的预览窗口数，可在设置 →「扩展集成」关闭',
        '扩展使用独立的后台 Service Worker 抓取网页：不受页面 CORS 限制，抓取快照、阅读模式与静音快照比油猴版更可靠；HTTP 状态码与最终重定向地址都会核对',
        '扩展拥有 <all_urls> 主机权限，但仍不能注入 chrome://、edge://、扩展商店、PDF 内置查看器等受保护页面；这些页面请直接打开',
        '如果扩展刚更新/重新加载，已打开的旧标签页不会自动获得新内容脚本：点一下工具栏图标即可按需注入（或刷新页面）',
        '在设置 →「扩展集成」里可以暂停整个扩展或指定域名；暂停只影响自动入口与已开预览，不会修改网页本身'
      ]],
      ['其它', [
"""
once(old_help_anchor, new_help_section, "help extension section")

once(
    """      const animation = animateWindow(item, false);
      const remove = () => item.ui.win.remove();
      if (animation) animation.finished.then(remove, remove);
      else remove();""",
    """      const animation = animateWindow(item, false);
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        try { item.ui.win.remove(); } catch (e) { /* 忽略 */ }
      };
      if (animation) {
        // WAAPI animations are throttled/paused in hidden tabs, so finished may
        // not resolve until the tab becomes visible again.  A wall-clock fallback
        // guarantees the closed window's DOM cannot remain as a ghost overlay.
        animation.finished.then(remove, remove);
        const closeMs = clampNum(settings.closeDuration, 0, 10000, 320, true);
        setTimeout(remove, closeMs + 180);
      } else remove();""",
    "closeWindow animation fallback",
)

once(
    """  const SNAPSHOT_THIN_CHARS = 200;
  function snapshotThin(doc) {
    try {
      const body = doc.body;
      if (!body) return true;
      const text = String(body.textContent || '').replace(/\\s+/g, '');
      if (text.length >= SNAPSHOT_THIN_CHARS) return false;
      if (body.querySelector('img,picture,video,audio,canvas,table')) return false;
      return true;
    } catch (e) { return false; }
  }""",
    """  const SNAPSHOT_THIN_CHARS = 200;
  function snapshotThin(doc) {
    try {
      const body = doc.body;
      if (!body) return true;
      const text = String(body.textContent || '').replace(/\\s+/g, '');
      if (text.length >= SNAPSHOT_THIN_CHARS) return false;
      if (body.querySelector('img,picture,video,audio,canvas,table')) return false;
      // v21 bugfix: a short but real article (e.g. a 2-paragraph page) used to
      // be misreported as a JavaScript-generated empty shell.  Structural
      // evidence (a main/article container, heading, paragraph, blockquote)
      // means there is actual content even when the character count is low.
      const structural = body.querySelectorAll('article,main,[role="main"],h1,h2,h3,p,pre,blockquote').length;
      if (text.length >= 40 && structural >= 2) return false;
      return true;
    } catch (e) { return false; }
  }""",
    "snapshot thin structural fix",
)

once(
    """        if (snapshotThin(doc)) {
          hint(item, '这个页面的内容由 JavaScript 生成，快照（已停用脚本）里只剩空壳。'
            + '想看原样请在新标签页打开。', HINT_OPEN_TAB);
        }""",
    """        if (snapshotThin(doc)) {
          hint(item, '快照里几乎没有正文：常见于纯 JavaScript 渲染的 SPA（快照已停用脚本），'
            + '也可能是站点只返回了很短的页面。想看原样请在新标签页打开。', HINT_OPEN_TAB);
        }""",
    "snapshot thin hint wording",
)

once(
    "    const bridgeKeys = ['threshold', 'longPressOpen', 'altClickOpen', 'longPressDelay',\n"
    "      'dragHold', 'linkButton', 'glassBlur', 'radius', 'blurAmount'];",
    "    const bridgeKeys = ['threshold', 'longPressOpen', 'altClickOpen', 'longPressDelay',\n"
    "      'dragHold', 'linkButton', 'glassBlur', 'radius', 'blurAmount', 'imageDragPreview'];",
    "bridge image setting",
)

once(
    """      for (const w of windows) {
        if (w.closed || !w.ui) continue;
        w.forceDark = !!settings.forceDark;""",
    """      for (const w of windows) {
        if (w.closed || !w.ui || w.imageMode) continue;
        w.forceDark = !!settings.forceDark;""",
    "forceDark image skip",
)
once(
    "  function applyForceDark(item) {\n    if (item.isReaderMode && item.readerSource)",
    "  function applyForceDark(item) {\n    if (item.imageMode) return;\n    if (item.isReaderMode && item.readerSource)",
    "applyForceDark image guard",
)

once(
    "      if (he === 'content-security-policy' || he === 'refresh' || he === 'x-frame-options') m.remove();",
    "      if (he === 'content-security-policy' || he === 'content-security-policy-report-only' || he === 'refresh' || he === 'x-frame-options') m.remove();",
    "snapshot CSP report-only",
)

once(
    """      reason => {
        if (item.closed) return;
        snapshotFailed(item, reason === 'timeout'
          ? '抓取快照超时（20 秒没有响应）。'
          : '该站点禁止被嵌入，抓取快照也失败了。');
      });""",
    """      reason => {
        if (item.closed) return;
        snapshotFailed(item, reason === 'timeout'
          ? '抓取快照超时（20 秒没有响应）。'
          : reason === 'too-large'
            ? '页面超过后台抓取的 12MB 上限，无法生成快照。可点「在新标签页打开」。'
            : '该站点禁止被嵌入，抓取快照也失败了。');
      });""",
    "snapshot too-large diagnostic",
)

once(
    """      () => {
        if (item.closed) return;
        item.ui.loader.hidden = true;
        item.preReaderRect = null;
        toast(item, '请求失败：该页面可能禁止外部抓取');
      });""",
    """      reason => {
        if (item.closed) return;
        item.ui.loader.hidden = true;
        item.preReaderRect = null;
        toast(item, reason === 'timeout' ? '请求超时：20 秒内没有拿到正文'
          : reason === 'too-large' ? '页面超过 12MB 抓取上限，无法进入阅读模式'
          : '请求失败：该页面可能禁止外部抓取');
      });""",
    "reader failure diagnostic",
)

once(
    "    const list = settings.favicon ? faviconCandidates(item.url) : [];",
    "    const list = (settings.favicon && !item.imageMode) ? faviconCandidates(item.url) : [];",
    "image title skip favicon",
)

once(
    """    /* 同步滚动：预览窗口内部滚动 → 立刻按比例转发给其它预览窗口。
       必须放在 token 校验之前 —— innerScroll 携带的就是发送方自己的 token，
       走正常校验会命中「已找到 item」分支直接 return，转发永远不执行
       （v19.1 之前同步滚动「开了没反应」的断点一就在这里）。 */
    if (settings.syncScroll && data.type === 'innerScroll' && typeof data.ratio === 'number') {
      for (const w of windows) {
        if (w.closed || w.ui.frame.contentWindow === event.source) continue;
        try { w.ui.frame.contentWindow.postMessage({ channel: CHANNEL, type: 'setScroll', ratio: clamp(data.ratio, 0, 1) }, '*'); }
        catch (e) { /* 忽略 */ }
      }
      return;
    }
    if (data.type === 'sync' && typeof data.ratio === 'number' && !data.frame) {
      for (const f of gatherFrames()) {
        try { f.postMessage({ channel: CHANNEL, type: 'sync', frame: true, ratio: data.ratio }, '*'); } catch (e) { /* 忽略 */ }
      }
      return;
    }
    /* v20.3：子框架上报的加载阶段（刻意不带 token —— 与 setScroll/sync 同理，
       「消息来自哪个窗口的 iframe」本身就是身份，先于 token 校验处理）。
       stage='dcl' 表示子框架自己的 DOMContentLoaded 到了：HTML 解析完成、
       首屏开始上屏。此时就撤骨架屏（revealEarly），内容边加载边显示。 */
    if (data.type === 'stage' && data.stage === 'dcl') {
      const staged = windows.find(w => !w.closed && w.ui.frame.contentWindow === event.source);
      if (staged) revealEarly(staged);
      return;
    }
    const synth = data.synthetic || {};
    if ((data.type === 'ldpFind' || data.type === 'ldpSync') && synth.query !== undefined) return;
    const item = windows.find(w => !w.closed && w.ui.frame.contentWindow === event.source);
    if (!item || data.token !== item.token) {
      if (data.type === 'ldpSelect' && typeof data.text === 'string') {
        const found = findUrlInText(data.text);
        if (found) { const it = openWindow(found); if (it) toast(it, '来自子框架的选中链接'); }
      }
      return;
    }""",
    """    // v21 security: every token-bearing message must come from the exact
    // preview iframe AND carry that item's token.  The old code handled
    // innerScroll/sync/stage before token validation and even exposed an
    // unauthenticated ldpSelect entry point; any page script could forge them.
    // The page can still see its own token (postMessage limitation), but it can
    // no longer reach the host without matching a live iframe source, and the
    // free-form ldpSelect opener has been removed entirely.
    const item = windows.find(w => !w.closed && w.ui.frame.contentWindow === event.source);
    if (!item || data.token !== item.token) return;
    if (data.type === 'stage' && data.stage === 'dcl') {
      revealEarly(item);
      return;
    }
    if (data.type === 'innerScroll' && typeof data.ratio === 'number') {
      if (settings.syncScroll) {
        for (const w of windows) {
          if (w.closed || w === item) continue;
          try { w.ui.frame.contentWindow.postMessage({ channel: CHANNEL, type: 'setScroll', ratio: clamp(data.ratio, 0, 1) }, '*'); }
          catch (e) { /* 忽略 */ }
        }
      }
      return;
    }""",
    "message auth and ldpSelect removal",
)

once(
    """    if (windows.length) {
      if (!o.silent && fromItem && o.confirm !== false) { askRestoreConfirm(fromItem, snapshot); return 0; }
      for (const w of windows.slice()) closeWindow(w, true);
    }
    let n = 0;
    restoringSession = true;
    try {
      for (const rec of snapshot.list.slice(0, settings.maxWindows)) {
        if (windows.length >= settings.maxWindows) break;
        if (openWindowFromRecord(rec)) n++;
      }
    } finally { restoringSession = false; }""",
    """    if (windows.length && !o.silent && fromItem && o.confirm !== false) {
      askRestoreConfirm(fromItem, snapshot);
      return 0;
    }
    let n = 0;
    // v21 bugfix: close old windows *inside* the restore guard.  Previously the
    // last close hit flushSessionNow() before restoringSession was set, marking
    // the current session closed and zeroing the tab mark even if restoration
    // then failed for every record.
    const wasRestoring = restoringSession;
    restoringSession = true;
    try {
      if (windows.length) for (const w of windows.slice()) closeWindow(w, true);
      for (const rec of snapshot.list.slice(0, settings.maxWindows)) {
        if (windows.length >= settings.maxWindows) break;
        if (openWindowFromRecord(rec)) n++;
      }
    } finally { restoringSession = wasRestoring; }
    if (!windows.length) resumeBackgroundVideos();""",
    "restoreSession guard order",
)

once(
    """    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
      if (!it || it.bare) return false;
      const step = clampNum(settings.zoomStep, 1, 25, 10, true) / 100;
      it.zoom = action === 'zoomReset' ? 1 : clamp(Math.round((it.zoom + (action === 'zoomIn' ? step : -step)) * 100) / 100, 0.5, 2);
      renderZoom(it);
      saveLayout(it);
      return true;
    }""",
    """    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
      if (!it || it.bare) return false;
      if (it.imageMode) {
        const step = 0.25;
        it.zoom = action === 'zoomReset' ? 1
          : clamp(Math.round((it.zoom + (action === 'zoomIn' ? step : -step)) * 100) / 100, 0.1, 8);
        renderImageZoom(it);
        saveLayout(it);
        return true;
      }
      const step = clampNum(settings.zoomStep, 1, 25, 10, true) / 100;
      it.zoom = action === 'zoomReset' ? 1 : clamp(Math.round((it.zoom + (action === 'zoomIn' ? step : -step)) * 100) / 100, 0.5, 2);
      renderZoom(it);
      saveLayout(it);
      return true;
    }""",
    "shortcut image zoom",
)

once(
    """    if (data.type === 'open') {
      const url = httpUrl(data.url);
      if (!url) return;""",
    """    if (data.type === 'open') {
      const url = httpUrl(data.url);
      if (!url || !allowNestedOpen(item)) return;""",
    "nested open budget",
)

once(
    "    if (action === 'find') { if (!it) return false; toggleFindBar(it); return true; }",
    "    if (action === 'find') { if (!it || it.imageMode) return false; toggleFindBar(it); return true; }",
    "shortcut find image guard",
)

once(
    "    const item = {\n      id: ++sequence,",
    "    try { window.__LPS_LAST_OPEN__ = Date.now(); } catch (e) { /* ignore */ }\n"
    "    const item = {\n      id: ++sequence,",
    "drag open timestamp",
)

once(
    """  window.addEventListener('drop', event => {
    endDropSession();
    const dt = event.dataTransfer;""",
    """  window.addEventListener('drop', event => {
    endDropSession();
    // v21: an in-page link/image drag is already handled by the gesture layer
    // (often before native dragstart).  The old 1.5s URL filter expired on slow
    // drags, so drop opened an identical second window.  Detect the in-page
    // drag sequence itself and never open the same preview twice.
    const dragGuard = window.__LPS_DRAG_GUARD__;
    const lastOpen = Number(window.__LPS_LAST_OPEN__) || 0;
    if (dragGuard && dragGuard.dragging && Date.now() - dragGuard.time < 30000 && lastOpen >= dragGuard.time) {
      window.__LPS_DRAG_GUARD__ = null;
      if (interactionEnabled()) event.preventDefault();
      return;
    }
    const dt = event.dataTransfer;""",
    "drop duplicate guard",
)

once(
    "    showHelpOnce: true,",
    "    showHelpOnce: false,",
    "disable automatic first-run help default",
)

# The in-page first-run panel is intentionally disabled: users open the help
# panel from the toolbar when they want it.  Leaving this call in made every
# new page/preview show the full help panel again for some profiles.
core_help_call_removed = False
if "      maybeShowFirstRunHelp(item);\n" in text:
    text = text.replace("      maybeShowFirstRunHelp(item);\n", "", 1)
    core_help_call_removed = True
if not core_help_call_removed:
    raise SystemExit("[build] first-run help call not found")

# Settings UI no longer advertises the obsolete auto-help switch.
if "    ['showHelpOnce', '下次开窗再显示一次说明', 'checkbox'],\n" in text:
    text = text.replace("    ['showHelpOnce', '下次开窗再显示一次说明', 'checkbox'],\n", "", 1)

once(
    "    ensureShell();\n    if (!shell) return null;",
    "    ensureShell();\n    if (!shell) return null;\n"
    "    // Re-sample the page at the moment a preview opens.  A shell created\n"
    "    // before the page's styles settled could otherwise keep the light\n"
    "    // document-start sample on a dark page.\n"
    "    invalidateThemeSample();\n"
    "    renderTheme(true);",
    "refresh theme on every preview open",
)

once(
    """    themeMutTimer = setTimeout(() => {
      themeMutTimer = 0;
      invalidateThemeSample();
      renderTheme(false);
    }, THEME_MUTATE_DEBOUNCE);""",
    """    themeMutTimer = setTimeout(() => {
      themeMutTimer = 0;
      invalidateThemeSample();
      // Apply synchronously: hidden/background tabs throttle rAF, which kept
      // the old light palette on pages whose theme changed just before a preview.
      renderTheme(true);
    }, THEME_MUTATE_DEBOUNCE);""",
    "sync theme mutation render",
)

once(
    """<div class="header"><span class="grip">${icon('grip')}</span><span class="title"></span>""",
    """<div class="header"><span class="brand">${icon('link')}</span><span class="grip">${icon('grip')}</span><span class="title"></span><span class="domain" hidden></span>""",
    "modern header brand/domain",
)

once(
    "title: $('.title'), content: $('.content'), frame: $('iframe'),",
    "title: $('.title'), domain: $('.domain'), content: $('.content'), frame: $('iframe'),",
    "domain UI binding",
)

once(
    """    if (span.textContent !== title) span.textContent = title;
    box.title = title + (item.url ? '\\n' + item.url : '');""",
    """    if (span.textContent !== title) span.textContent = title;
    const domain = item.ui && item.ui.domain;
    if (domain) {
      let host = '';
      try {
        const u = new window.URL(item.originalUrl || item.url || '');
        host = String(u.hostname || '').replace(/^www\\./i, '');
      } catch (e) { host = ''; }
      domain.textContent = host;
      domain.hidden = !host || !!item.bare;
      domain.title = host;
    }
    box.title = title + (item.url ? '\\n' + item.url : '');""",
    "domain title update",
)

# The old side-docked toolbar is replaced by a bottom dock in the modern
# window chrome; hide the obsolete setting from the settings panel.
if "    ['toolbarSide', '工具条停靠', 'select', [['auto', '自动（贴边换边）'], ['left', '固定在左'], ['right', '固定在右'], ['inside', '窗口内（不遮正文）']]],\n" in text:
    text = text.replace("    ['toolbarSide', '工具条停靠', 'select', [['auto', '自动（贴边换边）'], ['left', '固定在左'], ['right', '固定在右'], ['inside', '窗口内（不遮正文）']]],\n", "", 1)

once(
    "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}",
    """/* ============================================================================
   v21.1 Modern window chrome
   The old side strip / beige chrome is replaced by a compact app header and a
   bottom command dock.  Kept as a late CSS layer so the original geometry code
   and all [data-action] buttons continue to work unchanged.
   ============================================================================ */
.window{
  border-radius:var(--r-win);
  border:1px solid color-mix(in srgb,var(--border) 78%,transparent);
  box-shadow:0 28px 82px -28px rgba(0,0,0,.56),0 4px 16px -6px rgba(0,0,0,.2);
  font-family:"Inter","Segoe UI Variable","SF Pro Display","Segoe UI","Microsoft YaHei UI",sans-serif;
  font-feature-settings:"cv11","ss01";
}
.window.active{
  border-color:color-mix(in srgb,var(--accent) 42%,var(--border));
  box-shadow:0 30px 90px -30px rgba(0,0,0,.6),0 0 0 1px color-mix(in srgb,var(--accent) 16%,transparent),0 0 34px -8px color-mix(in srgb,var(--accent) 28%,transparent);
}
.header{
  height:50px!important;
  flex:0 0 50px!important;
  padding:0 8px 0 10px!important;
  gap:3px!important;
  border-radius:var(--r-in) var(--r-in) 0 0!important;
  border-bottom:1px solid color-mix(in srgb,var(--border) 52%,transparent)!important;
  background:linear-gradient(180deg,color-mix(in srgb,var(--surface) 95%,transparent),color-mix(in srgb,var(--surface) 84%,transparent))!important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.2);
}
.brand{
  width:24px;height:24px;flex:0 0 24px;display:inline-flex;align-items:center;justify-content:center;
  margin-right:3px;border-radius:8px;color:#fff;
  background:linear-gradient(135deg,#5b8cff 0%,#8b5cf6 100%);
  box-shadow:0 5px 14px -6px rgba(91,140,255,.9),inset 0 1px 0 rgba(255,255,255,.38);
}
.brand svg{width:14px;height:14px;stroke-width:2.2}
.grip{width:13px;height:24px;opacity:.34;margin:0 1px 0 0}
.grip svg{stroke-width:2.4}
.title{font-size:13.5px!important;font-weight:650!important;letter-spacing:-.012em;padding:0 3px!important}
.title img{width:15px!important;height:15px!important;border-radius:5px!important}
.domain{
  flex:0 1 auto;max-width:128px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding:3px 8px;border:1px solid color-mix(in srgb,var(--border) 66%,transparent);border-radius:999px;
  background:color-mix(in srgb,var(--surface) 62%,transparent);color:var(--muted);
  font-size:10.5px;font-weight:550;letter-spacing:.01em;
}
.header .btn{width:30px!important;height:30px!important;padding:6px!important;border-radius:10px!important;color:color-mix(in srgb,var(--text) 70%,var(--muted))!important}
.header .btn svg{width:17px!important;height:17px!important;stroke-width:1.9}
.header .btn:hover{background:color-mix(in srgb,var(--hover) 88%,transparent)!important;color:var(--text)!important}
.header .btn[data-action="close"]:hover{background:#e44b6424!important;color:#e76479!important}
.content{border-radius:0 0 var(--r-in) var(--r-in)!important;padding-left:0!important}
.window.tb-right .content{padding-left:0!important}
.window.tb-inside .content{padding-left:56px!important}
.window.pip .content{border-radius:var(--r-in)!important;padding-left:0!important}
.window.pip-bar .header{height:34px!important;flex:0 0 34px!important;padding:0 10px!important}
.window.pip-bar .brand,.window.pip-bar .domain{display:none!important}
.toolbar{
  position:absolute!important;top:58px!important;left:-62px!important;right:auto!important;bottom:auto!important;
  width:46px!important;max-width:none!important;max-height:calc(100% - 68px)!important;height:auto!important;
  display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:flex-start!important;gap:2px!important;
  padding:5px!important;overflow-x:hidden!important;overflow-y:auto!important;scrollbar-width:none;
  border:1px solid color-mix(in srgb,var(--border) 66%,transparent)!important;
  border-radius:16px!important;
  background:color-mix(in srgb,var(--surface) 76%,transparent)!important;
  box-shadow:0 16px 42px -18px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.18)!important;
  backdrop-filter:var(--glass-filter)!important;-webkit-backdrop-filter:var(--glass-filter)!important;
  z-index:25;
}
.toolbar::-webkit-scrollbar{height:0;width:0}
.window.tb-right .toolbar{left:auto!important;right:-62px!important;opacity:1!important}
.window.tb-inside .toolbar{left:10px!important;right:auto!important;opacity:1!important}
.window.pip .toolbar{display:none!important}
.toolbar .btn{width:32px!important;height:32px!important;padding:7px!important;border-radius:10px!important;color:color-mix(in srgb,var(--text) 70%,var(--muted))!important}
.toolbar .btn:hover{background:color-mix(in srgb,var(--hover) 82%,transparent)!important;color:var(--text)!important}
.toolbar .btn svg{width:17px!important;height:17px!important;stroke-width:1.9}
.toolbar .divider{width:24px!important;height:1px!important;flex:0 0 1px!important;margin:3px 0!important;align-self:center!important;background:color-mix(in srgb,var(--border) 58%,transparent)!important}
.zoom-label{width:auto!important;font-size:9.5px!important;font-weight:650!important;letter-spacing:.01em;color:var(--muted)!important;margin:1px 0 2px}
.window.image-mode .image-viewer{left:0!important}
.window.image-mode .loader{left:0!important}
.window .hint{left:10px!important}
.window.pip .image-viewer{left:0!important}
.window.tb-inside.image-mode .image-viewer{left:56px!important}
.window.tb-inside.image-mode .loader{left:56px!important}
.window.tb-inside .hint{left:66px!important}
.panel{
  top:58px!important;right:10px!important;max-height:calc(100% - 70px)!important;
  border-radius:16px!important;border-color:color-mix(in srgb,var(--border) 72%,transparent)!important;
  background:color-mix(in srgb,var(--surface) 94%,transparent)!important;
  box-shadow:0 24px 65px -22px rgba(0,0,0,.58)!important;
}
.panel-head{padding:12px 13px 12px 15px!important;border-bottom-color:color-mix(in srgb,var(--border) 46%,transparent)!important}
.panel-body{padding:16px!important}
.settings-panel{width:560px!important;max-width:calc(100% - 20px)!important;max-height:calc(100% - 76px)!important;overflow:hidden!important}
.settings-panel .panel-body{display:flex;flex-direction:column;min-height:0;overflow:hidden!important}
.settings-ai-footer{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;border-top:1px solid color-mix(in srgb,var(--border) 44%,transparent);background:color-mix(in srgb,var(--surface) 72%,transparent)}
.settings-ai-footer>span{flex:1;min-width:0;color:var(--muted);font-size:10px;line-height:1.35}
.settings-ai-footer .text-button{padding:7px 10px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--surface) 70%,transparent);color:var(--text);font-size:10.5px;font-weight:600;cursor:pointer;white-space:nowrap}
.settings-ai-footer .text-button[data-action="saveAI"]{border-color:color-mix(in srgb,var(--accent) 42%,var(--border));background:color-mix(in srgb,var(--accent) 17%,var(--surface))}
.settings-ai-footer .text-button:hover{background:color-mix(in srgb,var(--accent) 24%,var(--surface))}
.settings-hint{flex:0 0 auto;padding:10px 16px;color:var(--muted);font-size:11px;letter-spacing:.02em;border-bottom:1px solid color-mix(in srgb,var(--border) 40%,transparent);background:color-mix(in srgb,var(--surface) 78%,transparent)}
.settings-layout{display:flex;flex:1 1 auto;min-height:0;max-height:none;overflow:hidden}
.settings-nav{width:148px;flex:0 0 148px;padding:9px;display:flex;flex-direction:column;gap:2px;overflow:auto;border-right:1px solid color-mix(in srgb,var(--border) 44%,transparent);background:color-mix(in srgb,var(--surface) 58%,transparent);scrollbar-width:thin}
.settings-nav-item{width:100%;padding:9px 10px;border:0;border-radius:9px;background:transparent;color:var(--muted);text-align:left;font-size:12px;line-height:1.35;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.settings-nav-item:hover{background:var(--hover);color:var(--text)}
.settings-nav-item.active{background:color-mix(in srgb,var(--accent) 15%,var(--surface));color:var(--text);font-weight:650;box-shadow:inset 2px 0 var(--accent)}
.settings-content{flex:1;min-width:0;overflow:auto;padding:14px 16px 18px;scrollbar-width:thin}
.settings-group{display:none}
.settings-group.active{display:block;animation:ldp-fade .16s var(--ease)}
.settings-group h3{margin:0 0 10px;font-size:14px;font-weight:680;letter-spacing:-.01em}
.settings-content .row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--border) 42%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 38%,transparent);font-size:12px}
.settings-content .row>span{flex:1;min-width:0;line-height:1.4}
.settings-content .row select,.settings-content .row input[type="text"]{width:170px!important;min-width:0;padding:7px 9px!important;border:1px solid color-mix(in srgb,var(--border) 62%,transparent)!important;border-radius:8px!important;background:color-mix(in srgb,var(--bg) 60%,transparent)!important;color:var(--text)!important;font-size:11.5px!important;outline:none}
.settings-content .row select:focus,.settings-content .row input[type="text"]:focus{border-color:var(--accent)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.settings-content .number-control{width:170px!important;height:31px!important;background:color-mix(in srgb,var(--bg) 60%,transparent)!important;border-radius:8px!important}
.settings-content .number-control input{font-size:11.5px!important;color:var(--text)!important}
.settings-content .number-arrows{border-left-color:color-mix(in srgb,var(--border) 55%,transparent)!important}
.settings-content input[type="checkbox"]{appearance:none;-webkit-appearance:none;position:relative;width:38px;height:22px;flex:0 0 auto;border:0;border-radius:999px;background:color-mix(in srgb,var(--muted) 32%,transparent);cursor:pointer;transition:background var(--dur) var(--ease)}
.settings-content input[type="checkbox"]::after{content:"";position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:transform var(--dur) var(--ease)}
.settings-content input[type="checkbox"]:checked{background:var(--accent)}
.settings-content input[type="checkbox"]:checked::after{transform:translateX(16px)}
.settings-note{margin:8px 0!important;padding:9px 11px!important;border-radius:9px;background:color-mix(in srgb,var(--surface) 45%,transparent);font-size:11.5px;line-height:1.5}
.domain-editor-row{align-items:flex-start!important}
.domain-editor{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.domain-list{display:flex;flex-direction:column;gap:4px;max-height:154px;overflow:auto;scrollbar-width:thin}
.domain-item{display:flex;align-items:center;gap:6px;min-width:0}
.domain-value{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid color-mix(in srgb,var(--border) 65%,transparent);border-radius:7px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);font:11.5px/1.4 inherit;outline:none}
.domain-value:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.domain-remove{width:26px;height:26px;flex:0 0 26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:17px;line-height:1;cursor:pointer}
.domain-remove:hover{background:color-mix(in srgb,#e44b64 14%,transparent);color:#d9435c}
.domain-add-row{display:flex;align-items:center;gap:6px;min-width:0}
.domain-input{flex:1;min-width:0;height:29px;padding:0 8px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:7px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);font:11px/1.4 inherit;outline:none}
.domain-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.domain-add-row .text-button{height:29px;padding:0 9px;font-size:10.5px;white-space:nowrap}
.settings-diagnostic{margin:8px 0;padding:11px 12px;border:1px solid color-mix(in srgb,var(--border) 46%,transparent);border-radius:10px;background:color-mix(in srgb,var(--bg) 48%,transparent);font-size:11.5px;line-height:1.65;color:var(--muted)}
.settings-content .panel-actions{margin-top:2px;padding-top:2px;border-top:0}
.settings-content .pa-group>h4{font-size:10.5px}
.settings-content .pa-buttons{grid-template-columns:repeat(auto-fill,minmax(92px,1fr))}
.settings-ai-fields{display:flex;flex-direction:column;gap:6px}
.settings-ai-providers{display:flex;flex-wrap:nowrap;gap:4px;padding:1px 0 3px;overflow-x:auto;scrollbar-width:none}
.settings-ai-providers::-webkit-scrollbar{height:0}
.settings-ai-provider-select{position:relative;display:flex;flex-direction:column;gap:5px}
.settings-ai-provider-pill{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;padding:7px 11px;border:1px solid color-mix(in srgb,var(--accent) 34%,var(--border));border-radius:999px;background:color-mix(in srgb,var(--accent) 11%,var(--surface));color:var(--text);font:11.5px/1.2 inherit;font-weight:650;cursor:pointer}
.settings-ai-provider-pill:hover{background:color-mix(in srgb,var(--accent) 17%,var(--surface))}
.settings-ai-provider-chevron{color:var(--muted);font-size:12px;line-height:1}
.settings-ai-provider-menu{display:flex;flex-wrap:wrap;gap:5px;padding:6px;border:1px solid color-mix(in srgb,var(--border) 52%,transparent);border-radius:10px;background:color-mix(in srgb,var(--bg) 42%,transparent)}
.settings-ai-provider-menu .settings-ai-provider{display:block;width:auto;flex:0 0 auto;padding:5px 9px;border:1px solid color-mix(in srgb,var(--border) 52%,transparent);border-radius:999px;background:color-mix(in srgb,var(--surface) 62%,transparent);color:var(--muted);font-size:10.5px;cursor:pointer}
.settings-ai-provider-menu .settings-ai-provider:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 36%,var(--border))}
.settings-ai-provider-menu .settings-ai-provider.active{color:var(--text);border-color:color-mix(in srgb,var(--accent) 56%,var(--border));background:color-mix(in srgb,var(--accent) 14%,var(--surface));font-weight:650}
.settings-ai-provider{flex:0 0 auto;padding:5px 8px;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:999px;background:color-mix(in srgb,var(--bg) 45%,transparent);color:var(--muted);font-size:10.5px;cursor:pointer;transition:all var(--dur) var(--ease)}
.settings-ai-provider:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 36%,var(--border))}
.settings-ai-provider.active{color:var(--text);border-color:color-mix(in srgb,var(--accent) 56%,var(--border));background:color-mix(in srgb,var(--accent) 14%,var(--surface));font-weight:650}
.settings-ai-field{display:flex;flex-direction:column;gap:3px}
.settings-ai-field>span{font-size:11.5px;font-weight:650;color:var(--text)}
.settings-ai-field>span small{font-weight:400;color:var(--muted);font-size:10px}
.settings-ai-field input{width:100%;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);font:11.5px/1.5 inherit;outline:none}
.settings-ai-field input:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.settings-ai-inline{display:flex;align-items:center;gap:7px}
.settings-ai-inline input{flex:1;min-width:0}
.settings-ai-inline .text-button{flex:0 0 auto;padding:7px 11px}
.window.settings-standalone{left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0!important;border:0!important;box-shadow:none!important;background:#f3f5f8!important;color:#18202a!important;color-scheme:light;--bg:#f3f5f8;--surface:#ffffff;--panel:#ffffff;--text:#18202a;--muted:#596475;--border:#c8d0dc;--accent:#2e6fb7;--overlay:rgba(20,30,45,.06)}
.settings-ai-model-row{display:flex;align-items:center;gap:6px}
.settings-ai-model-row input{flex:1;min-width:0}
.settings-ai-model-row .text-button{flex:0 0 auto;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--surface) 70%,transparent);color:var(--text);font-size:10.5px;cursor:pointer;white-space:nowrap}
.settings-ai-model-row .text-button:hover{background:var(--hover)}
.settings-ai-model-search{width:100%;padding:6px 9px;border:1px solid color-mix(in srgb,var(--border) 52%,transparent);border-radius:8px;background:color-mix(in srgb,var(--bg) 48%,transparent);color:var(--text);font:10.5px/1.5 inherit;outline:none}
.settings-ai-model-search:focus{border-color:var(--accent)}
.settings-ai-model-select{flex:1;min-width:0;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);font:11.5px/1.5 inherit;outline:none}
.settings-ai-model-status{min-height:13px;color:var(--muted);font-size:10px;line-height:1.35}
.settings-ai-model-list{display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow:auto;padding:3px 0}
.settings-ai-model-item{max-width:100%;padding:6px 10px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:8px;background:color-mix(in srgb,var(--surface) 78%,var(--bg));color:var(--text);font:12px/1.35 inherit;font-weight:550;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.settings-ai-model-item:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 52%,var(--border));background:var(--hover)}
.settings-ai-model-item.active{color:var(--text);border-color:color-mix(in srgb,var(--accent) 70%,var(--border));background:color-mix(in srgb,var(--accent) 16%,var(--surface));font-weight:700}
.settings-ai-fields .text-button{align-self:flex-start;padding:7px 13px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--accent) 14%,var(--surface));color:var(--text);font-size:11.5px;cursor:pointer}
@media (max-width:650px){
  .settings-panel{width:calc(100% - 18px)!important}
  .settings-layout{flex-direction:column;max-height:calc(100vh - 230px)}
  .settings-nav{width:auto;flex:0 0 auto;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid color-mix(in srgb,var(--border) 44%,transparent);padding:6px}
  .settings-nav-item{width:auto;flex:0 0 auto;padding:7px 10px}
  .settings-nav-item.active{box-shadow:inset 0 -2px var(--accent)}
  .settings-content{max-height:none}
}
.ai-actions{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 12px}
.ai-model-row{position:relative;display:flex;align-items:center;gap:8px;margin:2px 0 4px}
.ai-vendor-row{position:relative;display:flex;align-items:center;margin:2px 0 6px}
.ai-vendor-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));border-radius:999px;background:color-mix(in srgb,var(--accent) 11%,var(--surface));color:var(--text);font-size:11px;font-weight:650;cursor:pointer}
.ai-vendor-pill:hover{background:color-mix(in srgb,var(--accent) 18%,var(--surface))}
.ai-vendor-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.ai-vendor-chevron{margin-left:2px;color:var(--muted);font-size:12px;line-height:1}
.ai-vendor-meta{margin-left:4px;color:var(--muted);font-size:9.5px;font-weight:450}
.ai-provider-menu{position:absolute;z-index:4;top:30px;left:0;min-width:150px;padding:5px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--surface) 97%,transparent);box-shadow:0 16px 36px -16px rgba(0,0,0,.55);display:flex;flex-direction:column;gap:1px}
.ai-provider-choice{width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:var(--text);text-align:left;font-size:11px;cursor:pointer}
.ai-provider-choice:hover{background:var(--hover)}
.ai-provider-choice.active{background:color-mix(in srgb,var(--accent) 13%,var(--surface));font-weight:650}
.ai-model-label{flex:0 0 auto;color:var(--muted);font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;font-weight:650}
.ai-model-picker{flex:1;min-width:0;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);font:11.5px/1.5 inherit;outline:none}
.ai-model-trigger{flex:1;min-width:0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--bg) 58%,transparent);color:var(--text);text-align:left;font:12px/1.4 inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-model-trigger:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.ai-model-popover{position:absolute;z-index:8;top:34px;left:38px;right:0;max-height:300px;display:flex;flex-direction:column;gap:5px;padding:7px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:11px;background:color-mix(in srgb,var(--surface) 98%,transparent);box-shadow:0 18px 42px -16px rgba(0,0,0,.62);overflow:hidden}
.ai-model-popover-search{width:100%;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:8px;background:color-mix(in srgb,var(--bg) 62%,transparent);color:var(--text);font:11.5px/1.5 inherit;outline:none}
.ai-model-popover-search:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.ai-model-popover-list{display:flex;flex-direction:column;gap:2px;max-height:245px;overflow:auto}
.ai-model-option{width:100%;padding:8px 9px;border:0;border-radius:7px;background:transparent;color:var(--text);text-align:left;font:12px/1.4 inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-model-option:hover,.ai-model-option.active{background:color-mix(in srgb,var(--accent) 14%,var(--surface));color:var(--text);font-weight:650}
.ai-actions .text-button,.ai-ask-row .text-button{padding:8px 12px;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 74%,transparent);color:var(--text);font-size:12px;cursor:pointer}
.ai-actions .text-button:hover,.ai-ask-row .text-button:hover{background:var(--hover);border-color:color-mix(in srgb,var(--accent) 38%,var(--border))}
.ai-question{width:100%;min-height:76px;resize:vertical;padding:10px 12px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:11px;background:color-mix(in srgb,var(--bg) 68%,transparent);color:var(--text);font:12.5px/1.6 inherit;outline:none}
.ai-question:focus{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}
.ai-ask-row{display:flex;gap:8px;margin-top:8px}
.ai-ask-row .primary-text{background:color-mix(in srgb,var(--accent) 18%,var(--surface));font-weight:650}
.ai-answer{margin-top:13px;padding:13px 14px;min-height:58px;max-height:330px;overflow:auto;color:var(--text);font-size:12.5px;line-height:1.7;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:13px;background:color-mix(in srgb,var(--bg) 58%,transparent);white-space:pre-wrap;word-break:break-word}
.panel.ai-panel{width:640px!important;max-width:calc(100% - 20px)!important;max-height:calc(100% - 70px)!important;overflow:hidden!important}
.ai-panel .panel-body{display:block!important;min-height:0;overflow:auto!important;padding-bottom:18px!important}
.ai-panel .ai-answer{min-height:180px;max-height:none;font-size:13.5px;line-height:1.72;white-space:normal;overflow:visible}
.panel.video-panel{width:620px!important;max-width:calc(100% - 20px)!important;max-height:calc(100% - 70px)!important;overflow:hidden!important}
.window.summary-window{background:transparent!important;border:0!important;box-shadow:none!important;max-width:none!important;max-height:none!important}
.window.summary-window .header,.window.summary-window .content,.window.summary-window .toolbar,.window.summary-window .resize{display:none!important}
.window.summary-window .panel{position:relative!important;inset:auto!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border:1px solid var(--border)!important;box-shadow:var(--shadow)!important}
.window.summary-window[data-summary-dock="right"] .panel{border-radius:var(--r-win) 0 0 var(--r-win)!important}
.window.summary-window[data-summary-dock="left"] .panel{border-radius:0 var(--r-win) var(--r-win) 0!important}
.window.summary-window[data-summary-dock="free"] .panel{border-radius:var(--r-win)!important}
.window.summary-window .panel-head{cursor:grab;user-select:none;touch-action:none}
.window.summary-window .panel-head:active{cursor:grabbing}
.window.settings-standalone{left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0!important;border:0!important;box-shadow:none!important;background:var(--bg)!important}
.window.settings-standalone .header,.window.settings-standalone .toolbar,.window.settings-standalone .content,.window.settings-standalone .resize{display:none!important}
.window.settings-standalone .panel{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;overflow:auto!important}
.window.settings-standalone .panel-head{position:sticky!important;top:0!important;z-index:2!important}
.window.settings-standalone .panel-body{max-width:860px;margin:0 auto;padding:8px 22px 32px!important;width:100%;box-sizing:border-box}
.video-panel .panel-body{display:block!important;overflow:auto!important;min-height:0}
.text-ai-panel .panel-body{display:flex!important;flex-direction:column!important;overflow:auto!important;min-height:0!important;gap:0}
.text-ai-answer{min-height:190px;max-height:min(50vh,560px);padding:12px 14px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--bg) 55%,transparent);font-size:13.5px;line-height:1.72;white-space:normal;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.text-ai-panel .note{word-break:break-all;flex:0 0 auto}.text-ai-panel .ai-actions{flex:0 0 auto;margin-top:10px}
.video-summary-status{font-size:11px;color:var(--muted);margin:7px 0}
.video-summary-answer{min-height:190px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--bg) 55%,transparent);font-size:13.5px;line-height:1.72;white-space:normal;overflow:visible}
.video-summary-answer:empty::before{content:'正在读取视频字幕…';color:var(--muted)}
.video-summary-meta{min-height:15px;margin:6px 0;color:var(--muted);font-size:10.5px}
.video-panel .markdown h1,.video-panel .markdown h2,.video-panel .markdown h3{margin:1em 0 .42em;line-height:1.35}
.video-panel .markdown p{margin:.55em 0}
.video-panel .markdown ul,.video-panel .markdown ol{margin:.5em 0;padding-left:1.4em}
.video-panel .markdown li{margin:.22em 0}
.video-panel .markdown code{padding:1px 4px;border-radius:4px;background:color-mix(in srgb,var(--text) 8%,transparent)}
.video-panel .markdown pre{padding:9px 11px;border-radius:8px;background:color-mix(in srgb,var(--text) 7%,transparent);overflow:auto}
.panel.media-panel{width:660px!important;max-width:calc(100% - 20px)!important;max-height:calc(100% - 70px)!important;overflow:hidden!important}
.media-panel .panel-body{display:block!important;overflow:auto!important;min-height:0}
.media-summary-status{font-size:11px;color:var(--muted);margin:7px 0 5px}
.media-progress{height:4px;border-radius:999px;background:color-mix(in srgb,var(--text) 10%,transparent);overflow:hidden;margin:0 0 9px}
.media-progress-bar{display:block;width:0;height:100%;border-radius:999px;background:var(--accent);transition:width .25s ease}
.media-summary-answer{min-height:190px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--bg) 55%,transparent);font-size:13.5px;line-height:1.72;white-space:normal;overflow:visible}
.media-summary-meta{min-height:15px;margin:6px 0;color:var(--muted);font-size:10.5px}
.ai-panel .ai-meta{flex:0 0 auto}
.ai-answer.markdown{white-space:normal;overflow-wrap:anywhere}
.ai-answer.markdown p{margin:.55em 0}
.ai-answer.markdown h1,.ai-answer.markdown h2,.ai-answer.markdown h3,.ai-answer.markdown h4{margin:.8em 0 .35em;line-height:1.35;font-weight:700}
.ai-answer.markdown h1{font-size:1.35em}.ai-answer.markdown h2{font-size:1.2em}.ai-answer.markdown h3{font-size:1.08em}
.ai-answer.markdown ul,.ai-answer.markdown ol{margin:.5em 0;padding-left:1.4em}
.ai-answer.markdown li{margin:.2em 0}
.ai-answer.markdown blockquote{margin:.7em 0;padding:4px 10px;border-left:3px solid color-mix(in srgb,var(--accent) 55%,var(--border));color:var(--muted)}
.ai-answer.markdown code{padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--bg) 72%,transparent);font:11.5px/1.5 "Cascadia Code","SFMono-Regular",Consolas,monospace}
.ai-answer.markdown pre{margin:.7em 0;padding:10px 12px;border-radius:9px;background:color-mix(in srgb,var(--bg) 72%,transparent);overflow:auto}
.ai-answer.markdown pre code{padding:0;background:transparent;font-size:11.5px;white-space:pre}
.ai-answer.markdown a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.ai-answer.markdown hr{border:0;border-top:1px solid var(--border);margin:1em 0}
.ai-prompt-box{margin:2px 0 8px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--border) 48%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 38%,transparent)}
.ai-prompt-head{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:4px;min-height:16px}
.ai-prompt-label{font-size:11px;font-weight:650;color:var(--text);flex:0 0 auto}
.ai-prompt-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}
.ai-prompt-toggle,.ai-prompt-reset{padding:2px 6px;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:10px;cursor:pointer;flex:0 0 auto}
.ai-prompt-toggle:hover,.ai-prompt-reset:hover{background:var(--hover);color:var(--text)}
.ai-summary-prompt{width:100%;min-height:46px;max-height:120px;resize:vertical;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:8px;background:color-mix(in srgb,var(--bg) 55%,transparent);color:var(--text);font:11.5px/1.55 inherit;outline:none}
.ai-summary-prompt:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.ai-answer.streaming::after{content:"▍";display:inline-block;margin-left:2px;color:var(--accent);animation:ldp-ai-caret .8s steps(2,end) infinite}
@keyframes ldp-ai-caret{50%{opacity:0}}
.ai-meta{margin-top:7px;min-height:16px;color:var(--muted);font-size:10.5px;letter-spacing:.01em}
.ai-answer[data-tone="bad"]{color:#d85a6d;border-color:color-mix(in srgb,#d85a6d 38%,var(--border))}
.ai-answer[data-tone="good"]{border-color:color-mix(in srgb,var(--accent) 26%,var(--border))}
.reader-outline{display:flex;flex-direction:column;gap:2px;max-height:390px;overflow:auto;margin:6px -4px 10px}
.reader-outline-item{display:block;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--text);text-align:left;font-size:12.5px;line-height:1.45;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reader-outline-item:hover{background:var(--hover);color:var(--accent)}
.panel h3{font-size:15px!important;letter-spacing:-.01em}
.panel h4{font-size:11px!important;letter-spacing:.055em;text-transform:uppercase}
.findbar{
  padding:7px 10px!important;gap:6px!important;
  border-bottom:1px solid color-mix(in srgb,var(--border) 46%,transparent)!important;
  background:color-mix(in srgb,var(--surface) 88%,transparent)!important;
}
.findbar input[type="text"]{border-radius:10px!important;background:color-mix(in srgb,var(--bg) 70%,transparent)!important}
.hint{
  border-radius:14px!important;border-color:color-mix(in srgb,var(--border) 72%,transparent)!important;
  background:color-mix(in srgb,var(--surface) 94%,transparent)!important;
  box-shadow:0 16px 40px -18px rgba(0,0,0,.5)!important;
}
.toast{
  bottom:15px!important;border-radius:14px!important;
  border:1px solid color-mix(in srgb,var(--border) 50%,transparent);
  background:color-mix(in srgb,var(--surface) 96%,transparent)!important;
  box-shadow:0 18px 44px -18px rgba(0,0,0,.55)!important;
}
.window.pip .toast{bottom:16px!important}
.loader{background:color-mix(in srgb,var(--bg) 94%,transparent)!important;backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.skeleton{background:linear-gradient(90deg,color-mix(in srgb,var(--surface) 72%,transparent) 25%,color-mix(in srgb,var(--hover) 82%,transparent) 50%,color-mix(in srgb,var(--surface) 72%,transparent) 75%);background-size:200% 100%!important;border-radius:8px!important}
.image-meta{padding:5px 12px!important;border-radius:999px!important;background:color-mix(in srgb,var(--surface) 88%,transparent)!important;color:var(--text)!important;box-shadow:0 8px 24px -10px rgba(0,0,0,.55)!important}
.image-stage{scrollbar-width:none;scrollbar-color:transparent transparent}
.image-stage::-webkit-scrollbar{width:0;height:0}
.image-stage::-webkit-scrollbar-track{background:transparent}
.image-stage::-webkit-scrollbar-thumb{background:transparent;border:0}
.panel{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted) 34%,transparent) transparent}
.panel::-webkit-scrollbar{width:8px;height:8px}
.panel::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 34%,transparent);border:2px solid transparent;border-radius:999px;background-clip:padding-box}
@media (max-width:560px){
  .domain{display:none!important}
  .header .btn{width:28px!important;height:28px!important}
  .toolbar .btn{width:28px!important;height:28px!important}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}""",
    "modern window chrome CSS",
)

# The image-fit calculation lives inside the image-viewer hook (inserted later).

once(
    """    play: '<path d="M8 5.4v13.2L19 12 8 5.4Z"/>'
  };""",
    """    play: '<path d="M8 5.4v13.2L19 12 8 5.4Z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    volume: '<path d="M11 5 6.6 9H3v6h3.6L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/>',
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="M19 16v4M17 18h4"/>'
  };""",
    "reader/ai icons",
)

once(
    "${button('find', 'search', '预览内查找')}${button('history', 'history', '预览历史')}${button('help', 'help', '使用说明')}${button('settings', 'settings', '设置')}",
    "${button('find', 'search', '预览内查找')}${button('history', 'history', '预览历史')}"
    "<button type=\"button\" class=\"btn reader-tool\" data-action=\"outline\" title=\"文章目录\" hidden>${icon('list')}</button>"
    "<button type=\"button\" class=\"btn reader-tool\" data-action=\"speak\" title=\"朗读正文\" hidden>${icon('volume')}</button>"
    "<button type=\"button\" class=\"btn reader-tool\" data-action=\"saveReader\" title=\"导出正文\" hidden>${icon('download')}</button>"
    "${button('ai', 'spark', 'AI 页面助手')}${button('help', 'help', '使用说明')}${button('settings', 'settings', '设置')}",
    "reader and AI toolbar buttons",
)

once(
    "      pipBtn: $('[data-action=\"pip\"]'), arrangeBtn: $('[data-action=\"arrange\"]'),",
    "      pipBtn: $('[data-action=\"pip\"]'), arrangeBtn: $('[data-action=\"arrange\"]'),\n"
    "      readerTools: Array.from(win.querySelectorAll('.reader-tool')),\n"
    "      speakBtn: $('[data-action=\"speak\"]'), aiBtn: $('[data-action=\"ai\"]'),",
    "reader tool UI bindings",
)

once(
    "  function applyReaderTypography(item) {",
    """  // v21.2 reader enhancements: outline, speech and text export.
  function readerOutlineFromHtml(html) {
    const list = [];
    try {
      const doc = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
      const headings = Array.from(doc.body ? doc.body.querySelectorAll('h1,h2,h3,h4') : [])
        .filter(h => String(h.textContent || '').replace(/\\s+/g, ' ').trim().length > 1);
      headings.forEach((h, i) => {
        const id = String(i);
        h.setAttribute('data-ldp-heading', id);
        list.push({
          id,
          level: Number(String(h.tagName || 'H2').slice(1)) || 2,
          text: String(h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
        });
      });
      return { html: doc.body ? doc.body.innerHTML : String(html || ''), list };
    } catch (e) { return { html: String(html || ''), list: [] }; }
  }
  function readerPlainText(item) {
    const doc = frameDoc(item);
    if (!doc || !doc.body) return '';
    return String(doc.body.innerText || doc.body.textContent || '')
      .replace(/\\n{3,}/g, '\\n\\n').trim();
  }
  function readerExportText(item) {
    const text = readerPlainText(item);
    if (!text) return '';
    const title = String(item.title || item.fallbackTitle || '网页正文').trim();
    const source = currentPageUrl(item) || item.originalUrl || item.url || '';
    return '# ' + title + '\\n\\n> ' + source + '\\n\\n' + text + '\\n';
  }
  function scrollReaderHeading(item, id) {
    const doc = frameDoc(item);
    if (!doc) return false;
    let target = null;
    try {
      target = Array.from(doc.querySelectorAll('[data-ldp-heading]'))
        .find(h => h.getAttribute('data-ldp-heading') === String(id)) || null;
    } catch (e) { target = null; }
    if (!target) return false;
    try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (e) { try { target.scrollIntoView(); } catch (e2) { /* ignore */ } }
    return true;
  }
  function renderReaderOutline(item) {
    item.panelMode = 'readerOutline';
    const body = panelFrame(item, '文章目录');
    const list = Array.isArray(item.readerOutline) ? item.readerOutline : [];
    if (!list.length) {
      body.appendChild(el('p', 'note', '这篇文章没有可识别的标题层级。'));
    } else {
      const box = el('div', 'reader-outline');
      for (const h of list) {
        const btn = el('button', 'reader-outline-item', h.text);
        btn.type = 'button';
        btn.style.paddingLeft = (8 + Math.max(0, Math.min(3, h.level - 1)) * 14) + 'px';
        btn.title = h.text;
        btn.addEventListener('click', () => {
          closePanel(item, false);
          setTimeout(() => {
            if (!scrollReaderHeading(item, h.id)) toast(item, '没有找到这个标题');
          }, 60);
        });
        box.appendChild(btn);
      }
      body.appendChild(box);
    }
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function renderReaderExport(item) {
    item.panelMode = 'readerExport';
    const body = panelFrame(item, '导出阅读正文');
    body.appendChild(el('p', 'note', '导出当前阅读模式的纯文本，包含标题和来源地址；不会上传正文。'));
    body.appendChild(buttonRow('<button class="text-button" data-action="copyReader">复制正文</button><button class="text-button" data-action="downloadReader">下载 TXT</button>', '14px'));
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function copyReaderText(item) {
    const text = readerExportText(item);
    if (!text) { toast(item, '阅读正文为空'); return; }
    toast(item, T.copy(text) ? '正文已复制到剪贴板' : '复制失败，请手动选择正文');
  }
  function downloadReaderText(item) {
    const text = readerExportText(item);
    if (!text) { toast(item, '阅读正文为空'); return; }
    try {
      const base = String(item.title || 'article').replace(/[\\\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'article';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = base + '.txt';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { window.URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 2000);
      toast(item, '正文已导出为 TXT');
    } catch (e) { toast(item, '导出失败'); }
  }
  function stopReaderSpeech(item) {
    if (!item) return;
    if (item.readerSpeechUtterance || item.readerSpeech) {
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
    item.readerSpeech = false;
    item.readerSpeechUtterance = null;
    syncReaderTools(item);
  }
  function syncReaderTools(item) {
    if (!item || !item.ui) return;
    const on = !!item.isReaderMode;
    for (const btn of item.ui.readerTools || []) btn.hidden = !on;
    if (item.ui.aiBtn) item.ui.aiBtn.hidden = !!(item.imageMode || item.bare);
    if (item.ui.speakBtn) {
      item.ui.speakBtn.classList.toggle('selected', !!item.readerSpeech);
      item.ui.speakBtn.title = item.readerSpeech ? '停止朗读' : '朗读正文';
    }
  }
  function toggleReaderSpeech(item) {
    if (!item || !item.isReaderMode) { toast(item, '先进入阅读模式'); return; }
    if (item.readerSpeech) {
      stopReaderSpeech(item);
      toast(item, '已停止朗读');
      return;
    }
    const synth = window.speechSynthesis;
    const Utter = window.SpeechSynthesisUtterance;
    if (!synth || typeof Utter !== 'function') { toast(item, '当前浏览器不支持语音朗读'); return; }
    const text = readerPlainText(item);
    if (!text) { toast(item, '阅读正文为空'); return; }
    try {
      const u = new Utter(text.slice(0, 60000));
      u.lang = String(document.documentElement.lang || 'zh-CN');
      u.rate = 1;
      u.onend = () => { item.readerSpeech = false; item.readerSpeechUtterance = null; syncReaderTools(item); };
      u.onerror = () => { item.readerSpeech = false; item.readerSpeechUtterance = null; syncReaderTools(item); };
      item.readerSpeech = true;
      item.readerSpeechUtterance = u;
      syncReaderTools(item);
      synth.speak(u);
      toast(item, '开始朗读正文');
    } catch (e) {
      item.readerSpeech = false;
      syncReaderTools(item);
      toast(item, '朗读启动失败');
    }
  }
  function applyReaderTypography(item) {""",
    "reader outline/tts/export",
)

once(
    """      const html = built.mode === 'empty'
        ? '<p>没能从这个页面里抽出正文。已保留原始页面，可点“刷新”重试，或用“新标签页”直接打开。</p>'
        : built.html;""",
    """      let html = built.mode === 'empty'
        ? '<p>没能从这个页面里抽出正文。已保留原始页面，可点“刷新”重试，或用“新标签页”直接打开。</p>'
        : built.html;
      let outline = [];
      if (built.mode !== 'empty') {
        const enriched = readerOutlineFromHtml(html);
        html = enriched.html;
        outline = enriched.list;
      }
      item.readerOutline = outline;""",
    "reader outline extraction",
)

once(
    """      if (settings.phoneMode) {
        const v = viewport();
        const rw = Math.min(width + 20, v.w - 16);
        item.rect = fit({ x: (v.w - rw) / 2, y: 20, w: rw, h: v.h - 40 });
        renderGeometry(item, true);
      }
    } catch (e) {
      item.isReaderMode = false;""",
    """      if (settings.phoneMode) {
        const v = viewport();
        const rw = Math.min(width + 20, v.w - 16);
        item.rect = fit({ x: (v.w - rw) / 2, y: 20, w: rw, h: v.h - 40 });
        renderGeometry(item, true);
      }
      syncReaderTools(item);
    } catch (e) {
      item.isReaderMode = false;""",
    "reader tools render sync",
)

once(
    """    if (item.isReaderMode) {
      item.isReaderMode = false;
      item.readerSource = null;
      item.readerDirty = false;
      if (item.preReaderRect) { item.rect = fit(item.preReaderRect); item.preReaderRect = null; renderGeometry(item, true); }
      navigate(item, currentPageUrl(item) || item.originalUrl);
      toast(item, '已退出阅读模式');
      return;
    }""",
    """    if (item.isReaderMode) {
      stopReaderSpeech(item);
      item.isReaderMode = false;
      item.readerSource = null;
      item.readerOutline = [];
      item.readerDirty = false;
      if (item.preReaderRect) { item.rect = fit(item.preReaderRect); item.preReaderRect = null; renderGeometry(item, true); }
      syncReaderTools(item);
      navigate(item, currentPageUrl(item) || item.originalUrl);
      toast(item, '已退出阅读模式');
      return;
    }""",
    "reader exit speech sync",
)

once(
    "    if (item.bare) win.classList.add('bare');",
    "    if (item.bare) win.classList.add('bare');\n"
    "    syncReaderTools(item);",
    "reader tools initial sync",
)

once(
    """    else if (mode === 'grid') showGridMenu(item);
    else if (mode === 'sessions') showSessions(item);
    else showHistory(item);""",
    """    else if (mode === 'grid') showGridMenu(item);
    else if (mode === 'sessions') showSessions(item);
    else if (mode === 'readerOutline') renderReaderOutline(item);
    else if (mode === 'readerExport') renderReaderExport(item);
    else if (mode === 'ai') renderAIPanel(item);
    else if (mode === 'video') renderVideoSummaryPanel(item);
    else if (mode === 'media') renderMediaSummaryPanel(item);
    else if (mode === 'text-ai') renderTextAISummaryPanel(item);
    else showHistory(item);""",
    "reader/ai panel routing",
)

once(
    """      case 'help':
        if (!item.ui.panel.hidden && item.panelMode === 'help') closePanel(item, false);
        else openPanel(item, 'help');
        break;""",
    """      case 'ai':
        if (item.imageMode || item.bare) { toast(item, 'AI 助手只支持网页/阅读窗口'); break; }
        // The toolbar AI button is a webpage-summary action.  Open a real
        // standalone summary popup instead of silently opening the assistant
        // panel and waiting for a second click.
        if (typeof openQuickTextAISummary === 'function') {
          const summaryUrl = item.originalUrl || item.url || item.readerUrl || '';
          const summaryItem = openQuickTextAISummary(summaryUrl, item.title || item.fallbackTitle || document.title, {
            x: item.rect ? item.rect.x + 24 : undefined,
            y: item.rect ? item.rect.y + 24 : undefined
          });
          if (summaryItem) break;
        }
        if (!item.ui.panel.hidden && item.panelMode === 'ai') closePanel(item, false);
        else openPanel(item, 'ai');
        break;
      case 'outline':
        if (!item.isReaderMode) { toast(item, '先进入阅读模式'); break; }
        if (!item.ui.panel.hidden && item.panelMode === 'readerOutline') closePanel(item, false);
        else openPanel(item, 'readerOutline');
        break;
      case 'speak':
        toggleReaderSpeech(item);
        break;
      case 'saveReader':
        if (!item.isReaderMode) { toast(item, '先进入阅读模式'); break; }
        if (!item.ui.panel.hidden && item.panelMode === 'readerExport') closePanel(item, false);
        else openPanel(item, 'readerExport');
        break;
      case 'copyReader':
        copyReaderText(item);
        break;
      case 'downloadReader':
        downloadReaderText(item);
        break;
      case 'help':
        if (!item.ui.panel.hidden && item.panelMode === 'help') closePanel(item, false);
        else openPanel(item, 'help');
        break;""",
    "reader/ai actions",
)

once(
    "  function renderReaderOutline(item) {",
    """  function aiPageText(item, callback) {
    if (item.isReaderMode && item.readerSource) { callback(readerPlainText(item)); return; }
    const pageUrl = currentPageUrl(item) || item.originalUrl;
    if (!pageUrl) { callback(''); return; }
    // The current document is already parsed and rendered: summarize its text
    // directly instead of re-downloading the same page.  This removes the
    // dominant delay for the "summarize current page" action.
    try {
      const target = new URL(pageUrl, location.href);
      const here = new URL(location.href);
      if (target.origin === here.origin && target.pathname === here.pathname && target.search === here.search && document.body) {
        const currentText = String(document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20000);
        if (currentText.length >= 30) { callback(currentText); return; }
      }
    } catch (e) { /* fall back to fetch */ }
    const buildPlain = (html) => {
      try {
        const raw = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
        try {
          raw.querySelectorAll('script,style,noscript,iframe,svg,nav,aside,footer,header,form').forEach(node => node.remove());
        } catch (e) { /* ignore */ }
        let plain = String(raw.body ? (raw.body.innerText || raw.body.textContent || '') : '').replace(/\\s+/g, ' ').trim();
        if (!plain) {
          // Last-resort tag stripping for malformed documents where the body
          // was not parsed into a usable element.
          plain = String(html || '').replace(/<(script|style)[\\s\\S]*?<\\/\\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\\s+/g, ' ').trim();
        }
        return plain.slice(0, 20000);
      } catch (e) { return ''; }
    };
    let settled = false;
    const finish = (text, status) => {
      if (settled) return;
      settled = true;
      if (status >= 400) { callback(''); return; }
      callback(buildPlain(text));
    };
    // Same-origin pages are fastest and most reliable through the content
    // script's own fetch; cross-origin pages go through the worker below.
    let sameOrigin = false;
    try { sameOrigin = new URL(pageUrl, location.href).origin === location.origin; } catch (e) { sameOrigin = false; }
    if (sameOrigin) {
      try {
        fetch(pageUrl, { credentials: 'include' }).then(res => res.text().then(text => finish(text || '', res.status || 0))).catch(() => callback(''));
      } catch (e) { callback(''); }
      return;
    }
    // Extension: use the privileged worker fetch first.  It bypasses page CORS
    // and is usually much faster than a content-script fetch for cross-origin
    // links.  Fall back to the local fetch only if the worker cannot answer.
    if (typeof EXT !== 'undefined' && EXT && EXT.runtime && EXT.runtime.sendMessage) {
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: pageUrl, timeoutMs: 12000 }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          if (response && response.ok && response.text) finish(String(response.text), Number(response.status) || 200);
          else if (!settled) {
            settled = true;
            fetchPageText(pageUrl, (text, status) => { settled = false; finish(text || '', status || 0); }, () => callback(''));
          }
        });
        return;
      } catch (e) { /* fall through */ }
    }
    fetchPageText(pageUrl, (text, status) => finish(text || '', status || 0), () => callback(''));
  }
  function aiErrorText(res) {
    if (!res) return 'AI 请求失败：后台没有响应。';
    if (res.reason === 'missing-config') return '还没有配置 AI 接口。请打开设置 → AI 接口，填写接口地址、模型和 API Key。';
    if (res.reason === 'missing-key') return '接口和模型已默认配置，请打开设置 → AI 接口填写 API Key。';
    if (res.reason === 'timeout') return 'AI 请求超时。';
    return 'AI 请求失败：' + (res.detail || res.reason || '未知错误');
  }
  function stopAIPort(item) {
    if (typeof closeAIDropdowns === 'function') closeAIDropdowns();
    if (!item) return;
    if (item.aiPort) {
      try { item.aiPort.disconnect(); } catch (e) { /* ignore */ }
      item.aiPort = null;
    }
    if (item.aiTimer) { clearInterval(item.aiTimer); item.aiTimer = null; }
    item.aiBusy = false;
  }
  let activeAIDropdown = null;
  function closeAIDropdowns() {
    if (activeAIDropdown && activeAIDropdown.menu) activeAIDropdown.menu.hidden = true;
    activeAIDropdown = null;
  }
  function toggleAIDropdown(pill, menu) {
    if (!pill || !menu) return;
    if (activeAIDropdown && activeAIDropdown.menu !== menu) activeAIDropdown.menu.hidden = true;
    menu.hidden = !menu.hidden;
    activeAIDropdown = menu.hidden ? null : { pill, menu };
  }
  document.addEventListener('pointerdown', event => {
    if (!activeAIDropdown) return;
    const path = event.composedPath ? event.composedPath() : [];
    if (path.includes(activeAIDropdown.pill) || path.includes(activeAIDropdown.menu)) return;
    closeAIDropdowns();
  }, true);
  function markdownToHtml(source) {
    const esc = value => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const inline = text => {
      let value = esc(text);
      value = value.replace(/`([^`]+)`/g, (_, code) => '<code>' + code + '</code>');
      value = value.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      value = value.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
      value = value.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+|mailto:[^\\s)]+)\\)/g, (_, label, href) =>
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
      return value;
    };
    const lines = String(source || '').replace(/\\r\\n?/g, '\\n').split('\\n');
    const html = [];
    let paragraph = [];
    let list = '';
    let code = null;
    let codeLang = '';
    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push('<p>' + paragraph.map(inline).join('<br>') + '</p>');
      paragraph = [];
    };
    const closeList = () => {
      if (!list) return;
      html.push('</' + list + '>');
      list = '';
    };
    const closeCode = () => {
      if (code === null) return;
      html.push('<pre><code' + (codeLang ? ' class="language-' + esc(codeLang) + '"' : '') + '>' + esc(code.join('\\n')) + '</code></pre>');
      code = null;
      codeLang = '';
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (code !== null) {
        if (/^\\s*```/.test(line)) closeCode();
        else code.push(line);
        continue;
      }
      const fence = line.match(/^\\s*```([\\w-]*)\\s*$/);
      if (fence) {
        flushParagraph();
        closeList();
        code = [];
        codeLang = fence[1] || '';
        continue;
      }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      const heading = line.match(/^(#{1,6})\\s+(.+)$/);
      if (heading) {
        flushParagraph();
        closeList();
        html.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>');
        continue;
      }
      if (/^\\s*(?:---+|\\*\\*\\*+)\\s*$/.test(line)) {
        flushParagraph();
        closeList();
        html.push('<hr>');
        continue;
      }
      const bullet = line.match(/^\\s*[-*+]\\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push('<li>' + inline(bullet[1]) + '</li>');
        continue;
      }
      const ordered = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
      if (ordered) {
        flushParagraph();
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push('<li>' + inline(ordered[1]) + '</li>');
        continue;
      }
      const quote = line.match(/^\\s*>\\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        html.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
        continue;
      }
      paragraph.push(line);
    }
    flushParagraph();
    closeList();
    closeCode();
    return html.join('');
  }
  function aiProviderConfig(providerId) {
    const id = providerId || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
    const preset = AI_PROVIDERS.find(p => p.id === id) || AI_PROVIDERS[0];
    const saved = (aiConfig.providerConfigs && aiConfig.providerConfigs[id]) || {};
    return {
      id,
      label: preset.label,
      endpoint: saved.endpoint || (id === aiConfig.provider ? aiConfig.endpoint : '') || preset.endpoint || '',
      model: saved.model || (id === aiConfig.provider ? aiConfig.model : '') || preset.model || '',
      key: String((aiConfig.apiKeys && aiConfig.apiKeys[id]) || (id === aiConfig.provider ? aiConfig.apiKey : '') || '')
    };
  }
  function aiPanelModels(providerId) {
    const cfg = aiProviderConfig(providerId);
    return Array.from(new Set([cfg.model].concat((aiConfig.models && aiConfig.models[cfg.id]) || []).filter(Boolean)));
  }
  function runAIAction(item, action, question, out, meta, status) {
    if (!out || item.aiBusy) return;
    const ask = String(question || '').trim();
    if (action === 'ask' && !ask) { out.textContent = '请先输入问题。'; return; }
    stopAIPort(item);
    item.aiBusy = true;
    item.aiAnswer = '';
    item.aiScrolled = false;
    out.dataset.tone = '';
    out.textContent = '正在读取页面正文…';
    if (status) { status.textContent = '正在读取页面正文…'; delete status.dataset.tone; }
    out.classList.remove('markdown');
    out.classList.add('streaming');
    if (typeof showStreamDots === 'function') showStreamDots(item, out);
    if (meta) meta.textContent = '准备中…';
    aiPageText(item, text => {
      if (item.closed) return;
      if (!text) {
        item.aiBusy = false;
        out.classList.remove('streaming');
        out.classList.remove('markdown');
        out.dataset.tone = 'bad';
        out.textContent = '无法读取此页正文。请确认页面允许抓取，或先在阅读模式中打开。';
        if (meta) meta.textContent = '';
        return;
      }
      out.textContent = '正在请求 AI 接口…';
      if (status) status.textContent = '正文已读取，正在流式生成总结…';
      const vendorId = item.aiVendor || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
      const vendorCfg = aiProviderConfig(vendorId);
      const request = {
        action: action,
        text: text.slice(0, 20000),
        question: ask.slice(0, 2000),
        title: String(item.title || item.fallbackTitle || ''),
        url: currentPageUrl(item) || item.originalUrl || item.url || '',
        provider: vendorId,
        endpoint: vendorCfg.endpoint,
        model: item.aiSelectedModel || vendorCfg.model,
        summaryPrompt: action === 'summary'
          ? String((item.ui.panel.querySelector('.ai-summary-prompt') || {}).value || item.aiSummaryPrompt || '').trim()
          : ''
      };
      const started = Date.now();
      let finished = false;
      let port = null;
      const cleanup = () => {
        if (item.aiTimer) { clearInterval(item.aiTimer); item.aiTimer = null; }
        if (item.aiPort === port) item.aiPort = null;
        try { if (port) port.disconnect(); } catch (e) { /* ignore */ }
      };
      const setLiveMeta = () => {
        if (meta && !finished) meta.textContent = '生成中 · 已用 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒';
      };
      try {
        port = EXT.runtime.connect({ name: 'ldp-ai-stream' });
      } catch (e) {
        item.aiBusy = false;
        out.classList.remove('streaming');
        out.dataset.tone = 'bad';
        out.textContent = 'AI 请求发送失败：当前环境不支持流式连接。';
        if (meta) meta.textContent = '';
        return;
      }
      item.aiPort = port;
      item.aiTimer = setInterval(setLiveMeta, 200);
      port.onMessage.addListener(msg => {
        if (!msg) return;
        if (msg.type === 'delta') {
          if (!item.aiAnswer) out.textContent = '';
          item.aiAnswer += String(msg.text || '');
          out.innerHTML = markdownToHtml(item.aiAnswer);
          out.classList.add('markdown');
          if (typeof showStreamDots === 'function') showStreamDots(item, out);
          out.scrollTop = out.scrollHeight;
          if (!item.aiScrolled) {
            item.aiScrolled = true;
            setTimeout(() => { try { out.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }, 20);
          }
          if (meta) meta.textContent = '生成中 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
          if (status) status.textContent = '正在生成总结 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
          return;
        }
        if (msg.type === 'done') {
          finished = true;
          item.aiBusy = false;
          out.classList.remove('streaming');
          out.dataset.tone = 'good';
          if (!item.aiAnswer) out.textContent = 'AI 没有返回内容。';
          else out.innerHTML = markdownToHtml(item.aiAnswer);
          out.classList.add('markdown');
          try { out.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ }
          if (meta) meta.textContent = '已加载完成 · 网页正文 · 用时 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒' + (msg.model ? ' · ' + msg.model : '');
          if (status) { status.textContent = '已加载完成'; delete status.dataset.tone; }
          if (typeof hideStreamDots === 'function') hideStreamDots(item);
          cleanup();
          return;
        }
        if (msg.type === 'error') {
          finished = true;
          item.aiBusy = false;
          out.classList.remove('streaming');
          out.classList.remove('markdown');
          out.dataset.tone = 'bad';
          out.textContent = aiErrorText(msg);
          if (typeof hideStreamDots === 'function') hideStreamDots(item);
          if (status) status.textContent = '总结失败';
          if (meta) meta.textContent = '';
          cleanup();
        }
      });
      port.onDisconnect.addListener(() => {
        if (finished) return;
        finished = true;
        item.aiBusy = false;
        out.classList.remove('streaming');
        out.dataset.tone = 'bad';
        if (!item.aiAnswer) out.textContent = 'AI 连接已断开，请重试。';
        if (status) status.textContent = '总结失败';
        if (meta) meta.textContent = '';
        cleanup();
      });
      try {
        port.postMessage({ type: 'start', request });
      } catch (e) {
        finished = true;
        item.aiBusy = false;
        out.classList.remove('streaming');
        out.dataset.tone = 'bad';
        out.textContent = 'AI 请求发送失败。';
        if (status) status.textContent = '总结失败';
        if (meta) meta.textContent = '';
        cleanup();
      }
    });
  }
  function renderAIPanel(item) {
    item.panelMode = 'ai';
    const body = panelFrame(item, 'AI 页面助手');
    item.ui.panel.classList.add('ai-panel');
    body.appendChild(el('p', 'note', '流式读取当前预览页正文，并发送给你配置的 OpenAI 兼容接口；API Key 只保存在本机。'));
    const promptBox = el('div', 'ai-prompt-box');
    const promptHead = el('div', 'ai-prompt-head');
    promptHead.appendChild(el('span', 'ai-prompt-label', '总结提示词'));
    const promptPreview = el('span', 'ai-prompt-preview', '');
    promptHead.appendChild(promptPreview);
    const togglePrompt = el('button', 'ai-prompt-toggle', '编辑');
    togglePrompt.type = 'button';
    const resetPrompt = el('button', 'ai-prompt-reset', '恢复默认');
    resetPrompt.type = 'button';
    promptHead.appendChild(togglePrompt);
    promptHead.appendChild(resetPrompt);
    const promptInput = el('textarea', 'ai-summary-prompt');
    promptInput.rows = 2;
    promptInput.value = item.aiSummaryPrompt || aiConfig.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
    item.aiSummaryPrompt = promptInput.value;
    promptInput.hidden = !item.aiPromptOpen;
    const syncPromptPreview = () => {
      const value = promptInput.value.trim();
      promptPreview.textContent = value.length > 46 ? value.slice(0, 46) + '…' : value;
    };
    syncPromptPreview();
    togglePrompt.addEventListener('click', () => {
      item.aiPromptOpen = !item.aiPromptOpen;
      promptInput.hidden = !item.aiPromptOpen;
      togglePrompt.textContent = item.aiPromptOpen ? '收起' : '编辑';
      if (item.aiPromptOpen) promptInput.focus();
    });
    promptInput.addEventListener('input', () => {
      item.aiSummaryPrompt = promptInput.value;
      syncPromptPreview();
    });
    promptInput.addEventListener('change', () => {
      item.aiSummaryPrompt = promptInput.value.trim() || DEFAULT_SUMMARY_PROMPT;
      promptInput.value = item.aiSummaryPrompt;
      aiConfig.summaryPrompt = item.aiSummaryPrompt;
      syncPromptPreview();
      writeStore(AI_CONFIG_KEY, aiConfig);
    });
    resetPrompt.addEventListener('click', () => {
      item.aiSummaryPrompt = DEFAULT_SUMMARY_PROMPT;
      promptInput.value = DEFAULT_SUMMARY_PROMPT;
      aiConfig.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
      syncPromptPreview();
      writeStore(AI_CONFIG_KEY, aiConfig);
    });
    promptBox.appendChild(promptHead);
    promptBox.appendChild(promptInput);
    body.appendChild(promptBox);
    const actions = el('div', 'ai-actions');
    const out = el('div', 'ai-answer');
    const meta = el('div', 'ai-meta');
    const activeProviderId = item.aiVendor || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
    item.aiVendor = activeProviderId;
    item.aiSelectedModel = (aiConfig.selectedModels && aiConfig.selectedModels[activeProviderId]) || aiConfig.model || item.aiSelectedModel;
    const vendorRow = el('div', 'ai-vendor-row');
    const vendorPill = el('button', 'ai-vendor-pill');
    vendorPill.type = 'button';
    const vendorDot = el('span', 'ai-vendor-dot');
    const vendorName = el('span', 'ai-vendor-name', (AI_PROVIDERS.find(p => p.id === activeProviderId) || AI_PROVIDERS[0]).label);
    const vendorChevron = el('span', 'ai-vendor-chevron', '⌄');
    vendorPill.appendChild(vendorDot);
    vendorPill.appendChild(vendorName);
    vendorPill.appendChild(vendorChevron);
    const vendorMenu = el('div', 'ai-provider-menu');
    vendorMenu.hidden = true;
    for (const p of AI_PROVIDERS) {
      const choice = el('button', 'ai-provider-choice' + (p.id === activeProviderId ? ' active' : ''), p.label);
      choice.type = 'button';
      choice.dataset.aiVendorChoice = p.id;
      choice.addEventListener('click', () => {
        item.aiVendor = p.id;
        vendorName.textContent = p.label;
        vendorMenu.hidden = true;
        activeAIDropdown = null;
        vendorMenu.querySelectorAll('.ai-provider-choice').forEach(x => x.classList.toggle('active', x === choice));
        item.aiSelectedModel = '';
        rebuildModels(p.id);
      });
      vendorMenu.appendChild(choice);
    }
    vendorPill.addEventListener('click', () => toggleAIDropdown(vendorPill, vendorMenu));
    vendorRow.appendChild(vendorPill);
    vendorRow.appendChild(vendorMenu);
    const modelRow = el('div', 'ai-model-row');
    const modelLabel = el('span', 'ai-model-label', '模型');
    const modelTrigger = el('button', 'ai-model-trigger');
    modelTrigger.type = 'button';
    const modelPopover = el('div', 'ai-model-popover');
    modelPopover.hidden = true;
    const modelSearch = el('input', 'ai-model-popover-search');
    modelSearch.type = 'text';
    modelSearch.placeholder = '搜索模型…';
    const modelOptionsBox = el('div', 'ai-model-popover-list');
    modelPopover.appendChild(modelSearch);
    modelPopover.appendChild(modelOptionsBox);
    let currentModels = [];
    const filterModelOptions = () => {
      const q = modelSearch.value.trim().toLowerCase();
      modelOptionsBox.querySelectorAll('[data-ai-model-option]').forEach(btn => {
        btn.hidden = !!q && !String(btn.textContent || '').toLowerCase().includes(q);
      });
    };
    const rebuildModels = providerId => {
      const cfg = aiProviderConfig(providerId);
      currentModels = aiPanelModels(providerId);
      modelOptionsBox.innerHTML = '';
      for (const id of currentModels) {
        const option = el('button', 'ai-model-option' + (id === item.aiSelectedModel ? ' active' : ''), id);
        option.type = 'button';
        option.dataset.aiModelOption = id;
        option.title = id;
        option.addEventListener('click', () => {
          item.aiSelectedModel = id;
          const providerId = item.aiVendor || activeProviderId;
          aiConfig.selectedModels = Object.assign({}, aiConfig.selectedModels || {}, { [providerId]: id });
          writeStore(AI_CONFIG_KEY, aiConfig);
          modelTrigger.textContent = id;
          modelOptionsBox.querySelectorAll('[data-ai-model-option]').forEach(x => x.classList.toggle('active', x === option));
          modelPopover.hidden = true;
          activeAIDropdown = null;
        });
        modelOptionsBox.appendChild(option);
      }
      const preferredModel = (aiConfig.selectedModels && aiConfig.selectedModels[providerId]) || cfg.model;
      if (!currentModels.includes(item.aiSelectedModel) || providerId !== item.aiVendor) {
        item.aiSelectedModel = currentModels.includes(preferredModel) ? preferredModel : (currentModels[0] || cfg.model || '');
      }
      modelTrigger.textContent = item.aiSelectedModel || '选择模型';
      modelSearch.value = '';
      filterModelOptions();
    };
    modelSearch.addEventListener('input', filterModelOptions);
    modelTrigger.addEventListener('click', () => {
      if (!currentModels.length) return;
      toggleAIDropdown(modelTrigger, modelPopover);
      if (!modelPopover.hidden) setTimeout(() => { try { modelSearch.focus(); } catch (e) { /* ignore */ } }, 20);
    });
    rebuildModels(activeProviderId);
    modelRow.appendChild(modelLabel);
    modelRow.appendChild(modelTrigger);
    modelRow.appendChild(modelPopover);
    body.appendChild(vendorRow);
    body.appendChild(modelRow);
    out.textContent = '选择「总结」「翻译」或输入问题后开始。';
    meta.textContent = '输出会逐字显示，并统计用时';
    const addAction = (action, label) => {
      const btn = el('button', 'text-button', label);
      btn.type = 'button';
      btn.addEventListener('click', () => runAIAction(item, action, '', out, meta));
      actions.appendChild(btn);
    };
    addAction('summary', '总结这页');
    addAction('translate', '翻译为中文');
    body.appendChild(actions);
    const ta = el('textarea', 'ai-question');
    ta.rows = 3;
    ta.placeholder = '针对这页内容提问，例如：这篇文章的核心结论是什么？';
    body.appendChild(ta);
    const askRow = el('div', 'ai-ask-row');
    const askBtn = el('button', 'text-button primary-text', '提问');
    askBtn.type = 'button';
    askBtn.addEventListener('click', () => runAIAction(item, 'ask', ta.value, out, meta));
    const copyBtn = el('button', 'text-button', '复制回答');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      if (!item.aiAnswer) return;
      toast(item, T.copy(item.aiAnswer) ? '回答已复制' : '复制失败');
    });
    askRow.appendChild(askBtn);
    askRow.appendChild(copyBtn);
    body.appendChild(askRow);
    body.appendChild(out);
    body.appendChild(meta);
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function renderReaderOutline(item) {""",
    "AI panel and request",
)

once(
    "  function closeWindow(item, silent) {",
    "  function closeWindow(item, silent) {\n    stopReaderSpeech(item);\n    stopAIPort(item);",
    "stop reader speech and AI on close",
)

once(
    "  function closePanel(item, commit) {\n    if (!item",
    "  function closePanel(item, commit) {\n    stopAIPort(item);\n    if (!item",
    "stop AI when panel closes",
)

once(
    """  function renderSettings(item) {
    item.panelMode = 'settings';
    const hidden = new Set(settings.unifyAnim ? ['animation', 'closeAnimation', 'pipAnimation'] : ['unifiedAnim']);
    if (settings.theme !== 'auto') ['themeSource', 'themeFollow'].forEach(k => hidden.add(k));
    const rows = FIELDS.map(f => {
      if (f.length === 1) return `<h4>${f[0]}</h4>`;
      const [name, label, type, options, placeholder] = f;
      if (hidden.has(name)) return '';
      // v20.2：type='note' 是「只解释、不可调」的说明行（不生成控件、也不参与赋值循环）
      if (type === 'note') return `<div class="note" style="margin:-6px 0 10px">${label}</div>`;
      return `<div class="row"><span>${label}</span>${controlHtml(name, type, options, placeholder)}</div>`;
    }).join('');
    let diag = '';
    if (settings.theme === 'auto') {
      const rep = themeReport();
      diag = `<h4>主题诊断（取色结果不对时看这里）</h4><div class="note">当前识别：<b>${rep.label}</b>（${rep.mode}）<br>依据：${rep.reasons}<br>页面底色：${rep.base}　界面色调：${rep.tint}</div>`;
    }
    const body = panelFrame(item, '设置 v' + SCRIPT_VERSION);
    body.innerHTML = rows + diag + actionGroupsHtml(SETTINGS_ACTIONS);
    body.querySelectorAll('[data-setting]').forEach(input => {
      const v = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = String(v);
    });
  }""",
    """  function domainEditorHtml(name, label) {
    const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const values = String(settings[name] || '').split(/[\\s,，]+/).filter(Boolean);
    return `<div class="row domain-editor-row" data-domain-row="${name}"><span>${label}</span><div class="domain-editor"><div class="domain-list" data-domain-list>${values.map(value => `<div class="domain-item" data-domain-item><input class="domain-value" value="${esc(value)}" spellcheck="false"><button type="button" class="domain-remove" data-domain-remove title="删除">×</button></div>`).join('')}</div><div class="domain-add-row"><input class="domain-input" data-domain-input placeholder="粘贴网址或域名，例如 https://example.com/path" autocomplete="off"><button type="button" class="text-button" data-domain-add>提取并添加</button></div><input type="hidden" data-setting="${name}" value="${esc(values.join(', '))}"></div></div>`;
  }
  function renderSettings(item) {
    item.panelMode = 'settings';
    const hidden = new Set(settings.unifyAnim ? ['animation', 'closeAnimation', 'pipAnimation'] : ['unifiedAnim']);
    if (settings.theme !== 'auto') ['themeSource', 'themeFollow'].forEach(k => hidden.add(k));
    const groups = [];
    let current = null;
    for (const f of FIELDS) {
      if (f.length === 1) {
        current = { title: f[0], rows: [] };
        groups.push(current);
        continue;
      }
      if (!current) { current = { title: '常规', rows: [] }; groups.push(current); }
      const [name, label, type, options, placeholder] = f;
      if (hidden.has(name)) continue;
      if (type === 'note') { current.rows.push(`<div class="note settings-note">${label}</div>`); continue; }
      if (name === 'aiQuickWhitelist' || name === 'aiQuickBlacklist') { current.rows.push(domainEditorHtml(name, label)); continue; }
      current.rows.push(`<div class="row"><span>${label}</span>${controlHtml(name, type, options, placeholder)}</div>`);
    }
    if (settings.theme === 'auto') {
      const rep = themeReport();
      groups.push({
        title: '主题诊断',
        rows: [`<div class="settings-diagnostic">当前识别：<b>${rep.label}</b>（${rep.mode}）<br>依据：${rep.reasons}<br>页面底色：${rep.base}　界面色调：${rep.tint}</div>`]
      });
    }
    const activeProvider = AI_PROVIDERS.find(p => p.id === (aiConfig.provider || DEFAULT_AI_CONFIG.provider)) || AI_PROVIDERS[0];
    groups.splice(1, 0, {
      title: 'AI 接口',
      rows: [
        `<div class="settings-ai-fields">
          <div class="settings-ai-provider-select">
            <button type="button" class="settings-ai-provider-pill" data-ai-provider-toggle><span class="settings-ai-provider-label">${activeProvider.label}</span><span class="settings-ai-provider-chevron">⌄</span></button>
            <div class="settings-ai-provider-menu" data-ai-provider-menu hidden>${AI_PROVIDERS.map(p => `<button type="button" class="settings-ai-provider${p.id === activeProvider.id ? ' active' : ''}" data-ai-provider="${p.id}">${p.label}</button>`).join('')}</div>
          </div>
          <div class="settings-ai-field"><span>接口地址</span><input type="url" data-ai-key="endpoint" value="${String(aiConfig.endpoint || activeProvider.endpoint).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${activeProvider.endpoint}" autocomplete="off"></div>
          <div class="settings-ai-field"><span>模型</span><div class="settings-ai-model-row"><input type="text" data-ai-key="model" value="${String(aiConfig.model || activeProvider.model).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="${activeProvider.model}" autocomplete="off"><button type="button" class="text-button" data-action="listModels">拉取模型</button></div><input type="text" class="settings-ai-model-search" data-ai-model-search placeholder="搜索模型…" autocomplete="off" hidden><div class="settings-ai-model-status" data-ai-model-status></div><div class="settings-ai-model-list" data-ai-model-list hidden></div></div>
          <div class="settings-ai-field"><span>API Key <small>仅保存在本机；本地 Ollama 可留空</small></span><div class="settings-ai-inline"><input type="password" data-ai-key="apiKey" value="${String((aiConfig.apiKeys && aiConfig.apiKeys[activeProvider.id]) || (aiConfig.provider === activeProvider.id ? aiConfig.apiKey : '') || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="sk-..." autocomplete="new-password"><button type="button" class="text-button" data-action="testAIKey">测试</button></div></div>
          <div class="settings-ai-field"><span>媒体总结 API Key <small>硅基流动 · 单独配置与测试</small></span><div class="settings-ai-inline"><input type="password" data-ai-key="mediaApiKey" value="${String(aiConfig.mediaApiKey || (aiConfig.apiKeys && aiConfig.apiKeys.siliconflow) || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="填写硅基流动 API Key" autocomplete="new-password"><button type="button" class="text-button" data-action="testMediaKey">测试</button></div></div>
          <div class="settings-ai-field"><span>媒体总结模型 <small>音频转写或视频理解模型</small></span><input type="text" data-ai-key="mediaModel" list="mediaModelOptions" value="${String(aiConfig.mediaModel || 'FunAudioLLM/SenseVoiceSmall').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="FunAudioLLM/SenseVoiceSmall" autocomplete="off"><datalist id="mediaModelOptions"><option value="FunAudioLLM/SenseVoiceSmall"></option><option value="TeleAI/TeleSpeechASR"></option><option value="Qwen/Qwen3-Omni-30B-A3B-Thinking"></option></datalist><div class="settings-ai-model-row"><input type="text" class="settings-ai-model-search" data-media-model-search placeholder="搜索媒体模型…" autocomplete="off" hidden><button type="button" class="text-button" data-action="listMediaModels">拉取媒体模型</button></div><div class="settings-ai-model-status" data-media-model-status></div><div class="settings-ai-model-list" data-media-model-list hidden></div></div>
          <div class="settings-ai-field"><span>音频转写接口 <small>硅基流动 ASR 上传地址</small></span><input type="url" data-ai-key="mediaEndpoint" value="${String(aiConfig.mediaEndpoint || 'https://api.siliconflow.cn/v1/audio/transcriptions').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="https://api.siliconflow.cn/v1/audio/transcriptions" autocomplete="off"></div>
          <div class="settings-ai-field"><span>音频总结提示词 <small>留空使用默认模板</small></span><input type="text" data-ai-key="mediaAudioPrompt" value="${String(aiConfig.mediaAudioPrompt || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="完整转写 + 结构化总结" autocomplete="off"></div>
          <div class="settings-ai-field"><span>视频总结提示词 <small>留空使用默认模板</small></span><input type="text" data-ai-key="mediaVideoPrompt" value="${String(aiConfig.mediaVideoPrompt || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="概述 + 关键节点 + 结论 + 画面文字" autocomplete="off"></div>
        </div>`
      ]
    });
    groups.push({ title: '操作与维护', rows: [actionGroupsHtml(SETTINGS_ACTIONS)] });
    let active = Number.isInteger(item.settingsGroup) ? item.settingsGroup : 0;
    if (active < 0 || active >= groups.length) active = 0;
    item.settingsGroup = active;
    const nav = groups.map((g, i) =>
      `<button type="button" class="settings-nav-item${i === active ? ' active' : ''}" data-settings-tab="${i}">${g.title}</button>`
    ).join('');
    const sections = groups.map((g, i) =>
      `<section class="settings-group${i === active ? ' active' : ''}" data-settings-group="${i}"><h3>${g.title}</h3>${g.rows.join('')}</section>`
    ).join('');
    const body = panelFrame(item, '设置 v' + SCRIPT_VERSION, item.settingsStandalone ? 'close' : 'closePanel');
    item.ui.panel.classList.add('settings-panel');
    const aiGroupIndex = groups.findIndex(g => g.title === 'AI 接口');
    body.innerHTML = `<div class="settings-hint">修改即时生效 · 只保存在本机</div><div class="settings-layout"><nav class="settings-nav">${nav}</nav><div class="settings-content">${sections}</div></div><div class="settings-ai-footer" ${active === aiGroupIndex ? '' : 'hidden'}><span data-ai-test-status>AI 配置只保存在本机</span><button type="button" class="text-button" data-action="testAI">测试连接</button><button type="button" class="text-button" data-action="saveAI">保存 AI 接口</button></div>`;
    body.querySelectorAll('[data-setting]').forEach(input => {
      const v = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = String(v);
    });
    body.querySelectorAll('[data-domain-row]').forEach(row => {
      const name = row.dataset.domainRow;
      const list = row.querySelector('[data-domain-list]');
      const addInput = row.querySelector('[data-domain-input]');
      const addButton = row.querySelector('[data-domain-add]');
      const normalizeDomain = raw => {
        let value = String(raw || '').trim();
        if (!value) return '';
        value = value.replace(/^\\*\\./, '');
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
        try {
          const parsed = new URL(value);
          return String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
        } catch (e) { return ''; }
      };
      const read = () => Array.from(list.querySelectorAll('.domain-value')).map(input => input.value.trim()).filter(Boolean);
      const persist = () => updateSetting(item, name, read().join(', '));
      const bindItem = itemRow => {
        const field = itemRow.querySelector('.domain-value');
        const remove = itemRow.querySelector('[data-domain-remove]');
        field.addEventListener('change', () => {
          const value = normalizeDomain(field.value);
          if (!value) { itemRow.remove(); persist(); return; }
          field.value = value;
          persist();
        });
        remove.addEventListener('click', () => { itemRow.remove(); persist(); });
      };
      list.querySelectorAll('[data-domain-item]').forEach(bindItem);
      const add = () => {
        const value = normalizeDomain(addInput.value);
        if (!value) { toast(item, '请输入有效的网址或域名'); return; }
        if (read().includes(value)) { toast(item, '该域名已在列表中'); addInput.value = ''; return; }
        const itemRow = document.createElement('div');
        itemRow.className = 'domain-item';
        itemRow.dataset.domainItem = '';
        itemRow.innerHTML = `<input class="domain-value" value="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" spellcheck="false"><button type="button" class="domain-remove" data-domain-remove title="删除">×</button>`;
        bindItem(itemRow);
        list.appendChild(itemRow);
        addInput.value = '';
        persist();
      };
      addButton.addEventListener('click', add);
      addInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); add(); }
      });
    });
    body.querySelectorAll('[data-settings-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.settingsTab);
        item.settingsGroup = idx;
        body.querySelectorAll('[data-settings-tab]').forEach(x => x.classList.toggle('active', x === btn));
        body.querySelectorAll('[data-settings-group]').forEach(x => x.classList.toggle('active', Number(x.dataset.settingsGroup) === idx));
        const aiFooter = body.querySelector('.settings-ai-footer');
        if (aiFooter) aiFooter.hidden = idx !== aiGroupIndex;
      });
    });
    const aiProviderPill = body.querySelector('[data-ai-provider-toggle]');
    const aiProviderMenu = body.querySelector('[data-ai-provider-menu]');
    if (aiProviderPill && aiProviderMenu) {
      aiProviderPill.addEventListener('click', () => toggleAIDropdown(aiProviderPill, aiProviderMenu));
    }
    body.querySelectorAll('[data-ai-provider]').forEach(btn => {
      btn.addEventListener('click', () => {
        const provider = AI_PROVIDERS.find(p => p.id === btn.dataset.aiProvider);
        if (!provider) return;
        item.aiProvider = provider.id;
        if (aiProviderMenu) aiProviderMenu.hidden = true;
        activeAIDropdown = null;
        if (aiProviderPill) {
          const label = aiProviderPill.querySelector('.settings-ai-provider-label');
          if (label) label.textContent = provider.label;
        }
        body.querySelectorAll('[data-ai-provider]').forEach(x => x.classList.toggle('active', x === btn));
        const endpoint = body.querySelector('[data-ai-key="endpoint"]');
        if (endpoint) endpoint.value = provider.endpoint;
        const model = body.querySelector('[data-ai-key="model"]');
        if (model) {
          if (model.tagName === 'SELECT') {
            const input = document.createElement('input');
            input.type = 'text';
            input.dataset.aiKey = 'model';
            input.value = provider.model;
            input.autocomplete = 'off';
            model.replaceWith(input);
          } else {
            model.value = provider.model;
          }
        }
        const key = body.querySelector('[data-ai-key="apiKey"]');
        if (key) key.value = String((aiConfig.apiKeys && aiConfig.apiKeys[provider.id]) || (aiConfig.provider === provider.id ? aiConfig.apiKey : '') || '');
        const status = body.querySelector('[data-ai-model-status]');
        if (status) status.textContent = '已切换服务商，填写 Key 后可拉取模型';
      });
    });
  }""",
    "modern settings panel",
)

once(
    "    const panel = item.ui.panel;\n    panel.textContent = '';",
    "    const panel = item.ui.panel;\n    panel.classList.remove('settings-panel');\n    panel.classList.remove('ai-panel');\n    panel.textContent = '';",
    "reset settings panel class",
)

once(
    """  function renderGeometry(item, force) {
    const r = item.rect;
    const prev = item.lastRect;""",
    """  function renderGeometry(item, force) {
    const r = item.rect;
    // Keep the outside-left command rail on screen.  Without this, a window
    // near the left edge would flip the rail to the right (or inside), which
    // defeats the fixed-left layout the user asked for.  Maximized windows
    // still fall back to the inside mode because they have no room.
    const rv = viewport();
    if (!item.pip && !(item.ui && item.ui.win && item.ui.win.classList.contains('summary-window')) && r.w < rv.w - 2) {
      const railGap = 64;
      const maxW = Math.max(280, rv.w - railGap - 8);
      if (r.w > maxW) r.w = maxW;
      if (r.x < railGap) r.x = railGap;
      if (r.x + r.w > rv.w - 8) r.x = Math.max(railGap, rv.w - r.w - 8);
    }
    const prev = item.lastRect;""",
    "reserve left rail room",
)

once(
    "  const SESSIONS_KEY = STORE + '_SESSIONS';",
    "  const SESSIONS_KEY = STORE + '_SESSIONS';\n  const AI_CONFIG_KEY = STORE + '_AI';\n  const AI_PROVIDERS = [\n    { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },\n    { id: 'siliconflow', label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3' },\n    { id: 'qwen', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },\n    { id: 'kimi', label: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },\n    { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },\n    { id: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2' },\n    { id: 'custom', label: '自定义接口', endpoint: '', model: '' }\n  ];\n  const DEFAULT_SUMMARY_PROMPT = '请总结下面网页正文的核心观点、关键事实和结论，控制在简洁的要点中。';\n"
    "const DEFAULT_AI_CONFIG = { provider: 'deepseek', endpoint: AI_PROVIDERS[0].endpoint, model: AI_PROVIDERS[0].model, apiKey: '', apiKeys: {}, models: {}, providerConfigs: {}, selectedModels: {}, mediaApiKey: '', mediaModel: 'FunAudioLLM/SenseVoiceSmall', mediaEndpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions', summaryPrompt: DEFAULT_SUMMARY_PROMPT };",
    "AI config key",
)

once(
    "  let sessions = readStore(SESSIONS_KEY, {});",
    "  let sessions = readStore(SESSIONS_KEY, {});\n  let aiConfig = Object.assign({}, DEFAULT_AI_CONFIG, readStore(AI_CONFIG_KEY, {}));\n  if (aiConfig.mediaEndpoint && /chat\\/completions/i.test(aiConfig.mediaEndpoint)) { aiConfig.mediaEndpoint = 'https://api.siliconflow.cn/v1/audio/transcriptions'; if (!aiConfig.mediaModel || /Qwen3-Omni/i.test(String(aiConfig.mediaModel || ''))) aiConfig.mediaModel = 'FunAudioLLM/SenseVoiceSmall'; }",
    "AI config state",
)

once(
    "      const freshLayouts = readStore(LAYOUTS_KEY, {});",
    "      aiConfig = Object.assign({}, DEFAULT_AI_CONFIG, readStore(AI_CONFIG_KEY, {}));\n      if (aiConfig.mediaEndpoint && /chat\\/completions/i.test(aiConfig.mediaEndpoint)) { aiConfig.mediaEndpoint = 'https://api.siliconflow.cn/v1/audio/transcriptions'; if (!aiConfig.mediaModel || /Qwen3-Omni/i.test(String(aiConfig.mediaModel || ''))) aiConfig.mediaModel = 'FunAudioLLM/SenseVoiceSmall'; }\n      const freshLayouts = readStore(LAYOUTS_KEY, {});",
    "AI config reload",
)

once(
    """      case 'settings':
        if (!item.ui.panel.hidden && item.panelMode === 'settings') closePanel(item, true);
        else openPanel(item, 'settings');
        break;""",
    """      case 'settings':
        if (!item.ui.panel.hidden && item.panelMode === 'settings') closePanel(item, true);
        else openPanel(item, 'settings');
        break;
      case 'saveAI': {
        const read = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const endpoint = read('endpoint') || DEFAULT_AI_CONFIG.endpoint;
        if (endpoint && !/^https?:\\/\\//i.test(endpoint)) { toast(item, 'AI 接口地址必须以 http:// 或 https:// 开头'); break; }
        const provider = item.aiProvider || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
        const apiKey = read('apiKey');
        const apiKeys = Object.assign({}, aiConfig.apiKeys || {});
        apiKeys[provider] = apiKey;
        const providerConfigs = Object.assign({}, aiConfig.providerConfigs || {});
        providerConfigs[provider] = { endpoint, model: read('model') || DEFAULT_AI_CONFIG.model };
        aiConfig = { provider, endpoint, model: read('model') || DEFAULT_AI_CONFIG.model, apiKey, apiKeys, models: aiConfig.models || {}, providerConfigs, selectedModels: aiConfig.selectedModels || {}, mediaApiKey: read('mediaApiKey') || aiConfig.mediaApiKey || '', mediaModel: read('mediaModel') || aiConfig.mediaModel || DEFAULT_AI_CONFIG.mediaModel, mediaEndpoint: read('mediaEndpoint') || aiConfig.mediaEndpoint || DEFAULT_AI_CONFIG.mediaEndpoint, mediaAudioPrompt: read('mediaAudioPrompt') || aiConfig.mediaAudioPrompt || '', mediaVideoPrompt: read('mediaVideoPrompt') || aiConfig.mediaVideoPrompt || '', summaryPrompt: aiConfig.summaryPrompt || DEFAULT_SUMMARY_PROMPT };
        writeStore(AI_CONFIG_KEY, aiConfig);
        toast(item, 'AI 接口设置已保存');
        renderSettings(item);
        break;
      }
      case 'listModels': {
        const get = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const endpoint = get('endpoint') || DEFAULT_AI_CONFIG.endpoint;
        const key = get('apiKey');
        const status = item.ui.panel.querySelector('[data-ai-model-status]');
        if (!endpoint) { toast(item, '请先填写接口地址'); break; }
        if (status) status.textContent = '正在从云端拉取模型…';
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:listModels', endpoint, apiKey: key }, res => {
            let lastError = null;
            try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
            if (lastError || !res) { if (status) status.textContent = '拉取失败：后台没有响应'; return; }
            if (!res.ok) { if (status) status.textContent = '拉取失败：' + (res.detail || res.reason || '未知错误'); return; }
            const models = Array.isArray(res.models) ? res.models.filter(Boolean).slice(0, 300) : [];
            if (!models.length) { if (status) status.textContent = '接口没有返回模型列表，可手动填写模型名'; return; }
            const provider = item.aiProvider || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
            const modelValue = get('model') || DEFAULT_AI_CONFIG.model;
            const apiKeys = Object.assign({}, aiConfig.apiKeys || {});
            apiKeys[provider] = key;
            const providerConfigs = Object.assign({}, aiConfig.providerConfigs || {});
            providerConfigs[provider] = { endpoint, model: modelValue };
            aiConfig = Object.assign({}, aiConfig, {
              provider,
              endpoint,
              model: modelValue,
              apiKey: key,
              apiKeys,
              models: Object.assign({}, aiConfig.models || {}, { [provider]: models }),
              providerConfigs
            });
            const row = item.ui.panel.querySelector('.settings-ai-model-row');
            const old = item.ui.panel.querySelector('[data-ai-key="model"]');
            let picker = null;
            if (row && old) {
              const current = old.value;
              old.value = models.includes(current) ? current : models[0];
              picker = old;
            }
            const search = item.ui.panel.querySelector('[data-ai-model-search]');
            const listBox = item.ui.panel.querySelector('[data-ai-model-list]');
            const filterModels = () => {
              if (!search || !picker) return;
              const q = search.value.trim().toLowerCase();
              if (picker.tagName === 'SELECT') {
                picker.querySelectorAll('option').forEach(opt => {
                  opt.hidden = !!q && !String(opt.textContent || '').toLowerCase().includes(q);
                });
              }
              if (listBox) listBox.querySelectorAll('[data-ai-model-item]').forEach(itemEl => {
                itemEl.hidden = !!q && !String(itemEl.textContent || '').toLowerCase().includes(q);
              });
            };
            if (search && picker) {
              search.hidden = false;
              search.value = '';
              search.oninput = filterModels;
            }
            if (listBox && picker) {
              listBox.hidden = false;
              listBox.innerHTML = '';
              for (const id of models) {
                const itemBtn = document.createElement('button');
                itemBtn.type = 'button';
                itemBtn.className = 'settings-ai-model-item';
                itemBtn.dataset.aiModelItem = id;
                itemBtn.textContent = id;
                itemBtn.title = id;
                itemBtn.addEventListener('click', () => {
                  picker.value = id;
                  picker.dispatchEvent(new Event('change', { bubbles: true }));
                  listBox.querySelectorAll('[data-ai-model-item]').forEach(x => x.classList.toggle('active', x === itemBtn));
                });
                if (id === picker.value) itemBtn.classList.add('active');
                listBox.appendChild(itemBtn);
              }
            }
            item.aiModelsRefresh = true;
            writeStore(AI_CONFIG_KEY, aiConfig);
            if (listBox) setTimeout(() => { try { listBox.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }, 30);
            if (status) status.textContent = '已拉取 ' + models.length + ' 个模型，可在搜索框筛选或下拉选择';
          });
        } catch (e) { if (status) status.textContent = '拉取失败：无法连接后台'; }
        break;
      }
      case 'listMediaModels': {
        const get = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const endpoint = get('mediaEndpoint') || DEFAULT_AI_CONFIG.mediaEndpoint;
        const key = get('mediaApiKey');
        const status = item.ui.panel.querySelector('[data-media-model-status]');
        const input = item.ui.panel.querySelector('[data-ai-key="mediaModel"]');
        const search = item.ui.panel.querySelector('[data-media-model-search]');
        const listBox = item.ui.panel.querySelector('[data-media-model-list]');
        if (!endpoint) { toast(item, '请先填写媒体接口地址'); break; }
        if (status) status.textContent = '正在从云端拉取媒体模型…';
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:listModels', endpoint, apiKey: key }, res => {
            const lastError = (() => { try { return EXT.runtime.lastError; } catch (e) { return null; } })();
            if (lastError || !res) { if (status) status.textContent = '拉取失败：后台没有响应'; return; }
            if (!res.ok) { if (status) status.textContent = '拉取失败：' + (res.detail || res.reason || '未知错误'); return; }
            const models = Array.isArray(res.models) ? res.models.filter(Boolean).slice(0, 300) : [];
            if (!models.length) { if (status) status.textContent = '接口没有返回模型列表，可手动填写'; return; }
            const filter = () => {
              const q = search ? search.value.trim().toLowerCase() : '';
              if (listBox) listBox.querySelectorAll('[data-media-model-item]').forEach(el => { el.hidden = !!q && !String(el.textContent || '').toLowerCase().includes(q); });
            };
            if (search) { search.hidden = false; search.value = ''; search.oninput = filter; }
            if (listBox) {
              listBox.hidden = false;
              listBox.innerHTML = '';
              for (const id of models) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'settings-ai-model-item';
                button.dataset.mediaModelItem = id;
                button.textContent = id;
                button.title = id;
                button.addEventListener('click', () => {
                  if (input) { input.value = id; input.dispatchEvent(new Event('change', { bubbles: true })); }
                  listBox.querySelectorAll('[data-media-model-item]').forEach(el => el.classList.toggle('active', el === button));
                });
                if (input && input.value === id) button.classList.add('active');
                listBox.appendChild(button);
              }
            }
            if (status) status.textContent = '已拉取 ' + models.length + ' 个媒体模型，可搜索选择';
          });
        } catch (e) { if (status) status.textContent = '拉取失败：无法连接后台'; }
        break;
      }
      case 'testAI': {
        const get = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const endpoint = get('endpoint');
        const model = get('model');
        const key = get('apiKey');
        const status = item.ui.panel.querySelector('[data-ai-test-status]');
        if (status) status.textContent = '正在测试连接…';
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:testAI', endpoint, model, apiKey: key }, res => {
            let lastError = null;
            try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
            if (lastError || !res) { if (status) status.textContent = '测试失败：后台没有响应'; return; }
            if (!res.ok) {
              if (status) status.textContent = '测试失败：' + (res.reason === 'missing-key' ? '请先填写 API Key' : (res.detail || res.reason || '未知错误'));
              return;
            }
            if (status) status.textContent = '连接成功 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒' + (res.model ? ' · ' + res.model : '');
            toast(item, 'AI 连接测试成功');
          });
        } catch (e) { if (status) status.textContent = '测试失败：无法连接后台'; }
        break;
      }
      case 'testAIKey': {
        const get = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const status = item.ui.panel.querySelector('[data-ai-test-status]');
        if (status) status.textContent = '正在测试普通 API Key…';
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:testAI', endpoint: get('endpoint'), model: get('model'), apiKey: get('apiKey') }, res => {
            const lastError = (() => { try { return EXT.runtime.lastError; } catch (e) { return null; } })();
            if (lastError || !res) { if (status) status.textContent = '普通 API Key 测试失败：后台没有响应'; return; }
            if (!res.ok) { if (status) status.textContent = '普通 API Key 测试失败：' + (res.reason === 'missing-key' ? '请先填写 API Key' : (res.detail || res.reason || '未知错误')); return; }
            if (status) status.textContent = '普通 API Key 可用 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒';
            toast(item, '普通 API Key 测试成功');
          });
        } catch (e) { if (status) status.textContent = '普通 API Key 测试失败：无法连接后台'; }
        break;
      }
      case 'testMediaKey': {
        const get = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const status = item.ui.panel.querySelector('[data-ai-test-status]');
        if (status) status.textContent = '正在测试媒体 API Key…';
        try {
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:testMediaAI', endpoint: get('mediaEndpoint'), model: get('mediaModel'), apiKey: get('mediaApiKey') }, res => {
            const lastError = (() => { try { return EXT.runtime.lastError; } catch (e) { return null; } })();
            if (lastError || !res) { if (status) status.textContent = '媒体 API Key 测试失败：后台没有响应'; return; }
            if (!res.ok) { if (status) status.textContent = '媒体 API Key 测试失败：' + (res.reason === 'missing-key' ? '请先填写媒体 API Key' : (res.detail || res.reason || '未知错误')); return; }
            if (status) status.textContent = '媒体 API Key 可用 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒';
            toast(item, '媒体 API Key 测试成功');
          });
        } catch (e) { if (status) status.textContent = '媒体 API Key 测试失败：无法连接后台'; }
        break;
      }""",
    "save AI from in-page settings",
)



once(
    """hr{border:none;border-top:1px solid ${borderColor};margin:2em 0}${filter}</style>""",
    """hr{border:none;border-top:1px solid ${borderColor};margin:2em 0}${filter}
.ldp-read-progress{position:fixed;left:0;right:0;top:0;height:3px;z-index:2147483647;background:transparent;pointer-events:none}
.ldp-read-progress i{display:block;height:100%;background:${linkColor};transform-origin:0 50%;transform:scaleX(0);animation:ldp-read-progress linear both;animation-timeline:scroll(root block)}
@keyframes ldp-read-progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
</style>""",
    "reader progress styles",
)

once(
    """</style></head><body><h1>${headTitle}</h1>${html}</body></html>""",
    """</style></head><body><div class="ldp-read-progress" aria-hidden="true"><i></i></div><h1>${headTitle}</h1>${html}</body></html>""",
    "reader progress markup",
)

# ---------------------------------------------------------------------------
# 9b. Image drag preview: high-resolution image viewer.
# ---------------------------------------------------------------------------
# Viewer CSS. The image gets an explicit pixel size (fit scale * user zoom), so
# large images pan/scroll instead of being silently downscaled by object-fit.
once(
    ".resize{position:absolute;z-index:20;touch-action:none}",
    """.window.image-mode .content{background:transparent}
.window.image-mode .loader .skeleton{display:none}
.window.image-mode .loader .globe-icon{animation:pulse 1.2s ease-in-out infinite}
.window.image-mode .loader{z-index:3}
.image-viewer{position:absolute;inset:0;z-index:1;overflow:hidden;background-color:var(--bg);background-image:linear-gradient(45deg,color-mix(in srgb,var(--muted) 8%,transparent) 25%,transparent 25%),linear-gradient(-45deg,color-mix(in srgb,var(--muted) 8%,transparent) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,color-mix(in srgb,var(--muted) 8%,transparent) 75%),linear-gradient(-45deg,transparent 75%,color-mix(in srgb,var(--muted) 8%,transparent) 75%);background-size:22px 22px;background-position:0 0,0 11px,11px -11px,-11px 0}
.image-viewer[hidden]{display:none!important}
.window.image-mode .image-viewer{-webkit-mask-image:var(--win-mask,none);mask-image:var(--win-mask,none);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-size:100% 100%;mask-size:100% 100%}
@supports not ((-webkit-mask-image:linear-gradient(#000,#000)) or (mask-image:linear-gradient(#000,#000))){.window.image-mode .image-viewer{opacity:var(--win-opacity,1);transition:opacity var(--dur2) var(--ease)}}
.image-stage{position:absolute;inset:0;overflow:auto;padding:22px;overscroll-behavior:contain;scrollbar-width:thin;touch-action:pan-x pan-y}
.image-el{display:block;margin:0 auto;max-width:none;max-height:none;height:auto;border-radius:4px;background:var(--surface);box-shadow:0 18px 50px -24px rgba(0,0,0,.65),0 2px 8px -4px rgba(0,0,0,.35);cursor:zoom-in;user-select:none;-webkit-user-drag:none;opacity:0;transition:opacity .16s var(--ease)}
.image-el.ready{opacity:1}
.image-el.can-pan{cursor:grab}
.image-el.dragging{cursor:grabbing}
.image-meta{position:absolute;left:50%;bottom:10px;z-index:3;transform:translateX(-50%);width:max-content;max-width:calc(100% - 26px);padding:4px 11px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:999px;background:color-mix(in srgb,var(--toast) 80%,transparent);color:var(--toast-text);font:10.5px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;backdrop-filter:var(--glass-filter);-webkit-backdrop-filter:var(--glass-filter);box-shadow:0 6px 18px -10px rgba(0,0,0,.5)}
.image-meta[hidden]{display:none!important}
.resize{position:absolute;z-index:20;touch-action:none}""",
    "image viewer CSS",
)
once(
    '<iframe title="网页预览" sandbox="${FULL_SANDBOX}" allow="fullscreen"></iframe><div class="shield" hidden></div>',
    '<iframe title="网页预览" sandbox="${FULL_SANDBOX}" allow="fullscreen"></iframe>'
    '<div class="image-viewer" hidden><div class="image-stage"><img class="image-el" alt="" draggable="false"></div><div class="image-meta" hidden></div></div>'
    '<div class="shield" hidden></div>',
    "image viewer template",
)
once(
    """      findBar: $('.findbar'), findInput: $('.fb-input'), findLabel: $('.fb-label'),
      findHint: $('.fb-hint'), findCase: $('.fb-case'), findWord: $('.fb-ww')
    };""",
    """      findBar: $('.findbar'), findInput: $('.fb-input'), findLabel: $('.fb-label'),
      findHint: $('.fb-hint'), findCase: $('.fb-case'), findWord: $('.fb-ww'),
      imageViewer: $('.image-viewer'), imageStage: $('.image-stage'),
      imageEl: $('.image-el'), imageMeta: $('.image-meta')
    };
    if (item.imageMode) {
      win.classList.add('image-mode');
      item.ui.frame.style.display = 'none';
      item.ui.imageViewer.hidden = false;
      for (const sel of ['[data-action="read"]', '[data-action="forceDark"]', '[data-action="find"]']) {
        const btn = win.querySelector(sel);
        if (btn) btn.hidden = true;
      }
      const zoomBtn = win.querySelector('[data-action="resetZoom"]');
      if (zoomBtn) zoomBtn.title = '适应窗口';
    }""",
    "image viewer UI refs",
)

once(
    "      zoom: clampNum(saved && saved.zoom, 0.5, 2, 1, false),",
    "      zoom: imageUrl ? clampNum(saved && saved.zoom, 0.1, 8, 1, false) : clampNum(saved && saved.zoom, 0.5, 2, 1, false),",
    "openWindow image zoom",
)

once(
    "    const key = bare ? '' : layoutKey(url);",
    "    // v21 bugfix: never let an image viewer share the webpage layout slot.\n"
    "    // Otherwise 400% image zoom / image geometry overwrites the site's normal\n"
    "    // preview layout (and gets clamped back to 200% when a webpage opens).\n"
    "    const key = bare ? '' : (imageUrl ? 'image:' + layoutKey(url) : layoutKey(url));",
    "image layout key",
)

# openWindow: image option, fields, branch.
once(
    """  function openWindow(value, fallbackTitle, parent, point, opts) {
    const o = opts || {};
    const bare = !!o.bare;                      // 空壳窗口：只用来放面板，不加载任何页面
    const url = bare ? '' : httpUrl(value);
    if (!bare && (!url || isBlacklisted(url))) return null;
    if (!bare && !interactionEnabled()) return null;""",
    """  function openWindow(value, fallbackTitle, parent, point, opts) {
    const o = opts || {};
    const bare = !!o.bare;                      // 空壳窗口：只用来放面板，不加载任何页面
    const imageInfo = (!bare && isObj(o.image)) ? o.image
      : ((!bare && looksLikeImageUrl(value)) ? { url: value, title: fallbackTitle } : null);
    const normalizedImage = imageInfo ? normalizeImageInfo(imageInfo) : null;
    const imageUrl = normalizedImage ? normalizedImage.url : '';
    const url = bare ? '' : (imageUrl || httpUrl(value));
    if (!bare && (!url || isBlacklisted(url))) return null;
    if (!bare && !interactionEnabled()) return null;""",
    "openWindow image url",
)
once(
    """      forceDark: !!settings.forceDark, bare, dockMode: '',
      synthetic: false, synthUrl: '',""",
    """      forceDark: imageUrl ? false : !!settings.forceDark, bare, dockMode: '',
      imageMode: !!imageUrl, imageSourceUrl: '', imageCandidates: [], imageCandidateIndex: 0,
      imageNaturalW: 0, imageNaturalH: 0, imageFitScale: 1, imageLoadTimer: 0,
      synthetic: false, synthUrl: '',""",
    "openWindow image fields",
)
once(
    """    } else {
      pauseBackgroundVideos();
      addToHistory(url, fallbackTitle);
      navigate(item, url);
    }""",
    """    } else if (item.imageMode) {
      pauseBackgroundVideos();
      addToHistory(url, (imageInfo && imageInfo.title) || fallbackTitle);
      setupImageViewer(item, imageInfo || { url: url, title: fallbackTitle });
    } else {
      pauseBackgroundVideos();
      addToHistory(url, fallbackTitle);
      navigate(item, url);
    }""",
    "openWindow image branch",
)

# renderZoom/renderGeometry image branches.
once(
    """  function renderGeometry(item, force) {
    const r = item.rect;""",
    """  function renderGeometry(item, force) {
    const r = item.rect;""",
    "renderGeometry anchor",
)
once(
    """    s.height = r.h + 'px';
    applyToolbarDock(item, r);
  }
  function renderZoom(item) {
    const f = item.ui.frame;""",
    """    s.height = r.h + 'px';
    applyToolbarDock(item, r);
    if (item.imageMode) renderImageZoom(item);
  }
  function renderZoom(item) {
    if (item.imageMode) { renderImageZoom(item); return; }
    const f = item.ui.frame;""",
    "renderZoom image branch",
)

# handleAction image branches.
once(
    """    if (item.bare && ['reload', 'new', 'url', 'read', 'forceDark', 'pip', 'find'].indexOf(action) >= 0) {
      toast(item, '这是面板窗口，没有对应的网页内容');
      return;
    }
    switch (action) {""",
    """    if (item.bare && ['reload', 'new', 'url', 'read', 'forceDark', 'pip', 'find'].indexOf(action) >= 0) {
      toast(item, '这是面板窗口，没有对应的网页内容');
      return;
    }
    if (item.imageMode && ['read', 'forceDark', 'find', 'findNext', 'findPrev', 'findClose'].indexOf(action) >= 0) {
      toast(item, '图片预览不支持这个操作');
      return;
    }
    switch (action) {""",
    "handleAction image guard",
)
once(
    """      case 'url': {
        let url = item.url;
        const fw = frameWin(item);
        if (fw) { try { url = fw.location.href || url; } catch (e) { /* 跨域 */ } }
        toast(item, T.copy(url) ? '已复制网址' : '复制失败，请手动复制');
        break;
      }""",
    """      case 'url': {
        let url = item.url;
        if (!item.imageMode) {
          const fw = frameWin(item);
          if (fw) { try { url = fw.location.href || url; } catch (e) { /* 跨域 */ } }
        }
        toast(item, T.copy(url) ? (item.imageMode ? '已复制图片地址' : '已复制网址') : '复制失败，请手动复制');
        break;
      }""",
    "handleAction image copy",
)
once(
    """      case 'plus':
      case 'minus':
      case 'resetZoom': {
        const step = clampNum(settings.zoomStep, 1, 25, 10, true) / 100;
        item.zoom = action === 'resetZoom'
          ? 1
          : clamp(Math.round((item.zoom + (action === 'plus' ? step : -step)) * 100) / 100, 0.5, 2);
        renderZoom(item);
        saveLayout(item);
        break;
      }""",
    """      case 'plus':
      case 'minus':
      case 'resetZoom': {
        if (item.imageMode) {
          const step = 0.25;
          item.zoom = action === 'resetZoom'
            ? 1
            : clamp(Math.round((item.zoom + (action === 'plus' ? step : -step)) * 100) / 100, 0.1, 8);
          renderImageZoom(item);
          saveLayout(item);
          break;
        }
        const step = clampNum(settings.zoomStep, 1, 25, 10, true) / 100;
        item.zoom = action === 'resetZoom'
          ? 1
          : clamp(Math.round((item.zoom + (action === 'plus' ? step : -step)) * 100) / 100, 0.5, 2);
        renderZoom(item);
        saveLayout(item);
        break;
      }""",
    "handleAction image zoom",
)
once(
    """      case 'reload': {
        const gen = item.generation;""",
    """      case 'reload': {
        if (item.imageMode) { reloadImageViewer(item); break; }
        const gen = item.generation;""",
    "handleAction image reload",
)

# Wheel zoom branch: Ctrl/⌘ + wheel on an image viewer.
once(
    """      // 阅读模式下 Ctrl+滚轮改的是正文字号（阅读排版），不是网页缩放
      if (item.isReaderMode) { adjustReaderFont(item, event.deltaY > 0 ? -1 : 1); return; }""",
    """      // 图片预览：Ctrl/⌘ + 滚轮缩放图片（以指针为中心），不是网页缩放
      if (item.imageMode) { imageWheelZoom(item, event.deltaY > 0 ? -1 : 1, event); return; }
      // 阅读模式下 Ctrl+滚轮改的是正文字号（阅读排版），不是网页缩放
      if (item.isReaderMode) { adjustReaderFont(item, event.deltaY > 0 ? -1 : 1); return; }""",
    "image wheel zoom",
)

# Frame load and snapshot guards for image windows.
once(
    "  function onFrameLoad(item) {\n    if (item.closed || item.isReaderMode) return;",
    "  function onFrameLoad(item) {\n    if (item.closed || item.isReaderMode || item.imageMode) return;",
    "onFrameLoad image guard",
)
once(
    "  function renderSnapshot(item) {\n    if (item.closed || item.isReaderMode || item.synthetic) return;",
    "  function renderSnapshot(item) {\n    if (item.closed || item.isReaderMode || item.imageMode || item.synthetic) return;",
    "renderSnapshot image guard",
)
once(
    "  function revealEarly(item) {\n    if (item.closed || item.seenEarly || item.isReaderMode || item.bare) return;",
    "  function revealEarly(item) {\n    if (item.closed || item.seenEarly || item.isReaderMode || item.imageMode || item.bare) return;",
    "revealEarly image guard",
)
once(
    "  function toggleReaderMode(item) {\n    if (item.isReaderMode) {",
    "  function toggleReaderMode(item) {\n    if (item.imageMode) { toast(item, '图片预览不支持阅读模式'); return; }\n    if (item.isReaderMode) {",
    "toggleReaderMode image guard",
)

# findLink must not claim images; image gestures have their own path.
once(
    """  function findLink(event) {
    const path = event.composedPath ? event.composedPath() : [event.target];
    for (let node of path) {""",
    """  function findLink(event) {
    const path = event.composedPath ? event.composedPath() : [event.target];
    // v21: dragging an image is an image preview, not a web-page preview.
    // Returning null here keeps mousedown/long-press/dragstart/Alt+click from
    // opening the wrapper <a>'s page before the image handler gets a turn.
    // When image preview is disabled, image links must keep normal link behavior.
    const imagePreviewOn = (typeof imageDragPreview !== 'undefined')
      ? imageDragPreview
      : (!(typeof settings === 'object' && settings) || settings.imageDragPreview !== false);
    if (imagePreviewOn) {
      const candidateImage = imageElementAtEvent(event);
      if (candidateImage && imageInfoFromElement(candidateImage)) return null;
    }
    for (let node of path) {""",
    "findLink image exclusion",
)

# Mouseover: skip launcher/peek when over an image.  The hover UI would
# otherwise advertise a web-page preview for an image link.
once(
    """    const raw = event.target;
    const node = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null;
    const anchor = node && node.closest ? node.closest('a[href]') : null;""",
    """    const raw = event.target;
    const node = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null;
    const hoveredImage = settings.imageDragPreview !== false ? imageElementAtEvent(event) : null;
    if (hoveredImage && imageInfoFromElement(hoveredImage)) {
      if (settings.linkButton || settings.aiQuick) launcher.handleLeave(); else launcher.hide();
      peekLeave();
      return;
    }
    const anchor = node && node.closest ? node.closest('a[href]') : null;""",
    "mouseover image exclusion",
)

# Session records keep image-mode details.
once(
    """      pinned: !!w.pinned, pip: !!w.pip, forceDark: !!w.forceDark, inArrange: !!w.inArrange
    }));""",
    """      pinned: !!w.pinned, pip: !!w.pip, forceDark: !!w.forceDark, inArrange: !!w.inArrange,
      imageMode: !!w.imageMode, imageSourceUrl: w.imageSourceUrl || '',
      imageCandidates: w.imageMode && w.imageCandidates && w.imageCandidates.length
        ? w.imageCandidates.slice(0, 12) : []
    }));""",
    "collectWindows image fields",
)
once(
    """  function openWindowFromRecord(rec) {
    const item = openWindow(rec.url, rec.title || '');
    if (!item) return null;""",
    """  function openWindowFromRecord(rec) {
    const imageOpts = rec.imageMode
      ? { image: { url: rec.url, title: rec.title || '', sourceUrl: rec.imageSourceUrl || '',
        candidates: (Array.isArray(rec.imageCandidates) && rec.imageCandidates.length) ? rec.imageCandidates : [rec.url] } }
      : undefined;
    const item = openWindow(rec.url, rec.title || '', null, null, imageOpts);
    if (!item) return null;""",
    "openWindowFromRecord image",
)
once(
    "    if (rec.zoom && rec.zoom !== item.zoom) { item.zoom = clampNum(rec.zoom, 0.5, 2, 1, false); renderZoom(item); }",
    "    if (rec.zoom && rec.zoom !== item.zoom) { item.zoom = item.imageMode ? clampNum(rec.zoom, 0.1, 8, 1, false) : clampNum(rec.zoom, 0.5, 2, 1, false); renderZoom(item); }",
    "openWindowFromRecord image zoom",
)

# gatherFrames should ignore image windows (their hidden about:blank iframe is
# not a sync-scroll participant).
once(
    """    for (const w of windows) {
      if (w.closed) continue;
      try {
        const f = w.ui.frame.contentWindow;""",
    """    for (const w of windows) {
      if (w.closed || w.imageMode) continue;
      try {
        const f = w.ui.frame.contentWindow;""",
    "gatherFrames image skip",
)

# New setting row.
once(
    "    ['hoverPeek', '悬停预览小窗', 'checkbox'], ['hoverDelay', '悬停预览延迟(ms)', 'number'],",
    "    ['hoverPeek', '悬停预览小窗', 'checkbox'], ['hoverDelay', '悬停预览延迟(ms)', 'number'],\n"
    "    ['imageDragPreview', '拖拽图片时预览高清原图', 'checkbox'],",
    "image drag setting field",
)

# Help section for image dragging.
old_image_help_anchor = "      ['悬停迷你预览（v20 新增，v20.2 补上声音治理）', [\n"
new_image_help = """      ['图片拖拽高清预览（v21 新增）', [
        '按住图片直接拖动，不再打开缩略网页，而是浮出一个高清图片窗口：直接把图片原文件按原始分辨率加载出来',
        '自动挑选最高清地址：优先 <a> 链接指向的原图、data-full / data-original / data-large 等原图属性、srcset 中最大的候选，最后才回退到当前缩略图；同一张图加载失败会按候选顺序自动换下一个',
        '窗口内双击图片在「适应窗口 / 1:1 原始像素」之间切换；Ctrl/⌘ + 滚轮以指针为中心缩放（10%–800%）；放大后可拖动平移，触控板也可滚动',
        '工具条的放大 / 缩小 / 重置按钮同样可用；「新标签页」打开当前实际加载的图片地址，「复制网址」复制图片地址',
        '图片预览计入窗口数、画中画、版式排列、布局记忆与会话恢复；退出后刷新页面也能恢复同一张图',
        '图片本身被热链保护或需要登录时会加载失败，提示条会给出「在新标签页打开」，可在原站登录后查看；不支持拖拽 CSS 背景图（浏览器不会为背景图派发 dragstart）',
        '也可以直接在图片上右键，选择「用 Link Preview 查看高清图片」；不想要拖拽行为可在设置 →「触发方式」取消勾选「拖拽图片时预览高清原图」'
      ]],
      ['悬停迷你预览（v20 新增，v20.2 补上声音治理）', [
"""
once(old_image_help_anchor, new_image_help, "image help section")

# Child-frame bridge: image drag/Alt-click inside a preview iframe.
once(
    "      longPressDelay = 500, dragHold = 150, launcherEnabled = true,",
    "      longPressDelay = 500, dragHold = 150, launcherEnabled = true, imageDragPreview = true,",
    "child image setting var",
)
once(
    "        launcherEnabled = data.linkButton !== false;\n        bindFrame();",
    "        launcherEnabled = data.linkButton !== false;\n        imageDragPreview = data.imageDragPreview !== false;\n        bindFrame();",
    "child image setting init",
)
once(
    """        const t = event.target;
        const node = t && t.nodeType === 1 ? t : (t && t.parentElement) || null;
        const anchor = node && node.closest ? node.closest('a[href]') : null;
        if (!anchor || anchor.hasAttribute('download') || anchor.isContentEditable) { frameLauncher.handleLeave(); return; }""",
    """        const t = event.target;
        const node = t && t.nodeType === 1 ? t : (t && t.parentElement) || null;
        if (imageDragPreview && node && node.closest && node.closest('img')) { frameLauncher.handleLeave(); return; }
        const anchor = node && node.closest ? node.closest('a[href]') : null;
        if (!anchor || anchor.hasAttribute('download') || anchor.isContentEditable) { frameLauncher.handleLeave(); return; }""",
    "child mouseover image exclusion",
)
once(
    """      if (data.type === 'request' && data.action === 'info' && isStr(data.id)) {
        send({ type: 'response', id: data.id, title: pageTitle(document), url: location.href });
      }
    });
    return;   // 子框架不再执行宿主逻辑""",
    """      if (data.type === 'request' && data.action === 'info' && isStr(data.id)) {
        send({ type: 'response', id: data.id, title: pageTitle(document), url: location.href });
      }
    });

    // v21: images dragged inside a preview iframe must become nested image
    // previews, not web-page previews.  The parent validates the token/source.
    function sendChildImage(info, event) {
      if (!info || !enabled || !imageDragPreview) return;
      const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
      const nx = Number.isFinite(event && event.clientX) ? clamp(event.clientX / vw, 0, 1) : 0.5;
      const ny = Number.isFinite(event && event.clientY) ? clamp(event.clientY / vh, 0, 1) : 0.5;
      send({ type: 'openImage', image: info, nx: nx, ny: ny });
    }
    window.addEventListener('dragstart', event => {
      if (!enabled || !imageDragPreview) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const info = imageInfoFromEvent(event);
      if (!info) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendChildImage(info, event);
    }, true);
    window.addEventListener('click', event => {
      if (!enabled || !imageDragPreview || !bridgeCfg.altClickOpen) return;
      if (event.button !== 0 || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
      const info = imageInfoFromEvent(event);
      if (!info) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendChildImage(info, event);
    }, true);
    return;   // 子框架不再执行宿主逻辑""",
    "child image gestures",
)

# Host init payload: tell child frames whether image drag preview is enabled.
once(
    "        linkButton: settings.linkButton, dark: getEffectiveDark()",
    "        linkButton: settings.linkButton, imageDragPreview: settings.imageDragPreview !== false,\n        dark: getEffectiveDark()",
    "sendInit image setting",
)

# Parent handler for openImage from a child frame.
once(
    """    if (data.type === 'open') {
      const url = httpUrl(data.url);""",
    """    if (data.type === 'openImage') {
      if (settings.imageDragPreview === false || !interactionEnabled()) return;
      const image = normalizeImageInfo(data.image);
      if (!image || !image.url || !allowNestedOpen(item)) return;
      const now = performance.now();
      if (item.lastNested && item.lastNested.url === image.url && now - item.lastNested.time < 700) return;
      item.lastNested = { url: image.url, time: now };
      const bounds = item.ui.frame.getBoundingClientRect();
      const nx = Number.isFinite(data.nx) ? clamp(data.nx, 0, 1) : 0.5;
      const ny = Number.isFinite(data.ny) ? clamp(data.ny, 0, 1) : 0.5;
      const zoom = item.zoom || 1;
      const v = viewport();
      const point = {
        x: clamp(bounds.left + nx * bounds.width * zoom, 40, Math.max(40, v.w - 40)),
        y: clamp(bounds.top + ny * bounds.height * zoom, 40, Math.max(40, v.h - 40))
      };
      openWindow(image.url, image.title || '', item, point, { image: image });
      return;
    }
    if (data.type === 'open') {
      const url = httpUrl(data.url);""",
    "parent openImage handler",
)

# CloseWindow: clear the image load timeout.
once(
    "    clearTimeout(item.progressTimer);\n    if (item.readerUrl)",
    "    clearTimeout(item.progressTimer);\n    clearTimeout(item.imageLoadTimer);\n    if (item.readerUrl)",
    "closeWindow image timer",
)

# The image path must not accidentally trigger navigate() when reloading an
# image item through a generic code path.
once(
    "  function navigate(item, url) {\n    item.generation++;",
    "  function navigate(item, url) {\n    if (item && item.imageMode) return;\n    item.generation++;",
    "navigate image guard",
)

# The theme refresh unhides forceDark on every window; image windows must keep
# it hidden (there is no page to invert).
once(
    """      const fdBtn = item.ui.fdBtn;
      if (fdBtn && fdBtn.hidden) fdBtn.hidden = false;""",
    """      const fdBtn = item.ui.fdBtn;
      if (fdBtn && fdBtn.hidden) fdBtn.hidden = false;
      if (fdBtn && item.imageMode) fdBtn.hidden = true;""",
    "image forceDark hide",
)

# ---------------------------------------------------------------------------
# 10. Page-level enable/site pause checks.
# ---------------------------------------------------------------------------
once(
    """  function pageInteractionAllowed(event) {
    return !gesture && !targetInHost(event, shell && shell.host)
      && !windows.some(w => !w.pinned && !isEffPip(w));
  }""",
    """  function pageInteractionAllowed(event) {
    if (typeof interactionEnabled === 'function' && !interactionEnabled()) return false;
    return !gesture && !targetInHost(event, shell && shell.host)
      && !windows.some(w => !w.pinned && !isEffPip(w));
  }""",
    "pageInteractionAllowed enabled guard",
)

# launcher enablement
once(
    "    isEnabled: () => settings.linkButton,",
    "    isEnabled: () => (settings.linkButton || (settings.aiQuick && aiQuickAllowed())) && interactionEnabled(),",
    "launcher enabled guard",
)

# peek guards
once(
    "  function peekShow(link) {\n    if (!settings.hoverPeek || !link.element.isConnected) return;",
    "  function peekShow(link) {\n    if (!settings.hoverPeek || !interactionEnabled() || !link.element.isConnected) return;",
    "peekShow enabled guard",
)
once(
    "  function peekHover(link) {\n    if (!settings.hoverPeek) { peekLeave(); return; }",
    "  function peekHover(link) {\n    if (!settings.hoverPeek || !interactionEnabled()) { peekLeave(); return; }",
    "peekHover enabled guard",
)

# auto restore must not pop windows on a paused site
once(
    "  function autoRestoreIfNeeded() {\n    if (!settings.sessionMemory || !settings.sessionAuto) return;",
    "  function autoRestoreIfNeeded() {\n    if (!interactionEnabled()) return;\n    if (!settings.sessionMemory || !settings.sessionAuto) return;",
    "auto restore enabled guard",
)

# drag/drop guard
once(
    "  window.addEventListener('dragenter', event => {\n    if (!hasUrlPayload(event.dataTransfer)) return;",
    "  window.addEventListener('dragenter', event => {\n    if (!interactionEnabled() || !hasUrlPayload(event.dataTransfer)) return;",
    "dragenter enabled guard",
)
once(
    "  window.addEventListener('dragover', event => {\n    if (!hasUrlPayload(event.dataTransfer)) return;",
    "  window.addEventListener('dragover', event => {\n    if (!interactionEnabled() || !hasUrlPayload(event.dataTransfer)) return;",
    "dragover enabled guard",
)

# Host shortcut handler guard
once(
    "  window.addEventListener('keydown', event => {\n    if (!settings.shortcuts) return;",
    "  window.addEventListener('keydown', event => {\n    if (!settings.shortcuts || !interactionEnabled()) return;",
    "shortcut enabled guard",
)

# top-level mouseover: hide UI when paused, but leave our own shadow UI alone
once(
    """  window.addEventListener('mouseover', event => {
    if (targetInHost(event, shell && shell.host)) {""",
    """  window.addEventListener('mouseover', event => {
    if (targetInHost(event, shell && shell.host)) {""",
    "mouseover anchor sanity",
)
# Insert the disabled check after the host-UI branch's closing return.  A small
# unique anchor is used rather than a giant block replacement.
once(
    """      if (!inside) peekHide(false);
      return;
    }
    const raw = event.target;""",
    """      if (!inside) peekHide(false);
      return;
    }
    if (!interactionEnabled()) {
      if (launcher) launcher.hide();
      peekHide(true);
      return;
    }
    const raw = event.target;""",
    "mouseover disabled guard",
)

# badge update at the end of syncStack
once(
    """    updateThemeButtons();
    if (syncSource && windows.indexOf(syncSource) < 0) syncSource = null;
  }""",
    """    updateThemeButtons();
    if (syncSource && windows.indexOf(syncSource) < 0) syncSource = null;
    scheduleBadgeUpdate();
  }""",
    "syncStack badge hook",
)

# updateSetting: apply page enable state when the two new switches change.
once(
    "    if (name === 'favicon') for (const w of windows) if (!w.closed) renderTitle(w);",
    "    if (name === 'favicon') for (const w of windows) if (!w.closed) renderTitle(w);\n"
    "    if (name === 'enabled' || name === 'disabledSites') applyPageEnableState(true);",
    "updateSetting enable state",
)

# ---------------------------------------------------------------------------
# 11. Hover-peek race fixes and warm-cache reset.
# ---------------------------------------------------------------------------
old_peek_switch = """    // 换了链接：旧小窗若无其事地淡出，新链接重新等阈值
    clearTimeout(peekTimer);
    if (peekEl && !peekEl.hidden && peekLink && peekLink.element !== link.element) peekScheduleHide(140);
    peekPending = link;"""
new_peek_switch = """    // 换了链接：旧小窗立即收起。  v21 bugfix: 旧版这里调用
    // peekScheduleHide(140)，140ms 后 peekHide() 会把「新链接刚设好的
    // peekTimer/peekPending」一并清掉 —— 从 A 快速移到 B 时 B 永远不会弹出。
    clearTimeout(peekTimer);
    if (peekEl && !peekEl.hidden && peekLink && peekLink.element !== link.element) peekHide(true);
    peekPending = link;"""
once(old_peek_switch, new_peek_switch, "hover switch race")

old_warm = """  function peekArmWarm(link) {
    if (link.url === peekWarmUrl) return;
    clearTimeout(peekWarmTimer);
    peekWarmUrl = link.url;
    peekWarmTimer = setTimeout(() => {
      peekWarmTimer = 0;
      warmLink(peekWarmUrl);
      if (peekKind() === 'snapshot') peekSnapFetch(peekWarmUrl, null);
    }, PEEK_WARM_MS);
  }"""
new_warm = """  function peekArmWarm(link) {
    if (link.url === peekWarmUrl) return;
    clearTimeout(peekWarmTimer);
    peekWarmUrl = link.url;
    peekWarmTimer = setTimeout(() => {
      const warmUrl = peekWarmUrl;
      peekWarmTimer = 0;
      if (!warmUrl) return;
      warmLink(warmUrl);
      if (peekKind() === 'snapshot') peekSnapFetch(warmUrl, null);
    }, PEEK_WARM_MS);
  }"""
once(old_warm, new_warm, "peek warm timer capture")
once(
    """  function peekLeave() {
    clearTimeout(peekTimer); peekTimer = 0;
    peekPending = null;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    if (peekEl && !peekEl.hidden) peekScheduleHide(200);
  }""",
    """  function peekLeave() {
    clearTimeout(peekTimer); peekTimer = 0;
    peekPending = null;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    // v21 bugfix: 清掉预热定时器后必须同时清掉去重键，否则移开再移回同一
    // 链接时会命中 `link.url === peekWarmUrl` 早退，预热永远不会再发生。
    peekWarmUrl = '';
    if (peekEl && !peekEl.hidden) peekScheduleHide(200);
  }""",
    "peek warm dedupe reset",
)
once(
    """  function peekHide(now) {
    clearTimeout(peekTimer); peekTimer = 0;
    clearTimeout(peekHideTimer); peekHideTimer = 0;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;""",
    """  function peekHide(now) {
    clearTimeout(peekTimer); peekTimer = 0;
    clearTimeout(peekHideTimer); peekHideTimer = 0;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    peekWarmUrl = '';""",
    "peek hide warm reset",
)

# ---------------------------------------------------------------------------
# 12. Extension integration hooks appended inside the core IIFE.
# ---------------------------------------------------------------------------
HOOKS = r"""
  /* ==================================================================================
   *  §19 浏览器扩展集成（v21）
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  这段代码只在扩展内容脚本里生效。它把核心与 MV3 的 storage / messages /
   *  badge 连起来，并增加「全局启用 / 站点暂停」两个安全开关。所有消息都带
   *  namespace，避免与页面自己的 postMessage 混在一起。
   * ================================================================================== */
  const EXT_NS = 'LPS_EXT';
  let extBadgeTimer = 0;
  let extLastAppliedSettings = '';

  function siteHostKey() {
    try {
      if (location.hostname) return location.hostname.toLowerCase();
      if (location.protocol === 'file:') return 'file';
      return '';
    } catch (e) { return ''; }
  }
  function siteRuleList(value) {
    return String(value == null ? '' : value)
      .split(/[\s,;]+/)
      .map(part => part.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
  }
  function siteMatchesRule(host, rule) {
    if (!host || !rule) return false;
    return host === rule || host.slice(-(rule.length + 1)) === '.' + rule;
  }
  function interactionEnabled() {
    if (settings.enabled === false) return false;
    const host = siteHostKey();
    if (!host) return true;
    return !siteRuleList(settings.disabledSites).some(rule => siteMatchesRule(host, rule));
  }
  function interactionDisabledReason() {
    if (settings.enabled === false) return 'extension-disabled';
    return interactionEnabled() ? '' : 'site-paused';
  }
  function applyPageEnableState(notify) {
    const on = interactionEnabled();
    if (!on) {
      if (launcher) launcher.hide();
      peekHide(true);
      const wasRestoring = restoringSession;
      restoringSession = true;
      try {
        for (const w of windows.slice()) {
          if (w.closed || w.bare) continue;
          closeWindow(w, true);
        }
      } finally {
        restoringSession = wasRestoring;
      }
      if (!windows.length) resumeBackgroundVideos();
      if (notify) toastStandalone(settings.enabled === false
        ? 'Link Preview 已全局暂停（工具栏图标可重新启用）'
        : '已暂停本站的 Link Preview（工具栏图标可恢复）');
    } else if (notify) {
      toastStandalone('Link Preview 已在' + (siteHostKey() || '本页') + '启用');
    }
    scheduleBadgeUpdate();
  }
  function scheduleBadgeUpdate() {
    if (!TOP || !EXT || !EXT.runtime || !EXT.runtime.sendMessage) return;
    clearTimeout(extBadgeTimer);
    extBadgeTimer = setTimeout(() => {
      extBadgeTimer = 0;
      let count = 0;
      for (const w of windows) if (!w.closed && !w.bare) count++;
      try {
        EXT.runtime.sendMessage({ namespace: EXT_NS, type: 'ldp:badge', count }, () => {
          try { void EXT.runtime.lastError; } catch (e) { /* 忽略 */ }
        });
      } catch (e) { /* 扩展更新后旧内容脚本会失联，静默即可 */ }
    }, 140);
  }
  function extStatus() {
    const host = siteHostKey();
    const pausedRules = siteRuleList(settings.disabledSites);
    const sitePaused = !!host && pausedRules.some(rule => siteMatchesRule(host, rule));
    return {
      ok: true,
      version: SCRIPT_VERSION,
      host: host,
      enabled: settings.enabled !== false,
      sitePaused: sitePaused,
      siteDisabled: settings.enabled === false || sitePaused,
      reason: interactionDisabledReason(),
      count: windows.filter(w => !w.closed && !w.bare).length,
      hoverPeek: !!settings.hoverPeek,
      linkButton: !!settings.linkButton,
      imageDragPreview: settings.imageDragPreview !== false,
      contextMenu: !!settings.contextMenu,
      badgeCount: !!settings.badgeCount,
      disabledSites: settings.disabledSites || ''
    };
  }
  function toggleCurrentSite() {
    const host = siteHostKey();
    if (!host) return extStatus();
    const list = siteRuleList(settings.disabledSites);
    const at = list.findIndex(rule => siteMatchesRule(host, rule));
    if (at >= 0) list.splice(at, 1);
    else list.push(host);
    updateSetting(null, 'disabledSites', list.join(','));
    return extStatus();
  }
  function allowNestedOpen(item) {
    if (!item) return false;
    const now = performance.now();
    if (!item.nestedBudget || now > item.nestedBudget.until) {
      item.nestedBudget = { count: 0, until: now + 10000 };
    }
    if (item.nestedBudget.count >= 8) return false;
    item.nestedBudget.count++;
    return true;
  }
  function normalizeImageUrl(value, base) {
    if (!isStr(value)) return '';
    const raw = value.trim().replace(/^url\(\s*['"]?/i, '').replace(/['"]?\s*\)$/, '');
    if (!raw || /[{}\r\n]/.test(raw)) return '';
    if (/^data:image\//i.test(raw)) return raw.length <= 3 * 1024 * 1024 ? raw : '';
    try {
      const u = new window.URL(raw, base || location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      return u.href;
    } catch (e) { return ''; }
  }
  function looksLikeImageUrl(value) {
    if (!isStr(value)) return false;
    if (/^data:image\//i.test(value)) return true;
    try {
      const u = new window.URL(value, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (/\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)(?:$|[?#])/i.test(u.pathname)) return true;
      if (/[?&](?:format|fm|ext|type)=?(?:jpe?g|png|webp|gif|avif)\b/i.test(u.search)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  function parseImageSrcset(value, base) {
    const rows = [];
    const seen = Object.create(null);
    String(value || '').split(',').forEach(part => {
      const text = part.trim();
      if (!text) return;
      const m = text.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/i);
      if (!m) return;
      const url = normalizeImageUrl(m[1], base);
      if (!url || seen[url]) return;
      seen[url] = 1;
      let score = 1;
      if (m[2]) score = m[3].toLowerCase() === 'x' ? parseFloat(m[2]) * 1000 : parseFloat(m[2]);
      rows.push({ url: url, score: Number.isFinite(score) ? score : 1 });
    });
    rows.sort((a, b) => b.score - a.score);
    return rows.map(row => row.url);
  }
  function imageOriginalVariant(url) {
    try {
      const u = new window.URL(url, location.href);
      if (!/-\d{2,4}x\d{2,4}\.(?:jpe?g|jfif|png|webp|avif|gif)$/i.test(u.pathname)) return '';
      const original = u.pathname.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|jfif|png|webp|avif|gif))$/i, '$1');
      return u.origin + original + u.search + u.hash;
    } catch (e) { return ''; }
  }
  function imageTitleFromUrl(url) {
    try {
      const u = new window.URL(url, location.href);
      const name = decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,5}$/i, ''));
      return name.replace(/[-_+]+/g, ' ').trim();
    } catch (e) { return ''; }
  }
  function imageElementMeaningful(img) {
    if (!img || img.nodeType !== 1) return false;
    try {
      const rect = img.getBoundingClientRect();
      // Judge the rendered box, not the intrinsic file size: a 320px source
      // shown as a 16px icon must not steal the surrounding link's hover UI.
      return rect.width >= 48 && rect.height >= 48;
    } catch (e) { return false; }
  }
  /**
   * Return the actual <img> being dragged/clicked.  Usually event.target or
   * the composed path already contains it; on some engines a drag that starts
   * on an image wrapped by <a> retargets to the anchor, so fall back to the
   * image under the pointer (never any arbitrary image elsewhere in the link).
   */
  function imageElementAtEvent(event) {
    const path = event && event.composedPath ? event.composedPath() : [event && event.target];
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (node && node.nodeType === 1 && node.localName && String(node.localName).toLowerCase() === 'img'
        && imageElementMeaningful(node)) return node;
    }
    let target = event && event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!target || !target.closest) return null;
    const anchor = target.closest('a[href]');
    if (!anchor) return null;
    const x = Number(event.clientX), y = Number(event.clientY);
    const imgs = anchor.querySelectorAll('img');
    for (const img of imgs) {
      if (!imageElementMeaningful(img)) continue;
      try {
        const rect = img.getBoundingClientRect();
        if (Number.isFinite(x) && Number.isFinite(y)
          && x >= rect.left - 2 && x <= rect.right + 2
          && y >= rect.top - 2 && y <= rect.bottom + 2) return img;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  /** Pure DOM extraction, also called by child frames (hoisted declaration). */
  function imageInfoFromElement(img) {
    if (!img || img.nodeType !== 1 || String(img.localName).toLowerCase() !== 'img') return null;
    const base = img.baseURI || location.href;
    const list = [];
    const seen = Object.create(null);
    const add = value => {
      const url = normalizeImageUrl(value, base);
      if (!url || seen[url] || list.length >= 12) return;
      if (/^data:/i.test(url) && url.length > 3 * 1024 * 1024) return;
      seen[url] = 1;
      list.push(url);
    };
    let rect = null;
    try { rect = img.getBoundingClientRect(); } catch (e) { rect = null; }
    if (rect && rect.width < 24 && rect.height < 24 && (img.naturalWidth || 0) < 128) return null;

    const anchor = img.closest ? img.closest('a[href]') : null;
    const holder = img.closest ? (img.closest('[data-image],[data-full],[data-original],[data-src]') || anchor) : anchor;
    // 1) Explicit full-size attributes are the strongest signal.
    for (const name of ['data-full', 'data-original', 'data-large', 'data-large-file',
      'data-zoom-image', 'data-hi-res-src', 'data-image']) {
      if (holder && holder !== img) add(holder.getAttribute(name));
      add(img.getAttribute(name));
    }
    // 2) The wrapping link usually points at the full image on image sites.
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href && looksLikeImageUrl(href)) add(href);
    }
    // 3) Largest srcset candidate from <img> and <picture><source>.
    parseImageSrcset(img.getAttribute('data-srcset'), base).forEach(add);
    parseImageSrcset(img.getAttribute('srcset'), base).forEach(add);
    const picture = img.closest ? img.closest('picture') : null;
    if (picture) {
      picture.querySelectorAll('source[srcset],source[data-srcset]').forEach(source => {
        parseImageSrcset(source.getAttribute('data-srcset') || source.getAttribute('srcset'), base).forEach(add);
      });
    }
    // 4) Lazy-load attributes are usually better than the current placeholder,
    //    but rank below an explicit high-res srcset.
    for (const name of ['data-src', 'data-lazy-src']) {
      if (holder && holder !== img) add(holder.getAttribute(name));
      add(img.getAttribute(name));
    }
    // 5) Current / declared sources.  A WordPress-style "-300x200" thumbnail
    //    gets an original-size sibling inserted before it.
    const current = normalizeImageUrl(img.currentSrc || img.getAttribute('src') || '', base);
    const original = current ? imageOriginalVariant(current) : '';
    if (original) add(original);
    add(current);
    add(img.getAttribute('src'));
    if (!list.length) return null;

    let title = String(img.alt || img.title || (anchor && anchor.title) || document.title || '').replace(/\s+/g, ' ').trim();
    if (!title) title = imageTitleFromUrl(list[0]) || '图片预览';
    return {
      url: list[0],
      candidates: list,
      title: title.slice(0, 300),
      sourceUrl: location.href,
      width: Number(img.naturalWidth) || 0,
      height: Number(img.naturalHeight) || 0
    };
  }
  function imageInfoFromEvent(event) {
    return imageInfoFromElement(imageElementAtEvent(event));
  }
  function normalizeImageInfo(raw, base) {
    if (!isObj(raw)) return null;
    const list = [];
    const seen = Object.create(null);
    const add = value => {
      const url = normalizeImageUrl(value, base);
      if (!url || seen[url] || list.length >= 12) return;
      if (/^data:/i.test(url) && url.length > 3 * 1024 * 1024) return;
      seen[url] = 1;
      list.push(url);
    };
    add(raw.url);
    if (Array.isArray(raw.candidates)) {
      for (const candidate of raw.candidates) add(isObj(candidate) ? candidate.url : candidate);
    }
    if (!list.length) return null;
    let title = (isStr(raw.title) ? raw.title : '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!title) title = imageTitleFromUrl(list[0]) || '图片预览';
    return {
      url: list[0],
      candidates: list,
      title: title,
      sourceUrl: httpUrl(raw.sourceUrl) || '',
      width: Number(raw.width) || 0,
      height: Number(raw.height) || 0
    };
  }
  function openImagePreview(info, event) {
    const image = normalizeImageInfo(info);
    if (!image || !settings.imageDragPreview || !interactionEnabled()) return false;
    markPreviewed(image.url);
    if (TOP) {
      openWindow(image.url, image.title, null,
        { x: event && event.clientX, y: event && event.clientY }, { image: image });
      return true;
    }
    const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
    const nx = event && Number.isFinite(event.clientX) ? clamp(event.clientX / vw, 0, 1) : 0.5;
    const ny = event && Number.isFinite(event.clientY) ? clamp(event.clientY / vh, 0, 1) : 0.5;
    send({ type: 'openImage', image: image, nx: nx, ny: ny });
    return true;
  }
  function renderImageZoom(item) {
    if (!item || !item.imageMode || item.closed || !item.ui || !item.ui.imageEl) return;
    const img = item.ui.imageEl;
    const nw = Number(item.imageNaturalW) || 0;
    const nh = Number(item.imageNaturalH) || 0;
    if (!nw || !nh) {
      item.ui.zoomLabel.textContent = '100%';
      return;
    }
    const stage = item.ui.imageStage;
    // Use offsetWidth/offsetHeight, not clientWidth/clientHeight: the latter
    // shrink when scrollbars appear, which made the stored fit scale change
    // between "fit" and "1:1" and produced a 104% image instead of 100%.
    const stageW = stage && stage.offsetWidth > 44 ? stage.offsetWidth - 44 : Number(item.rect.w) - 44;
    const stageH = stage && stage.offsetHeight > 44 ? stage.offsetHeight - 44 : Number(item.rect.h) - 88;
    const availW = Math.max(80, stageW);
    const availH = Math.max(80, stageH);
    const fit = Math.min(availW / nw, availH / nh, 1);
    const scale = clamp(fit * (Number(item.zoom) || 1), 0.02, 16);
    item.imageFitScale = fit;
    const w = Math.max(1, Math.round(nw * scale));
    if (img.style.width !== w + 'px') img.style.width = w + 'px';
    img.style.height = 'auto';
    const canPan = !!(stage && (stage.scrollWidth > stage.clientWidth + 2 || stage.scrollHeight > stage.clientHeight + 2));
    img.classList.toggle('can-pan', canPan);
    item.ui.zoomLabel.textContent = Math.round(scale * 100) + '%';
    item.ui.imageMeta.textContent = nw + ' × ' + nh + ' · ' + Math.round(scale * 100) + '% · 双击 1:1 / 适应';
    item.ui.imageMeta.hidden = false;
  }
  function imageWheelZoom(item, dir, event) {
    if (!item || !item.imageMode || !item.imageNaturalW) return;
    const stage = item.ui.imageStage;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = event && Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
    const cy = event && Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2;
    const px = cx - rect.left + stage.scrollLeft;
    const py = cy - rect.top + stage.scrollTop;
    const oldScale = item.imageFitScale * (Number(item.zoom) || 1);
    const next = clamp((Number(item.zoom) || 1) * (dir > 0 ? 1.2 : 1 / 1.2), 0.1, 8);
    if (Math.abs(next - item.zoom) < 0.001) return;
    item.zoom = next;
    renderImageZoom(item);
    const ratio = oldScale > 0 ? (item.imageFitScale * next) / oldScale : 1;
    requestAnimationFrame(() => {
      if (!item.closed) {
        stage.scrollLeft = Math.max(0, px * ratio - (cx - rect.left));
        stage.scrollTop = Math.max(0, py * ratio - (cy - rect.top));
      }
    });
  }
  function failImageViewer(item) {
    if (!item || item.closed) return;
    clearTimeout(item.imageLoadTimer);
    item.ui.loader.hidden = true;
    item.ui.progressBar.style.width = '100%';
    item.ui.imageEl.classList.remove('ready');
    item.ui.imageEl.style.display = 'none';
    item.ui.imageMeta.hidden = true;
    hint(item, '图片加载失败：可能被热链保护、需要登录，或地址已失效。可在新标签页打开后重试。', HINT_OPEN_TAB);
  }
  function loadImageViewerCandidate(item) {
    if (!item || item.closed) return;
    if (Date.now() > (item.imageLoadDeadline || 0)) { failImageViewer(item); return; }
    const img = item.ui.imageEl;
    const url = item.imageCandidates[item.imageCandidateIndex];
    if (!url) { failImageViewer(item); return; }
    const token = (item.imageLoadToken || 0) + 1;
    item.imageLoadToken = token;
    clearTimeout(item.imageLoadTimer);
    item.ui.loader.hidden = false;
    item.ui.progressBar.style.width = '12%';
    item.ui.imageEl.style.display = '';
    item.ui.imageEl.classList.remove('ready');
    item.ui.imageMeta.hidden = true;
    item.imageLoadTimer = setTimeout(() => {
      if (item.closed || item.imageLoadToken !== token) return;
      item.imageCandidateIndex++;
      loadImageViewerCandidate(item);
    }, Math.min(25000, Math.max(3000, (item.imageLoadDeadline || Date.now()) - Date.now())));
    img.onload = () => {
      if (item.closed || item.imageLoadToken !== token) return;
      clearTimeout(item.imageLoadTimer);
      const nw = Number(img.naturalWidth) || 0;
      const nh = Number(img.naturalHeight) || 0;
      if (!nw || !nh) {
        item.imageCandidateIndex++;
        loadImageViewerCandidate(item);
        return;
      }
      item.imageNaturalW = nw;
      item.imageNaturalH = nh;
      item.imageUrl = url;
      item.url = url;
      item.originalUrl = url;
      img.classList.add('ready');
      item.ui.loader.hidden = true;
      item.ui.progressBar.style.width = '100%';
      setTimeout(() => { if (!item.closed) item.ui.progressBar.style.width = '0'; }, 500);
      item.ui.hint.hidden = true;
      renderImageZoom(item);
    };
    img.onerror = () => {
      if (item.closed || item.imageLoadToken !== token) return;
      clearTimeout(item.imageLoadTimer);
      item.imageCandidateIndex++;
      loadImageViewerCandidate(item);
    };
    try { img.src = url; } catch (e) { item.imageCandidateIndex++; loadImageViewerCandidate(item); }
  }
  function setupImageViewer(item, rawInfo) {
    if (!item || item.closed) return;
    const info = normalizeImageInfo(rawInfo) || normalizeImageInfo({ url: item.url, title: item.fallbackTitle });
    if (!info) { failImageViewer(item); return; }
    item.imageCandidates = info.candidates.slice();
    item.imageCandidateIndex = 0;
    item.imageSourceUrl = info.sourceUrl || location.href;
    item.title = info.title || item.fallbackTitle || '图片预览';
    item.fallbackTitle = item.title;
    item.url = info.url;
    item.originalUrl = info.url;
    item.imageNaturalW = 0;
    item.imageNaturalH = 0;
    item.imageFitScale = 1;
    item.imageLoadDeadline = Date.now() + 45000;
    item.ui.imageViewer.hidden = false;
    item.ui.frame.style.display = 'none';
    item.ui.imageEl.alt = item.title;
    item.ui.imageEl.style.display = '';
    item.ui.imageEl.onload = null;
    item.ui.imageEl.onerror = null;
    // Force a fresh navigation even when reloading the same URL.  Assigning
    // the same src again would not fire load in some browsers, leaving the
    // spinner up forever.
    try { item.ui.imageEl.removeAttribute('src'); } catch (e) { /* ignore */ }
    item.ui.imageMeta.hidden = true;
    item.ui.hint.hidden = true;
    item.ui.loader.hidden = false;
    item.ui.progressBar.style.width = '8%';
    renderTitle(item);
    if (!item.ui.imageEl.__ldpBound) {
      item.ui.imageEl.__ldpBound = true;
      item.ui.imageEl.addEventListener('dragstart', event => event.preventDefault());
      item.ui.imageEl.addEventListener('dblclick', event => {
        event.preventDefault();
        if (!item.imageNaturalW) return;
        const fit = item.imageFitScale || 1;
        const actual = fit > 0 ? 1 / fit : 1;
        const target = clamp(actual, 0.1, 8);
        if (item.zoom < target - 0.02) item.zoom = target;
        else item.zoom = 1;
        renderImageZoom(item);
      });
      let pan = null;
      const stopPan = () => {
        pan = null;
        item.ui.imageEl.classList.remove('dragging');
      };
      item.ui.imageStage.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const stage = item.ui.imageStage;
        if (stage.scrollWidth <= stage.clientWidth + 2 && stage.scrollHeight <= stage.clientHeight + 2) return;
        pan = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        item.ui.imageEl.classList.add('dragging');
        try { stage.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        // Do not preventDefault here: it would suppress the double-click that
        // toggles between fit and 1:1.  The image is draggable=false anyway.
      });
      item.ui.imageStage.addEventListener('pointermove', event => {
        if (!pan) return;
        item.ui.imageStage.scrollLeft = pan.left - (event.clientX - pan.x);
        item.ui.imageStage.scrollTop = pan.top - (event.clientY - pan.y);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => {
        item.ui.imageStage.addEventListener(name, stopPan);
      });
    }
    loadImageViewerCandidate(item);
  }
  function reloadImageViewer(item) {
    if (!item || item.closed || !item.imageMode) return;
    const url = item.imageUrl || currentPageUrl(item) || item.url;
    const info = {
      url: url,
      candidates: (item.imageCandidates && item.imageCandidates.length) ? item.imageCandidates.slice() : [url],
      title: item.title || '',
      sourceUrl: item.imageSourceUrl || ''
    };
    setupImageViewer(item, info);
    toast(item, '正在重新加载图片…');
  }
  function reloadSettingsFromExternal(newValue) {
    if (!isObj(newValue)) return;
    const merged = Object.assign({}, DEFAULTS, newValue);
    const sig = JSON.stringify(merged);
    if (sig === extLastAppliedSettings) return;
    extLastAppliedSettings = sig;
    settings = merged;
    normalizeSettings();
    extCache[SETTINGS_KEY] = settings;
    refreshShortcuts();
    syncThemeObserver();
    invalidateThemeSample();
    if (shell) applySettings(true);
    applyPageEnableState(false);
    for (const w of windows) {
      if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
    }
  }
  function extRespond(sendResponse, payload) {
    try { sendResponse(payload); } catch (e) { /* 端口可能已关闭 */ }
  }
  if (EXT && EXT.runtime && EXT.runtime.onMessage) {
    EXT.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isObj(message) || message.namespace !== EXT_NS) return false;
      const type = String(message.type || '');
      if (type === 'ldp:ping') {
        extRespond(sendResponse, { ok: true, version: SCRIPT_VERSION, frame: TOP ? 'top' : 'frame' });
        return false;
      }
      if (type === 'ldp:get-status') {
        extRespond(sendResponse, extStatus());
        return false;
      }
      if (type === 'ldp:summary-page' || type === 'ldp:summary-media') {
        if (!interactionEnabled()) {
          extRespond(sendResponse, { ok: false, reason: interactionDisabledReason() || 'disabled' });
          return false;
        }
        const opened = openPageOrMediaSummary();
        extRespond(sendResponse, opened ? { ok: true, id: opened.id } : { ok: false, reason: 'open-failed' });
        return false;
      }
      if (type === 'ldp:open-preview') {
        const target = httpUrl(message.url);
        if (!target || !interactionEnabled()) {
          extRespond(sendResponse, { ok: false, reason: interactionDisabledReason() || 'invalid-url' });
          return false;
        }
        const v = viewport();
        const item = openWindow(target, isStr(message.title) ? message.title.slice(0, 300) : '', null,
          { x: v.w / 2, y: v.h / 2 });
        extRespond(sendResponse, item ? { ok: true, id: item.id } : { ok: false, reason: 'open-failed' });
        return false;
      }
      if (type === 'ldp:open-image') {
        const image = normalizeImageInfo(message.image);
        if (!image || !interactionEnabled()) {
          extRespond(sendResponse, { ok: false, reason: interactionDisabledReason() || 'invalid-image' });
          return false;
        }
        const v = viewport();
        const item = openWindow(image.url, image.title, null,
          { x: v.w / 2, y: v.h / 2 }, { image: image });
        extRespond(sendResponse, item ? { ok: true, id: item.id } : { ok: false, reason: 'open-failed' });
        return false;
      }
      if (type === 'ldp:open-settings') {
        openSettingsStandalone();
        extRespond(sendResponse, { ok: true });
        return false;
      }
      if (type === 'ldp:open-help') {
        openHelpStandalone();
        extRespond(sendResponse, { ok: true });
        return false;
      }
      if (type === 'ldp:close-all') {
        for (const w of windows.slice()) closeWindow(w, true);
        extRespond(sendResponse, { ok: true });
        return false;
      }
      if (type === 'ldp:toggle-site') {
        extRespond(sendResponse, toggleCurrentSite());
        return false;
      }
      if (type === 'ldp:set-setting') {
        const name = String(message.name || '');
        if (!(name in DEFAULTS)) {
          extRespond(sendResponse, { ok: false, reason: 'unknown-setting' });
          return false;
        }
        updateSetting(null, name, message.value);
        extRespond(sendResponse, extStatus());
        return false;
      }
      if (type === 'ldp:show-toast') {
        toastStandalone(isStr(message.text) ? message.text.slice(0, 200) : '');
        extRespond(sendResponse, { ok: true });
        return false;
      }
      return false;
    });
  }
  if (EXT && EXT.storage && EXT.storage.onChanged) {
    EXT.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      if (changes[LAYOUTS_KEY] && isObj(changes[LAYOUTS_KEY].newValue)) {
        layouts = changes[LAYOUTS_KEY].newValue;
        extCache[LAYOUTS_KEY] = layouts;
      }
      if (changes[HISTORY_KEY] && Array.isArray(changes[HISTORY_KEY].newValue)) {
        history = changes[HISTORY_KEY].newValue;
        extCache[HISTORY_KEY] = history;
      }
      if (changes[SESSIONS_KEY] && isObj(changes[SESSIONS_KEY].newValue)) {
        sessions = changes[SESSIONS_KEY].newValue;
        extCache[SESSIONS_KEY] = sessions;
      }
      if (changes[AI_CONFIG_KEY] && isObj(changes[AI_CONFIG_KEY].newValue)) {
        aiConfig = changes[AI_CONFIG_KEY].newValue;
        extCache[AI_CONFIG_KEY] = aiConfig;
        for (const w of windows) {
          if (w.aiModelsRefresh) { w.aiModelsRefresh = false; continue; }
          if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
        }
      }
      if (!changes[SETTINGS_KEY]) return;
      const value = changes[SETTINGS_KEY].newValue;
      if (!isObj(value)) {
        if (changes[SETTINGS_KEY].newValue === undefined) reloadSettingsFromExternal({});
        return;
      }
      if (!extReady) return;
      reloadSettingsFromExternal(value);
    });
  }
  // Host-side image gestures.  The child-frame counterpart lives in the
  // !TOP branch and forwards plain image data to this frame.
  window.addEventListener('dragstart', event => {
    if (!settings.imageDragPreview || !interactionEnabled()) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (shell && targetInHost(event, shell.host)) return;
    if (!pageInteractionAllowed(event)) return;
    const info = imageInfoFromEvent(event);
    if (!info) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openImagePreview(info, event);
  }, true);
  window.addEventListener('click', event => {
    if (!settings.imageDragPreview || !settings.altClickOpen || !interactionEnabled()) return;
    if (event.button !== 0 || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
    if (shell && targetInHost(event, shell.host)) return;
    if (!pageInteractionAllowed(event)) return;
    const info = imageInfoFromEvent(event);
    if (!info) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openImagePreview(info, event);
  }, true);

  // Initial badge (0) and enable state.  The store-ready hook below will run
  // again after async storage has loaded the real settings.
  scheduleBadgeUpdate();
  whenStoreReady(() => {
    const stored = readStore(SETTINGS_KEY, {});
    if (isObj(stored)) reloadSettingsFromExternal(stored);
    applyPageEnableState(false);
  });
"""

# Insert hooks inside the original core IIFE, immediately before its final close.
video_hooks_path = Path(__file__).with_name("video_summary.js")
if video_hooks_path.exists():
    HOOKS += "\n" + video_hooks_path.read_text(encoding="utf-8") + "\n"
media_hooks_path = Path(__file__).with_name("media_summary.js")
if media_hooks_path.exists():
    HOOKS += "\n" + media_hooks_path.read_text(encoding="utf-8") + "\n"
core = text
idx = core.rfind("})();")
if idx < 0:
    raise SystemExit("[build] cannot locate core IIFE close")
core = core[:idx] + HOOKS + "\n" + core[idx:]

# ---------------------------------------------------------------------------
# 13. Outer guard + manifest metadata.  The guard makes programmatic
#     chrome.scripting.executeScript() idempotent after an extension reload.
# ---------------------------------------------------------------------------
header = """/* Link Preview Suite — Chromium extension v1.9.41
 * ---------------------------------------------------------------------------
 * Ported from the v20.3.0 userscript.  The core engine is kept intact; this
 * wrapper provides the browser-extension runtime: MV3 messaging, privileged
 * fetch, storage, context menus, toolbar popup and site-level pause controls.
 *
 * This file is generated by tools/build_content.py.  Edit the source/patcher,
 * not this file, if you need to rebuild.
 * ------------------------------------------------------------------------- */
"""
outer = """(function () {
  'use strict';
  // Idempotence guard: the popup/background may inject this file into an
  // already-open tab after an extension reload.  Never install twice.
  if (window.__LPS_EXTENSION_V21_LOADED__) return;
  window.__LPS_EXTENSION_V21_LOADED__ = true;
  const LPS_MANIFEST = (() => {
    try {
      const m = chrome.runtime.getManifest();
      return { version: String(m.version || '1.9.41'), name: String(m.name || '') };
    } catch (e) { return { version: '1.9.41', name: '' }; }
  })();
  // Registered before the core's drag handlers so the drop handler can tell
  // an in-page link/image drag from an external tab/OS drop.  A page-internal
  // drag may have already opened its preview on mousedown/mousemove, long
  // before drop; the old 1.5s URL dedupe expired on slow drags and opened a
  // second identical window.
  window.__LPS_DRAG_GUARD__ = null;
  window.__LPS_LAST_OPEN__ = 0;
  window.addEventListener('mousedown', event => {
    try {
      const target = event.target;
      if (target && target.closest && (target.closest('a[href]') || target.closest('img'))) {
        // The gesture layer may open the preview on mousemove, before the
        // browser's native dragstart.  Anchor the drag sequence here so drop
        // can tell whether this exact drag already produced a window.
        window.__LPS_DRAG_GUARD__ = { time: Date.now(), dragging: false };
      }
    } catch (e) { /* ignore */ }
  }, true);
  window.addEventListener('dragstart', event => {
    try {
      const target = event.target;
      if (target && target.closest && (target.closest('a[href]') || target.closest('img'))) {
        if (!window.__LPS_DRAG_GUARD__) window.__LPS_DRAG_GUARD__ = { time: Date.now(), dragging: true };
        else window.__LPS_DRAG_GUARD__.dragging = true;
      } else {
        window.__LPS_DRAG_GUARD__ = null;
      }
    } catch (e) { window.__LPS_DRAG_GUARD__ = null; }
  }, true);
  window.addEventListener('dragend', () => { window.__LPS_DRAG_GUARD__ = null; }, true);
"""
content = header + outer + core + "\n})();\n"
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(content, encoding="utf-8", newline="\n")
print(f"[build] wrote {OUT} ({len(content):,} chars)")
print(f"[build] source delta: {len(original_text):,} -> {len(content):,} chars")


