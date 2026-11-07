'use strict';
/*
 * LinkDrag runtime language layer.
 *
 * The extension UI is available in Simplified Chinese (default) and English.
 * The setting is stored in the same chrome.storage.local settings object as
 * every other extension preference, so it works for the popup, options page,
 * side panel, and the in-page shadow UI.
 */
(function () {
  const SETTINGS_KEY = 'FOX_QQQORANGE_PREVIEW_140_SETTINGS';
  const DEFAULT_LANGUAGE = 'zh-CN';
  let language = DEFAULT_LANGUAGE;

  // Exact UI strings.  localizeTree() translates text nodes and a handful of
  // accessibility/tooltip attributes, leaving page content and user-written
  // prompts untouched.
  const EXACT_EN = {
    // Product / popup
    'Link Preview Suite': 'LinkDrag',
    'LinkDrag 链接预览完全体': 'LinkDrag',
    '链接预览完全体': 'LinkDrag',
    '链接预览完全体 ·': 'LinkDrag ·',
    '链接预览完全体 · 选项与诊断': 'LinkDrag · Options & diagnostics',
    '当前站点': 'Current site',
    '读取中': 'Reading…',
    '个预览': 'previews',
    '全局已暂停': 'Globally paused',
    '本站已暂停': 'This site is paused',
    '运行中': 'Running',
    '全局启用': 'Enable globally',
    '关闭后所有网站都不再自动弹预览': 'When off, automatic previews are disabled everywhere',
    '暂停当前站点': 'Pause this site',
    '只影响这个域名，设置页仍可打开': 'Only affects this host; settings remain available',
    '悬停预览小窗': 'Hover preview',
    '鼠标停留 600ms 出现整屏缩略图': 'Show a full-page thumbnail after hovering for 600ms',
    '链接旁浮出按钮': 'Link action button',
    '链接右侧的小预览按钮': 'Small preview button beside links',
    '图片拖拽高清预览': 'Drag images for full resolution',
    '拖图片直接看原图，不打开缩略网页': 'Drag an image to view the original instead of a thumbnail page',
    '总结当前网页': 'Summarize this page',
    '总结页面音视频': 'Summarize page media',
    '打开总结侧边栏': 'Open summary side panel',
    '页面内完整设置': 'In-page settings',
    '使用说明': 'Help',
    '选项与诊断': 'Options & diagnostics',
    '最近预览': 'Recent previews',
    '暂无记录': 'No history yet',
    '设置': 'Settings',
    'MV3 · 高权限扩展版': 'MV3 · Privileged extension',
    '这个页面不能运行内容脚本': 'This page cannot run content scripts',
    'chrome://、edge://、扩展商店和 PDF 内置查看器属于浏览器保护页面。请打开普通网页后再使用。': 'chrome://, edge://, extension stores and the built-in PDF viewer are protected browser pages. Open a normal webpage to use LinkDrag.',
    '页面脚本尚未连接，请刷新页面后重试': 'The page script is not connected yet. Refresh the page and try again.',
    '页面脚本未响应，已保存到扩展设置': 'The page script did not respond; saved to extension settings',
    '已保存；刷新页面后生效': 'Saved; refresh the page to apply',
    '设置已应用': 'Settings applied',
    '操作失败：页面脚本未响应': 'Action failed: the page script did not respond',
    '请先启用扩展并恢复本站': 'Enable LinkDrag and resume this site first',
    '打开失败：': 'Open failed: ',
    '页面限制': 'page restriction',
    '已暂停本站': 'This site is paused',
    '已恢复本站': 'This site is resumed',
    '文件页面需要在扩展详情里开启“允许访问文件网址”。': 'For file:// pages, enable “Allow access to file URLs” in the extension details.',

    // Options
    'CHROMIUM EXTENSION · MV3': 'CHROMIUM EXTENSION · MV3',
    '把任意链接在当前页浮出预览：多窗口、画中画、阅读模式、悬停小窗、只读快照、嵌套预览与会话恢复；拖拽图片直接查看高清原图。': 'Preview links in place: multiple windows, picture-in-picture, reader mode, hover cards, read-only snapshots, nested previews and session restore; drag images to inspect the original.',
    '在当前页打开完整设置': 'Open full settings on this page',
    '更改扩展快捷键': 'Change extension shortcuts',
    '安装成功。': 'Installed successfully.',
    '打开任意普通网页，按住链接拖动、长按、Alt+点击，或把鼠标停在链接上约 600ms，即可看到预览。工具栏图标提供当前站点开关和最近预览。': 'Open any normal webpage, then drag a link, long-press it, Alt+click it, or hover for about 600ms to see a preview. The toolbar icon provides site controls and recent previews.',
    '扩展级开关': 'Extension switches',
    '这些开关对所有网站生效。更细的动画、主题、阅读模式与触发阈值在「页面内完整设置」里。': 'These switches apply to all websites. Fine-grained animation, theme, reader mode and trigger settings live in “In-page settings”.',
    '关闭后自动入口与右键预览全部暂停': 'Disables automatic entry points and right-click previews',
    '右键菜单': 'Context menu',
    '链接/选中网址/页面设置': 'Links, selected URLs and page settings',
    '工具栏计数徽标': 'Toolbar count badge',
    '显示当前标签页的预览窗口数': 'Show the number of preview windows in the current tab',
    '暂停站点': 'Paused sites',
    '每行或逗号分隔；子域名会一并暂停。暂停后设置/说明窗口仍可打开。': 'One per line or comma-separated; subdomains are included. Settings and help remain available while paused.',
    '保存扩展级设置': 'Save extension settings',
    '运行诊断': 'Diagnostics',
    '扩展版本': 'Extension version',
    '清单版本': 'Manifest version',
    '主机权限': 'Host permissions',
    'http / https / file（需手动允许）': 'http / https / file (manual permission required)',
    '存储占用': 'Storage used',
    '后台抓取': 'Background fetch',
    'Service Worker 独立抓取': 'Independent Service Worker fetch',
    '快捷键': 'Shortcut',
    'Alt+Shift+L 暂停/恢复本站': 'Alt+Shift+L pause/resume this site',
    '打开扩展管理页': 'Open extension manager',
    '检查当前标签页': 'Check current tab',
    'AI 页面助手': 'AI page assistant',
    'AI 不会自动发起请求。已预置 DeepSeek、硅基流动、通义千问、Kimi、OpenAI、Ollama 等服务商配置，通常只需要填写 API Key；也可以改成任意 OpenAI 兼容接口。只有点击网页/播放器旁的 AI 按钮、总结入口或追问后，才会把对应正文发送到你配置的接口。': 'AI never sends requests automatically. Presets are provided for DeepSeek, SiliconFlow, Qwen, Kimi, OpenAI, Ollama and compatible endpoints; usually only an API key is needed. Text is sent only after you click an AI button, summary entry point or follow-up.',
    'AI 服务商': 'AI provider',
    '接口地址': 'Endpoint',
    '模型': 'Model',
    '拉取模型': 'Fetch models',
    'API Key': 'API Key',
    '仅保存在本机 chrome.storage.local；Ollama 等本地接口可留空': 'Stored only in local chrome.storage.local; local endpoints such as Ollama may be empty',
    '测试 Key': 'Test key',
    '清除': 'Clear',
    '媒体总结 API Key': 'Media summary API key',
    '硅基流动 · 单独配置与测试': 'SiliconFlow · configured separately and testable',
    '媒体总结模型': 'Media summary model',
    '音频转写模型': 'Audio transcription model',
    '音频转写接口': 'Audio transcription endpoint',
    '硅基流动 ASR 上传地址': 'SiliconFlow ASR upload endpoint',
    '音频总结提示词': 'Audio summary prompt',
    '视频总结提示词': 'Video summary prompt',
    '留空使用默认模板': 'Leave empty to use the default template',
    '保存 AI 设置': 'Save AI settings',
    '测试连接': 'Test connection',
    '这一版做了什么': 'What changed',
    '原生扩展能力': 'Native extension capabilities',
    '核心增强': 'Core enhancements',
    '安全边界': 'Security boundaries',
    '常见问题': 'FAQ',
    '为什么有些网站仍然不能直接嵌入？': 'Why do some sites still refuse embedding?',
    '为什么 chrome://、edge:// 和扩展商店没有预览？': 'Why do chrome://, edge:// and extension stores have no preview?',
    'file:// 页面怎么启用？': 'How do I enable file:// pages?',
    '扩展刚刚重新加载，旧标签页没反应？': 'The extension just reloaded and old tabs do not respond?',
    '怎么完全恢复默认？': 'How do I reset everything?',
    '清除全部扩展数据': 'Clear all extension data',
    '保存扩展级设置': 'Save extension settings',

    // Summary panels
    '视频总结': 'Video summary',
    '音视频内容总结': 'Media summary',
    '网页 AI 总结': 'Page AI summary',
    '下载字幕 SRT': 'Download SRT subtitles',
    '下载视频': 'Download video',
    '下载音频': 'Download audio',
    '复制总结': 'Copy summary',
    '重新总结': 'Regenerate',
    '取消': 'Cancel',
    '字号': 'Text size',
    '正在读取视频字幕…': 'Reading video subtitles…',
    '从当前视频的字幕/转写中提取内容，交给默认 AI 配置生成文字总结；不会下载或上传视频文件。': 'Extract the current video’s subtitles/transcript and send the text to your default AI configuration. The video file is not downloaded or uploaded.',
    '优先提取音频；没有独立音轨时使用视频链路。媒体只发送到你配置的硅基流动接口。': 'Prefer an audio stream; use the video audio track when no standalone audio exists. Media is sent only to your configured SiliconFlow endpoint.',
    '正在读取网页正文…': 'Reading page content…',
    '准备中…': 'Preparing…',
    '正在处理…': 'Processing…',
    '正在读取网页正文…': 'Reading page content…',
    '已加载完成': 'Loaded',
    '总结完成': 'Summary complete',
    '总结失败': 'Summary failed',
    '没有可提取媒体': 'No extractable media',
    '已取消': 'Cancelled',
    '已取消本次总结。': 'This summary was cancelled.',
    '来源：': 'Source: ',
    '字幕不可用：': 'Subtitles unavailable: ',
    '下载失败': 'Download failed',
    '字幕下载失败': 'Subtitle download failed',
    '视频下载失败': 'Video download failed',
    '总结窗口': 'Summary window',
    '透明度(%)': 'Opacity (%)',
    '总结文字字号(px)': 'Summary text size (px)',
    '贴边位置': 'Dock position',
    '右侧贴边': 'Dock right',
    '左侧贴边': 'Dock left',

    // Settings / language
    '界面语言': 'Interface language',
    '语言': 'Language',
    '常规': 'General',
    '动画与外观': 'Animation & appearance',
    '窗口行为': 'Window behavior',
    '阅读模式': 'Reader mode',
    '触发方式': 'Triggers',
    '快捷 AI': 'Quick AI',
    '扩展集成': 'Extension integration',
    '高级': 'Advanced',
    '默认尺寸': 'Default size',
    '操作与维护': 'Actions & maintenance',
    'AI 接口': 'AI endpoint',
    '主题诊断': 'Theme diagnostics',
    '设置 v': 'Settings v',
    '关闭面板': 'Close panel',
    '统一设置所有动画': 'Use one animation for all actions',
    '统一动画样式': 'Unified animation',
    '打开动画': 'Open animation',
    '打开动画时长': 'Open animation duration',
    '关闭动画': 'Close animation',
    '关闭动画时长': 'Close animation duration',
    '画中画动画': 'Picture-in-picture animation',
    '画中画动画时长': 'Picture-in-picture duration',
    '界面颜色': 'Interface color',
    '自动取色': 'Automatic',
    '强制日间': 'Force light',
    '强制夜间': 'Force dark',
    '取色依据': 'Color source',
    '智能（页面+系统）': 'Smart (page + system)',
    '跟随页面主题变化': 'Follow page theme changes',
    '锁定背景滚动': 'Lock background scroll',
    '暂停背景视频': 'Pause background videos',
    '点击背景关闭': 'Click backdrop to close',
    '记住每个站点的窗口组合': 'Remember window layout per site',
    '刷新后自动恢复窗口': 'Restore windows after reload',
    '多窗口同步滚动': 'Synchronize scrolling across windows',
    '启用预览内查找（按需唤出）': 'Enable in-preview find',
    '在网页中启用 LinkDrag': 'Enable LinkDrag on web pages',
    '暂停站点（逗号分隔）': 'Paused sites (comma-separated)',
    '右键菜单「预览此链接」': 'Context menu “Preview this link”',
    '工具栏图标显示窗口数': 'Show window count on toolbar icon',
    '修改即时生效 · 只保存在本机': 'Changes apply immediately · stored locally',
    '内容总结': 'Content summary',
    'LinkDrag · 内容总结': 'LinkDrag · Content summary',
    '还没有总结': 'No summary yet',
    '在网页中点击「总结当前网页」或「总结页面音视频」，结果会显示在这里。': 'Click “Summarize this page” or “Summarize page media” on a webpage; the result appears here.',
    '复制': 'Copy',
    '已复制': 'Copied',
    '总结': 'Summary',
    '设置数据': 'Settings data',
    '窗口与会话': 'Windows & sessions',
    '记录': 'History',
    '帮助': 'Help',
    '操作与维护': 'Actions & maintenance',
    '扩展集成': 'Extension integration',
    '在网页中启用 LinkDrag': 'Enable LinkDrag on web pages',
    '暂停站点（逗号分隔）': 'Paused sites (comma-separated)',
    '右键菜单「预览此链接」': 'Context menu “Preview this link”',
    '工具栏图标显示窗口数': 'Show window count on the toolbar icon',
    '修改即时生效 · 只保存在本机': 'Changes apply immediately · stored locally',
    '后台音轨捕获倍速': 'Background capture speed',
    '扩展更新': 'Extension updates',
    '每次启动浏览器检查 GitHub 最新发布。只提示是否有新版，不会自动下载；点击更新会打开 GitHub 发布页。': 'Check GitHub for the latest release at browser startup. It only notifies you; nothing is downloaded automatically. Clicking update opens the GitHub release page.',
    '启动时检查更新': 'Check for updates at startup',
    '浏览器启动后在后台检查，发现新版会发通知': 'Check in the background after startup and notify when a new version exists',
    'GitHub 个人访问令牌': 'GitHub personal access token',
    '清除令牌': 'Clear token',
    '公开仓库可以不填；填写 GitHub Personal Access Token 可避免 API 限流。令牌只保存在本机 chrome.storage.local，不会注入网页。无需 repo 写权限，只需读取公开仓库。': 'Optional for a public repository; a GitHub personal access token avoids API rate limits. The token stays in local chrome.storage.local and is never injected into web pages. No repo write scope is needed; read-only public access is enough.',
    '尚未检查': 'Not checked yet',
    '保存更新设置': 'Save update settings',
    '立即检测': 'Check now',
    '打开 GitHub 发布页': 'Open GitHub release',
    '发现新版本': 'Update available',
    '查看更新': 'View update',
    '更新设置已保存。': 'Update settings saved.',
    '正在检查 GitHub 最新版本…': 'Checking GitHub for the latest release…',
    '检查失败，请检查网络或令牌。': 'Check failed. Verify your network or token.',
    '发现新版本；点击「打开 GitHub 发布页」自行下载。': 'A new version is available. Open the GitHub release page to download it.',
    '当前已是最新版本。': 'You are up to date.',
    '已标记清除令牌；点击「保存更新设置」后生效。': 'Token will be cleared after saving.',
    '这些开关对所有网站生效。更细的动画、主题、阅读模式与触发阈值在「页面内完整设置」里。': 'These switches apply everywhere. Fine-grained animation, theme, reader mode and trigger settings are in “In-page settings”.'
  };

  const EXACT_ZH = {};
  for (const [zh, en] of Object.entries(EXACT_EN)) {
    // Values that are already English are useful as English UI labels but
    // must not be treated as Chinese source strings.
    if (/[\u3400-\u9fff]/.test(zh)) EXACT_ZH[en] = zh;
  }

  const PATTERNS_EN = [
    [/^设置 v(.+)$/, (_, v) => `Settings v${v}`],
    [/^(\d+)\s*个预览$/, (_, n) => `${n} preview${Number(n) === 1 ? '' : 's'}`],
    [/^已连接：(.+?) · 运行中 (是|否) · 已开 (\d+) 个预览$/, (_, host, on, n) => `Connected: ${host} · running ${on === '是' ? 'yes' : 'no'} · ${n} previews open`],
    [/^已拉取 (\d+) 个模型，可搜索或选择$/, (_, n) => `Fetched ${n} models; search or choose one`],
    [/^正在拉取模型…$/, () => 'Fetching models…'],
    [/^正在测试连接…$/, () => 'Testing connection…'],
    [/^正在测试普通 API Key…$/, () => 'Testing API key…'],
    [/^正在测试媒体 API Key…$/, () => 'Testing media API key…'],
    [/^已连接：(.*)$/, (_, rest) => `Connected: ${rest}`]
  ];

  function normalize(value) { return value === 'en' ? 'en' : 'zh-CN'; }
  function lang() { return language; }
  function isEnglish() { return language === 'en'; }
  function tr(zh, en) { return isEnglish() ? en : zh; }
  function t(key, vars) {
    const table = (window.LinkDragI18N && window.LinkDragI18N.messages) || {};
    const value = (table[key] && table[key][isEnglish() ? 'en' : 'zh']) || key;
    return vars ? String(value).replace(/\{(\w+)\}/g, (_, name) => vars[name] == null ? '' : vars[name]) : value;
  }

  function translateText(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return value;
    if (isEnglish()) {
      if (EXACT_EN[trimmed]) return String(value).replace(trimmed, EXACT_EN[trimmed]);
      for (const [re, fn] of PATTERNS_EN) {
        const match = trimmed.match(re);
        if (match) return String(value).replace(trimmed, fn(...match));
      }
    } else if (EXACT_ZH[trimmed]) {
      return String(value).replace(trimmed, EXACT_ZH[trimmed]);
    }
    return value;
  }

  function localizeTree(root) {
    if (!root) return;
    if (typeof Node === 'undefined') return;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      for (const textNode of nodes) {
        const next = translateText(textNode.nodeValue);
        if (next !== textNode.nodeValue) textNode.nodeValue = next;
      }
      root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(node => {
        for (const attr of ['placeholder', 'title', 'aria-label']) {
          if (!node.hasAttribute(attr)) continue;
          const value = node.getAttribute(attr);
          const next = translateText(value);
          if (next !== value) node.setAttribute(attr, next);
        }
      });
    } catch (e) { /* ignore */ }
  }

  function localizeDocument(root) {
    const target = root || document;
    localizeTree(target.body || target.documentElement || target);
    try { document.documentElement.lang = isEnglish() ? 'en' : 'zh-CN'; } catch (e) { /* ignore */ }
  }

  function setLanguage(value, apply) {
    language = normalize(value);
    if (apply !== false) localizeDocument(document);
    return language;
  }

  async function init() {
    try {
      const stored = await new Promise(resolve => {
        try {
          chrome.storage.local.get(SETTINGS_KEY, value => {
            try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
            resolve(value && value[SETTINGS_KEY]);
          });
        } catch (e) { resolve(null); }
      });
      setLanguage(stored && stored.language, false);
    } catch (e) { /* keep default */ }
    localizeDocument(document);
    return language;
  }

  window.LinkDragI18N = {
    DEFAULT_LANGUAGE,
    SETTINGS_KEY,
    EXACT_EN,
    messages: {
      previews: { zh: '个预览', en: 'previews' },
      language: { zh: '界面语言', en: 'Interface language' }
    },
    init,
    lang,
    isEnglish,
    tr,
    t,
    translateText,
    localizeTree,
    localizeDocument,
    setLanguage
  };
})();
