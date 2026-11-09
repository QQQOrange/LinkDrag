/* LinkDrag — Chromium extension v1.1.19
 * ---------------------------------------------------------------------------
 * Ported from the v20.3.0 userscript.  The core engine is kept intact; this
 * wrapper provides the browser-extension runtime: MV3 messaging, privileged
 * fetch, storage, context menus, toolbar popup and site-level pause controls.
 *
 * This file is the maintained source.  tools/build_content.py stamps the
 * manifest version into 1.1.19 and writes extension/content.js.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';
  // Idempotence guard: the popup/background may inject this file into an
  // already-open tab after an extension reload.  Never install twice.
  if (window.__LPS_EXTENSION_V21_LOADED__) return;
  window.__LPS_EXTENSION_V21_LOADED__ = true;
  const LPS_MANIFEST = (() => {
    try {
      const m = chrome.runtime.getManifest();
      return { version: String(m.version || '1.1.19'), name: String(m.name || '') };
    } catch (e) { return { version: '1.1.19', name: '' }; }
  })();
  // Registered before the core's drag handlers so the drop handler can tell
  // an in-page link/image drag from an external tab/OS drop.  A page-internal
  // drag may have already opened its preview on mousedown/mousemove, long
  // before drop; the old 1.5s URL dedupe expired on slow drags and opened a
  // second identical window.
  window.__LPS_DRAG_GUARD__ = null;
  window.__LPS_TEXT_DRAG__ = false;
  window.__LPS_LAST_OPEN__ = 0;
  window.addEventListener('mousedown', event => {
    try {
      window.__LPS_TEXT_DRAG__ = false;
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
      // A native drag of selected text also carries text/plain.  Previews are
      // only valid when the drag starts on an actual link or image; everything
      // else (including a selection inside a paragraph) is native text drag.
      let target = event.target;
      if (target && target.nodeType === 3) target = target.parentElement;
      const previewSource = target && target.closest && target.closest('a[href],img');
      if (!previewSource || selectionTouchesEvent(event)) {
        window.__LPS_TEXT_DRAG__ = true;
        window.__LPS_DRAG_GUARD__ = null;
        return;
      }
      window.__LPS_TEXT_DRAG__ = false;
      if (!window.__LPS_DRAG_GUARD__) window.__LPS_DRAG_GUARD__ = { time: Date.now(), dragging: true };
      else window.__LPS_DRAG_GUARD__.dragging = true;
    } catch (e) {
      window.__LPS_TEXT_DRAG__ = false;
      window.__LPS_DRAG_GUARD__ = null;
    }
  }, true);
  window.addEventListener('dragend', () => {
    window.__LPS_TEXT_DRAG__ = false;
    window.__LPS_DRAG_GUARD__ = null;
  }, true);
/* ----------------------------------------------------------------------------------
 *  关于编辑器里那些黄色三角：那不是运行期错误，是油猴编辑器自带的 JSHint 按默认
 *  esversion 5 逐行报的「'const' / 箭头函数 / 模板字符串 is only available in ES6」
 *  之类。下面几行把语言版本与全局符号一次声明清楚，三角就没了：
 *    · esversion 6 —— 本脚本只用 ES6 语法（16 处 ES7 的 .includes() 已全部换成
 *      indexOf()，否则在 esversion 6 下它会被单独报警）；
 *    · global 一行声明 GM_* 与 chrome，避免「未定义变量」类提示；
 *    · unused / undef 关掉，减少与业务无关的噪声；
 *    · eslint-disable 兼容新版编辑器改走 ESLint 的情况。
 * -------------------------------------------------------------------------------- */
/* jshint esversion: 6, browser: true, devel: true, laxbreak: true, laxcomma: true, sub: true, expr: true, loopfunc: true, notypeof: true, unused: false, undef: false */
/* global GM_info, GM_getValue, GM_setValue, GM_setClipboard, GM_xmlhttpRequest, GM_openInTab, GM_addStyle, chrome */
/* eslint-disable */
/*
 *  LinkDrag v1.0 (userscript core v20.3.0)
 *  ────────────────────────────────────────────────────────────────────────────────
 *  v20.3.0 = v20.2.3 + 「渐进显示」：预览窗不再憋到整页加载完才一次性掀开。
 *   用户报「一直在转圈，加载出来之后一次性给我」—— 根因是骨架屏一直盖到 iframe 的
 *   load 事件（所有图片、字体、脚本全部到齐），而 iframe 的网络优先级又天生低于
 *   标签页导航（Chromium 把子框架的资源调度排在主框架导航之后，且 HTTP 缓存按
 *   「顶层站点 × 框架站点」分区 —— 预览 iframe 用的是和标签页完全不同的缓存分区，
 *   哪怕你刚在标签页开过同一个网站，预览里也要整页重新下载）。两件结构性的事任何
 *   用户脚本都改不了，能改的是显示策略：
 *   · 子框架现在会在自身 DOMContentLoaded 时上报 stage='dcl'，宿主收到就撤骨架屏
 *     （revealEarly）—— HTML 解析完、首屏开始上屏的那一刻就掀开，内容边加载边显示，
 *     与直接开新标签页的体感一致；进度条停在 88%，load 到了再收 100%。
 *   · init 不再只等 load 之后发一次：navigate 设完 src 就按 150/600/1400/2400ms 补发，
 *     子框架一应答（ready）即停 —— 子框架要收到 init 才会 enable、才会报 dcl，
 *     设完 src 立刻发的那条大概率会丢（对方还没挂上监听），所以要补发。
 *   · 「ready」消息不再撤骨架屏：它现在在 document-start 就能到（页面还是空白），
 *     真正「可以看了」以 dcl 为准；load 事件与 16 秒超时兜底（子框架脚本没跑起来的
 *     页面 —— 例如被 CSP 拦掉注入 —— 行为与旧版完全一致）。
 *   另：悬停小窗先加载过一遍的话，同一地址的完整预览会命中 HTTP 缓存（两者缓存分区
 *   相同）——「先悬停看一眼再点开」本来就是这个脚本里最快的完整预览路径。
 *
 *  v20.2.3 = v20.2.2 减去三项「提速」（用户报「更卡了，我正常一点就进去了，用这个
 *  等半分钟都没进去」）。这一版只做一件事：把 v20.2.2 里**对普通浏览动过手脚**的地方
 *  全部撤回，让「点一下进网页」回到 v20.2.1 的体感；「打不开时把话说清楚」原样保留。
 *   · 1. 撤回「鼠标划过链接就 preconnect」。它会让一页里被扫过的每个域名都开连接，
 *        链接密集的页面上可能把连接池占住；而预览窗的 iframe 网络优先级天生最低，
 *        只能排在后面等 —— 症状正好就是「正常一点就进去，用这个等半天」。
 *        现在 preconnect 只剩「按下鼠标」这一处，且加了硬上限（PECONNECT_MAX = 8），
 *        到顶就不再建新连接，绝不 clear 重来。
 *   · 2. 撤回「按下鼠标就 prefetch 整页」。那是一次真实的重复下载：**普通点一下链接**
 *        也会在后台把目标页拉一遍，和真正的导航抢带宽、抢同一个 URL 的缓存条目。
 *        prefetch 回到只在「位移过半」与「悬停停够 350ms」这两个意图明确点触发。
 *   · 3. 撤回「页面加载空闲时预建外壳」。它会在**每一个**页面的加载期挂上一个全屏
 *        fixed + isolation 的层并做一次取色重算 —— 对普通浏览是净负担。改为「指针
 *        第一次碰到链接时再排队预建」，收益基本不变，代价挪出页面加载期。
 *  另外顺手改掉 v20.2.2 引入的一处笔误：「中键接管是 v20.2.1 删的」被误写成 v20.2.2。
 *
 *  v20.2.2 = v20.2.1 + 「预览开得更快」与「打不开时把话说清楚」两件事：
 *   · a. [提速 · 已在 v20.2.3 回退] 预热拆两级 + 提前到「指针碰到 / 按下鼠标」：
 *        · preconnectUrl —— 只建 DNS / TCP / TLS，0 字节。
 *        · prefetchUrl  —— 真把 HTML 取回来。
 *      （阶段拆分本身保留：preconnectUrl 仍单独存在，只是调用点收敛到「按下鼠标」。）
 *   · b. [提速 · 已在 v20.2.3 回退] 空闲时预建「外壳」（影子根 + 窗口模板 + 18KB CSS）。
 *      回退原因：会在每个页面的加载期执行，并挂上一个全屏 fixed 层。
 *   · c. [可诊断] 抓取快照带上 HTTP 状态码，4xx/5xx 不再被当成正文渲染 ——
 *      以前站点拒绝抓取（403）会被原样渲染成一张空白页，用户什么都不知道。
 *      阅读模式与小窗静音快照共用同一个抓取函数，一起受益。
 *   · d. [可诊断] 新增「空壳检测」：快照抓回来了、也渲染了，但正文几乎没有内容
 *      （典型是 SPA —— 首屏 HTML 里只有一个空挂载点，正文全靠脚本填，而快照按设计
 *      就是禁用脚本的）。这正是用户报的「预览打开啥都没有，也没提示」。命中后就地
 *      给出原因说明，而不是让用户盯着一片空白。
 *   · e. [新功能] 提示条支持一个动作按钮：上面几种「打不开」的提示现在都直接带一个
 *      「在新标签页打开」，不用再自己跑去工具栏找。跳转用的是 originalUrl ——
 *      进过快照 / 阅读模式的窗口 item.url 可能已经变成 blob: 地址，开那个只会空白。
 *
 *  v20.2.1 = v20.2 + 删除中键接管（用户报「在链接上按中键没开新标签页，反而弹预览小窗」）：
 *   脚本底部原本挂着一个 auxclick 监听：中键点在链接上就 preventDefault() 并直接浮出
 *   预览窗 —— 代价是**吃掉了浏览器原生的「中键 → 后台新标签页打开链接」**。用户明确
 *   表示没设置过、也没要求过这个行为，要求删掉。现已**整段移除**（连监听都不注册），
 *   中键完全走浏览器原生流程。
 *   ⚠️ 不要再把它加回来：中键＝新标签页是用户的既有肌肉记忆，静默改变浏览器既有行为
 *   一旦与预期不符就会显得像 bug。若哪天真要恢复，正确做法是加一个**默认关闭**的设置
 *   项，而不是硬编码接管。
 *   另外，手势层（拖拽 / 长按）本来就只认左键（`event.button !== 0` 直接早退），
 *   Alt+点击走的是另一条分支，所以中键只剩这一处接管点，删掉即彻底干净。
 *
 *  v20.2 = v20.1 + 悬停小窗「声音」治理（用户实测：设了「不自动播放」小窗里照样出声）：
 *   · a. [为什么拦不住] 权限策略只管「有没有用户手势」这一关，浏览器另有两条永远放行的
 *        路：① **静音自动播放永远允许**，而大量视频站的手法就是「先静音起播 → 立刻
 *        取消静音」，这条路径根本不经过 autoplay 权限策略；② 浏览器认为「用户与该
 *        域名互动过 / 该域名 MEI 超阈值」时直接放行有声播放。
 *        更根本的是：小窗里的页面是**跨域**的，父页拿不到它的 DOM —— 点不了暂停、也
 *        调不了音量（HTMLIFrameElement.mute() 只有 Firefox 曾实现，Chromium 没有）。
 *        所以「小窗静音但继续播」在跨域场景下**做不到**，只能靠「改变加载什么」。
 *   · b. [新功能] 小窗标题条新增「停止播放 / 恢复」按钮（一键停声）：点一下立即把
 *        iframe 导航到 about:blank，原文档连同媒体一起销毁 —— 一定停声，且略缩区换成
 *        占位层（点小窗仍可打开完整预览）；再点一下恢复加载。只作用于当前这次小窗，
 *        想要「永远不出声」请把下面的「小窗内视频」设成「静音快照」。
 *   · c. [新功能]「小窗内视频」升级为三档（设置 → 触发方式）：
 *        · 实时页面 · 拒绝自动播放（默认）—— allow="fullscreen; autoplay 'none'"，
 *          挡得住「脚本无手势 play()」，挡不住上面 a 里说的两条路；
 *        · 实时页面 · 不干预 —— 完全交给页面（v20.1 的「不干预」档，行为不变）；
 *        · 静音快照 —— 用 GM_xmlhttpRequest 抓页面 HTML，删掉全部 <script>/<noscript>
 *          与音视频元素、把内嵌播放器（iframe）换成同尺寸占位块，再以
 *          SNAPSHOT_SANDBOX（无 allow-scripts）渲染成 blob。**结构上不存在能发声的
 *          东西 → 100% 无声、100% 不自动播放**。代价：小窗是静态首屏，纯 JS 渲染的
 *          站点会显示不全（这时小窗显示提示文案而不是退回实时页面，以守住「绝对无声」）。
 *          抓取结果按 URL 缓存最近 PEEK_SNAP_MAX 条，并在悬停 350ms 预热时就发起，
 *          因此通常命中缓存、几乎无等待。
 *   · d. [重构] 快照公共预处理（<base> 处理 + 摘 CSP/refresh/x-frame-options meta）
 *        抽成 snapshotPrep(doc, url)，renderSnapshot（禁止嵌入站点）与小窗静音快照共用。
 *
 *  v20.1 = v20.0.1 + 取色重做（色调跟随）+ 悬停小窗视频治理：
 *   · a. [取色] 界面配色不再恒定中性灰 —— 从网页**真实底色**取色相，饱和度封顶 12%，
 *        深色的彩色网页终于会配上同色系的深色窗口；明度映射区间也一并放宽（旧区间太窄，
 *        中间调页面会被硬拽到边缘）。开关：设置 → 动画与外观 →「窗口色调跟随网页」。
 *   · b. [修复] 悬停小窗收起时只做了 hidden，iframe 文档没卸载 —— 页面与其中的视频
 *        继续在后台跑。现在收起即把 iframe 导航到 about:blank（原文档连同媒体一起销毁）。
 *   · c. [新功能] 小窗内视频默认「不自动播放」（显式拒绝 autoplay 权限），可切
 *        「不干预」交给页面。开关：设置 → 触发方式 →「小窗内视频」。
 *        （v20.2 起这一项变成三档，并补上「停止播放」按钮与「静音快照」档。）
 *   · d. [修复] peekGoneTimer 竞态：淡出收尾定时器未在重新展示时清掉，快速「移出→移回」
 *        会让刚出现的小窗立刻又消失；shell 重建时小窗状态也一并作废。
 *
 *  v20.0.1 = v20.0 + 致命样式缺陷修复（含悬停小窗改为「整屏窗口略缩图」）：
 *   · adoptStyles 同根第二次注入会踢掉上一条样式表 → 窗口整片失去样式（见下面 1b）；
 *   · 悬停小窗原本是把 iframe 当视口用，只露出页面左上角一角；现在按窗口内容区的
 *     逻辑尺寸渲染再整体缩放，呈现「完整一屏窗口的略缩图」。
 *
 *  v20.0 四件事（其余逻辑与 v19.2 完全一致）：
 *
 *  1. [新功能] 悬停迷你预览（hover peek）
 *     鼠标在链接上停留超过阈值（默认 600ms，设置里 200–2000ms 可调）弹出一个
 *     比画中画略小的迷你预览窗，标题条带标题 / 域名 / favicon，主体是**完整一屏
 *     窗口的略缩图**（iframe 按窗口内容区的逻辑尺寸 1000×668 渲染，再整体 scale
 *     进小窗 —— 不是页面左上角的一角裁切），点击即用该链接打开完整预览。
 *     移开鼠标 / 滚动 / Esc / 任何 mousedown 都会收起。只在顶层页面生效
 *     （预览窗口内部不嵌套弹小窗，浮出按钮不受影响）。
 *     开关：设置 → 触发方式 →「悬停预览小窗」。
 *     v20.1：小窗里的视频默认不自动播放（拒绝 autoplay 权限），且小窗一收起就把
 *     iframe 导航到 about:blank —— 原文档连同媒体一起销毁，不会在后台继续播。
 *     另有「小窗内视频」开关可切到「不干预」。
 *     v20.2：标题条加「停止播放 / 恢复」按钮（一键停声，一定生效），
 *     「小窗内视频」三档 —— 拒绝自动播放 / 不干预 / 静音快照（绝对无声）。
 *
 *  1b. [致命修复] adoptStyles 在同一根上第二次注入会踢掉上一条样式表
 *     宿主页面的 shell 影子根上先后注入两份 CSS：窗口 CSS（key 'shell'）与浮出按钮
 *     CSS（key 'launcher'）。旧版按「根」只记一条缓存，第二次注入时执行
 *     `list.filter(s => s !== prev.sheet)`，把**上一条别的 key 的样式表**从
 *     adoptedStyleSheets 里剔了出去 —— 浮出按钮一挂上，整份窗口样式表立即失效：
 *     .window 退化成未加样式的块（position:static、宽 730px），标题栏里的 SVG 按默认
 *     尺寸撑成 730×730。用户报的「拖拽不出现窗口、出现很多奇奇怪怪的超大符号」正是
 *     这个（真实 Chromium 已复现；该缺陷 v19.2 就已存在，只是被触发条件掩盖）。
 *     修法：改为「一个根一张 key→样式 的映射表，只替换自己那个 key 的旧条目」，
 *     并在赋值后校验样式表是否真的落地，没落地就走 <style> 回退。
 *
 *  2. [新功能] 禁止嵌入站点的「抓取快照」兜底（embedFallback，默认开）
 *     X-Frame-Options / CSP frame-ancestors 拒绝嵌入的站点，iframe 里只有浏览器
 *     错误页。判定：load 事件后子框架对 init/request 毫无应答（正常嵌入的页面
 *     一定能应答 —— 无论同源还是跨域，脚本在子框架 document-start 就跑了）。
 *     命中后自动用 GM_xmlhttpRequest（不受嵌入限制）抓取 HTML，去掉 <script> 与
 *     CSP / refresh meta、地址全部绝对化，blob URL 渲染进预览窗。sandbox 同时收掉
 *     allow-scripts / allow-same-origin：快照不含脚本，内联 on* 处理器也随 sandbox
 *     一起失效，比逐个剥属性更彻底。样式、图片、链接照常加载；链接点击经
 *     <base target="_blank"> 开新标签页。快照是「只读」的 —— 无法登录、点不动
 *     页面按钮；「刷新」会先重试正常嵌入，仍被拒才再抓一次。
 *
 *  3. [提速] 悬停 350ms 即预热链接（preconnect + prefetch，受「拖拽时预热链接」开关约束）
 *     旧版只在拖拽意图明确（位移过半阈值）时才预热；现在鼠标在链接上停 350ms 就
 *     预热 —— 迷你小窗与完整预览窗命中缓存的概率大幅上升。iframe 的网络优先级
 *     天生低于顶层导航，预热是缩小「预览比直接打开慢」差距的最有效手段。
 *
 *  4. [打磨] 页面底端「已浮出 N 个预览」提示条重做
 *     v19.2 已把它挂进影子宿主、颜色走令牌；本轮把观感收敛：小一号的胶囊
 *     （12px 字号、999px 圆角、78% 透明度的 --toast 底、细至 55% 的描边、
 *     收敛的投影），淡入淡出放缓到 0.3s 且不再有位移弹跳 —— 看得见，但不抢戏。
 *     白夜间跟随：颜色全部来自调色板令牌，主题一变它立刻变。
 *
 *  ── 以下是 v19.2 的改动记录（保留备查） ──────────────────────────────────────────
 *
 *  1. [修复] 页面底端那条「已浮出 N 个预览」的提示不再赖着不走
 *     旧版 toastStandalone() 有三个毛病：
 *       · 提示挂在 document.documentElement 上（在影子宿主外面），读不到 --toast 这些
 *         令牌，颜色是把当时的调色板色值一次性写死进内联样式的 —— 界面换主题它不变；
 *       · 样式里写着 opacity:0!important，随后又用不带 priority 的
 *         setProperty('opacity','1') 去点灯，两者互相打架；
 *       · 收不收得回去只靠一个 3.2 秒定时器，一旦时序或优先级出岔子，它就永远贴在
 *         页面底端（用户报的正是这个）。
 *     修法：提示改挂进宿主影子根，颜色 / 圆角 / 磨砂全部走调色板令牌，界面一变它
 *     立刻跟着变；显示 1.6 秒 → 淡出 0.24 秒 → 再补一个 hidden 兜底，双保险。
 *     顺手清掉旧版可能残留在页面里的 #ldp-standalone-toast 节点。
 *
 *  2. [修复] 拖放提示层（「松手即在此页浮出预览」）不会再永远挂在页面上
 *     旧版只看 dragenter / dragleave 计数，可浏览器并不保证一定派发 dragleave：
 *     松手落在预览窗口的 iframe 里、或拖到窗口外再松手，宿主页面一个事件都收不到，
 *     计数永远减不回 0。现在每次 dragenter / dragover 都续一次期，900ms 内没有新的
 *     拖拽事件就自动收干净（dragend / pagehide 也一并收尾）。
 *
 *  3. [清理] 油猴编辑器里成片的黄色三角警告
 *       · 脚本头补 jshint esversion / global 声明，并关掉 unused / undef 噪声；
 *       · 16 处 .includes() 换成 indexOf()（ES7 API，esversion 6 下会单独报警）；
 *       · 删掉 v18 之后就没人引用的死常量 ACCENT_SELECTORS；
 *       · void win.offsetHeight 改成 Number(win.offsetHeight)（JSHint 对「非赋值、
 *         非调用的表达式语句」会报 W030）；
 *       · CSSStyleSheet / CustomEvent / NodeFilter / MutationObserver / URL 一律写成
 *         window.xxx，避免「未定义变量」类警告。
 *
 *  ── 以下是 v19.1 的改动记录（保留备查） ──────────────────────────────────────────
 *  承接 v19.0（液态玻璃下线、极简材质），v19.1 修四个问题：
 *
 *  1. [修复] 同步滚动从未真正生效（用户报「开了没什么用」，属实）
 *     两个断点：
 *       · 断点一：预览窗口滚动时子框架上报 innerScroll，宿主的转发逻辑却写在了
 *         「token 校验失败」分支里 —— 正常初始化的窗口 token 必然匹配，于是走到
 *         「已找到 item」分支直接 return，转发代码永远不执行。修法：innerScroll
 *         的转发提到 token 校验之前，与 token 无关。
 *       · 断点二：宿主页面滚动广播的 'sync' 消息不带 token，子框架脚本在
 *         `data.token !== bridgeToken` 处直接丢弃，子框架也从来没有 'sync' 的
 *         处理分支。修法：子框架把 'sync' 并入 setScroll 同一条应用逻辑。
 *     另加防回环：A 滚动 → 宿主转发 setScroll 给 B → B 的程序滚动不再回传
 *     innerScroll（240ms 抑制窗），否则 A↔B 会互相触发形成抖动循环。
 *
 *  2. [调整] 同步滚动按钮从工具条移除（按用户要求）
 *     功能保留：设置面板的「多窗口同步滚动」复选框 + Alt+Shift+S 快捷键。
 *     新语义：任意预览窗口内滚动，其余预览窗口按比例跟随 —— 谁滚动谁就是源，
 *     不再依赖「焦点切换主窗口」那套（连同误导性的切换提示一并删掉）。
 *
 *  3. [修复] 设置里的「强制暗色滤镜」是死设置
 *     settings.forceDark 定义了、面板里能勾，但全脚本没有任何地方读它 ——
 *     勾了什么都不发生（标题栏按钮是另一套 per-window 状态，一直正常）。
 *     修法：勾选立即对全部已开窗口生效（上滤镜 / 摘滤镜）；新窗口以它为初始值。
 *
 *  4. [打磨] 两类动画重做
 *     · 苹果线性：对称 ease-in-out 起手慢、显得肉。换成 iOS 抽屉/表单同族的
 *       cubic-bezier(0.32,0.72,0,1) —— 起手快、长滑行、无过冲。
 *     · 物理回弹：过冲 1.32 收敛为 1.28 并加快起手；关闭方向加「预备动作」
 *       （先微微鼓一下再被吸走，easeInBack 的反向用法）。
 *     · 透明度与缩放分离编排：打开时透明度在前 45% 就位（窗口先「显形」再生长）、
 *       关闭时透明度保持到最后 45% 才淡出（先收缩、后消失，回到拖拽点而不是
 *       原地变没）。此前两者共用同一条曲线，观感糊成一片。
 *
 *  ── 结构 ────────────────────────────────────────────────────────────────────────
 *     §1 常量与配置      §2 环境适配与存储   §3 通用工具
 *     §4 颜色与主题引擎  §5 材质（唯一来源）  §6 样式与模板
 *     §7 手势与浮出按钮  §8 子框架桥接        §9 宿主状态与几何
 *     §10 窗口渲染       §11 生命周期与动画   §12 面板
 *     §13 阅读模式       §14 会话与恢复       §15 宿主接入
 *  边缘算法（阅读模式密度打分、主题多信号投票、嵌套桥接、会话双闸恢复）逐字保留。
 */
(function () {
  'use strict';

  /* ==================================================================================
   *  §1 常量与配置
   * ================================================================================== */
  const CHANNEL = 'FOX_QQQORANGE_PREVIEW_140';   // 与子框架通信的 channel（沿用，避免旧子框架失联）
  const STORE = 'FOX_QQQORANGE_PREVIEW_140';
  const SETTINGS_KEY = STORE + '_SETTINGS';
  const LAYOUTS_KEY = STORE + '_LAYOUTS';
  const HISTORY_KEY = STORE + '_HISTORY';
  const SESSIONS_KEY = STORE + '_SESSIONS';
  const AI_CONFIG_KEY = STORE + '_AI';
  const AI_PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    { id: 'siliconflow', label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3' },
    { id: 'qwen', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    { id: 'kimi', label: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    { id: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2' },
    { id: 'custom', label: '自定义接口', endpoint: '', model: '' }
  ];
  const DEFAULT_SUMMARY_PROMPT = '请总结下面网页正文的核心观点、关键事实和结论，控制在简洁的要点中。';
const DEFAULT_AI_CONFIG = { provider: 'deepseek', endpoint: AI_PROVIDERS[0].endpoint, model: AI_PROVIDERS[0].model, apiKey: '', apiKeys: {}, models: {}, providerConfigs: {}, selectedModels: {}, mediaApiKey: '', mediaModel: 'FunAudioLLM/SenseVoiceSmall', mediaEndpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions', summaryPrompt: DEFAULT_SUMMARY_PROMPT };
  const TAB_MARK_KEY = STORE + '_TAB_MARK';
  const SCHEMA_KEY = STORE + '_SCHEMA';
  const SCHEMA_VERSION = 210;
  const SCRIPT_VERSION = (() => {
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
    return '1.1.19';
  })();

  const TOP = window.self === window.top;
  const LONG_PRESS_MOVE = 4;      // 长按期间允许的手指抖动
  const PIP_SCALE = 0.3;          // 非紧凑画中画的缩放
  const PIP_BAR_H = 36;           // 紧凑画中画小条高度
  const LAUNCHER_SIZE = 22;
  const MAX_HISTORY = 20;
  const MAX_FIND = 1200;          // 单次查找最多高亮处数
  const MAX_FIND_NODES = 9000;    // 单次查找最多扫描的文本节点数
  const THEME_SAMPLE_TTL = 1200;  // 取色缓存时长
  const THEME_MUTATE_DEBOUNCE = 320;
  const READY_TIMEOUT = 16000;
  const INFO_TIMEOUT = 2200;
  /* v20.3：navigate 之后 init 的重发时刻（毫秒）。子框架脚本跑在 document-start，
     但它挂上 message 监听的具体时刻我们无从得知 —— 设完 src 立刻发的第一条大概率
     会丢。按这几个时刻各补发一次，直到子框架回 ready。目的见 navigate 里的说明。 */
  const INIT_PING_MS = [150, 600, 1400, 2400];
  const FRAME_FOCUS_HZ = 400;
  const GLASS_MAX = 40;           // 「界面玻璃磨砂」量程上限，t = 值 / GLASS_MAX
  /* v20：预览 iframe 的两种 sandbox 形态。
     FULL_SANDBOX —— 正常嵌入（与模板里的 iframe sandbox 一致，改一处必须同步另一处）；
     SNAPSHOT_SANDBOX —— 只读快照：没有 allow-scripts（页面脚本与内联 on* 全部失效）、
     没有 allow-same-origin（快照与宿主彻底隔离），保留 allow-popups 供
     <base target="_blank"> 的链接开新标签页。 */
  const FULL_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  // Reader and snapshot documents contain fetched third-party HTML.  They must
  // never execute scripts.  Reader keeps allow-same-origin only so the host
  // can read its DOM for find/TTS/export; snapshots get an opaque origin.
  const READER_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
  const SNAPSHOT_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
  /* v20：悬停迷你预览的几何 —— 呈现的是「完整窗口的一屏略缩」，比非紧凑画中画
     （0.3×默认窗 = 300×216）略小一号。iframe 按窗口内容区的逻辑尺寸渲染，再整体
     缩放到小窗里，所以看到的是整屏窗口，而不是页面左上角的一角裁切。 */
  const PEEK_W = 260;             // 小窗（= 略缩图）宽度上限（略缩比例由此推导）
  const PEEK_HEAD_H = 26;         // 标题条高度
  const PEEK_MAX_BODY_H = 190;    // 略缩图区高度上限（按窗口宽高比自动收缩）
  const PEEK_REF_CHROME_H = 52;   // 窗口标题栏所占高度：略缩的是「内容区」而不是整窗外框
  const PEEK_WARM_MS = 350;       // 悬停多久后开始预热链接
  /* 悬停小窗内视频的策略（设置项 peekVideo，v20.2 起三档）。
     · block    —— 显式拒绝 autoplay 权限：页面脚本无手势的 play() 会被拒，<video autoplay>
       属性也被忽略。跨域 iframe 本来就默认拒绝（autoplay 的默认允许列表是 self），
       写出来是为了把意图固定住 —— 同源渲染（例如抓取快照）时同样生效。
       ⚠ 但它**只管「有没有用户手势」这一关**：浏览器另有两条永远放行的路 —— 静音自动
       播放永远允许（站点的「先静音起播 → 立刻取消静音」因此绕过整套策略），以及
       浏览器认定「用户与该域名互动过 / 该域名 MEI 超阈值」时直接放行有声播放。
     · allow    —— 不写任何声明，完全交给页面自己。
     · snapshot —— 不加载实时页面，改渲染脚本自己抓取并清洗过的静态快照（删掉全部
       脚本、音视频元素与内嵌播放器），结构上不存在能发声的东西，绝对无声。
     另外无论哪一档，小窗收起时都会把 iframe 导航到 about:blank（peekStopFrame），
     把原文档连同它的媒体一起销毁 —— 否则页面会在隐藏的 iframe 里继续播放。 */
  const PEEK_ALLOW_BLOCK = "fullscreen; autoplay 'none'";
  const PEEK_ALLOW_OPEN = 'fullscreen';
  const PEEK_SNAP_MAX = 6;        // 小窗静音快照缓存条数（按 URL 去重）

  /* v19.1 动画曲线重做：
     · EASE_APPLE —— iOS 抽屉/表单同族曲线：起手快（窗口立刻「弹出」）、长滑行、
       无过冲。v19.0 的对称 ease-in-out(0.42,0,0.58,1) 起手太慢，观感发肉。
     · EASE_SPRING —— 单次轻回弹：起手快、过冲收敛到 1.28、落位干脆。
     · EASE_SINK   —— 关闭收拢用：加速曲线，窗口「被吸入」拖拽点而不是匀速缩没。
     · EASE_ANTIC  —— 物理回弹的关闭方向：先微微鼓一下（scale 略过 1）再被吸走，
       easeInBack 的反向用法，给「关」一个可感知的预备动作。 */
  const EASE_APPLE = 'cubic-bezier(0.32,0.72,0,1)';
  const EASE_SPRING = 'cubic-bezier(0.18,0.89,0.32,1.28)';
  const EASE_SINK = 'cubic-bezier(0.55,0.06,0.68,0.19)';
  const EASE_ANTIC = 'cubic-bezier(0.36,0,0.66,-0.56)';
  const APPLE_FROM_SCALE = 0.22;      // 从拖拽点生长时的起始缩放（v17 由 .965 放开）
  const SPRING_FROM = 'translate3d(0,14px,0) scale(.94)';

  /* backdrop-filter 能力探测。CSS 这个标识符在本文件里被样式常量占用了，所以走 window.CSS。 */
  const CAN_BLUR = (() => {
    try {
      const s = window.CSS && window.CSS.supports;
      if (!s) return true;
      return !!(s('backdrop-filter', 'blur(4px)') || s('-webkit-backdrop-filter', 'blur(4px)'));
    } catch (e) { return true; }
  })();

  /* v19：液态玻璃三件套（边缘透镜 / 指针跟随高光 / 真实边缘折射）已按用户要求
     整体下线。这里曾有一段 64×64 位移贴图（LENS_MAP）+ feDisplacementMap 的
     SVG 滤镜定义（refractFilterMarkup / ensureRefractDefs）与指针高光的
     rAF 换算（setSheen / flushSheen），全部删除；材质回归「细描边 + 投影 + 轻磨砂」。 */

  /* ---- 运行环境适配：同一份核心，油猴 / 扩展内容脚本都能跑 ---------------------------- */
  const EXT = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? chrome : null;
  const HAS = {
    gmStore: typeof GM_getValue === 'function' && typeof GM_setValue === 'function',
    gmClip: typeof GM_setClipboard === 'function',
    gmTab: typeof GM_openInTab === 'function',
    extStore: !!(EXT && EXT.storage && EXT.storage.local),
    clipApi: !!(navigator && navigator.clipboard && navigator.clipboard.writeText)
  };
  const T = {
    openInTab(url, active) {
      const target = httpUrl(url);
      if (!target) return false;
      const anchorFallback = () => {
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
      };
      // v21: extension background owns tab creation.  This works even when the
      // page has a sandbox/CSP that blocks window.open, and it keeps the new tab
      // out of the host page's opener chain.
      if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
        try {
          EXT.runtime.sendMessage({
            namespace: 'LPS_EXT', type: 'ldp:openTab', url: target,
            active: active !== false
          }, response => {
            let err = null;
            try { err = EXT.runtime.lastError; } catch (e) { /* 忽略 */ }
            if (err || !response || !response.ok) anchorFallback();
          });
          return true;
        } catch (e) { /* 落到浏览器兜底 */ }
      }
      try { if (HAS.gmTab) { GM_openInTab(target, { active: active !== false, insert: true, setParent: true }); return true; } } catch (e) { /* 继续兜底 */ }
      return anchorFallback();
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
    }
  };

  const DEFAULTS = {
    language: 'zh-CN',
    remember: true, grouping: 'site', theme: 'auto',
    blur: true, blurAmount: 8, glassBlur: 22, windowOpacity: 100, radius: 26,
    themeSource: 'smart', themeFollow: true, pageTint: false,
    // v18：界面配色改成恒定中性灰。原来这里是 pageAccent / followPageHue 两个开关，
    // 默认都开着 —— 近白偏蓝的页面（如 #e8f0fe）会越过极差闸门，把整窗染蓝；
    // pageAccent 还会直接把页面 <a> 的默认蓝色拿来当强调色。按用户要求整体删掉，
    // 页面底色只再影响窗口的深浅（明度），不再影响色调（色相/饱和度）。
    // v19：液态玻璃三项（liquidRefract / refractAmount / liquidSheen）整体删除，
    // 旧存档里的字段由 normalizeSettings() 按「不在 DEFAULTS 里就删」自动清理。
    // v20.1：按用户反馈「深色网页配中性灰窗口，外框跟网页对不上」重新引入色调跟随 ——
    // 但这次采集源是「网页真实底色」（v18 的问题出在采 <a> 默认蓝 / meta theme-color，
    // 源本身就是错的），且饱和度封顶 TINT_MAX_S，不会重演整窗染蓝。pageTint 关掉即
    // 回到 v18 的绝对中性灰。
    lockScroll: true, lockScrollWhenPip: false, pauseVideos: true,
    backdropClose: true, escapeClose: true,
    animation: 'apple', duration: 300, closeAnimation: 'apple', closeDuration: 320,
    pipAnimation: 'apple', pipDuration: 300,
    unifyAnim: false, unifiedAnim: 'apple',
    longPressOpen: true, longPressDelay: 500, altClickOpen: true, linkButton: true,
    aiQuick: true, aiQuickWhitelist: '', aiQuickBlacklist: '',
    videoAI: true, summaryDock: 'right', summaryOpacity: 100, summaryFontSize: 14, captureRate: 4,
    // v20.2：peekVideo 三档 —— block（拒绝自动播放）/ snapshot（静音快照，绝对无声）/ allow（不干预）
    hoverPeek: true, hoverDelay: 600, peekVideo: 'block',
    dragHold: 150, warmup: true, embedFallback: true,
    threshold: 12, zoomStep: 10, desktopWidth: 1000, desktopHeight: 720,
    offsetX: 0, offsetY: -8, blacklist: '', snapEnabled: true, pipEnabled: true,
    pipSide: 'right', pipStack: 'down', pipCompact: true, pipBarWidth: 220,
    maxWindows: 8,
    phoneMode: true, phoneWidth: 420, readerHideImages: false, forceDark: false,
    readerFontSize: 17, readerLineHeight: 190,
    autoFocus: true, favicon: true,
    sessionMemory: true, sessionAuto: false,
    syncScroll: false, gridMenu: true, findBar: true,
    spawnMode: 'default', toolbarSide: 'auto', dblClick: 'center',
    shortcuts: true,
    shortcutsMap: 'alt+shift+f=find,alt+shift+s=sync,alt+shift+r=restore,alt+shift+h=help,alt+shift+w=close,alt+shift+q=closeall,alt+shift+e=reader,alt+shift+p=pipall',
    showHelpOnce: false,
    // v21 extension integration
    enabled: true, disabledSites: '', contextMenu: true, badgeCount: true,
    imageDragPreview: true
  };
  const RANGES = {
    blurAmount: [0, 24, 1], glassBlur: [0, 40, 1], radius: [0, 40, 1],
    duration: [0, 10000, 50], closeDuration: [0, 10000, 50],
    windowOpacity: [60, 100, 5], pipDuration: [0, 2000, 50],
    longPressDelay: [200, 2000, 50], dragHold: [0, 800, 20],
    hoverDelay: [200, 2000, 50],
    threshold: [5, 80, 1], zoomStep: [1, 25, 1],
    desktopWidth: [280, 3000, 10], desktopHeight: [220, 2000, 10],
    offsetX: [-50, 50, 1], offsetY: [-50, 50, 1], maxWindows: [2, 12, 1],
    pipBarWidth: [120, 400, 10], phoneWidth: [280, 900, 20],
    readerFontSize: [12, 28, 1], readerLineHeight: [120, 260, 10],
    summaryOpacity: [40, 100, 2],
    summaryFontSize: [12, 22, 1],
    captureRate: [2, 8, 1]
  };
  const ANIM_CHOICES = [['none', '关闭'], ['apple', '苹果线性'], ['spring', '物理回弹']];
  const ENUMS = {
    language: ['zh-CN', 'en'],
    animation: ['none', 'apple', 'spring'],
    closeAnimation: ['none', 'apple', 'spring'],
    pipAnimation: ['none', 'apple', 'spring'],
    unifiedAnim: ['none', 'apple', 'spring'],
    theme: ['auto', 'light', 'dark'],
    themeSource: ['smart', 'page', 'scheme', 'system'],
    peekVideo: ['block', 'snapshot', 'allow'],
    grouping: ['site', 'section', 'page'],
    pipSide: ['left', 'right'],
    pipStack: ['down', 'up'],
    spawnMode: ['default', 'cursor', 'cascade'],
    toolbarSide: ['auto', 'left', 'right', 'inside'],
    dblClick: ['center', 'maximize', 'none']
  };
  const LEGACY_SHORTCUT_DEFAULT = 'alt+shift+f=find,alt+shift+s=sync,alt+shift+r=restore,alt+shift+h=help';
  const THEME_ATTRS = ['class', 'style', 'data-theme', 'data-color-mode', 'data-color-scheme',
    'data-scheme', 'data-mode', 'data-bs-theme', 'data-darkreader-scheme'];

  /* ---- 最底层纯工具 --------------------------------------------------------------
     这几个必须放在 §2 之前：§2 的 readStore() 用到 isObj()，§1 末尾的 normalizeSettings()
     用到 clampNum()。它们都是 const 箭头函数，没有函数声明那种提升，放在 §3 里会在
     初始化阶段直接撞 TDZ（Cannot access 'clampNum' before initialization），整个脚本
     一行功能都跑不起来。                                                             */
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const clampNum = (n, min, max, fallback, isInt) => {
    let v = Number(n);
    if (!Number.isFinite(v)) v = fallback;
    v = clamp(v, min, max);
    return isInt ? Math.round(v) : v;
  };
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const pct = n => (Math.round(n * 1000) / 10) + '%';

  /* ==================================================================================
   *  §2 环境适配与存储
   * ================================================================================== */
  const extCache = Object.create(null);
  let extReady = !HAS.extStore;
  const extReadyHooks = [];
  function onExtStoreReady() {
    extReady = true;
    for (const fn of extReadyHooks.splice(0)) { try { fn(); } catch (e) { /* 忽略 */ } }
  }
  function whenStoreReady(fn) {
    if (extReady) { try { fn(); } catch (e) { /* 忽略 */ } return; }
    extReadyHooks.push(fn);
  }
  if (HAS.extStore) {
    try {
      EXT.storage.local.get(null, all => {
        try { void EXT.runtime.lastError; } catch (e) { /* 忽略 */ }
        if (all && typeof all === 'object') {
          for (const k of Object.keys(all)) extCache[k] = all[k];
        }
        onExtStoreReady();
      });
    } catch (e) { onExtStoreReady(); }
  }
  /** 读只认对象/数组：形态不对（或标量）一律当「读不到」 */
  function readStore(key, fallback) {
    try {
      const v = HAS.extStore ? extCache[key] : GM_getValue(key, fallback);
      if (isObj(v)) return v;
      if (Array.isArray(v) && Array.isArray(fallback)) return v;
      return fallback;
    } catch (e) { return fallback; }
  }
  function writeStore(key, value) {
    try {
      if (HAS.extStore) { extCache[key] = value; EXT.storage.local.set({ [key]: value }); return true; }
      GM_setValue(key, value);
      return true;
    } catch (e) { return false; }
  }
  /** 原样读写：配置架构版本号这类标量走这两个 */
  function readRaw(key, fallback) {
    try {
      if (HAS.extStore) return (key in extCache) ? extCache[key] : fallback;
      return GM_getValue(key, fallback);
    } catch (e) { return fallback; }
  }
  function writeRaw(key, value) {
    try {
      if (HAS.extStore) { extCache[key] = value; EXT.storage.local.set({ [key]: value }); return true; }
      GM_setValue(key, value);
      return true;
    } catch (e) { return false; }
  }
  /** v12 / v13 → 现有存储键的一次性搬运 */
  function migrateLegacy() {
    if (HAS.extStore) return;   // extension uses chrome.storage, not GM_* legacy keys
    let done = true;
    try { done = GM_getValue(STORE + '_MIGRATED', false) === true; } catch (e) { done = true; }
    if (done) return;
    try {
      const cur = {
        settings: readStore(SETTINGS_KEY, {}),
        layouts: readStore(LAYOUTS_KEY, {}),
        history: readStore(HISTORY_KEY, [])
      };
      const pick = suf => {
        for (const base of ['FOX_QQQORANGE_PREVIEW_130', 'FOX_QQQORANGE_PREVIEW_121']) {
          const a = readStore(base + suf, {});
          if (a && Object.keys(a).length) return a;
        }
        return {};
      };
      if (!Object.keys(cur.settings).length) {
        const old = pick('_SETTINGS');
        if (Object.keys(old).length) writeStore(SETTINGS_KEY, old);
      }
      if (!Object.keys(cur.layouts).length) {
        const old = pick('_LAYOUTS');
        if (Object.keys(old).length) writeStore(LAYOUTS_KEY, old);
      }
      if (!cur.history.length) {
        const old = pick('_HISTORY');
        if (Array.isArray(old) && old.length) writeStore(HISTORY_KEY, old);
      }
      writeStore(STORE + '_MIGRATED', true);
    } catch (e) { /* 忽略迁移失败 */ }
  }

  let settings = Object.assign({}, DEFAULTS, readStore(SETTINGS_KEY, {}));
  let layouts = readStore(LAYOUTS_KEY, {});
  let history = (() => { const h = readStore(HISTORY_KEY, []); return Array.isArray(h) ? h : []; })();
  let sessions = readStore(SESSIONS_KEY, {});
  let aiConfig = Object.assign({}, DEFAULT_AI_CONFIG, readStore(AI_CONFIG_KEY, {}));
  if (aiConfig.mediaEndpoint && /chat\/completions/i.test(aiConfig.mediaEndpoint)) { aiConfig.mediaEndpoint = 'https://api.siliconflow.cn/v1/audio/transcriptions'; if (!aiConfig.mediaModel || /Qwen3-Omni/i.test(String(aiConfig.mediaModel || ''))) aiConfig.mediaModel = 'FunAudioLLM/SenseVoiceSmall'; }
  let dirtySettings = false;

  /** 字段级规范化：类型不对回默认、数值夹进量程、枚举不在表里回默认、未知字段删除 */
  function normalizeSettings() {
    const before = JSON.stringify(settings);
    for (const key of Object.keys(DEFAULTS)) {
      const def = DEFAULTS[key];
      const val = settings[key];
      if (typeof def === 'boolean') { if (typeof val !== 'boolean') settings[key] = def; continue; }
      if (typeof def === 'string') { if (typeof val !== 'string') settings[key] = def; continue; }
      if (typeof def === 'number') {
        const range = RANGES[key];
        settings[key] = range
          ? clampNum(val, range[0], range[1], def, range[2] === 1)
          : (Number.isFinite(Number(val)) ? Number(val) : def);
      }
    }
    for (const key of Object.keys(ENUMS)) if (ENUMS[key].indexOf(settings[key]) < 0) settings[key] = DEFAULTS[key];
    for (const key of Object.keys(settings)) if (!(key in DEFAULTS)) delete settings[key];
    if (JSON.stringify(settings) !== before) dirtySettings = true;
  }
  if (settings.shortcutsMap === LEGACY_SHORTCUT_DEFAULT) settings.shortcutsMap = DEFAULTS.shortcutsMap;
  normalizeSettings();
  try {
    if (window.LinkDragI18N) window.LinkDragI18N.setLanguage(settings.language, false);
  } catch (e) { /* ignore */ }

  /** 架构迁移：处理「同一个字段换了含义」的情况 —— 旧仓里的旧值仍是合法值，靠 DEFAULTS 补不上 */
  function migrateSchema() {
    // 扩展环境下 chrome.storage 是异步就绪的，此时判断「有没有存过配置」必然错，推迟到 reloadFromStore()
    if (!extReady) return;
    const cur = Number(readRaw(SCHEMA_KEY, 0)) || 0;
    if (cur >= SCHEMA_VERSION) return;
    const stored = readStore(SETTINGS_KEY, {});
    if (Object.keys(stored).length) {
      // 任何一处真的改动都要落盘，否则迁移结果只活在本次加载里（下次 SCHEMA 已更新，不会再迁）
      if (stored.sessionAuto === true) { settings.sessionAuto = false; dirtySettings = true; }
      if (stored.dragHold === 260) { settings.dragHold = DEFAULTS.dragHold; dirtySettings = true; }
      if (stored.duration === 400) { settings.duration = DEFAULTS.duration; dirtySettings = true; }
      // v18：删掉两个染色开关。老存档里它们若是 true，必须显式压掉 —— 光靠 DEFAULTS
      // 补不上（旧值本身是合法值），留着就会继续把界面染蓝。
      // （键本身由紧随其后的 normalizeSettings() 按「不在 DEFAULTS 里就删」清掉。）
      if (stored.pageAccent === true || stored.followPageHue === true) {
        settings.pageAccent = false;
        settings.followPageHue = false;
        dirtySettings = true;
      }
    }
    writeRaw(SCHEMA_KEY, SCHEMA_VERSION);
    if (dirtySettings) { writeStore(SETTINGS_KEY, settings); dirtySettings = false; }
  }
  migrateLegacy();
  migrateSchema();
  normalizeSettings();
  if (dirtySettings) { writeStore(SETTINGS_KEY, settings); dirtySettings = false; }

  /* ==================================================================================
   *  §3 通用工具
   * ================================================================================== */
  // clamp / clampNum / isObj / isStr / pct 定义在 §1 末尾（§2 与本段都需要，必须前置）

  /**
   * 事件目标是否落在我们自己的 UI 里。
   * UI 全挂在影子宿主下，事件跨影子边界会被重定向到宿主元素本身，所以判 identity / contains
   * 就够 —— 比每次拼一条 composedPath() 数组便宜得多，而 mouseover 是整站最高频的事件之一。
   */
  function targetInHost(event, hostEl) {
    const t = event && event.target;
    if (!hostEl || !t) return false;
    if (t === hostEl) return true;
    return t.nodeType === 1 && hostEl.contains(t);
  }

  function addToHistory(url, title) {
    history = history.filter(h => h && h.url !== url);
    history.unshift({ url, title: title || url, time: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    writeStore(HISTORY_KEY, history);
  }
  function isBlacklisted(url) {
    const list = settings.blacklist;
    if (!list) return false;
    try {
      const host = new window.URL(url).hostname;
      return list.split(',').some(b => { const t = b.trim(); return t && host.indexOf(t) >= 0; });
    } catch (e) { return false; }
  }
  function httpUrl(value, base) {
    if (!isStr(value) || !value.trim()) return '';
    try {
      const url = new window.URL(value, base || location.href);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (e) { return ''; }
  }
  function pageTitle(doc) {
    if (!doc) return '';
    // 取属性 / 取文本都要先判空再读：这里不用可选链，是为了让脚本整体停在 ES2017
    // 语法内（油猴编辑器的语法检查按 esversion 6 报，出现 ?. 会整行标感叹号）。
    const pick = sel => {
      const node = doc.querySelector(sel);
      return node ? (node.content || node.textContent || '') : '';
    };
    const raw = doc.title
      || pick('meta[property="og:title"]')
      || pick('meta[name="twitter:title"]')
      || pick('h1')
      || '';
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  function viewport() { return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) }; }
  function prefersDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }
  /** 标题栏图标候选：先取站点自己的 favicon，再走两个图标服务兜底 */
  function faviconCandidates(url) {
    let origin = '', host = '';
    try {
      const u = new window.URL(url);
      if (!/^https?:$/.test(u.protocol)) return [];
      origin = u.origin;
      host = u.hostname;
    } catch (e) { return []; }
    if (!host) return [];
    return [
      origin + '/favicon.ico',
      'https://icons.duckduckgo.com/ip3/' + host + '.ico',
      'https://favicon.im/' + host + '?larger=true'
    ];
  }
  /** 中文/字母数字都算「词字符」，用于全词匹配 */
  function isWordChar(ch) { return !!ch && /[\w\u4e00-\u9fff]/.test(ch); }
  function wordBounded(text, idx, len) {
    const before = idx > 0 ? text.charAt(idx - 1) : '';
    const after = idx + len < text.length ? text.charAt(idx + len) : '';
    return !isWordChar(before) && !isWordChar(after);
  }
  function findUrlInText(text) {
    if (!text) return '';
    const m = text.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) return httpUrl(m[0].replace(/[),.，。；;]+$/, ''));
    const m2 = text.match(/\b((?:[\w-]+\.)+[a-z]{2,})(\/[^\s"'<>]*)?/i);
    if (m2) return httpUrl('https://' + m2[0]);
    return '';
  }
  function parseShortcuts(text) {
    const map = Object.create(null);
    String(text || '').split(',').forEach(item => {
      const i = item.indexOf('=');
      if (i < 0) return;
      const key = item.slice(0, i).trim().toLowerCase().replace(/\s+/g, '');
      const action = item.slice(i + 1).trim().toLowerCase();
      if (key && action) map[key] = action;
    });
    return map;
  }
  function keyCombo(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');
    let key = String(event.key || '').toLowerCase();
    if (!key || key === 'control' || key === 'alt' || key === 'shift' || key === 'meta') return '';
    // macOS Option+Shift can turn letters into symbols (e.g. Ï).  Physical
    // code keeps the documented Alt+Shift+F style shortcuts working.
    const letter = /^Key([A-Z])$/.exec(String(event.code || ''));
    if (letter) key = letter[1].toLowerCase();
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(String(event.code || ''));
    if (digit) key = digit[1];
    if (key === ' ') key = 'space';
    if (key === 'escape') key = 'esc';
    parts.push(key);
    return parts.join('+');
  }
  function isEditingInPage() {
    // A field inside our own closed shadow root is invisible to
    // document.activeElement (it reports the host), so consult the tracked node.
    if (shadowEditingEl && shadowEditingEl.isConnected) {
      try { if (shadowEditingEl.matches(':focus')) return true; } catch (e) { /* ignore */ }
    }
    const ae = document.activeElement;
    if (!ae || ae === document.body) return false;
    if (ae.isContentEditable) return true;
    if (ae.localName === 'input' || ae.localName === 'textarea' || ae.localName === 'select') return true;
    // With a closed shadow root document.activeElement is the host element;
    // the real focused field is the first item of composedPath().
    return false;
  }
  function isEditingEvent(event) {
    if (isEditingInPage()) return true;
    let path = [];
    try { path = event && event.composedPath ? event.composedPath() : []; } catch (e) { path = []; }
    const node = (path && path[0]) || (event && event.target);
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    const tag = String(node.localName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** 按钮行的统一构建（面板底部、说明、会话管理都在用） */
  function buttonRow(html, marginTop) {
    const row = el('div', 'pa-buttons');
    if (marginTop) row.style.marginTop = marginTop;
    row.innerHTML = html;
    return row;
  }
  const styleCache = new WeakMap();
  /**
   * CSP 安全地注入样式：构造式样式表优先，失败回退 <style>。
   *
   * ⚠️ v20.0.0 修掉一个致命缺陷（真实引擎里实测复现）：旧版按「根」只记一条缓存
   * （`{ key, sheet }`），第二次以不同 key 注入同一根时执行
   * `list.filter(s => s !== prev.sheet)` —— 把**上一条别的 key 的样式表**从
   * adoptedStyleSheets 里剔了出去。宿主页面上 shell 根会先后注入两份：窗口 CSS（'shell'）
   * 与浮出按钮 CSS（'launcher'），于是浮出按钮一挂上，整份窗口样式表就被踢掉：
   * `.window` 退化成未加样式的块（position:static、宽 730px），标题栏里的 SVG 按默认
   * 尺寸撑成 730×730 —— 用户看到的「拖拽后不出现窗口、全是超大符号」就是这个。
   * 现在改成「一个根一张 key→样式 的映射表，只替换自己那个 key 的旧条目」，
   * 并在赋值后**校验是否真的落地**（某些环境里赋值会被静默忽略），没落地就走 <style>。
   */
  function adoptStyles(root, cssText, key) {
    let map = styleCache.get(root);
    if (!map) { map = Object.create(null); styleCache.set(root, map); }
    const prev = map[key];
    if (prev && prev.css === cssText) return;          // 同一份文本，一个 DOM 都不碰
    let sheet = null;
    try {
      sheet = new window.CSSStyleSheet();
      sheet.replaceSync(cssText);
    } catch (e) { sheet = null; }
    if (sheet) {
      try {
        let list = root.adoptedStyleSheets ? [...root.adoptedStyleSheets] : [];
        // 只摘掉「同一个 key 的上一条」，别的 key 的样式表一律留着
        if (prev && prev.sheet) list = list.filter(s => s !== prev.sheet);
        list.push(sheet);
        root.adoptedStyleSheets = list;
        if (root.adoptedStyleSheets && Array.prototype.indexOf.call(root.adoptedStyleSheets, sheet) >= 0) {
          // 旧的 <style> 回退节点（如果之前用过）清掉，避免同一份 CSS 生效两遍
          if (prev && prev.el && prev.el.parentNode) prev.el.parentNode.removeChild(prev.el);
          map[key] = { sheet, css: cssText };
          return;
        }
      } catch (e) { /* 回退到 <style> */ }
    }
    let node = prev && prev.el;
    if (!node || !node.isConnected) {
      node = document.createElement('style');
      node.setAttribute('data-ldp-style', key);
      (root === document ? document.head || document.documentElement : root).appendChild(node);
    }
    if (node.textContent !== cssText) node.textContent = cssText;
    map[key] = { el: node, css: cssText };
  }

  /* ==================================================================================
   *  §4 颜色与主题引擎
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  明暗判定走「多信号加权投票」：color-scheme 声明、html/body 的 dark/light 标记、
   *  真实背景色（透明回溯 + 面积加权）、正文文字色、系统偏好，谁证据多听谁的。
   *  配色生成锚定「页面实际底色」而不是固定档位 —— 深色页就是深色窗，且色相 / 饱和度 /
   *  明度都贴近页面。
   * ================================================================================== */
  const PAGE_COLOR_SELECTORS = [
    'main', 'article', '[role="main"]', '#app', '#root', '#content', '#main',
    '.container', '.wrapper', '.main', '.app', '.layout', '[class*="layout"]', '[class*="page-"]'
  ];
  // 自动取色只判断「页面 UI」的明暗；视频/音频/画布只是内容，不是 UI。
  // 先看页头、导航、侧栏等真正的界面区域，再回退到 body/html。
  const UI_COLOR_SELECTORS = [
    'header', 'nav', '[role="banner"]', '[role="navigation"]', 'aside',
    '[class*="header"]', '[class*="topbar"]', '[class*="toolbar"]', '[class*="sidebar"]'
  ];
  const KIND_DARK_RE = /(^|[-_\s])(dark|night|dim|darkmode|dark-mode|dark-theme|theme-dark|night-mode|nightmode)([-_\s]|$)/i;
  const KIND_LIGHT_RE = /(^|[-_\s])(light|day|daymode|day-mode|light-theme|theme-light)([-_\s]|$)/i;
  /* v19.2：这里原先还有一个 ACCENT_SELECTORS（强调色候选按钮选择器）。v18 删掉
     collectAccent() 之后它就没人引用了，JSHint 会报「已定义未使用」，一并删除。 */
  const NAMED_COLORS = {
    white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
    red: [255, 0, 0, 1], lime: [0, 255, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
    gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], gainsboro: [220, 220, 220, 1],
    whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1], ivory: [255, 255, 240, 1],
    aliceblue: [240, 248, 255, 1], navy: [0, 0, 128, 1], teal: [0, 128, 128, 1],
    purple: [128, 0, 128, 1], olive: [128, 128, 0, 1], orange: [255, 165, 0, 1],
    yellow: [255, 255, 0, 1], gold: [255, 215, 0, 1], dimgray: [105, 105, 105, 1],
    dimgrey: [105, 105, 105, 1], darkslategray: [47, 79, 79, 1], midnightblue: [25, 25, 112, 1]
  };

  function getLuminance(r, g, b) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
  /** 只认 rgb()/rgba()/#hex 的轻量解析（读计算样式用，不需要完整 CSS 颜色语法） */
  function parseColorStr(str) {
    if (!str) return null;
    str = String(str).trim();
    const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    if (str.startsWith('#')) {
      let hex = str.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }
    return null;
  }
  function parseColor(value) {
    if (value == null) return null;
    const s = String(value).trim().toLowerCase();
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, s)) {
      const n = NAMED_COLORS[s];
      return { r: n[0], g: n[1], b: n[2], a: n[3] };
    }
    if (s.charAt(0) === '#') {
      let hex = s.slice(1);
      if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(ch => ch + ch).join('');
      if (hex.length !== 6 && hex.length !== 8) return null;
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
      return { r, g, b, a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
    }
    const alphaOf = (arr) => {
      if (arr.length < 4) return 1;
      const raw = parseFloat(arr[3]);
      if (!Number.isFinite(raw)) return 1;
      return clamp(/[-+]?[\d.]+%$/.test(arr[3]) ? raw / 100 : raw, 0, 1);
    };
    let m = s.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const to255 = t => {
        const v = parseFloat(t);
        if (!Number.isFinite(v)) return NaN;
        return /%$/.test(t) ? Math.round(v * 255 / 100) : Math.round(v);
      };
      const r = to255(parts[0]), g = to255(parts[1]), b = to255(parts[2]);
      if (![r, g, b].every(v => Number.isFinite(v) && v >= 0)) return null;
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: alphaOf(parts) };
    }
    m = s.match(/^hsla?\(([^)]*)\)$/);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const rgb = hslToRgb(parseFloat(parts[0]) || 0, (parseFloat(parts[1]) || 0) / 100, (parseFloat(parts[2]) || 0) / 100);
      return { r: rgb.r, g: rgb.g, b: rgb.b, a: alphaOf(parts) };
    }
    return null;
  }
  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    };
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s, l };
  }
  const cssRgb = c => `rgb(${c.r},${c.g},${c.b})`;
  const makeCss = (h, s, l) => cssRgb(hslToRgb(h, s, l));

  /* ---- 采样 ------------------------------------------------------------------------ */
  let themeSampleCache = { at: 0, data: null };
  let themeSampleDirty = true;
  function invalidateThemeSample() { themeSampleDirty = true; }

  function readBackground(node, name) {
    if (!node) return null;
    try {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (!c) return null;
      return { color: c, lum: getLuminance(c.r, c.g, c.b), alpha: c.a === undefined ? 1 : c.a, name };
    } catch (e) { return null; }
  }
  function isMediaSurface(node) {
    if (!node || node === document.documentElement || node === document.body) return false;
    try {
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'video' || tag === 'audio' || tag === 'canvas' || tag === 'img' || tag === 'picture') return true;
      const media = node.querySelector && node.querySelector('video,audio,canvas');
      if (!media) return false;
      const nodeRect = node.getBoundingClientRect();
      const mediaRect = media.getBoundingClientRect();
      const area = Math.max(0, nodeRect.width * nodeRect.height);
      const mediaArea = Math.max(0, mediaRect.width * mediaRect.height);
      // A player stage whose visible area is mostly media is content, not UI.
      // Keep a page shell with a real header/nav even if it contains a video.
      return area > 0 && mediaArea / area > 0.55
        && !node.querySelector('header,nav,[role="banner"],[role="navigation"]');
    } catch (e) { return false; }
  }
  /** color-scheme 声明：现代站点表达「我支持暗色」的标准方式 */
  function schemeTokens() {
    let tokens = '';
    try {
      const cs = getComputedStyle(document.documentElement).colorScheme;
      if (cs) tokens += ' ' + String(cs).toLowerCase();
    } catch (e) { /* 忽略 */ }
    try {
      document.querySelectorAll('meta[name="color-scheme"]').forEach(meta => {
        tokens += ' ' + String(meta.getAttribute('content') || '').toLowerCase();
      });
    } catch (e) { /* 忽略 */ }
    return tokens;
  }
  function classHints(node) {
    if (!node) return null;
    try {
      const cls = String(node.getAttribute('class') || '');
      if (KIND_DARK_RE.test(cls)) return true;
      if (KIND_LIGHT_RE.test(cls)) return false;
      const hint = THEME_ATTRS.slice(2)
        .map(a => node.getAttribute(a)).filter(Boolean).join(' ');
      if (hint) {
        if (/dark|night|dim/i.test(hint)) return true;
        if (/light|day/i.test(hint)) return false;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  /* v18 删除了 collectAccent()：它会把页面 <a> 的默认蓝色 (#0000EE) 或 meta theme-color
     （站点主色，多半是蓝的）直接拿来当界面强调色，实测能让 --accent 变成 rgb(19,19,195)。
     界面强调色由 generatePalette() 直接给出（v20.1 起会跟着页面底色沾一点色调，
     但始终是 luminance 合适的中性偏灰），不再从页面采集。 */
  function collectThemeSignals() {
    const out = { dark: false, base: null, reasons: [], score: 0 };
    const want = ENUMS.themeSource.indexOf(settings.themeSource) >= 0 ? settings.themeSource : 'smart';
    const useScheme = want === 'smart' || want === 'scheme';
    const usePage = want === 'smart' || want === 'page';
    const useSystem = want === 'smart' || want === 'system';
    const sysDark = prefersDark();
    let score = 0, weight = 0;
    const vote = (isDark, w, reason) => {
      if (!(w > 0)) return;
      score += isDark ? w : -w;
      weight += w;
      if (reason) out.reasons.push(reason);
    };

    if (useScheme) {
      const tokens = schemeTokens();
      const hasDark = /\bdark\b/.test(tokens);
      const hasLight = /\blight\b/.test(tokens);
      if (hasDark && hasLight) vote(sysDark, 2.2, 'color-scheme: light dark → 跟随系统');
      else if (hasDark) vote(true, 3.4, 'color-scheme: dark');
      else if (hasLight) vote(false, 1.8, 'color-scheme: light');
    }

    if (usePage) {
      for (const node of [document.documentElement, document.body]) {
        const hint = classHints(node);
        if (hint === null) continue;
        vote(hint, hint ? 2.4 : 1.8, hint ? 'html/body 标记了暗色' : 'html/body 标记了亮色');
      }
      // 系统偏好只当平票时的微弱倾向，别把页面自己的明确声明顶掉
      vote(sysDark, 0.6, sysDark ? '系统偏好暗色' : '系统偏好亮色');
    } else if (useSystem) {
      vote(sysDark, 1, sysDark ? '系统偏好暗色' : '系统偏好亮色');
    }

    if (usePage) {
      const cands = [];
      const consider = (node, name, w, ui) => {
        if (!node || isMediaSurface(node)) return false;
        const info = readBackground(node, name);
        if (!info) return false;
        let big = true;
        try {
          const rect = node.getBoundingClientRect();
          const v = viewport();
          big = rect.width * rect.height > v.w * v.h * 0.35;
        } catch (e) { /* 忽略 */ }
        if (!big && w < 2) return false;
        // A visible UI header/nav is stronger evidence than a full-screen
        // media stage, even if it is physically shorter than 35% of viewport.
        cands.push({ info, w: big ? w : w * (ui ? 0.85 : 0.45), big, ui: !!ui });
        return true;
      };
      // UI chrome has priority over a full-screen video stage.  A dark player
      // on a light page must not make the extension choose dark.
      let uiExtra = 0;
      for (const sel of UI_COLOR_SELECTORS) {
        if (uiExtra >= 4) break;
        let node = null;
        try { node = document.querySelector(sel); } catch (e) { node = null; }
        if (!node || node === document.body || node === document.documentElement) continue;
        if (consider(node, 'UI ' + sel, 3.4, true)) uiExtra++;
      }
      consider(document.body, 'body', 2.6);
      consider(document.documentElement, 'html', 2.2);
      let extra = 0;
      for (const sel of PAGE_COLOR_SELECTORS) {
        if (extra >= 3) break;
        let node = null;
        try { node = document.querySelector(sel); } catch (e) { node = null; }
        if (!node || node === document.body || node === document.documentElement) continue;
        if (consider(node, sel, 1)) extra++;
      }
      for (const c of cands) {
        if (c.info.alpha < 0.9) continue;                        // 蒙层/卡片不能代表整页底色
        // 实际观测到的底色是所有信号里最直接的一条，权重压过声明类信号
        const w = c.w * (0.5 + Math.abs(c.info.lum - 0.5) * 2.2);
        vote(c.info.lum < 0.5, w, `${c.info.name} 底色 ${cssRgb(c.info.color)}`);
      }
      const solid = cands.find(c => c.ui && c.info.alpha >= 0.9)
        || cands.find(c => c.big && c.info.alpha >= 0.9)
        || cands.find(c => c.info.alpha >= 0.9);
      if (solid) out.base = solid.info.color;
      /* v18：这里原本还有一路「meta theme-color 兜底」。删掉了 ——
         它是站点主色（工具栏 / 状态栏的颜色），不是页面底色。多数站点的主色是蓝的，
         拿它当整页底色就是「界面不知道为什么整体偏蓝」的直接来源；而且它在
         document-start 阶段是唯一能拿到的东西，于是这份蓝样本一路被缓存沿用下去。
         现在取不到真正的底色就留 null，调色板会退回中性灰 —— 这才是想要的结果。 */
      // 文字色：浅字配暗底、深字配亮底（弱信号，但能兜住「底色全是蒙层」）
      if (document.body && !out.base) {
        try {
          const tc = parseColor(getComputedStyle(document.body).color);
          if (tc) {
            const tLum = getLuminance(tc.r, tc.g, tc.b);
            if (tLum < 0.4) vote(false, 1.1, '正文文字偏深');
            else if (tLum > 0.62) vote(true, 1.1, '正文文字偏浅');
          }
        } catch (e) { /* 忽略 */ }
      }
    }

    out.score = weight ? Math.round(score / weight * 100) / 100 : 0;
    out.dark = weight ? (score > 0 ? true : score < 0 ? false : sysDark) : sysDark;
    return out;
  }
  function sampleTheme(force) {
    const now = Date.now();
    if (!force && !themeSampleDirty && themeSampleCache.data && now - themeSampleCache.at < THEME_SAMPLE_TTL) {
      return themeSampleCache.data;
    }
    let data;
    try { data = collectThemeSignals(); }
    catch (e) { data = { dark: prefersDark(), base: null, reasons: ['采集失败，回退系统偏好'], score: 0 }; }
    themeSampleCache = { at: now, data };
    themeSampleDirty = false;
    return data;
  }
  function getEffectiveDark() {
    if (settings.theme === 'light') return false;
    if (settings.theme === 'dark') return true;
    return sampleTheme().dark;
  }
  /** 诊断行：把色调跟随的实际取值说清楚，方便用户判断「取色对不对」 */
  function tintReport(base) {
    return '不跟随页面色相（自动取色只决定日间/夜间）';
  }
  function themeReport() {
    const st = sampleTheme(true);
    return {
      dark: st.dark,
      label: st.dark ? '暗色' : '亮色',
      reasons: st.reasons.slice(0, 4).join('；') || '没有明确信号，按系统偏好处理',
      base: st.base ? cssRgb(st.base) : '—',
      tint: tintReport(st.base),
      mode: settings.theme === 'auto' ? '自动取色' : (settings.theme === 'dark' ? '强制夜间' : '强制日间')
    };
  }
  /**
   * 调色板 —— 明度与色调都来自页面，只是色调被严格封顶。
   *
   * v18–v20.0 是「恒定中性灰」：hue / sat 恒为 0，只有明度跟随页面。当时的理由是
   * v17 的采集源错了（去取 <a> 的默认蓝 #0000EE、meta theme-color 的站点主色），
   * 于是整窗被染成纯蓝，用户原话「这个蓝色是我肯定不想要的」。
   *
   * v20.1 重新引入色调跟随，但换了个前提 —— 采集源改成「网页真实底色」：
   *   · 底色 = collectThemeSignals() 里面积加权后选出的那一个（body / html / #app…），
   *     它本来就是页面上面积最大、最实在的那块颜色，不存在「主色冒充底色」的问题；
   *   · 饱和度封顶 TINT_MAX_S（12%）—— 页面再艳，窗口也只沾一点点，同色系但不刺眼；
   *   · 底色本身接近灰（饱和度 < 4%）时无色相可取，自动落回中性灰；
   *   · 文字类令牌只取 35% 的封顶饱和度，保证可读性。
   * 设置里 pageTint 一关，就完全回到 v18 的绝对中性灰。
   *
   * 明度映射（v20.1 同时放宽）：旧区间暗色 0.05–0.16、亮色 0.84–0.982 太窄，
   * 中间调的页面（#4d4d4d、#cccccc 之类）会被硬拽到区间边缘，窗口与页面明显错位。
   */
  const TINT_MAX_S = 0.12;
  function generatePalette(baseColor, isDark) {
    // Auto color only decides light/dark.  The light palette is deliberately
    // blue-grey rather than neutral grey: brighter cards, crisp soft borders.
    const hue = isDark ? 220 : 218;
    const sat = isDark ? 0.08 : 0.16;
    const g = l => makeCss(hue, sat, l);
    const gt = l => makeCss(hue, sat * 0.35, l);
    if (isDark) {
      return {
        bg: g(0.13),
        surface: g(0.175),
        head: g(0.16),
        hover: g(0.22),
        selected: g(0.25),
        border: g(0.31),
        text: gt(0.93),
        muted: gt(0.64),
        accent: gt(0.84),
        overlay: 'rgba(2,2,4,.58)',
        scrim: 'rgba(2,2,4,.44)',
        shadow: '0 12px 34px -12px rgba(0,0,0,.55),0 34px 80px -32px rgba(0,0,0,.66),0 2px 10px -4px rgba(0,0,0,.50)',
        toast: gt(0.93),
        'toast-text': gt(0.10)
      };
    }
    return {
      bg: g(0.975),
      surface: g(0.995),
      head: g(0.99),
      hover: g(0.94),
      selected: g(0.91),
      border: g(0.855),
      text: gt(0.19),
      muted: gt(0.47),
      accent: gt(0.47),
      overlay: 'rgba(15,23,42,.18)',
      scrim: 'rgba(15,23,42,.16)',
      shadow: '0 18px 50px -20px rgba(31,56,98,.24),0 42px 90px -38px rgba(31,56,98,.22),0 2px 8px -3px rgba(31,56,98,.10)',
      toast: gt(0.20),
      'toast-text': gt(0.97)
    };
  }
  const PALETTE_VARS = ['bg', 'surface', 'head', 'text', 'muted', 'border', 'hover', 'accent', 'selected', 'overlay', 'scrim', 'shadow', 'toast', 'toast-text'];

  /* ==================================================================================
   *  §5 材质 —— 全脚本唯一的材质配方
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  t ∈ [0,1]：0 = 干净的实心面（macOS「降低透明度」观感），1 = 最厚磨砂。
   *  所有量随 t 连续插值，没有任何突变点。
   *
   *  v19 相比 v18 的改动（按用户要求撤掉液态玻璃，回归极简）：
   *    · 边缘透镜（box-shadow 负扩散柔光）、四向棱线、环形描边、指针跟随高光、
   *      真实边缘折射全部删除 —— 返回值只剩 fill / filter / off 三样；
   *    · 描边与投影不再由本配方给出：边框统一用调色板的 --border（取色引擎按明暗与
   *      页面色调给出），投影统一用调色板的 --shadow，一处定义全 UI 共用；
   *    · 轻磨砂原样保留：blur + 极轻 brightness，无 saturate（v18 已去掉，
   *      它是乘性滤镜，会放大被预览页面自己的颜色，任何闸门都拦不住）。
   *
   *  返回的所有值都是 CSS 片段，由 renderTheme() 一次性写到宿主上，窗口外框与
   *  所有内部层引用同一组令牌 —— 滑块一动整窗一起变。
   * ================================================================================== */
  function glassRecipe(t, isDark, alpha) {
    const k = clamp(t, 0, 1);
    const solid = 1, glassy = isDark ? 0.42 : 0.26;
    const fillA = clamp((solid + (glassy - solid) * k) * alpha, 0, 1);
    const blur = (k * GLASS_MAX).toFixed(1);
    const bri = (1 + (isDark ? -0.02 : 0.03) * k).toFixed(3);
    const filter = k <= 0 ? 'none' : `blur(${blur}px) brightness(${bri})`;
    return {
      fill: pct(fillA),
      filter,
      off: k <= 0
    };
  }

  /* ==================================================================================
   *  §6 样式与模板
   * ================================================================================== */
  const ICONS = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    pin: '<path d="M8 3h8l-1.5 6 3.5 4v2H6v-2l3.5-4L8 3ZM12 15v7"/>',
    external: '<path d="M14 3h7v7M21 3l-11 11M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    link: '<path d="M10 13l4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 1) scale(.9)"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    reset: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    grip: '<path d="M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01"/>',
    pip: '<path d="M22 14h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2z M15 11V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7"/>',
    read: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
    history: '<path d="M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10h18M10 10v11"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    sync: '<path d="M21 2v6h-6M3 22v-6h6"/><path d="M21 8A9 9 0 0 0 6 5.7L3 8M3 16a9 9 0 0 0 15 2.3L21 16"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/>',
    // v20.2：悬停小窗「停止播放 / 恢复」按钮用（action 图标 —— 图标即将要执行的动作）
    mute: '<path d="M11 5 6.6 9H3v6h3.6L11 19V5Z"/><path d="M15.6 9.6a3.5 3.5 0 0 1 0 4.8"/><path d="m4 4 16 16"/>',
    play: '<path d="M8 5.4v13.2L19 12 8 5.4Z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    volume: '<path d="M11 5 6.6 9H3v6h3.6L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/>',
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="M19 16v4M17 18h4"/>'
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }
  const button = (action, name, title) =>
    `<button type="button" class="btn" data-action="${action}" title="${title}" aria-label="${title}">${icon(name)}</button>`;

  /* ---- 浮出按钮（全局与子框架共用，性能敏感） ---------------------------------------- */
  const LAUNCHER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M6.6 7h.01M9.6 7h.01"/></svg>';
  const LAUNCHER_AI_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z"/><path d="M5 16.5 5.8 18.2 7.5 19l-1.7.8L5 21.5l-.8-1.7L2.5 19l1.7-.8L5 16.5Z"/><path d="M19 14.5l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5Z"/></svg>';
  const LAUNCHER_CSS = `[hidden]{display:none!important}
.ldp-launcher{--glass-base:var(--head,#dfe2e7);--glass-fill:color-mix(in srgb,var(--glass-base) var(--glass-a,100%),transparent);position:absolute;z-index:6;width:${LAUNCHER_SIZE}px;height:${LAUNCHER_SIZE}px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--border,#cbcbcb);border-radius:var(--r-ctl,9px);background:var(--glass-fill,#dfe2e7);backdrop-filter:var(--glass-filter,none);-webkit-backdrop-filter:var(--glass-filter,none);color:var(--accent,#4a4a4a);box-shadow:0 1px 5px -1px rgba(10,10,14,.22);pointer-events:auto;cursor:pointer;animation:ldp-in .16s cubic-bezier(.42,0,.58,1)}
.ldp-launcher:hover{background:var(--hover,#d1d8e3);border-color:color-mix(in srgb,var(--accent,#396bb5) 55%,transparent)}
.ldp-launcher-ai{color:var(--accent,#396bb5);border-color:color-mix(in srgb,var(--accent,#396bb5) 48%,var(--border,#cbcbcb));background:color-mix(in srgb,var(--accent,#396bb5) 9%,var(--glass-fill,#dfe2e7))}
.ldp-launcher-ai:hover{background:color-mix(in srgb,var(--accent,#396bb5) 18%,var(--hover,#d1d8e3))}
.ldp-launcher:active{transform:scale(.95)}
.ldp-launcher:focus-visible{outline:2px solid var(--accent,#396bb5);outline-offset:1px}
.ldp-launcher svg{width:15px;height:15px;display:block;pointer-events:none}
/* 子框架里没有取色引擎，深色时只覆盖底色与强调色；磨砂与圆角仍由 applyFrameChrome 统一写入 */
:host([data-ldp-frame][data-theme="dark"]) .ldp-launcher{--glass-base:#20222d;--hover:#2c2e3a;--accent:#c9c9c9}
:host([data-theme="dark"]) .ldp-launcher{--glass-base:#20242c;--hover:#2c3442;--accent:#a9c4ff;--border:#3a4658}
:host([data-theme="dark"]) .ldp-launcher-ai{color:#b9ceff;border-color:#526a9b;background:color-mix(in srgb,#121923 86%,#2f6fed 14%)}
:host([data-theme="dark"]) .ldp-launcher-ai:hover{background:#26344a}
@keyframes ldp-in{from{opacity:0;transform:scale(.72)}}`;

  /* ---- 主样式 ----------------------------------------------------------------------
     v19 极简材质：一组令牌（--glass-a / --glass-fill / --glass-filter）由 JS 的
     renderTheme() 写入，描边统一走调色板的 --border、投影统一走 --shadow ——
     液态玻璃那套 --glass-in / --glass-hair / --glass-ring / --hl / --edge /
     --sx / --sy / --sheen-* 已全部删除。
     「界面玻璃磨砂」一动，窗口外框与所有内部层一起变（填充不透明度 + 磨砂强度）。
     实体形状：窗口外壳保持透明（否则子元素的 backdrop-filter 采样不到身后的网页）；
     正文由 iframe 自己铺满；窗口不透明度走 iframe 遮罩（见 iframe 规则）。            */
  const CSS = `:host{
--bg:#f4f7fb;--surface:#ffffff;--head:#ffffff;--text:#1b2636;--muted:#697589;--border:#d9e2ee;--hover:#eef4fc;--accent:#2f6fed;--selected:#e7efff;
--overlay:rgba(15,23,42,.18);--scrim:rgba(15,23,42,.16);
--shadow:0 18px 50px -20px rgba(31,56,98,.24),0 42px 90px -38px rgba(31,56,98,.22),0 2px 8px -3px rgba(31,56,98,.10);
--toast:#2e2e34;--toast-text:#f0f2f5;
--glass-base:var(--head);--glass-a:100%;--glass-fill:color-mix(in srgb,var(--glass-base) var(--glass-a),transparent);
--glass-filter:none;
--blur:8px;--win-opacity:1;--win-mask:none;
--r-win:26px;--r-in:25px;--r-pop:16px;--r-ctl:11px;--r-chip:8px;
--dur:140ms;--dur2:240ms;--ease:cubic-bezier(.42,0,.58,1);
color-scheme:light}
:host([data-theme="dark"]){--bg:#171717;--surface:#222222;--head:#1d1d1d;--text:#e6e6e6;--muted:#9b9b9b;--border:#373737;--hover:#2e2e2e;--accent:#c9c9c9;--selected:#353535;
--overlay:rgba(2,2,4,.58);--scrim:rgba(2,2,4,.44);
--shadow:0 12px 34px -12px rgba(0,0,0,.52),0 36px 84px -32px rgba(0,0,0,.64),0 2px 10px -4px rgba(0,0,0,.46);
--toast:#e3e4eb;--toast-text:#171717;
color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}
/* 遮罩：只做「压暗 + 柔化被预览页面的背景」。v17 去掉了这里的 saturate(120%) ——
   它会和被它覆盖的玻璃层提纯叠乘，把页面底色里看不见的蓝放大成看得见的蓝。 */
.backdrop{position:absolute;inset:0;pointer-events:auto;background:var(--overlay);backdrop-filter:blur(var(--blur,8px));-webkit-backdrop-filter:blur(var(--blur,8px))}
/* 窗口外壳：透明（给子元素的 backdrop-filter 让路）+ 与内部共用同一套材质令牌。
   v19 极简风：1px --border 描边 + 一档 --shadow 投影，无棱线无环形描边。 */
.window{position:absolute;display:flex;flex-direction:column;pointer-events:auto;color:var(--text);background:transparent;border:1px solid var(--border);border-radius:var(--r-win);box-shadow:var(--shadow);font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;min-width:0;isolation:isolate;transform-origin:top left;transition:border-color var(--dur2) var(--ease),box-shadow var(--dur2) var(--ease)}
.window.active{border-color:color-mix(in srgb,var(--accent) 42%,var(--border));box-shadow:var(--shadow),0 0 32px -6px color-mix(in srgb,var(--accent) 26%,transparent)}
.window.pinned .header{box-shadow:inset 0 2px var(--accent)}
.window.pip{z-index:2147483646!important}
.window.pip .content{pointer-events:none!important}
.window.pip .header .btn{display:none!important}
.window.pip-bar .header .btn{display:none!important}
.window.pip .grip,.window.pip .toolbar,.window.pip .panel,.window.pip .resize{display:none!important}
.window.bare .content{background:var(--bg)}
.window.pip-bar{border-radius:var(--r-ctl)}
.window.pip-bar .header{height:${PIP_BAR_H}px;flex:0 0 ${PIP_BAR_H}px;border-bottom:none;border-radius:var(--r-ctl);padding:0 10px;cursor:pointer}
.window.pip-bar .content,.window.pip-bar .toast{display:none!important}
.window.pip-bar .btn,.window.pip-bar .grip{display:none}
.window.pip-bar .title{font-size:12px}
.header{height:44px;flex:0 0 44px;display:flex;align-items:center;gap:3px;padding:0 7px;border-radius:var(--r-in) var(--r-in) 0 0;border-bottom:1px solid color-mix(in srgb,var(--border) 34%,transparent);cursor:grab;user-select:none;touch-action:none}
.grip{width:19px;height:22px;color:var(--muted);flex-shrink:0}
.grip svg{width:100%;height:100%;stroke-width:3}
.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;padding:0 5px;display:flex;align-items:center;gap:6px}
.title img{width:16px;height:16px;border-radius:3px;flex-shrink:0}
.title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{border:0;background:transparent;color:var(--muted);width:31px;height:31px;flex-shrink:0;padding:6px;border-radius:var(--r-ctl);display:inline-flex;align-items:center;justify-content:center;transition:background var(--dur) var(--ease),color var(--dur) var(--ease),transform var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.btn svg{width:19px;height:19px;pointer-events:none}
.btn:hover{background:color-mix(in srgb,var(--hover) 82%,transparent);color:var(--accent)}
.btn:active{transform:scale(.93)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.btn.selected{background:var(--selected);color:var(--accent)}
.btn[data-action="pin"] svg{transform:rotate(40deg);transition:transform .23s var(--ease)}
.btn[data-action="pin"].selected svg{transform:rotate(0deg)}
.btn[data-action="close"]:hover{background:#e44b6424;color:#e76479}
.content{position:relative;flex:1;min-height:0;overflow:hidden;border-radius:0 0 var(--r-in) var(--r-in);background:transparent;z-index:1}
.progress-bar{position:absolute;top:0;left:0;height:2px;background:var(--accent);opacity:.85;width:0;transition:width .3s;z-index:10}
/* 「窗口不透明度」用 iframe 遮罩实现：opacity 会影响不了硬件视频叠加平面，遮罩可以。
   100% 时 JS 会把 --win-mask 设成 none，此时不产生任何遮罩合成开销。 */
iframe{display:block;border:0;transform-origin:0 0;background:var(--bg);color-scheme:normal;width:100%;height:100%;-webkit-mask-image:var(--win-mask,none);mask-image:var(--win-mask,none);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-size:100% 100%;mask-size:100% 100%}
@supports not ((-webkit-mask-image:linear-gradient(#000,#000)) or (mask-image:linear-gradient(#000,#000))){iframe{opacity:var(--win-opacity,1);transition:opacity var(--dur2) var(--ease)}}
.shield{position:absolute;inset:0;z-index:4}
.toolbar{position:absolute;top:53px;left:-47px;width:39px;padding:3px;display:flex;flex-direction:column;gap:3px;max-height:calc(100% - 60px);overflow:auto;scrollbar-width:none;border:1px solid var(--border);border-radius:var(--r-pop);box-shadow:var(--shadow);z-index:25}
.toolbar::-webkit-scrollbar{width:0;height:0}
.window.tb-right .toolbar{left:auto;right:-47px}
.window.tb-inside .toolbar{left:7px;opacity:.5;transition:opacity var(--dur2) var(--ease)}
.window.tb-inside .toolbar:hover{opacity:1}
.window.tb-inside .content{padding-left:46px}
.divider{flex-shrink:0;height:1px;margin:2px 3px;background:color-mix(in srgb,var(--border) 60%,transparent)}
.zoom-label{text-align:center;color:var(--muted);font-size:10px}
.loader{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:var(--bg);pointer-events:none}
.loader .globe-icon{width:48px;height:48px;color:var(--muted);animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.5;transform:scale(.95)}50%{opacity:1;transform:scale(1)}}
.skeleton{width:80%;height:12px;background:linear-gradient(90deg,var(--surface) 25%,var(--hover) 50%,var(--surface) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:var(--r-chip);margin:8px 0}
.skeleton:first-child{width:40%;height:20px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.hint{position:absolute;left:10px;right:10px;bottom:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-pop);box-shadow:var(--shadow);color:var(--muted);font-size:12px;z-index:10}
.hint-close{float:right;border:0;background:none;color:inherit;font-size:18px;cursor:pointer}
/* v20.2.2：提示条上的动作按钮（「在新标签页打开」）。用 float:right 与 .hint-close 并排 ——
   它排在 .hint-close 之后，所以浮到关闭按钮的左边，不会把它挤走。 */
.hint-act{float:right;margin-left:8px;max-width:62%;padding:5px 10px;border:1px solid var(--border);border-radius:var(--r-ctl);background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--text);font-size:12px;line-height:1.3;cursor:pointer}
.panel{position:absolute;top:51px;right:8px;z-index:30;width:400px;max-width:calc(100% - 16px);max-height:calc(100% - 61px);overflow:auto;overscroll-behavior:contain;padding:0;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--r-pop);box-shadow:var(--shadow);cursor:auto;user-select:text}
.panel-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:11px 12px 11px 14px;flex:0 0 auto;border-bottom:1px solid color-mix(in srgb,var(--border) 34%,transparent);border-radius:calc(var(--r-pop) - 1px) calc(var(--r-pop) - 1px) 0 0}
.panel-head h3{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.panel-close{width:27px;height:27px;padding:5px}
.panel-close svg{width:15px;height:15px}
.panel-body{padding:14px}
.panel h3{margin:0 0 12px;font-size:15px}
.panel h4{color:var(--muted);margin:17px 0 8px;font-size:12px}
.panel-actions{margin-top:18px;padding-top:14px;border-top:1px solid color-mix(in srgb,var(--border) 40%,transparent);display:flex;flex-direction:column;gap:13px}
.pa-group{display:flex;flex-direction:column;gap:6px}
.pa-group>h4{margin:0;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em}
.pa-buttons{display:grid;grid-template-columns:repeat(auto-fill,minmax(94px,1fr));gap:6px}
.pa-buttons .text-button{width:100%;padding:8px 6px;text-align:center;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0}
.row>span{flex:1;min-width:0}
.row select{width:150px;padding:6px 7px;color:var(--text);background:color-mix(in srgb,var(--surface) 72%,transparent);border:1px solid var(--border);border-radius:var(--r-ctl)}
.row input[type="checkbox"]{width:16px;height:16px;accent-color:var(--accent)}
.number-control{display:flex;align-items:stretch;width:150px;height:34px;background:color-mix(in srgb,var(--surface) 72%,transparent);border:1px solid var(--border);border-radius:var(--r-ctl)}
.number-control input[type="number"]{width:0;flex:1;padding:5px 8px;border:0;color:var(--text);background:transparent;outline:none;appearance:textfield;-moz-appearance:textfield}
.number-control input::-webkit-inner-spin-button,.number-control input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.number-arrows{width:27px;display:flex;flex-direction:column;border-left:1px solid var(--border)}
.number-arrows button{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;padding:0;border:0;background:transparent;color:var(--muted);font-size:9px;line-height:1;user-select:none}
.number-arrows button:hover{color:var(--accent);background:var(--hover)}
.text-button{border:1px solid var(--border);background:color-mix(in srgb,var(--surface) 72%,transparent);color:var(--accent);padding:7px 10px;border-radius:var(--r-ctl);transition:background var(--dur) var(--ease)}
.text-button:hover{background:var(--hover)}
.note{font-size:12px;color:var(--muted);line-height:1.7}
.toast{position:absolute;left:50%;bottom:15px;z-index:40;transform:translateX(-50%);width:max-content;max-width:calc(100% - 24px);padding:9px 12px;border-radius:var(--r-pop);background:color-mix(in srgb,var(--toast) 88%,transparent);box-shadow:0 16px 40px -16px rgba(0,0,0,.5);color:var(--toast-text);text-align:center;pointer-events:none}
/* 页面级提示条（一个预览窗口都没开时，快捷键 / 拖放反馈的落点）。
   v20 重做为低干扰胶囊：12px 字号、999px 圆角、半透明 --toast 底 + 细描边 +
   收敛投影，淡入淡出 0.3s 无位移弹跳 —— 看得见但不抢戏。颜色 / 圆角 / 磨砂
   全部走调色板令牌，白夜间与外观设置自动跟随（v19.2 起挂在宿主影子根里）。 */
.standalone-toast{position:absolute;left:50%;bottom:22px;z-index:60;width:max-content;max-width:min(70vw,480px);padding:5px 14px;border:1px solid color-mix(in srgb,var(--border) 55%,transparent);border-radius:999px;background-color:color-mix(in srgb,var(--toast) 78%,transparent);backdrop-filter:var(--glass-filter);-webkit-backdrop-filter:var(--glass-filter);box-shadow:0 6px 20px -10px rgba(0,0,0,.38);color:color-mix(in srgb,var(--toast-text) 90%,transparent);text-align:center;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:.02em;pointer-events:none;opacity:0;transform:translateX(-50%);transition:opacity .3s var(--ease)}
.standalone-toast.show{opacity:1}
.standalone-toast[hidden]{display:none!important}
/* 悬停迷你预览小窗：鼠标在链接上停够阈值后出现，比画中画略小。
   材质与主窗口同一套令牌（--glass-fill / --glass-filter / --border / --shadow / --r-pop），
   白夜间与外观设置自动跟随。 */
.hover-peek{position:absolute;width:${PEEK_W}px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border:1px solid var(--border);border-radius:var(--r-pop);box-shadow:var(--shadow);background:transparent;opacity:0;transform:translateY(6px);transition:opacity .18s var(--ease),transform .18s var(--ease)}
.hover-peek.show{opacity:1;transform:translateY(0)}
.hover-peek[hidden]{display:none!important}
.hover-peek .peek-head{display:flex;align-items:center;gap:6px;height:${PEEK_HEAD_H}px;flex:0 0 ${PEEK_HEAD_H}px;padding:0 3px 0 9px;background-color:var(--glass-fill);backdrop-filter:var(--glass-filter);-webkit-backdrop-filter:var(--glass-filter);color:var(--muted);font:11px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;user-select:none;cursor:pointer}
.hover-peek .peek-head img{width:14px;height:14px;border-radius:3px;flex-shrink:0}
.hover-peek .peek-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hover-peek .peek-btn{border:0;background:transparent;color:var(--muted);width:22px;height:22px;flex-shrink:0;padding:3px;border-radius:var(--r-ctl);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background var(--dur) var(--ease),color var(--dur) var(--ease)}
.hover-peek .peek-btn:hover{background:color-mix(in srgb,var(--hover) 82%,transparent);color:var(--accent)}
/* v20.2：停在「已停止播放」状态时按钮保持高亮，一眼能看出小窗是被按停的 */
.hover-peek .peek-btn.selected{background:color-mix(in srgb,var(--hover) 82%,transparent);color:var(--accent)}
.hover-peek .peek-btn svg{width:14px;height:14px;pointer-events:none}
/* 略缩图舞台：iframe 以「窗口内容区的逻辑尺寸」（默认 1000×668）渲染，
   再由 .peek-stage 的 transform: scale() 整体缩到小窗里 —— 得到的是完整一屏窗口的
   略缩，而不是页面左上角的一角裁切。尺寸由 JS 按窗口宽高比算好后内联写入。 */
.hover-peek .peek-body{position:relative;overflow:hidden;background:var(--bg);flex:0 0 auto}
.hover-peek .peek-stage{position:absolute;top:0;left:0;transform-origin:top left}
.hover-peek .peek-stage iframe{display:block;border:0;background:var(--bg);color-scheme:normal}
/* v20.2 小窗占位层：① 点「停止播放」后 iframe 被卸成 about:blank，这里补上说明，
   不让小窗塌成一个空白块；② 静音快照档在抓取期间 / 抓取失败时也走这里。
   必须排在 .peek-shield 之前 —— 挡板要压在占位层上面，点这里照样打开完整预览
   （文案里也就敢写「点击小窗打开完整预览」）。 */
.hover-peek .peek-note{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:12px;text-align:center;background:var(--bg);color:var(--muted);font:11px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}
.hover-peek .peek-note[hidden]{display:none!important}
.hover-peek .peek-note svg{width:22px;height:22px;flex:0 0 auto;opacity:.65}
.hover-peek .peek-note-text{white-space:pre-line;max-width:100%}
.hover-peek .peek-btn[hidden]{display:none!important}
/* 透明挡板：小窗是「略缩图」不是可操作界面 —— 点击一律走「打开完整预览」。
   同时也拦住 iframe 内部吞掉滚动/点击，避免小窗里误触页面。 */
.hover-peek .peek-shield{position:absolute;inset:0;cursor:pointer;background:transparent}
.window.image-mode .content{background:transparent}
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
.resize{position:absolute;z-index:20;touch-action:none}
.n,.s{left:15px;right:15px;height:10px;cursor:ns-resize}.n{top:-5px}.s{bottom:-5px}
.e,.w{top:15px;bottom:15px;width:10px;cursor:ew-resize}.e{right:-5px}.w{left:-5px}
.ne,.nw,.se,.sw{width:18px;height:18px}
.ne{right:-5px;top:-5px;cursor:nesw-resize}.nw{left:-5px;top:-5px;cursor:nwse-resize}
.se{right:-5px;bottom:-5px;cursor:nwse-resize}.sw{left:-5px;bottom:-5px;cursor:nesw-resize}
.interacting{user-select:none}
.snap-indicator{position:absolute;background:color-mix(in srgb,var(--accent) 16%,transparent);border:2px dashed color-mix(in srgb,var(--accent) 78%,transparent);border-radius:var(--r-win);pointer-events:none;z-index:5;display:none}
.history-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r-chip);cursor:pointer;font-size:12px;transition:background var(--dur) var(--ease)}
.history-item:hover{background:var(--hover)}
.history-item span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.findbar{display:flex;align-items:center;gap:5px;padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--border) 34%,transparent);border-radius:var(--r-in) var(--r-in) 0 0}
.findbar input[type="text"]{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--border);border-radius:var(--r-chip);background:color-mix(in srgb,var(--surface) 72%,transparent);color:var(--text);outline:none;transition:border-color var(--dur) var(--ease)}
.findbar input[type="text"]:focus{border-color:color-mix(in srgb,var(--accent) 68%,transparent)}
.findbar .fb-btn{width:26px;height:26px;padding:3px;border:0;border-radius:var(--r-chip);background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center}
.findbar .fb-btn:hover{background:var(--hover);color:var(--accent)}
.findbar .fb-btn svg{width:16px;height:16px;pointer-events:none}
.findbar .fb-label{color:var(--muted);font-size:11px;min-width:44px;text-align:center}
.findbar .fb-opt{display:flex;align-items:center;gap:2px;color:var(--muted);font-size:11px;white-space:nowrap;cursor:pointer;user-select:none}
.findbar .fb-opt input{width:12px;height:12px;margin:0;accent-color:var(--accent)}
.findbar .fb-hint{color:#e76479;font-size:11px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drop-overlay{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:var(--scrim);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);animation:ldp-fade .14s var(--ease);pointer-events:none}
.drop-ring{position:absolute;inset:12px;border:1.5px dashed color-mix(in srgb,var(--accent) 42%,transparent);border-radius:var(--r-win);pointer-events:none}
.drop-card{position:relative;display:flex;align-items:center;gap:9px;max-width:min(78vw,420px);padding:12px 18px;border:1px solid var(--border);border-radius:var(--r-pop);box-shadow:var(--shadow),0 0 34px -10px color-mix(in srgb,var(--accent) 30%,transparent);color:var(--text);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.drop-ico{width:18px;height:18px;flex:0 0 auto;color:var(--accent)}
.drop-ico svg{width:100%;height:100%;display:block}
.drop-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes ldp-fade{from{opacity:0}}
/* v19 极简材质：填充（--glass-fill）+ 磨砂（--glass-filter）一组令牌所有层共用，
   所以「界面玻璃磨砂」一动，整窗一起变。描边与投影走调色板（--border / --shadow）。
   注意：.window 本身绝不能加 backdrop-filter —— 那会让它成为 backdrop root，
   子元素（标题栏 / 工具条）就只剩窗口自己的背景可采样，磨砂直接失效；
   窗口外壳因此保持透明，只靠 1px 描边与投影成形。 */
.toolbar,.panel,.hint,.drop-card,.header,.findbar,.panel-head,.ldp-launcher{background-color:var(--glass-fill);backdrop-filter:var(--glass-filter);-webkit-backdrop-filter:var(--glass-filter)}
.toast{backdrop-filter:var(--glass-filter);-webkit-backdrop-filter:var(--glass-filter)}
/* ============================================================================
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
.window.pip-bar .domain{display:none!important}
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
.settings-ai-note{font-size:10px;line-height:1.45;color:var(--muted)}
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
.window.summary-window .panel-head{cursor:default;user-select:none;touch-action:none}
.window.summary-window[data-summary-dock="free"] .panel-head{cursor:grab}
.window.summary-window[data-summary-dock="free"] .panel-head:active{cursor:grabbing}
.window.settings-standalone{left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0!important;border:0!important;box-shadow:none!important;background:var(--bg)!important}
.window.settings-standalone .header,.window.settings-standalone .toolbar,.window.settings-standalone .content,.window.settings-standalone .resize{display:none!important}
.window.settings-standalone .panel{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;overflow:auto!important}
.window.settings-standalone .panel-head{position:sticky!important;top:0!important;z-index:2!important}
.window.settings-standalone .panel-body{max-width:860px;margin:0 auto;padding:8px 22px 32px!important;width:100%;box-sizing:border-box}
.video-panel .panel-body{display:block!important;overflow:auto!important;min-height:0}
.text-ai-panel .panel-body{display:flex!important;flex-direction:column!important;overflow:auto!important;min-height:0!important;gap:0}
.text-ai-answer{min-height:190px;max-height:none;padding:12px 14px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--bg) 55%,transparent);font-size:13.5px;line-height:1.72;white-space:normal;overflow:visible;overscroll-behavior:contain;scrollbar-width:thin}
.text-ai-panel .note{word-break:break-all;flex:0 0 auto}.text-ai-panel .summary-actions{flex:0 0 auto;margin:0!important}
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
/* v1.9.43 summary studio polish: one calm surface, a clear accent, and an
   action bar that remains reachable while the answer scrolls. */
.window.summary-window .panel{background:linear-gradient(155deg,color-mix(in srgb,var(--surface) 97%,#fff 3%),var(--surface))!important;border:1px solid color-mix(in srgb,var(--border) 72%,transparent)!important;box-shadow:0 28px 80px -34px rgba(18,28,48,.55),inset 0 1px 0 rgba(255,255,255,.28)!important;overflow:hidden!important}
.window.summary-window .panel::before{content:"";position:absolute;z-index:1;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 42%,#8b5cf6),transparent 82%);opacity:.9;pointer-events:none}
.window.summary-window .panel-head{position:relative;z-index:2;padding:20px 22px 15px!important;border-bottom:1px solid color-mix(in srgb,var(--border) 48%,transparent)!important;background:linear-gradient(120deg,color-mix(in srgb,var(--accent) 7%,transparent),transparent 58%)!important}
.window.summary-window .panel-head h3{display:flex;align-items:center;gap:10px;font-size:15.5px!important;letter-spacing:-.02em;color:var(--text)}
.window.summary-window .panel-head h3::before{content:"✦";display:inline-grid;place-items:center;flex:0 0 28px;width:28px;height:28px;border-radius:10px;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#8b5cf6));color:#fff;font-size:14px;font-weight:700;box-shadow:0 6px 16px -7px color-mix(in srgb,var(--accent) 75%,transparent),inset 0 1px 0 rgba(255,255,255,.35)}
.window.summary-window .panel-close{width:30px!important;height:30px!important;border-radius:10px!important;color:var(--muted)!important;background:color-mix(in srgb,var(--surface) 55%,transparent)!important}
.window.summary-window .panel-close:hover{color:var(--text)!important;background:var(--hover)!important}
.window.summary-window .panel-body{display:flex!important;flex:1 1 0!important;flex-direction:column!important;gap:0;height:0!important;padding:0!important;min-height:0;overflow:hidden!important}
.window.summary-window .panel::-webkit-scrollbar,.window.summary-window .panel-body::-webkit-scrollbar{width:0;height:0}
.summary-scroll{display:flex;flex:1 1 0;flex-direction:column;gap:11px;min-height:0;padding:17px 21px 13px;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin}
.media-panel .summary-scroll>.note,.video-panel .summary-scroll>.note{margin:0;padding:11px 13px;border:1px solid color-mix(in srgb,var(--border) 45%,transparent);border-radius:12px;background:linear-gradient(120deg,color-mix(in srgb,var(--accent) 5%,var(--bg)),var(--bg));color:var(--muted);font-size:11.5px;line-height:1.55;white-space:pre-line}
.media-summary-status,.video-summary-status{display:flex;align-items:center;gap:7px;margin:0;color:var(--muted);font-size:11px;font-weight:600}
.media-summary-status::before,.video-summary-status::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent)}
.media-progress{height:6px;margin:0!important;border-radius:999px;background:color-mix(in srgb,var(--accent) 11%,var(--bg));box-shadow:inset 0 1px 2px rgba(0,0,0,.05)}
.media-progress-bar{background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 52%,#8b5cf6))}
.media-progress-percent{top:-16px!important;font-weight:650!important;color:var(--muted)!important}
.summary-answer-card{position:relative;flex:0 0 auto;border:1px solid color-mix(in srgb,var(--border) 55%,transparent)!important;border-radius:15px!important;background:linear-gradient(160deg,color-mix(in srgb,var(--surface) 72%,var(--bg)),color-mix(in srgb,var(--bg) 76%,transparent))!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.32),0 10px 28px -24px rgba(20,32,60,.42);white-space:normal}
.media-summary-answer,.video-summary-answer{min-height:180px!important;padding:17px 18px!important;font-size:13.5px;line-height:1.78!important;overflow:visible!important;max-height:none!important}
.summary-answer-card:empty::before{content:"正在整理内容…";color:var(--muted);font-weight:500}

.summary-actions{position:relative!important;bottom:auto!important;z-index:3;display:flex;flex:0 0 auto;flex-wrap:wrap;align-items:center;gap:7px;margin:0!important;padding:10px 14px 12px!important;border-top:1px solid color-mix(in srgb,var(--border) 42%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--surface) 88%,transparent),var(--surface) 48%);box-shadow:0 -10px 24px -26px rgba(20,32,60,.48);border-radius:0}
.summary-actions .text-button{padding:8px 11px!important;border-radius:9px!important;font-weight:600!important}
.summary-actions .summary-action-primary{color:#fff!important;border-color:transparent!important;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#7c5ce7))!important;box-shadow:0 8px 18px -10px color-mix(in srgb,var(--accent) 72%,transparent)}
.summary-actions .summary-action-primary:hover{filter:brightness(1.06)}
.summary-actions .summary-action-secondary{background:color-mix(in srgb,var(--surface) 78%,var(--bg))!important}
.summary-actions .text-button:disabled{opacity:.48;cursor:not-allowed;filter:none}
.summary-appearance{margin-left:auto;padding-left:5px;border-left:1px solid color-mix(in srgb,var(--border) 45%,transparent)}
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
/* Markdown tables and images inside summary/answer surfaces. */
.md-table-wrap{max-width:100%;margin:.75em 0;overflow-x:auto;overscroll-behavior-x:contain;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 46%,transparent);-webkit-overflow-scrolling:touch}
.md-table-wrap table{border-collapse:collapse;width:100%;font-size:.94em;line-height:1.55}
.md-table-wrap th,.md-table-wrap td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);text-align:left;vertical-align:top;word-break:break-word}
.md-table-wrap th{position:sticky;top:0;background:color-mix(in srgb,var(--accent) 9%,var(--surface));font-weight:650;white-space:nowrap}
.md-table-wrap tbody tr:last-child td{border-bottom:0}
.md-table-wrap tbody tr:nth-child(even){background:color-mix(in srgb,var(--text) 3%,transparent)}
.md-table-wrap code{padding:0 3px;font-size:.92em}
.markdown img{max-width:100%;height:auto;display:block;margin:.7em auto;border-radius:10px;border:1px solid color-mix(in srgb,var(--border) 50%,transparent);background:var(--bg)}
.markdown ul.md-tasks{padding-left:1.1em;list-style:none}
.markdown li.md-task{display:flex;align-items:flex-start;gap:6px}
.markdown li.md-task input{margin:.35em 0 0;flex:0 0 auto;accent-color:var(--accent)}
.markdown li.md-task-done{color:var(--muted);text-decoration:line-through}
.markdown del{color:var(--muted)}
/* 总结目录：默认只显示一个按钮，点开才展开；当前章节标题吸顶。 */
.summary-toc{position:absolute;top:56px;right:14px;z-index:6;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none}
.summary-toc-toggle{pointer-events:auto;display:inline-grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--surface) 88%,transparent);color:var(--muted);cursor:pointer;box-shadow:0 6px 16px -12px rgba(18,28,48,.5)}
.summary-toc-toggle:hover{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.summary-toc.open .summary-toc-toggle{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.summary-toc-list{pointer-events:auto;width:min(230px,52vw);max-height:min(52vh,360px);overflow-y:auto;padding:6px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:11px;background:color-mix(in srgb,var(--surface) 96%,transparent);box-shadow:0 18px 44px -24px rgba(18,28,48,.6);scrollbar-width:thin}
.summary-toc-item{display:block;width:100%;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--text);text-align:left;font-size:11.5px;line-height:1.45;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.summary-toc-item:hover{background:var(--hover);color:var(--accent)}
.summary-toc-item.active{background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent);font-weight:650}
.summary-toc-item[data-level="3"]{padding-left:18px;font-size:11px}
.summary-toc-item[data-level="4"]{padding-left:28px;font-size:10.5px;color:var(--muted)}
/* 章节标题吸顶：滚动到本章节时贴住滚动区顶部。 */
/* 章节标题吸顶：只让「当前章节」的标题 sticky。
   早期把每个标题都设成 sticky，结果所有标题同时贴在顶部互相覆盖，
   滚动位置完全看不出来，点目录也像是「没跳」。
   现在由滚动监听给当前章节加 .toc-sticky，滚到下一章时下一个标题接管。 */
.summary-scroll .markdown h1,.summary-scroll .markdown h2,.summary-scroll .markdown h3,.summary-scroll .markdown h4{scroll-margin-top:8px}
/* 当前章节的吸顶标题要明显区别于普通标题：左侧强调色竖条 + 主色文字 +
   加粗放大 + 投影，让人一眼看出「我正停在这一章」。 */
.summary-scroll .markdown .toc-sticky{
  /* --accent resolves to a neutral grey inside a summary window, so the pinned
     chapter uses its own guaranteed-visible accent per theme. */
  --toc-accent:#2f6fed;
  position:sticky;top:0;z-index:4;isolation:isolate;
  margin:2px -8px 10px;padding:9px 12px 9px 15px;
  font-size:calc(var(--summary-font-size,14px) + 1.5px);
  font-weight:800;letter-spacing:.01em;
  color:var(--toc-accent);
  background:linear-gradient(90deg,color-mix(in srgb,var(--toc-accent) 16%,var(--bg)) 0%,color-mix(in srgb,var(--toc-accent) 6%,var(--bg)) 62%,var(--bg) 100%);
  border-radius:10px;
  box-shadow:0 6px 16px -8px color-mix(in srgb,var(--toc-accent) 55%,transparent),0 1px 0 color-mix(in srgb,var(--toc-accent) 20%,transparent) inset;
  backdrop-filter:blur(8px);
}
.summary-scroll .markdown .toc-sticky::before{
  content:"";position:absolute;left:0;top:6px;bottom:6px;width:4px;border-radius:4px;
  background:linear-gradient(180deg,var(--toc-accent),color-mix(in srgb,var(--toc-accent) 55%,transparent));
}
.summary-scroll .markdown .toc-sticky::after{
  content:attr(data-toc-badge);position:absolute;right:10px;top:50%;transform:translateY(-50%);
  padding:1px 7px;border-radius:999px;font-size:9.5px;font-weight:700;letter-spacing:.02em;
  color:var(--toc-accent);background:color-mix(in srgb,var(--toc-accent) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--toc-accent) 34%,transparent);
}
.summary-scroll .markdown .toc-sticky:not([data-toc-badge])::after{display:none}
:host([data-theme="dark"]) .summary-scroll .markdown .toc-sticky{--toc-accent:#8fb4ff}
.summary-scroll .markdown .toc-passed{opacity:.9}
/* 总结内容区必须保有可用高度：追问框和操作栏都在 scroll 之外，
   没有这条下限时它们会把正文挤到几十像素，目录点击就无处可滚。 */
.window.summary-window .summary-scroll{min-height:150px}
/* 下载进度：先下完再保存，进度条在总结内容区下方。 */
.download-progress{flex:0 0 auto;display:flex;flex-direction:column;gap:5px;margin:2px 0 0;padding:9px 12px;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:11px;background:color-mix(in srgb,var(--surface) 52%,transparent)}
.download-progress[hidden]{display:none!important}
.download-progress-track{position:relative;height:6px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,var(--bg));overflow:hidden}
.download-progress-bar{display:block;width:0;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 52%,#8b5cf6));transition:width .18s linear}
.download-progress-text{color:var(--muted);font-size:10.5px;line-height:1.45;font-variant-numeric:tabular-nums}
.download-progress[data-tone="bad"] .download-progress-bar{background:#d85a6d}
.download-progress[data-tone="bad"] .download-progress-text{color:#d85a6d}
.download-progress[data-tone="good"] .download-progress-text{color:var(--accent)}
/* 总结追问：总结正文下方常驻的对话框 */
/* The composer sits between the scrolling answer and the action bar.  It must
   never live inside .summary-scroll: that container is clipped by the panel's
   overflow:hidden, which left the textarea invisible and impossible to type in. */
.followup-box{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;gap:6px;margin:0;padding:8px 14px 9px;border-top:1px solid color-mix(in srgb,var(--border) 46%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--surface) 92%,transparent),var(--surface));z-index:3;position:relative}
.followup-box[hidden]{display:none!important}
.followup-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.followup-title{font-size:calc(var(--summary-font-size,14px) - 2px);font-weight:700;color:var(--text)}
.followup-title::before{content:"✦";margin-right:5px;color:var(--accent)}
.followup-hint{font-size:calc(var(--summary-font-size,14px) - 4px);color:var(--muted)}
.followup-list{display:flex;flex-direction:column;gap:7px;max-height:min(28vh,220px);overflow-y:auto;padding:2px;scrollbar-width:thin;overscroll-behavior:contain}
.followup-list[hidden]{display:none!important}
.followup-turn{display:flex;gap:7px;align-items:flex-start}
.followup-role{flex:0 0 auto;padding:1px 6px;border-radius:6px;font-size:calc(var(--summary-font-size,14px) - 4.5px);font-weight:700;line-height:1.6}
.followup-ask .followup-role{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.followup-answer .followup-role{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--muted)}
.followup-text{flex:1;min-width:0;font-size:var(--summary-font-size,14px);line-height:1.72;overflow-wrap:anywhere}
.followup-text[data-tone="bad"]{color:#d85a6d}
.followup-text p{margin:.4em 0}
.followup-text ul,.followup-text ol{margin:.4em 0;padding-left:1.3em}
.followup-text pre{margin:.5em 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--bg) 72%,transparent);overflow:auto}
.followup-input-row{display:flex;align-items:flex-end;gap:7px}
.followup-input{flex:1;min-width:0;min-height:30px;max-height:120px;resize:none;padding:7px 10px;border:1px solid color-mix(in srgb,var(--border) 62%,transparent);border-radius:9px;background:color-mix(in srgb,var(--bg) 62%,transparent);color:var(--text);font-family:inherit;font-size:var(--summary-font-size,14px);line-height:1.55;outline:none}
.followup-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.followup-input:disabled{opacity:.6}
.followup-send{flex:0 0 auto;padding:7px 12px!important;border-radius:9px!important;color:#fff!important;border-color:transparent!important;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#7c5ce7))!important;font-weight:650!important}
.followup-send:disabled{opacity:.55;filter:none}
.ai-prompt-box{margin:2px 0 8px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--border) 48%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 38%,transparent)}
.ai-prompt-head{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:4px;min-height:16px}
.ai-prompt-label{font-size:11px;font-weight:650;color:var(--text);flex:0 0 auto}
.ai-prompt-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px}
.ai-prompt-toggle,.ai-prompt-reset{padding:2px 6px;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:10px;cursor:pointer;flex:0 0 auto}
.ai-prompt-toggle:hover,.ai-prompt-reset:hover{background:var(--hover);color:var(--text)}
.ai-summary-prompt{width:100%;min-height:46px;max-height:120px;resize:vertical;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 58%,transparent);border-radius:8px;background:color-mix(in srgb,var(--bg) 55%,transparent);color:var(--text);font:11.5px/1.55 inherit;outline:none}
.ai-summary-prompt:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}

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
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}`;

  const TEMPLATE_HTML = `<template id="ldp-win-tpl"><section class="window" role="dialog"><div class="header"><span class="grip">${icon('grip')}</span><span class="title"></span><span class="domain" hidden></span>${button('read', 'read', '阅读模式')}${button('pip', 'pip', '画中画')}${button('forceDark', 'dark', '强制暗色')}${button('theme', 'moon', '切换主题')}${button('pin', 'pin', '固定窗口')}${button('reload', 'refresh', '刷新')}${button('new', 'external', '新标签页')}${button('close', 'close', '关闭')}</div><div class="findbar" hidden><input type="text" class="fb-input" placeholder="在预览页内查找（回车下一个 / Shift+回车上一个）"><span class="fb-label">0/0</span><button type="button" class="btn fb-btn" data-action="findPrev" title="上一个（Shift+回车）">▲</button><button type="button" class="btn fb-btn" data-action="findNext" title="下一个（回车）">▼</button><label class="fb-opt" title="区分大小写"><input type="checkbox" class="fb-case">Aa</label><label class="fb-opt" title="全词匹配"><input type="checkbox" class="fb-ww">词</label><span class="fb-hint"></span><button type="button" class="btn fb-btn" data-action="findClose" title="关闭（Esc）">✕</button></div><div class="content"><div class="progress-bar"></div><iframe title="网页预览" sandbox="${FULL_SANDBOX}" allow="fullscreen"></iframe><div class="image-viewer" hidden><div class="image-stage"><img class="image-el" alt="" draggable="false"></div><div class="image-meta" hidden></div></div><div class="shield" hidden></div><div class="loader" hidden><div class="globe-icon">${icon('globe')}</div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="hint" hidden><button type="button" class="hint-close" data-action="hideHint">×</button><button type="button" class="hint-act" data-action="openTab" hidden></button><span class="hint-text"></span></div></div><div class="toolbar">${button('url', 'link', '复制网址')}<div class="divider"></div>${button('plus', 'plus', '放大')}${button('minus', 'minus', '缩小')}${button('resetZoom', 'reset', '100%')}<span class="zoom-label">100%</span><div class="divider"></div>${button('resetSize', 'fit', '重置尺寸')}<button type="button" class="btn" data-action="grid" title="排列版式" hidden>${icon('layout')}</button><button type="button" class="btn" data-action="arrange" title="智能排列" hidden>${icon('grid')}</button>${button('find', 'search', '预览内查找')}${button('history', 'history', '预览历史')}<button type="button" class="btn reader-tool" data-action="outline" title="文章目录" hidden>${icon('list')}</button><button type="button" class="btn reader-tool" data-action="speak" title="朗读正文" hidden>${icon('volume')}</button><button type="button" class="btn reader-tool" data-action="saveReader" title="导出正文" hidden>${icon('download')}</button>${button('ai', 'spark', 'AI 页面助手')}${button('help', 'help', '使用说明')}${button('settings', 'settings', '设置')}</div><div class="panel" hidden></div><div class="toast" hidden></div>${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `<div class="resize ${d}" data-direction="${d}"></div>`).join('')}</section></template><div class="backdrop" hidden></div><div class="snap-indicator"></div><div class="drop-overlay" hidden><div class="drop-ring"></div><div class="drop-card"><span class="drop-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><path d="m7.6 10.6 4.4 4.4 4.4-4.4"/><path d="M4.5 20.5h15"/></svg></span><span class="drop-text">松手即在此页浮出预览</span></div></div><div class="hover-peek" hidden><div class="peek-head"><span class="peek-title"></span><button type="button" class="peek-btn peek-mute" title="停止播放（静音）" aria-label="停止播放">${icon('mute')}</button><button type="button" class="peek-btn peek-open" title="打开完整预览" aria-label="打开完整预览">${icon('external')}</button></div><div class="peek-body"><div class="peek-stage"><iframe class="peek-frame" title="悬停预览" sandbox="${FULL_SANDBOX}" allow="${PEEK_ALLOW_BLOCK}"></iframe></div><div class="peek-note" hidden><span class="peek-note-ico">${icon('mute')}</span><span class="peek-note-text"></span></div><div class="peek-shield" title="点击打开完整预览"></div></div></div>`;

  /* ==================================================================================
   *  §7 手势：链接命中 / 预热 / 拖拽与长按 / 浮出按钮
   * ================================================================================== */
  /** 从事件路径里找出真正指向外链的那个 <a>（顶层与子框架共用的唯一权威实现） */
  function findLink(event) {
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
    for (let node of path) {
      if (node && node.nodeType === 3) node = node.parentElement;
      while (node && node !== document && node !== window) {
        if (node.nodeType === 1 && node.localName && node.localName.toLowerCase() === 'a' && node.hasAttribute('href')) {
          if (node.hasAttribute('download') || node.isContentEditable) return null;
          const href = node.getAttribute('href');
          if (!href || /^\s*(?:#|javascript:|mailto:|tel:|blob:|data:)/i.test(href)) return null;
          const url = httpUrl(href, node.baseURI || location.href);
          if (!url || isBlacklisted(url)) return null;
          const img = node.querySelector('img');
          const title = (node.getAttribute('title') || node.textContent || (img && img.alt) || '')
            .replace(/\s+/g, ' ').trim().slice(0, 300);
          return { element: node, url, title };
        }
        node = node.parentNode || node.host || null;
      }
    }
    return null;
  }

  function selectionIntersectsElement(selection, element) {
    if (!selection || selection.isCollapsed || !selection.rangeCount || !element) return false;
    const node = element.nodeType === 3 ? element.parentElement : element;
    if (!node || node.nodeType !== 1) return false;
    try { return selection.containsNode(node, true); } catch (e) { return false; }
  }
  /** True while the current mouse/drag gesture is moving selected page text. */
  function selectionTouchesEvent(event) {
    const target = event && event.target;
    if (target && /^(INPUT|TEXTAREA)$/.test(String(target.tagName || '').toUpperCase())
      && Number(target.selectionStart) !== Number(target.selectionEnd)) return true;
    let selection = null;
    try { selection = window.getSelection ? window.getSelection() : null; } catch (e) { selection = null; }
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const path = event && event.composedPath ? event.composedPath() : [target];
    for (const node of path) {
      if (selectionIntersectsElement(selection, node)) return true;
    }
    return false;
  }

  /**
   * 链接预热。拖拽触发是「位移 + 按住时长」双条件，从按下到窗口出现客观上有一段等待；
   * 位移过半阈值时用户意图已经明确（是「拖」不是「选」），此时补 preconnect + prefetch，
   * 等按住时长走完时请求往往已经回来 —— 窗口一出现就是内容而不是空壳。
   *
   * v20.2.3 把这件事**拆成两级**，好在不同确信度上用不同代价的动作：
   *   · preconnectUrl —— 只建 DNS / TCP / TLS，0 字节。按下鼠标时打一次。
   *   · prefetchUrl  —— 真把 HTML 拉回来。只在「意图已经明确」时发：位移过半、
   *     在链接上停够 350ms（悬停小窗预热）。
   *   · warmLink(url, stage) —— stage === 'press' 只建连接，否则两级都做。
   *
   * v20.2.2 曾经把两级都提前到「指针刚碰到链接」和「按下鼠标」：划过链接就 preconnect
   * 会让一页里被扫过的域名全去开连接，而按下鼠标就 prefetch 是一次真实的重复下载
   * （普通点一下打开链接也会在后台再拉一整页）。用户反馈「正常一点就进去了，用这个
   * 等半分钟都没进去」，两项都已回退 —— preconnect 只留「按下鼠标」一处，
   * prefetch 只留「位移过半 / 悬停 350ms」。
   */
  /* preconnect 的并发上限。到顶就**不再建新连接** —— 早期写法是超过阈值就 clear()
     重来，那等于让同一批域名反复重连；链接密集的页面上这会把连接池占住，而预览窗的
     iframe 网络优先级天生最低，只能排在后面等。 */
  const PECONNECT_MAX = 8;
  const warmedUrls = new Set();
  const warmedOrigins = new Set();
  /** 只建连接，不下载：0 字节，安全 */
  function preconnectUrl(url) {
    const target = httpUrl(url);
    if (!target) return '';
    let origin = '';
    try { origin = new window.URL(target).origin; } catch (e) { origin = ''; }
    if (!origin || warmedOrigins.has(origin)) return origin;
    if (warmedOrigins.size >= PECONNECT_MAX) return origin;
    warmedOrigins.add(origin);
    try {
      const head = document.head || document.documentElement;
      if (!head) return origin;
      const pc = document.createElement('link');
      pc.rel = 'preconnect';
      pc.href = origin;
      pc.crossOrigin = '';
      head.appendChild(pc);
      setTimeout(() => { try { pc.remove(); } catch (e) { /* 忽略 */ } }, 20000);
    } catch (e) { /* 忽略 */ }
    return origin;
  }
  /** 真的把 HTML 取回来（顺带补一次 preconnect） */
  function prefetchUrl(url) {
    const target = httpUrl(url);
    if (!target || warmedUrls.has(target)) return;
    /* 只清 URL 去重表；warmedOrigins 不动 —— preconnect 的上限必须是硬的，
       否则同一个域名会被反复重连。 */
    if (warmedUrls.size > 60) warmedUrls.clear();
    warmedUrls.add(target);
    preconnectUrl(target);
    try {
      const head = document.head || document.documentElement;
      if (!head) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      // 用 setAttribute 而不是 link.as = 'document'：属性反射在部分引擎里不落地，
      // 而预取 HTML 文档必须显式声明 as，否则浏览器会按默认类型猜。
      link.setAttribute('as', 'document');
      link.href = target;
      head.appendChild(link);
      setTimeout(() => { try { link.remove(); } catch (e) { /* 忽略 */ } }, 20000);
    } catch (e) { /* 预热失败无所谓，静默 */ }
  }
  /**
   * @param stage 传 'press' 表示「只是按下了鼠标」—— 这时只建连接（0 字节），绝不下载；
   *              省略 / 其他值表示「意图已经明确」—— 建连接 + 真取 HTML。
   */
  function warmLink(url, stage) {
    if (!settings.warmup) return;
    if (stage === 'press') { preconnectUrl(url); return; }
    prefetchUrl(url);
  }

  /**
   * 链接拖拽 / 长按 / Alt 点击。
   * 拖拽是双条件：按住 ≥ getDragHold() 且位移 ≥ getThreshold()。只看位移的话划选必然误触，
   * 而划选一段文字几乎必然超过 12px，所以旧版误触是结构性的。
   * getDragHold() 返回 0 时等同不等待。onIntent(link, stage) 会被调两次：
   * stage === 'press'（刚按下鼠标，只该建连接、不下载）与 stage === undefined
   * （位移过半，意图明确）。
   * @param cfg 触发方式配置 { longPressOpen, altClickOpen }（子框架由宿主实时下发）
   */
  function installLinkDrag(allowed, activate, getThreshold, getLongPressDelay, getDragHold, cfg, onIntent) {
    let candidate = null, suppressed = null, pressTimer = 0, holdTimer = 0;
    // Read the live settings object on demand.  Capturing `settings` here used
    // to freeze the initial defaults: after chrome.storage finished loading,
    // reloadSettingsFromExternal() replaced the object, so longPressOpen /
    // altClickOpen changes silently stopped working.
    const getConf = typeof cfg === 'function' ? cfg : () => (cfg || settings);
    const modifiers = e => e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;
    const clearTimer = (id) => { if (id) clearTimeout(id); return 0; };
    function reset() { candidate = null; pressTimer = clearTimer(pressTimer); holdTimer = clearTimer(holdTimer); }
    function fire(link, event) {
      reset();
      // 记一笔「刚刚由手势浮出过」，1.6 秒内对同一个链接的 click / dragstart 一律吞掉
      suppressed = { element: link.element, url: link.url, until: performance.now() + 1600 };
      activate(link, event);
    }
    window.addEventListener('mousedown', event => {
      reset();
      if (event.button !== 0 || modifiers(event) || !allowed(event)) return;
      if (selectionTouchesEvent(event)) return;
      const link = findLink(event);
      if (!link) return;
      candidate = Object.assign({}, link, {
        x: event.clientX, y: event.clientY,
        t: performance.now(), moved: false, intent: false,
        lastX: event.clientX, lastY: event.clientY
      });
      /* v20.2.3：按下鼠标只做「建连接」（0 字节），**不预取**。
         v20.2.2 这里直接调 onIntent（= warmLink = 整页 prefetch），于是连「普通点一下
         打开链接」都会在后台把目标页再拉一遍，和真正的导航抢带宽、抢同一个 URL 的
         缓存条目 —— 用户报的「正常一点就进去，用这个等半分钟」多半就是它。
         这里**故意不置 candidate.intent = true**：下面 mousemove 的「位移过半」那一步
         仍要补一次真正的 prefetch（那时才是确定要拖）。
         第二个参数 stage = 'press' 让 warmLink 降级成只建连接。 */
      if (onIntent) {
        try { onIntent(candidate, 'press'); } catch (e) { /* 忽略 */ }
      }
      if (getConf().longPressOpen) {
        const source = event;
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          if (candidate && allowed(source)) fire(candidate, { clientX: candidate.x, clientY: candidate.y });
        }, getLongPressDelay());
      }
    }, true);
    window.addEventListener('mousemove', event => {
      if (!candidate) return;
      if (!(event.buttons & 1) || modifiers(event) || !allowed(event)) { reset(); return; }
      try {
        if (selectionIntersectsElement(window.getSelection && window.getSelection(), candidate.element)) { reset(); return; }
      } catch (e) { /* ignore */ }
      const c = candidate;
      c.lastX = event.clientX;
      c.lastY = event.clientY;
      const dist = Math.hypot(event.clientX - c.x, event.clientY - c.y);
      if (pressTimer && dist > LONG_PRESS_MOVE) pressTimer = clearTimer(pressTimer);
      if (!c.intent && onIntent && dist >= Math.max(4, getThreshold() / 2)) {
        c.intent = true;
        try { onIntent(c); } catch (e) { /* 忽略 */ }
      }
      if (dist < getThreshold()) return;
      // 位移达标，再看按住时长够不够
      const wait = getDragHold() - (performance.now() - c.t);
      if (wait <= 0) { fire(c, event); return; }
      c.moved = true;
      // 时长没到就先记下「已越过阈值」，到点补发一次 —— 「猛拖一下再停住」之后不会再有
      // mousemove，只靠 mousemove 判断会永远等不到触发。candidate 被清掉时自然不触发。
      if (!holdTimer) {
        holdTimer = setTimeout(() => {
          holdTimer = 0;
          const cur = candidate;
          if (!cur || !cur.moved) return;
          fire(cur, { clientX: cur.lastX, clientY: cur.lastY });
        }, wait);
      }
    }, true);
    window.addEventListener('dragstart', event => {
      if (selectionTouchesEvent(event)) { reset(); return; }
      const link = findLink(event);
      if (!link) return;
      // 原生拖拽同样受「按住时长」约束：还没按够就交给页面自己处理
      const hold = getDragHold();
      if (candidate && hold > 0 && performance.now() - candidate.t < hold) return;
      if (suppressed && performance.now() < suppressed.until && link.url === suppressed.url) { event.preventDefault(); return; }
      if (modifiers(event) || !allowed(event)) return;
      event.preventDefault();
      fire(candidate || link, event);
    }, true);
    window.addEventListener('click', event => {
      if (getConf().altClickOpen && event.button === 0 && event.altKey
        && !event.ctrlKey && !event.shiftKey && !event.metaKey && allowed(event)) {
        const link = findLink(event);
        if (link) {
          event.preventDefault();
          event.stopImmediatePropagation();
          fire(link, event);
          return;
        }
      }
      if (!suppressed || performance.now() > suppressed.until) return;
      const link = findLink(event);
      if (link && (link.element === suppressed.element || link.url === suppressed.url)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressed = null;
      }
    }, true);
    const cancel = () => reset();
    window.addEventListener('mouseup', cancel, true);
    window.addEventListener('pointerup', cancel, true);
    window.addEventListener('dragend', cancel, true);
    window.addEventListener('blur', cancel);
  }

  function aiQuickAllowed() {
    if (settings.aiQuick === false) return false;
    const host = String(location.hostname || '').toLowerCase();
    const match = raw => String(raw || '').split(/[\s,，]+/).filter(Boolean).some(token => {
      const value = token.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*?\./, '').replace(/:\d+$/, '').toLowerCase();
      return value && (host === value || host.endsWith('.' + value));
    });
    if (match(settings.aiQuickBlacklist)) return false;
    const white = String(settings.aiQuickWhitelist || '').trim();
    return !white || match(white);
  }

  /**
   * 悬停浮出按钮。性能敏感：指针停在同一链接内走 O(1) 快路径，不重复查 DOM；
   * 位置计算合并到 rAF，滚动/缩放期间最多每帧一次。
   */
  function installLauncher(opts) {
    let host = null, btn = null, aiBtn = null, current = null, hideTimer = 0, themeDark = false;
    let lastX = 0, lastY = 0, rafId = 0;
    const setVisible = () => {
      const preview = opts.isPreviewEnabled ? !!opts.isPreviewEnabled() : true;
      const ai = !!(opts.onAskAI && opts.isAIEnabled && opts.isAIEnabled());
      if (btn) btn.hidden = !preview;
      if (aiBtn) aiBtn.hidden = !ai;
      return preview || ai;
    };
    function ensure() {
      const target = opts.mount && opts.mount();
      if (!target || !target.root) return false;
      host = target.host || null;
      if (opts.owned && host) {
        host.dataset.theme = themeDark ? 'dark' : 'light';
        if (opts.applyChrome) { try { opts.applyChrome(host); } catch (e) { /* 忽略 */ } }
      }
      adoptStyles(target.root, LAUNCHER_CSS, 'launcher');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ldp-launcher';
        btn.title = '浮出预览此链接';
        btn.innerHTML = LAUNCHER_ICON;
        btn.hidden = true;
        btn.addEventListener('mouseenter', () => { hideTimer = clearTimeout(hideTimer); });
        btn.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 300); });
        btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          const link = current;
          hide();
          if (link) opts.onLaunch(link, { x: lastX, y: lastY, clientX: lastX, clientY: lastY });
        });
        target.root.append(btn);
      } else if (!btn.isConnected) {
        target.root.append(btn);
      }
      if (opts.onAskAI) {
        if (!aiBtn) {
          aiBtn = document.createElement('button');
          aiBtn.type = 'button';
          aiBtn.className = 'ldp-launcher ldp-launcher-ai';
          aiBtn.title = 'AI 总结此链接';
          aiBtn.innerHTML = LAUNCHER_AI_ICON;
          aiBtn.hidden = true;
          aiBtn.addEventListener('mouseenter', () => { hideTimer = clearTimeout(hideTimer); });
          aiBtn.addEventListener('mouseleave', () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 300); });
          aiBtn.addEventListener('pointerdown', e => {
            e.stopPropagation();
            // Open on press as well as click.  A few sites stop click events
            // globally, and the link-side AI button must still respond.
            try { if (typeof invokeAI === 'function') invokeAI(); } catch (e2) { /* ignore */ }
          });
          aiBtn.addEventListener('mousedown', e => { e.stopPropagation(); });
          let lastAIInvoke = 0;
          const invokeAI = () => {
            const now = Date.now();
            if (now - lastAIInvoke < 350) return;
            lastAIInvoke = now;
            const link = current;
            const point = { x: lastX, y: lastY, clientX: lastX, clientY: lastY };
            if (!link || !opts.onAskAI) return;
            hide();
            try {
              opts.onAskAI(link, point);
            } catch (err) {
              try { toastStandalone('AI 总结打开失败：' + (err && err.message ? err.message : '未知错误')); } catch (e2) { /* ignore */ }
            }
          };
          aiBtn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            invokeAI();
          });
          // Some page-level capture handlers can swallow the synthetic click
          // even though the pointer interaction reached our button.  A pointerup
          // fallback keeps the AI action reliable in those pages.
          aiBtn.addEventListener('pointerup', e => {
            e.stopPropagation();
            invokeAI();
          });
          // Page-level capture handlers occasionally stop pointer events before
          // they reach our shadow-root button.  A document capture listener is
          // the final fallback for those pages.
          if (!aiBtn.__ldpDocPointerBound) {
            aiBtn.__ldpDocPointerBound = true;
            document.addEventListener('pointerdown', event => {
              let path = [];
              try { path = event.composedPath ? event.composedPath() : []; } catch (e) { path = []; }
              if (path.indexOf(aiBtn) >= 0) invokeAI();
            }, true);
          }
          target.root.append(aiBtn);
        } else if (!aiBtn.isConnected) {
          target.root.append(aiBtn);
        }
      }
      return true;
    }
    function hide() {
      clearTimeout(hideTimer); hideTimer = 0;
      current = null;
      if (btn && !btn.hidden) btn.hidden = true;
      if (aiBtn && !aiBtn.hidden) aiBtn.hidden = true;
    }
    function place(link, x, y) {
      const rect = link.element.getBoundingClientRect();
      if (!(rect.width > 0 || rect.height > 0)) return false;
      const vw = window.innerWidth, vh = window.innerHeight, gap = 4;
      const size = LAUNCHER_SIZE;
      const fitsRight = rect.right + gap + size <= vw - 4;
      const fitsLeft = rect.left - gap - size >= 4;
      const anchorY = Number.isFinite(y) ? y : rect.top + rect.height / 2;
      const low = Math.min(rect.top, rect.bottom - size);
      const high = Math.max(rect.top, rect.bottom - size);
      let top = clamp(anchorY - size / 2, low, high);
      top = clamp(top, 4, Math.max(4, vh - size - 4));

      // Never put either launcher over the link itself.  This matters for
      // icon-only links where a 22px button used to cover almost the whole
      // target and caused accidental AI clicks.
      let previewLeft = fitsRight ? rect.right + gap : (fitsLeft ? rect.left - gap - size : rect.left);
      let previewTop = top;
      if (!fitsRight && !fitsLeft) {
        previewLeft = clamp(rect.left, 4, Math.max(4, vw - size - 4));
        previewTop = rect.bottom + gap;
        if (previewTop + size > vh - 4) previewTop = Math.max(4, rect.top - gap - size);
      }
      if (btn) {
        btn.style.left = Math.round(previewLeft) + 'px';
        btn.style.top = Math.round(previewTop) + 'px';
      }
      if (aiBtn) {
        let aiLeft = 0, aiTop = top;
        if (fitsRight) {
          // Preview is on the right of the link; place AI on the left, or
          // outside the preview when the link is at the left edge.
          aiLeft = fitsLeft ? rect.left - gap - size : previewLeft + size + 2;
        } else if (fitsLeft) {
          aiLeft = rect.right + gap;
        } else {
          aiLeft = previewLeft + size + 2;
          if (aiLeft + size > vw - 4) aiLeft = Math.max(4, previewLeft - size - 2);
          aiTop = previewTop;
        }
        aiLeft = clamp(aiLeft, 4, Math.max(4, vw - size - 4));
        aiTop = clamp(aiTop, 4, Math.max(4, vh - size - 4));
        aiBtn.style.left = Math.round(aiLeft) + 'px';
        aiBtn.style.top = Math.round(aiTop) + 'px';
      }
      return true;
    }
    function schedulePlace() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!current) return;
        if (!place(current, lastX, lastY)) hide();
      });
    }
    function show(link, x, y) {
      lastX = Number.isFinite(x) ? x : 0;
      lastY = Number.isFinite(y) ? y : 0;
      if (!ensure()) return;
      if (!place(link, lastX, lastY)) { hide(); return; }
      current = link;
      clearTimeout(hideTimer); hideTimer = 0;
      if (!setVisible()) hide();
    }
    function setTheme(dark) {
      themeDark = !!dark;
      if (opts.owned && host) {
        host.dataset.theme = themeDark ? 'dark' : 'light';
        if (opts.applyChrome) { try { opts.applyChrome(host); } catch (e) { /* 忽略 */ } }
      }
    }
    function handleEnter(link, x, y) {
      if (!opts.isEnabled()) { hide(); return; }
      if (current && current.element === link.element && current.element.isConnected) {
        lastX = Number.isFinite(x) ? x : 0; lastY = Number.isFinite(y) ? y : 0;
        clearTimeout(hideTimer); hideTimer = 0;
        if (ensure()) { if (!setVisible()) hide(); }
        return;
      }
      show(link, x, y);
    }
    function handleLeave() {
      if (!current) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 300);
    }
    return { hide, show, setTheme, handleEnter, handleLeave, schedulePlace, isShowing: () => !!current && ((btn && !btn.hidden) || (aiBtn && !aiBtn.hidden)) };
  }

  /* ==================================================================================
   *  §8 子框架桥接（!TOP）
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  子框架分支是懒挂载的：只有真的收到宿主下发的 init 之后才安装 mousemove / scroll /
   *  链接手势这些「热」监听。页面里那些广告、埋点、统计 iframe 永远收不到 init，
   *  只会多挂一个 message 监听，开销接近 0 —— 这也是可以去掉 @noframes、
   *  从而支持预览窗口无限嵌套的前提。
   * ================================================================================== */
  if (!TOP) {
    let enabled = false, bridgeToken = '', bridgeNavSeq = 0, parentOrigin = '*', threshold = 12,
      longPressDelay = 500, dragHold = 150, launcherEnabled = true, imageDragPreview = true,
      frameGlassPx = 22, frameRadiusPx = 26, frameDark = false,
      frameHost = null, frameRoot = null, lastFocusSent = 0, frameBound = false,
      scrollReportSuppressUntil = 0;   // setScroll/sync 引发的程序滚动不回传（防 A↔B 回环）
    // 触发方式以宿主实时下发为准，不读取子框架本地的 settings（那只是宿主配置的副本）
    const bridgeCfg = { longPressOpen: true, altClickOpen: true };
    let frameLauncher = null;
    function send(data) {
      if (!enabled) return;
      try {
        window.parent.postMessage(Object.assign({
          channel: CHANNEL, token: bridgeToken, navSeq: bridgeNavSeq
        }, data), parentOrigin);
      } catch (e) { /* 忽略 */ }
    }
    /* v20.3：把自身的加载阶段报给宿主。宿主原来要等整个 load 完成才撤骨架屏 ——
       而 iframe 的网络优先级天生低于标签页导航（资源调度靠后、缓存又是另一个分区），
       憋到整页加载完就显得特别久。dcl（DOMContentLoaded）一到就上报，宿主立刻掀开
       骨架屏，页面边加载边显示 —— 和直接开新标签页的体感一致。 */
    function reportStage() {
      send({ type: 'stage', stage: 'dcl' });
    }
    if (document.readyState !== 'loading') reportStage();
    else document.addEventListener('DOMContentLoaded', reportStage);
    function openHere(link, event) {
      const vw = Math.max(1, window.innerWidth), vh = Math.max(1, window.innerHeight);
      let nx = 0.5, ny = 0.5;
      if (Number.isFinite(event && event.clientX) && Number.isFinite(event && event.clientY)) {
        nx = clamp(event.clientX / vw, 0, 1);
        ny = clamp(event.clientY / vh, 0, 1);
      }
      send({ type: 'open', url: link.url, title: link.title, nx, ny });
    }
    /**
     * 浮出按钮的材质：把宿主的「界面玻璃磨砂 / 统一圆角」算出来的同一份材质配方
     * 搬到本框架的宿主元素上。宿主侧怎么变、预览窗里的浮出按钮就怎么变。
     */
    function applyFrameChrome(host) {
      if (!host) return;
      try {
        let dark = frameDark;
        try { dark = getEffectiveDark(); } catch (e) { /* 忽略 */ }
        const t = CAN_BLUR ? clamp(frameGlassPx / GLASS_MAX, 0, 1) : 0;
        const rec = glassRecipe(t, dark, 1);
        host.dataset.glass = rec.off ? 'off' : 'on';
        host.style.setProperty('--glass-a', rec.fill);
        host.style.setProperty('--glass-filter', rec.filter);
        host.style.setProperty('--r-ctl', Math.round(frameRadiusPx * 0.42) + 'px');
      } catch (e) { /* 忽略 */ }
    }
    function mountFrameLauncher() {
      if (!frameHost || !frameHost.isConnected) {
        if (!document.documentElement) return null;
        if (!frameHost) {
          frameHost = document.createElement('div');
          frameHost.dataset.ldpFrame = 'true';
          frameHost.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;display:block!important;pointer-events:none!important;z-index:2147483647!important';
          frameRoot = frameHost.attachShadow({ mode: 'open' });
        }
        document.documentElement.append(frameHost);
      }
      return { root: frameRoot, host: frameHost };
    }
    function bindFrame() {
      if (frameBound) return;
      frameBound = true;
      frameLauncher = installLauncher({
        isEnabled: () => enabled && launcherEnabled,
        onLaunch: openHere,
        mount: mountFrameLauncher,
        owned: true,
        applyChrome: applyFrameChrome
      });
      frameLauncher.setTheme(prefersDark());
      installLinkDrag(() => enabled, openHere, () => threshold, () => longPressDelay, () => dragHold, bridgeCfg,
        (link, stage) => warmLink(link.url, stage));

      // 子框架内无法用 mouseover（按钮挂在 shadow root 上，指针在按钮内时不会再产生
      // 页面级事件），因此用捕获阶段的 mousemove 做一次 closest('a[href]') 判定，
      // 命中后走 O(1) 快路径。
      window.addEventListener('mousemove', event => {
        if (!enabled || !launcherEnabled) { frameLauncher.handleLeave(); return; }
        const t = event.target;
        const node = t && t.nodeType === 1 ? t : (t && t.parentElement) || null;
        if (imageDragPreview && node && node.closest && node.closest('img')) { frameLauncher.handleLeave(); return; }
        const anchor = node && node.closest ? node.closest('a[href]') : null;
        if (!anchor || anchor.hasAttribute('download') || anchor.isContentEditable) { frameLauncher.handleLeave(); return; }
        const url = httpUrl(anchor.getAttribute('href') || '', anchor.baseURI || location.href);
        if (!url || isBlacklisted(url)) { frameLauncher.handleLeave(); return; }
        const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        frameLauncher.handleEnter({ element: anchor, url, title }, event.clientX, event.clientY);
      }, true);
      window.addEventListener('scroll', () => frameLauncher.schedulePlace(), true);
      let frameRaf = 0;
      window.addEventListener('resize', () => {
        if (frameRaf) return;
        frameRaf = requestAnimationFrame(() => { frameRaf = 0; frameLauncher.schedulePlace(); });
      });
      window.addEventListener('blur', () => frameLauncher.hide());
      window.addEventListener('mousedown', () => {
        const now = performance.now();
        if (now - lastFocusSent < FRAME_FOCUS_HZ) return;
        lastFocusSent = now;
        send({ type: 'focus' });
      }, true);
      // 自己内部滚动时上报比例，供宿主同步到其它预览窗口。
      // scrollReportSuppressUntil 在子框架顶层声明：宿主带过来的 setScroll/sync 会引发
      // 程序滚动，滚动事件同样会触发这段上报 —— 不拦住就会 A→B→A 互相触发，
      // 形成抖动循环（v19.1 的防回环）。
      let innerScrollTimer = 0;
      window.addEventListener('scroll', () => {
        if (performance.now() < scrollReportSuppressUntil) return;
        if (innerScrollTimer) return;
        innerScrollTimer = setTimeout(() => {
          innerScrollTimer = 0;
          const doc = document.scrollingElement || document.documentElement;
          if (!doc) return;
          const max = doc.scrollHeight - window.innerHeight;
          send({ type: 'innerScroll', ratio: max > 0 ? clamp(doc.scrollTop / max, 0, 1) : 0 });
        }, 120);
      }, true);
      window.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) send({ type: 'escape' }); });
    }

    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source !== window.parent || !isObj(data) || data.channel !== CHANNEL) return;
      if (data.type === 'init' && isStr(data.token)) {
        enabled = true;
        bridgeToken = data.token;
        bridgeNavSeq = Number.isFinite(Number(data.navSeq)) ? Number(data.navSeq) : 0;
        parentOrigin = event.origin === 'null' ? '*' : event.origin;
        threshold = clampNum(data.threshold, 5, 80, 12, true);
        longPressDelay = clampNum(data.longPressDelay, 200, 2000, 500, true);
        dragHold = clampNum(data.dragHold, 0, 800, 150, true);
        frameGlassPx = clampNum(data.glass, 0, 40, 22, true);
        frameRadiusPx = clampNum(data.radius, 0, 40, 26, true);
        frameDark = data.dark === true;
        if (frameHost) applyFrameChrome(frameHost);
        bridgeCfg.longPressOpen = data.longPressOpen !== false;
        bridgeCfg.altClickOpen = data.altClickOpen !== false;
        launcherEnabled = data.linkButton !== false;
        imageDragPreview = data.imageDragPreview !== false;
        // The child frame does not run the host's async storage loader, so the
        // parent must push these policy values with init.  Otherwise nested
        // link gestures silently use DEFAULTS (empty blacklist, warmup on).
        if (isStr(data.blacklist)) settings.blacklist = data.blacklist;
        if (typeof data.warmup === 'boolean') settings.warmup = data.warmup;
        bindFrame();
        // 按钮贴在预览页上，用「这个页面自己的底色」判断明暗比用宿主页面的更准
        try { frameLauncher.setTheme(getEffectiveDark()); } catch (e) { frameLauncher.setTheme(data.dark === true); }
        if (!launcherEnabled) frameLauncher.hide();
        send({ type: 'ready', title: pageTitle(document), url: location.href });
        /* v20.3：如果 init 到达时 DCL 已经过了（页面很小 / 加载很快 / 宿主补发得晚），
           上面的监听不会再触发 —— 这里立刻补一次上报，两条路谁后到谁负责。 */
        if (document.readyState !== 'loading') reportStage();
        return;
      }
      /* setScroll：宿主转发的「其它窗口滚动到这个比例了」。
         sync：宿主页面自己滚动时的广播。v19.1 之前子框架在 token 校验处直接把它丢掉
         （sync 消息不带 token），这是同步滚动「开了没反应」的断点二 —— 两种消息
         走同一条应用逻辑，且都无需 token：滚动同步本来就不关心发送方身份。 */
      if ((data.type === 'setScroll' || data.type === 'sync') && typeof data.ratio === 'number') {
        const doc = document.scrollingElement || document.documentElement;
        if (doc) {
          const max = doc.scrollHeight - window.innerHeight;
          if (max > 0) {
            scrollReportSuppressUntil = performance.now() + 240;
            window.scrollTo(0, Math.round(max * clamp(data.ratio, 0, 1)));
          }
        }
        return;
      }
      if (!enabled || data.token !== bridgeToken) return;
      if (data.type === 'request' && data.action === 'info' && isStr(data.id)) {
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
    return;   // 子框架不再执行宿主逻辑
  }

  /* ==================================================================================
   *  §9 宿主状态
   * ================================================================================== */
  const windows = [];                 // 打开中的预览窗口，数组顺序 = 堆叠顺序
  const requests = new Map();         // 等待子框架回话的请求
  const pausedVideos = new WeakMap();
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  let shell = null;
  let launcher = null;
  let sequence = 0;
  let gesture = null;
  let scrollSnapshot = null;
  let arrangeState = null;
  let visibilityPaused = false;
  let dragOverlay = null;
  let syncSource = null;
  let shortcutsMap = Object.create(null);
  let helpOpened = false;
  let firstHelpShown = false;
  let dropDepth = 0;
  let restoringSession = false;
  let currentPalette = null;
  let currentPaletteDark = null;

  /* ==================================================================================
   *  §10 主题渲染（调色板 + 材质，一次写入）
   *  v19：折射的 SVG defs 注入（ensureRefractDefs）与指针跟随高光
   *  （setSheen / flushSheen / pointermove 监听）已随液态玻璃整体删除。
   * ================================================================================== */

  function ensureShell() {
    if (shell && shell.host.isConnected) return;
    if (!document.documentElement) return;
    const host = document.createElement('div');
    host.dataset.ldpHost = 'true';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;display:block!important;pointer-events:none!important;z-index:2147483647!important;isolation:isolate!important';
    // Closed root: the host page must not be able to read or rewrite the
    // in-page settings UI.  It used to be open, which let any page script read
    // API keys from input values and retarget the AI endpoint.
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = TEMPLATE_HTML;
    adoptStyles(root, CSS, 'shell');
    shell = {
      host, root,
      backdrop: root.querySelector('.backdrop'),
      snapIndicator: root.querySelector('.snap-indicator')
    };
    // Events retarget at the shadow boundary: window-level handlers only see the
    // host, so `isEditingEvent()` could not tell that the user was typing in a
    // panel field.  Track the real focused element here, where paths are intact.
    const trackFocus = event => {
      const node = event.target;
      if (!node || node.nodeType !== 1) { shadowEditingEl = null; return; }
      const tag = String(node.localName || '').toLowerCase();
      shadowEditingEl = (node.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select') ? node : null;
    };
    root.addEventListener('focusin', trackFocus, true);
    root.addEventListener('focusout', () => {
      // Defer: focus may move straight to another field inside the same root.
      setTimeout(() => {
        if (!shadowEditingEl || !shadowEditingEl.isConnected) { shadowEditingEl = null; return; }
        try { if (!shadowEditingEl.matches(':focus')) shadowEditingEl = null; } catch (e) { shadowEditingEl = null; }
      }, 0);
    }, true);
    document.documentElement.append(host);
    // 窗口重建时把已有窗口重新挂回新的 shadow root
    if (windows.length) for (const item of windows) if (!item.closed) root.append(item.ui.win);
    shell.backdrop.addEventListener('click', () => {
      if (!settings.backdropClose) return;
      // A summary window is a page-side panel, not a modal preview.  Clicking
      // page content must never close it or leave an empty backdrop behind.
      if (windows.some(w => !w.closed && w.ui && w.ui.win && w.ui.win.classList.contains('summary-window'))) return;
      const item = [...windows].reverse().find(w => !w.pinned && !isEffPip(w));
      if (item) closeWindow(item);
    });
    renderTheme(true);
  }
  function isEffPip(w) { return w.pip && !w.inArrange; }

  /** Focused editable inside our closed shadow root (see ensureShell). */
  let shadowEditingEl = null;

  let appliedThemeSig = '';
  let appliedThemeHost = null;
  let themeRAF = 0;
  /**
   * 把「调色板 + 统一玻璃材质 + 圆角」一次性写到宿主元素上。
   * 采样只做一次（旧版 getEffectiveDark() 与 generatePalette() 各采一次，等于每帧两遍
   * getComputedStyle + 强制样式计算）；采样本身带 TTL 缓存，需要重新取值的地方会先 invalidate。
   * force 只表示「立刻渲染、不要等 rAF」。
   */
  function renderTheme(force) {
    if (!shell) return;
    if (themeRAF) { if (!force) return; cancelAnimationFrame(themeRAF); themeRAF = 0; }
    const run = () => {
      themeRAF = 0;
      if (!shell || !shell.host.isConnected) return;
      const sample = sampleTheme(false);
      // 明暗判定：settings.theme 明确指定时必须说了算，否则标题栏那个「切换日间/夜间」
      // 按钮就成了摆设 —— 它只改 settings.theme，而这里旧版直接取 sample.dark（页面底色
      // 决定的），于是点了没反应。getEffectiveDark() 本来就是干这件事的，只是没被用上。
      const isDark = settings.theme === 'dark' ? true : settings.theme === 'light' ? false : sample.dark;
      const themeName = isDark ? 'dark' : 'light';
      const palette = generatePalette(sample.base, isDark);
      // 「背景柔化」只管被预览页面有多糊；「界面玻璃磨砂」只管界面层有多厚。两者互不干扰。
      const bgOn = CAN_BLUR && !!settings.blur && clampNum(settings.blurAmount, 0, 24, 8, true) > 0;
      const blurPx = (bgOn ? clampNum(settings.blurAmount, 0, 24, 8, true) : 0) + 'px';
      // 磨砂档位 → 连续系数 t：0 是干净的实心面，1 是最厚磨砂，中间没有任何突变点
      const t = CAN_BLUR ? clamp(clampNum(settings.glassBlur, 0, GLASS_MAX, 22, true) / GLASS_MAX, 0, 1) : 0;
      const alpha = clampNum(settings.windowOpacity, 60, 100, 100, true) / 100;
      const rec = glassRecipe(t, isDark, alpha);

      // 透明度 100% 时把遮罩置为 none，此时完全不产生遮罩合成开销
      const winMask = alpha >= 1 ? 'none' : `linear-gradient(rgba(0,0,0,${alpha}),rgba(0,0,0,${alpha}))`;
      // 五级同心圆角全部由「统一圆角」派生 —— 改一处，整套 UI 一起变
      const radius = clampNum(settings.radius, 0, 40, 26, true);
      let sig = [themeName, blurPx, rec.fill, rec.filter, winMask, radius].join('|') + '|';
      if (palette) for (const key of PALETTE_VARS) sig += (palette[key] || '') + ',';
      else sig += 'default';
      if (sig === appliedThemeSig && appliedThemeHost === shell.host) return;   // 什么都没变，一个 DOM 都不碰
      const prevDark = currentPaletteDark;
      appliedThemeSig = sig;
      appliedThemeHost = shell.host;
      currentPalette = palette;
      currentPaletteDark = isDark;
      const host = shell.host, st = host.style;
      if (host.dataset.theme !== themeName) host.dataset.theme = themeName;
      if (typeof refreshSummaryTheme === 'function') { try { refreshSummaryTheme(themeName); } catch (e) { /* ignore */ } }
      if (palette) {
        for (const key of PALETTE_VARS) if (palette[key]) st.setProperty('--' + key, palette[key]);
      } else {
        for (const key of PALETTE_VARS) st.removeProperty('--' + key);
      }
      st.setProperty('--blur', blurPx);
      st.setProperty('--glass-a', rec.fill);
      st.setProperty('--glass-filter', rec.filter);
      st.setProperty('--r-win', radius + 'px');
      st.setProperty('--r-in', Math.max(0, radius - 1) + 'px');
      st.setProperty('--r-pop', Math.round(radius * 0.62) + 'px');
      st.setProperty('--r-ctl', Math.round(radius * 0.42) + 'px');
      st.setProperty('--r-chip', Math.round(radius * 0.30) + 'px');
      st.setProperty('--win-opacity', String(alpha));
      st.setProperty('--win-mask', winMask);
      updateThemeButtons();
      // 阅读模式是整篇 Blob 渲染的，明暗真的变了才重画
      if (prevDark !== null && prevDark !== isDark) {
        for (const w of windows) if (!w.closed && w.isReaderMode && w.readerSource) renderReaderMode(w);
      }
    };
    if (force) run();
    else themeRAF = requestAnimationFrame(run);
  }
  function updateThemeButtons() {
    if (!shell) return;
    const showToggle = settings.theme !== 'auto';
    const isDark = shell.host.dataset.theme === 'dark';
    for (const item of windows) {
      if (item.closed) continue;
      const themeBtn = item.ui.themeBtn;
      if (themeBtn) {
        if (themeBtn.hidden === showToggle) themeBtn.hidden = !showToggle;
        if (showToggle) {
          themeBtn.innerHTML = icon(isDark ? 'sun' : 'moon');
          themeBtn.title = isDark ? '切换日间' : '切换夜间';
        }
      }
      // v19.1：强制暗色按钮不再跟随主题按钮的显隐 —— 旧代码把两者共用一条
      // 「仅手动主题时显示」的规则，导致默认的自动取色模式下这个按钮被藏起来，
      // 用户根本找不到入口。强制暗色只作用于预览页内容，与界面主题无关，永远可见。
      const fdBtn = item.ui.fdBtn;
      if (fdBtn && fdBtn.hidden) fdBtn.hidden = false;
      if (fdBtn && item.imageMode) fdBtn.hidden = true;
    }
  }
  if (themeMedia) {
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', () => renderTheme(false));
    else if (themeMedia.addListener) themeMedia.addListener(() => renderTheme(false));
  }

  /* ---- 跟随页面主题变化（SPA 切主题 / 夜间插件 / color-scheme 改动） ---- */
  let themeObserver = null;
  let themeMutTimer = 0;
  let themeSelfWriteUntil = 0;
  function noteSelfStyleWrite() { themeSelfWriteUntil = performance.now() + 120; }
  function themeFollowWanted() { return settings.theme === 'auto' && settings.themeFollow; }
  function scheduleThemeResample() {
    if (!themeFollowWanted() || !shell) return;
    clearTimeout(themeMutTimer);
    themeMutTimer = setTimeout(() => {
      themeMutTimer = 0;
      invalidateThemeSample();
      // Apply synchronously: hidden/background tabs throttle rAF, which kept
      // the old light palette on pages whose theme changed just before a preview.
      renderTheme(true);
    }, THEME_MUTATE_DEBOUNCE);
  }
  function onThemeMutations(records) {
    for (const rec of records) {
      if (rec.type !== 'attributes') continue;
      // 自己锁背景滚动时也会改 html 的 style，别把自己当成页面主题变化
      if (rec.attributeName === 'style' && performance.now() < themeSelfWriteUntil) continue;
      scheduleThemeResample();
      return;
    }
  }
  function syncThemeObserver() {
    if (!window.MutationObserver) return;
    if (!themeFollowWanted()) { if (themeObserver) { themeObserver.disconnect(); themeObserver = null; } return; }
    if (!themeObserver) themeObserver = new window.MutationObserver(onThemeMutations);
    themeObserver.disconnect();
    const opts = { attributes: true, attributeFilter: THEME_ATTRS };
    try { themeObserver.observe(document.documentElement, opts); } catch (e) { /* 忽略 */ }
    try { if (document.body) themeObserver.observe(document.body, opts); } catch (e) { /* 忽略 */ }
  }
  /**
   * v17 新增：取色「落定」时机。
   *
   * 脚本在 document-start 就跑了，那一刻页面还没有任何样式：body 不存在或透明，
   * 只能走 meta theme-color 兜底 —— 而它常常是站点主色（多半是蓝的）。这份错误样本
   * 会一直用到下一次重新取色为止，于是「某些页面整体偏蓝、随便调一下设置又正常了」
   * 就出现了（调设置会触发重新渲染，缓存过期后重采到正确底色）。
   * 现在在 DOMContentLoaded 与 load 各补采一次，把首屏的错样本换掉。
   */
  function scheduleThemeSettle() {
    const kick = () => { invalidateThemeSample(); if (shell && shell.host.isConnected) renderTheme(true); };
    const once = (target, name, delay) => {
      try { target.addEventListener(name, () => setTimeout(kick, delay), { once: true }); }
      catch (e) { /* 忽略 */ }
    };
    if (document.readyState === 'complete') { setTimeout(kick, 80); return; }
    if (document.readyState === 'loading') once(document, 'DOMContentLoaded', 0);
    once(window, 'load', 140);
  }

  /* ==================================================================================
   *  §11 几何与布局
   * ================================================================================== */
  /** 把矩形夹进可视区，并保证不小于可用空间 */
  function fit(rect, marginOverride) {
    const v = viewport();
    const margin = Number.isFinite(marginOverride) ? clamp(marginOverride, 0, 40) : Math.min(8, v.w / 4, v.h / 4);
    const maxW = Math.max(1, v.w - margin * 2), maxH = Math.max(1, v.h - margin * 2);
    const w = clamp(Number(rect.w) || 1000, Math.min(280, maxW), maxW);
    const h = clamp(Number(rect.h) || 720, Math.min(220, maxH), maxH);
    return {
      w, h,
      x: clamp(Number.isFinite(rect.x) ? rect.x : (v.w - w) / 2, margin, Math.max(margin, v.w - w - margin)),
      y: clamp(Number.isFinite(rect.y) ? rect.y : (v.h - h) / 2, margin, Math.max(margin, v.h - h - margin))
    };
  }
  function offsetRect(w, h, ox, oy) {
    const v = viewport();
    const px = Number.isFinite(ox) ? ox : settings.offsetX;
    const py = Number.isFinite(oy) ? oy : settings.offsetY;
    return { w, h, x: (v.w - w) / 2 + v.w * px / 100, y: (v.h - h) / 2 + v.h * py / 100 };
  }
  function defaultRect() { return fit(offsetRect(settings.desktopWidth, settings.desktopHeight)); }
  /**
   * 新窗口落点。
   *   spawnMode = default → 固定默认位置（默认尺寸 + 偏移），不跟随鼠标；
   *                           只有和已有窗口几乎完全重合时才轻微错位，避免整块被盖住。
   *             = cursor  → 落在指针 / 手势位置
   *             = cascade → 在默认位置基础上按窗口数依次错位铺开
   * 由父窗口打开的嵌套预览始终相对父窗口错位 —— 那是层级关系，不受这一项影响。
   */
  function spawnRect(item, parent, point) {
    const base = { x: item.rect.x, y: item.rect.y, w: item.rect.w, h: item.rect.h };
    if (parent && !parent.closed) return fit(Object.assign({}, base, { x: parent.rect.x + 26, y: parent.rect.y + 26 }));
    if (settings.spawnMode === 'cursor' && point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      return fit(Object.assign({}, base, { x: point.x - base.w / 2, y: point.y - 16 }));
    }
    if (settings.spawnMode === 'cascade') {
      const i = windows.length % 7;
      return fit(Object.assign({}, base, { x: base.x + i * 22, y: base.y + i * 22 }));
    }
    if (item.bare) return fit(base);
    const clash = windows.some(w => !w.closed && Math.abs(w.rect.x - base.x) < 26 && Math.abs(w.rect.y - base.y) < 26);
    if (clash) {
      const i = (windows.length % 5) + 1;
      return fit(Object.assign({}, base, { x: base.x + i * 26, y: base.y + i * 26 }));
    }
    return fit(base);
  }
  /**
   * 工具条停靠：贴边时不再压在正文上。优先停靠在窗口外侧（左侧没位置就换到右侧），
   * 两侧都放不下（窗口接近满宽）才进窗口内，进窗口内时由 CSS 给 .content 让出一列。
   */
  const TB_WIDTH = 47;
  function dockModeFor(rect) {
    const want = settings.toolbarSide;
    if (want === 'inside') return 'inside';
    const v = viewport();
    const leftRoom = rect.x;
    const rightRoom = v.w - (rect.x + rect.w);
    if (want === 'left') return leftRoom >= TB_WIDTH ? 'left' : (rightRoom >= TB_WIDTH ? 'right' : 'inside');
    if (want === 'right') return rightRoom >= TB_WIDTH ? 'right' : (leftRoom >= TB_WIDTH ? 'left' : 'inside');
    if (leftRoom >= TB_WIDTH) return 'left';
    if (rightRoom >= TB_WIDTH) return 'right';
    return 'inside';
  }
  function applyToolbarDock(item, rect) {
    const mode = dockModeFor(rect);
    if (item.dockMode === mode) return;
    item.dockMode = mode;
    const cls = item.ui.win.classList;
    cls.toggle('tb-right', mode === 'right');
    cls.toggle('tb-inside', mode === 'inside');
  }
  /** 布局记忆 / 会话记忆共用的分区键（同域名 / 同栏目 / 精确页面） */
  function layoutKey(url) {
    let u;
    try { u = new window.URL(url); } catch (e) { return url; }
    if (settings.grouping === 'site') return u.origin;
    if (settings.grouping === 'page') return u.origin + u.pathname;
    const parts = u.pathname.split('/').filter(Boolean);
    let section = parts.length > 1 ? parts[0] : '';
    if (/^\d+$/.test(section) || section.indexOf('.') >= 0) section = '';
    return u.origin + '/' + section;
  }
  function saveLayout(item) {
    if (!settings.remember || item.isReaderMode || item.pip) return;
    const v = viewport();
    layouts[item.key] = {
      w: Math.round(item.rect.w), h: Math.round(item.rect.h), zoom: item.zoom,
      ox: Math.round((item.rect.x + item.rect.w / 2 - v.w / 2) / v.w * 1000) / 10,
      oy: Math.round((item.rect.y + item.rect.h / 2 - v.h / 2) / v.h * 1000) / 10,
      time: Date.now()
    };
    const keys = Object.keys(layouts);
    if (keys.length > 150) {
      keys.sort((a, b) => ((layouts[a] && layouts[a].time) || 0) - ((layouts[b] && layouts[b].time) || 0));
      keys.slice(0, keys.length - 150).forEach(k => delete layouts[k]);
    }
    writeStore(LAYOUTS_KEY, layouts);
  }
  function setScrollLock(lock) {
    if (lock && !scrollSnapshot) {
      scrollSnapshot = [document.documentElement, document.body].filter(Boolean)
        .map(node => ({ el: node, value: node.style.getPropertyValue('overflow'), priority: node.style.getPropertyPriority('overflow') }));
      noteSelfStyleWrite();
      for (const it of scrollSnapshot) it.el.style.setProperty('overflow', 'hidden', 'important');
    } else if (!lock && scrollSnapshot) {
      noteSelfStyleWrite();
      for (const it of scrollSnapshot) {
        if (it.el.style.getPropertyValue('overflow') !== 'hidden') continue;
        if (it.value) it.el.style.setProperty('overflow', it.value, it.priority);
        else it.el.style.removeProperty('overflow');
      }
      scrollSnapshot = null;
    }
  }
  function pauseBackgroundVideos() {
    if (!settings.pauseVideos) return;
    document.querySelectorAll('video').forEach(v => {
      try {
        if (v.paused || v.ended || pausedVideos.has(v)) return;
        pausedVideos.set(v, { muted: v.muted, volume: v.volume, wasPlaying: true });
        v.pause();
      } catch (e) { /* 某些跨域视频不可控 */ }
    });
  }
  function resumeBackgroundVideos() {
    // 只还原「我们暂停过、且当时确实在播放」的视频；用户自己暂停过的不动
    document.querySelectorAll('video').forEach(v => {
      const state = pausedVideos.get(v);
      if (!state) return;
      pausedVideos.delete(v);
      if (!state.wasPlaying || !v.isConnected || v.ended) return;
      try {
        v.muted = state.muted;
        v.volume = state.volume;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* 自动播放策略拒绝，忽略 */ }
    });
  }

  /* ==================================================================================
   *  §12 窗口渲染与窗口栈
   * ================================================================================== */
  function syncStack() {
    if (!shell) return;
    const hasModal = windows.some(w => !w.bare && !w.summaryProtected && !w.pinned && !isEffPip(w) && !(w.ui && w.ui.win && w.ui.win.classList.contains('summary-window')));
    const hasPip = windows.some(w => !w.bare && !w.summaryProtected && !w.closed && isEffPip(w) && !(w.ui && w.ui.win && w.ui.win.classList.contains('summary-window')));
    const hasAny = windows.length > 0;
    if (shell.backdrop.hidden === hasModal) shell.backdrop.hidden = !hasModal;
    windows.forEach((item, index) => {
      const z = String(10 + index);
      if (item.ui.win.style.zIndex !== z) item.ui.win.style.zIndex = z;
      item.ui.win.classList.toggle('active', index === windows.length - 1 && !isEffPip(item));
    });
    const showArrange = windows.length >= 2;
    for (const item of windows) {
      const btn = item.ui.arrangeBtn;
      if (!btn) continue;
      if (btn.hidden === showArrange) btn.hidden = !showArrange;
      btn.classList.toggle('selected', !!arrangeState);
    }
    setScrollLock((settings.lockScroll && hasModal) || (settings.lockScrollWhenPip && hasPip));
    updateThemeButtons();
    if (syncSource && windows.indexOf(syncSource) < 0) syncSource = null;
    scheduleBadgeUpdate();
  }
  function focusWindow(item) {
    if (!item || item.closed) return;
    const index = windows.indexOf(item);
    if (index >= 0 && index !== windows.length - 1) {
      windows.splice(index, 1);
      windows.push(item);
    }
    // 关掉其它窗口的面板时要正常提交输入，不能静默丢掉用户刚填的数字。
    // AI summary 是持久窗口：打开另一个拖拽预览时不能把它的面板关掉，
    // 否则会留下一块空白但仍遮住网页的 summary 外壳。
    for (const w of windows) {
      if (w === item || w.closed || w.ui.panel.hidden) continue;
      if (w.summaryProtected || (w.ui.win && w.ui.win.classList.contains('summary-window'))) continue;
      closePanel(w, true);
    }
    syncStack();
    // v19.1：同步滚动改为「谁滚动谁就是源」，焦点切换不再有「主窗口」一说，
    // 原来那句「已切换同步滚动的主窗口」提示连同逻辑一并撤掉。
  }
  function toast(item, message) {
    if (!item || item.closed) return;
    clearTimeout(item.toastTimer);
    item.ui.toast.textContent = message;
    item.ui.toast.hidden = false;
    item.toastTimer = setTimeout(() => { if (!item.closed) item.ui.toast.hidden = true; }, 3600);
  }
  /* v20.2.2：「打不开」类提示统一的动作按钮描述（hint 的第二参数） */
  const HINT_OPEN_TAB = { label: '在新标签页打开', action: 'openTab' };
  /**
   * 窗口内的提示条。
   * v20.2.2 起支持带一个动作按钮 —— 「打不开」这类提示只让用户自己去工具栏找
   * 「新标签页」太绕，直接在提示条上给一个「在新标签页打开」。不传 action 时按钮收起。
   */
  function hint(item, message, action) {
    if (item.closed) return;
    item.ui.hintText.textContent = message;
    if (item.ui.hintAct) {
      if (action) {
        item.ui.hintAct.textContent = action.label;
        item.ui.hintAct.setAttribute('data-action', action.action);
        item.ui.hintAct.hidden = false;
      } else {
        item.ui.hintAct.hidden = true;
      }
    }
    item.ui.hint.hidden = false;
  }
  function renderGeometry(item, force) {
    const r = item.rect;
    // Keep the outside-left command rail on screen.  Without this, a window
    // near the left edge would flip the rail to the right (or inside), which
    // defeats the fixed-left layout the user asked for.  Maximized windows
    // still fall back to the inside mode because they have no room.
    const rv = viewport();
    if (!item.pip && !item.preMaxRect
      && !(item.ui && item.ui.win && item.ui.win.classList.contains('summary-window'))) {
      const railGap = 64;
      // Never shrink a normal/maximized window just to make room for the rail.
      // Shift it instead; if the viewport is simply too narrow, keep the whole
      // window inside the viewport and let dockModeFor() move the rail inside.
      if (r.w > rv.w - 8) r.w = Math.max(1, rv.w - 8);
      if (r.x < railGap) r.x = Math.max(0, Math.min(railGap, rv.w - r.w - 8));
      if (r.x + r.w > rv.w - 8) r.x = Math.max(0, rv.w - r.w - 8);
    }
    const prev = item.lastRect;
    if (!force && prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h) return;
    item.lastRect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const s = item.ui.win.style;
    s.left = r.x + 'px';
    s.top = r.y + 'px';
    s.width = r.w + 'px';
    s.height = r.h + 'px';
    applyToolbarDock(item, r);
    if (item.imageMode) renderImageZoom(item);
  }
  function renderZoom(item) {
    if (item.imageMode) { renderImageZoom(item); return; }
    const f = item.ui.frame;
    f.style.width = (100 / item.zoom) + '%';
    f.style.height = (100 / item.zoom) + '%';
    f.style.transform = `scale(${item.zoom})`;
    item.ui.zoomLabel.textContent = Math.round(item.zoom * 100) + '%';
  }
  function renderTitle(item) {
    const title = item.title || item.fallbackTitle || '网页预览';
    const box = item.ui.title;
    const list = (settings.favicon && !item.imageMode) ? faviconCandidates(item.url) : [];
    let img = box.firstElementChild;
    if (list.length) {
      if (!img || img.tagName !== 'IMG') {
        box.textContent = '';
        img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.dataset.ldpLadder = '0';
        // 三级兜底：站点自己的 favicon → DuckDuckGo → favicon.im
        img.addEventListener('error', () => {
          const arr = img.__ldpList || [];
          const next = Number(img.dataset.ldpLadder || 0) + 1;
          if (next < arr.length) {
            img.dataset.ldpLadder = String(next);
            img.style.display = '';
            img.setAttribute('src', arr[next]);
          } else {
            img.style.display = 'none';
          }
        });
        box.appendChild(img);
        box.appendChild(document.createElement('span'));
      }
      img.__ldpList = list;
      if (img.getAttribute('src') !== list[0]) {
        img.style.display = '';
        img.dataset.ldpLadder = '0';
        img.setAttribute('src', list[0]);
      }
    } else if (img) {
      img.remove();
      img = null;
    }
    let span = box.querySelector('span');
    if (!span) { span = document.createElement('span'); box.appendChild(span); }
    if (span.textContent !== title) span.textContent = title;
    const domain = item.ui && item.ui.domain;
    if (domain) {
      let host = '';
      try {
        const u = new window.URL(item.originalUrl || item.url || '');
        host = String(u.hostname || '').replace(/^www\./i, '');
      } catch (e) { host = ''; }
      domain.textContent = host;
      domain.hidden = !host || !!item.bare;
      domain.title = host;
    }
    box.title = title + (item.url ? '\n' + item.url : '');
  }
  function applySettings(updateBridge) {
    if (!shell) return;
    renderTheme(true);
    if (updateBridge) for (const w of windows) sendInit(w);
    syncStack();
  }

  /* ---- 画中画布局 ---------------------------------------------------------------- */
  function layoutPips() {
    if (!shell) return;
    const pips = windows.filter(isEffPip);
    if (!pips.length) return;   // 没有画中画，无需改写任何窗口几何
    const v = viewport(), gap = 10, margin = 16;
    const side = settings.pipSide === 'left' ? 'left' : 'right';
    const compact = pips.length >= 2 && settings.pipCompact;
    const barW = clampNum(settings.pipBarWidth, 120, 400, 220, true);
    const upward = settings.pipStack === 'up';
    const sizes = pips.map(p => compact
      ? { w: barW, h: PIP_BAR_H }
      : { w: Math.round(p.rect.w * PIP_SCALE), h: Math.round(p.rect.h * PIP_SCALE) });
    // 指纹去重：布局没变就一个样式都不写
    const fp = sizes.map(s => `${s.w}x${s.h}`).join(',') + `|${side}|${compact}|${upward}|${v.w}x${v.h}|${v.w - (compact ? barW : sizes[0].w) - 2 * margin}`;
    if (fp === layoutPips.fp) return;
    layoutPips.fp = fp;
    let y = upward ? v.h - margin : margin;
    pips.forEach((p, i) => {
      const s = sizes[i];
      const st = p.ui.win.style;
      if (upward) y -= s.h;
      const x = side === 'left' ? margin : (v.w - s.w - margin);
      const wasCompact = p.ui.win.classList.contains('pip-bar');
      if (wasCompact !== compact) p.ui.win.classList.toggle('pip-bar', compact);
      if (compact) {
        if (st.transform !== 'none') st.transform = 'none';
        if (st.width !== barW + 'px') st.width = barW + 'px';
        if (st.height !== PIP_BAR_H + 'px') st.height = PIP_BAR_H + 'px';
      } else {
        if (st.width !== p.rect.w + 'px') st.width = p.rect.w + 'px';
        if (st.height !== p.rect.h + 'px') st.height = p.rect.h + 'px';
        if (st.transformOrigin !== 'top left') st.transformOrigin = 'top left';
        const tr = `scale(${PIP_SCALE})`;
        if (st.transform !== tr) st.transform = tr;
      }
      const lx = x + 'px', ty = y + 'px';
      if (st.left !== lx) st.left = lx;
      if (st.top !== ty) st.top = ty;
      p.lastRect = null;
      if (!upward) y += s.h + gap; else y -= gap;
    });
  }

  /* ---- 智能排列与版式预设 ---------------------------------------------------------- */
  function smartArrange() {
    if (windows.length < 2) return;
    if (arrangeState) {
      exitArrange();
      if (windows.length) toast(windows[windows.length - 1], '已恢复原状');
    } else {
      enterArrange();
      if (windows.length) toast(windows[windows.length - 1], '已智能排列，再次点击恢复');
    }
  }
  function enterArrange() {
    if (windows.length < 2 || arrangeState) return;
    arrangeState = windows.map(w => ({ item: w, rect: Object.assign({}, w.rect), wasPip: w.pip }));
    for (const w of windows) {
      if (!w.pip) continue;
      w.inArrange = true;
      w.ui.win.classList.remove('pip', 'pip-bar');
      w.ui.win.style.transform = 'scale(1)';
      w.ui.win.style.transformOrigin = 'top left';
    }
    layoutPips.fp = '';
    arrangeGrid();
  }
  function arrangeGrid() {
    const v = viewport(), count = windows.length;
    if (!count) return;
    const cols = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / cols), gap = 10, pad = 20;
    const cellW = (v.w - pad * 2 - gap * (cols - 1)) / cols;
    const cellH = (v.h - pad * 2 - gap * (rows - 1)) / rows;
    windows.forEach((item, i) => {
      item.rect = fit({
        x: pad + (i % cols) * (cellW + gap), y: pad + Math.floor(i / cols) * (cellH + gap),
        w: cellW, h: cellH
      });
      renderGeometry(item, true);
    });
    syncStack();
  }
  function exitArrange() {
    if (!arrangeState) return;
    for (const snap of arrangeState) {
      const w = snap.item;
      if (w.closed) continue;
      if (snap.wasPip) {
        w.inArrange = false;
        w.pip = true;
        w.ui.win.classList.add('pip');
        w.ui.win.style.transformOrigin = 'top left';
        w.rect = w.prePipRect ? fit(w.prePipRect) : fit(offsetRect(settings.desktopWidth, settings.desktopHeight));
        w.ui.win.style.transform = `scale(${PIP_SCALE})`;
        w.lastRect = null;
      } else {
        w.rect = fit(snap.rect);
        renderGeometry(w, true);
      }
    }
    arrangeState = null;
    layoutPips.fp = '';
    layoutPips();
    syncStack();
  }
  /** 均分网格：cols 列、按需补行 —— 两列 / 三列 / 等分网格 / 横向并排 / 纵向堆叠全是它的特例 */
  function gridCells(v, n, cols, gap, pad) {
    const g = gap === undefined ? 12 : gap, p = pad === undefined ? 12 : pad;
    const c = clamp(cols, 1, n), r = Math.max(1, Math.ceil(n / c));
    const w = (v.w - p * 2 - g * (c - 1)) / c;
    const h = (v.h - p * 2 - g * (r - 1)) / r;
    return Array.from({ length: n }, (_, i) => ({
      x: p + (i % c) * (w + g), y: p + Math.floor(i / c) * (h + g), w, h
    }));
  }
  const GRID_PRESETS = [
    { id: '2col', label: '两列', fn: (v, n) => gridCells(v, n, 2) },
    { id: '3col', label: '三列', fn: (v, n) => gridCells(v, n, 3) },
    { id: 'main-side', label: '主窗 + 侧栏', fn: (v, n) => {
      if (n < 2) return [{ x: 12, y: 12, w: v.w - 24, h: v.h - 24 }];
      const sideW = Math.max(300, Math.round(v.w * 0.28));
      const mainW = v.w - 24 - 12 - sideW;
      const rest = n - 1;
      const rowH = (v.h - 24 - 12 * (rest - 1)) / rest;
      const out = [{ x: 12, y: 12, w: mainW, h: v.h - 24 }];
      for (let i = 0; i < rest; i++) out.push({ x: 12 + mainW + 12, y: 12 + i * (rowH + 12), w: sideW, h: rowH });
      return out;
    } },
    { id: 'row', label: '横向并排', fn: (v, n) => gridCells(v, n, n) },
    { id: 'col', label: '纵向堆叠', fn: (v, n) => gridCells(v, n, 1) },
    { id: 'grid', label: '等分网格', fn: (v, n) => gridCells(v, n, Math.ceil(Math.sqrt(n))) },
    { id: 'stack', label: '层叠（错位）', fn: (v, n) => {
      const w = Math.min(v.w - 60, 980), h = Math.min(v.h - 60, 720);
      return Array.from({ length: n }, (_, i) => ({ x: 24 + i * 26, y: 24 + i * 26, w, h }));
    } }
  ];
  function applyGridPreset(id) {
    const preset = GRID_PRESETS.find(p => p.id === id);
    if (!preset || windows.length < 2) return;
    if (arrangeState) exitArrange();
    const list = windows.slice();
    const cells = preset.fn(viewport(), list.length);
    list.forEach((item, i) => {
      const c = cells[i] || cells[cells.length - 1];
      item.pip = false;
      item.inArrange = false;
      item.ui.win.classList.remove('pip', 'pip-bar');
      if (item.ui.pipBtn) item.ui.pipBtn.classList.remove('selected');
      item.rect = fit(c);
      item.lastRect = null;
      renderGeometry(item, true);
    });
    layoutPips.fp = '';
    syncStack();
    if (list.length) toast(list[list.length - 1], '已套用版式：' + preset.label);
  }

  /* ---- 多窗口同步滚动 -------------------------------------------------------------- */
  function scrollRatio() {
    const doc = document.scrollingElement || document.documentElement;
    if (!doc) return 0;
    const max = doc.scrollHeight - window.innerHeight;
    return max > 0 ? clamp(doc.scrollTop / max, 0, 1) : 0;
  }
  function toggleSyncScroll(force) {
    const want = force === undefined ? !settings.syncScroll : !!force;
    updateSetting(null, 'syncScroll', want);
    if (want) {
      syncSource = windows[windows.length - 1] || null;
      if (windows.length) toast(windows[windows.length - 1], '同步滚动已开：滚动任意预览窗口，其余窗口按比例跟随');
    } else {
      syncSource = null;
      if (windows.length) toast(windows[windows.length - 1], '同步滚动已关');
    }
  }
  // 注意：开/关时不广播当前比例 —— 宿主页面多半是锁定滚动的（ratio 恒为 0），
  // 开关瞬间广播会把所有预览窗口一巴掌拍回顶部。同步从「开启后的第一次滚动」开始。
  // v19.1：onScrollSourceChanged（焦点切换换主窗口 + 提示）已随「谁滚动谁就是源」的新语义删除
  function gatherFrames() {
    const list = [];
    for (const w of windows) {
      if (w.closed || w.imageMode) continue;
      try {
        const f = w.ui.frame.contentWindow;
        if (f && f !== window) list.push(f);
      } catch (e) { /* 忽略 */ }
    }
    return list;
  }
  function broadcast(payload) {
    for (const f of gatherFrames()) {
      try { f.postMessage(Object.assign({ channel: CHANNEL }, payload), '*'); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---- 预览内查找（同源页面） ------------------------------------------------------ */
  /** 取预览 iframe 的文档：跨域时 contentDocument 为空，个别浏览器还会抛错 → 统一兜底 null */
  function frameDoc(item) {
    if (!item || item.closed) return null;
    try { return item.ui.frame.contentDocument || null; } catch (e) { return null; }
  }
  function frameWin(item) {
    if (!item || item.closed) return null;
    try { return item.ui.frame.contentWindow || null; } catch (e) { return null; }
  }
  function clearFind(item) {
    const doc = frameDoc(item);
    if (doc) {
      try {
        doc.querySelectorAll('mark[data-ldp-find]').forEach(m => {
          const parent = m.parentNode;
          if (!parent) return;
          parent.replaceChild(doc.createTextNode(m.textContent), m);
          parent.normalize();
        });
      } catch (e) { /* 忽略 */ }
    }
    if (item.findNodes) item.findNodes.length = 0;
    if (item.findState) item.findState.idx = -1;
  }
  function collectTextNodes(root, out, limit) {
    if (!root || out.length >= limit) return;
    // NodeFilter 写成 window.NodeFilter：避免编辑器报「未定义变量」（下同）
    const NF = window.NodeFilter;
    const walker = root.ownerDocument.createTreeWalker(root, NF.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NF.FILTER_REJECT;
        const p = node.parentNode;
        if (!p) return NF.FILTER_REJECT;
        const tag = (p.localName || '').toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'textarea') return NF.FILTER_REJECT;
        if (p.closest && p.closest('mark[data-ldp-find]')) return NF.FILTER_REJECT;
        return NF.FILTER_ACCEPT;
      }
    });
    let n = walker.nextNode();
    while (n && out.length < limit) {
      out.push(n);
      n = walker.nextNode();
    }
  }
  function wrapMatch(doc, node, idx, len) {
    try {
      const mark = doc.createElement('mark');
      mark.setAttribute('data-ldp-find', '1');
      mark.style.cssText = 'background:#ffe066;color:#111;border-radius:2px;padding:0 1px';
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + len);
      range.surroundContents(mark);
      return mark;
    } catch (e) { return null; }   // 跨节点边界等情况直接跳过
  }
  /**
   * 预览内查找。同一文本节点里的多处匹配会全部高亮（从后往前逐处包裹，避免包裹后
   * 偏移失效），包裹完成后按文档顺序重排，计数与「上一个 / 下一个」才是页面里的真实顺序。
   */
  function doFind(item, query, opts) {
    const doc = frameDoc(item);
    if (!doc) { showFindHint(item, '该页面跨域，无法在预览内查找（可点“新标签页”打开后查找）'); updateFindLabel(item); return 0; }
    clearFind(item);
    const q = String(query || '');
    if (!q) { showFindHint(item, ''); updateFindLabel(item); return 0; }
    const caseSensitive = !!(opts && opts.case);
    const wholeWord = !!(opts && opts.word);
    const needle = caseSensitive ? q : q.toLowerCase();
    const nodes = [];
    collectTextNodes(doc.body || doc.documentElement, nodes, MAX_FIND_NODES);
    const found = [];
    let capped = false;
    for (const node of nodes) {
      if (found.length >= MAX_FIND) { capped = true; break; }
      const text = node.nodeValue || '';
      if (!text) continue;
      const hay = caseSensitive ? text : text.toLowerCase();
      let cursor = hay.length;
      let guard = 0;
      while (found.length < MAX_FIND && guard++ <= MAX_FIND + 8) {
        const idx = hay.lastIndexOf(needle, cursor - 1);
        if (idx < 0) break;
        cursor = idx;   // 下一轮从 idx 之前继续找，位置严格向前
        if (wholeWord && !wordBounded(text, idx, needle.length)) continue;
        const mark = wrapMatch(doc, node, idx, needle.length);
        if (mark) found.push(mark);
        // lastIndexOf 的 position 是「起始位置」，传 -1 会被夹到 0，于是行首匹配会被反复命中
        if (idx === 0) break;
      }
    }
    if (found.length > 1) {
      try { found.sort((a, b) => ((a.compareDocumentPosition(b) & 4) ? -1 : 1)); } catch (e) { /* 忽略 */ }
    }
    item.findNodes = found;
    item.findState = { idx: -1, query: q, case: caseSensitive, word: wholeWord };
    if (found.length) {
      stepFind(item, 1);
      showFindHint(item, capped ? '匹配过多，只高亮前 ' + found.length + ' 处' : '');
    } else {
      showFindHint(item, '没有匹配项');
      updateFindLabel(item);
    }
    return found.length;
  }
  function stepFind(item, dir) {
    const found = item.findNodes || [];
    const st = item.findState;
    if (!found.length || !st) { updateFindLabel(item); return; }
    st.idx = (st.idx + dir + found.length) % found.length;
    // 只有「当前高亮项」变了才写样式：匹配上千处时，这一步才是大头
    for (let i = 0; i < found.length; i++) {
      const m = found[i];
      const on = i === st.idx;
      if (m.getAttribute('data-ldp-cur') === (on ? '1' : '0')) continue;
      m.setAttribute('data-ldp-cur', on ? '1' : '0');
      m.style.background = on ? '#ff9f1c' : '#ffe066';
      m.style.outline = on ? '2px solid #ff9f1c' : 'none';
    }
    const target = found[st.idx];
    try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    catch (e) { try { target.scrollIntoView(); } catch (e2) { /* 忽略 */ } }
    updateFindLabel(item);
  }
  function updateFindLabel(item) {
    if (!item.ui.findLabel) return;
    const found = item.findNodes || [];
    const st = item.findState;
    item.ui.findLabel.textContent = found.length ? `${(st ? st.idx : 0) + 1}/${found.length}` : '0/0';
  }
  function showFindHint(item, text) {
    if (!item.ui.findHint) return;
    item.ui.findHint.textContent = text || '';
    item.ui.findHint.hidden = !text;
  }
  function findOptions(item) {
    return {
      case: !!(item.ui.findCase && item.ui.findCase.checked),
      word: !!(item.ui.findWord && item.ui.findWord.checked)
    };
  }
  /**
   * 查找栏默认永远是关的：只有点搜索按钮 / 快捷键 / 手动开启才会出现
   * （旧版写成 hidden = !settings.findBar，于是开着查找功能就等于每个窗口一出现就顶着一条查找栏）。
   */
  function toggleFindBar(item, force) {
    if (!item || item.closed) return;
    if (!settings.findBar) { toast(item, '查找栏已在设置中关闭'); return; }
    const show = force === undefined ? item.ui.findBar.hidden : !!force;
    if (!show) {
      clearFind(item);
      item.ui.findBar.hidden = true;
      showFindHint(item, '');
      return;
    }
    item.ui.findBar.hidden = false;
    showFindHint(item, '');
    setTimeout(() => {
      if (item.closed || item.ui.findBar.hidden) return;
      try { item.ui.findInput.focus(); item.ui.findInput.select(); } catch (e) { /* 忽略 */ }
    }, 0);
  }

  /* ==================================================================================
   *  §13 生命周期与动画
   * ================================================================================== */
  function createUI(item) {
    if (!shell) return;
    const node = shell.root.getElementById('ldp-win-tpl').content.cloneNode(true);
    const win = node.querySelector('.window');
    const $ = s => win.querySelector(s);
    item.panelMode = null;
    item.ui = {
      win, header: $('.header'), title: $('.title'), domain: $('.domain'), content: $('.content'), frame: $('iframe'),
      shield: $('.shield'), loader: $('.loader'), hint: $('.hint'), hintText: $('.hint-text'),
      hintAct: $('.hint-act'),
      toolbar: $('.toolbar'), panel: $('.panel'), toast: $('.toast'), zoomLabel: $('.zoom-label'),
      themeBtn: $('[data-action="theme"]'), fdBtn: $('[data-action="forceDark"]'),
      pipBtn: $('[data-action="pip"]'), arrangeBtn: $('[data-action="arrange"]'),
      readerTools: Array.from(win.querySelectorAll('.reader-tool')),
      speakBtn: $('[data-action="speak"]'), aiBtn: $('[data-action="ai"]'),
      gridBtn: $('[data-action="grid"]'),
      progressBar: $('.progress-bar'),
      findBar: $('.findbar'), findInput: $('.fb-input'), findLabel: $('.fb-label'),
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
    }
    item.ui.findBar.hidden = true;   // 查找栏永远默认关闭
    // 空壳窗口（使用说明 / 设置）没有 iframe，而窗口外壳是透明的，必须补一层底色
    if (item.bare) win.classList.add('bare');
    syncReaderTools(item);
    // 强制暗色：v19.1 起设置里的全局开关决定新窗口的初始状态（此前是无任何效果的死设置）
    item.ui.fdBtn.classList.toggle('selected', !!item.forceDark);
    if (item.forceDark) applyForceDark(item);
    item.ui.gridBtn.hidden = windows.length < 2;
    win.__ldpItem = item;   // 便于扩展 / 调试时从 DOM 反查窗口记录
    shell.root.append(win);

    win.addEventListener('mousedown', () => focusWindow(item), true);
    win.addEventListener('click', event => {
      // Controls must win over the PiP "click anywhere to restore" shortcut.
      // Otherwise close/pin/reload/new-tab buttons in a PiP header just toggled
      // PiP and the requested action never ran.  Walk composedPath(): with a
      // closed shadow root the retargeted event.target can be the shadow host.
      const path = event.composedPath ? event.composedPath() : [];
      const control = path.find(n => n && n.nodeType === 1 && n.dataset && n.dataset.action);
      const arrow = path.find(n => n && n.nodeType === 1 && n.dataset && n.dataset.step);
      if (arrow) { stepNumber(item, arrow); return; }
      if (control) { handleAction(item, control.dataset.action); return; }
      if (isEffPip(item)) { togglePip(item); return; }
      const inPanel = path.some(n => n && n.nodeType === 1 && n.classList && n.classList.contains('panel'));
      if (inPanel) return;      // 面板内部点击不关闭面板
      if (!item.ui.panel.hidden) closePanel(item, true);
    });
    // 面板打开时遮罩挡住 iframe，点击遮罩即关闭面板
    item.ui.shield.addEventListener('mousedown', event => {
      if (gesture || item.ui.panel.hidden) return;
      event.preventDefault();
      closePanel(item, true);
    });
    item.ui.header.addEventListener('mousedown', event => {
      if (event.target.closest('button') || isEffPip(item)) return;
      startGesture(item, event, '');
    });
    item.ui.header.addEventListener('dblclick', event => {
      if (event.target.closest('button') || isEffPip(item)) return;
      if (settings.dblClick === 'maximize') toggleMaximize(item);
      else if (settings.dblClick === 'center') centerWindow(item);
    });
    win.querySelectorAll('.resize').forEach(handle => {
      handle.addEventListener('mousedown', event => {
        if (isEffPip(item)) return;
        startGesture(item, event, handle.dataset.direction);
      });
    });
    const panel = item.ui.panel;
    panel.addEventListener('change', event => {
      const input = event.target;
      if (!input.matches('[data-setting]')) return;
      if (input.type === 'number') saveNumber(item, input, true);
      else updateSetting(item, input.dataset.setting, input.type === 'checkbox' ? input.checked : input.value);
    });
    panel.addEventListener('focusout', event => {
      if (event.target.matches('input[type="number"][data-setting]')) saveNumber(item, event.target, true);
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') return;
      if (event.key === 'Enter' && event.target.matches('input[type="number"][data-setting]')) {
        event.preventDefault();
        saveNumber(item, event.target, true);
        event.target.blur();
      }
    });
    item.ui.frame.addEventListener('load', () => onFrameLoad(item));
    // Ctrl/⌘ + 滚轮缩放（指针在窗口任意位置都可用）
    win.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (item.closed || isEffPip(item)) return;
      event.preventDefault();
      // 图片预览：Ctrl/⌘ + 滚轮缩放图片（以指针为中心），不是网页缩放
      if (item.imageMode) { imageWheelZoom(item, event.deltaY > 0 ? -1 : 1, event); return; }
      // 阅读模式下 Ctrl+滚轮改的是正文字号（阅读排版），不是网页缩放
      if (item.isReaderMode) { adjustReaderFont(item, event.deltaY > 0 ? -1 : 1); return; }
      const step = clampNum(settings.zoomStep, 1, 25, 10, true) / 100;
      const dir = event.deltaY > 0 ? -1 : 1;
      const next = clamp(Math.round((item.zoom + dir * step) * 100) / 100, 0.5, 2);
      if (next === item.zoom) return;
      item.zoom = next;
      renderZoom(item);
      saveLayout(item);
    }, { passive: false });
    // 查找栏交互
    const fb = item.ui.findBar;
    const input = item.ui.findInput;
    let findTimer = 0;
    input.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => doFind(item, input.value, findOptions(item)), 240);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (item.findNodes && item.findNodes.length) stepFind(item, event.shiftKey ? -1 : 1);
        else doFind(item, input.value, findOptions(item));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        toggleFindBar(item, false);
      }
    });
    const rerun = () => { if (input.value) doFind(item, input.value, findOptions(item)); };
    item.ui.findCase.addEventListener('change', rerun);
    item.ui.findWord.addEventListener('change', rerun);
    fb.addEventListener('mousedown', e => e.stopPropagation());
  }

  function copySummaryText(item, text, successMessage) {
    const value = String(text || '').trim();
    if (!value) { toast(item, '还没有可复制的总结'); return false; }
    const ok = T.copy(value);
    toast(item, ok ? (successMessage || '已复制总结') : '复制失败，请手动选择文本');
    return ok;
  }
  function openQuickTextAISummary(value, fallbackTitle, point) {
    const url = httpUrl(value);
    if (!url) { try { toastStandalone('这个链接不是有效网页地址，无法总结'); } catch (e) { /* ignore */ } return null; }
    try {
      const item = openWindow('', fallbackTitle, null, point, { bare: true });
      if (!item) return null;
      item.url = url;
      item.originalUrl = url;
      item.title = String(fallbackTitle || url).slice(0, 180);
      item.textAIState = { url, title: item.title, busy: false };
      item.summaryProtected = true;
      openPanel(item, 'text-ai');
      return item;
    } catch (e) {
      try { toastStandalone('网页总结窗口打开失败：' + (e && e.message ? e.message : '未知错误')); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  function renderTextAISummaryPanel(item) {
    item.panelMode = 'text-ai';
    const body = panelFrame(item, '网页 AI 总结', 'close');
    if (typeof configureSummaryWindow === 'function') configureSummaryWindow(item);
    item.ui.panel.classList.add('text-ai-panel');
    const source = el('p', 'note', item.textAIState && item.textAIState.url ? item.textAIState.url : '');
    const status = el('div', 'video-summary-status', '正在读取网页正文…');
    const out = el('div', 'ai-answer markdown text-ai-answer summary-answer-card');
    const meta = el('div', 'video-summary-meta', '');
    const actions = el('div', 'ai-actions summary-actions');
    const copy = el('button', 'text-button', '复制总结');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = String(item.aiAnswer || out.textContent || '').trim();
      if (!text) { toast(item, '还没有可复制的总结'); return; }
      copySummaryText(item, text, '已复制总结');
    });
    const retry = el('button', 'text-button', '重新总结');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (!item.aiBusy) runAIAction(item, 'summary', '', out, meta, status);
    });
    actions.appendChild(copy); actions.appendChild(retry);
    if (typeof addSummaryAppearance === 'function') addSummaryAppearance(item, actions);
    const scroll = el('div', 'summary-scroll');
    scroll.appendChild(source);
    scroll.appendChild(status);
    scroll.appendChild(out);
    scroll.appendChild(meta);
    body.appendChild(scroll);
    if (typeof buildFollowupBox === 'function') body.appendChild(buildFollowupBox(item));
    body.appendChild(actions);
    item.ui.textAIStatus = status;
    item.ui.textAIOut = out;
    item.ui.textAIMeta = meta;
    runAIAction(item, 'summary', '', out, meta, status);
    setTimeout(() => { if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item); }, 0);
  }

  function isDouyinShareUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      if (!/^https?:$/i.test(url.protocol)) return false;
      return /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(url.hostname)
        && (/\/(?:video|note)\/\d+/i.test(url.pathname) || /^v\.douyin\.com$/i.test(url.hostname));
    } catch (e) { return false; }
  }

  function openQuickAISummary(value, fallbackTitle, point) {
    if (isDouyinShareUrl(value) && typeof openDouyinLinkSummary === 'function') {
      return openDouyinLinkSummary(value, fallbackTitle, point);
    }
    const directMedia = /\.(mp3|m4a|aac|wav|ogg|opus|mp4|webm|mov|mkv|ts|m4s|m3u8)(?:$|\?)/i.test(String(value || ''));
    if (directMedia && typeof openMediaSummaryFromUrl === 'function') return openMediaSummaryFromUrl(value, fallbackTitle, point);
    // A link-side AI button always means "summarize this web page".  Media
    // summaries have their own in-player AI button and must never be selected
    // merely because the page contains a video element.
    const item = openQuickTextAISummary(value, fallbackTitle, point);
    if (!item) { try { toastStandalone('网页总结窗口没有打开，请刷新页面后重试'); } catch (e) { /* ignore */ } }
    return item;
  }
  function openWindow(value, fallbackTitle, parent, point, opts) {
    const o = opts || {};
    const bare = !!o.bare;                      // 空壳窗口：只用来放面板，不加载任何页面
    const imageInfo = (!bare && isObj(o.image)) ? o.image
      : ((!bare && looksLikeImageUrl(value)) ? { url: value, title: fallbackTitle } : null);
    const normalizedImage = imageInfo ? normalizeImageInfo(imageInfo) : null;
    const imageUrl = normalizedImage ? normalizedImage.url : '';
    const url = bare ? '' : (imageUrl || httpUrl(value));
    if (!bare && (!url || isBlacklisted(url))) return null;
    if (!bare && !interactionEnabled()) return null;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', () => openWindow(value, fallbackTitle, parent, point, opts), { once: true });
      return null;
    }
    ensureShell();
    if (!shell) return null;
    // Re-sample the page at the moment a preview opens.  A shell created
    // before the page's styles settled could otherwise keep the light
    // document-start sample on a dark page.
    invalidateThemeSample();
    renderTheme(true);
    finishGesture();
    if (launcher) launcher.hide();
    peekHide(true);   // v20：开完整预览的瞬间收起悬停小窗，两者不并存
    if (!bare) {
      const activePreviews = () => windows.filter(w => !w.closed && !w.bare);
      while (activePreviews().length >= settings.maxWindows) {
        // Never evict a persistent AI summary window here.  Calling closeWindow
        // on a protected summary returns without removing it, which used to
        // turn this while-loop into an infinite loop and made the AI button
        // appear completely dead when a previous summary was open.
        const candidates = activePreviews().filter(w => !w.pinned && !isEffPip(w)
          && !w.summaryProtected && !(w.ui.win && w.ui.win.classList.contains('summary-window')));
        const oldest = candidates[0];
        if (!oldest) {
          toastStandalone('已达到窗口上限（' + settings.maxWindows + ' 个）。请先关闭或取消固定一个预览窗口。');
          return null;
        }
        oldest.summaryCloseRequested = true;
        closeWindow(oldest, true);
      }
    }
    // v21 bugfix: never let an image viewer share the webpage layout slot.
    // Otherwise 400% image zoom / image geometry overwrites the site's normal
    // preview layout (and gets clamped back to 200% when a webpage opens).
    const key = bare ? '' : (imageUrl ? 'image:' + layoutKey(url) : layoutKey(url));
    const saved = settings.remember && key ? layouts[key] : null;
    try { window.__LPS_LAST_OPEN__ = Date.now(); } catch (e) { /* ignore */ }
    const item = {
      id: ++sequence,
      token: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      navSeq: 0,
      url, originalUrl: url, title: '', fallbackTitle: fallbackTitle || '', key,
      rect: fit(offsetRect(
        saved && saved.w ? saved.w : settings.desktopWidth,
        saved && saved.h ? saved.h : settings.desktopHeight,
        saved && Number.isFinite(saved.ox) ? saved.ox : undefined,
        saved && Number.isFinite(saved.oy) ? saved.oy : undefined
      )),
      zoom: imageUrl ? clampNum(saved && saved.zoom, 0.1, 8, 1, false) : clampNum(saved && saved.zoom, 0.5, 2, 1, false),
      // point 是触发坐标（拖拽 / 长按 / Alt+点击 / 浮出按钮都会带上），
      // 打开与关闭动画都以它为原点。（v20.2.1 起不再有「中键」这个来源）
      pinned: false, pip: false, inArrange: false, closed: false, ready: false,
      generation: 0, point, lastNested: null, lastFocus: document.activeElement,
      // v20.3：seenEarly = 骨架屏已经提前撤掉（子框架上报了 dcl）；initPings = 待发的 init 补发定时器
      seenEarly: false, initPings: [],
      isReaderMode: false, readerSource: null, readerDirty: false, readerMode: '', readerUrl: '',
      forceDark: imageUrl ? false : !!settings.forceDark, bare, dockMode: '',
      imageMode: !!imageUrl, imageSourceUrl: '', imageCandidates: [], imageCandidateIndex: 0,
      imageNaturalW: 0, imageNaturalH: 0, imageFitScale: 1, imageLoadTimer: 0,
      synthetic: false, synthUrl: '',
      preReaderRect: null, prePipRect: null, preMaxRect: null, lastRect: null, animation: null,
      toastTimer: 0, loadTimer: 0, pipTransTimer: 0, progressTimer: 0, progressStep: 0,
      findNodes: null, findState: null
    };
    item.rect = spawnRect(item, parent, point);
    windows.push(item);
    createUI(item);
    renderGeometry(item, true);
    renderZoom(item);
    renderTitle(item);
    if (settings.autoFocus) focusWindow(item);
    else syncStack();
    animateWindow(item, true);
    if (bare) {
      // 空壳窗口：iframe 直接不参与（连 about:blank 都不用加载）
      item.isReaderMode = true;
      item.ui.frame.style.display = 'none';
      item.ui.loader.hidden = true;
      item.ui.progressBar.style.width = '0';
    } else if (item.imageMode) {
      pauseBackgroundVideos();
      addToHistory(url, (imageInfo && imageInfo.title) || fallbackTitle);
      setupImageViewer(item, imageInfo || { url: url, title: fallbackTitle });
    } else {
      pauseBackgroundVideos();
      addToHistory(url, fallbackTitle);
      navigate(item, url);
    }
    if (arrangeState) {
      arrangeState.push({ item, rect: Object.assign({}, item.rect), wasPip: false });
      arrangeGrid();
    }
    scheduleSessionSave();
    return item;
  }
  function cancelRequests(item) {
    for (const [id, req] of requests) {
      if (req.item !== item) continue;
      clearTimeout(req.timer);
      requests.delete(id);
      req.resolve(null);
    }
  }
  function closeWindow(item, silent) {
    stopReaderSpeech(item);
    stopAIPort(item);
    if (!item || item.closed) return;
    // Summary panels are page-side companions.  Only an explicit close action
    // may remove them; outside clicks / focus changes must not close them.
    if (item.summaryProtected && item.ui && item.ui.win && item.ui.win.classList.contains('summary-window') && !item.summaryCloseRequested) return;
    if (typeof cleanupMediaResources === 'function') cleanupMediaResources(item);
    if (gesture && gesture.item === item) finishGesture();
    saveLayout(item);
    item.closed = true;
    item.generation++;
    cancelRequests(item);
    clearInitPings(item);
    clearTimeout(item.loadTimer);
    clearTimeout(item.toastTimer);
    clearTimeout(item.pipTransTimer);
    clearTimeout(item.progressTimer);
    clearTimeout(item.imageLoadTimer);
    if (item.readerUrl) { try { window.URL.revokeObjectURL(item.readerUrl); } catch (e) { /* 忽略 */ } item.readerUrl = ''; }
    if (item.synthUrl) { try { window.URL.revokeObjectURL(item.synthUrl); } catch (e) { /* 忽略 */ } item.synthUrl = ''; }
    const index = windows.indexOf(item);
    if (index >= 0) windows.splice(index, 1);
    for (const w of windows) if (!w.closed && w.ui && w.ui.gridBtn) w.ui.gridBtn.hidden = windows.length < 2;
    if (arrangeState) {
      arrangeState = arrangeState.filter(s => s.item !== item);
      if (windows.length >= 2) arrangeGrid();
      else exitArrange();
    }
    // 会话恢复 / 排列进行中不要归位，避免打断正在批量摆放的布局
    if (windows.length === 1 && !restoringSession && !arrangeState) {
      const last = windows[0];
      if (!isEffPip(last) && !last.isReaderMode && !last.preMaxRect) {
        last.rect = defaultRect();
        last.lastRect = null;
        renderGeometry(last, true);
      }
    }
    item.ui.win.style.pointerEvents = 'none';
    try { item.ui.frame.src = 'about:blank'; } catch (e) { /* 忽略 */ }
    layoutPips.fp = '';
    layoutPips();
    syncStack();
    // 关掉最后一个窗口是关键节点：必须立刻同步落盘把 closed 标记写进去，
    // 不能走可能被推迟的 idle 回调（用户关完就跳转的话标记会丢，下次又自动弹回来）。
    if (windows.some(w => !w.closed && !w.bare)) scheduleSessionSave();
    else flushSessionNow(!item.bare);
    if (!windows.length && !restoringSession) resumeBackgroundVideos();
    if (silent) {
      item.ui.win.remove();
    } else {
      const animation = animateWindow(item, false);
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
      } else remove();
    }
    const remaining = windows[windows.length - 1];
    if (remaining) focusWindow(remaining);
    else { try { if (item.lastFocus && item.lastFocus.isConnected) item.lastFocus.focus(); } catch (e) { /* 忽略 */ } }
  }
  function centerWindow(item, save) {
    item.rect = fit(offsetRect(item.rect.w, item.rect.h));
    item.lastRect = null;
    renderGeometry(item, true);
    if (save !== false) saveLayout(item);
  }
  function toggleMaximize(item) {
    if (!item || item.closed || item.pip || item.isReaderMode) return;
    const v = viewport();
    if (item.preMaxRect) {
      item.rect = fit(item.preMaxRect);
      item.preMaxRect = null;
    } else {
      item.preMaxRect = Object.assign({}, item.rect);
      item.rect = fit({ x: 0, y: 0, w: v.w, h: v.h }, 2);
    }
    item.lastRect = null;
    renderGeometry(item, true);
    saveLayout(item);
  }

  /* ---- 动画 ----------------------------------------------------------------------
     v17：动画原点锚定到触发点。
     触发坐标一直存在 item.point 里，但旧版动画完全没用它，transform-origin 固定
     top left —— 于是窗口永远从自己的左上角冒出来，和「我拖的那个地方」毫无关系。
     现在按触发点在窗口内的相对位置算出原点百分比：
       · 触发点在窗口内   → 原地从该点长出来（观感克制）；
       · 触发点在窗口外   → 缩放会连带位移，窗口从那个方向「飞」进来 / 退回去，
                           正是「从我拖的地方弹出来、关闭时又回到那里」。
     百分比夹在 -120% ~ 220%：方向仍然正确，同时把长距离位移收敛在可控范围内。 */
  function effAnim(kind) {
    if (settings.unifyAnim) return settings.unifiedAnim || 'spring';
    if (kind === 'open') return settings.animation;
    if (kind === 'close') return settings.closeAnimation;
    return settings.pipAnimation;
  }
  function animateWindow(item, opening) {
    const win = item.ui.win;
    if (item.animation) { try { item.animation.cancel(); } catch (e) { /* 忽略 */ } item.animation = null; }
    const type = opening ? effAnim('open') : effAnim('close');
    const range = RANGES[opening ? 'duration' : 'closeDuration'];
    const duration = clampNum(opening ? settings.duration : settings.closeDuration, range[0], range[1], 0, true);
    if (type === 'none' || !duration || !win.animate) return null;
    const pipNow = isEffPip(item);
    // 画中画窗口的 transform 被 layoutPips 占用（scale = PIP_SCALE），动画再写 transform
    // 会让它先弹回 scale(1) 再缩回去 —— 这类窗口只做淡入淡出。
    let frames, easing;
    if (pipNow) {
      frames = opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
      easing = type === 'apple' ? EASE_APPLE : EASE_SPRING;
    } else {
      const p = item.point;
      let origin = 'top left';
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        const r = item.rect;
        const ox = r.w > 0 ? (p.x - r.x) / r.w * 100 : 50;
        const oy = r.h > 0 ? (p.y - r.y) / r.h * 100 : 50;
        origin = clamp(ox, -120, 220).toFixed(1) + '% ' + clamp(oy, -120, 220).toFixed(1) + '%';
      }
      if (win.style.transformOrigin !== origin) win.style.transformOrigin = origin;
      /* v19.1 透明度与缩放分离编排（Web Animations 逐帧 easing/offset）：
         · 打开：opacity 在前 ~45% 就位 —— 窗口先「显形」，缩放全程走完。
           transform 只在首尾两个关键帧出现，因此首帧的 easing 作用于整段缩放；
           opacity 用首两帧（0 → 0.45）插值，同一曲线但只走 45% 时长。
         · 关闭：opacity 保持到最后 ~45% 才淡出 —— 先收缩、后消失，
           窗口是「回到拖拽点」而不是原地变没。苹果线性用加速吸入（EASE_SINK），
           物理回弹用预备动作（EASE_ANTIC：先微鼓一下再吸走）。 */
      if (opening) {
        const openEase = type === 'apple' ? EASE_APPLE : EASE_SPRING;
        const from = type === 'apple'
          ? { opacity: 0, transform: `scale(${APPLE_FROM_SCALE})` }
          : { opacity: 0, transform: SPRING_FROM };
        const to = type === 'apple'
          ? { opacity: 1, transform: 'scale(1)' }
          : { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' };
        frames = [
          Object.assign({ easing: openEase }, from),
          { opacity: 1, offset: 0.45 },
          to
        ];
      } else {
        const sink = type === 'apple' ? EASE_SINK : EASE_ANTIC;
        const start = type === 'apple' ? 'scale(1)' : 'translate3d(0,0,0) scale(1)';
        const end = type === 'apple' ? `scale(${APPLE_FROM_SCALE})` : SPRING_FROM;
        frames = [
          { opacity: 1, transform: start, easing: sink },
          { opacity: 1, offset: 0.55, easing: 'ease-in' },
          { opacity: 0, transform: end }
        ];
      }
      easing = type === 'apple' ? EASE_APPLE : EASE_SPRING;
    }
    let animation;
    try { animation = win.animate(frames, { duration, easing, fill: 'none' }); }
    catch (e) { return null; }
    item.animation = animation;
    const done = () => {
      if (item.animation !== animation) return;
      item.animation = null;
      // 动画结束把原点交还给布局（画中画与排列都以 top left 为缩放原点）
      if (!item.pip && win.style.transformOrigin !== 'top left') win.style.transformOrigin = 'top left';
    };
    animation.finished.then(done, done);
    return animation;
  }
  function pipTransition(item, dur, easing) {
    const s = item.ui.win.style;
    s.transition = dur > 0
      ? `transform ${dur}ms ${easing},left ${dur}ms ${easing},top ${dur}ms ${easing},width ${dur}ms ${easing},height ${dur}ms ${easing}`
      : 'none';
    if (dur > 0) {
      clearTimeout(item.pipTransTimer);
      item.pipTransTimer = setTimeout(() => { if (!item.closed) item.ui.win.style.transition = 'none'; }, dur + 60);
    }
  }
  /** 画中画开关（几何在 layoutPips 里算，这里只改状态与过渡） */
  function togglePip(item) {
    if (item.closed) return;
    const dur = clampNum(settings.pipDuration, 0, 2000, 0, true);
    const animType = effAnim('pip');
    const useAnim = animType !== 'none' && dur > 0;
    const easing = animType === 'apple' ? EASE_APPLE : EASE_SPRING;
    const win = item.ui.win;
    win.style.transition = 'none';
    win.getBoundingClientRect();   // 读一次布局强制重排：transition:none 必须先落地
    layoutPips.fp = '';
    if (item.pip) {
      item.pip = false;
      item.inArrange = false;
      win.classList.remove('pip', 'pip-bar');
      item.ui.pipBtn.classList.remove('selected');
      if (item.prePipRect) { item.rect = fit(item.prePipRect); item.prePipRect = null; }
      if (useAnim) pipTransition(item, dur, easing);
      win.style.transform = 'scale(1)';
      win.style.transformOrigin = 'top left';
      win.style.width = item.rect.w + 'px';
      win.style.height = item.rect.h + 'px';
      item.lastRect = null;
      renderGeometry(item, true);
      layoutPips();
      syncStack();
      if (useAnim) setTimeout(() => { if (!item.closed) { layoutPips.fp = ''; layoutPips(); } }, dur + 20);
    } else {
      if (item.animation) { try { item.animation.cancel(); } catch (e) { /* 忽略 */ } item.animation = null; }
      item.prePipRect = Object.assign({}, item.rect);
      item.pip = true;
      win.classList.add('pip');
      item.ui.pipBtn.classList.add('selected');
      win.style.transformOrigin = 'top left';
      win.style.transform = `scale(${PIP_SCALE})`;
      layoutPips();
      syncStack();
      if (useAnim) pipTransition(item, dur, easing);
    }
  }

  /* ---- 与子框架通信 ---------------------------------------------------------------- */
  function sendInit(item) {
    if (item.closed) return;
    try {
      item.ui.frame.contentWindow.postMessage({
        channel: CHANNEL, type: 'init', token: item.token, navSeq: item.navSeq,
        threshold: settings.threshold, longPressOpen: settings.longPressOpen,
        altClickOpen: settings.altClickOpen, longPressDelay: settings.longPressDelay,
        dragHold: settings.dragHold,
        // 把「界面玻璃磨砂」与「统一圆角」下发给子框架，让预览窗里的浮出按钮
        // 与宿主侧共用同一份玻璃配方与圆角（否则宿主关掉磨砂、窗内按钮还是磨砂的）
        glass: settings.glassBlur, radius: settings.radius,
        linkButton: settings.linkButton, imageDragPreview: settings.imageDragPreview !== false,
        blacklist: settings.blacklist || '', warmup: settings.warmup !== false,
        dark: getEffectiveDark()
      }, '*');
    } catch (e) { /* 跨域 / 未就绪 */ }
  }
  function acceptInfo(item, data) {
    const url = httpUrl(data && data.url);
    if (!url) return false;
    if (item.url !== url) item.fallbackTitle = '';
    item.url = url;
    // v21 bugfix: previews can navigate inside their iframe.  Keeping the
    // original URL forever made reader mode / snapshot / "open in new tab"
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
  }
  /* v20.3：清掉还没发的 init 补发定时器（关窗 / 换页 / 子框架已应答时）。 */
  function clearInitPings(item) {
    if (!item.initPings || !item.initPings.length) return;
    for (const t of item.initPings) clearTimeout(t);
    item.initPings.length = 0;
  }
  /**
   * v20.3：提前撤掉骨架屏。子框架在自身 DOMContentLoaded 时上报 stage='dcl' ——
   * 那一刻 HTML 已经解析完、首屏内容开始上屏（图片字体还在路上）。直接开新标签页
   * 看到的就是这种「边加载边显示」；预览窗以前要憋到整个 load 完成（所有图片、字体、
   * 脚本全部到齐）才一次性掀开，而 iframe 的网络优先级又天生低于标签页导航，
   * 于是表现为「转圈转半天，最后一次性全出来」。现在 dcl 一到就掀开，
   * 加载条停在 88%，等真正的 load 再收 100%。幂等：只生效一次。
   */
  function revealEarly(item) {
    if (item.closed || item.seenEarly || item.isReaderMode || item.imageMode || item.bare) return;
    item.seenEarly = true;
    item.ui.loader.hidden = true;
    if (item.progressTimer) { clearTimeout(item.progressTimer); item.progressTimer = 0; }
    item.ui.progressBar.style.width = '88%';
  }
  function navigate(item, url) {
    if (item && item.imageMode) return;
    item.generation++;
    item.navSeq = (Number(item.navSeq) || 0) + 1;
    item.ready = false;
    item.seenEarly = false;
    item.title = '';
    item.url = url;
    if (httpUrl(url)) item.originalUrl = httpUrl(url);
    item.isReaderMode = false;
    item.readerSource = null;
    // v20：从快照回到正常嵌入 —— 恢复完整 sandbox（快照模式会临时收掉 allow-scripts /
    // allow-same-origin），并清掉旧的 blob
    if (item.synthetic) {
      item.synthetic = false;
      if (item.synthUrl) { try { window.URL.revokeObjectURL(item.synthUrl); } catch (e) { /* 忽略 */ } item.synthUrl = ''; }
    }
    // Leaving reader/snapshot mode must restore the normal page sandbox.
    if (!item.synthetic) { try { item.ui.frame.setAttribute('sandbox', FULL_SANDBOX); } catch (e) { /* 忽略 */ } }
    cancelRequests(item);
    clearInitPings(item);
    clearTimeout(item.loadTimer);
    clearTimeout(item.progressTimer);
    item.ui.loader.hidden = false;
    item.ui.hint.hidden = true;
    renderTitle(item);
    if (item.findNodes && item.findNodes.length) clearFind(item);
    try { item.ui.frame.src = url; } catch (e) { /* 忽略 */ }
    const gen = item.generation;
    /* v20.3：补发 init。原来 init 只在 iframe 完整 load 之后才发一次 —— 那太晚了：
       子框架要收到 init 才会 enable、才会把自身的加载阶段（dcl）报上来。现在设完 src
       就按 INIT_PING_MS 的节奏补发，子框架一应答（ready）就停。 */
    for (const ms of INIT_PING_MS) {
      item.initPings.push(setTimeout(() => {
        if (item.closed || gen !== item.generation || item.ready) return;
        sendInit(item);
      }, ms));
    }
    // 渐进式进度：iframe 拿不到真实进度，用 15 → 45 → 70 → 86 的节奏给点反馈，
    // 真正的 100% 由 onFrameLoad 收尾（v20.3：dcl 提前掀开时会停在 88%）
    const steps = [15, 45, 70, 86];
    item.progressStep = 0;
    item.ui.progressBar.style.width = steps[0] + '%';
    const tick = () => {
      item.progressTimer = 0;
      if (item.closed || gen !== item.generation) return;
      item.progressStep++;
      if (item.progressStep >= steps.length) return;
      item.ui.progressBar.style.width = steps[item.progressStep] + '%';
      item.progressTimer = setTimeout(tick, 260 + item.progressStep * 180);
    };
    item.progressTimer = setTimeout(tick, 260);
    item.loadTimer = setTimeout(() => {
      if (item.closed || gen !== item.generation) return;
      item.ui.loader.hidden = true;
      item.ui.progressBar.style.width = '100%';
      hint(item, '页面加载较慢。若长时间空白，可以直接在新标签页打开。', HINT_OPEN_TAB);
    }, READY_TIMEOUT);
  }
  function requestInfo(item) {
    if (item.closed) return Promise.resolve(null);
    try {
      const fw = frameWin(item);
      const doc = frameDoc(item);
      const url = fw ? fw.location.href : '';
      if (doc && url && httpUrl(url)) return Promise.resolve({ url, title: pageTitle(doc) });
    } catch (e) { /* 跨域：走 postMessage */ }
    sendInit(item);
    return new Promise(resolve => {
      const id = `${item.id}-${++sequence}-${Date.now()}`;
      const timer = setTimeout(() => { requests.delete(id); resolve(null); }, INFO_TIMEOUT);
      requests.set(id, { item, resolve, timer });
      try {
        item.ui.frame.contentWindow.postMessage({ channel: CHANNEL, token: item.token, navSeq: item.navSeq, type: 'request', id, action: 'info' }, '*');
      } catch (e) {
        clearTimeout(timer);
        requests.delete(id);
        resolve(null);
      }
    });
  }
  function onFrameLoad(item) {
    if (item.closed || item.isReaderMode || item.imageMode) return;
    item.generation++;
    const generation = item.generation;
    item.ready = false;
    cancelRequests(item);
    clearInitPings(item);
    clearTimeout(item.loadTimer);
    clearTimeout(item.progressTimer);
    item.ui.loader.hidden = true;
    item.ui.progressBar.style.width = '100%';
    setTimeout(() => { if (!item.closed && item.generation === generation) item.ui.progressBar.style.width = '0'; }, 500);
    // v20：快照（禁止嵌入站点的只读渲染）里没有子框架脚本能应答，也不需要再判断回退
    if (item.synthetic) return;
    sendInit(item);
    // 这里刻意用 Promise 链而不是 async/await：油猴编辑器的语法检查按 esversion 6 走，
    // 脚本整体保持在 ES2017 之前的语法里，那几行就不会被标上感叹号。
    requestInfo(item).then(result => {
      if (item.closed || generation !== item.generation) return;
      if (acceptInfo(item, result)) item.ui.hint.hidden = true;
      else if (settings.embedFallback) {
        // v20：load 已完成但子框架毫无应答 —— 正常嵌入的页面无论同源跨域都能应答
        //（脚本在子框架 document-start 就跑了），基本可以断定是被
        // X-Frame-Options / CSP frame-ancestors 拒了。自动改抓只读快照。
        item.ui.hint.hidden = true;
        renderSnapshot(item);
      }
      else if (!item.ready) hint(item, '无法读取此页信息：该页面可能禁止被嵌入，或子框架脚本被站点 CSP 拦截。', HINT_OPEN_TAB);
    });
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (!isObj(data) || data.channel !== CHANNEL) return;
    // v21 security: every token-bearing message must come from the exact
    // preview iframe AND carry that item's token.  The old code handled
    // innerScroll/sync/stage before token validation and even exposed an
    // unauthenticated ldpSelect entry point; any page script could forge them.
    // The page can still see its own token (postMessage limitation), but it can
    // no longer reach the host without matching a live iframe source, and the
    // free-form ldpSelect opener has been removed entirely.
    const item = windows.find(w => !w.closed && w.ui.frame.contentWindow === event.source);
    if (!item || data.token !== item.token) return;
    // Messages from an old document can arrive after navigate()/reload.  The
    // child echoes the navigation sequence; drop anything from a prior page so
    // it cannot overwrite the new URL/title or clear the new init pings.
    if (Number(data.navSeq) !== Number(item.navSeq)) return;
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
    }
    if (data.type === 'ready') {
      item.ready = true;
      clearInitPings(item);
      if (acceptInfo(item, data)) item.ui.hint.hidden = true;
      /* v20.3：这里不再撤骨架屏 —— ready 在 document-start 就能到（init 现在设完 src
         就开始补发），那一刻页面多半还是空白。真正的「可以看了」以子框架上报的
         dcl 为准（见上面的 stage 分支与 revealEarly），load 事件兜底。 */
      return;
    }
    if (data.type === 'focus') { focusWindow(item); return; }
    if (data.type === 'escape') { escapeWindow(item); return; }
    if (data.type === 'openImage') {
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
      const url = httpUrl(data.url);
      if (!url || !allowNestedOpen(item)) return;
      const now = performance.now();
      if (item.lastNested && item.lastNested.url === url && now - item.lastNested.time < 700) return;
      item.lastNested = { url, time: now };
      const bounds = item.ui.frame.getBoundingClientRect();
      const nx = Number.isFinite(data.nx) ? clamp(data.nx, 0, 1) : 0.5;
      const ny = Number.isFinite(data.ny) ? clamp(data.ny, 0, 1) : 0.5;
      const zoom = item.zoom || 1;
      const v = viewport();
      const point = {
        x: clamp(bounds.left + nx * bounds.width * zoom, 40, Math.max(40, v.w - 40)),
        y: clamp(bounds.top + ny * bounds.height * zoom, 40, Math.max(40, v.h - 40))
      };
      openWindow(url, isStr(data.title) ? data.title.slice(0, 300) : '', item, point);
      return;
    }
    if (data.type === 'response' && isStr(data.id)) {
      const req = requests.get(data.id);
      if (!req || req.item !== item) return;
      clearTimeout(req.timer);
      requests.delete(data.id);
      req.resolve({ url: isStr(data.url) ? data.url : '', title: isStr(data.title) ? data.title.slice(0, 500) : '' });
    }
  });

  /* ==================================================================================
   *  §14 面板与设置
   * ================================================================================== */
  function closePanel(item, commit) {
    // A running summary must survive a panel close: the user may reopen it,
    // and the stream keeps writing into state.answer either way.
    detachAIPort(item);
    if (!item || item.closed || item.ui.panel.hidden) return;
    // A persistent AI summary must never be reduced to an empty window shell
    // by an outside panel close.  Its X button uses closeWindow explicitly.
    if (item.summaryProtected || (item.ui.win && item.ui.win.classList.contains('summary-window'))) return;
    if (commit !== false && item.panelMode === 'settings') commitNumbers(item);
    item.ui.panel.hidden = true;
    item.panelMode = null;
    if (!gesture) item.ui.shield.hidden = true;
  }
  function openPanel(item, mode) {
    if (mode === 'settings') renderSettings(item);
    else if (mode === 'help') showHelpIn(item);
    else if (mode === 'grid') showGridMenu(item);
    else if (mode === 'sessions') showSessions(item);
    else if (mode === 'readerOutline') renderReaderOutline(item);
    else if (mode === 'readerExport') renderReaderExport(item);
    else if (mode === 'ai') renderAIPanel(item);
    else if (mode === 'video') renderVideoSummaryPanel(item);
    else if (mode === 'media') renderMediaSummaryPanel(item);
    else if (mode === 'text-ai') renderTextAISummaryPanel(item);
    else showHistory(item);
    if (window.LinkDragI18N && item.ui && item.ui.panel) window.LinkDragI18N.localizeTree(item.ui.panel);
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  /** 面板统一骨架：吸顶头（标题 + 关闭）+ 滚动体。返回滚动体，调用方只管往里塞内容。 */
  function panelFrame(item, title, closeAction) {
    const panel = item.ui.panel;
    panel.classList.remove('settings-panel');
    panel.classList.remove('ai-panel');
    // The panel is rebuilt on every render (including each streaming tick).
    // Drop the previous outline/listeners first: leftover TOC nodes used to
    // stack on top of the new answer and swallow clicks meant for it.
    if (item._tocScroll) {
      try { item._tocScrollTarget && item._tocScrollTarget.removeEventListener('scroll', item._tocScroll); } catch (e) { /* ignore */ }
      item._tocScroll = null;
      item._tocScrollTarget = null;
    }
    try {
      panel.querySelectorAll('.summary-toc').forEach(node => node.remove());
    } catch (e) { /* ignore */ }
    panel.textContent = '';
    const head = el('div', 'panel-head');
    const close = el('button', 'btn panel-close');
    close.type = 'button';
    close.dataset.action = closeAction || 'closePanel';
    close.title = '关闭面板';
    close.setAttribute('aria-label', '关闭面板');
    close.innerHTML = icon('close');
    head.appendChild(el('h3', '', title));
    head.appendChild(close);
    const body = el('div', 'panel-body');
    panel.appendChild(head);
    panel.appendChild(body);
    return body;
  }
  /** 设置面板底部的动作区：按语义分组，每组一行等宽网格 */
  const SETTINGS_ACTIONS = [
    { title: '主题', items: [['retheme', '重新取色']] },
    { title: '设置数据', items: [['exportSettings', '导出设置'], ['importSettings', '导入设置'], ['defaults', '恢复默认']] },
    { title: '窗口与会话', items: [['saveSession', '记住当前窗口'], ['restoreSession', '恢复上次窗口'], ['sessions', '会话管理']] },
    { title: '记录', items: [['clearLayouts', '清空布局'], ['clearHistory', '清空历史']] },
    { title: '帮助', items: [['help', '使用说明']] }
  ];
  function actionGroupsHtml(groups) {
    return '<div class="panel-actions">' + groups.map(g =>
      `<div class="pa-group"><h4>${g.title}</h4><div class="pa-buttons">${
        g.items.map(([action, label]) => `<button class="text-button" data-action="${action}">${label}</button>`).join('')
      }</div></div>`).join('') + '</div>';
  }
  /* [分组标题] 或 [字段名, 标签, 控件类型, 选项, 占位符]
     控件类型：checkbox / select / text / number（number 的量程取自 RANGES） */
  const FIELDS = [
    ['常规'],
    ['language', '界面语言', 'select', [['zh-CN', '简体中文'], ['en', 'English']]],
    ['动画与外观'],
    ['unifyAnim', '统一设置所有动画', 'checkbox'],
    ['unifiedAnim', '统一动画样式', 'select', ANIM_CHOICES],
    ['animation', '打开动画', 'select', ANIM_CHOICES],
    ['duration', '打开动画时长', 'number'],
    ['closeAnimation', '关闭动画', 'select', ANIM_CHOICES],
    ['closeDuration', '关闭动画时长', 'number'],
    ['pipAnimation', '画中画动画', 'select', ANIM_CHOICES],
    ['pipDuration', '画中画动画时长', 'number'],
    ['theme', '界面颜色', 'select', [['auto', '自动取色'], ['light', '强制日间'], ['dark', '强制夜间']]],
    ['themeSource', '取色依据', 'select', [['smart', '智能（页面+系统）'], ['page', '只看页面颜色'], ['scheme', '只看 color-scheme'], ['system', '只看系统偏好']]],
    ['themeFollow', '跟随页面主题变化', 'checkbox'],
    ['pageTint', '色调跟随网页已停用：自动取色只决定日间/夜间界面', 'note'],
    ['blur', '背景毛玻璃', 'checkbox'],
    ['blurAmount', '背景柔化强度(px)', 'number'],
    ['glassBlur', '界面玻璃磨砂(px)', 'number'],
    ['windowOpacity', '窗口不透明度%', 'number'],
    ['radius', '统一圆角(px)', 'number'],
    ['窗口行为'],
    ['spawnMode', '新窗口出现位置', 'select', [['default', '固定默认位置（不跟鼠标）'], ['cursor', '跟随指针 / 手势'], ['cascade', '依次错位铺开']]],
    ['dblClick', '双击标题栏', 'select', [['center', '回到中心'], ['maximize', '最大化 / 还原'], ['none', '不做任何事']]],
    ['remember', '记忆布局', 'checkbox'],
    ['grouping', '布局记忆范围', 'select', [['site', '同域名(推荐)'], ['section', '同栏目/一级目录'], ['page', '精确页面(完整路径)']]],
    ['lockScroll', '锁定背景滚动', 'checkbox'], ['lockScrollWhenPip', '画中画时也锁滚动', 'checkbox'],
    ['pauseVideos', '暂停背景视频', 'checkbox'], ['backdropClose', '点击背景关闭', 'checkbox'],
    ['escapeClose', 'Esc关闭', 'checkbox'], ['snapEnabled', '边缘磁吸', 'checkbox'],
    ['sessionMemory', '记住每个站点的窗口组合', 'checkbox'],
    ['sessionAuto', '刷新后自动恢复窗口', 'checkbox'],
    ['syncScroll', '多窗口同步滚动', 'checkbox'],
    ['gridMenu', '排列版式菜单', 'checkbox'],
    ['findBar', '启用预览内查找（按需唤出）', 'checkbox'],
    ['pipEnabled', '画中画', 'checkbox'], ['maxWindows', '最大窗口数', 'number'],
    ['pipSide', '画中画停靠侧', 'select', [['right', '右侧'], ['left', '左侧']]],
    ['pipStack', '画中画排列方向', 'select', [['down', '从上到下'], ['up', '从下到上']]],
    ['pipCompact', '多画中画标题小条', 'checkbox'],
    ['pipBarWidth', '标题条宽度', 'number'],
    ['阅读模式'],
    ['phoneMode', '手机模式(窄屏)', 'checkbox'],
    ['phoneWidth', '阅读宽度', 'number'],
    ['readerFontSize', '正文字号', 'number'],
    ['readerLineHeight', '正文行高%', 'number'],
    ['readerHideImages', '阅读模式隐藏图片', 'checkbox'],
    ['触发方式'],
    ['shortcuts', '启用快捷键', 'checkbox'],
    ['longPressOpen', '长按弹出', 'checkbox'], ['longPressDelay', '长按时长', 'number'],
    ['altClickOpen', 'Alt+点击', 'checkbox'], ['linkButton', '链接旁浮出按钮', 'checkbox'],
    ['hoverPeek', '悬停预览小窗', 'checkbox'], ['hoverDelay', '悬停预览延迟(ms)', 'number'],
    ['imageDragPreview', '拖拽图片时预览高清原图', 'checkbox'],
    ['peekVideo', '小窗内视频', 'select', [
      ['block', '实时页面 · 拒绝自动播放（推荐）'],
      ['snapshot', '静音快照（绝对无声）'],
      ['allow', '实时页面 · 不干预（交给页面）']
    ]],
    ['peekVideoNote', '小窗无法远程静音（跨域），标题条上的喇叭按钮可一键停声', 'note'],
    ['threshold', '拖拽阈值(px)', 'number'], ['dragHold', '拖拽按住时长(ms)', 'number'],
    ['warmup', '拖拽时预热链接', 'checkbox'],
    ['快捷 AI'],
    ['aiQuick', '链接旁 AI 总结按钮', 'checkbox'],
    ['videoAI', '视频旁 AI 总结按钮', 'checkbox'],
    ['aiQuickWhitelist', 'AI 白名单（当前页面域名）', 'text'],
    ['aiQuickBlacklist', 'AI 黑名单（当前页面域名）', 'text'],
    ['总结窗口'],
    ['summaryDock', '贴边位置', 'select', [['right', '右侧贴边'], ['left', '左侧贴边']]],
    ['summaryOpacity', '透明度(%)', 'number'],
    ['summaryFontSize', '总结文字字号(px)', 'number'],
    ['captureRate', '后台音轨捕获倍速', 'number'],
    ['扩展集成'],
    ['enabled', '在网页中启用 LinkDrag', 'checkbox'],
    ['disabledSites', '暂停站点（逗号分隔）', 'text', null, '例如 example.com, news.site'],
    ['contextMenu', '右键菜单「预览此链接」', 'checkbox'],
    ['badgeCount', '工具栏图标显示窗口数', 'checkbox'],
    ['extensionNote', '暂停站点会立即收起本站自动入口；设置/说明窗口仍可打开，便于重新启用', 'note'],
    ['高级'],
    ['shortcutsMap', '快捷键设置', 'text', null, '组合=动作，逗号分隔'],
    ['autoFocus', '打开时自动聚焦窗口', 'checkbox'],
    ['favicon', '标题栏显示网站图标', 'checkbox'],
    ['blacklist', '黑名单', 'text'], ['forceDark', '强制暗色滤镜', 'checkbox'],
    ['embedFallback', '禁止嵌入的站点自动改用抓取快照', 'checkbox'],
    ['默认尺寸'],
    ['desktopWidth', '宽度', 'number'], ['desktopHeight', '高度', 'number'],
    ['offsetX', '水平偏移%', 'number'], ['offsetY', '垂直偏移%', 'number']
  ];
  function controlHtml(name, type, options, placeholder) {
    if (type === 'select') {
      return `<select data-setting="${name}">${options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
    }
    if (type === 'checkbox') return `<input type="checkbox" data-setting="${name}">`;
    if (type === 'text') {
      const wide = name === 'shortcutsMap' || name === 'disabledSites';
      return `<input type="text" data-setting="${name}" style="width:${wide ? 200 : 140}px;padding:5px;border:1px solid var(--border);border-radius:var(--r-chip);background:var(--surface);color:var(--text)" placeholder="${placeholder || '逗号分隔域名'}">`;
    }
    const [min, max, step] = RANGES[name] || [0, 9999, 1];
    return `<div class="number-control"><input type="number" min="${min}" max="${max}" step="${step}" data-setting="${name}"><div class="number-arrows"><button type="button" data-step="${step}" data-number="${name}" title="增加">▲</button><button type="button" data-step="${-step}" data-number="${name}" title="减少">▼</button></div></div>`;
  }
  function domainEditorHtml(name, label) {
    const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const values = String(settings[name] || '').split(/[\s,，]+/).filter(Boolean);
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
    const activeKeySaved = !!String((aiConfig.apiKeys && aiConfig.apiKeys[activeProvider.id])
      || (aiConfig.provider === activeProvider.id ? aiConfig.apiKey : '') || '').trim();
    const mediaKeySaved = !!String(aiConfig.mediaApiKey || (aiConfig.apiKeys && aiConfig.apiKeys.siliconflow) || '').trim();
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
          <div class="settings-ai-field"><span>API Key <small>只保存在扩展存储；页面脚本无法读取</small></span><div class="settings-ai-inline"><input type="password" data-ai-key="apiKey" value="" placeholder="${activeKeySaved ? '已保存，留空保持不变' : 'sk-...'}" autocomplete="new-password"><button type="button" class="text-button" data-action="testAIKey">测试</button></div><div class="settings-ai-note">${activeKeySaved ? '已保存 Key；要更换请直接输入新 Key，清除请到「选项与诊断」页。' : '尚未配置 Key；本地 Ollama 可留空。'}</div></div>
          <div class="settings-ai-field"><span>媒体总结 API Key <small>硅基流动 · 单独配置与测试</small></span><div class="settings-ai-inline"><input type="password" data-ai-key="mediaApiKey" value="" placeholder="${mediaKeySaved ? '已保存，留空保持不变' : '填写硅基流动 API Key'}" autocomplete="new-password"><button type="button" class="text-button" data-action="testMediaKey">测试</button></div><div class="settings-ai-note">${mediaKeySaved ? '已保存媒体 Key；要更换请直接输入新 Key。' : '尚未配置媒体 Key。'}</div></div>
          <div class="settings-ai-field"><span>媒体总结模型 <small>音频转写模型</small></span><input type="text" data-ai-key="mediaModel" list="mediaModelOptions" value="${String(aiConfig.mediaModel || 'FunAudioLLM/SenseVoiceSmall').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="FunAudioLLM/SenseVoiceSmall" autocomplete="off"><datalist id="mediaModelOptions"><option value="FunAudioLLM/SenseVoiceSmall"></option><option value="TeleAI/TeleSpeechASR"></option></datalist><div class="settings-ai-model-row"><input type="text" class="settings-ai-model-search" data-media-model-search placeholder="搜索媒体模型…" autocomplete="off" hidden><button type="button" class="text-button" data-action="listMediaModels">拉取媒体模型</button></div><div class="settings-ai-model-status" data-media-model-status></div><div class="settings-ai-model-list" data-media-model-list hidden></div></div>
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
        value = value.replace(/^\*\./, '');
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
        const savedProvider = (aiConfig.providerConfigs && aiConfig.providerConfigs[provider.id]) || {};
        const endpoint = body.querySelector('[data-ai-key="endpoint"]');
        if (endpoint) endpoint.value = savedProvider.endpoint
          || (aiConfig.provider === provider.id ? aiConfig.endpoint : '')
          || provider.endpoint;
        const nextModel = (aiConfig.selectedModels && aiConfig.selectedModels[provider.id])
          || savedProvider.model
          || (aiConfig.provider === provider.id ? aiConfig.model : '')
          || provider.model;
        const model = body.querySelector('[data-ai-key="model"]');
        if (model) {
          if (model.tagName === 'SELECT') {
            const input = document.createElement('input');
            input.type = 'text';
            input.dataset.aiKey = 'model';
            input.value = nextModel;
            input.autocomplete = 'off';
            model.replaceWith(input);
          } else {
            model.value = nextModel;
          }
        }
        const key = body.querySelector('[data-ai-key="apiKey"]');
        if (key) {
          // Never inject the stored secret into page-controlled DOM.
          key.value = '';
          key.placeholder = savedAIKey(provider.id) ? '已保存，留空保持不变' : 'sk-...';
        }
        const status = body.querySelector('[data-ai-model-status]');
        if (status) status.textContent = savedAIKey(provider.id)
          ? '已切换服务商，已保存的 Key 可继续使用'
          : '已切换服务商，请填写 Key 后拉取模型';
      });
    });
  }
  function showHistory(item) {
    item.panelMode = 'history';
    const body = panelFrame(item, '预览历史');
    const list = el('div');
    list.style.cssText = 'max-height:250px;overflow:auto';
    if (history.length) {
      for (const h of history) {
        const row = el('div', 'history-item');
        row.title = h.url;
        row.appendChild(el('span', '', h.title || h.url));
        row.addEventListener('click', () => {
          closePanel(item, false);
          openWindow(h.url, h.title || '');
        });
        list.appendChild(row);
      }
    } else {
      list.appendChild(el('p', 'note', '暂无历史'));
    }
    body.appendChild(list);
    body.appendChild(buttonRow('<button class="text-button" data-action="settings">打开设置</button><button class="text-button" data-action="clearHistory">清空</button>', '14px'));
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  /** 会话管理：列出所有站点保存过的窗口组合，可单独恢复或删除 */
  function showSessions(item) {
    item.panelMode = 'sessions';
    const body = panelFrame(item, '会话管理');
    const list = el('div');
    list.style.cssText = 'max-height:280px;overflow:auto';
    const entries = Object.keys(sessions)
      .map(key => ({ key, rec: sessions[key] }))
      .filter(e => e.rec && Array.isArray(e.rec.list) && e.rec.list.length)
      .sort((a, b) => ((b.rec && b.rec.time) || 0) - ((a.rec && a.rec.time) || 0));
    if (!entries.length) {
      list.appendChild(el('p', 'note', '还没有保存过窗口组合。开几个预览窗口就会自动记住，也可以点下面的「记住当前窗口」。'));
    }
    for (const { key, rec } of entries) {
      const row = el('div', 'history-item');
      const when = rec.time ? new Date(rec.time).toLocaleString() : '';
      row.appendChild(el('span', '', String(key).replace(/^https?:\/\//, '') + '（' + rec.list.length + ' 个窗口'
        + (when ? '，' + when : '') + (rec.closed ? '，已关闭' : '') + '）'));
      row.title = rec.list.map(r => r && r.url).filter(Boolean).join('\n');
      const go = el('button', 'text-button', key === sessionKey() ? '恢复' : '换站恢复');
      go.type = 'button';
      go.addEventListener('click', () => {
        closePanel(item, false);
        restoreSession(item, { session: rec, confirm: false });
      });
      const del = el('button', 'text-button', '删除');
      del.type = 'button';
      del.addEventListener('click', () => {
        delete sessions[key];
        writeStore(SESSIONS_KEY, sessions);
        showSessions(item);
      });
      row.appendChild(go);
      row.appendChild(del);
      list.appendChild(row);
    }
    body.appendChild(list);
    body.appendChild(buttonRow('<button class="text-button" data-action="saveSession">记住当前窗口</button><button class="text-button" data-action="settings">打开设置</button>', '14px'));
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function showGridMenu(item) {
    item.panelMode = 'grid';
    const body = panelFrame(item, '排列版式（' + windows.length + ' 个窗口）');
    for (const preset of GRID_PRESETS) {
      const row = el('div', 'row');
      row.style.margin = '6px 0';
      row.appendChild(el('span', '', preset.label));
      const btn = el('button', 'text-button', '套用');
      btn.type = 'button';
      btn.addEventListener('click', () => { closePanel(item, false); applyGridPreset(preset.id); });
      row.appendChild(btn);
      body.appendChild(row);
    }
    body.appendChild(el('p', 'note', '套用后可直接拖动窗口微调；关掉再开不会影响布局记忆。'));
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }

  /* ---- 设置写入 ------------------------------------------------------------------- */
  function applyUiLanguage(item) {
    const I = window.LinkDragI18N;
    if (!I) return;
    try {
      I.setLanguage(settings.language, false);
      if (shell && shell.root) I.localizeTree(shell.root);
      for (const w of windows) {
        if (!w || w.closed || !w.ui || !w.ui.win) continue;
        I.localizeTree(w.ui.win);
      }
      if (item && !item.closed && item.ui && item.ui.panel && item.panelMode === 'settings') {
        renderSettings(item);
        I.localizeTree(item.ui.panel);
      }
    } catch (e) { /* ignore */ }
  }
  function updateSetting(item, name, value) {
    if (!(name in DEFAULTS)) return;
    if (settings[name] === value) return;
    settings[name] = value;
    normalizeSettings();
    writeStore(SETTINGS_KEY, settings);
    if (name === 'syncScroll') {
      // 同 toggleSyncScroll：不在开关时广播比例（宿主页锁定滚动时会把窗口拍回顶部）
    }
    if (name === 'findBar' && !settings.findBar) {
      // 关掉「预览内查找」时顺手收起已经打开的查找栏
      for (const w of windows) if (!w.closed && !w.ui.findBar.hidden) toggleFindBar(w, false);
    }
    // v19.1：强制暗色滤镜立即生效 —— settings.forceDark 此前是「定义了但没人读」的
    // 死设置，勾了什么都不发生。现在勾选当场对全部已开窗口上/摘滤镜，新窗口也以它为初始值。
    if (name === 'forceDark') {
      let applied = 0;
      for (const w of windows) {
        if (w.closed || !w.ui || w.imageMode) continue;
        w.forceDark = !!settings.forceDark;
        if (w.ui.fdBtn) w.ui.fdBtn.classList.toggle('selected', w.forceDark);
        applyForceDark(w);
        applied++;
      }
      if (item && !item.closed) {
        toast(item, settings.forceDark
          ? '强制暗色已应用到全部 ' + applied + ' 个窗口'
          : '已取消全部窗口的强制暗色');
      }
    }
    if (name === 'shortcutsMap') refreshShortcuts();
    if (name === 'hoverPeek' && !settings.hoverPeek) peekHide(true);   // v20：关掉就立刻收摊
    if (name === 'peekVideo') {
      // 换档：把新策略写到 iframe 上，并卸掉当前文档 —— 下一次悬停就会按新策略重新加载。
      // 静音快照缓存不清：缓存里存的都是「已清洗」的 HTML，任何档位下都仍然有效。
      peekMuted = false;
      peekNoteHide();
      if (peekEl && peekEl.isConnected) {
        const pf = peekEl.querySelector('.peek-frame');
        if (pf) {
          pf.setAttribute('allow', peekAllowValue());
          pf.setAttribute('sandbox', peekSandboxValue());
        }
        peekMutePaint();
      }
      peekStopFrame();
    }
    if (name === 'favicon') for (const w of windows) if (!w.closed) renderTitle(w);
    if (name === 'enabled' || name === 'disabledSites') applyPageEnableState(true);
    if (name === 'language') applyUiLanguage(item);
    const themeKeys = ['theme', 'themeSource', 'themeFollow', 'pageTint'];
    if (themeKeys.indexOf(name) >= 0) {
      invalidateThemeSample();
      if (name === 'theme' || name === 'themeFollow') syncThemeObserver();
    }
    // 需要下发给子框架的字段：触发参数 + 材质参数（玻璃磨砂 / 统一圆角）
    const bridgeKeys = ['threshold', 'longPressOpen', 'altClickOpen', 'longPressDelay',
      'dragHold', 'linkButton', 'glassBlur', 'radius', 'blurAmount', 'imageDragPreview'];
    applySettings(bridgeKeys.indexOf(name) >= 0);
    if (name === 'videoAI' && typeof hideVideoAI === 'function') hideVideoAI();
    if ((name === 'summaryDock' || name === 'summaryOpacity') && typeof applySummaryWindow === 'function') {
      for (const w of windows) {
        if (!w.closed && w.ui && w.ui.win && w.ui.win.classList.contains('summary-window')) {
          applySummaryWindow(w, name === 'summaryDock');
        }
      }
    }
    if (((name === 'linkButton' && !settings.linkButton) || name === 'aiQuick' || name === 'videoAI' || name === 'aiQuickWhitelist' || name === 'aiQuickBlacklist') && launcher) launcher.hide();
    // 主题相关选项会改变面板里的可选项与诊断行，重绘一次
    if (themeKeys.indexOf(name) >= 0 && item && !item.closed && !item.ui.panel.hidden && item.panelMode === 'settings') {
      renderSettings(item);
    }
    if (name === 'remember' && !settings.remember) {
      layouts = {};
      writeStore(LAYOUTS_KEY, layouts);
    }
    if (['desktopWidth', 'desktopHeight', 'offsetX', 'offsetY'].indexOf(name) >= 0) {
      for (const w of windows) {
        if (w.closed || w.pip || w.isReaderMode || (!w.pinned && windows.length > 1)) continue;
        w.rect = defaultRect();
        renderGeometry(w);
      }
    }
    if (['pipSide', 'pipStack', 'pipCompact', 'pipBarWidth'].indexOf(name) >= 0) {
      layoutPips.fp = '';
      layoutPips();
    }
    if (name === 'toolbarSide') {
      // 停靠侧变了：几何没变也要按新规则重算一次停靠 class
      for (const w of windows) if (!w.closed) { w.dockMode = ''; renderGeometry(w, true); }
    }
    if (name === 'readerFontSize' || name === 'readerLineHeight') {
      for (const w of windows) if (!w.closed && w.isReaderMode) applyReaderTypography(w);
    }
    if (name === 'unifyAnim' || name === 'unifiedAnim') {
      for (const w of windows) if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
    }
    // 其它窗口 / 当前面板里的同名控件同步刷新
    for (const target of windows) {
      if (target.closed || target === item || target.ui.panel.hidden) continue;
      syncControl(target, name);
    }
    if (item && !item.closed && !item.ui.panel.hidden) syncControl(item, name);
  }
  function syncControl(item, name) {
    const input = item.ui.panel.querySelector(`[data-setting="${name}"]`);
    if (!input) return;
    if (input.type === 'checkbox') input.checked = !!settings[name];
    else input.value = String(settings[name]);
  }
  function saveNumber(item, input, finalize) {
    const name = input.dataset.setting, range = RANGES[name];
    if (!range) return;
    const raw = input.value.trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) { if (finalize) input.value = String(settings[name]); return; }
    const next = clamp(Math.round(value), range[0], range[1]);
    input.value = String(next);   // 立即回写夹紧后的值，避免「填了没生效」
    updateSetting(item, name, next);
  }
  function stepNumber(item, arrow) {
    const name = arrow.dataset.number;
    const input = item.ui.panel.querySelector(`[data-setting="${name}"]`);
    if (!input || !RANGES[name]) return;
    const raw = input.value.trim(), num = Number(raw);
    const current = raw && Number.isFinite(num) ? num : settings[name];
    const step = Number(arrow.dataset.step) || 1;
    const next = clamp(Math.round(current + step), RANGES[name][0], RANGES[name][1]);
    input.value = String(next);
    updateSetting(item, name, next);
  }
  function commitNumbers(item) {
    item.ui.panel.querySelectorAll('input[type="number"][data-setting]').forEach(input => saveNumber(item, input, true));
  }
  function importSettingsInto(item) {
    const finish = text => {
      const raw = String(text || '').trim();
      if (raw) { applyImportedSettings(item, raw); return; }
      let manual = '';
      try { manual = window.prompt('把导出的设置 JSON 粘贴到这里：') || ''; } catch (e) { manual = ''; }
      if (!manual.trim()) { toast(item, '没有读到可导入的内容'); return; }
      applyImportedSettings(item, manual);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(finish, () => finish(''));
        return;
      }
    } catch (e) { /* 落到 prompt */ }
    finish('');
  }
  function applyImportedSettings(item, text) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    const incoming = isObj(data) && isObj(data.settings) ? data.settings : (isObj(data) ? data : null);
    if (!incoming) { toast(item, '导入失败：不是有效的设置 JSON'); return; }
    settings = Object.assign({}, DEFAULTS, incoming);
    normalizeSettings();
    writeStore(SETTINGS_KEY, settings);
    if (isObj(data) && isObj(data.layouts)) { layouts = data.layouts; writeStore(LAYOUTS_KEY, layouts); }
    if (isObj(data) && Array.isArray(data.history)) { history = data.history.slice(0, MAX_HISTORY); writeStore(HISTORY_KEY, history); }
    if (isObj(data) && isObj(data.sessions)) { sessions = data.sessions; writeStore(SESSIONS_KEY, sessions); }
    refreshShortcuts();
    syncThemeObserver();
    invalidateThemeSample();
    applySettings(true);
    applyPageEnableState(false);
    layoutPips.fp = '';
    layoutPips();
    for (const w of windows) if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
    toast(item, '设置已导入');
  }
  /* 页面级提示条：一个窗口都没开时，快捷键 / 拖放反馈需要一个落点。
     v19.2 重写。旧版有三个毛病：
       · 它挂在 document.documentElement 上（影子宿主外面），读不到 --toast 这些令牌，
         颜色是把当时的调色板色值一次性写死进内联样式的 —— 界面换主题它不跟着变；
       · 内联样式里写着 opacity:0!important，随后又用不带 priority 的
         setProperty('opacity','1') 去点灯，两者互相打架；
       · 收不收得回去只靠一个 3.2 秒定时器，一旦时序或优先级出岔子，它就永远贴在
         页面底端（用户报的就是这个）。
     现在：挂进宿主影子根 → 颜色 / 圆角 / 磨砂全走令牌，跟着界面一起变；
     显示 1.6 秒 → 淡出 0.24 秒 → 补 hidden 兜底，双保险。 */
  const STANDALONE_TOAST_MS = 1800;
  const STANDALONE_FADE_MS = 300;
  function toastStandalone(message) {
    if (!document.documentElement) return;
    ensureShell();
    if (!shell || !shell.root) return;
    // 旧版本可能已经在页面里留下一个永远不消失的 #ldp-standalone-toast，顺手清掉
    const stale = document.getElementById('ldp-standalone-toast');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    let box = shell.standaloneToast;
    if (!box || !box.isConnected) {
      box = el('div', 'standalone-toast');
      box.setAttribute('role', 'status');
      box.hidden = true;
      shell.root.append(box);
      shell.standaloneToast = box;
    }
    clearTimeout(box.__ldpHideTimer);
    clearTimeout(box.__ldpGoneTimer);
    box.textContent = message;
    box.hidden = false;
    box.classList.remove('show');
    box.getBoundingClientRect();   // 强制一次重排：先让「隐藏态」落地，过渡才会真的播
    box.classList.add('show');
    box.__ldpHideTimer = setTimeout(() => {
      if (!box.isConnected) return;
      box.classList.remove('show');
      box.__ldpGoneTimer = setTimeout(() => {
        if (!box.isConnected) return;
        box.hidden = true;         // 兜底：就算过渡被别的样式压掉，也一定收干净
        box.textContent = '';
      }, STANDALONE_FADE_MS);
    }, STANDALONE_TOAST_MS);
  }
  function openHelpStandalone() {
    // 旧版用 openWindow(location.href) 再隐藏 iframe：iframe 里其实是把当前页面又完整
    // 加载了一遍（同域名二次请求 + 二次执行脚本）。现在开「空壳窗口」。
    const item = openWindow('about:blank', '使用说明', null, null, { bare: true });
    if (!item) return;
    item.title = '使用说明';
    renderTitle(item);
    showHelpIn(item);
  }
  function openSettingsStandalone() {
    const v = viewport();
    const item = openWindow('', '设置', null, { x: v.w / 2, y: v.h / 2 }, { bare: true });
    if (!item) return;
    item.ui.win.style.visibility = 'hidden';
    item.title = 'LinkDrag 设置';
    item.settingsStandalone = true;
    item.pinned = true;
    item.ui.win.classList.add('settings-standalone');
    item.ui.win.classList.add('pinned');
    item.rect = { x: 0, y: 0, w: v.w, h: v.h };
    item.lastRect = null;
    renderGeometry(item, true);
    renderTitle(item);
    openPanel(item, 'settings');
    requestAnimationFrame(() => { if (!item.closed && item.ui && item.ui.win) item.ui.win.style.visibility = ''; });
    item.ui.win.addEventListener('wheel', event => event.stopPropagation(), { capture: true, passive: true });
    // 设置页自身消费滚轮，避免滚到边缘后把事件传给背后的页面。
    item.ui.panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  }
  /** 使用说明：按主题分组的数据，渲染交给 showHelpIn */
  function helpContent() {
    return [
      ['如何打开预览', [
        '在链接上按住左键拖动 —— 需同时满足「按住时长 ≥ 150ms」与「位移 ≥ 12px」，两个阈值都能在设置 →「触发方式」里调，调大更不容易和划选文字撞车',
        '在链接上长按（默认 500ms）　·　Alt + 点击链接',
        '鼠标中键点击链接**不会**被本脚本接管（下拉刷新/新标签页等浏览器原生行为照旧）—— v20.2.1 起已删除原先「中键直接浮出预览」的行为，中键就是浏览器默认的「后台新标签页打开链接」',
        '鼠标划过链接时旁边会浮出一个小按钮，点它即可',
        'v20：鼠标在链接上停留超过阈值（默认 600ms）会浮出一个迷你预览小窗，先看一眼再决定要不要开完整预览（见下面「悬停迷你预览」）',
        '把链接 / 网址 / 书签拖到页面任意位置（会出现提示层）后松手即预览',
        '预热分两级，但只在「意图明确」时才做：位移过半（确定是在拖）、或在链接上停够 350ms（悬停小窗预热）才真正预取整页（prefetch）；只按下鼠标时仅建连接（preconnect，0 字节）。v20.2.3 起划过链接、按下鼠标都**不再**预取整页 —— 那会让「普通点一下打开链接」也重复下载一遍，反而更慢。不想要预热可在设置里关掉「拖拽时预热链接」',
        'v20.3：预览窗是**渐进显示**的 —— 页面自身的 DOMContentLoaded 一到就撤掉加载动画，内容边加载边显示（和新标签页一样），不再等所有图片字体全部到齐；另外浏览器给 iframe 的网络优先级低于标签页导航、HTTP 缓存也按「顶层站点 × 框架站点」分区（预览和标签页不共享缓存），所以预览天生比直接打开慢一截 —— 这是浏览器的隐私设计，任何脚本都绕不过。先悬停小窗看一眼再点开完整预览是最快的路径（小窗加载过的内容完整预览可以直接复用缓存）'
      ]],
      ['窗口操作', [
        '拖动标题栏移动；拖到屏幕左/右/上边缘会自动半屏或最大化',
        '拖动四角/四边缩放；双击标题栏默认回到中心（可改成「最大化 / 还原」或「不做任何事」）；Ctrl/⌘ + 滚轮缩放页面',
        '标题栏按钮：阅读模式、画中画、强制暗色、主题、固定、刷新、新标签页、关闭',
        '强制暗色有两层：标题栏按钮只管当前窗口；设置 →「强制暗色滤镜」是全局开关，勾选立即对全部已开窗口生效，新窗口也默认带上',
        '工具条会自动换边：窗口贴左边缘时挪到右侧；两侧都放不下才进窗口内，并给正文让出一列，不会盖住文字',
        'Tab / Shift+Tab 在多个预览窗口之间切换焦点；Esc 先关面板再关窗口'
      ]],
      ['新窗口出现在哪里', [
        '设置 →「新窗口出现位置」：默认 = 固定默认位置（默认尺寸 + 偏移），不跟随鼠标；想落在指针处改成「跟随指针 / 手势」，想层叠铺开改成「依次错位」',
        'v17 起，打开动画从「你拖 / 点的那个位置」生长出来，关闭时缩回同一点 —— 无论用哪种出现位置都能看出「它从哪来的」',
        '嵌套预览（在预览窗口里再拖一个链接）始终相对父窗口错位 —— 那是层级关系，不受这一项影响'
      ]],
      ['主题取色', [
        '自动模式下会同时看：页面的 color-scheme 声明、html/body 上的 dark/light 标记、真实背景色（含透明回溯与面积加权）、正文文字颜色、以及系统偏好，谁证据多听谁的',
        '取色依据可选「智能 / 只看页面 / 只看 color-scheme / 只看系统」，取不准时可以手动切',
        '「跟随页面主题变化」打开后，站点自己切夜间模式（或你装了夜间插件）这里会同步跟上',
        'v20.1 起「窗口色调跟随网页」默认开启：窗口底色从网页的真实底色取色相（饱和度封顶 12%），所以深色的彩色网页会配到同色系的深色窗口，不再是中性灰；底色本身接近灰时自动落回中性灰',
        '不想要这个色调就取消勾选「窗口色调跟随网页」，界面立刻回到恒定中性灰（v18 的绝对不偏色）',
        '「取色依据」与色调跟随相互独立：前者决定「判断明暗时听谁的」，后者决定「窗口沾不沾页面的色」',
        '强调色不参与色调跟随的采集（旧版会取 <meta theme-color>、主按钮底色、链接默认色，实际常常把整窗染成纯蓝）',
        '设置面板底部的「主题诊断」会直接写出当前识别结果、依据、页面底色与色调取值，取色不对时先看它'
      ]],
      ['界面质感与外观', [
        'v19 起为极简风：细描边 + 投影 + 一层可调轻磨砂，无棱线 / 无透镜 / 无指针高光 / 无边缘折射（v17–v18 的液态玻璃三件套已按用户要求整体下线）',
        '「背景柔化」只管被预览页面有多糊；「界面玻璃磨砂」只管标题栏 / 工具条 / 面板 / 窗口外框这层界面有多厚，两者互不干扰，窗口外框与内部会一起变',
        '把「界面玻璃磨砂」调成 0 = 切到「降低透明度」：所有界面层变成干净的实心面，只靠细边与投影分层',
        '「窗口不透明度」是整个窗口（含预览页面与其中的视频）一起变淡',
        '「统一圆角」一个滑块派生五级同心圆角，改一处整套 UI 一起变'
      ]],
      ['刷新与记忆', [
        '「记住每个站点的窗口组合」会把当前窗口组合（网址、位置、大小、缩放、固定、画中画）按「布局记忆范围」存下来',
        '「刷新后自动恢复窗口」只在「同一标签页刷新 / 后退重进」时还原 —— 站内跳转、新开标签页、从别的站进来都不会自己弹窗',
        '主动关掉全部预览窗口后，该站点记录会标记为「已关闭」，刷新也不会再弹回来；仍可在「会话管理」里手动找回',
        '想随时手动还原：Alt+Shift+R，或设置面板的「恢复上次窗口 / 会话管理」'
      ]],
      ['画中画 / 排列版式', [
        '多个窗口同时最小化时自动变成标题小条，竖排贴在屏幕边缘；可在设置里改停靠侧、排列方向、标题条宽度、是否启用小条',
        '工具条里的方格按钮可一键套用两列 / 三列 / 主窗+侧栏 / 横向并排 / 纵向堆叠 / 等分网格 / 层叠',
        '「智能排列」按钮在排列与恢复之间切换'
      ]],
      ['预览内查找', [
        '按 Alt+Shift+F（可改）或点工具条搜索图标才会出现 —— 查找栏默认是关的，不会自己弹出来',
        '回车下一个 / Shift+回车上一个；可勾选「Aa」区分大小写、「词」全词匹配；同一段文字里的多处匹配会全部高亮',
        '仅对同源页面有效；跨域页面可以用「新标签页」打开后再查找'
      ]],
      ['图片拖拽高清预览（v21 新增）', [
        '按住图片直接拖动，不再打开缩略网页，而是浮出一个高清图片窗口：直接把图片原文件按原始分辨率加载出来',
        '自动挑选最高清地址：优先 <a> 链接指向的原图、data-full / data-original / data-large 等原图属性、srcset 中最大的候选，最后才回退到当前缩略图；同一张图加载失败会按候选顺序自动换下一个',
        '窗口内双击图片在「适应窗口 / 1:1 原始像素」之间切换；Ctrl/⌘ + 滚轮以指针为中心缩放（10%–800%）；放大后可拖动平移，触控板也可滚动',
        '工具条的放大 / 缩小 / 重置按钮同样可用；「新标签页」打开当前实际加载的图片地址，「复制网址」复制图片地址',
        '图片预览计入窗口数、画中画、版式排列、布局记忆与会话恢复；退出后刷新页面也能恢复同一张图',
        '图片本身被热链保护或需要登录时会加载失败，提示条会给出「在新标签页打开」，可在原站登录后查看；不支持拖拽 CSS 背景图（浏览器不会为背景图派发 dragstart）',
        '也可以直接在图片上右键，选择「用 LinkDrag 查看高清图片」；不想要拖拽行为可在设置 →「触发方式」取消勾选「拖拽图片时预览高清原图」'
      ]],
      ['悬停迷你预览（v20 新增，v20.2 补上声音治理）', [
        '鼠标在链接上停留超过阈值（默认 600ms，设置 →「触发方式」里可调 200–2000ms）会弹出一个比画中画略小的迷你小窗',
        '小窗里是**完整一屏窗口的略缩图**：顶部标题条（标题 · 域名 · favicon），下面是按窗口宽高比缩放后的整屏内容 —— 不含糊、也不是只截左上角',
        '小窗是只读的略缩图：点它（或右上角按钮）即以该链接打开完整预览；移开鼠标、滚动页面、按 Esc、在别处按下鼠标都会收起',
        '停 350ms 就会先预热链接（按下鼠标时也会先建好连接），小窗与随后的完整预览多半命中缓存，明显更快',
        'v20.1：小窗一收起就立刻把 iframe 卸掉（导航到 about:blank），所以「小窗没了视频还在后台响」不会再发生',
        '（v20.2）小窗里的声音管不住 —— 权限策略只管「有没有用户手势」这一关，而浏览器另外两条路是永远放行的：静音自动播放永远允许（站点的「先静音起播再立刻取消静音」就是这么绕过策略的），以及你与该域名互动过、或该域名媒体互动指数够高时直接放行有声播放；更根本的是小窗里的页面是跨域的，脚本拿不到它的 DOM，点不了暂停也调不了音量。所以「静音但继续播」做不到',
        '（v20.2）能做的有三件：① 标题条上的喇叭按钮（一键停声）—— 点一下立即把 iframe 卸掉，一定停声，再点一下恢复；② 设置 →「触发方式」→「小窗内视频」切成「静音快照」—— 小窗改为渲染脚本抓回来的静态快照，其中所有脚本与音视频元素都被删掉，绝对无声（代价：纯 JS 渲染的站点会显示不全）；③ 保持默认的「实时页面 · 拒绝自动播放」，它能挡住脚本无手势的播放，但挡不住上面说的那两条路',
        '不想要就在设置 →「触发方式」里取消勾选「悬停预览小窗」；略缩比例跟随「默认尺寸」设置（desktopWidth × desktopHeight），为控制开销，它只在顶层页面生效（预览窗口内部不嵌套弹小窗，浮出按钮不受影响）'
      ]],
      ['禁止嵌入的站点（v20 新增：抓取快照）', [
        '部分站点用 X-Frame-Options / CSP frame-ancestors 拒绝被任何页面嵌入，预览窗原本只能显示浏览器的错误页',
        'v20 起会自动改用脚本特权抓取该页 HTML，渲染成「只读快照」：排版、样式、图片、链接都照常，但页面自己的脚本不运行 —— 无法登录、点不动页面里的按钮、也没有滚动加载',
        '快照里的链接点击会在新标签页打开；工具条的「刷新」会先重试正常嵌入，仍被拒才重新抓取',
        'v20.2.2：抓不到 / 抓到空壳时，提示条会说清是哪一种情况，并直接给一个「在新标签页打开」的按钮 —— 常见三种：站点拒绝被抓取（提示会带上 HTTP 状态码）、抓取超时、以及「内容由 JavaScript 生成」（快照按设计禁用脚本，所以只剩空壳）',
        '不需要时可在设置 →「高级」里取消勾选「禁止嵌入的站点自动改用抓取快照」'
      ]],
      ['阅读模式', [
        '阅读按钮会抓取并重排正文，支持同源 fetch 与 GM_xmlhttpRequest 两种取文方式',
        '提取引擎按「段落密度 + 链接密度」找正文容器，再做二次净化；结果过短会自动兜底回退，提示条会说明用的是「密度抽取」还是「兜底提取」',
        '设置 →「阅读模式」可调正文字号（12–28px）与行高（120%–260%）；阅读模式下 Ctrl/⌘ + 滚轮直接调字号'
      ]],
      ['同步滚动', [
        '在设置里勾「多窗口同步滚动」，或按 Alt+Shift+S（工具条按钮已按用户要求移除）',
        '开了之后：滚动任意一个预览窗口，其余预览窗口按滚动比例跟随 —— 谁滚动谁就是源，不用先切换焦点',
        '宿主页面（预览背后的原网页）滚动时，所有预览窗口也会按比例跟随'
      ]],
      ['快捷键（可在设置里改）', [
        '默认：Alt+Shift+F 查找　Alt+Shift+S 同步滚动　Alt+Shift+R 恢复上次窗口　Alt+Shift+H 使用说明',
        '　　　Alt+Shift+W 关闭当前窗口　Alt+Shift+Q 关闭全部　Alt+Shift+E 阅读模式　Alt+Shift+P 全部画中画',
        '格式：组合=动作，多个用英文逗号分隔。可用动作名：find / sync / restore / help / settings / sessions / close / closeall / reader / maximize / next / zoomIn / zoomOut / zoomReset / pipall / grand'
      ]],
      ['浏览器扩展增强（v21）', [
        '工具栏图标弹出快捷面板：一键全局启用/停用、暂停当前站点、开关悬停小窗与链接按钮，并显示当前页已开预览数',
        '右键菜单：链接上右键可「用 LinkDrag 预览此链接」；页面空白处右键可直接打开设置或使用说明，选中的网址也能预览',
        '浏览器命令 Alt+Shift+L：暂停 / 恢复当前站点（可在 edge://extensions/shortcuts 或 chrome://extensions/shortcuts 中改键）',
        '工具栏图标上的数字徽标显示当前标签页已打开的预览窗口数，可在设置 →「扩展集成」关闭',
        '扩展使用独立的后台 Service Worker 抓取网页：不受页面 CORS 限制，抓取快照、阅读模式与静音快照比油猴版更可靠；HTTP 状态码与最终重定向地址都会核对',
        '扩展拥有 <all_urls> 主机权限，但仍不能注入 chrome://、edge://、扩展商店、PDF 内置查看器等受保护页面；这些页面请直接打开',
        '如果扩展刚更新/重新加载，已打开的旧标签页不会自动获得新内容脚本：点一下工具栏图标即可按需注入（或刷新页面）',
        '在设置 →「扩展集成」里可以暂停整个扩展或指定域名；暂停只影响自动入口与已开预览，不会修改网页本身'
      ]],
      ['其它', [
        '「导出设置 / 导入设置」会把配置、布局记忆、历史、会话一起复制到剪贴板，换设备直接粘回来',
        '标题栏图标优先取站点自己的 /favicon.ico，取不到才去图标服务兜底，也可以整个关掉',
        '全局开关都在设置面板，改完立即生效'
      ]]
    ];
  }
  function showHelpIn(item) {
    helpOpened = true;
    if (settings.showHelpOnce) updateSetting(null, 'showHelpOnce', false);
    item.panelMode = 'help';
    const body = panelFrame(item, 'LinkDrag 使用说明');
    for (const [title, lines] of helpContent()) {
      body.appendChild(el('h4', '', title));
      const wrap = el('div', 'note');
      for (const line of lines) {
        const p = el('div', '', '· ' + line);
        p.style.margin = '4px 0';
        wrap.appendChild(p);
      }
      body.appendChild(wrap);
    }
    body.appendChild(buttonRow('<button class="text-button" data-action="settings">打开设置</button><button class="text-button" data-action="hideHelp">知道了</button>', '14px'));
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function maybeShowFirstRunHelp(item) {
    if (!settings.showHelpOnce || helpOpened || firstHelpShown || restoringSession) return;
    if (!item || item.closed || !item.ui || !item.ui.panel.hidden) return;
    firstHelpShown = true;
    helpOpened = true;
    showHelpIn(item);
  }

  /* ==================================================================================
   *  §14b 动作分发
   * ================================================================================== */
  function handleAction(item, action) {
    if (item.closed) return;
    focusWindow(item);
    // 面板窗口（使用说明 / 设置）里没有真实网页，和页面相关的动作直接说明一下就好
    if (item.bare && ['reload', 'new', 'url', 'read', 'forceDark', 'pip', 'find'].indexOf(action) >= 0) {
      toast(item, '这是面板窗口，没有对应的网页内容');
      return;
    }
    if (item.imageMode && ['read', 'forceDark', 'find', 'findNext', 'findPrev', 'findClose'].indexOf(action) >= 0) {
      toast(item, '图片预览不支持这个操作');
      return;
    }
    switch (action) {
      case 'close':
        commitNumbers(item);
        item.summaryCloseRequested = true;
        closeWindow(item);
        break;
      case 'pin':
        item.pinned = !item.pinned;
        item.ui.win.classList.toggle('pinned', item.pinned);
        item.ui.win.querySelector('[data-action="pin"]').classList.toggle('selected', item.pinned);
        syncStack();
        break;
      case 'pip':
        if (!settings.pipEnabled) { toast(item, '画中画已在设置中关闭'); break; }
        if (arrangeState) exitArrange();
        togglePip(item);
        break;
      case 'read':
        toggleReaderMode(item);
        break;
      case 'forceDark':
        item.forceDark = !item.forceDark;
        item.ui.fdBtn.classList.toggle('selected', item.forceDark);
        applyForceDark(item);
        break;
      case 'theme':
        updateSetting(item, 'theme', shell && shell.host.dataset.theme === 'dark' ? 'light' : 'dark');
        break;
      case 'new': {
        let url = item.url;
        const fw = frameWin(item);
        if (fw) { try { url = httpUrl(fw.location.href) || url; } catch (e) { /* 跨域用已知地址 */ } }
        if (!T.openInTab(url)) toast(item, '打开新标签页失败');
        break;
      }
      case 'settings':
        if (!item.ui.panel.hidden && item.panelMode === 'settings') closePanel(item, true);
        else openPanel(item, 'settings');
        break;
      case 'saveAI': {
        const read = key => {
          const input = item.ui.panel.querySelector('[data-ai-key="' + key + '"]');
          return input ? String(input.value || '').trim() : '';
        };
        const provider = item.aiProvider || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
        const providerMeta = AI_PROVIDERS.find(p => p.id === provider) || AI_PROVIDERS[0];
        const endpoint = read('endpoint') || providerMeta.endpoint;
        const model = read('model') || providerMeta.model;
        if (!endpoint || !model) { toast(item, '自定义接口必须填写接口地址和模型名'); break; }
        if (!/^https?:\/\//i.test(endpoint)) { toast(item, 'AI 接口地址必须以 http:// 或 https:// 开头'); break; }
        // The page-side input starts empty and never receives the stored key.
        // Blank therefore means "keep the existing secret", not "erase it".
        const typedKey = read('apiKey');
        const apiKey = typedKey || savedAIKey(provider);
        const apiKeys = Object.assign({}, aiConfig.apiKeys || {});
        apiKeys[provider] = apiKey;
        const providerConfigs = Object.assign({}, aiConfig.providerConfigs || {});
        providerConfigs[provider] = { endpoint, model };
        const selectedModels = Object.assign({}, aiConfig.selectedModels || {});
        selectedModels[provider] = model;
        const typedMediaKey = read('mediaApiKey');
        const mediaApiKey = typedMediaKey || savedMediaKey();
        aiConfig = { provider, endpoint, model, apiKey, apiKeys, models: aiConfig.models || {}, providerConfigs, selectedModels, mediaApiKey, mediaModel: read('mediaModel') || aiConfig.mediaModel || DEFAULT_AI_CONFIG.mediaModel, mediaEndpoint: read('mediaEndpoint') || aiConfig.mediaEndpoint || DEFAULT_AI_CONFIG.mediaEndpoint, mediaAudioPrompt: read('mediaAudioPrompt') || aiConfig.mediaAudioPrompt || '', mediaVideoPrompt: read('mediaVideoPrompt') || aiConfig.mediaVideoPrompt || '', summaryPrompt: aiConfig.summaryPrompt || DEFAULT_SUMMARY_PROMPT };
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
        const providerForList = item.aiProvider || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
        const key = get('apiKey') || savedAIKey(providerForList);
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
            const selectedModels = Object.assign({}, aiConfig.selectedModels || {});
            selectedModels[provider] = modelValue;
            aiConfig = Object.assign({}, aiConfig, {
              provider,
              endpoint,
              model: modelValue,
              apiKey: key,
              apiKeys,
              models: Object.assign({}, aiConfig.models || {}, { [provider]: models }),
              providerConfigs,
              selectedModels
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
        const key = get('mediaApiKey') || savedMediaKey();
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
        const key = get('apiKey') || savedAIKey(item.aiProvider || aiConfig.provider);
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
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:testAI', endpoint: get('endpoint'), model: get('model'), apiKey: get('apiKey') || savedAIKey(item.aiProvider || aiConfig.provider) }, res => {
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
          EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:testMediaAI', endpoint: get('mediaEndpoint'), model: get('mediaModel'), apiKey: get('mediaApiKey') || savedMediaKey() }, res => {
            const lastError = (() => { try { return EXT.runtime.lastError; } catch (e) { return null; } })();
            if (lastError || !res) { if (status) status.textContent = '媒体 API Key 测试失败：后台没有响应'; return; }
            if (!res.ok) { if (status) status.textContent = '媒体 API Key 测试失败：' + (res.reason === 'missing-key' ? '请先填写媒体 API Key' : (res.detail || res.reason || '未知错误')); return; }
            if (status) status.textContent = '媒体 API Key 可用 · ' + Number(res.elapsed || 0).toFixed(1) + ' 秒';
            toast(item, '媒体 API Key 测试成功');
          });
        } catch (e) { if (status) status.textContent = '媒体 API Key 测试失败：无法连接后台'; }
        break;
      }
      case 'sessions':
        if (!item.ui.panel.hidden && item.panelMode === 'sessions') closePanel(item, false);
        else openPanel(item, 'sessions');
        break;
      case 'maximize':
        toggleMaximize(item);
        break;
      case 'history':
        if (!item.ui.panel.hidden && item.panelMode === 'history') closePanel(item, false);
        else openPanel(item, 'history');
        break;
      case 'clearHistory':
        history = [];
        writeStore(HISTORY_KEY, history);
        toast(item, '历史已清空');
        if (item.panelMode === 'history') showHistory(item);
        break;
      case 'arrange':
        smartArrange();
        break;
      case 'grid':
        if (!windows.length) break;
        if (!item.ui.panel.hidden && item.panelMode === 'grid') closePanel(item, false);
        else if (windows.length < 2) toast(item, '至少需要 2 个窗口');
        else showGridMenu(item);
        break;
      case 'find':
        if (!item.ui.panel.hidden && item.panelMode === 'settings') closePanel(item, true);
        toggleFindBar(item, item.ui.findBar.hidden);
        break;
      case 'findNext': stepFind(item, 1); break;
      case 'findPrev': stepFind(item, -1); break;
      case 'findClose': toggleFindBar(item, false); break;
      // v19.1：'sync' 工具条按钮已移除（设置面板与 Alt+Shift+S 仍可开关同步滚动）
      case 'ai':
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
        break;
      case 'hideHelp':
      case 'closePanel':
        closePanel(item, action === 'closePanel');
        break;
      case 'saveSession': {
        // 给准确反馈：一个可记住的窗口都没有（只开着设置/说明这类空壳窗口）时说清楚
        const saved = rememberSession();
        toast(item, saved ? '已记住这台设备的窗口组合' : '当前没有可记住的预览窗口');
        break;
      }
      case 'restoreSession':
        restoreSession(item);
        break;
      case 'url': {
        let url = item.url;
        if (!item.imageMode) {
          const fw = frameWin(item);
          if (fw) { try { url = fw.location.href || url; } catch (e) { /* 跨域 */ } }
        }
        toast(item, T.copy(url) ? (item.imageMode ? '已复制图片地址' : '已复制网址') : '复制失败，请手动复制');
        break;
      }
      case 'plus':
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
      }
      case 'resetSize':
        item.rect = defaultRect();
        item.zoom = 1;
        item.lastRect = null;
        renderGeometry(item, true);
        renderZoom(item);
        saveLayout(item);
        break;
      case 'reload': {
        if (item.imageMode) { reloadImageViewer(item); break; }
        const gen = item.generation;
        requestInfo(item).then(result => {
          if (item.closed || item.generation !== gen) return;
          navigate(item, httpUrl(result && result.url) || currentPageUrl(item));
        });
        break;
      }
      case 'hideHint':
        item.ui.hint.hidden = true;
        break;
      /* v20.2.2：提示条上的「在新标签页打开」。
         用 originalUrl 而不是 item.url —— 进过快照/阅读模式的窗口 item.url 可能已经
         变成 blob: 地址，直接开那个地址只会得到一张空白页。 */
      case 'openTab': {
        const tabUrl = currentPageUrl(item) || item.originalUrl || item.url;
        if (tabUrl && !T.openInTab(tabUrl)) toast(item, '打开新标签页失败');
        break;
      }
      case 'clearLayouts':
        layouts = {};
        writeStore(LAYOUTS_KEY, layouts);
        toast(item, '布局已清空');
        break;
      case 'retheme':
        invalidateThemeSample();
        renderTheme(true);
        if (!item.ui.panel.hidden && item.panelMode === 'settings') renderSettings(item);
        toast(item, '已按当前页面重新取色');
        break;
      case 'exportSettings': {
        const payload = JSON.stringify({ type: 'link-preview-settings', version: 17, settings, layouts, history, sessions });
        toast(item, T.copy(payload) ? '设置已复制到剪贴板（含布局/历史/会话）' : '复制失败，请手动复制');
        break;
      }
      case 'importSettings':
        importSettingsInto(item);
        break;
      case 'defaults':
        settings = Object.assign({}, DEFAULTS);
        writeStore(SETTINGS_KEY, settings);
        dirtySettings = false;
        refreshShortcuts();
        syncThemeObserver();
        invalidateThemeSample();
        applySettings(true);
        applyPageEnableState(false);
        layoutPips.fp = '';
        layoutPips();
        for (const w of windows) if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
        toast(item, '已恢复默认');
        break;
    }
  }
  /** 强制暗色滤镜：阅读模式整篇重绘，普通页面直接给 iframe 上滤镜 */
  function applyForceDark(item) {
    if (item.imageMode) return;
    if (item.isReaderMode && item.readerSource) { item.readerDirty = true; renderReaderMode(item); return; }
    try { item.ui.frame.style.filter = item.forceDark ? 'invert(1) hue-rotate(180deg)' : ''; } catch (e) { /* 忽略 */ }
  }

  /* ---- 快捷键 -------------------------------------------------------------------- */
  function topWindow() { return windows[windows.length - 1] || null; }
  function refreshShortcuts() { shortcutsMap = parseShortcuts(settings.shortcutsMap); }
  function runShortcut(action) {
    if (!action) return false;
    const it = topWindow();
    if (action === 'find') { if (!it || it.imageMode) return false; toggleFindBar(it); return true; }
    if (action === 'sync') { if (!windows.length) return false; toggleSyncScroll(); return true; }
    if (action === 'restore') { const n = restoreSession(it); return n > 0 || !windows.length; }
    if (action === 'help') { if (it) openPanel(it, 'help'); else openHelpStandalone(); return true; }
    if (action === 'settings') { if (it) openPanel(it, 'settings'); else openSettingsStandalone(); return true; }
    if (action === 'sessions') { if (!it) { toastStandalone('请先打开一个预览窗口'); return false; } openPanel(it, 'sessions'); return true; }
    if (action === 'close') { if (!it) return false; closeWindow(it); return true; }
    if (action === 'closeall') { for (const w of windows.slice()) closeWindow(w, true); toastStandalone('已关闭全部预览'); return true; }
    if (action === 'reader') { if (!it || it.bare) return false; toggleReaderMode(it); return true; }
    if (action === 'maximize') { if (!it) return false; toggleMaximize(it); return true; }
    if (action === 'next') {
      if (windows.length < 2) return false;
      const idx = windows.findIndex(w => w.ui.win.classList.contains('active'));
      focusWindow(windows[(idx + 1) % windows.length]);
      return true;
    }
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
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
    }
    if (action === 'pipall') {
      if (!windows.length) return false;
      const allPip = windows.every(w => w.pip);
      for (const w of windows) if (allPip === w.pip) togglePip(w);
      return true;
    }
    if (action === 'grand') { applyGridPreset('grid'); return true; }
    return false;
  }

  /* ==================================================================================
   *  §15 阅读模式
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  分三步：
   *    ① 预清洗：整篇文档去掉脚本 / 表单 / 站点级 header、footer、nav、aside；
   *    ② 密度抽取：给每个候选容器按「段落密度 × 标点数量」打分，用链接密度做惩罚，
   *       再用 class/id 的正负词表微调，选出真正的正文容器；
   *    ③ 二次净化：在正文容器里再去掉噪声块、高链接密度块、空壳，把懒加载图片的真实
   *       地址提到 src，并清掉内联样式 / 事件 / 类名（阅读模式自带排版，留着页面原样式
   *       只会互相打架）。
   *  最后有兜底：抽取结果太短就退回 article / main / body 的净化版，保证极端站点也不白屏。
   * ================================================================================== */
  /* 这些标签在任何情况下都不属于正文。
     注意绝不能包含 base —— readerBuild 会自己往 head 里插一个 <base>，
     否则会在预清洗时被一起删掉，相对路径图片就全 404 了。 */
  const READER_PRUNE = 'script,style,noscript,link,meta,title,iframe,frame,form,input,select,textarea,button,svg,canvas,video,audio,source,track,embed,object,nav,aside,[role="navigation"],[role="banner"],[role="complementary"],[role="contentinfo"],[role="search"],[role="dialog"],[aria-hidden="true"],[hidden]';
  /** class / id 词表里的噪声块：评论、相关阅读、分享、面包屑、分页、推荐位…… */
  const READER_NOISE_CLASS = '[class*="comment"],[id*="comment"],[class*="related"],[id*="related"],[class*="recommend"],[class*="share-"],[class*="share_"],[class*="social"],[class*="breadcrumb"],[class*="crumb"],[class*="pagination"],[class*="pager"],[class*="sidebar"],[class*="advert"],[class*="adsbygoogle"],[class*="sponsor"],[class*="promo"],[class*="newsletter"],[class*="subscribe"],[class*="hot-list"],[class*="read-more"],[class*="back-to-top"],[class*="toolbar"]';
  /** 容器的 class/id 里出现这些词 → 更像正文 */
  const READER_POS_RE = /(^|[-_\s])(article|content|entry|hentry|main|post|text|blog|story|detail|rich[_-]?media|markdown|prose|chapter|readable)([-_\s]|$)/i;
  /** 容器的 class/id 里出现这些词 → 更像周边噪声 */
  const READER_NEG_RE = /(^|[-_\s])(comment|foot|footer|footnote|masthead|outbrain|promo|related|shoutbox|sidebar|sponsor|shopping|tags|tool|widget|nav|menu|breadcrumb|crumb|pagination|pager|share|social|subscribe|advert|ads|banner|copyright|disclaimer|recommend|hot|rank|login|signup|search|meta|byline)([-_\s]|$)/i;

  /** 元素里的有效文字长度（忽略空白，忽略标签） */
  function readerPlainLen(text) { return String(text || '').replace(/\s+/g, '').length; }
  /** HTML 字符串里的有效文字长度：用正则去标签，避免为了量长度而真正解析一次 DOM（会触发图片下载） */
  function readerTextLength(html) {
    return String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, '').length;
  }
  /** 链接密度：文字里有多大比例在 <a> 里 —— 导航条 / 目录 / 相关阅读的密度都极高 */
  function readerLinkDensity(node) {
    const total = readerPlainLen(node.textContent);
    if (!total) return 0;
    let linkLen = 0;
    node.querySelectorAll('a').forEach(a => { linkLen += readerPlainLen(a.textContent); });
    return Math.min(1, linkLen / total);
  }
  /** 单段得分：越长、标点越多越像正文；太短的基本是菜单项 */
  function readerParagraphScore(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const len = readerPlainLen(t);
    if (len < 12) return 0;
    const punct = (t.match(/[，。、；：！？…—,.!?;:]/g) || []).length;
    return 1 + Math.min(len / 90, 3) + Math.min(punct / 2, 3);
  }
  function readerSignature(node) {
    return (String(node.getAttribute('class') || '') + ' ' + String(node.id || '')).slice(0, 240);
  }
  function readerClassWeight(node) {
    const sig = readerSignature(node);
    let w = 0;
    if (READER_POS_RE.test(sig)) w += 26;
    if (READER_NEG_RE.test(sig)) w -= 46;
    return w;
  }
  /**
   * 密度抽取：每个段落按「离容器越近权重越高」累加到祖先候选上，
   * 然后取总分最高、链接密度不过高、文字量够长的那个。
   */
  function readerExtract(root) {
    if (!root) return null;
    const cands = new Map();
    const add = node => { if (node && node.nodeType === 1 && !cands.has(node)) cands.set(node, 0); };
    add(root);
    root.querySelectorAll('article,main,section,div,td,body').forEach(add);
    if (cands.size < 2) return root;
    for (const p of root.querySelectorAll('p,pre,blockquote,li,h2,h3')) {
      const score = readerParagraphScore(p.textContent);
      if (!score) continue;
      let node = p.parentElement, depth = 0;
      while (node && depth < 4) {
        if (cands.has(node)) cands.set(node, cands.get(node) + score / (depth + 1));
        if (node === root) break;
        node = node.parentElement;
        depth++;
      }
    }
    let best = null, bestScore = -Infinity;
    for (const [node, raw] of cands) {
      const len = readerPlainLen(node.textContent);
      if (len < 120) continue;                 // 短容器不可能是正文
      const density = readerLinkDensity(node);
      if (density > 0.6) continue;             // 链接堆不可能是正文
      let score = raw * (1 - density) + readerClassWeight(node) + Math.min(len / 400, 3);
      const tag = node.nodeName;
      if (tag === 'ARTICLE') score += 14;
      else if (tag === 'MAIN') score += 8;
      if (node === root) score -= 12;          // 只有别的候选都不行时才用根节点
      if (score > bestScore) { bestScore = score; best = node; }
    }
    return best || root;
  }
  /** 在正文容器内做二次净化：去噪声块、去高链接密度块、去空壳、提懒加载图、清属性 */
  function readerPurify(root, dropImages) {
    if (!root) return;
    const kill = sel => { try { root.querySelectorAll(sel).forEach(node => node.remove()); } catch (e) { /* 忽略 */ } };
    kill(READER_PRUNE);
    kill(READER_NOISE_CLASS);
    if (dropImages) kill('img,picture,figure,svg,video');

    // 高链接密度 / 空 / 超短的块，只要里面没有图片表格代码，就是导航或按钮堆
    for (const node of Array.from(root.querySelectorAll('div,section,ul,ol,dl,table,p,li'))) {
      if (!node.isConnected) continue;
      const len = readerPlainLen(node.textContent);
      const hasMedia = !!node.querySelector('img,picture,table,pre,code,iframe');
      if (!len) { if (!hasMedia) node.remove(); continue; }
      if (len < 14 && !hasMedia) { node.remove(); continue; }
      if (!hasMedia && len < 420 && readerLinkDensity(node) > 0.62) node.remove();
    }

    // class/id 明显是「周边信息」（post-meta / byline / tags / breadcrumb…）而且整块很短 → 直接删。
    // 这类块文字不多、链接密度也低，上面两条规则都拦不住。80 字上限是为了防止
    // 误伤 class 里恰好含这些词、但装的是整篇正文的大容器。
    for (const node of Array.from(root.querySelectorAll('div,section,span,p,ul,ol,dl'))) {
      if (!node.isConnected) continue;
      if (!READER_NEG_RE.test(readerSignature(node))) continue;
      if (readerPlainLen(node.textContent) < 80 && !node.querySelector('img,picture,table,pre,code')) node.remove();
    }

    // 懒加载图片：真实地址常常在 data-src / data-original 上，不搬过来就只剩占位图
    for (const img of Array.from(root.querySelectorAll('img,source'))) {
      const cur = String(img.getAttribute('src') || '');
      if (!cur || /^data:image\/(gif|png);base64,/i.test(cur) || /(spacer|blank|placeholder|loading|pixel)/i.test(cur)) {
        for (const k of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-echo', 'data-url']) {
          const v = img.getAttribute(k);
          if (v) { img.setAttribute('src', v); break; }
        }
      }
      const ss = img.getAttribute('data-srcset');
      if (ss && !img.getAttribute('srcset')) img.setAttribute('srcset', ss);
    }

    // 收尾：删掉彻底空掉的容器；清掉 style / class / id / on* / data-*，
    // 让阅读模式自己的排版说话（页面的浮动、栅格、暗色覆盖都会破坏阅读体验）
    for (const node of Array.from(root.querySelectorAll('*'))) {
      if (!node.isConnected) continue;
      const tag = node.nodeName;
      if ((tag === 'DIV' || tag === 'SECTION' || tag === 'SPAN' || tag === 'P' || tag === 'LI') &&
          !readerPlainLen(node.textContent) && !node.querySelector('img,picture,table,pre,code,iframe,br')) {
        node.remove();
        continue;
      }
      for (const attr of Array.from(node.attributes)) {
        const n = attr.name.toLowerCase();
        if (n === 'style' || n === 'class' || n === 'id' || n === 'hidden' || n === 'aria-hidden' ||
            /^on[a-z]+$/.test(n) || n.indexOf('data-') === 0) node.removeAttribute(attr.name);
      }
    }
    try {
      root.querySelectorAll('a[href]').forEach(a => {
        const href = String(a.getAttribute('href') || '');
        if (/^(javascript|data|vbscript):/i.test(href)) { a.removeAttribute('href'); return; }
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
    } catch (e) { /* 忽略 */ }
    readerCollapseBlank(root);
  }
  /**
   * 折叠多余空行。
   * 根因：上一轮清理空容器时会保留含 <br> 的空元素（条件里排除了 br），而大量站点正是用
   * <p><br></p> / <div><br><br></div> 做段间距的，这些空壳搬进阅读模式后，再叠加阅读样式
   * 自己的 p{margin:.8em 0} 就出现大片空行。三步：① 纯空壳直接删（段间距交回给 CSS）；
   * ② 连续 2 个及以上 <br> 折成 1 个；③ 正文首尾孤立的 <br> 清掉。
   * 不动 <pre> / <code> 内部：代码块里的换行是内容本身。
   */
  function readerCollapseBlank(root) {
    if (!root) return;
    const BLANK_RE = /[\s\u00a0\u200b\ufeff]+/g;
    const isBlankText = n => n.nodeType === 3 && !String(n.nodeValue || '').replace(BLANK_RE, '');
    /** 返回值 >= 0 表示「空壳，含 n 个 <br>」；-1 表示有实质内容 */
    const breakOnly = node => {
      let brs = 0;
      for (const n of node.childNodes) {
        if (isBlankText(n)) continue;
        if (n.nodeType === 1 && (n.nodeName === 'BR' || n.nodeName === 'WBR')) { brs++; continue; }
        return -1;
      }
      return brs;
    };
    const SHELL_TAGS = 'p,div,section,span,li,dd,dt,td,th,blockquote,h1,h2,h3,h4,h5,h6';
    for (const node of Array.from(root.querySelectorAll(SHELL_TAGS))) {
      if (!node.isConnected) continue;
      if (node.closest('pre,code')) continue;
      if (node.querySelector('img,picture,table,pre,code,iframe,video,hr')) continue;
      if (breakOnly(node) >= 0) node.remove();
    }
    // 折叠连续 <br>：按文档顺序扫一遍，遇到实质文本就重置计数
    const flat = [];
    (function walk(node) {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) flat.push(n);
        else if (n.nodeType === 1) {
          if (n.nodeName === 'BR') flat.push(n);
          else if (n.nodeName !== 'PRE') walk(n);
        }
      }
    })(root);
    let run = 0;
    for (const n of flat) {
      if (n.nodeType === 3) {
        if (!String(n.nodeValue || '').replace(BLANK_RE, '')) continue;   // 纯空白不打断连续 <br>
        run = 0;
        continue;
      }
      run++;
      if (run > 1) n.remove();
    }
    // 清掉首尾的孤立 <br>（连片空行清掉后，正文常以 <br> 开头或结尾）
    const trimEdge = fromEnd => {
      for (let guard = 0; guard < 40; guard++) {
        const kids = Array.from(root.childNodes);
        if (!kids.length) return;
        const ordered = fromEnd ? kids.reverse() : kids;
        let hit = null;
        for (const n of ordered) {
          if (isBlankText(n)) continue;
          if (n.nodeType === 1 && n.nodeName === 'BR') hit = n;
          break;
        }
        if (!hit) return;
        hit.remove();
      }
    };
    trimEdge(true);
    trimEdge(false);
  }
  /**
   * 从原始 HTML 构建阅读模式正文。
   * @returns {{html:string, mode:'density'|'fallback'|'empty'}}
   */
  function readerBuild(srcHtml, url, dropImages) {
    const parser = new window.DOMParser();
    const prepare = () => {
      const d = parser.parseFromString(String(srcHtml || ''), 'text/html');
      const base = d.createElement('base');
      base.setAttribute('href', url);
      if (d.head) d.head.prepend(base); else d.documentElement.prepend(base);
      d.querySelectorAll(READER_PRUNE).forEach(node => node.remove());
      // 站点级页眉页脚才删；<article> 内部的 header/footer 往往放着标题和作者，留着
      d.querySelectorAll('header,footer').forEach(node => {
        try { if (!node.closest('article,main,[role="main"]')) node.remove(); } catch (e) { node.remove(); }
      });
      return d;
    };
    let doc = prepare();
    let html = '', mode = 'empty';
    const root = readerExtract(doc.body || doc.documentElement);
    if (root) {
      readerPurify(root, dropImages);
      absolutize(doc, url);
      html = root.innerHTML;
      mode = 'density';
    }
    // 兜底：密度抽取失败或结果过短（不少站点正文没有 <p>，全靠 <div> 堆），
    // 退回 article / main / body 的净化版，谁更长用谁
    if (readerTextLength(html) < 180) {
      doc = prepare();
      const naive = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('[role="main"]') || doc.body;
      if (naive) {
        readerPurify(naive, dropImages);
        absolutize(doc, url);
        const alt = naive.innerHTML;
        if (readerTextLength(alt) > readerTextLength(html)) { html = alt; mode = 'fallback'; }
      }
    }
    if (!readerTextLength(html)) mode = 'empty';
    return { html, mode };
  }
  /** 取页面 HTML 文本：优先 GM_xmlhttpRequest，没有就用 fetch 兜底（同源/允许 CORS 时可用） */
  /**
   * 抓一份页面的 HTML 文本。
   * v20.2.2：onDone 现在会带上 HTTP 状态码 —— 之前不管 403 还是 200 都直接当正文渲染，
   * 于是「站点拒绝脚本抓取」会表现为「抓回来了一个空白/错误页」，用户什么都不知道。
   * onFail 也会带上原因字符串（'timeout' / 'network'）。
   */
  function fetchPageText(url, onDone, onFail) {
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
  }

  /* ---- v20：禁止嵌入站点的只读快照 ----------------------------------------------
   * X-Frame-Options / CSP frame-ancestors 拒绝嵌入时，iframe 里只有浏览器错误页。
   * 这里用 GM_xmlhttpRequest（脚本特权，不受嵌入限制）抓一份 HTML，做四件事：
   *   ① 插 <base href=原地址 target=_blank>：相对地址全部可解析，链接点击开新标签页；
   *   ② 摘掉 CSP / refresh / x-frame-options 的 <meta http-equiv>：CSP meta 会把快照
   *      文档自己的资源加载策略也套上（图片直接全灭），refresh 会把 iframe 导走；
   *   ③ 删掉全部 <script> 与 <noscript>（无 JS 环境，noscript 内容是给无 JS 用户的
   *      提示横幅，留着只会碍眼）；sandbox 收掉 allow-scripts 后内联 on* 也一并失效；
   *   ④ 绝对化所有资源地址（absolutize 与阅读模式共用），blob URL 渲染进预览窗。
   * 快照是只读的：样式 / 图片 / 链接照常，但无法登录、点不动页面按钮。
   * 「刷新」会先重试正常嵌入，仍被拒才再抓一次。 */
  /* v20.2：快照公共预处理 —— <base> 处理 + 摘掉会反过来咬自己的那几个 meta。
     被 renderSnapshot（禁止嵌入站点）与 peekSnapBuild（小窗静音快照）共用。
       · base：页面自己声明过 <base href> 的（相对地址的解析根在别处），保留它并只补
         target；否则才用原地址兜底。第一个 <base href> 生效，所以「保留原 base」这一支
         绝不能在前面再插一个自己的。
       · meta：CSP meta 会把快照文档自己的资源加载策略也套上（图片直接全灭），
         refresh 会把 iframe 导走，x-frame-options 同理 —— 三者都摘。 */
  function snapshotPrep(doc, url) {
    let baseEl = doc.querySelector('base[href]');
    if (baseEl) {
      const absBase = httpUrl(baseEl.getAttribute('href'), url);
      if (absBase) baseEl.setAttribute('href', absBase);
      baseEl.setAttribute('target', '_blank');
    } else {
      baseEl = doc.createElement('base');
      baseEl.setAttribute('href', url);
      baseEl.setAttribute('target', '_blank');
      if (doc.head) doc.head.prepend(baseEl);
      else doc.documentElement.prepend(baseEl);
    }
    doc.querySelectorAll('meta[http-equiv]').forEach(m => {
      const he = String(m.getAttribute('http-equiv') || '').toLowerCase();
      if (he === 'content-security-policy' || he === 'content-security-policy-report-only' || he === 'refresh' || he === 'x-frame-options') m.remove();
    });
  }
  /** 取页面 HTML 文本，解析成文档并做公共预处理；解析失败返回 null */
  function snapshotDoc(text, url) {
    let doc = null;
    try { doc = new window.DOMParser().parseFromString(text, 'text/html'); }
    catch (e) { doc = null; }
    if (!doc || !doc.documentElement) return null;
    try { snapshotPrep(doc, url); } catch (e) { /* 预处理失败就按原样继续 */ }
    return doc;
  }
  function renderSnapshot(item) {
    if (item.closed || item.isReaderMode || item.imageMode || item.synthetic) return;
    const pageUrl = currentPageUrl(item);
    const requestGeneration = item.generation;
    if (!pageUrl) { snapshotFailed(item, '拿不到当前预览的有效网址，无法抓取快照。'); return; }
    toast(item, '该站点禁止被嵌入，正在抓取只读快照…');
    fetchPageText(pageUrl,
      (text, status, finalUrl) => {
        // A slow snapshot response must never be written into a window that
        // navigated to another page in the meantime.
        if (item.closed || item.generation !== requestGeneration) return;
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
          // A read-only snapshot must not autoplay media, submit forms or
          // navigate a nested frame.  The sandbox already blocks scripts; this
          // also removes the DOM surfaces that remain interactive.
          doc.querySelectorAll('script,noscript,video,audio,source,track,iframe,frame,embed,object,form,input,select,textarea,button').forEach(n => n.remove());
          absolutize(doc, snapshotUrl);
        } catch (e) { /* 清洗失败时沙箱仍会阻止脚本与表单 */ }
        item.url = snapshotUrl;
        item.originalUrl = snapshotUrl;
        const html = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
        if (item.synthUrl) { try { window.URL.revokeObjectURL(item.synthUrl); } catch (e) { /* 忽略 */ } }
        item.synthUrl = window.URL.createObjectURL(new window.Blob([html], { type: 'text/html' }));
        item.synthetic = true;
        try { item.ui.frame.setAttribute('sandbox', SNAPSHOT_SANDBOX); } catch (e) { /* 忽略 */ }
        item.ui.frame.src = item.synthUrl;
        const t = pageTitle(doc);
        if (t) { item.title = t; renderTitle(item); }
        /* v20.2.2：空壳检测 —— 抓回来了、也渲染了，但里面其实什么都没有。
           这正是用户报的「预览打开啥都没有，也没提示」：SPA 的首屏 HTML 只有一个
           空的挂载点，正文全靠脚本填，而快照按设计就是禁用脚本的。不检测的话
           用户就只是盯着一片空白，完全不知道发生了什么。 */
        if (snapshotThin(doc)) {
          hint(item, '快照里几乎没有正文：常见于纯 JavaScript 渲染的 SPA（快照已停用脚本），'
            + '也可能是站点只返回了很短的页面。想看原样请在新标签页打开。', HINT_OPEN_TAB);
        }
      },
      reason => {
        if (item.closed || item.generation !== requestGeneration) return;
        snapshotFailed(item, reason === 'timeout'
          ? '抓取快照超时（20 秒没有响应）。'
          : reason === 'too-large'
            ? '页面超过后台抓取的 12MB 上限，无法生成快照。可点「在新标签页打开」。'
            : '该站点禁止被嵌入，抓取快照也失败了。');
      });
  }
  /**
   * 快照是不是「空壳」：抓回来了，但正文基本没东西。
   * 判定故意保守 —— 误报（内容其实有、却被说成空壳）比漏报更烦人。
   * 文本太短时再看有没有实质元素撑场面（图片 / 视频 / 表格这类无文字内容）。
   */
  const SNAPSHOT_THIN_CHARS = 200;
  function snapshotThin(doc) {
    try {
      const body = doc.body;
      if (!body) return true;
      const text = String(body.textContent || '').replace(/\s+/g, '');
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
  }
  function snapshotFailed(item, message) {
    item.ui.loader.hidden = true;
    item.ui.progressBar.style.width = '100%';
    hint(item, message || '该站点禁止被嵌入，抓取快照也失败了。', HINT_OPEN_TAB);
  }
  /** 把 src / srcset / poster / 链接 / 内联 style 里的相对地址补成绝对地址 */
  function absolutize(doc, base) {
    // A parsed document may carry its own <base href>.  Using the request URL
    // blindly broke every relative image/link on sites with a base element.
    const docBase = httpUrl(doc && doc.baseURI) || base;
    const fixSrc = node => {
      const raw = node.getAttribute('src');
      if (raw) { const abs = httpUrl(raw, docBase); if (abs) node.setAttribute('src', abs); }
      const set = node.getAttribute('srcset');
      if (set) {
        node.setAttribute('srcset', set.split(',').map(part => {
          const seg = part.trim().split(/\s+/);
          const abs = httpUrl(seg[0], docBase);
          if (abs) seg[0] = abs;
          return seg.join(' ');
        }).join(', '));
      }
    };
    for (const sel of ['img', 'source', 'video', 'audio', 'track', 'embed']) {
      try { doc.querySelectorAll(sel).forEach(fixSrc); } catch (e) { /* 忽略 */ }
    }
    doc.querySelectorAll('video[poster]').forEach(node => {
      const abs = httpUrl(node.getAttribute('poster'), docBase);
      if (abs) node.setAttribute('poster', abs);
    });
    // v20：补上「不是图片但同样会发请求」的那几类 —— 快照模式下外部样式表 / 内嵌框 /
    // 表单动作地址全靠这一步（阅读模式也用同一个函数，多覆盖几种只会有益无害）。
    const fixAttr = (sel, attr) => {
      try {
        doc.querySelectorAll(sel).forEach(node => {
          const raw = node.getAttribute(attr);
          if (!raw || raw.charAt(0) === '#' || /^(data:|blob:|javascript:|mailto:|tel:)/i.test(raw)) return;
          const abs = httpUrl(raw, docBase);
          if (abs) node.setAttribute(attr, abs);
        });
      } catch (e) { /* 忽略 */ }
    };
    fixAttr('link[href]', 'href');
    fixAttr('iframe[src]', 'src');
    fixAttr('object[data]', 'data');
    fixAttr('form[action]', 'action');
    fixAttr('input[src]', 'src');
    try {
      doc.querySelectorAll('a[href]').forEach(node => {
        const raw = node.getAttribute('href');
        if (!raw || raw.charAt(0) === '#') return;
        if (/^(javascript|data|vbscript):/i.test(raw)) { node.removeAttribute('href'); return; }
        const abs = httpUrl(raw, docBase);
        if (abs) node.setAttribute('href', abs);
      });
    } catch (e) { /* 忽略 */ }
    try {
      doc.querySelectorAll('[style*="url("]').forEach(node => {
        const css = node.getAttribute('style') || '';
        const next = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (whole, quote, raw) => {
          if (/^(data:|blob:|https?:)/i.test(raw)) return whole;
          const abs = httpUrl(raw, docBase);
          return abs ? `url(${quote}${abs}${quote})` : whole;
        });
        if (next !== css) node.setAttribute('style', next);
      });
    } catch (e) { /* 忽略 */ }
  }
  function renderReaderMode(item) {
    if (!item.readerSource || item.closed) return;
    item.readerDirty = false;
    try {
      const isDark = getEffectiveDark();
      const palette = currentPalette;
      const readerBg = palette ? (palette.surface || palette.bg) : (isDark ? '#20222d' : '#dfe2e7');
      const readerText = palette ? palette.text : (isDark ? '#e4e5eb' : '#29313d');
      const pageUrl = currentPageUrl(item) || item.originalUrl || location.href;
      const built = readerBuild(item.readerSource, pageUrl, settings.readerHideImages);
      item.readerMode = built.mode;
      let html = built.mode === 'empty'
        ? '<p>没能从这个页面里抽出正文。已保留原始页面，可点“刷新”重试，或用“新标签页”直接打开。</p>'
        : built.html;
      let outline = [];
      if (built.mode !== 'empty') {
        const enriched = readerOutlineFromHtml(html);
        html = enriched.html;
        outline = enriched.list;
      }
      item.readerOutline = outline;
      const bgParsed = parseColorStr(readerBg);
      const isDarkBg = bgParsed ? getLuminance(bgParsed.r, bgParsed.g, bgParsed.b) < 0.5 : isDark;
      const linkColor = isDarkBg ? '#8ab4f8' : '#1a6bcb';
      const borderColor = isDarkBg ? '#3a3c4e' : '#c6ccd5';
      const codeBg = isDarkBg ? '#2c2e3a' : '#f0f0f0';
      const width = settings.phoneMode ? clampNum(settings.phoneWidth, 280, 900, 420, true) : 760;
      const readerFont = clampNum(settings.readerFontSize, 12, 28, 17, true);
      const lineH = clampNum(settings.readerLineHeight, 120, 260, 190, true) / 100;
      const headTitle = String(item.title || item.fallbackTitle || '').replace(/[<>&]/g, '');
      const filter = item.forceDark ? 'html{filter:invert(1) hue-rotate(180deg)}img,video,picture{filter:invert(1) hue-rotate(180deg)}' : '';
      const readerHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${(currentPageUrl(item) || item.originalUrl || location.href).replace(/"/g, '&quot;')}"><style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:${readerFont}px;line-height:${lineH};color:${readerText};max-width:${width}px;margin:0 auto;padding:40px 20px;background:${readerBg}}h1{font-size:1.6em;margin:0 0 .5em}h2,h3{margin-top:1.5em}p{margin:.8em 0}img{max-width:100%;height:auto;border-radius:8px;margin:16px auto;display:block}a{color:${linkColor};text-decoration:none}blockquote{border-left:3px solid ${borderColor};padding-left:16px;opacity:.8;margin:1em 0}pre{background:${codeBg};padding:14px;border-radius:8px;overflow-x:auto;font-size:.9em}table{border-collapse:collapse;width:100%}th,td{border:1px solid ${borderColor};padding:8px;text-align:left}hr{border:none;border-top:1px solid ${borderColor};margin:2em 0}${filter}
.ldp-read-progress{position:fixed;left:0;right:0;top:0;height:3px;z-index:2147483647;background:transparent;pointer-events:none}
.ldp-read-progress i{display:block;height:100%;background:${linkColor};transform-origin:0 50%;transform:scaleX(0);animation:ldp-read-progress linear both;animation-timeline:scroll(root block)}
@keyframes ldp-read-progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
</style></head><body><div class="ldp-read-progress" aria-hidden="true"><i></i></div><h1>${headTitle}</h1>${html}</body></html>`;
      if (item.readerUrl) { try { window.URL.revokeObjectURL(item.readerUrl); } catch (e) { /* 忽略 */ } }
      item.readerUrl = window.URL.createObjectURL(new window.Blob([readerHtml], { type: 'text/html' }));
      // Iframe sandbox is a security boundary.  Reader HTML came from an
      // untrusted page; never give it allow-scripts, even after sanitizing.
      try { item.ui.frame.setAttribute('sandbox', READER_SANDBOX); } catch (e) { /* 忽略 */ }
      item.ui.frame.src = item.readerUrl;
      item.ui.loader.hidden = true;
      if (settings.phoneMode) {
        const v = viewport();
        const rw = Math.min(width + 20, v.w - 16);
        item.rect = fit({ x: (v.w - rw) / 2, y: 20, w: rw, h: v.h - 40 });
        renderGeometry(item, true);
      }
      syncReaderTools(item);
    } catch (e) {
      item.isReaderMode = false;
      try { item.ui.frame.setAttribute('sandbox', FULL_SANDBOX); } catch (e2) { /* ignore */ }
      item.ui.loader.hidden = true;
      toast(item, '阅读模式渲染失败');
    }
  }
  function toggleReaderMode(item) {
    if (item.imageMode) { toast(item, '图片预览不支持阅读模式'); return; }
    if (item.isReaderMode) {
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
    }
    item.preReaderRect = Object.assign({}, item.rect);
    item.ui.loader.hidden = false;
    toast(item, '正在提取正文...');
    const pageUrl = currentPageUrl(item);
    const requestGeneration = item.generation;
    if (!pageUrl) { item.ui.loader.hidden = true; item.preReaderRect = null; toast(item, '拿不到当前预览的有效网址'); return; }
    fetchPageText(pageUrl,
      (text, status, finalUrl) => {
        if (item.closed || item.generation !== requestGeneration || currentPageUrl(item) !== pageUrl) return;
        if (status >= 400) {
          item.ui.loader.hidden = true;
          item.preReaderRect = null;
          toast(item, '抓取正文失败（HTTP ' + status + '）');
          return;
        }
        if (httpUrl(finalUrl)) { item.url = httpUrl(finalUrl); item.originalUrl = httpUrl(finalUrl); }
        item.readerSource = text || '';
        item.isReaderMode = true;
        item.readerDirty = true;
        renderReaderMode(item);
        const modeName = item.readerMode === 'density' ? '密度抽取' : (item.readerMode === 'fallback' ? '兜底提取' : '');
        toast(item, item.readerSource ? ('已进入阅读模式' + (modeName ? '（' + modeName + '）' : '')) : '正文为空');
      },
      reason => {
        if (item.closed || item.generation !== requestGeneration) return;
        item.ui.loader.hidden = true;
        item.preReaderRect = null;
        toast(item, reason === 'timeout' ? '请求超时：20 秒内没有拿到正文'
          : reason === 'too-large' ? '页面超过 12MB 抓取上限，无法进入阅读模式'
          : '请求失败：该页面可能禁止外部抓取');
      });
  }
  /** 阅读排版（字号 / 行高）：同源时直接改样式，改不动就整篇重绘兜底 */
  // v21.2 reader enhancements: outline, speech and text export.
  function readerOutlineFromHtml(html) {
    const list = [];
    try {
      const doc = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
      const headings = Array.from(doc.body ? doc.body.querySelectorAll('h1,h2,h3,h4') : [])
        .filter(h => String(h.textContent || '').replace(/\s+/g, ' ').trim().length > 1);
      headings.forEach((h, i) => {
        const id = String(i);
        h.setAttribute('data-ldp-heading', id);
        list.push({
          id,
          level: Number(String(h.tagName || 'H2').slice(1)) || 2,
          text: String(h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        });
      });
      return { html: doc.body ? doc.body.innerHTML : String(html || ''), list };
    } catch (e) { return { html: String(html || ''), list: [] }; }
  }
  function readerPlainText(item) {
    const doc = frameDoc(item);
    if (!doc || !doc.body) return '';
    return String(doc.body.innerText || doc.body.textContent || '')
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  function readerExportText(item) {
    const text = readerPlainText(item);
    if (!text) return '';
    const title = String(item.title || item.fallbackTitle || '网页正文').trim();
    const source = currentPageUrl(item) || item.originalUrl || item.url || '';
    return '# ' + title + '\n\n> ' + source + '\n\n' + text + '\n';
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
  function aiPageText(item, callback) {
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
        const currentText = String(document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
        if (currentText.length >= 30) { callback(currentText); return; }
      }
    } catch (e) { /* fall back to fetch */ }
    const buildPlain = (html) => {
      try {
        const raw = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
        try {
          raw.querySelectorAll('script,style,noscript,iframe,svg,nav,aside,footer,header,form').forEach(node => node.remove());
        } catch (e) { /* ignore */ }
        let plain = String(raw.body ? (raw.body.innerText || raw.body.textContent || '') : '').replace(/\s+/g, ' ').trim();
        if (!plain) {
          // Last-resort tag stripping for malformed documents where the body
          // was not parsed into a usable element.
          plain = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
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
  /**
   * 只在「用户明确要停」时断流。
   * 旧实现把 stopAIPort 挂在 closePanel / 窗口关闭上，而页面上的普通操作
   * （点一下空白、切换工具、面板重建）都会走到这些路径，于是总结写到一半就被
   * 掐断 —— 表现就是「动一下网页，总结就卡住」。
   * 现在面板/窗口关闭只做「暂停显示」，流仍然在后台跑完并缓存结果；
   * 真正断流只发生在取消、重新开始、或窗口彻底销毁时。
   */
  function detachAIPort(item) {
    if (!item) return;
    if (item.aiPort) {
      item.aiPortPaused = item.aiPort;
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
    const safeHref = href => {
      const value = String(href || '').trim();
      return /^(https?:\/\/|mailto:)/i.test(value) ? esc(value) : '';
    };
    const inline = text => {
      let value = esc(text);
      value = value.replace(/`([^`]+)`/g, (_, code) => '<code>' + code + '</code>');
      // Images must be handled before links, otherwise `![alt](src)` becomes a
      // broken nested anchor.  Only http(s)/data-image sources are accepted.
      value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (match, alt, src, title) => {
        const href = safeHref(src) || (/^data:image\//i.test(src) ? esc(src) : '');
        if (!href) return esc(alt || '');
        return '<img src="' + href + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + ' loading="lazy" decoding="async">';
      });
      value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) =>
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
      value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      value = value.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return value;
    };
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
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
      html.push('<pre><code' + (codeLang ? ' class="language-' + esc(codeLang) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
      code = null;
      codeLang = '';
    };
    const splitRow = line => String(line || '')
      .trim()
      .replace(/^\|/, '').replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
    const alignOf = line => splitRow(line).map(cell => {
      const left = /^:/.test(cell);
      const right = /:$/.test(cell);
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
    const isTableDivider = line => /\|/.test(String(line || ''))
      && splitRow(line).every(cell => /^:?-{2,}:?$/.test(cell));
    const renderTable = (headerLine, dividerLine, bodyLines) => {
      const aligns = alignOf(dividerLine);
      const head = splitRow(headerLine);
      const alignAttr = index => {
        const value = aligns[index] || '';
        return value ? ' style="text-align:' + value + '"' : '';
      };
      const parts = ['<div class="md-table-wrap"><table><thead><tr>'];
      head.forEach((cell, index) => { parts.push('<th' + alignAttr(index) + '>' + inline(cell) + '</th>'); });
      parts.push('</tr></thead><tbody>');
      for (const row of bodyLines) {
        const cells = splitRow(row);
        parts.push('<tr>');
        for (let index = 0; index < head.length; index += 1) {
          parts.push('<td' + alignAttr(index) + '>' + inline(cells[index] || '') + '</td>');
        }
        parts.push('</tr>');
      }
      parts.push('</tbody></table></div>');
      html.push(parts.join(''));
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (code !== null) {
        if (/^\s*```/.test(line)) closeCode();
        else code.push(line);
        continue;
      }
      const fence = line.match(/^\s*```([\w-]*)\s*$/);
      if (fence) {
        flushParagraph();
        closeList();
        code = [];
        codeLang = fence[1] || '';
        continue;
      }
      // GitHub-style table: header row, `|---|:--:|` divider, then body rows.
      if (/\|/.test(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        flushParagraph();
        closeList();
        const body = [];
        let cursor = i + 2;
        while (cursor < lines.length && /\|/.test(lines[cursor]) && lines[cursor].trim()) {
          body.push(lines[cursor]);
          cursor += 1;
        }
        renderTable(line, lines[i + 1], body);
        i = cursor - 1;
        continue;
      }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        closeList();
        html.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>');
        continue;
      }
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        flushParagraph();
        closeList();
        html.push('<hr>');
        continue;
      }
      const task = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/);
      if (task) {
        flushParagraph();
        if (list !== 'ul') { closeList(); html.push('<ul class="md-tasks">'); list = 'ul'; }
        const checked = task[1].toLowerCase() === 'x';
        html.push('<li class="md-task' + (checked ? ' md-task-done' : '') + '">'
          + '<input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + inline(task[2]) + '</li>');
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
        html.push('<li>' + inline(bullet[1]) + '</li>');
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        flushParagraph();
        if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
        html.push('<li>' + inline(ordered[1]) + '</li>');
        continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
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
  function savedAIKey(providerId) {
    const id = providerId || aiConfig.provider || DEFAULT_AI_CONFIG.provider;
    return String((aiConfig.apiKeys && aiConfig.apiKeys[id])
      || (id === aiConfig.provider ? aiConfig.apiKey : '') || '').trim();
  }
  function savedMediaKey() {
    return String(aiConfig.mediaApiKey || (aiConfig.apiKeys && aiConfig.apiKeys.siliconflow) || '').trim();
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
      // Keep the page text so the follow-up box can ground its answers in the
      // original content, not just in the rendered summary.
      if (text) item.pageText = String(text).slice(0, 20000);
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
          if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item);
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
          if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item);
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
    item.ui.aiOut = out;
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
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
      const base = String(item.title || 'article').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'article';
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
  function applyReaderTypography(item) {
    if (!item || item.closed || !item.isReaderMode) return false;
    const doc = frameDoc(item);
    if (doc && doc.body) {
      try {
        const size = clampNum(settings.readerFontSize, 12, 28, 17, true) + 'px';
        const lh = String(clampNum(settings.readerLineHeight, 120, 260, 190, true) / 100);
        if (doc.body.style.fontSize !== size) doc.body.style.fontSize = size;
        if (doc.body.style.lineHeight !== lh) doc.body.style.lineHeight = lh;
        return true;
      } catch (e) { /* 落到重绘 */ }
    }
    if (item.readerSource) renderReaderMode(item);
    return false;
  }
  function adjustReaderFont(item, dir) {
    const cur = clampNum(settings.readerFontSize, 12, 28, 17, true);
    const next = clampNum(cur + dir, 12, 28, 17, true);
    if (next === cur) { toast(item, '字号已经到' + (dir > 0 ? '上限' : '下限') + '了'); return; }
    updateSetting(item, 'readerFontSize', next);
    toast(item, '正文字号 ' + next + 'px');
  }

  /* ==================================================================================
   *  §16 窗口记忆与会话恢复
   * ================================================================================== */
  function collectWindows() {
    return windows.filter(w => !w.closed && !w.bare && w.url).map(w => ({
      url: w.url, title: w.title || w.fallbackTitle || '', key: w.key, zoom: w.zoom,
      rect: { x: Math.round(w.rect.x), y: Math.round(w.rect.y), w: Math.round(w.rect.w), h: Math.round(w.rect.h) },
      pinned: !!w.pinned, pip: !!w.pip, forceDark: !!w.forceDark, inArrange: !!w.inArrange,
      imageMode: !!w.imageMode, imageSourceUrl: w.imageSourceUrl || '',
      imageCandidates: w.imageMode && w.imageCandidates && w.imageCandidates.length
        ? w.imageCandidates.slice(0, 12) : []
    }));
  }
  function rememberSession(forceClosed) {
    if (!settings.sessionMemory) return 0;
    // 恢复会话时会先把窗口全关掉，那一瞬间 windows 为空会被误判成「用户主动关完了」
    // 从而删掉这个站点刚保存的记录 —— 恢复期间一律不写。
    if (restoringSession) return 0;
    // 会话键走 layoutKey()（与布局记忆同一套分区逻辑），不再写死 location.origin，
    // 否则某个子页面留下的组合会在站点任意页面自动弹出来 —— 用户感知就是「记忆错乱」。
    const key = sessionKey();
    const list = windows.length ? collectWindows() : [];
    if (!list.length) {
      // Opening settings/help creates a bare window with no preview.  It must
      // not be mistaken for "the user closed every preview", which used to
      // disable the next automatic restore.  Only a real non-bare close
      // (forceClosed) or a tab that previously owned previews may mark closed.
      if (!forceClosed) {
        const mark = tabMarkRead();
        if (!mark || !mark.count || mark.key !== key) return 0;
      }
      // 「关掉全部窗口」不直接删记录，而是标成 closed：自动恢复会跳过它
      // （用户主动关掉的，不该下次自己弹回来），但手动恢复仍能把上次的组合找回来。
      const rec = sessions[key];
      if (rec && rec.closed !== true) { rec.closed = true; writeStore(SESSIONS_KEY, sessions); }
      // 标签页标记同步归零 —— 关完窗口再刷新不该把窗口变回来。
      // 只有「本标签页原本确实标着有窗口」时才写，避免启动阶段（标记正等着被
      // autoRestoreIfNeeded 读取）被自己擦掉。
      const prevMark = tabMarkRead();
      if (prevMark && prevMark.count > 0 && prevMark.key === key) {
        tabMarkWrite({ key, count: 0, time: Date.now() });
      }
      return 0;
    }
    sessions[key] = { time: Date.now(), closed: false, list };
    const keys = Object.keys(sessions);
    if (keys.length > 60) {
      keys.sort((a, b) => ((sessions[a] && sessions[a].time) || 0) - ((sessions[b] && sessions[b].time) || 0));
      keys.slice(0, keys.length - 60).forEach(k => delete sessions[k]);
    }
    writeStore(SESSIONS_KEY, sessions);
    tabMarkWrite({ key, count: list.length, time: Date.now() });
    return list.length;
  }
  let sessionTimer = 0;
  let idleHandle = 0;
  /** 落盘走空闲回调：不打断滚动与拖拽，也不跟窗口动画抢主线程 */
  function runIdle(fn) {
    try {
      if (typeof window.requestIdleCallback === 'function') {
        idleHandle = window.requestIdleCallback(() => { idleHandle = 0; fn(); }, { timeout: 1500 });
        return;
      }
    } catch (e) { /* 回退到 setTimeout */ }
    sessionTimer = setTimeout(fn, 450);
  }
  /* v20.2.3：空闲时先把「外壳」建好。
     ensureShell 做的是「建影子根 + 解析窗口模板 + 注入 18KB CSS」，这笔钱本来要花在
     用户手势之后才付 —— 感知就是「点了之后要愣一下」。挪到页面空闲之后再付，
    第一次开窗就和第二次一样快。
     ⚠ v20.2.2 是在**页面加载时**就排队做这件事；那会在每一个页面的加载期挂上一个
     全屏 fixed + isolation 的层并重算一次取色，对「只是路过」的页面是净负担。
     v20.2.3 改成「指针第一次碰到链接时才排队」—— 那时用户已经表现出可能要用预览，
     而真正开窗至少还在 600ms（悬停阈值）之后，建壳完全来得及。
     幂等：已经排过队或已经有壳就直接返回，所以可以放在 mouseover 这种热路径上。 */
  let shellWarmHandle = 0;
  function scheduleShellWarm() {
    if (shell || shellWarmHandle) return;
    const fire = () => {
      shellWarmHandle = 0;
      try { if (!shell) ensureShell(); } catch (e) { /* 建壳失败就等真正需要时再试 */ }
    };
    try {
      if (typeof window.requestIdleCallback === 'function') {
        shellWarmHandle = window.requestIdleCallback(fire, { timeout: 2500 });
        return;
      }
    } catch (e) { /* 回退到 setTimeout */ }
    shellWarmHandle = setTimeout(fire, 900);
  }
  function cancelShellWarm() {
    if (!shellWarmHandle) return;
    try {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(shellWarmHandle);
    } catch (e) { /* ignore */ }
    clearTimeout(shellWarmHandle);
    shellWarmHandle = 0;
  }
  function scheduleSessionSave() {
    if (!settings.sessionMemory || restoringSession) return;
    if (idleHandle) { try { window.cancelIdleCallback(idleHandle); } catch (e) { /* 忽略 */ } idleHandle = 0; }
    clearTimeout(sessionTimer);
    runIdle(rememberSession);
  }
  /**
   * 立刻同步落盘，不等空闲回调。用在「关掉最后一个窗口」这个关键时刻 ——
   * 旧版走 idle（最多 1.5s 才写），用户关完就跳转 / 关标签页的话 closed 标记根本来不及
   * 落盘，下次进这个站点又会被自动恢复弹回来。
   */
  function flushSessionNow(forceClosed) {
    if (idleHandle) { try { window.cancelIdleCallback(idleHandle); } catch (e) { /* 忽略 */ } idleHandle = 0; }
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = 0; }
    if (!settings.sessionMemory || restoringSession) return;
    rememberSession(!!forceClosed);
  }
  function sessionKey() {
    try { return layoutKey(location.href); } catch (e) { return location.origin; }
  }
  function sessionFor(key) {
    const s = sessions[key || sessionKey()];
    if (!s || !Array.isArray(s.list) || !s.list.length) return null;
    return s;
  }
  function restoreSession(fromItem, opts) {
    const o = opts || {};
    const snapshot = o.session || sessionFor(sessionKey());
    if (!snapshot || !snapshot.list.length) {
      if (!o.silent) {
        if (fromItem) toast(fromItem, '这台设备上还没有保存过窗口');
        else toastStandalone('还没有保存过窗口');
      }
      return 0;
    }
    if (windows.length && !o.silent && fromItem && o.confirm !== false) {
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
    if (!windows.some(w => !w.closed && !w.bare)) resumeBackgroundVideos();
    if (n) scheduleSessionSave();
    if (n && fromItem) toast(fromItem, '已恢复 ' + n + ' 个窗口');
    else if (n && !o.silent) toastStandalone('已恢复 ' + n + ' 个预览窗口');
    return n;
  }
  function askRestoreConfirm(item, snapshot) {
    item.panelMode = 'confirm';
    const body = panelFrame(item, '恢复上次的窗口组合？');
    const t = snapshot && snapshot.time ? new Date(snapshot.time).toLocaleString() : '';
    body.appendChild(el('p', 'note', '会先关闭当前 ' + windows.length + ' 个预览窗口，再打开记录的 '
      + snapshot.list.length + ' 个' + (t ? '（保存于 ' + t + '）' : '')));
    const row = buttonRow('<button class="text-button" data-action="confirmRestore">恢复</button><button class="text-button" data-action="closePanel">取消</button>', '14px');
    body.appendChild(row);
    row.querySelector('[data-action="confirmRestore"]').addEventListener('click', () => {
      closePanel(item, false);
      restoreSession(item, { session: snapshot, confirm: false });
    });
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  function openWindowFromRecord(rec) {
    const imageOpts = rec.imageMode
      ? { image: { url: rec.url, title: rec.title || '', sourceUrl: rec.imageSourceUrl || '',
        candidates: (Array.isArray(rec.imageCandidates) && rec.imageCandidates.length) ? rec.imageCandidates : [rec.url] } }
      : undefined;
    const item = openWindow(rec.url, rec.title || '', null, null, imageOpts);
    if (!item) return null;
    if (rec.rect && Number.isFinite(rec.rect.x)) {
      item.rect = fit(rec.rect);
      item.lastRect = null;
      renderGeometry(item, true);
    }
    if (rec.zoom && rec.zoom !== item.zoom) { item.zoom = item.imageMode ? clampNum(rec.zoom, 0.1, 8, 1, false) : clampNum(rec.zoom, 0.5, 2, 1, false); renderZoom(item); }
    if (rec.forceDark) {
      item.forceDark = true;
      item.ui.fdBtn.classList.add('selected');
      applyForceDark(item);
    }
    if (rec.pinned) {
      item.pinned = true;
      item.ui.win.classList.add('pinned');
      item.ui.win.querySelector('[data-action="pin"]').classList.add('selected');
    }
    if (rec.pip && settings.pipEnabled) togglePip(item);
    else if (rec.inArrange && !arrangeState) enterArrange();
    return item;
  }
  function tabMarkRead() {
    try {
      const raw = sessionStorage.getItem(TAB_MARK_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return isObj(v) ? v : null;
    } catch (e) { return null; }
  }
  function tabMarkWrite(value) {
    try { sessionStorage.setItem(TAB_MARK_KEY, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
  }
  /** 本次页面加载的导航类型（拿不到就保守地当 navigate，不还原） */
  function navType() {
    try {
      const list = performance.getEntriesByType && performance.getEntriesByType('navigation');
      if (list && list[0] && list[0].type) return String(list[0].type);
    } catch (e) { /* 忽略 */ }
    try {
      const t = performance.navigation && performance.navigation.type;
      if (t === 1) return 'reload';
      if (t === 2) return 'back_forward';
    } catch (e) { /* 忽略 */ }
    return 'navigate';
  }
  /**
   * 刷新恢复。两道闸同时命中才还原：
   *   ① 导航类型必须是 reload / back_forward（站内点链接跳转是 navigate，新开标签页也是）；
   *   ② 标签页级标记（sessionStorage）必须存在且 count > 0 —— sessionStorage 的生命周期
   *      正好是「一个标签页 + 它的刷新链」：刷新不丢、换标签页不共享、关掉标签页即消失，
   *      语义完全对得上，而且天然解决「同站开多个标签页各自弹一遍」。
   */
  function autoRestoreIfNeeded() {
    if (!interactionEnabled()) return;
    if (!settings.sessionMemory || !settings.sessionAuto) return;
    if (windows.length) return;
    const nt = navType();
    if (nt !== 'reload' && nt !== 'back_forward') return;
    const mark = tabMarkRead();
    if (!mark || !mark.count) return;
    const key = sessionKey();
    if (mark.key !== key) return;                             // 分区（域名 / 栏目 / 页面）对不上
    const snap = sessionFor(key);
    if (!snap) return;
    if (snap.closed === true) return;                         // 用户主动关掉过全部窗口 → 不弹回来
    if (Date.now() - (snap.time || 0) > 12 * 3600 * 1000) return;
    if (snap.list.length < 1) return;
    restoreSession(null, { session: snap, silent: true });
    const last = windows[windows.length - 1];
    if (last) toast(last, '已恢复刷新前的 ' + windows.length + ' 个预览窗口（可在设置里关闭）');
  }

  /* ==================================================================================
   *  §17 拖拽 / 缩放
   * ================================================================================== */
  let snapSig = '';
  function checkSnap(rect, dx, dy) {
    let snap = null;
    if (settings.snapEnabled) {
      const v = viewport(), margin = 20;
      if (rect.x + dx < margin) snap = { x: 0, y: 0, w: v.w / 2, h: v.h };
      else if (rect.x + rect.w + dx > v.w - margin) snap = { x: v.w / 2, y: 0, w: v.w / 2, h: v.h };
      else if (rect.y + dy < margin) snap = { x: 0, y: 0, w: v.w, h: v.h };
    }
    // 只有目标矩形真的变了才写样式（旧版每次 mousemove 都写 4 个内联值，
    // 而且关掉吸附后不会隐藏提示框，会残留）
    const ind = shell && shell.snapIndicator;
    if (ind) {
      const sig = snap ? (snap.x + ',' + snap.y + ',' + snap.w + ',' + snap.h) : '';
      if (sig !== snapSig) {
        snapSig = sig;
        if (snap) {
          ind.style.left = snap.x + 'px';
          ind.style.top = snap.y + 'px';
          ind.style.width = snap.w + 'px';
          ind.style.height = snap.h + 'px';
          ind.style.display = 'block';
        } else {
          ind.style.display = 'none';
        }
      }
    }
    return snap;
  }
  function startGesture(item, event, direction) {
    if (event.button !== 0 || gesture || item.closed || isEffPip(item)) return;
    focusWindow(item);
    if (item.animation) { try { item.animation.cancel(); } catch (e) { /* 忽略 */ } item.animation = null; }
    if (item.ui.win.style.transformOrigin !== 'top left') item.ui.win.style.transformOrigin = 'top left';
    if (launcher) launcher.hide();
    gesture = { item, direction, x: event.clientX, y: event.clientY, rect: Object.assign({}, item.rect), moved: false };
    for (const w of windows) w.ui.shield.hidden = false;
    item.ui.win.classList.add('interacting');
    bindGestureListeners();
    // 拖拽时禁止页面选中文本（只在窗口上加 user-select:none 的话，拖到页面上仍会选中文字）
    try {
      gesture.prevUserSelect = document.documentElement.style.getPropertyValue('user-select');
      document.documentElement.style.setProperty('user-select', 'none', 'important');
    } catch (e) { /* 忽略 */ }
    event.preventDefault();
  }
  let gestureRAF = 0;
  /**
   * 把一次手势的几何计算 + DOM 写入合并到每帧一次。
   * 旧版在 mousemove 里同步算 + 同步写 left/top/width/height，高刷鼠标下一秒可能写 120 次，
   * 每次都触发一次强制布局；现在同一帧内只落一次。
   */
  function applyGestureFrame() {
    gestureRAF = 0;
    const g = gesture;
    if (!g || g.px === undefined) return;
    const item = g.item;
    if (item.closed) return;
    const r = g.rect, dx = g.px - g.x, dy = g.py - g.y;
    if (!g.direction) {
      const snap = checkSnap(r, dx, dy);
      item.rect = (snap && g.moved) ? fit(snap) : fit(Object.assign({}, r, { x: r.x + dx, y: r.y + dy }));
    } else {
      const v = viewport(), margin = 8, minW = 280, minH = 220;
      let left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
      if (g.direction.indexOf('w') >= 0) left = clamp(r.x + dx, margin, right - minW);
      if (g.direction.indexOf('e') >= 0) right = clamp(r.x + r.w + dx, left + minW, v.w - margin);
      if (g.direction.indexOf('n') >= 0) top = clamp(r.y + dy, margin, bottom - minH);
      if (g.direction.indexOf('s') >= 0) bottom = clamp(r.y + r.h + dy, top + minH, v.h - margin);
      item.rect = fit({ x: left, y: top, w: right - left, h: bottom - top });
    }
    renderGeometry(item);
  }
  function moveGesture(event) {
    if (!gesture) return;
    if (!(event.buttons & 1)) { finishGesture(); return; }
    const g = gesture;
    if (g.item.closed) { finishGesture(); return; }
    if (Math.abs(event.clientX - g.x) + Math.abs(event.clientY - g.y) > 2) g.moved = true;
    g.px = event.clientX;
    g.py = event.clientY;
    if (!gestureRAF) gestureRAF = requestAnimationFrame(applyGestureFrame);
    event.preventDefault();
  }
  function finishGesture() {
    unbindGestureListeners();
    // 松手前先把最后一帧补上，保证落点和最后一次鼠标位置一致（否则窗口会差一帧）
    if (gestureRAF) { cancelAnimationFrame(gestureRAF); gestureRAF = 0; applyGestureFrame(); }
    if (!gesture) return;
    const old = gesture;
    gesture = null;
    snapSig = '';
    if (shell) {
      shell.snapIndicator.style.display = 'none';
      for (const item of windows) if (!item.closed) item.ui.shield.hidden = item.ui.panel.hidden;
    }
    if (!old.item.closed) old.item.ui.win.classList.remove('interacting');
    try {
      if (old.prevUserSelect) document.documentElement.style.setProperty('user-select', old.prevUserSelect);
      else document.documentElement.style.removeProperty('user-select');
    } catch (e) { /* 忽略 */ }
    if (old.moved && !old.item.closed) saveLayout(old.item);
  }
  /**
   * 拖拽 / 缩放期间才挂全局移动监听。
   * 常驻捕获阶段监听的话，页面上每一次 mousemove 都要先派发到我们这里再往下走，
   * 而窗口拖拽本身是低频操作，所以改成「按下时挂、松手即摘」。
   */
  let gestureBound = false;
  function bindGestureListeners() {
    if (gestureBound) return;
    gestureBound = true;
    window.addEventListener('mousemove', moveGesture, true);
    window.addEventListener('mouseup', finishGesture, true);
    window.addEventListener('pointerup', finishGesture, true);
    window.addEventListener('dragend', finishGesture, true);
    window.addEventListener('blur', finishGesture);
  }
  function unbindGestureListeners() {
    if (!gestureBound) return;
    gestureBound = false;
    window.removeEventListener('mousemove', moveGesture, true);
    window.removeEventListener('mouseup', finishGesture, true);
    window.removeEventListener('pointerup', finishGesture, true);
    window.removeEventListener('dragend', finishGesture, true);
    window.removeEventListener('blur', finishGesture);
  }

  /* ==================================================================================
   *  §18 宿主接入
   * ================================================================================== */
  /**
   * 刚刚由手势（拖拽 / 长按 / Alt 点击）浮出过的地址。
   * 场景：按住链接拖拽时，浏览器的原生拖拽可能先一步启动，于是「手势补发」与
   * 「松手 drop」会对同一个地址各开一次窗 —— 用户看到两个一模一样的预览窗。
   * 这里记一笔时间戳，drop 时把 1.5 秒内刚由手势开过的地址跳过。
   */
  const recentlyPreviewed = new Map();
  function markPreviewed(url) {
    if (!url) return;
    const now = Date.now();
    recentlyPreviewed.set(url, now);
    if (recentlyPreviewed.size > 40) {
      for (const [k, v] of recentlyPreviewed) if (now - v > 6000) recentlyPreviewed.delete(k);
    }
  }
  function wasJustPreviewed(url) {
    const t = recentlyPreviewed.get(url);
    return !!t && (Date.now() - t) < 1500;
  }
  /**
   * A summary is a page-side companion, not a modal preview.  Its backdrop is
   * transparent and pointer-events:none, so treating it as modal used to block
   * every new link drag / image drag / hover preview while a summary stayed
   * open.  Bare settings/help windows are still modal and intentionally block.
   */
  function isPersistentSummary(item) {
    return !!(item && (item.summaryProtected
      || (item.ui && item.ui.win && item.ui.win.classList.contains('summary-window'))));
  }
  function pageInteractionAllowed(event) {
    if (typeof interactionEnabled === 'function' && !interactionEnabled()) return false;
    return !gesture && !targetInHost(event, shell && shell.host)
      && !windows.some(w => !w.closed && !w.pinned && !isEffPip(w) && !isPersistentSummary(w));
  }

  /* ==================================================================================
   *  §18b 悬停迷你预览（v20）
   *  ──────────────────────────────────────────────────────────────────────────────────
   *  鼠标在链接上停留超过阈值（settings.hoverDelay，默认 600ms）→ 弹出迷你小窗：
   *  26px 标题条（标题 · 域名 · favicon）+ 一屏窗口的**略缩图**。略缩图的实现是把
   *  iframe 按「窗口内容区的逻辑尺寸」（desktopWidth × (desktopHeight − 标题栏)，
   *  默认 1000×668）渲染，再由 .peek-stage 的 transform: scale() 整体缩进小窗 ——
   *  看到的是整屏窗口，而不是页面左上角的一角裁切；比例跟随设置的窗口宽高比。
   *  小窗是「略缩图」不是可操作界面：略缩区盖了一层透明挡板，点击一律开完整预览
   *  （也顺手拦住页内滚动/点击在小窗里误触）。
   *  生命周期：
   *    · mouseover 命中链接 → peekHover：起阈值定时器；停 350ms 先预热（warmLink）；
   *    · 离开链接 → peekLeave：200ms 宽限后淡出（给「移进小窗本身」留路）；
   *    · 点击小窗 → 以该链接打开完整预览（openWindow 会顺手 peekHide）；
   *    · 滚动 / 任意 mousedown / Esc / 窗口失焦 / 标签页隐藏 → 立即收起；
   *    · 收起时把 iframe 导航到 about:blank（peekStopFrame）—— 小窗只是 hidden 的话，
   *      页面与其中的视频会继续在后台跑，用户报的「小窗收了视频还在播」即由此而来；
   *      跨域 iframe 拿不到内部 DOM，导航走人是最可靠的停播手段。
   *  声音（v20.2 重做，起因是用户实测「设了不自动播放，小窗里照样有声音」）：
   *    · 先把话说清楚：权限策略（allow="autoplay 'none'"）只管「有没有用户手势」这一关。
   *      浏览器另有两条永远放行的路 —— 静音自动播放永远允许（所以「先静音起播、再立刻
   *      取消静音」这种站点手法绕过了整套策略），以及浏览器认定「用户与该域名互动过 /
   *      该域名 MEI 超阈值」时直接放行有声播放。
   *    · 更要命的是小窗里的页面是**跨域**的：父页拿不到它的 DOM，点不了暂停、也调不了
   *      音量（HTMLIFrameElement.mute() 只有 Firefox 曾实现）。所以「静音但继续播」
   *      在跨域场景下做不到，能做的只有「改变加载什么」与「让它别活着」。
   *    · 因此设置项 peekVideo 三档：block（默认，拒绝 autoplay 权限）/ allow（不干预）/
   *      snapshot（静音快照 —— 抓回 HTML 后删掉全部脚本与音视频元素，结构上无可发声之物，
   *      绝对无声）；另有标题条上的「停止播放 / 恢复」按钮做一次性兜底（卸载 iframe，
   *      一定生效）。三者的取舍都写在 §1 的常量注释与使用说明里。
   *  只在顶层页面生效：预览窗口内部不嵌套弹小窗（开销与视觉都会失控），
   *  子框架里已有的浮出按钮不受影响。
   * ================================================================================== */
  let peekEl = null;          // 小窗根节点（shell 影子根里，随 shell 重建重新查询）
  let peekLink = null;        // 当前正在展示的链接
  let peekPending = null;     // 等待阈值中的链接
  let peekTimer = 0;          // 阈值定时器
  let peekHideTimer = 0;      // 离开宽限定时器
  let peekGoneTimer = 0;      // 淡出收尾定时器
  let peekWarmTimer = 0;      // 预热定时器
  let peekWarmUrl = '';       // 最近一次已安排预热的地址（去重）
  let peekBoxW = PEEK_W;                          // 小窗当前宽度（随窗口宽高比变）
  let peekBoxH = PEEK_HEAD_H + PEEK_MAX_BODY_H;   // 小窗当前总高（标题条 + 略缩图区）
  let peekMuted = false;      // v20.2：本次小窗是否已被「停止播放」按停（只作用于当前这次）
  let peekSnapUrl = '';       // 当前静音快照的 blob 地址（换新的先撤销旧的）
  let peekSnapUrlFor = '';    // peekSnapUrl 对应的原始页面地址（同址重开就不重建 blob）
  let peekSnapCache = [];     // 静音快照缓存：[{url, html}]，最多 PEEK_SNAP_MAX 条
  let peekSnapWaits = {};     // 抓取中的地址 → 等待回调数组（同一地址只抓一次）

  function peekDom() {
    if (peekEl && peekEl.isConnected) return peekEl;
    // 一个窗口都没开、浮出按钮也关着的时候 shell 可能还不存在 —— 小窗要自己把它建起来，
    // 否则「悬停预览」在干净页面上会静默失效（用户报的那种「设了没反应」）
    ensureShell();
    if (!shell || !shell.root) return null;
    const node = shell.root.querySelector('.hover-peek');
    if (!node) return null;
    // shell 重建过（宿主被摘掉又挂回来）：旧节点连同它的 iframe 一起作废，
    // 缓存的链接与定时器必须一并清掉，否则后续会对一个已不在文档里的节点操作
    if (node !== peekEl) {
      peekEl = node;
      peekLink = null;
      peekPending = null;
      clearTimeout(peekGoneTimer); peekGoneTimer = 0;
    }
    peekEl.addEventListener('mouseenter', () => { clearTimeout(peekHideTimer); peekHideTimer = 0; });
    peekEl.addEventListener('mouseleave', () => { peekScheduleHide(160); });
    // 点击小窗任意位置（含标题条与右上角按钮）都打开完整预览；
    // 「停止播放」按钮必须自己吃掉事件，否则会连带开一个完整预览
    const muteBtn = peekEl.querySelector('.peek-mute');
    if (muteBtn) muteBtn.addEventListener('click', ev => { ev.stopPropagation(); peekToggleMute(); });
    peekEl.addEventListener('click', () => {
      const link = peekLink;
      peekHide(true);
      if (!link || !link.element.isConnected) return;
      markPreviewed(link.url);
      openWindow(link.url, link.title, null, peekPointFor(link));
    });
    return peekEl;
  }
  /**
   * 把小窗 iframe 导航到 about:blank —— 原文档连同它的 <video>/<audio> 一起销毁。
   *
   * 这是「小窗收了但视频还在后台播」的唯一可靠解法：小窗只是 hidden 的话，iframe 文档
   * 照旧活着、媒体照旧解码出声；而小窗里的页面是跨域的，拿不到它的 DOM，没法点暂停或静音。
   * 导航走人则一定生效，顺带把页面的定时器、网络请求、内存一起回收。
   * 代价是下次悬停要重新加载 —— 预热（warmLink）已经把网络这一段铺好了。
   */
  function peekStopFrame() {
    const el = peekEl;
    if (!el) return;
    const frame = el.querySelector('.peek-frame');
    if (!frame || frame.getAttribute('src') === 'about:blank') return;
    try { frame.setAttribute('src', 'about:blank'); } catch (e) { /* 忽略 */ }
  }
  /** 设置项 peekVideo 归一化后的档位（存档里的脏值一律落回默认的 block） */
  function peekKind() {
    const v = settings.peekVideo;
    return (v === 'allow' || v === 'snapshot') ? v : 'block';
  }
  /** 当前档位对应的 iframe allow 取值 */
  function peekAllowValue() { return peekKind() === 'allow' ? PEEK_ALLOW_OPEN : PEEK_ALLOW_BLOCK; }
  /** 当前档位对应的 iframe sandbox：静音快照走只读版（无 allow-scripts / 无 allow-same-origin） */
  function peekSandboxValue() { return peekKind() === 'snapshot' ? SNAPSHOT_SANDBOX : FULL_SANDBOX; }
  /** 占位层：停声说明 / 快照生成中 / 快照失败都走它。空文本 = 收起 */
  function peekNote(text) {
    const el = peekEl;
    if (!el) return;
    const box = el.querySelector('.peek-note');
    if (!box) return;
    const span = box.querySelector('.peek-note-text');
    if (span && span.textContent !== text) span.textContent = text;
    box.hidden = !text;
  }
  function peekNoteHide() { peekNote(''); }
  /* ---- 静音快照（peekVideo = 'snapshot'）--------------------------------------------
   * 用户实测「设了不自动播放还是有声音」之后加的第三档。做法与「禁止嵌入站点」的
   * 只读快照同源：GM_xmlhttpRequest 把页面 HTML 抓回来（脚本特权，不受 CORS 限制），
   * 然后**额外**做两件事，让它绝对发不出声：
   *   ① 删掉全部 <script>/<noscript>（配合 SNAPSHOT_SANDBOX 没有 allow-scripts，
   *      页面自己的播放器逻辑根本不会启动）；
   *   ② 删掉全部 <video>/<audio>/<source>/<track>/<embed>/<object>，并把内嵌播放器
   *      （<iframe>，多数站点的视频本体）换成同尺寸的灰色占位块 —— 连原生
   *      autoplay 属性这条「不需要 JS 也会播」的路也一并堵死。
   * 于是「结构上不存在能发声的东西」→ 100% 无声、100% 不自动播放，也不再需要
   * peekStopFrame 去救火。代价是小窗是静态首屏：纯 JS 渲染的站点会显示不全，
   * 这种时候老实显示提示文案，而不是退回实时页面（那会把「绝对无声」的承诺打破）。
   * 抓取结果按 URL 缓存最近 PEEK_SNAP_MAX 条，同一地址只抓一次；
   * 悬停 350ms 的预热阶段就会发起抓取，所以正式弹出时通常已经命中缓存。
   * --------------------------------------------------------------------------------- */
  function peekSnapFind(url) {
    for (let i = 0; i < peekSnapCache.length; i++) {
      if (peekSnapCache[i].url === url) return peekSnapCache[i].html;
    }
    return '';
  }
  /** 抓取（或命中缓存）+清洗，拿到清洗后的 HTML；失败回调空字符串 */
  function peekSnapFetch(url, onReady) {
    const hit = peekSnapFind(url);
    if (hit) { if (onReady) onReady(hit); return; }
    const waiting = peekSnapWaits[url];
    if (waiting) { if (onReady) waiting.push(onReady); return; }
    peekSnapWaits[url] = onReady ? [onReady] : [];
    const settle = html => {
      const list = peekSnapWaits[url];
      delete peekSnapWaits[url];
      if (html) {
        peekSnapCache.push({ url: url, html: html });
        while (peekSnapCache.length > PEEK_SNAP_MAX) peekSnapCache.shift();
      }
      const q = list || [];
      for (let i = 0; i < q.length; i++) {
        try { q[i](html || ''); } catch (e) { /* 单个等待者出错不影响其他 */ }
      }
    };
    fetchPageText(url, (text, status) => {
      let clean = '';
      // 4xx/5xx 也走「拿不到内容」这条路：错误页渲染出来只会是一张空壳
      if (text && !(status >= 400)) { try { clean = peekSnapBuild(text, url); } catch (e) { clean = ''; } }
      settle(clean);
    }, () => settle(''));
  }
  /** 页面 HTML → 绝对无声的静态快照 HTML（清洗完仍可能为空，交给调用方兜底） */
  function peekSnapBuild(text, url) {
    const doc = snapshotDoc(text, url);
    if (!doc) return '';
    try {
      doc.querySelectorAll('script,noscript').forEach(n => n.remove());
      // 媒体元素：直接移除（留着任何一个都可能自己出声）
      doc.querySelectorAll('video,audio,source,track,embed,object,param').forEach(n => n.remove());
      // 任何漏网的 autoplay 声明（自定义元素上的）也一并摘掉
      doc.querySelectorAll('[autoplay]').forEach(n => n.removeAttribute('autoplay'));
      // 内嵌播放器：换成同尺寸占位块，尽量保住原来的排版骨架
      doc.querySelectorAll('iframe,frame').forEach(n => {
        const box = doc.createElement('div');
        const w = n.getAttribute('width');
        const h = n.getAttribute('height');
        const st = n.getAttribute('style') || '';
        let css = 'background:rgba(128,128,128,.14);border-radius:6px;box-sizing:border-box;';
        if (w && /^\d+$/.test(w)) css += 'width:' + w + 'px;';
        if (h && /^\d+$/.test(h)) css += 'height:' + h + 'px;';
        box.setAttribute('style', css + st);
        try { n.parentNode.replaceChild(box, n); } catch (e) { try { n.remove(); } catch (e2) { /* 忽略 */ } }
      });
      absolutize(doc, url);
    } catch (e) { /* 清洗失败就按原样渲染，总比不上强 —— 仍无脚本可跑 */ }
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }
  /** 渲染静音快照到小窗（异步；期间显示占位层，避免上一份内容挂在里面继续响） */
  function peekSnapRender(link) {
    const el = peekEl;
    if (!el) return;
    const frame = el.querySelector('.peek-frame');
    if (!frame) return;
    // 同一地址的 blob 还在，直接复用 —— 免得「移开又移回」时闪一下
    if (peekSnapUrl && peekSnapUrlFor === link.url) {
      try { if (frame.getAttribute('src') !== peekSnapUrl) frame.setAttribute('src', peekSnapUrl); } catch (e) { /* 忽略 */ }
      peekNoteHide();
      return;
    }
    peekNote('正在生成静音快照…');
    peekSnapFetch(link.url, html => {
      // 抓取期间小窗可能已经收起 / 换了链接 —— 那就整个丢弃，连 blob 都不建
      if (!peekEl || peekEl.hidden || !peekLink || peekLink.url !== link.url) return;
      const f = peekEl.querySelector('.peek-frame');
      if (!f) return;
      if (!html) { peekNote('该站点无法生成静音快照\n点小窗打开完整预览'); return; }
      let url = '';
      try { url = window.URL.createObjectURL(new window.Blob([html], { type: 'text/html' })); }
      catch (e) { url = ''; }
      if (!url) { peekNote('该站点无法生成静音快照\n点小窗打开完整预览'); return; }
      if (peekSnapUrl) { try { window.URL.revokeObjectURL(peekSnapUrl); } catch (e) { /* 忽略 */ } }
      peekSnapUrl = url;
      peekSnapUrlFor = link.url;
      try { f.setAttribute('src', url); } catch (e) { /* 忽略 */ }
      peekNoteHide();
    });
  }
  /** 按钮外观跟着状态走：有声音时显示「停声」图标，已停声时显示「恢复播放」图标 */
  function peekMutePaint() {
    const el = peekEl;
    if (!el) return;
    const btn = el.querySelector('.peek-mute');
    if (!btn) return;
    btn.hidden = peekKind() === 'snapshot';   // 静音快照档本来就发不出声，不需要这个按钮
    btn.innerHTML = icon(peekMuted ? 'play' : 'mute');
    btn.title = peekMuted ? '恢复播放' : '停止播放（静音）';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('selected', peekMuted);
  }
  /** 停止播放：把 iframe 卸成 about:blank（媒体一定停），略缩区换成占位说明 */
  function peekStop() {
    peekMuted = true;
    peekStopFrame();
    peekNote('已停止播放\n点小窗打开完整预览');
    peekMutePaint();
  }
  /** 恢复播放：按当前档位重新加载（静音快照档会重新挂回快照 blob） */
  function peekResume() {
    const link = peekLink;
    const el = peekEl;
    if (!link || !el) return;
    peekMuted = false;
    peekMutePaint();
    const frame = el.querySelector('.peek-frame');
    if (!frame) return;
    if (peekKind() === 'snapshot') { peekNoteHide(); peekSnapRender(link); return; }
    peekNoteHide();
    try { frame.setAttribute('src', link.url); } catch (e) { /* 忽略 */ }
  }
  /** 标题条「停止播放 / 恢复播放」按钮（只作用于当前这次小窗，不写进设置） */
  function peekToggleMute() {
    const el = peekEl;
    if (!el || el.hidden || !peekLink) return;
    if (peekKind() === 'snapshot') return;
    clearTimeout(peekHideTimer); peekHideTimer = 0;
    if (peekMuted) peekResume(); else peekStop();
  }
  function peekPointFor(link) {
    try {
      const r = link.element.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.min(r.bottom + 20, r.bottom + r.height / 2 + 30)) };
    } catch (e) { return undefined; }
  }
  function peekHide(now) {
    clearTimeout(peekTimer); peekTimer = 0;
    clearTimeout(peekHideTimer); peekHideTimer = 0;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    peekWarmUrl = '';
    peekPending = null;
    peekLink = null;
    if (!peekEl) return;
    if (now) {
      clearTimeout(peekGoneTimer); peekGoneTimer = 0;
      peekEl.classList.remove('show');
      peekEl.hidden = true;
      peekStopFrame();   // 立即卸掉 iframe：不给媒体留后台播放的机会
      return;
    }
    if (peekEl.hidden) return;
    peekEl.classList.remove('show');
    clearTimeout(peekGoneTimer);
    peekGoneTimer = setTimeout(() => {
      peekGoneTimer = 0;
      if (peekEl && !peekLink) {
        peekEl.hidden = true;
        // 淡出（200ms）走完才卸 iframe —— 过程里略缩图还在，不会闪成空白
        peekStopFrame();
      }
    }, 200);
  }
  function peekScheduleHide(delay) {
    if (!peekEl || peekEl.hidden || !peekLink) return;
    clearTimeout(peekHideTimer);
    peekHideTimer = setTimeout(() => peekHide(false), delay === undefined ? 200 : delay);
  }
  /** 贴着链接放置：优先右下方，放不下换上方，再不行贴边 */
  function peekPlace(link) {
    const el = peekDom();
    if (!el) return false;
    let r = null;
    try { r = link.element.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || !(r.width > 0 || r.height > 0)) return false;
    const v = viewport(), totalH = peekBoxH, boxW = peekBoxW;
    const left = clamp(r.left, 8, Math.max(8, v.w - boxW - 8));
    let top = r.bottom + 8;
    if (top + totalH > v.h - 8) top = r.top - totalH - 8;
    if (top < 8) top = clamp(r.bottom + 8, 8, Math.max(8, v.h - totalH - 8));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    return true;
  }
  function peekShow(link) {
    if (!settings.hoverPeek || !interactionEnabled() || !link.element.isConnected) return;
    // 手势进行中 / 存在模态预览时绝不弹（backdrop 已经盖住了页面，这时弹出只会突兀）。
    // 持久 AI 总结窗是无遮罩的伴生面板，不应拦住悬停预览。
    if (gesture || windows.some(w => !w.closed && !w.pinned && !isEffPip(w) && !isPersistentSummary(w))) return;
    const el = peekDom();
    if (!el) return;
    // 上一次淡出的收尾定时器可能还挂着（快速「移出→再移回」时），此时它会把刚显示的
    // 小窗又 hidden 掉 —— 先清掉再展示
    clearTimeout(peekGoneTimer); peekGoneTimer = 0;
    peekLink = link;
    const title = el.querySelector('.peek-title');
    if (title) {
      let host = link.url;
      try { host = new window.URL(link.url).hostname; } catch (e) { /* 保留原值 */ }
      const text = (link.title ? link.title + ' · ' : '') + host;
      if (title.textContent !== text) title.textContent = text;
      title.title = link.url;
      // favicon 与标题栏同一套候选逻辑（只要第一级，小窗不值得做三级兜底）
      const list = settings.favicon ? faviconCandidates(link.url) : [];
      let img = title.previousElementSibling;
      if (img && img.tagName !== 'IMG') img = null;
      if (list.length) {
        if (!img) { img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; title.parentNode.insertBefore(img, title); }
        if (img.getAttribute('src') !== list[0]) img.setAttribute('src', list[0]);
      } else if (img) img.remove();
    }
    const frame = el.querySelector('.peek-frame');
    // 每次弹出都是一次全新的小窗：「停止播放」的状态不跨小窗保留，想永久不出声请把
    // 设置里的「小窗内视频」设成「静音快照」
    peekMuted = false;
    peekMutePaint();
    if (frame) {
      // 策略先于 src 落定：权限策略与沙箱标志都是随导航生效的，先改 allow / sandbox
      // 再赋 src 才能保证这一轮加载用的是新策略（每次收起都把 src 卸成 about:blank，
      // 所以这里必定是重新导航）。
      const wantAllow = peekAllowValue();
      const wantSandbox = peekSandboxValue();
      if (frame.getAttribute('allow') !== wantAllow) frame.setAttribute('allow', wantAllow);
      if (frame.getAttribute('sandbox') !== wantSandbox) frame.setAttribute('sandbox', wantSandbox);
      if (peekKind() === 'snapshot') {
        // 静音快照：先把上一份实时页面卸掉（它可能正在出声），再由 peekSnapRender 异步填回
        peekStopFrame();
      } else {
        peekNoteHide();
        if (frame.getAttribute('src') !== link.url) {
          try { frame.setAttribute('src', link.url); } catch (e) { /* 忽略 */ }
        }
      }
    }
    // 略缩图几何：iframe 以「窗口内容区的逻辑尺寸」渲染（默认 1000×668，与真实窗口
    // 一致 → 页面按桌面版式排版），再由 stage 的 scale 整体缩到小窗里。于是小窗呈现的是
    // 「完整一屏窗口的略缩」，而不是页面左上角的一角裁切；比例按窗口宽高比走，
    // 高窗/宽窗都不会变形。
    const refW = clampNum(settings.desktopWidth, RANGES.desktopWidth[0], RANGES.desktopWidth[1], 1000, true);
    const fullH = clampNum(settings.desktopHeight, RANGES.desktopHeight[0], RANGES.desktopHeight[1], 720, true);
    const refH = Math.max(160, fullH - PEEK_REF_CHROME_H);
    const k = Math.min(PEEK_W / refW, PEEK_MAX_BODY_H / refH);
    const bodyW = Math.max(120, Math.round(refW * k));
    const bodyH = Math.max(80, Math.round(refH * k));
    // 外壳是 border-box（全局 box-sizing:border-box），1px 描边要额外让出 2px，
    // 否则略缩图右侧/底部会被 overflow:hidden 裁掉 2px
    peekBoxW = bodyW + 2;
    peekBoxH = PEEK_HEAD_H + bodyH + 2;
    const body = el.querySelector('.peek-body');
    const stage = el.querySelector('.peek-stage');
    if (body) {
      body.style.width = bodyW + 'px';
      body.style.height = bodyH + 'px';
    }
    if (stage) {
      stage.style.width = refW + 'px';
      stage.style.height = refH + 'px';
      stage.style.transform = 'scale(' + k + ')';
    }
    el.style.width = peekBoxW + 'px';
    if (frame) {
      frame.style.width = refW + 'px';
      frame.style.height = refH + 'px';
    }
    if (!peekPlace(link)) { peekHide(true); return; }
    clearTimeout(peekHideTimer); peekHideTimer = 0;
    if (el.hidden) {
      el.hidden = false;
      Number(el.offsetHeight);   // 强制一次重排，让 hidden→可见的过渡真的播
    }
    el.classList.add('show');
    // 静音快照档：内容要等抓取回来才能填 —— 放到最后（小窗已经可见）再发起，
    // 否则异步回调里那句「peekEl.hidden」判断会在还没 show 的时候把结果丢掉
    if (peekKind() === 'snapshot') peekSnapRender(link);
  }
  /** mouseover 命中链接：安排阈值 / 预热；同一个链接上移动走 O(1) 快路径 */
  function peekHover(link) {
    if (!settings.hoverPeek || !interactionEnabled()) { peekLeave(); return; }
    // 正在展示同一个链接：链接内移动，位置跟着锚点微调即可
    if (peekLink && peekLink.element === link.element && peekLink.element.isConnected
      && peekEl && !peekEl.hidden) {
      clearTimeout(peekHideTimer); peekHideTimer = 0;
      peekPlace(link);
      peekArmWarm(link);
      return;
    }
    // 已在等同一个链接：不重置定时器（避免在链接内蹭来蹭去永远等不到阈值）
    if (peekPending && peekPending.element === link.element) { peekArmWarm(link); return; }
    // 换了链接：旧小窗立即收起。  v21 bugfix: 旧版这里调用
    // peekScheduleHide(140)，140ms 后 peekHide() 会把「新链接刚设好的
    // peekTimer/peekPending」一并清掉 —— 从 A 快速移到 B 时 B 永远不会弹出。
    clearTimeout(peekTimer);
    if (peekEl && !peekEl.hidden && peekLink && peekLink.element !== link.element) peekHide(true);
    peekPending = link;
    peekTimer = setTimeout(() => {
      peekTimer = 0;
      const cur = peekPending;
      peekPending = null;
      if (cur) peekShow(cur);
    }, clampNum(settings.hoverDelay, 200, 2000, 600, true));
    peekArmWarm(link);
  }
  /** 悬停 350ms 即预热：preconnect + prefetch（完整预览 / 小窗命中缓存），
      静音快照档还要额外把 HTML 抓回来清洗好 —— 这样小窗弹出时几乎不用等。
      注意这里不再拿 settings.warmup 直接早退：warmLink 自己会判断该开关，
      而静音快照是「不抓就没有内容」，不该被那个开关一起关掉。 */
  function peekArmWarm(link) {
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
  }
  /** mouseover 离开链接：取消等待中的阈值，已显示的给一点宽限再收 */
  function peekLeave() {
    clearTimeout(peekTimer); peekTimer = 0;
    peekPending = null;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    // v21 bugfix: 清掉预热定时器后必须同时清掉去重键，否则移开再移回同一
    // 链接时会命中 `link.url === peekWarmUrl` 早退，预热永远不会再发生。
    peekWarmUrl = '';
    if (peekEl && !peekEl.hidden) peekScheduleHide(200);
  }

  installLinkDrag(pageInteractionAllowed,
    (link, event) => {
      markPreviewed(link.url);
      openWindow(link.url, link.title, null, { x: event.clientX, y: event.clientY });
    },
    () => settings.threshold, () => settings.longPressDelay, () => settings.dragHold, () => settings,
    // v20.2.3：stage === 'press' 时只建连接，绝不下载整页（详见 warmLink 的说明）
    (link, stage) => warmLink(link.url, stage));

  launcher = installLauncher({
    isEnabled: () => (settings.linkButton || (settings.aiQuick && aiQuickAllowed())) && interactionEnabled(),
    isPreviewEnabled: () => settings.linkButton,
    isAIEnabled: () => settings.aiQuick && aiQuickAllowed(),
    // 旧版这里传的是 { clientX, clientY }，而 openWindow 读 point.x / point.y，
    // 于是点浮出按钮开出来的窗口永远落在「默认位置」而不是指针处
    onLaunch: (link, p) => {
      markPreviewed(link.url);
      return openWindow(link.url, link.title, null, {
        x: p && Number.isFinite(p.x) ? p.x : undefined,
        y: p && Number.isFinite(p.y) ? p.y : undefined
      });
    },
    onAskAI: (link, p) => openQuickAISummary(link.url, link.title, p),
    mount: () => { ensureShell(); return shell ? { root: shell.root, host: shell.host } : null; }
  });
  launcher.setTheme(prefersDark());

  refreshShortcuts();
  scheduleThemeSettle();
  /* v20.2.3：这里**不再**在页面加载期排队建壳。
     v20.2.2 这么做过 —— 代价是每一个被匹配到的页面（无论用户有没有用过预览）都会在
     加载期挂上一个全屏 fixed + isolation 的层并重算一次取色。对普通浏览是净负担，
     用户报的「更卡了」可能就包含它。改成「指针第一次碰到链接时」再排队，见
     scheduleShellWarm 的说明与下面 mouseover 分支里的调用点。 */
  whenStoreReady(() => {
    // 扩展环境下 chrome.storage 是异步的：首屏可能用默认值初始化，读到真实配置后要重新应用一遍
    if (HAS.extStore) reloadFromStore();
    refreshShortcuts();
    invalidateThemeSample();
    syncThemeObserver();
    setTimeout(() => { try { autoRestoreIfNeeded(); } catch (e) { /* 忽略 */ } }, 260);
  });
  // document-start 时还没有 body，等 body 出来再给主题观察器补一个目标
  if (!document.body) document.addEventListener('DOMContentLoaded', syncThemeObserver, { once: true });

  /** 扩展环境：存储异步就绪后重新套用一遍配置 */
  function reloadFromStore() {
    try {
      const fresh = readStore(SETTINGS_KEY, {});
      if (isObj(fresh) && Object.keys(fresh).length) {
        settings = Object.assign({}, DEFAULTS, fresh);
        normalizeSettings();
        migrateSchema();   // 扩展环境：存储异步就绪后补跑一次架构迁移
      }
      aiConfig = Object.assign({}, DEFAULT_AI_CONFIG, readStore(AI_CONFIG_KEY, {}));
      if (aiConfig.mediaEndpoint && /chat\/completions/i.test(aiConfig.mediaEndpoint)) { aiConfig.mediaEndpoint = 'https://api.siliconflow.cn/v1/audio/transcriptions'; if (!aiConfig.mediaModel || /Qwen3-Omni/i.test(String(aiConfig.mediaModel || ''))) aiConfig.mediaModel = 'FunAudioLLM/SenseVoiceSmall'; }
      const freshLayouts = readStore(LAYOUTS_KEY, {});
      if (isObj(freshLayouts)) layouts = freshLayouts;
      const freshHistory = readStore(HISTORY_KEY, []);
      if (Array.isArray(freshHistory)) history = freshHistory;
      sessions = readStore(SESSIONS_KEY, {});
      if (shell) applySettings(true);
    } catch (e) { /* 忽略 */ }
  }

  /* ---- 拖放链接 / 网址到页面：直接浮出预览 ------------------------------------------ */
  function hasUrlPayload(dt) {
    if (!dt || window.__LPS_TEXT_DRAG__) return false;
    const types = Array.from(dt.types || []);
    return types.indexOf('text/uri-list') >= 0 || types.indexOf('text/x-moz-url') >= 0 || types.indexOf('text/plain') >= 0;
  }
  /** 提示层挂在宿主影子根里，颜色全部由取色引擎供（压暗用 --scrim，卡片用玻璃配方） */
  function showDropOverlay(show) {
    if (show) {
      ensureShell();
      if (!shell) return;
      dragOverlay = shell.root.querySelector('.drop-overlay');
      if (!dragOverlay) return;
      dragOverlay.hidden = false;
    } else {
      const node = (shell && shell.root.querySelector('.drop-overlay')) || dragOverlay;
      if (node) node.hidden = true;
      dragOverlay = null;
    }
  }
  /* 拖放提示层的看门狗。
     旧版只看 dragenter / dragleave 的计数，可浏览器并不保证一定派发 dragleave：
     松手落在预览窗口的 iframe 里、或者拖到标签栏外再松手，宿主页面一个事件都收不到，
     计数永远减不回 0 —— 「松手即在此页浮出预览」那层提示就永远贴在页面上（用户报的
     另一个现象）。现在每次 dragenter / dragover 都续一次期，长时间没有新的拖拽事件
     就把提示层收干净；dragend / drop / pagehide 也都会直接收尾。 */
  const DRAG_IDLE_MS = 900;
  let dragWatchTimer = 0;
  let dragWatchAt = 0;
  function armDragWatchdog() {
    // dragover 在高刷下可能每帧都来，别每次都拆掉重建定时器：300ms 内只续一次
    const now = performance.now();
    if (dragWatchTimer && now - dragWatchAt < 300) return;
    dragWatchAt = now;
    clearTimeout(dragWatchTimer);
    dragWatchTimer = setTimeout(endDropSession, DRAG_IDLE_MS);
  }
  function endDropSession() {
    clearTimeout(dragWatchTimer);
    dragWatchTimer = 0;
    dropDepth = 0;
    showDropOverlay(false);
  }
  window.addEventListener('dragenter', event => {
    if (!interactionEnabled() || !hasUrlPayload(event.dataTransfer)) return;
    dropDepth++;
    showDropOverlay(true);
    armDragWatchdog();
    event.preventDefault();
  }, true);
  window.addEventListener('dragover', event => {
    if (!interactionEnabled() || !hasUrlPayload(event.dataTransfer)) return;
    try { event.dataTransfer.dropEffect = 'copy'; } catch (e) { /* 忽略 */ }
    armDragWatchdog();
    event.preventDefault();
  }, true);
  window.addEventListener('dragleave', () => {
    if (dropDepth > 0) dropDepth--;
    if (dropDepth <= 0) endDropSession();
  }, true);
  window.addEventListener('drop', event => {
    endDropSession();
    if (window.__LPS_TEXT_DRAG__) {
      window.__LPS_TEXT_DRAG__ = false;
      return;
    }
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
    const dt = event.dataTransfer;
    if (!dt) return;
    let raw = '';
    try { raw = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (e) { raw = ''; }
    if (!raw) return;
    const urls = String(raw).split(/[\r\n]+/).map(t => httpUrl(t.trim())).filter(Boolean);
    if (!urls.length) {
      const single = findUrlInText(raw);
      if (single) urls.push(single);
    }
    if (!urls.length) return;
    // 这个地址刚刚已经由拖拽手势浮出过了（原生拖拽与手势同时命中），跳过，免得开两个一样的窗
    const fresh = urls.filter(u => !wasJustPreviewed(u));
    if (!fresh.length) { event.preventDefault(); return; }
    event.preventDefault();
    let opened = 0;
    for (const u of fresh.slice(0, Math.max(1, settings.maxWindows))) if (openWindow(u)) opened++;
    if (opened) toastStandalone('已浮出 ' + opened + ' 个预览');
  }, true);
  window.addEventListener('dragend', endDropSession, true);

  /* ---- 兜底定时保存窗口组合（pagehide 在个别浏览器不可靠） ---- */
  setInterval(() => {
    if (!settings.sessionMemory || !windows.length) return;
    rememberSession();
  }, 20000);

  /* ---- 同步滚动：主窗口滚动 → 其它窗口（rAF 合并 + 比例去重） ---- */
  let syncRAF = 0, lastSyncRatio = -1;
  function flushSyncScroll() {
    syncRAF = 0;
    if (!settings.syncScroll || !windows.length) return;
    if (syncSource && windows.indexOf(syncSource) < 0) syncSource = null;
    if (!syncSource) syncSource = windows[windows.length - 1] || null;
    const ratio = scrollRatio();
    if (Math.abs(ratio - lastSyncRatio) < 0.0005) return;
    lastSyncRatio = ratio;
    broadcast({ type: 'sync', ratio });
  }
  window.addEventListener('scroll', () => {
    if (!settings.syncScroll || !windows.length || syncRAF) return;
    syncRAF = requestAnimationFrame(flushSyncScroll);
  }, true);

  /* ---- 快捷键 ---- */
  window.addEventListener('keydown', event => {
    if (!settings.shortcuts || !interactionEnabled()) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (isEditingEvent(event)) return;
    const combo = keyCombo(event);
    if (!combo) return;
    const action = shortcutsMap[combo];
    if (!action) return;
    // 先执行，只有动作真的生效了才吞掉事件 ——「一个窗口都没开」时
    // 「恢复上次窗口」恰恰最需要用到，不能一上来就 return。
    if (!runShortcut(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  /* ---- 链接旁浮出按钮：指针进入新元素时才判定一次，命中后 O(1) 保持 ----
     另外对同一个 <a> 做结果缓存：鼠标在链接内部的子元素间移动会连着触发好几次 mouseover，
     旧版每次都要重新解析 URL、跑一遍黑名单与 textContent。 */
  let lastAnchor = null, lastAnchorLink = null;
  function linkFromAnchor(anchor) {
    if (!anchor) return null;
    if (anchor === lastAnchor) return lastAnchorLink;
    lastAnchor = anchor;
    lastAnchorLink = null;
    if (anchor.hasAttribute('download') || anchor.isContentEditable) return null;
    const url = httpUrl(anchor.getAttribute('href'), anchor.baseURI || location.href);
    if (!url || isBlacklisted(url)) return null;
    lastAnchorLink = {
      element: anchor, url,
      title: (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    };
    return lastAnchorLink;
  }
  window.addEventListener('mouseover', event => {
    if (targetInHost(event, shell && shell.host)) {
      // v20：指针从链接移进我们自己的 UI（预览窗口 / 工具条 / 浮出按钮）时小窗要收，
      // 但「移进小窗本身」不能收。宿主影子根里的事件会被重定向到宿主元素上，
      // 光看 event.target 分不清这两种情况，必须用 composedPath()[0] 取真实目标。
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      const real = path && path.length ? path[0] : event.target;
      const inside = !!peekEl && !!real && real.nodeType === 1
        && (real === peekEl || peekEl.contains(real));
      if (!inside) peekHide(false);
      return;
    }
    if (!interactionEnabled()) {
      if (launcher) launcher.hide();
      peekHide(true);
      return;
    }
    const raw = event.target;
    const node = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null;
    const hoveredImage = settings.imageDragPreview !== false ? imageElementAtEvent(event) : null;
    if (hoveredImage && imageInfoFromElement(hoveredImage)) {
      if (settings.linkButton || settings.aiQuick) launcher.handleLeave(); else launcher.hide();
      peekLeave();
      return;
    }
    const anchor = node && node.closest ? node.closest('a[href]') : null;
    if (anchor && pageInteractionAllowed(event)) {
      const link = linkFromAnchor(anchor);
      if (link) {
        /* v20.2.3：指针碰到链接时只做一件**零成本**的事 —— 排队在页面空闲时预建外壳。
           真正要花钱（建影子根 + 解析模板 + 注入 18KB CSS）的那一下被挪到 idle，
           而离真正开窗至少还有 600ms（悬停阈值），完全来得及。
           这里**不再** preconnect —— v20.2.2 的「划过链接就建连接」会让一页里被扫过的
           每个域名都去开连接，链接密集的页面上可能把连接池占住（详见 §7 的说明）。
           preconnect 现在只在「按下鼠标 / 位移过半 / 悬停 350ms」这几处意图明确的
           时机发生。 */
        if (settings.linkButton || settings.aiQuick || settings.hoverPeek) scheduleShellWarm();
        // v20：浮出按钮与悬停迷你预览共用同一次 mouseover 判定 —— 两者互不干扰，
        // 各自有独立开关（linkButton / hoverPeek）。
        if (settings.linkButton || settings.aiQuick) launcher.handleEnter(link, event.clientX, event.clientY);
        peekHover(link);
        return;
      }
    }
    if (!settings.linkButton && !settings.aiQuick) { if (launcher.isShowing()) launcher.hide(); }
    else launcher.handleLeave();
    // A pass-through link should not pay for building the full shadow-root UI
    // in the next idle slice.  Build it again on the next real link hover.
    cancelShellWarm();
    peekLeave();
  }, true);
  window.addEventListener('scroll', () => {
    if (launcher.isShowing()) launcher.hide();
    peekHide(true);   // 滚动时小窗的位置会失效，直接收起（等下一轮悬停再出现）
  }, true);
  window.addEventListener('blur', () => { launcher.hide(); peekHide(true); });
  window.addEventListener('pagehide', () => { launcher.hide(); peekHide(true); });

  function escapeWindow(item) {
    if (!item || item.closed || !settings.escapeClose) return;
    if (!item.ui.panel.hidden) closePanel(item, true);
    else closeWindow(item);
  }
  // 挂捕获阶段：页面里 stopPropagation 之后就再也收不到 Esc/Tab（挂冒泡阶段很容易被吞）
  window.addEventListener('keydown', event => {
    const fromUI = targetInHost(event, shell && shell.host);
    if (event.key === 'Escape') peekHide(true);   // v20：Esc 先收悬停小窗，再走窗口关闭逻辑
    if (event.key === 'Escape' && windows.length && settings.escapeClose && !event.defaultPrevented) {
      const item = windows[windows.length - 1];
      if (!item) return;
      if (fromUI) {
        // 事件来自我们自己的 UI（已重定向到影子宿主）：只收面板 / 查找栏，不要顺手把窗口关了
        event.preventDefault();
        if (!item.ui.panel.hidden) { closePanel(item, true); return; }
        if (!item.ui.findBar.hidden) { toggleFindBar(item, false); return; }
        return;
      }
      if (isEditingInPage()) return;   // 用户正在页面输入框里打字，别抢 Esc
      event.preventDefault();
      escapeWindow(item);
      return;
    }
    // Tab is intentionally left to the browser.  The old handler preventDefault()ed
    // it and only changed the preview z-index without moving focus, which broke
    // keyboard navigation for both the page and the preview chrome.
  }, true);

  let resizeRAF = 0;
  window.addEventListener('resize', () => {
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
      resizeRAF = 0;
      if (visibilityPaused) return;
      finishGesture();
      peekHide(true);
      if (arrangeState) arrangeGrid();
      else for (const item of windows) {
        if (item.pip) continue;
        if (item.preMaxRect) {
          const v = viewport();
          item.rect = fit({ x: 0, y: 0, w: v.w, h: v.h }, 2);
        } else {
          item.rect = fit(item.rect);
        }
        renderGeometry(item, true);
      }
      layoutPips.fp = '';
      layoutPips();
      if (launcher) launcher.schedulePlace();
    });
  });
  window.addEventListener('pagehide', () => {
    finishGesture();
    for (const w of windows) saveLayout(w);
    rememberSession();
    setScrollLock(false);
    resumeBackgroundVideos();
    endDropSession();
    if (launcher) launcher.hide();
    peekHide(true);
  });
  window.addEventListener('pageshow', () => {
    finishGesture();                 // 从 bfcache 回来的页面可能残留手势状态
    invalidateThemeSample();
    if (shell) renderTheme(true);
    layoutPips.fp = '';
    layoutPips();
    syncStack();
  });
  // 标签页隐藏时停止一切非必要渲染（画中画 / 主题 / 几何），切回补一次
  document.addEventListener('visibilitychange', () => {
    visibilityPaused = document.hidden;
    if (visibilityPaused) { peekHide(true); return; }
    invalidateThemeSample();       // 切回来时页面主题可能已经被别的脚本改过了
    if (shell) renderTheme(true);
    layoutPips.fp = '';
    layoutPips();
    syncStack();
  });

  /* ---- 面板外部点击关闭（覆盖 shadow / iframe 之外的场景） ---- */
  window.addEventListener('mousedown', event => {
    // v20：任何落在我们 UI 之外的按下都收起悬停小窗（点在宿主里则保留 ——
    // 小窗自身的点击要走完整的 click 流程去打开完整预览）。窗口一个都没开时早退，
    // 所以这一句必须放在长度判断之前。
    if (!targetInHost(event, shell && shell.host)) peekHide(true);
    if (!windows.length) return;
    if (targetInHost(event, shell && shell.host)) return;
    // The edge tab is intentionally outside the shadow host (so it stays above
    // page stacking contexts).  Treat its clicks as UI clicks too.
    try { if (event.target && event.target.closest && event.target.closest('.summary-edge-tab')) return; } catch (e) { /* ignore */ }
    for (const item of windows) {
      if (item.closed || item.ui.panel.hidden) continue;
      // AI summaries are persistent companions, not transient preview panels.
      // An outside page click must never close their panel (or make the window
      // look blank).  Only the explicit close action may close them.
      if (item.summaryProtected || (item.ui.win && item.ui.win.classList.contains('summary-window'))) continue;
      closePanel(item, true);
    }
  }, true);

  /* ---- 中键点击：刻意不接管（v20.2.1 按用户要求整段删除） ----
     这里原本挂着一个 auxclick 监听：中键点在链接上就 preventDefault() 并直接浮出预览窗。
     代价是**把浏览器原生的「中键 → 后台新标签页打开链接」吃掉了** —— 用户报「鼠标放在
     链接上按中键，结果没开新标签页，反而弹出预览小窗」，并且明确表示从来没设置过、也没
     要求过这个行为，要求删掉。
     ⚠️ 不要再把它加回来：中键在浏览器里的默认语义就是「新标签页打开链接」，是用户早已
     形成的肌肉记忆，改掉它比多提供一个入口更让人困惑；而且它属于「静默改变浏览器既有
     行为」，一旦与用户预期不符就会显得像 bug。
     若哪天真想恢复，正确做法是加一个**默认关闭**的设置项，而不是硬编码接管 —— 现在这一
     段连监听都不注册，中键完全走浏览器原生流程。 */

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
      .map(part => {
        let rule = part.trim().toLowerCase();
        if (!rule) return '';
        // Accept the forms users paste from the address bar and from other
        // blocker lists: https://*.example.com/path:8080.  Only the hostname is
        // meaningful for matching; a literal "*.example.com" used to never
        // match anything.
        rule = rule.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
        rule = rule.replace(/^[^/@]*@/, '').split('/')[0];
        rule = rule.replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
        return rule;
      })
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
      if (!windows.some(w => !w.closed && !w.bare)) resumeBackgroundVideos();
      if (notify) toastStandalone(settings.enabled === false
        ? 'LinkDrag 已全局暂停（工具栏图标可重新启用）'
        : '已暂停本站的 LinkDrag（工具栏图标可恢复）');
    } else if (notify) {
      toastStandalone('LinkDrag 已在' + (siteHostKey() || '本页') + '启用');
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
  function isSafeRemoteUrl(value) {
    try {
      const u = new window.URL(String(value || ''), location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!host) return false;
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
        || host.endsWith('.internal') || host === 'metadata.google.internal') return false;
      if (host === '::1' || host === '0.0.0.0') return false;
      if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return false;
      if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
        || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
      return true;
    } catch (e) { return false; }
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
      if (!/[-_]\d{2,4}x\d{2,4}\.(?:jpe?g|jfif|png|webp|avif|gif)$/i.test(u.pathname)) return '';
      const original = u.pathname.replace(/[-_]\d{2,4}x\d{2,4}(\.(?:jpe?g|jfif|png|webp|avif|gif))$/i, '$1');
      return u.origin + original + u.search + u.hash;
    } catch (e) { return ''; }
  }
  function imageOriginalVariants(url) {
    const out = [];
    const add = value => { const normalized = normalizeImageUrl(value, location.href); if (normalized && out.indexOf(normalized) < 0) out.push(normalized); };
    add(imageOriginalVariant(url));
    try {
      const u = new window.URL(url, location.href);
      const suffix = u.pathname.replace(/(?:[-_](?:thumb|thumbnail|small|medium|preview|compressed|lowres))(?=\.[a-z0-9]{2,5}$)/i, '');
      if (suffix !== u.pathname) add(u.origin + suffix + u.search + u.hash);
      const bareThumb = u.pathname.replace(/\/thumb(?:nail)?\//i, '/');
      if (bareThumb !== u.pathname) add(u.origin + bareThumb + u.search + u.hash);
    } catch (e) { /* ignore */ }
    return out;
  }
  function imageUrlsFromHtml(html, base) {
    const out = [];
    const add = value => {
      const url = normalizeImageUrl(String(value || '')
        .replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&'), base);
      if (!url || out.indexOf(url) >= 0 || out.length >= 8) return;
      out.push(url);
    };
    const source = String(html || '');
    const attrValue = (tag, name) => {
      const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
      return match ? match[1] : '';
    };
    const metaPattern = /<meta\b[^>]*>/ig;
    let meta;
    while ((meta = metaPattern.exec(source)) && out.length < 8) {
      const key = attrValue(meta[0], 'property') || attrValue(meta[0], 'name');
      if (!/^(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(key)) continue;
      add(attrValue(meta[0], 'content'));
    }
    const linkPattern = /<link\b[^>]*>/ig;
    let link;
    while ((link = linkPattern.exec(source)) && out.length < 8) {
      const rel = attrValue(link[0], 'rel').toLowerCase();
      const as = attrValue(link[0], 'as').toLowerCase();
      if (rel === 'image_src' || (rel === 'preload' && as === 'image')) add(attrValue(link[0], 'href'));
    }
    const jsonImage = /"image"\s*:\s*(?:"([^"]+)"|\[\s*"([^"]+)")/ig;
    let jsonMatch;
    while ((jsonMatch = jsonImage.exec(source)) && out.length < 8) add(jsonMatch[1] || jsonMatch[2]);
    return out;
  }
  const imagePageCache = new Map();
  function imagePageCandidates(pageUrl) {
    const target = httpUrl(pageUrl);
    if (!target) return Promise.resolve([]);
    if (imagePageCache.has(target)) return imagePageCache.get(target);
    const promise = (typeof videoFetchText === 'function' ? videoFetchText(target) : Promise.resolve(''))
      .then(html => imageUrlsFromHtml(html, target))
      .catch(() => []);
    imagePageCache.set(target, promise);
    if (imagePageCache.size > 24) imagePageCache.delete(imagePageCache.keys().next().value);
    return promise;
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
    let sourcePageUrl = '';
    // 1) Explicit full-size attributes are the strongest signal.  Check a few
    // ancestors, not just the immediate card: galleries often put data-full on
    // the figure while the thumbnail itself only has a small src.
    const fullAttrs = ['data-full', 'data-full-src', 'data-original', 'data-original-src',
      'data-large', 'data-large-file', 'data-large-src', 'data-zoom-image', 'data-zoom-src',
      'data-hi-res', 'data-hi-res-src', 'data-actualsrc', 'data-image'];
    let attrNode = img;
    for (let depth = 0; attrNode && depth < 5; depth++, attrNode = attrNode.parentElement) {
      for (const name of fullAttrs) add(attrNode.getAttribute && attrNode.getAttribute(name));
      if (depth <= 1 && attrNode.querySelectorAll) {
        let nested = 0;
        for (const fullNode of attrNode.querySelectorAll('[data-full],[data-full-src],[data-original],[data-original-src],[data-large],[data-large-src],[data-zoom-image],[data-zoom-src],[data-actualsrc]')) {
          if (nested++ >= 6) break;
          for (const name of fullAttrs) add(fullNode.getAttribute(name));
        }
      }
    }
    // 2) The wrapping link usually points at the full image on image sites.
    // If it points at a viewer page, remember it so metadata can supply the
    // original instead of enlarging the thumbnail.
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href && looksLikeImageUrl(href)) add(href);
      else {
        const pageUrl = httpUrl(href, anchor.baseURI || base);
        if (pageUrl && pageUrl.split('#')[0] !== String(location.href || '').split('#')[0]) sourcePageUrl = pageUrl;
      }
    }
    const linkScope = anchor || img.parentElement;
    if (linkScope && linkScope.querySelectorAll) {
      let linkCount = 0;
      for (const link of linkScope.querySelectorAll('a[href]')) {
        if (linkCount++ >= 8) break;
        const href = link.getAttribute('href');
        if (href && looksLikeImageUrl(href)) add(href);
        else if (!sourcePageUrl) {
          const pageUrl = httpUrl(href, link.baseURI || base);
          if (pageUrl && pageUrl.split('#')[0] !== String(location.href || '').split('#')[0]) sourcePageUrl = pageUrl;
        }
      }
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
    if (current) imageOriginalVariants(current).forEach(add);
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
      sourcePageUrl: sourcePageUrl,
      width: Number(img.naturalWidth) || 0,
      height: Number(img.naturalHeight) || 0
    };
  }
  function imageInfoFromEvent(event) {
    return imageInfoFromElement(imageElementAtEvent(event));
  }
  let lastContextImage = null;
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
      sourcePageUrl: httpUrl(raw.sourcePageUrl) || '',
      width: Number(raw.width) || 0,
      height: Number(raw.height) || 0
    };
  }
  function mergeImageViewerCandidates(item, extra, pageUrl) {
    if (!item || item.closed || !Array.isArray(extra) || !extra.length) return;
    const seen = Object.create(null);
    const merged = [];
    for (const value of extra.concat(item.imageCandidates || [])) {
      const url = normalizeImageUrl(value, item.imageSourceUrl || location.href);
      if (!url || seen[url]) continue;
      seen[url] = 1;
      merged.push(url);
      if (merged.length >= 12) break;
    }
    const previous = item.imageCandidates || [];
    if (!merged.length || (merged.length === previous.length && merged[0] === previous[0])) return;
    item.imagePageResolvedFor = pageUrl;
    item.imageCandidates = merged;
    const first = merged[0];
    if (first && first !== item.imageUrl) {
      item.imageCandidateIndex = 0;
      loadImageViewerCandidate(item);
    }
  }
  function upgradeImageViewerFromPage(item, pageUrl) {
    const target = httpUrl(pageUrl);
    if (!item || item.closed || !target || item.imagePageResolvedFor === target) return;
    item.imagePageResolvedFor = target;
    imagePageCandidates(target).then(urls => {
      if (!item || item.closed || !urls.length) return;
      mergeImageViewerCandidates(item, urls, target);
    }).catch(() => { /* thumbnail remains usable */ });
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
    }, Math.min(item.imageCandidates.length > 1 ? 10000 : 25000, Math.max(3000, (item.imageLoadDeadline || Date.now()) - Date.now())));
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
    if (info.sourcePageUrl) upgradeImageViewerFromPage(item, info.sourcePageUrl);
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
    try {
      if (window.LinkDragI18N) {
        window.LinkDragI18N.setLanguage(settings.language, false);
        if (shell && shell.root) window.LinkDragI18N.localizeTree(shell.root);
      }
    } catch (e) { /* ignore */ }
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
    function handleExtMessage(message, sender, sendResponse) {
      if (!isObj(message) || message.namespace !== EXT_NS) return false;
      const type = String(message.type || '');
      if (type === 'ldp:ping') {
        extRespond(sendResponse, { ok: true, version: SCRIPT_VERSION, frame: TOP ? 'top' : 'frame', ready: extReady });
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
      if (type === 'ldp:summary-link') {
        const target = httpUrl(message.url);
        if (!target || !interactionEnabled()) {
          extRespond(sendResponse, { ok: false, reason: interactionDisabledReason() || 'invalid-url' });
          return false;
        }
        const opened = openQuickAISummary(target, isStr(message.title) ? message.title.slice(0, 300) : '', undefined);
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
        let image = normalizeImageInfo(message.image);
        if (image && lastContextImage && Date.now() - lastContextImage.time < 8000
          && (lastContextImage.info.url === image.url
            || (Array.isArray(lastContextImage.info.candidates) && lastContextImage.info.candidates.indexOf(image.url) >= 0))) {
          image = normalizeImageInfo(lastContextImage.info);
          lastContextImage = null;
        }
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
    }
    EXT.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isObj(message) || message.namespace !== EXT_NS) return false;
      const type = String(message.type || '');
      // Chrome storage is asynchronous.  A command can arrive immediately after
      // ensureContent() injects this file, before the first storage snapshot is
      // available.  Applying it against DEFAULTS would overwrite the user's
      // saved disabledSites / enabled flags.  Queue everything except ping.
      if (!extReady && type !== 'ldp:ping') {
        whenStoreReady(() => { handleExtMessage(message, sender, sendResponse); });
        return true;
      }
      return handleExtMessage(message, sender, sendResponse);
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
  // Remember the full candidate list (srcset / data-full / wrapping link) at
  // context-menu time.  The background only receives info.srcUrl, so without
  // this snapshot "right click -> view high-res image" fell back to the
  // thumbnail.
  window.addEventListener('contextmenu', event => {
    if (!settings.imageDragPreview || !interactionEnabled()) return;
    if (shell && targetInHost(event, shell.host)) return;
    const info = imageInfoFromEvent(event);
    if (info) lastContextImage = { info, time: Date.now() };
  }, true);

  // Host-side image gestures.  The child-frame counterpart lives in the
  // !TOP branch and forwards plain image data to this frame.
  window.addEventListener('dragstart', event => {
    if (!settings.imageDragPreview || !interactionEnabled()) return;
    if (selectionTouchesEvent(event)) return;
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
  let videoAIShowToken = 0;
  let videoAIPointer = { x: -1, y: -1 };
  const videoAIInRect = (rect, x, y) => !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  function isVideoSummaryEligible(video) {
    if (!video || !video.isConnected || !/^(VIDEO|AUDIO)$/.test(String(video.tagName || '').toUpperCase())) return false;
    const tag = String(video.tagName).toUpperCase();
    let rect = null;
    try { rect = video.getBoundingClientRect(); } catch (e) { return false; }
    if (!rect) return false;
    const minWidth = tag === 'AUDIO' ? 120 : 240;
    const minHeight = tag === 'AUDIO' ? 20 : 120;
    if (rect.width < minWidth || rect.height < minHeight) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const visibleW = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const visibleH = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    if (visibleW * visibleH < rect.width * rect.height * 0.3) return false;
    try {
      const style = window.getComputedStyle(video);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) < 0.05) return false;
    } catch (e) { /* keep going */ }
    try {
      const chrome = video.closest([
        '[data-e2e*="comment" i]', '[data-e2e*="reply" i]', '[data-e2e*="notif" i]', '[data-e2e*="notice" i]',
        '[class*="comment" i]', '[class*="reply" i]', '[class*="notif" i]', '[class*="toast" i]',
        '[class*="message-list" i]', '[class*="chat-room" i]', '[class*="emoji" i]', '[class*="sticker" i]',
        '[class*="effect-preview" i]', '[class*="advert" i]', '[class*="sponsor" i]',
        '[aria-label*="评论"]', '[aria-label*="通知"]', '[role="tooltip"]'
      ].join(','));
      if (chrome) return false;
    } catch (e) { /* ignore invalid selectors */ }
    if (/douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
      try {
        if (!video.closest('[data-e2e="feed-active-video"],[data-e2e="feed-video"],[data-e2e="video-player"],[data-e2e="video-detail"],#sliderVideo,.xgplayer')) return false;
      } catch (e) { return false; }
      // A feed card or author preview can be large enough for the generic
      // minimum yet much smaller than the real player.  It was the cause of
      // the button briefly appearing beside the author avatar before jumping.
      if (tag !== 'AUDIO' && rect.width * rect.height < window.innerWidth * window.innerHeight * 0.18) return false;
    }
    return true;
  }

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
    // Never paint at the shadow host's default (0,0) while the player layout
    // settles; positionVideoAI() will place it before it is unhidden.
    button.style.left = '-9999px';
    button.style.top = '-9999px';
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
      // Douyin's recommendation feed can replace <video> nodes without a page
      // reload.  Never open the summary against a stale detached node.
      const video = (videoAICurrent && videoAICurrent.isConnected && isVideoSummaryEligible(videoAICurrent))
        ? videoAICurrent
        : findActiveVideoElement();
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

  function overlayThemeDark() {
    // Auto mode intentionally combines both signals: the page's real
    // background/declared color and the OS preference.  Page evidence has the
    // stronger weight, so a bright page stays light even when the OS is dark.
    try {
      if (typeof getEffectiveDark === 'function') return !!getEffectiveDark();
    } catch (e) { /* fall through to system */ }
    try {
      if (settings.theme === 'dark') return true;
      if (settings.theme === 'light') return false;
    } catch (e) { /* settings may still be loading */ }
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }
  function refreshVideoAITheme() {
    if (!videoAIButton) return;
    // The launcher and loading card use the same auto page+system theme as the
    // summary window, so their day/night state cannot diverge.
    const dark = overlayThemeDark();
    videoAIButton.style.background = dark ? '#20242c' : '#ffffff';
    videoAIButton.style.color = dark ? '#cfe0ff' : '#2459b8';
    videoAIButton.style.borderColor = dark ? '#3a4658' : '#8fa8cc';
    videoAIButton.style.setProperty('--surface', dark ? '#20242c' : '#ffffff');
    videoAIButton.style.setProperty('--accent', dark ? '#cfe0ff' : '#2459b8');
    videoAIButton.style.setProperty('--border', dark ? '#3a4658' : '#8fa8cc');
  }

  function videoAIRect(video) {
    try { return video.getBoundingClientRect(); } catch (e) { return null; }
  }

  function positionVideoAI(video) {
    if (!videoAIButton || !isVideoSummaryEligible(video)) return false;
    const rect = videoAIRect(video);
    if (!rect) return false;
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
    if (!settings.videoAI) return;
    if (!isVideoSummaryEligible(video)) { hideVideoAI(); return; }
    if (!ensureVideoAI()) return;
    if (videoAICurrent === video && !videoAIButton.hidden) {
      if (positionVideoAI(video)) refreshVideoAITheme();
      clearTimeout(videoAIHideTimer);
      return;
    }
    // Douyin swaps between its feed card and full-screen player a few frames
    // after mouseover.  Showing on the first frame made the button appear near
    // the author avatar and then jump to the player's top-right corner.  Wait
    // until the player's viewport rect is stable before revealing it.
    const token = ++videoAIShowToken;
    videoAIButton.hidden = true;
    let last = null;
    let stable = 0;
    const check = () => {
      if (token !== videoAIShowToken) return;
      if (!video || !video.isConnected || !isVideoSummaryEligible(video)) { hideVideoAI(); return; }
      const rect = videoAIRect(video);
      if (!rect) { hideVideoAI(); return; }
      if (last && Math.abs(last.left - rect.left) < 2 && Math.abs(last.top - rect.top) < 2
        && Math.abs(last.width - rect.width) < 2 && Math.abs(last.height - rect.height) < 2) stable++;
      else stable = 0;
      last = rect;
      if (stable < 3) { requestAnimationFrame(check); return; }
      if (videoAIPointer.x >= 0 && !videoAIInRect(rect, videoAIPointer.x, videoAIPointer.y)) { hideVideoAI(); return; }
      if (token !== videoAIShowToken || !positionVideoAI(video)) { hideVideoAI(); return; }
      videoAICurrent = video;
      videoAIButton.hidden = false;
      refreshVideoAITheme();
      clearTimeout(videoAIHideTimer);
    };
    requestAnimationFrame(check);
  }

  function hideVideoAI() {
    videoAIShowToken++;
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
        return;
      }
      // Video players often sit under a control/notification overlay, so the
      // video never receives mouseout.  Hide based on the pointer leaving both
      // rectangles, not on the event target.
      clearTimeout(videoAIHideTimer);
      videoAIHideTimer = setTimeout(() => {
        if (!videoAICurrent || !videoAIButton || videoAIButton.hidden) return;
        const br = videoAIButton.getBoundingClientRect();
        const vr = videoAIRect(videoAICurrent);
        if (videoAIInRect(br, videoAIPointer.x, videoAIPointer.y) || videoAIInRect(vr, videoAIPointer.x, videoAIPointer.y)) return;
        hideVideoAI();
      }, 700);
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
      if (!videoAICurrent) return;
      if (!videoAICurrent.isConnected || !isVideoSummaryEligible(videoAICurrent)) { hideVideoAI(); return; }
      if (positionVideoAI(videoAICurrent)) videoAIButton.hidden = false;
      else hideVideoAI();
    };
    setTimeout(scanVisibleVideo, 900);
    window.addEventListener('load', scanVisibleVideo, { once: true });
    document.addEventListener('loadedmetadata', scanVisibleVideo, true);
    document.addEventListener('play', scanVisibleVideo, true);
    // A 450 ms full-document media scan was needlessly expensive on pages with
    // many videos.  Hover/play/metadata already cover the immediate cases;
    // this slow safety net only runs while the tab is visible.
    setInterval(() => { if (!document.hidden) scanVisibleVideo(); }, 1200);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scanVisibleVideo(); });
  }

  function videoFetchText(url) {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return Promise.resolve('');
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; resolve(value); };
      const direct = () => {
        fetch(target, { credentials: 'include' })
          .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          })
          .then(text => finish(text))
          .catch(() => finish(''));
      };
      const background = () => {
        if (EXT && EXT.runtime && EXT.runtime.sendMessage) {
          try {
            EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:fetch', url: target, timeoutMs: 15000 }, res => {
              if (res && res.ok && Number(res.status || 0) < 400 && typeof res.text === 'string' && res.text) finish(res.text);
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
          .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          })
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
            if (res && res.ok && Number(res.status || 0) < 400 && typeof res.text === 'string' && res.text) finish(res.text);
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
    let last = '';
    for (const raw of lines) {
      const line = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!line || line === last) continue;
      last = line;
      out.push(line);
    }
    return out.join('\n').trim();
  }
  function decodeSubtitleEntities(text) {
    return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, body) => {
      try {
        if (body.charAt(0) === '#') {
          const hex = body.charAt(1).toLowerCase() === 'x';
          const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        return Object.prototype.hasOwnProperty.call(named, body.toLowerCase()) ? named[body.toLowerCase()] : whole;
      } catch (e) { return whole; }
    });
  }

  function subtitleTimeValue(value) {
    const parts = String(value || '').replace(',', '.').split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }
  function parseSubtitleCues(raw) {
    const text = String(raw || '').replace(/\r/g, '');
    if (!text.trim()) return [];
    const cues = [];
    const blocks = text.split(/\n{2,}/);
    for (const block of blocks) {
      const parts = block.split('\n').map(x => x.trim()).filter(Boolean);
      const timeIndex = parts.findIndex(x => x.includes('-->'));
      if (timeIndex < 0) continue;
      const match = parts[timeIndex].match(/((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})/);
      if (!match) continue;
      const start = subtitleTimeValue(match[1]);
      const end = Math.max(start + 0.2, subtitleTimeValue(match[2]));
      const payload = decodeSubtitleEntities(parts.slice(timeIndex + 1).join(' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' '))
        .replace(/-->/g, '→')
        .replace(/\s+/g, ' ')
        .trim();
      if (payload) cues.push({ start, end, text: payload });
    }
    return cues;
  }
  function parseSubtitleText(raw) {
    return dedupeTranscript(parseSubtitleCues(raw).map(cue => cue.text));
  }

  function extractYouTubeXmlData(raw) {
    const source = String(raw || '').trim();
    if (!source || source[0] !== '<') return null;
    try {
      const doc = new DOMParser().parseFromString(source, 'text/xml');
      const nodes = Array.from(doc.querySelectorAll('text'));
      const cues = nodes.map(node => {
        const start = Number(node.getAttribute('start')) || 0;
        const dur = Number(node.getAttribute('dur')) || 0;
        return { start, end: start + Math.max(0.2, dur || 2), text: String(node.textContent || '').replace(/\s+/g, ' ').trim() };
      }).filter(cue => cue.text);
      const text = dedupeTranscript(cues.map(cue => cue.text));
      return text ? { text, cues } : null;
    } catch (e) { return null; }
  }
  function extractYouTubeXml(raw) {
    const data = extractYouTubeXmlData(raw);
    return data ? data.text : '';
  }

  function extractYouTubeJsonData(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    const events = data && Array.isArray(data.events) ? data.events : [];
    const lines = [];
    const cues = [];
    for (const event of events) {
      let text = '';
      if (Array.isArray(event.segs)) text = event.segs.map(seg => seg && seg.utf8 ? seg.utf8 : '').join('');
      else if (event.t) text = event.t;
      text = String(text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push(text);
      if (Number.isFinite(Number(event.tStartMs))) {
        const start = Math.max(0, Number(event.tStartMs) / 1000);
        const end = start + Math.max(0.2, (Number(event.dDurationMs) || 2000) / 1000);
        cues.push({ start, end, text });
      }
    }
    const joined = dedupeTranscript(lines);
    return joined ? { text: joined, cues } : null;
  }
  function extractYouTubeJson(raw) {
    const data = extractYouTubeJsonData(raw);
    return data ? data.text : '';
  }

  function extractBilibiliJsonData(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    const body = data && Array.isArray(data.body) ? data.body : [];
    const cues = body.map(item => {
      const start = Number(item && (item.from ?? item.start)) || 0;
      const end = Number(item && (item.to ?? item.end)) || (start + 2);
      return { start, end: Math.max(start + 0.2, end), text: String(item && item.content || '').replace(/\s+/g, ' ').trim() };
    }).filter(cue => cue.text);
    const text = dedupeTranscript(cues.map(cue => cue.text));
    return text ? { text, cues } : null;
  }
  function extractBilibiliJson(raw) {
    const data = extractBilibiliJsonData(raw);
    return data ? data.text : '';
  }

  async function nativeVideoTranscript(video) {
    const tracks = [];
    try {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track && (!track.kind || /caption|subtitle/i.test(track.kind))) {
            if (track.cues && track.cues.length) {
              const cues = Array.from(track.cues).map(cue => ({
                start: Number(cue.startTime) || 0,
                end: Number(cue.endTime) || (Number(cue.startTime) || 0) + 2,
                text: String(cue.text || '').replace(/\s+/g, ' ').trim()
              })).filter(cue => cue.text);
              const text = dedupeTranscript(cues.map(cue => cue.text));
              if (text) return { text, cues, source: '视频字幕' };
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
      const cues = parseSubtitleCues(raw);
      const text = dedupeTranscript(cues.map(cue => cue.text));
      if (text) return { text, cues, source: '视频字幕' };
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
        // A cipher-only format also carries an `s` (signature) parameter.
        // Returning its raw url produces a 403 from googlevideo; without the
        // player decipher implementation, report "no usable audio" instead.
        if (cipher.get('s')) return '';
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
      const jsonData = extractYouTubeJsonData(jsonRaw);
      if (jsonData && jsonData.text) return { text: jsonData.text, cues: jsonData.cues, source: 'YouTube 字幕' };
      const xmlRaw = await videoFetchText(base.replace(/&fmt=srv3\b/gi, '').replace(/\bfmt=srv3&?/gi, ''));
      const xmlData = extractYouTubeXmlData(xmlRaw);
      if (xmlData && xmlData.text) return { text: xmlData.text, cues: xmlData.cues, source: 'YouTube 字幕' };
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
    if (pageSubtitle.text) return { text: pageSubtitle.text, cues: pageSubtitle.cues || [], source: 'Bilibili 字幕' };
    if (pageSubtitle.subtitles && pageSubtitle.subtitles.length) subtitles = pageSubtitle.subtitles;
    if (!subtitles.length) {
      const viewList = view && view.data && view.data.subtitle && Array.isArray(view.data.subtitle.list) ? view.data.subtitle.list : [];
      if (viewList.length) subtitles = viewList;
    }
    if (!subtitles.length) {
      try { wbiQuery = await bilibiliWbiQuery(bvid, cid); } catch (e) { wbiQuery = ''; }
      if (wbiQuery) {
        pageSubtitle = await biliPageHookSubtitles(bvid, cid, wbiQuery);
        if (pageSubtitle.text) return { text: pageSubtitle.text, cues: pageSubtitle.cues || [], source: 'Bilibili 字幕' };
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
    const biliData = extractBilibiliJsonData(await videoFetchText(subUrl));
    return biliData && biliData.text ? { text: biliData.text, cues: biliData.cues, source: 'Bilibili 字幕' } : null;
  }

  function biliPageHookSubtitles(bvid, cid, wbiQuery) {
    return new Promise(resolve => {
      const id = 'bili-sub-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = value => { if (settled) return; settled = true; window.removeEventListener('message', onMessage); resolve(value || {}); };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_BILI_SUBTITLE_RESULT' || event.data.id !== id) return;
        finish({
          subtitles: Array.isArray(event.data.subtitles) ? event.data.subtitles : [],
          text: String(event.data.text || ''),
          cues: Array.isArray(event.data.cues) ? event.data.cues : []
        });
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

  function subtitleProbeBudget(video) {
    const host = String(location.hostname || '');
    try {
      if (video && video.textTracks && video.textTracks.length) return 12000;
    } catch (e) { /* ignore */ }
    try {
      if (video && video.querySelector && video.querySelector('track[src]')) return 12000;
    } catch (e) { /* ignore */ }
    // Douyin/TikTok descriptions and chapter cards are not subtitle tracks.
    // Only skip the wait after ruling out a real native track above.
    if (/douyin\.com|iesdouyin\.com|tiktok\.com/i.test(host)) return 0;
    // YouTube/Bilibili fetch captions through their APIs, which can be slower
    // but are often available even without a visible <track> element.
    if (/youtube\.com|youtu\.be|bilibili\.com/i.test(host)) return 12000;
    // Generic pages may render subtitles into DOM nodes.  Give them a short
    // probe, then move to ASR instead of blocking the panel for 20 seconds.
    return 3500;
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
    if (!video || !video.isConnected) video = findActiveVideoElement();
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
    item.anchorVideo = video;
    item.videoState = {
      busy: false,
      answer: '',
      transcript: '',
      transcriptCues: [],
      transcriptDuration: 0,
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
    const out = el('div', 'video-summary-answer markdown summary-answer-card');
    const meta = el('div', 'video-summary-meta', '');
    const actions = el('div', 'ai-actions summary-actions');
    const copy = el('button', 'text-button', '复制总结');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = String((item.videoState && item.videoState.answer) || '').trim();
      if (!text) { toast(item, '还没有可复制的总结'); return; }
      copySummaryText(item, text, '已复制总结');
    });
    const videoDownload = el('button', 'text-button summary-action-secondary', '下载视频');
    videoDownload.type = 'button';
    videoDownload.hidden = true;
    videoDownload.disabled = true;
    videoDownload.addEventListener('click', () => downloadVideoFromSummary(item));
    const audioDownload = el('button', 'text-button summary-action-secondary', '下载音频');
    audioDownload.type = 'button';
    audioDownload.hidden = true;
    audioDownload.disabled = true;
    audioDownload.addEventListener('click', () => downloadAudioFromSummary(item));
    const downloadProgress = buildDownloadProgress();
    const subtitleDownload = el('button', 'text-button summary-subtitle-button summary-action-primary', '下载字幕 SRT');
    subtitleDownload.type = 'button';
    subtitleDownload.hidden = true;
    subtitleDownload.addEventListener('click', () => downloadSummarySubtitles(item));
    const retry = el('button', 'text-button', '重新总结');
    retry.type = 'button';
    retry.addEventListener('click', () => startVideoSummary(item));
    actions.appendChild(videoDownload);
    actions.appendChild(audioDownload);
    actions.appendChild(subtitleDownload);
    actions.appendChild(copy);
    actions.appendChild(retry);
    if (typeof addSummaryAppearance === 'function') addSummaryAppearance(item, actions);
    const scroll = el('div', 'summary-scroll');
    scroll.appendChild(source);
    scroll.appendChild(status);
    if (typeof addSummarySteps === 'function') addSummarySteps(item, scroll, 'video', ['扫描字幕', 'AI 总结']);
    scroll.appendChild(out);
    scroll.appendChild(meta);
    scroll.appendChild(downloadProgress.box);
    body.appendChild(scroll);
    body.appendChild(buildFollowupBox(item));
    body.appendChild(actions);
    item.ui.videoStatus = status;
    item.ui.videoOut = out;
    item.ui.videoMeta = meta;
    item.ui.videoSubtitleDownload = subtitleDownload;
    item.ui.videoDownloadBtn = videoDownload;
    item.ui.videoAudioBtn = audioDownload;
    item.ui.downloadProgress = downloadProgress.box;
    item.ui.downloadProgressBar = downloadProgress.bar;
    item.ui.downloadProgressText = downloadProgress.text;
    if (typeof applySummaryTextStyle === 'function') applySummaryTextStyle(item, out);
    if (state.answer) { out.innerHTML = markdownToHtml(state.answer); if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item); }
    else if (state.error) { out.textContent = state.error; out.dataset.tone = 'bad'; }
    else out.textContent = '正在读取视频字幕…';
    if (state.error) status.textContent = '未能读取字幕';
    updateSummarySubtitleButton(item);
    setDownloadCapability(item, { video: false, audio: false, pending: true });
    setTimeout(() => {
      detectDownloadCapability(item).catch(() => { /* ignore */ });
      if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
    }, 60);
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
      transcript: '',
      transcriptCues: [],
      transcriptDuration: Number(video.duration) || 0,
      error: '',
      subtitleError: String(subtitleError || ''),
      textMode: false,
      list: candidates.length ? candidates : [{ element: video, url: src, kind: 'video', srcKind, duration: Number(video.duration) || 0, title: info.title || '' }],
      anchorVideo: video,
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
    resetSummaryLoadingProgress(item);
    if (!state.info) state.info = {};
    if (!state.info.video || !state.info.video.isConnected) {
      // Preserve the player that was clicked; only then use the active player.
      // Never take the first <video> in the document (recommendation feeds
      // keep preloaded previous clips in DOM order).
      if (item.anchorVideo && item.anchorVideo.isConnected) state.info.video = item.anchorVideo;
      else state.info.video = findActiveVideoElement();
    }
    if (state.info.video && state.info.video.isConnected) item.anchorVideo = state.info.video;
    if (!state.info.video) {
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
      return;
    }
    state.busy = true;
    state.error = '';
    state.answer = '';
    state.transcript = '';
    state.transcriptCues = [];
    state.transcriptDuration = Number(state.info.video.duration) || 0;
    state.source = '';
    state.startedAt = Date.now();
    updateSummarySubtitleButton(item);
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
      const subtitleBudget = subtitleProbeBudget(state.info.video);
      try {
        if (subtitleBudget) {
          subtitleTicker = setInterval(() => {
            if (!item || item.closed || !state.busy) return;
            const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
            if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, Math.min(48, 10 + elapsed * 2), '正在读取并解析视频字幕…');
          }, 1000);
          result = await Promise.race([
            collectVideoTranscript(state.info.video),
            new Promise(resolve => setTimeout(() => resolve(null), subtitleBudget))
          ]);
        } else if (status) {
          status.textContent = '未检测到字幕，改用音视频模型…';
          if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 20, '未检测到字幕，改用音视频模型…');
        }
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
      state.transcriptCues = Array.isArray(result.cues) ? result.cues : [];
      state.transcriptDuration = Number(state.info.video.duration) || 0;
      state.source = result.source;
      updateSummarySubtitleButton(item);
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

  /**
   * 流式输出必须写到「当前活着的」节点上。
   * 总结面板在页面交互后会被重建（panelFrame 清空整个面板），旧代码在开流时
   * 就把 out 节点存进了闭包，重建后它变成游离节点 —— 流还在，文字却写进了
   * 没人看的地方，表现就是「动一下网页总结就卡住」。
   */
  function liveSummaryOut(item, kind) {
    const ui = item && item.ui;
    if (!ui) return null;
    const candidates = kind === 'video' ? [ui.videoOut] : kind === 'media' ? [ui.mediaOut] : [ui.aiOut, ui.textAIOut];
    for (const node of candidates) {
      if (node && node.isConnected) return node;
    }
    return null;
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
    let keepAlive = 0;
    let renderTimer = 0;
    let port = null;
    const releasePort = () => {
      if (item.aiPort === port) item.aiPort = null;
      try { if (port) port.disconnect(); } catch (e) { /* ignore */ }
      port = null;
    };
    const finishOnce = fn => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      watchdog = 0;
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = 0;
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = 0;
      releasePort();
      fn();
    };
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
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => finishOnce(() => fallbackVideoSummary(item, transcript, '文本模型 90 秒没有返回新内容')), 90000);
    };
    armWatchdog();
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
    try { port = EXT.runtime.connect({ name: 'ldp-ai-stream' }); } catch (e) {
      if (watchdog) clearTimeout(watchdog);
      fallbackVideoSummary(item, transcript, '连接失败');
      return;
    }
    item.aiPort = port;
    keepAlive = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (e) { /* ignore */ } }, 15000);
    const started = Date.now();
    state.answer = '';
    // Resolve the answer node on every render instead of capturing it: the
    // panel may be rebuilt while the stream is running.
    const currentOut = () => liveSummaryOut(item, 'video');
    const renderPartial = () => {
      if (finished) return;
      const out = currentOut();
      if (!out) return;
      out.innerHTML = markdownToHtml(state.answer);
      out.classList.add('markdown');
      if (typeof showStreamDots === 'function') showStreamDots(item, out);
    };
    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = 0;
        renderPartial();
        // Streaming replaces the answer HTML on every tick; keep the TOC in
        // sync so the active chapter and sticky heading stay accurate.
        const out = currentOut();
        if (out && typeof refreshSummaryToc === 'function' && collectSummaryHeadings(out).length >= TOC_MIN_HEADINGS) refreshSummaryToc(item);
      }, 60);
    };
    port.onMessage.addListener(msg => {
      if (!msg || finished) return;
      if (msg.type === 'delta') {
        state.answer += String(msg.text || '');
        armWatchdog();
        scheduleRender();
        // Text metadata is purely informational; a rebuilt panel simply has
        // new nodes, so look them up instead of using stale references.
        const metaNow = item.ui.videoMeta || meta;
        if (metaNow) metaNow.textContent = '生成中 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
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
          const out = currentOut();
          if (out) {
            out.classList.remove('streaming');
            out.classList.add('markdown');
            out.dataset.tone = 'good';
            if (!state.answer) out.textContent = 'AI 没有返回内容。';
            else { out.innerHTML = markdownToHtml(state.answer); if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item); }
          }
          if (typeof hideStreamDots === 'function') hideStreamDots(item);
          if (meta) meta.textContent = '总结来源：' + (state.source || '字幕') + ' · 生成完成 · 用时 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒' + (msg.model ? ' · ' + msg.model : '') + (state.startedAt ? ' · 总耗时 ' + Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) + ' 秒' : '');
          if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'video', 'AI 总结', 'done');
          const status = item.ui.videoStatus;
          const totalElapsed = state.startedAt ? Math.max(0.1, (Date.now() - state.startedAt) / 1000).toFixed(1) : '';
          if (status) { status.textContent = '已加载完成' + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : ''); status.classList.remove('streaming'); }
          if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, '总结完成' + (totalElapsed ? ' · 总耗时 ' + totalElapsed + ' 秒' : ''));
          if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
          if (typeof revealSummaryWindow === 'function') setTimeout(() => revealSummaryWindow(item), 220);
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
      if (finished) return;
      finishOnce(() => fallbackVideoSummary(item, transcript, '后台连接断开'));
    });
    try { port.postMessage({ type: 'start', request }); } catch (e) {
      finishOnce(() => fallbackVideoSummary(item, transcript, '请求发送失败'));
    }
  }

  installVideoSummary();


  /* ==================================================================================
   *  §21 网页音视频内容总结
   *  媒体候选 -> 直链 / Blob / HLS 提取 -> SiliconFlow ASR -> 文本模型总结。
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
  let summaryLoadingProgress = 4;
  let summaryLoadingSamples = [];
  let summaryLoadingLastProgressAt = 0;
  let summaryLoadingTicker = 0;
  let summaryLoadingLastText = '';
  let summaryLoadingItem = null;
  const douyinCapturedUrls = [];
  const genericCapturedUrls = [];
  const douyinDetailCache = new Map();
  const douyinPageDataCache = new Map();

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    const source = event.data.source;
    if (source === 'LPS_DOUYIN_MEDIA') {
      const url = String(event.data.url || '');
      if (isSafeRemoteUrl(url) && !douyinCapturedUrls.includes(url)) {
        douyinCapturedUrls.unshift(url);
        if (douyinCapturedUrls.length > 30) douyinCapturedUrls.length = 30;
      }
    } else if (source === 'LPS_MEDIA_URL') {
      const url = String(event.data.url || '');
      if (isSafeRemoteUrl(url) && !genericCapturedUrls.includes(url)) {
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
    host.dataset.theme = overlayThemeDark() ? 'dark' : 'light';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SUMMARY_LOADING_CSS
      + ':host([data-theme="dark"]) .card{background:rgba(32,35,43,.97);color:#e9ebf0;border-color:#404552}'
      + ':host([data-theme="dark"]) .close,:host([data-theme="dark"]) .eta{color:#a1a8b5}'
      + ':host([data-theme="dark"]) .percent{color:#9fc0ff}'
      + ':host([data-theme="dark"]) .spinner{border-color:rgba(159,192,255,.2);border-top-color:#9fc0ff}'
      + ':host([data-theme="dark"]) .track{background:rgba(159,192,255,.15)}'
      + ':host([data-theme="dark"]) .bar{background:#9fc0ff}'
      + ':host([data-theme="light"]) .card{background:rgba(247,248,251,.97);color:#20242c;border-color:rgba(120,130,150,.35)}'
      + ':host([data-theme="light"]) .close,:host([data-theme="light"]) .eta{color:#6c7280}'
      + ':host([data-theme="light"]) .percent{color:#396bb5}'
      + ':host([data-theme="light"]) .spinner{border-color:rgba(57,107,181,.2);border-top-color:#396bb5}'
      + ':host([data-theme="light"]) .track{background:rgba(57,107,181,.13)}'
      + ':host([data-theme="light"]) .bar{background:#396bb5}';
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

  function summaryStageFloor(text, value) {
    if (value >= 100) return 0;
    const label = String(text || '');
    if (/(生成总结|AI 总结|总结生成|正在生成|流式生成)/.test(label)) return value >= 82 ? 12 : 18;
    if (/(转写|ASR|解码|音频|音轨|捕获|录制|上传)/.test(label)) return 10;
    if (/(字幕|正文|读取|扫描|解析|详情)/.test(label)) return 4;
    return 6;
  }

  function renderSummaryLoadingEta() {
    if (!summaryLoadingEta || !summaryLoadingItem) return;
    const now = Date.now();
    const elapsed = Math.max(0.1, (now - (summaryLoadingStartedAt || now)) / 1000);
    const value = Math.max(4, Math.min(100, summaryLoadingProgress || 4));
    if (value >= 100) {
      summaryLoadingRemaining = 0;
      summaryLoadingEta.textContent = '完成';
      return;
    }
    const samples = summaryLoadingSamples.slice(-6);
    let velocityRemaining = 0;
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dv = last.value - first.value;
      const dt = Math.max(0.2, (last.at - first.at) / 1000);
      if (dv > 0) velocityRemaining = dt * (100 - value) / dv;
    }
    // A stage may be slow without changing the percentage (e.g. waiting for
    // ASR or the first AI token).  Never let a stale estimate collapse to 0.
    const stall = Math.max(0, (now - (summaryLoadingLastProgressAt || now)) / 1000 - 4);
    const estimateRemaining = Math.max(0, summaryLoadingEstimate * (100 - value) / 100);
    const floor = summaryStageFloor(summaryLoadingLastText, value);
    const raw = Math.max(velocityRemaining, estimateRemaining, floor) + Math.min(45, stall);
    if (!summaryLoadingRemaining) summaryLoadingRemaining = raw;
    else if (raw > summaryLoadingRemaining) summaryLoadingRemaining = Math.min(raw, summaryLoadingRemaining + Math.max(2, stall * 0.7));
    else summaryLoadingRemaining = Math.max(raw, summaryLoadingRemaining - Math.max(1, stall * 0.5));
    summaryLoadingEta.textContent = elapsed < 2 && samples.length < 2
      ? '正在估算… · 已用 ' + formatSummaryEta(elapsed)
      : '预计剩余 ' + formatSummaryEta(summaryLoadingRemaining) + ' · 已用 ' + formatSummaryEta(elapsed);
  }

  function startSummaryLoadingTicker() {
    if (summaryLoadingTicker) clearInterval(summaryLoadingTicker);
    summaryLoadingTicker = setInterval(() => {
      if (!summaryLoadingItem) return;
      renderSummaryLoadingEta();
    }, 1000);
  }

  function stopSummaryLoadingTicker() {
    if (summaryLoadingTicker) clearInterval(summaryLoadingTicker);
    summaryLoadingTicker = 0;
  }

  function resetSummaryLoadingProgress(item) {
    if (summaryLoadingItem !== item) return;
    summaryLoadingStartedAt = Date.now();
    summaryLoadingEstimate = 30;
    summaryLoadingRemaining = 0;
    summaryLoadingProgress = 4;
    summaryLoadingSamples = [{ at: Date.now(), value: 4 }];
    summaryLoadingLastProgressAt = Date.now();
    summaryLoadingLastText = '正在准备总结…';
  }

  function showSummaryLoading(item, text) {
    ensureSummaryLoading();
    summaryLoadingItem = item;
    summaryLoadingStartedAt = Date.now();
    summaryLoadingEstimate = 30;
    summaryLoadingRemaining = 0;
    summaryLoadingProgress = 4;
    summaryLoadingSamples = [{ at: Date.now(), value: 4 }];
    summaryLoadingLastProgressAt = Date.now();
    summaryLoadingLastText = text || '正在准备总结…';
    summaryLoadingText.textContent = summaryLoadingLastText;
    summaryLoadingPercent.textContent = '4%';
    summaryLoadingEta.textContent = '正在估算…';
    summaryLoadingBar.style.width = '4%';
    startSummaryLoadingTicker();
    if (summaryLoadingHost) {
      summaryLoadingHost.dataset.theme = overlayThemeDark() ? 'dark' : 'light';
      summaryLoadingHost.hidden = false;
      summaryLoadingHost.style.setProperty('display', 'block', 'important');
    }
  }

  function setSummaryEstimate(item, seconds) {
    if (summaryLoadingItem !== item) return;
    summaryLoadingEstimate = Math.max(8, Math.min(600, Number(seconds) || 30));
    renderSummaryLoadingEta();
  }

  function updateSummaryLoading(item, percent, text) {
    if (summaryLoadingItem !== item) return;
    const reported = Math.max(4, Math.min(100, Number(percent) || 0));
    // Stages can have different percentages, but the visible progress bar
    // should never move backwards during one task.
    const value = Math.max(summaryLoadingProgress || 4, reported);
    summaryLoadingProgress = value;
    if (text) {
      summaryLoadingText.textContent = text;
      summaryLoadingLastText = text;
    }
    const now = Date.now();
    const previous = summaryLoadingSamples[summaryLoadingSamples.length - 1];
    if (!previous || value !== previous.value) {
      summaryLoadingSamples.push({ at: now, value });
      if (summaryLoadingSamples.length > 12) summaryLoadingSamples.shift();
      summaryLoadingLastProgressAt = now;
    }
    summaryLoadingBar.style.width = value + '%';
    if (summaryLoadingPercent) summaryLoadingPercent.textContent = Math.round(value) + '%';
    renderSummaryLoadingEta();
    if (item.ui) {
      if (item.ui.mediaPercent) item.ui.mediaPercent.textContent = Math.round(value) + '%';
      if (item.ui.videoPercent) item.ui.videoPercent.textContent = Math.round(value) + '%';
    }
  }

  function hideSummaryLoading(item) {
    if (item && summaryLoadingItem !== item) return;
    summaryLoadingItem = null;
    stopSummaryLoadingTicker();
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
    if (!item) return;
    item.summaryResourcesCleared = true;
    if (item.mediaState) item.mediaState.mseChunksPromise = null;
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
    // Keep state.list and candidate URLs: the "download video/audio" buttons
    // are used after the summary completes, and clearing the list here made
    // them fail with "no downloadable media".
    if (item.mediaState) {
      if (item.mediaState.candidate) item.mediaState.candidate.element = null;
    }
    if (item.videoState) {
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
    // DASH/YouTube CDN URLs often have no useful extension.  Their query
    // carries `mime=audio%2Fmp4` / `mime_type=video%2Fmp4`; use that before
    // falling back to the element tag.  Without this, an audio-only stream was
    // labelled "video" and the 下载视频 button produced a silent MP4.
    try {
      const parsed = new URL(value, location.href);
      for (const key of ['mime', 'mime_type', 'mimeType', 'type']) {
        const raw = parsed.searchParams.get(key);
        if (!raw) continue;
        const mime = decodeURIComponent(raw).toLowerCase();
        if (/^audio(?:\/|$)/.test(mime)) return 'audio';
        if (/^video(?:\/|$)/.test(mime)) return 'video';
      }
    } catch (e) { /* ignore */ }
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

  function isPlatformMediaUrl(value) {
    const url = String(value || '');
    if (!isSafeRemoteUrl(url) || /\.(png|jpe?g|webp|gif|avif|svg)(?:$|\?)/i.test(url)) return false;
    return /(\.mp4|\.webm|\.mov|\.mkv|\.m4s|\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.opus|\.m3u8|\.mpd)(?:$|\?)/i.test(url)
      || /(douyinvod|video\/tos|aweme\/v1\/play|kwimgs|kwaicdn|kspkg|sns-video|xhscdn|bilivideo|hdslb|googlevideo|videoplayback|tiktokcdn|tiktokv|v16-webapp|cdninstagram|fbcdn|video\.twimg\.com|mime_type=(?:video|audio)|audio\/tos)/i.test(url);
  }

  function pageDeclaredMediaUrls() {
    const out = [];
    const add = raw => {
      const value = String(raw || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
      if (!isPlatformMediaUrl(value) || out.some(item => item.url === value)) return;
      if (out.length < 12) out.push({ url: value, title: document.title || '' });
    };
    try {
      for (const node of Array.from(document.querySelectorAll('meta[property],meta[name]'))) {
        const name = String(node.getAttribute('property') || node.getAttribute('name') || '').toLowerCase();
        if (!/^(og:video|og:audio|twitter:player:stream|twitter:player)$/.test(name)) continue;
        add(node.getAttribute('content'));
      }
    } catch (e) { /* ignore */ }
    try {
      for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        const text = String(node.textContent || '').trim();
        if (!text || text.length > 512 * 1024) continue;
        let data = null;
        try { data = JSON.parse(text); } catch (e) { continue; }
        const walk = (value, depth) => {
          if (!value || depth > 8) return;
          if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
          if (typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            if (/^(contentUrl|contentURL|video|audio|url)$/i.test(key)) add(child);
            walk(child, depth + 1);
          }
        };
        walk(data, 0);
      }
    } catch (e) { /* ignore */ }
    try {
      const roots = [window.__NEXT_DATA__, window.__NUXT__, window.__INITIAL_STATE__, window._ROUTER_DATA];
      const walk = (value, depth) => {
        if (!value || depth > 8 || out.length >= 12) return;
        if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
        if (typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (/^(contentUrl|contentURL|playUrl|play_url|playAddr|play_addr|videoUrl|video_url|audioUrl|audio_url|src)$/i.test(key)) add(child);
          walk(child, depth + 1);
        }
      };
      roots.forEach(root => walk(root, 0));
    } catch (e) { /* ignore */ }
    return out;
  }

  function scanMediaCandidates() {
    const list = [];
    const douyinHost = /douyin\.com|iesdouyin\.com/i.test(location.hostname);
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
      // Never invent a URL for a Douyin player with no source.  The feed keeps
      // several preloaded nodes; borrowing an unbound CDN URL here used to make
      // a hidden effect/ad clip look like the video the user clicked.
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
    for (const declared of pageDeclaredMediaUrls()) {
      if (list.some(candidate => candidate.url === declared.url)) continue;
      const kind = mediaUrlKind(declared.url, 'video');
      list.push({ element: null, kind: kind === 'audio' ? 'audio' : 'video', url: declared.url, srcKind: kind === 'audio' ? 'audio' : 'direct', duration: 0, title: declared.title || document.title || '', visible: true, unbound: douyinHost });
    }
    list.sort((a, b) => (a.kind === 'audio' && b.kind !== 'audio' ? -1 : a.kind !== 'audio' && b.kind === 'audio' ? 1 : 0));
    if (!list.some(candidate => candidate.url && !/^blob:/i.test(candidate.url))) {
      const baseElement = list.find(candidate => candidate.element)?.element || null;
      const youtubeAudio = typeof youtubeAudioUrl === 'function' ? youtubeAudioUrl() : '';
      if (youtubeAudio) list.push({ element: baseElement, kind: 'audio', url: youtubeAudio, srcKind: 'direct', duration: 0, title: document.title || '', visible: true });
      const capturedList = genericCapturedUrls.filter(url => isSafeRemoteUrl(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 8);
      const douyinList = /douyin\.com|iesdouyin\.com/i.test(location.hostname)
        ? douyinCapturedUrls.filter(url => isSafeRemoteUrl(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 8)
        : [];
      for (const captured of capturedList.concat(douyinList)) {
        const capturedKind = mediaUrlKind(captured, 'video');
        const existing = list.find(candidate => candidate.url === captured);
        if (existing) {
          if (capturedKind === 'audio' && existing.kind !== 'audio') {
            existing.kind = 'audio';
            existing.srcKind = 'audio';
          }
          continue;
        }
        list.push({
          element: douyinHost ? null : baseElement,
          kind: capturedKind === 'audio' ? 'audio' : 'video',
          url: captured,
          srcKind: capturedKind === 'audio' ? 'audio' : 'direct',
          duration: 0,
          title: document.title || '',
          visible: true,
          unbound: douyinHost
        });
      }
      try {
        const perfList = performance.getEntriesByType('resource')
          .slice().sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0))
          .map(entry => String(entry.name || '')).filter(name =>
            /\.(mp3|m4a|aac|wav|ogg|opus|mp4|webm|mov|m4s)(?:$|\?)/i.test(name) ||
            /(douyinvod|video\/tos|mime_type=video|audio\/tos|mime_type=audio|kwimgs|kwaicdn|sns-video|xhscdn|bilivideo|hdslb|googlevideo|videoplayback|tiktokcdn|tiktokv|v16-webapp|cdninstagram|fbcdn|video\.twimg\.com)/i.test(name));
        for (const perf of perfList.slice(0, 8)) {
          const perfKind = mediaUrlKind(perf, 'video');
          const existing = list.find(candidate => candidate.url === perf);
          if (existing) {
            if (perfKind === 'audio') { existing.kind = 'audio'; existing.srcKind = 'audio'; }
            continue;
          }
          list.push({
            element: douyinHost ? null : baseElement,
            kind: perfKind === 'audio' ? 'audio' : 'video',
            url: perf,
            srcKind: perfKind === 'audio' ? 'audio' : 'direct',
            duration: 0,
            title: document.title || '',
            visible: true,
            unbound: douyinHost
          });
        }
      } catch (e) { /* ignore */ }
    }
    // Audio candidates must win over video-only DASH streams.
    if (douyinHost) {
      for (const captured of douyinCapturedUrls.filter(url => isSafeRemoteUrl(url) && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url)).slice(0, 12)) {
        if (list.some(candidate => candidate.url === captured)) continue;
        const isAudio = /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|media-audio|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(captured);
        list.push({ element: null, kind: isAudio ? 'audio' : 'video', url: captured, srcKind: 'direct', duration: 0, title: document.title || '', visible: true, unbound: true });
      }
    }
    list.sort((a, b) => (a.kind === 'audio' && b.kind !== 'audio' ? -1 : a.kind !== 'audio' && b.kind === 'audio' ? 1 : 0));
    return list;
  }

  function parseJsonSafe(text) {
    try { return JSON.parse(String(text || '')); } catch (e) { return null; }
  }

  function pushDouyinUrl(out, value) {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value) && !out.includes(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) pushDouyinUrl(out, item);
      return;
    }
    if (typeof value === 'object') {
      pushDouyinUrl(out, value.url_list);
      pushDouyinUrl(out, value.url);
      pushDouyinUrl(out, value.play_url);
      pushDouyinUrl(out, value.play_addr);
      pushDouyinUrl(out, value.play_addr_h264);
      pushDouyinUrl(out, value.play_addr_h265);
      pushDouyinUrl(out, value.play_addr_bytevc1);
    }
  }
  function collectDouyinAudioUrls(value, out, depth, parentKey, targetId) {
    if (!value || depth > 12 || out.length >= 8) return;
    if (targetId && value && !Array.isArray(value) && value.aweme_id && String(value.aweme_id) !== String(targetId)) return;
    if (Array.isArray(value)) {
      for (const item of value) collectDouyinAudioUrls(item, out, depth + 1, parentKey, targetId);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'music') {
        pushDouyinUrl(out, child && child.play_url);
        pushDouyinUrl(out, child && child.play_url_h264);
        pushDouyinUrl(out, child && child.play_url_h265);
        pushDouyinUrl(out, child && child.url_list);
        pushDouyinUrl(out, child && child.url);
      } else if (parentKey === 'music' && /^play_url(?:_h264|_h265)?$/i.test(key)) {
        pushDouyinUrl(out, child);
      }
      collectDouyinAudioUrls(child, out, depth + 1, key, targetId);
    }
  }

  function collectDouyinUrls(value, out, depth, parentKey, targetId) {
    if (!value || depth > 10 || out.length >= 8) return;
    if (targetId && value && !Array.isArray(value) && value.aweme_id && String(value.aweme_id) !== String(targetId)) return;
    if (Array.isArray(value)) {
      for (const item of value) collectDouyinUrls(item, out, depth + 1, parentKey, targetId);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^play_addr(?:_h264|_h265|_bytevc1|_264|_265)?$/i.test(key) || (key === 'play_url' && parentKey !== 'music')) {
        pushDouyinUrl(out, child);
      }
      collectDouyinUrls(child, out, depth + 1, key, targetId);
    }
  }

  function douyinAwemeIdFromUrl(value) {
    const raw = String(value || '');
    try {
      const parsed = new URL(raw, location.href || 'https://www.douyin.com/');
      for (const key of ['aweme_id', 'item_id', 'group_id']) {
        const id = String(parsed.searchParams.get(key) || '');
        if (/^\d{10,}$/.test(id)) return id;
      }
      const fromPath = parsed.pathname.match(/\/(?:video|note)\/(\d{10,})/i);
      if (fromPath) return fromPath[1];
    } catch (e) { /* fall through to the cheap regex */ }
    const match = raw.match(/(?:[?&#]|\/)(?:aweme_id|item_id|group_id)=?(\d{10,})/i);
    return match ? match[1] : '';
  }

  function douyinUrlMatchesAweme(value, targetId) {
    const target = String(targetId || '');
    if (!/^\d{10,}$/.test(target)) return false;
    return douyinAwemeIdFromUrl(value) === target;
  }

  function douyinDurationSeconds(value) {
    const duration = Number(value) || 0;
    return duration > 1000 ? duration / 1000 : duration;
  }

  function douyinPageDataUrls(targetIdOverride) {
    if (!/douyin\.com/i.test(location.hostname)) return { urls: [], audioUrls: [] };
    const targetId = String(targetIdOverride || currentDouyinAwemeId() || '');
    // Page snapshots contain every preloaded recommendation.  Without a target
    // id there is no safe way to attribute a play_addr to the current player.
    if (!/^\d{10,}$/.test(targetId)) return { urls: [], audioUrls: [] };
    const cacheKey = targetId + '@' + location.pathname;
    const cached = douyinPageDataCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const roots = [];
    const add = value => { if (value) roots.push(value); };
    try { add(window._ROUTER_DATA); } catch (e) { /* ignore */ }
    try { add(window.__INITIAL_STATE__); } catch (e) { /* ignore */ }
    try { add(window._SSR_DATA); } catch (e) { /* ignore */ }
    try { add(window._SSR_HYDRATED_DATA); } catch (e) { /* ignore */ }
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
    }
    const urls = [];
    const audioUrls = [];
    for (const root of roots) {
      collectDouyinUrls(root, urls, 0, '', targetId);
      collectDouyinAudioUrls(root, audioUrls, 0, '', targetId);
    }
    const value = { urls, audioUrls };
    douyinPageDataCache.set(cacheKey, { at: Date.now(), value });
    if (douyinPageDataCache.size > 8) {
      const oldest = [...douyinPageDataCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, douyinPageDataCache.size - 8);
      for (const [key] of oldest) douyinPageDataCache.delete(key);
    }
    return value;
  }

  function douyinUrlParam(value, name) {
    try { return new URL(String(value || ''), location.href).searchParams.get(name) || ''; } catch (e) { return ''; }
  }
  function douyinAudioTracksForVideo(video) {
    const current = String(video && (video.currentSrc || video.src) || '');
    // When the player exposes a direct URL, its audio-only companion shares
    // the same request-log token (`l`).  If the player only exposes blob:, the
    // latest audio requests are still candidates; callers must verify their
    // decoded duration against the clicked player before using them.
    const logId = /^https?:\/\//i.test(current) ? douyinUrlParam(current, 'l') : '';
    const isAudio = url => isSafeRemoteUrl(url)
      && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(String(url || ''))
      && (/media-audio/i.test(url)
        || /mime(?:[_-]?type)?=(?:audio|audio%2F)/i.test(url)
        || /audio\/tos/i.test(url)
        || /\.(?:m4a|mp3|aac)(?:$|[?&#])/i.test(url));
    const urls = [];
    try {
      window.performance.getEntriesByType('resource')
        .slice().sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0))
        .forEach(entry => urls.push(String(entry.name || '')));
    } catch (e) { /* ignore */ }
    for (const captured of douyinCapturedUrls) urls.push(captured);
    const seen = Object.create(null);
    const out = [];
    const matched = [];
    for (const url of urls) {
      if (!url || seen[url]) continue;
      seen[url] = 1;
      if (!isAudio(url)) continue;
      if (logId && douyinUrlParam(url, 'l') === logId) matched.push(url);
      out.push(url);
      if (out.length >= 8) break;
    }
    if (matched.length) return matched;
    // A signed direct URL is not always accompanied by a visible audio
    // resource entry.  Keep the recent candidates as duration-checked
    // fallbacks instead of losing the only usable audio path.
    return out.slice(0, 4);
  }
  function douyinAudioTrackForVideo(video) {
    return douyinAudioTracksForVideo(video)[0] || '';
  }
  function resolveDouyinAudioUrl(anchorVideo) {
    if (!/douyin\.com/i.test(location.hostname)) return '';
    const targetId = currentDouyinAwemeId(anchorVideo);
    if (!targetId) return '';
    const isAudio = url => isSafeRemoteUrl(url)
      && !/\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(String(url || ''))
      && /(mime(?:[_-]?type)?=(?:audio|audio%2F)|audio\/|music|\.mp3|\.m4a|\.aac|\.wav|\.ogg|opus)/i.test(String(url || ''));
    // A visible network URL only belongs to this clip when the URL names the
    // same aweme id.  Most signed CDN URLs do not, so they are deliberately
    // ignored rather than guessed from request recency.
    const captured = douyinCapturedUrls.find(url => isAudio(url) && douyinUrlMatchesAweme(url, targetId));
    if (captured) return captured;
    const page = douyinPageDataUrls(targetId);
    return page.audioUrls.find(url => isAudio(url)) || '';
  }

  function resolveDouyinMediaUrl(anchorVideo) {
    if (!/douyin\.com/i.test(location.hostname)) return '';
    const targetId = currentDouyinAwemeId(anchorVideo);
    if (!targetId) return '';
    const isImage = url => /\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(String(url || ''));
    const isM4s = url => /\.m4s(?:$|\?)/i.test(String(url || ''));
    const fromList = list => {
      const clean = list.filter(url => isSafeRemoteUrl(url) && !isImage(url) && mediaUrlKind(url, 'video') !== 'audio');
      return clean.find(url => !isM4s(url)) || clean[0] || '';
    };
    const captured = fromList(douyinCapturedUrls.filter(url => douyinUrlMatchesAweme(url, targetId)));
    if (captured) return captured;
    const pageData = douyinPageDataUrls(targetId);
    const fromPage = fromList(pageData.urls || []);
    if (fromPage) return fromPage;
    const candidates = anchorVideo && anchorVideo.isConnected
      ? [anchorVideo]
      : Array.from(document.querySelectorAll('video')).filter(video => awemeIdFromVideo(video) === targetId);
    for (const video of candidates) {
      const holder = video.closest && video.closest('[data-e2e="feed-active-video"],[data-e2e="feed-video"],[data-aweme-id],[data-video-id],[data-e2e-vid],[data-e2e="video-player"]');
      const attrs = [
        video.currentSrc, video.src,
        video.getAttribute('data-src'), video.getAttribute('data-url'),
        video.getAttribute('data-play-url'), video.getAttribute('data-video-url'),
        holder && holder.getAttribute('data-src'), holder && holder.getAttribute('data-url'),
        holder && holder.getAttribute('data-play-url'), holder && holder.getAttribute('data-video-url')
      ];
      for (const value of attrs) {
        if (value && /^https?:\/\//i.test(value) && !isImage(value)) return value;
      }
    }
    try {
      const perf = performance.getEntriesByType('resource')
        .slice().sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0))
        .map(entry => String(entry.name || ''))
        .filter(name => !isImage(name) && douyinUrlMatchesAweme(name, targetId));
      return fromList(perf);
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
          // dataUrl is normally the first chunk.  Storing both doubled the
          // payload (a 10-minute WAV could exceed 150 MB in storage).
          const chunks = Array.isArray(request.audioChunks) && request.audioChunks.length
            ? request.audioChunks.slice()
            : (request.dataUrl ? [request.dataUrl] : []);
          const stored = { audioChunks: chunks };
          storage.set({ [key]: stored }, () => {
            let storageError = null;
            try { storageError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
            if (storageError) {
              try { storage.remove(key); } catch (e) { /* ignore */ }
              finish({ ok: false, reason: 'too-large', detail: '音频数据无法暂存到扩展存储：' + String(storageError.message || storageError) });
              return;
            }
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
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: '远程转写超过 900 秒没有返回' }), 900000);
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

  function reactAwemeIdFromNode(root) {
    const seen = new WeakSet();
    const scan = (value, depth) => {
      if (!value || depth > 7 || typeof value !== 'object') return '';
      if (seen.has(value)) return '';
      seen.add(value);
      try {
        if (value.aweme_id && /^\d{10,}$/.test(String(value.aweme_id))) return String(value.aweme_id);
        if (value.awemeId && /^\d{10,}$/.test(String(value.awemeId))) return String(value.awemeId);
      } catch (e) { /* ignore */ }
      let keys = [];
      try { keys = Object.keys(value).slice(0, 80); } catch (e) { return ''; }
      for (const key of keys) {
        if (!/aweme|video|item|data|props|detail/i.test(key)) continue;
        let child = null;
        try { child = value[key]; } catch (e) { continue; }
        const found = scan(child, depth + 1);
        if (found) return found;
      }
      return '';
    };
    try {
      for (const key of Object.keys(root || {})) {
        if (!/^__react/i.test(key)) continue;
        const found = scan(root[key], 0);
        if (found) return found;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function awemeIdFromVideo(video) {
    if (!video) return '';
    for (const raw of [video.poster, video.currentSrc, video.src]) {
      const match = String(raw || '').match(/[?&](?:aweme_id|item_id|video_id)=(\d{10,})/i);
      if (match) return match[1];
    }
    // Prefer explicit DOM ownership attributes on every ancestor before
    // looking at React props.  A parent component can carry props for a list
    // of preloaded clips, and the first item in that list is not necessarily
    // the player the user clicked.
    let node = video;
    for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
      for (const attr of ['data-aweme-id', 'data-awemeid', 'data-video-id', 'data-videoid', 'data-item-id', 'data-itemid', 'data-vid', 'data-e2e-vid', 'data-id']) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value && /^\d{10,}$/.test(String(value))) return String(value);
      }
      try {
        for (const attr of Array.from(node.attributes || [])) {
          if (/(aweme|video|item|vid)/i.test(attr.name) && /^\d{10,}$/.test(String(attr.value))) return String(attr.value);
        }
      } catch (e) { /* ignore */ }
      try {
        // Douyin's detail player wrapper is `.video_<aweme_id>` without any
        // data-aweme-id attribute.  Parse that exact class before falling back
        // to the address bar, which can be stale in the recommendation feed.
        const className = String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : (node.className || ''));
        const classMatch = className.match(/(?:^|[\s_-])video[_-]?(\d{10,})(?=$|[\s_-])/i);
        if (classMatch) return classMatch[1];
      } catch (e) { /* ignore */ }
      try {
        const outer = String(node.outerHTML || '');
        const opening = outer.slice(0, Math.max(0, outer.indexOf('>') + 1));
        const match = opening.match(/(?:aweme[_-]?id|video[_-]?id|item[_-]?id|vid|data-id)["'\s:=]+(\d{10,})/i);
        if (match) return match[1];
      } catch (e) { /* ignore */ }
    }
    node = video;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const reactId = reactAwemeIdFromNode(node);
      if (reactId) return reactId;
    }
    return '';
  }

  function currentDouyinAwemeId(anchorVideo) {
    // The clicked player is the strongest signal.  Recommendation feeds keep
    // the URL and page data on the previous clip, so never let them win over
    // the exact <video> the user pressed.
    const fromAnchor = awemeIdFromVideo(anchorVideo);
    if (fromAnchor) return fromAnchor;
    // When an anchor player was supplied, do not fall back to the URL: the
    // recommendation feed often leaves the previous clip's /video/{id} in the
    // address bar.  The one safe exception is a real `/video/{id}` detail page
    // whose player has no id attributes at all (current Douyin builds put the
    // id only in the wrapper class, which `awemeIdFromVideo` now reads too).
    if (anchorVideo) {
      try {
        const detailMatch = location.pathname.match(/\/video\/(\d+)/);
        const detailPlayer = anchorVideo.closest && anchorVideo.closest('.video-detail-container,[data-e2e="video-detail"]');
        if (detailMatch && detailPlayer) return detailMatch[1];
      } catch (e) { /* ignore */ }
      return '';
    }
    try {
      const canonical = document.querySelector('link[rel="canonical"],meta[property="og:url"]');
      const canonicalUrl = canonical && (canonical.href || canonical.content || '');
      const fromCanonical = String(canonicalUrl).match(/\/(?:video|note)\/(\d+)/i);
      if (fromCanonical) return fromCanonical[1];
    } catch (e) { /* ignore */ }
    try {
      const fromUrl = location.pathname.match(/\/video\/(\d+)/) || location.search.match(/[?&](?:modal_id|aweme_id)=(\d+)/);
      if (fromUrl) return fromUrl[1];
    } catch (e) { /* ignore */ }
    const videos = Array.from(document.querySelectorAll('video')).sort((a, b) => videoActivityScore(b) - videoActivityScore(a));
    for (const video of videos) {
      const id = awemeIdFromVideo(video);
      if (id) return id;
    }
    return '';
  }

  function requestDouyinDetail(preferredAwemeId, anchorVideo) {
    return new Promise(resolve => {
      if (!/douyin\.com|iesdouyin\.com/i.test(location.hostname)) { resolve(null); return; }
      const requested = String(preferredAwemeId || '').trim();
      // Ask for an explicit id whenever we can derive one.  Sending an empty id
      // let the MAIN-world hook fall back to its own heuristics (address bar,
      // last API id, preloaded neighbours), which is how a summary could come
      // back describing a completely different clip.
      const explicitId = /^\d{10,}$/.test(requested) ? requested : currentDouyinAwemeId(anchorVideo);
      const cacheKey = (explicitId ? String(explicitId) : 'anon')
        + '|' + location.pathname
        + '|' + String(anchorVideo && (anchorVideo.currentSrc || anchorVideo.src) || '');
      const cached = douyinDetailCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 120000) { resolve(cached.value); return; }
      let settled = false;
      const id = 'dy-detail-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let markedAnchor = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        try {
          if (markedAnchor && anchorVideo) anchorVideo.removeAttribute('data-lps-current-video');
        } catch (e) { /* ignore */ }
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        // An anonymous request cannot be attributed to the clicked player.
        // Drop the response instead of letting a neighbouring clip through.
        if (value && value.awemeId && (!explicitId || String(value.awemeId) === String(explicitId))) {
          douyinDetailCache.set(cacheKey, { at: Date.now(), value });
          if (douyinDetailCache.size > 12) {
            const oldest = [...douyinDetailCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, douyinDetailCache.size - 12);
            for (const [key] of oldest) douyinDetailCache.delete(key);
          }
        }
        resolve(value || null);
      };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_DOUYIN_DETAIL_RESULT' || event.data.id !== id) return;
        finish(event.data.ok ? { audio: event.data.audio || [], video: event.data.video || [], title: event.data.title || '', awemeId: event.data.awemeId || '', duration: Number(event.data.duration) || 0 } : null);
      };
      const timer = setTimeout(() => finish(null), 9000);
      window.addEventListener('message', onMessage);
      try {
        if (anchorVideo && anchorVideo.setAttribute) {
          anchorVideo.setAttribute('data-lps-current-video', '1');
          markedAnchor = true;
        }
        window.postMessage({ source: 'LPS_DOUYIN_DETAIL', id, awemeId: explicitId || '' }, '*');
      } catch (e) { finish(null); }
    });
  }

  function requestDouyinResolve(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: '抖音解析超过 35 秒没有返回' }), 35000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish({ ok: false, reason: 'no-runtime' }); return; }
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:resolveDouyin', url }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          finish(response || { ok: false, reason: 'no-response' });
        });
      } catch (e) { finish({ ok: false, reason: 'network', detail: String(e && e.message || e) }); }
    });
  }

  function requestKuaishouResolve(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(null), 12000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish(null); return; }
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:resolveKuaishou', url }, response => {
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
    // startFrame/endFrame are positions on the *output* timeline (16 kHz).
    // The old code mixed source-frame offsets with output-frame counts and
    // scaled them a second time, so every chunk after the first accelerated
    // toward the end of the source and turned into silence.
    const totalOutFrames = Math.max(0, Math.ceil(buffer.length * outRate / sourceRate));
    const start = Math.max(0, Math.min(totalOutFrames, Math.floor(startFrame || 0)));
    const end = Math.max(start, Math.min(totalOutFrames, Math.ceil(endFrame == null ? totalOutFrames : endFrame)));
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
    const channelData = [];
    for (let c = 0; c < outChannels; c++) channelData.push(buffer.getChannelData(Math.min(c, sourceChannels - 1)));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      const sourceIndex = Math.min(buffer.length - 1, Math.floor((start + i) * sourceRate / outRate));
      for (let c = 0; c < outChannels; c++) {
        const sample = channelData[c][sourceIndex] || 0;
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
    const totalOutFrames = Math.max(0, Math.ceil(buffer.length * outRate / buffer.sampleRate));
    const chunks = [];
    for (let start = 0; start < totalOutFrames; start += framesPerChunk) {
      const blob = audioBufferToWav(buffer, outRate, 1, start, Math.min(totalOutFrames, start + framesPerChunk));
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

  async function captureAudioFromMediaUrl(url, duration) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    let host = null;
    let audio = null;
    try {
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
      audio = document.createElement('audio');
      audio.src = url;
      audio.preload = 'auto';
      audio.muted = true;
      audio.volume = 0;
      audio.setAttribute('aria-hidden', 'true');
      host.appendChild(audio);
      document.documentElement.appendChild(host);
      const ready = await new Promise(resolve => {
        let done = false;
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          audio.removeEventListener('loadedmetadata', onReady);
          audio.removeEventListener('canplay', onReady);
          audio.removeEventListener('error', onError);
          resolve(value);
        };
        const onReady = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), 10000);
        audio.addEventListener('loadedmetadata', onReady, { once: true });
        audio.addEventListener('canplay', onReady, { once: true });
        audio.addEventListener('error', onError, { once: true });
      });
      if (!ready) return null;
      // Decoding a complete muxed MP4 through decodeAudioData is rejected by
      // some Chromium builds.  A hidden media element still decodes its AAC
      // track, so capture that track at 4x with Web Audio (never audible and
      // never sent to the model as video).
      return await captureMediaElementAudio(audio, null, {
        background: true,
        captureRate: 4,
        duration: Number(duration) || Number(audio.duration) || 0
      });
    } catch (e) {
      return null;
    } finally {
      try { if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } } catch (e) { /* ignore */ }
      try { if (host && host.parentNode) host.remove(); } catch (e) { /* ignore */ }
    }
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
        if (data && data.dataUrl) arrayBuffer = dataUrlToArrayBuffer(data.dataUrl);
      }
    } catch (e) { /* fall through to media-element capture */ }
    if (arrayBuffer && arrayBuffer.byteLength <= MEDIA_MAX_BYTES) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) {
        const context = new AudioCtor();
        try {
          const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
          const channel = audioBuffer.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < channel.length; i += 16) peak = Math.max(peak, Math.abs(channel[i]));
          if (peak < 0.0005) return null;
          const chunks = await audioBufferToWavChunks(audioBuffer);
          if (!chunks.length) return null;
          const fullBlob = audioBufferToWav(audioBuffer, 16000, 1, 0,
            Math.ceil(audioBuffer.length * 16000 / audioBuffer.sampleRate));
          return { dataUrl: chunks[0], chunks, fullBlob, mime: 'audio/wav', duration: audioBuffer.duration };
        } catch (e) {
          /* try the media-element path below */
        } finally {
          try { context.close(); } catch (e) { /* ignore */ }
        }
      }
    }
    if (candidate.srcKind !== 'blob' && /^https?:\/\//i.test(candidate.url)) {
      return await captureAudioFromMediaUrl(candidate.url, candidate.duration);
    }
    return null;
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

  function requestDouyinMseChunks(blobUrl) {
    return new Promise(resolve => {
      if (!/douyin\.com|iesdouyin\.com/i.test(location.hostname)) { resolve([]); return; }
      const id = 'dy-mse-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      let settled = false;
      const finish = chunks => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(Array.isArray(chunks) ? chunks.filter(chunk => chunk && chunk.data instanceof ArrayBuffer && chunk.data.byteLength) : []);
      };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== 'LPS_DOUYIN_MSE_RESULT' || event.data.id !== id) return;
        finish(event.data.chunks || []);
      };
      const timer = setTimeout(() => finish([]), 10000);
      window.addEventListener('message', onMessage);
      try { window.postMessage({ source: 'LPS_DOUYIN_MSE_REQUEST', id, blobUrl: String(blobUrl || '') }, '*'); }
      catch (e) { finish([]); }
    });
  }

  async function extractAudioFromMseChunks(chunks) {
    if (!Array.isArray(chunks) || !chunks.length) return null;
    const groups = new Map();
    for (const chunk of chunks) {
      if (!chunk || !(chunk.data instanceof ArrayBuffer) || !chunk.data.byteLength) continue;
      // Old hook builds used the MediaSource owner as `id`, so audio and video
      // appends landed in one bucket and decodeAudioData received a muxed,
      // unordered stream.  Include mime as a defensive second key.
      const id = String(chunk.id || 0) + '|' + String(chunk.mime || '');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(chunk);
    }
    if (!groups.size) return null;
    const groupList = Array.from(groups.values());
    const audioGroups = groupList.filter(group => /audio/i.test(String(group[0] && group[0].mime || '')));
    const selected = (audioGroups.length ? audioGroups : groupList)
      .sort((a, b) => {
        const size = group => group.reduce((sum, chunk) => sum + (chunk.data.byteLength || 0), 0);
        return size(b) - size(a);
      })[0];
    if (!selected || !selected.length) return null;
    const mime = String(selected[0].mime || 'video/mp4').replace(/;.*$/, '');
    let arrayBuffer = null;
    try {
      const blob = new Blob(selected.map(chunk => chunk.data), { type: mime });
      arrayBuffer = await blob.arrayBuffer();
    } catch (e) { return null; }
    if (!arrayBuffer || !arrayBuffer.byteLength || arrayBuffer.byteLength > MEDIA_MAX_BYTES) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    const context = new AudioCtor();
    try {
      const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      const channel = audioBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < channel.length; i += 16) peak = Math.max(peak, Math.abs(channel[i]));
      if (peak < 0.0005) return null;
      const wavChunks = await audioBufferToWavChunks(audioBuffer);
      if (!wavChunks.length) return null;
      const fullBlob = audioBufferToWav(audioBuffer, 16000, 1, 0,
        Math.ceil(audioBuffer.length * 16000 / audioBuffer.sampleRate));
      return { dataUrl: wavChunks[0], chunks: wavChunks, fullBlob, mime: 'audio/wav', duration: audioBuffer.duration, source: 'mse' };
    } catch (e) {
      return null;
    } finally {
      try { context.close(); } catch (e) { /* ignore */ }
    }
  }

  // Recording a MediaSource player at 4x on the foreground element would make
  // the user watch a fast-forward video.  Clone the player off-screen first and
  // record that clone, leaving the visible playback completely untouched.
  async function createBackgroundVideo(source) {
    if (!source) return null;
    const src = String(source.currentSrc || source.src || '').trim();
    const sourceStream = source.srcObject || null;
    if (!/^(https?:|blob:|data:)/i.test(src) && !sourceStream) return null;
    let clone = null;
    let host = null;
    try {
      // Keep the clone inside a closed shadow root so Douyin's own
      // document.querySelectorAll('video') cannot select it as the feed video.
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      clone = document.createElement('video');
      if (src) clone.src = src;
      else if (sourceStream) clone.srcObject = sourceStream;
      clone.preload = 'auto';
      clone.muted = true;
      clone.volume = 0;
      clone.playsInline = true;
      clone.setAttribute('aria-hidden', 'true');
      clone.style.cssText = 'width:1px;height:1px;';
      clone.__lpsHost = host;
      shadow.appendChild(clone);
      document.documentElement.appendChild(host);
      const ready = await new Promise(resolve => {
        let done = false;
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clone.removeEventListener('loadedmetadata', onReady);
          clone.removeEventListener('canplay', onReady);
          clone.removeEventListener('error', onError);
          resolve(value);
        };
        const onReady = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), 8000);
        clone.addEventListener('loadedmetadata', onReady, { once: true });
        clone.addEventListener('canplay', onReady, { once: true });
        clone.addEventListener('error', onError, { once: true });
      });
      // MediaSource/Blob players often expose duration as NaN or Infinity
      // until more segments arrive.  Metadata readiness is enough; the caller
      // uses the source player duration as the capture deadline.
      if (!ready) {
        removeBackgroundVideo(clone);
        return null;
      }
      return clone;
    } catch (e) {
      try { removeBackgroundVideo(clone); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  function removeBackgroundVideo(video) {
    if (!video) return;
    try { video.pause(); } catch (e) { /* ignore */ }
    try { const host = video.__lpsHost; if (host && host.parentNode) host.remove(); else video.remove(); } catch (e) { /* ignore */ }
  }

  async function captureMediaElementAudio(video, item, opts) {
    if (!video) return null;
    const rate = Math.max(1, Math.min(8, Number(opts && opts.captureRate) || 1.25));
    const background = !!(opts && opts.background);
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    let context = null;
    let source = null;
    let processor = null;
    let silent = null;
    let stateCaptured = false;
    let wasPaused = false;
    let wasPlaying = false;
    let oldTime = 0;
    let oldRate = 1;
    let oldMuted = false;
    let oldVolume = 1;
    let oldPreservesPitch = true;
    const restore = () => {
      if (!stateCaptured) return;
      stateCaptured = false;
      try { video.playbackRate = oldRate; } catch (e) { /* ignore */ }
      try { video.muted = oldMuted; } catch (e) { /* ignore */ }
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      try { video.preservesPitch = oldPreservesPitch; } catch (e) { /* ignore */ }
      if (wasPaused) { try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ } }
      else if (wasPlaying) { try { video.currentTime = oldTime; video.play(); } catch (e) { /* ignore */ } }
    };
    try {
      context = new AudioCtor();
      await context.resume();
      source = context.createMediaElementSource(video);
      processor = context.createScriptProcessor(4096, 1, 1);
      silent = context.createGain();
      silent.gain.value = 0;
      const samples = [];
      processor.onaudioprocess = event => {
        const data = event.inputBuffer.getChannelData(0);
        samples.push(new Float32Array(data));
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      wasPaused = !!video.paused;
      wasPlaying = !wasPaused;
      oldTime = Number(video.currentTime) || 0;
      oldRate = Number(video.playbackRate) || 1;
      oldMuted = !!video.muted;
      oldVolume = Number(video.volume);
      oldPreservesPitch = video.preservesPitch !== false;
      stateCaptured = true;
      if (background) { video.muted = false; video.volume = 0; }
      else { video.muted = false; video.volume = Math.max(0.2, Number(video.volume) || 1); }
      video.currentTime = 0;
      video.playbackRate = rate;
      try { video.preservesPitch = true; } catch (e) { /* ignore */ }
      try { await video.play(); } catch (e) { /* ignore */ }
      const rawDuration = Number(video.duration);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration : (Number(opts && opts.duration) || 0);
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / rate + 2000)) : 5 * 60 * 1000;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('ended', finish); resolve(); };
        const timer = setTimeout(finish, waitMs);
        video.addEventListener('ended', finish, { once: true });
      });
      if (!samples.length) return null;
      const total = samples.reduce((sum, part) => sum + part.length, 0);
      if (!total) return null;
      const merged = new Float32Array(total);
      let offset = 0;
      let peak = 0;
      for (const part of samples) {
        merged.set(part, offset);
        offset += part.length;
        for (let i = 0; i < part.length; i += 8) peak = Math.max(peak, Math.abs(part[i]));
      }
      if (peak < 0.0005) return null;
      const audioBuffer = context.createBuffer(1, total, context.sampleRate);
      audioBuffer.copyToChannel(merged, 0);
      const chunks = await audioBufferToWavChunks(audioBuffer);
      if (!chunks.length) return null;
      return { dataUrl: chunks[0], chunks, mime: 'audio/wav', duration: audioBuffer.duration };
    } catch (e) {
      return null;
    } finally {
      try { if (source) source.disconnect(); } catch (e) { /* ignore */ }
      try { if (processor) processor.disconnect(); } catch (e) { /* ignore */ }
      try { if (silent) silent.disconnect(); } catch (e) { /* ignore */ }
      try { if (context) context.close(); } catch (e) { /* ignore */ }
      restore();
    }
  }

  async function captureStreamAudioWebAudio(video, item, opts) {
    const rate = Math.max(1, Math.min(8, Number(opts && opts.captureRate) || 1.25));
    const background = !!(opts && opts.background);
    if (!video || typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    let stream = null;
    let context = null;
    let source = null;
    let processor = null;
    let silent = null;
    let stateCaptured = false;
    let wasPaused = false;
    let wasPlaying = false;
    let oldTime = 0;
    let oldRate = 1;
    let oldMuted = false;
    let oldVolume = 1;
    let oldPreservesPitch = true;
    const restorePlayback = () => {
      if (!stateCaptured) return;
      stateCaptured = false;
      try { video.playbackRate = oldRate; } catch (e) { /* ignore */ }
      try { video.muted = oldMuted; } catch (e) { /* ignore */ }
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      try { video.preservesPitch = oldPreservesPitch; } catch (e) { /* ignore */ }
      if (wasPaused) {
        try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ }
      } else if (wasPlaying) {
        try { video.currentTime = oldTime; video.play(); } catch (e) { /* ignore */ }
      }
    };
    try {
      const rawStream = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
      if (!rawStream || !rawStream.getAudioTracks) return null;
      const audioTracks = rawStream.getAudioTracks();
      if (!audioTracks.length) {
        try { rawStream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
        return null;
      }
      // Keep only the audio tracks.  Passing a video+audio stream to
      // MediaRecorder with an audio/* mime type can throw; it also needlessly
      // duplicates video decoding during a long capture.
      try { rawStream.getVideoTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      stream = new MediaStream(audioTracks);
      context = new AudioCtor();
      await context.resume();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      silent = context.createGain();
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
      wasPaused = !!video.paused;
      wasPlaying = !wasPaused;
      oldTime = Number(video.currentTime) || 0;
      oldRate = Number(video.playbackRate) || 1;
      oldMuted = !!video.muted;
      oldVolume = Number(video.volume);
      oldPreservesPitch = video.preservesPitch !== false;
      stateCaptured = true;
      if (background) { video.muted = false; video.volume = 0; }
      else { video.muted = false; video.volume = Math.max(0.2, Number(video.volume) || 1); }
      video.currentTime = 0;
      video.playbackRate = rate;
      try { video.preservesPitch = true; } catch (e) { /* ignore */ }
      try { await video.play(); } catch (e) { /* ignore */ }
      const rawDuration = Number(video.duration);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration : (Number(opts && opts.duration) || 0);
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / rate + 2000)) : 5 * 60 * 1000;
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
      if (!samples.length) return null;
      const total = samples.reduce((sum, part) => sum + part.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const part of samples) { merged.set(part, offset); offset += part.length; }
      let peak = 0;
      for (let i = 0; i < merged.length; i += 8) peak = Math.max(peak, Math.abs(merged[i]));
      if (peak < 0.0005) return null;
      const audioBuffer = context.createBuffer(1, total, context.sampleRate);
      audioBuffer.copyToChannel(merged, 0);
      const chunks = await audioBufferToWavChunks(audioBuffer);
      if (!chunks.length) return null;
      return { dataUrl: chunks[0], chunks, mime: 'audio/wav', duration: audioBuffer.duration };
    } catch (e) {
      return null;
    } finally {
      try { if (processor) processor.disconnect(); } catch (e) { /* ignore */ }
      try { if (source) source.disconnect(); } catch (e) { /* ignore */ }
      try { if (silent) silent.disconnect(); } catch (e) { /* ignore */ }
      try { if (stream) stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      try { if (context) context.close(); } catch (e) { /* ignore */ }
      restorePlayback();
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
    const rate = Math.max(1, Math.min(8, Number(candidate && candidate.captureRate) || 1.25));
    const background = !!(candidate && candidate.backgroundCapture);
    const video = candidate && candidate.element;
    if (!video || typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') return null;
    let rawStream = null;
    let stream = null;
    let recorder = null;
    let fallback = false;
    let result = null;
    let stateCaptured = false;
    let wasPaused = false;
    let wasPlaying = false;
    let oldTime = 0;
    let oldRate = 1;
    let oldMuted = false;
    let oldVolume = 1;
    let oldPreservesPitch = true;
    const restorePlayback = () => {
      if (!stateCaptured) return;
      stateCaptured = false;
      try { video.playbackRate = oldRate; } catch (e) { /* ignore */ }
      try { video.muted = oldMuted; } catch (e) { /* ignore */ }
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      try { video.preservesPitch = oldPreservesPitch; } catch (e) { /* ignore */ }
      if (wasPaused) {
        try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ }
      } else if (wasPlaying) {
        try { video.currentTime = oldTime; video.play(); } catch (e) { /* ignore */ }
      }
    };
    try {
      const readStream = () => {
        if (video.srcObject && video.srcObject.getAudioTracks) return video.srcObject;
        return typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
      };
      rawStream = readStream();
      if (!rawStream || !rawStream.getAudioTracks) return null;
      let audioTracks = rawStream.getAudioTracks();
      // MSE players often expose audio tracks only after playback starts.
      if (!audioTracks.length) {
        try { await video.play(); } catch (e) { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 180));
        rawStream = readStream();
        audioTracks = rawStream && rawStream.getAudioTracks ? rawStream.getAudioTracks() : [];
      }
      if (!audioTracks.length) return null;
      try { rawStream.getVideoTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      stream = new MediaStream(audioTracks);
      if (typeof MediaRecorder === 'undefined') { fallback = true; return null; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', '']
        .find(type => !type || MediaRecorder.isTypeSupported(type));
      if (mime == null) { fallback = true; return null; }
      const chunks = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; recorder.onerror = resolve; });
      recorder.start(1000);
      wasPaused = !!video.paused;
      wasPlaying = !wasPaused;
      oldTime = Number(video.currentTime) || 0;
      oldRate = Number(video.playbackRate) || 1;
      oldMuted = !!video.muted;
      oldVolume = Number(video.volume);
      oldPreservesPitch = video.preservesPitch !== false;
      stateCaptured = true;
      if (background) { video.muted = false; video.volume = 0; }
      else { video.muted = false; video.volume = Math.max(0.2, Number(video.volume) || 1); }
      const captureLabel = background ? ('正在后台 ' + rate + '× 录制音频…') : '正在从播放器录制音频…';
      if (item && item.ui && item.ui.mediaStatus) item.ui.mediaStatus.textContent = captureLabel;
      if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 28, captureLabel);
      video.currentTime = 0;
      video.playbackRate = rate;
      try { video.preservesPitch = true; } catch (e) { /* ignore */ }
      try { await video.play(); } catch (e) { /* autoplay may still work after gesture */ }
      const rawDuration = Number(video.duration);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : (Number(candidate.duration) || 0);
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / rate + 2000)) : 5 * 60 * 1000;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('ended', finish); resolve(); };
        const timer = setTimeout(finish, waitMs);
        video.addEventListener('ended', finish, { once: true });
      });
      try { recorder.stop(); } catch (e) { /* ignore */ }
      await stopped;
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      if (!blob.size || !(await blobHasAudio(blob))) fallback = true;
      else result = { dataUrl: await blobToDataUrl(blob), mime: blob.type || 'audio/webm', duration };
    } catch (e) {
      fallback = true;
    } finally {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* ignore */ }
      try { if (stream) stream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      try { if (rawStream) rawStream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      restorePlayback();
    }
    if (fallback) return captureStreamAudioWebAudio(video, item, {
      captureRate: rate,
      background: background,
      duration: Number(candidate && candidate.duration) || 0
    });
    return result;
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
    if (reason === 'dash' || reason === 'invalid-hls' || reason === 'empty-hls' || reason === 'unsupported-container') return '暂不支持解析这个流媒体格式：' + detail;
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
    if (!item || !item.ui || !item.ui.panel) return;
    const head = item.ui.panel.querySelector('.panel-head');
    // panelFrame() replaces the whole panel body on every re-render, so the
    // marker must live on the current head, not on the persistent panel node.
    if (!head || head.dataset.summaryDragBound) return;
    head.dataset.summaryDragBound = '1';
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
    if (!shell || !shell.backdrop || !windows.length) return;
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
    // The video AI launcher and loading card live outside the shadow host.
    try { if (typeof refreshVideoAITheme === 'function') refreshVideoAITheme(); } catch (e) { /* ignore */ }
    try { if (summaryLoadingHost) summaryLoadingHost.dataset.theme = overlayThemeDark() ? 'dark' : 'light'; } catch (e) { /* ignore */ }
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
      const width = Math.min(v.w - 8, Math.max(320, rememberedWidth || Math.min(540, Math.max(380, Math.round(v.w * 0.38)))));
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
    win.querySelectorAll(SUMMARY_TEXT_SELECTOR).forEach(node => { node.style.fontSize = fontSize + 'px'; });
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
    // Summary UI lives inside the closed shadow root.  A stylesheet appended
    // to document.head cannot style it, which made A−/A+ fall back to native
    // button colors and ignore light/dark themes.
    const root = shell && shell.root;
    if (summaryAppearanceStyle && summaryAppearanceStyle.isConnected && root && summaryAppearanceStyle.parentNode === root) return;
    if (summaryAppearanceStyle) { try { summaryAppearanceStyle.remove(); } catch (e) { /* ignore */ } }
    const style = document.createElement('style');
    style.id = 'ldp-summary-appearance-style';
    style.textContent = '.summary-window .video-summary-answer,.summary-window .media-summary-answer,.summary-window .text-ai-answer,.summary-window .ai-answer{font-size:var(--summary-font-size,14px)!important;line-height:1.72}.ldp-stream-dots{display:inline-flex;gap:1px;margin-left:3px;color:var(--accent);vertical-align:bottom}.ldp-stream-dots[hidden]{display:none!important}.ldp-stream-dots i{font-style:normal;line-height:1;animation:ldp-dot-blink 1.2s infinite}.ldp-stream-dots i:nth-child(2){animation-delay:.2s}.ldp-stream-dots i:nth-child(3){animation-delay:.4s}.summary-window .video-summary-answer.streaming,.summary-window .media-summary-answer.streaming{min-height:24px}.summary-appearance{display:inline-flex;align-items:center;gap:5px;margin-left:auto;color:var(--muted);font-size:10px;white-space:nowrap}.summary-appearance-label{font-size:10px}.summary-appearance-btn{height:24px;padding:0 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:11px/1 sans-serif;cursor:pointer}.summary-appearance-btn:hover{border-color:var(--accent);color:var(--accent)}.summary-opacity-range{width:64px;accent-color:var(--accent);height:14px}.summary-appearance-value{min-width:60px;font-variant-numeric:tabular-nums;text-align:right}@keyframes ldp-dot-blink{0%,70%,100%{opacity:.18}35%{opacity:1}}@keyframes ldp-status-spin{to{transform:rotate(360deg)}}';
    (root || document.head || document.documentElement).appendChild(style);
    summaryAppearanceStyle = style;
  }

  /** Everything in a summary that follows the 字号 A± control. */
  const SUMMARY_TEXT_SELECTOR = '.video-summary-answer,.media-summary-answer,.text-ai-answer,.ai-answer,'
    + '.followup-text,.followup-input,.followup-title,.followup-hint,.followup-role';

  function summaryFontSizeValue(item) {
    return Math.max(12, Math.min(22, Number(item && item.summaryFontSize == null
      ? (settings.summaryFontSize || 14)
      : item.summaryFontSize) || 14));
  }

  /**
   * Apply the summary font size to the answer AND the follow-up composer, so the
   * question/answer text matches the summary instead of staying at a fixed size.
   */
  function applySummaryTextStyle(item, node) {
    if (!item) return;
    const fs = summaryFontSizeValue(item);
    const win = item.ui && item.ui.win;
    if (win) {
      win.style.setProperty('--summary-font-size', fs + 'px');
      win.dataset.summaryFontSize = String(fs);
      win.querySelectorAll(SUMMARY_TEXT_SELECTOR).forEach(target => { target.style.fontSize = fs + 'px'; });
    }
    if (node) node.style.fontSize = fs + 'px';
  }

  function requestMediaDownload(item, candidate, kindOverride, filenameOverride) {
    const url = String(candidate && candidate.url || '');
    if (!url) { toast(item, '没有可下载的媒体地址'); return; }
    const filename = filenameOverride || cleanDownloadName(item, candidate, kindOverride);
    if (/^blob:/i.test(url)) {
      fetch(url).then(response => response.blob()).then(blob => {
        downloadBlob(blob, filename);
      }).catch(() => toast(item, 'Blob 媒体无法下载'));
      return;
    }
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { toast(item, '扩展后台不可用'); return; }
    const fallback = () => {
      EXT.runtime.sendMessage({
        namespace: 'LPS_EXT',
        type: 'ldp:downloadMedia',
        url,
        filename
      }, response => {
        try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
        if (!response || !response.ok) toast(item, '下载启动失败：' + String(response && (response.detail || response.reason) || '未知原因'));
      });
    };
    // Fetch in the page first.  Douyin's CDN requires a first-party Referer;
    // fetching here preserves the page referrer and lets <a download> save the
    // file without the downloads API's Save-As cancellation path.  If CORS or
    // a site policy blocks it, fall back to the background downloader.
    if (typeof fetch === 'function') {
      toast(item, '正在下载媒体…');
      fetch(url, { credentials: 'same-origin' }).then(response => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.blob();
      }).then(blob => {
        if (!blob || !blob.size) throw new Error('媒体为空');
        if (downloadBlob(blob, filename)) toast(item, '下载已开始');
      }).catch(() => {
        toast(item, '页面下载受限，正在交给后台下载…');
        fallback();
      });
      return;
    }
    fallback();
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
    if (audioCandidate) {
      await prepareAndSave(item, {
        url: audioCandidate.url,
        kind: 'audio',
        label: '音频',
        filename: cleanDownloadName(item, audioCandidate, 'audio')
      });
      return;
    }
    const videoCandidate = (state.list || []).find(candidate => candidate.kind === 'video' && candidate.url) || state.candidate;
    if (!videoCandidate || videoCandidate.kind !== 'video') { toast(item, '当前没有可提取的音轨'); return; }
    updateDownloadProgress(item, 3, '正在从视频中提取音轨…');
    const audio = await extractAudioFromVideo(videoCandidate);
    if (audio && audio.fullBlob) {
      updateDownloadProgress(item, 100, '提取完成，正在保存…');
      downloadBlob(audio.fullBlob, cleanDownloadName(item, videoCandidate, 'audio').replace(/\.[^.]+$/, '.wav'));
      setTimeout(() => hideDownloadProgress(item), 2500);
    } else {
      updateDownloadProgress(item, 0, '音频提取失败：没有可下载的独立音轨', 'bad');
    }
  }

  async function ensureDouyinDownloadCandidates(item) {
    const state = item && item.mediaState;
    if (!state || !/douyin\.com|iesdouyin\.com/i.test(location.hostname)) return state;
    const anchorVideo = item.anchorVideo && item.anchorVideo.isConnected
      ? item.anchorVideo
      : (typeof findActiveVideoElement === 'function' ? findActiveVideoElement() : null);
    if (anchorVideo) state.anchorVideo = anchorVideo;
    if (!Array.isArray(state.list)) state.list = [];
    if (!anchorVideo) return state;
    if (!state.downloadDetailPromise) {
      const requestedId = currentDouyinAwemeId(anchorVideo);
      state.downloadRequestedId = requestedId;
      state.downloadDetailPromise = requestDouyinDetail(requestedId, anchorVideo);
    }
    let detail = null;
    try { detail = await state.downloadDetailPromise; } catch (e) { detail = null; }
    if (!detail || item.closed) return state;
    const currentId = state.downloadRequestedId || currentDouyinAwemeId(anchorVideo);
    const mediaDuration = Number(anchorVideo.duration) || 0;
    const detailId = douyinDetailBoundId(detail, currentId, mediaDuration);
    if (!detailId) return state;
    state.boundAwemeId = detailId;
    state.boundTitle = detail.title || state.boundTitle || '';
    appendDouyinDetailCandidates(state.list, detail, detailId, mediaDuration, state.boundTitle);
    if (!state.candidate || !state.candidate.url) state.candidate = state.list[0] || null;
    return state;
  }

  async function ensureMediaForDownload(item) {
    if (!item || item.closed) return null;
    const anchorVideo = item.anchorVideo && item.anchorVideo.isConnected
      ? item.anchorVideo
      : (typeof findActiveVideoElement === 'function' ? findActiveVideoElement() : null);
    let state = item.mediaState;
    if (!state) {
      state = item.mediaState = {
        busy: false, cancelled: false, answer: '', transcript: '', transcriptCues: [], transcriptDuration: 0,
        error: '', subtitleError: '', textMode: false, list: [], anchorVideo: anchorVideo || null,
        candidate: null, prompt: ''
      };
    }
    if (anchorVideo) {
      state.anchorVideo = anchorVideo;
      if (!item.anchorVideo) item.anchorVideo = anchorVideo;
    }
    if (!Array.isArray(state.list)) state.list = [];
    if (!state.list.length && typeof scanMediaCandidates === 'function') state.list = scanMediaCandidates();
    // Subtitle summaries never needed the media list before.  Resolve the
    // detail once on first download so the MP4 and its audio-only track are
    // both available even when the summary came from captions.
    if (!/douyin\.com|iesdouyin\.com/i.test(location.hostname) || !anchorVideo) return state;
    return ensureDouyinDownloadCandidates(item);
  }

  async function downloadVideoFromSummary(item) {
    if (!item || item.closed) return;
    if (/bilibili\.com/i.test(location.hostname)) { await downloadBilibiliVideo(item); return; }
    updateDownloadProgress(item, 2, '正在解析视频下载地址…');
    try {
      await ensureMediaForDownload(item);
      // Prefer the candidate capability detection already verified; it may be a
      // direct URL or a fetchable blob source that is not part of the list.
      const verified = item.downloadVideoCandidate;
      if (verified && verified.srcKind === 'hls') {
        const base = String((item.videoState && item.videoState.info && item.videoState.info.title) || document.title || 'video')
          .replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim().slice(0, 80) || 'video';
        const name = base + '.ts';
        const result = await downloadHlsStream(item, verified.url, { label: '视频', filename: name });
        downloadBlob(result.blob, result.filename);
        updateDownloadProgress(item, 100, '视频已保存');
        return;
      }
      const list = item.mediaState && Array.isArray(item.mediaState.list) ? item.mediaState.list : null;
      if (verified && verified.url && list && !list.includes(verified)) list.unshift(verified);
      await downloadMediaVideo(item);
    } catch (e) {
      updateDownloadProgress(item, 0, '视频下载失败：' + String(e && e.message || e || '未知错误'), 'bad');
    }
  }

  async function downloadAudioFromSummary(item) {
    if (!item || item.closed) return;
    if (/bilibili\.com/i.test(location.hostname)) { await downloadBilibiliAudio(item); return; }
    updateDownloadProgress(item, 2, '正在解析音频下载地址…');
    try {
      await ensureMediaForDownload(item);
      await downloadMediaAudio(item);
    } catch (e) {
      updateDownloadProgress(item, 0, '音频下载失败：' + String(e && e.message || e || '未知错误'), 'bad');
    }
  }

  function requestBilibiliVideo(url) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', detail: 'B 站视频解析超过 20 秒没有返回' }), 20000);
      if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { finish({ ok: false, reason: 'no-runtime' }); return; }
      try {
        EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:resolveBilibiliVideo', url }, response => {
          try { void EXT.runtime.lastError; } catch (e) { /* ignore */ }
          finish(response || { ok: false, reason: 'no-response' });
        });
      } catch (e) { finish({ ok: false, reason: 'network', detail: String(e && e.message || e) }); }
    });
  }

  function biliVideoInfoFromPage() {
    try {
      const roots = [window.__INITIAL_STATE__, window.__playinfo__, window.__INITIAL_DATA__];
      for (const root of roots) {
        if (!root || typeof root !== 'object') continue;
        const video = root.videoData || (root.videoInfo && root.videoInfo.data) || root;
        const title = String(video && (video.title || (video.videoData && video.videoData.title)) || '').trim();
        if (title) return { title };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function bilibiliProgressiveMedia() {
    if (!/bilibili\.com/i.test(location.hostname)) return null;
    const resolved = await requestBilibiliVideo(location.href);
    if (!resolved || !resolved.ok || !resolved.url) return null;
    return {
      url: resolved.url,
      urls: Array.isArray(resolved.urls) && resolved.urls.length ? resolved.urls : [resolved.url],
      title: String(resolved.title || document.title || ''),
      duration: Number(resolved.duration) || 0,
      size: Number(resolved.size) || 0,
      quality: Number(resolved.quality) || 0,
      bvid: resolved.bvid || '',
      cid: resolved.cid || ''
    };
  }

  function bilibiliDownloadName(item, media, kind) {
    const title = String((media && media.title) || (item && (item.title || (item.videoState && item.videoState.info && item.videoState.info.title))) || document.title || 'bilibili')
      .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'bilibili';
    const pageNo = (() => {
      try { return Math.max(1, Number(new URLSearchParams(location.search).get('p')) || 1); } catch (e) { return 1; }
    })();
    const part = media && media.part ? ' - ' + String(media.part).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) : '';
    return title + part + ' P' + pageNo + (kind === 'audio' ? '.m4a' : '.mp4');
  }

  async function downloadBilibiliVideo(item) {
    if (!item || item.closed) return;
    const media = item.biliMedia || await bilibiliProgressiveMedia();
    if (!media || !media.url) {
      setDownloadCapability(item, { video: false, audio: !!(item.downloadCaps && item.downloadCaps.audio), note: 'B 站未返回可下载的 MP4' });
      toast(item, 'B 站没有返回可下载的 MP4：请确认已登录、视频可正常播放');
      return;
    }
    item.biliMedia = media;
    await prepareAndSave(item, {
      url: media.url,
      kind: 'video',
      label: '视频',
      filename: bilibiliDownloadName(item, media, 'video')
    });
  }

  async function downloadBilibiliAudio(item) {
    if (!item || item.closed) return;
    const url = item.biliAudioUrl || await bilibiliAudioUrl();
    if (!url) {
      setDownloadCapability(item, { video: !!(item.downloadCaps && item.downloadCaps.video), audio: false });
      toast(item, '没有解析到 B 站音频流');
      return;
    }
    item.biliAudioUrl = url;
    await prepareAndSave(item, {
      url,
      kind: 'audio',
      label: '音频',
      filename: bilibiliDownloadName(item, biliVideoInfoFromPage(), 'audio')
    });
  }

  function probeVideoCandidate(candidate, timeoutMs) {
    if (!candidate) return Promise.resolve(false);
    const element = candidate.element;
    if (element && String(element.tagName || '').toUpperCase() === 'VIDEO'
      && String(element.currentSrc || element.src || '') === String(candidate.url || '')
      && Number(element.videoWidth) > 0) {
      return Promise.resolve(true);
    }
    if (!candidate.url || /^(hls|dash|stream)$/i.test(String(candidate.srcKind || ''))) return Promise.resolve(false);
    return new Promise(resolve => {
      const probe = document.createElement('video');
      let settled = false;
      probe.preload = 'metadata';
      probe.muted = true;
      probe.playsInline = true;
      probe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { probe.removeAttribute('src'); probe.load(); probe.remove(); } catch (e) { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), Math.max(1500, Number(timeoutMs) || 6000));
      probe.addEventListener('loadedmetadata', () => finish(Number(probe.videoWidth) > 0 && Number(probe.videoHeight) > 0), { once: true });
      probe.addEventListener('error', () => finish(false), { once: true });
      (document.body || document.documentElement).appendChild(probe);
      probe.src = candidate.url;
    });
  }
  async function captureVideoElement(candidate, item) {
    const video = candidate && candidate.element && candidate.element.isConnected
      ? candidate.element
      : findCaptureVideoElement();
    if (!video || typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') return null;
    let raw = null;
    let recorder = null;
    let stateCaptured = false;
    let wasPaused = false;
    let wasPlaying = false;
    let oldTime = 0;
    let oldRate = 1;
    let oldMuted = false;
    let oldVolume = 1;
    const restore = () => {
      if (!stateCaptured) return;
      stateCaptured = false;
      try { video.playbackRate = oldRate; } catch (e) { /* ignore */ }
      try { video.muted = oldMuted; } catch (e) { /* ignore */ }
      try { video.volume = oldVolume; } catch (e) { /* ignore */ }
      if (wasPaused) { try { video.pause(); video.currentTime = oldTime; } catch (e) { /* ignore */ } }
      else if (wasPlaying) { try { video.currentTime = oldTime; video.play(); } catch (e) { /* ignore */ } }
    };
    try {
      raw = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
      if (!raw || !raw.getVideoTracks || !raw.getVideoTracks().length) return null;
      if (typeof MediaRecorder === 'undefined') return null;
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find(type => !type || MediaRecorder.isTypeSupported(type));
      if (!mime) return null;
      const chunks = [];
      recorder = new MediaRecorder(raw, { mimeType: mime });
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; recorder.onerror = resolve; });
      recorder.start(1000);
      wasPaused = !!video.paused;
      wasPlaying = !wasPaused;
      oldTime = Number(video.currentTime) || 0;
      oldRate = Number(video.playbackRate) || 1;
      oldMuted = !!video.muted;
      oldVolume = Number(video.volume);
      stateCaptured = true;
      video.muted = false;
      video.volume = Math.max(0.2, Number(video.volume) || 1);
      video.currentTime = 0;
      video.playbackRate = 1.25;
      try { await video.play(); } catch (e) { /* autoplay may be allowed after click */ }
      const rawDuration = Number(video.duration);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : (Number(candidate.duration) || 0);
      const waitMs = duration ? Math.min(35 * 60 * 1000, Math.max(3000, duration * 1000 / 1.25 + 2000)) : 5 * 60 * 1000;
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('ended', finish); resolve(); };
        const timer = setTimeout(finish, waitMs);
        video.addEventListener('ended', finish, { once: true });
      });
      try { recorder.stop(); } catch (e) { /* ignore */ }
      await stopped;
      const blob = new Blob(chunks, { type: mime });
      return blob.size ? blob : null;
    } catch (e) {
      return null;
    } finally {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* ignore */ }
      try { if (raw) raw.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      restore();
    }
  }
  async function downloadMediaVideo(item) {
    const state = item && item.mediaState;
    if (!state) return;
    const candidates = (state.list || []).filter(candidate => candidate.kind === 'video')
      .sort((a, b) => {
        const direct = candidate => candidate.url && !/^blob:/i.test(candidate.url) ? 1 : 0;
        if (/douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
          return direct(b) - direct(a) || videoActivityScore(b.element) - videoActivityScore(a.element);
        }
        return direct(b) - direct(a);
      });
    if (state.candidate && state.candidate.kind === 'video' && !candidates.includes(state.candidate)) candidates.push(state.candidate);
    if (!candidates.length) { toast(item, '当前没有可下载的视频文件'); return; }
    for (const candidate of candidates.slice(0, 4)) {
      const mustCapture = !candidate.url || /^blob:/i.test(candidate.url) || /^(stream|dash)$/i.test(String(candidate.srcKind || ''));
      if (mustCapture) {
        // A normal Blob URL (not a MediaSource handle) can be read directly.
        // Try that first; it preserves the original MP4 and is much faster.
        if (candidate.url && /^blob:/i.test(candidate.url) && candidate.srcKind !== 'stream') {
          try {
            const response = await fetch(candidate.url);
            const file = await response.blob();
            if (file && file.size) {
              const ext = /mp4/i.test(file.type) ? '.mp4' : (/webm/i.test(file.type) ? '.webm' : '.mp4');
              downloadBlob(file, cleanBaseDownloadName(item) + ext);
              toast(item, '视频已开始下载');
              return;
            }
          } catch (e) { /* MediaSource handle; fall through to recorder */ }
        }
        if (!candidate.element && !findCaptureVideoElement()) continue;
        toast(item, '这是 MediaSource/Blob 流，正在录制实际视频画面…');
        const blob = await captureVideoElement(candidate, item);
        if (blob) {
          const isMp4 = /mp4/i.test(blob.type);
          downloadBlob(blob, cleanBaseDownloadName(item) + (isMp4 ? '.mp4' : '.webm'));
          toast(item, '视频已开始下载' + (isMp4 ? '' : '（WebM）'));
          return;
        }
        continue;
      }
      if (candidate.verifiedVideo || await probeVideoCandidate(candidate)) {
        requestMediaDownload(item, candidate, 'video');
        return;
      }
    }
    toast(item, '没有验证到包含画面的视频流；当前源是纯音频，已阻止下载伪装成 MP4 的文件');
  }

  function cleanDownloadName(item, candidate, kindOverride) {
    const raw = cleanBaseDownloadName(item);
    const kind = kindOverride || (candidate && candidate.kind === 'audio' ? 'audio' : 'video');
    let ext = kind === 'audio' ? 'm4a' : 'mp4';
    try {
      const path = new URL(String(candidate && candidate.url || ''), location.href).pathname;
      const match = path.match(/\.(webm|mov|mkv|m4a|mp3|aac|ogg|wav|mp4)$/i);
      if (match) ext = match[1].toLowerCase();
    } catch (e) { /* keep MIME default */ }
    return raw + '.' + ext;
  }
  function cleanBaseDownloadName(item) {
    return String((item && ((item.videoState && item.videoState.info && item.videoState.info.title) || item.title)) || document.title || 'media')
      .replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'media';
  }
  function srtTimestamp(value) {
    let seconds = Math.max(0, Number(value) || 0);
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const whole = Math.floor(seconds);
    const ms = Math.round((seconds - whole) * 1000);
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0')
      + ':' + String(whole).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
  }
  function normalizeSrtText(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/-->/g, '→')
      .replace(/\s+/g, ' ').trim();
  }
  function splitTranscriptSegments(text) {
    const segments = [];
    for (const rawLine of String(text || '').split(/\n+/)) {
      const line = normalizeSrtText(rawLine);
      if (!line) continue;
      if (line.length <= 110) { segments.push(line); continue; }
      const pieces = line.split(/(?<=[。！？!?；;])/).map(part => part.trim()).filter(Boolean);
      for (const piece of pieces) {
        if (piece.length <= 110) { segments.push(piece); continue; }
        for (let i = 0; i < piece.length; i += 96) segments.push(piece.slice(i, i + 96));
      }
    }
    return segments;
  }
  function buildSrtDocument(transcript, cues, duration) {
    const sourceCues = (Array.isArray(cues) ? cues : []).map((cue, index) => ({
      start: Math.max(0, Number(cue && cue.start) || 0),
      end: Math.max(0, Number(cue && cue.end) || 0),
      text: normalizeSrtText(cue && cue.text),
      index
    })).filter(cue => cue.text).sort((a, b) => a.start - b.start || a.index - b.index);
    let entries = sourceCues.map(cue => ({
      start: cue.start,
      end: cue.end > cue.start + 0.15 ? cue.end : cue.start + 0.8,
      text: cue.text
    }));
    if (!entries.length) {
      const segments = splitTranscriptSegments(transcript);
      if (!segments.length) return '';
      const total = Number(duration) > 0 ? Number(duration) : segments.length * 3.2;
      const weights = segments.map(segment => Math.max(8, segment.length));
      const weightTotal = weights.reduce((sum, value) => sum + value, 0);
      const gap = 0.12;
      const available = Math.max(segments.length * 0.8, total - gap * Math.max(0, segments.length - 1));
      let cursor = 0;
      entries = segments.map((segment, index) => {
        const span = Math.max(0.8, available * weights[index] / weightTotal);
        const start = cursor;
        cursor += span + gap;
        return { start, end: start + span, text: segment };
      });
    }
    return entries.map((entry, index) =>
      (index + 1) + '\n' + srtTimestamp(entry.start) + ' --> ' + srtTimestamp(entry.end)
      + '\n' + entry.text
    ).join('\n\n') + '\n';
  }
  function summarySubtitleState(item) {
    if (!item) return null;
    if (item.panelMode === 'video' && item.videoState) {
      return {
        state: item.videoState,
        text: String(item.videoState.transcript || ''),
        cues: item.videoState.transcriptCues || [],
        duration: Number(item.videoState.transcriptDuration) || 0
      };
    }
    if (item.mediaState) {
      return {
        state: item.mediaState,
        text: String(item.mediaState.transcript || ''),
        cues: item.mediaState.transcriptCues || [],
        duration: Number(item.mediaState.transcriptDuration) || 0
      };
    }
    return null;
  }
  function updateSummarySubtitleButton(item) {
    if (!item || !item.ui) return;
    const button = item.panelMode === 'video' ? item.ui.videoSubtitleDownload : item.ui.mediaSubtitleDownload;
    if (!button || !button.isConnected) return;
    const info = summarySubtitleState(item);
    const available = !!(info && info.text.trim() && !(info.state && info.state.textMode));
    button.hidden = !available;
    button.disabled = !available;
    button.title = available ? '下载当前转写/字幕的 SRT 文件' : '当前没有可下载的字幕';
  }

  /* ---------------------------------------------------------------------------
   * 下载可得性：只有真的能拿到文件时才显示按钮。
   * 能力探测是异步的（B 站要问接口、抖音要拿详情），所以按钮先隐藏，
   * 探测完成后再按结果放出来 —— 避免点下去才发现下载不了。
   * ------------------------------------------------------------------------- */
  function downloadButtons(item) {
    if (!item || !item.ui) return [];
    return [item.ui.videoDownloadBtn, item.ui.mediaDownload, item.mediaAudioButton || item.ui.mediaAudioDownload]
      .filter(button => button && button.isConnected);
  }

  function setDownloadCapability(item, caps) {
    if (!item) return;
    const next = Object.assign({ video: false, audio: false, pending: false, note: '' }, item.downloadCaps || {}, caps || {});
    item.downloadCaps = next;
    const apply = (button, available, label, hint) => {
      if (!button || !button.isConnected) return;
      button.hidden = !available;
      button.disabled = !available;
      if (available) {
        button.textContent = label;
        button.title = hint || label;
      }
    };
    const videoBtn = item.ui.videoDownloadBtn || item.ui.mediaDownload;
    const audioBtn = item.ui.videoAudioBtn || item.ui.mediaAudioDownload;
    apply(videoBtn, next.video, '下载视频', next.videoHint || '下载完整视频文件');
    apply(audioBtn, next.audio, '下载音频', next.audioHint || '下载独立音轨文件');
  }

  async function detectDownloadCapability(item) {
    if (!item || item.closed) return item && item.downloadCaps;
    const host = String(location.hostname || '');
    const caps = { video: false, audio: false, pending: true };
    try {
      if (/bilibili\.com/i.test(host)) {
        const [media, audio] = await Promise.all([
          typeof bilibiliProgressiveMedia === 'function' ? bilibiliProgressiveMedia().catch(() => null) : Promise.resolve(null),
          typeof bilibiliAudioUrl === 'function' ? bilibiliAudioUrl().catch(() => '') : Promise.resolve('')
        ]);
        if (media && media.url) {
          item.biliMedia = media;
          caps.video = true;
          caps.videoHint = media.size
            ? '下载完整 MP4 · 约 ' + Math.round(media.size / 1024 / 1024) + 'MB'
            : '下载完整 MP4';
        }
        if (audio) {
          item.biliAudioUrl = audio;
          caps.audio = true;
        }
        if (!caps.video && !caps.audio) caps.note = 'B 站未返回可下载的音视频流（可能需要登录）';
      } else if (/douyin\.com|iesdouyin\.com/i.test(host)) {
        const state = item.mediaState;
        if (state) {
          if (!Array.isArray(state.list)) state.list = [];
          await ensureDouyinDownloadCandidates(item);
          const video = (state.list || []).find(entry => entry && entry.kind === 'video' && entry.url && /^https?:\/\//i.test(entry.url));
          const audio = (state.list || []).find(entry => entry && entry.kind === 'audio' && entry.url && /^https?:\/\//i.test(entry.url));
          caps.video = !!video;
          caps.audio = !!audio;
          if (video) item.downloadVideoCandidate = video;
          if (audio) item.downloadAudioCandidate = audio;
        }
      } else {
        // Generic pages: a video is download-able when the page exposes a real
        // http(s) media URL, or when a same-page <video> source can be fetched
        // directly.  This must work for the video-summary panel too, where
        // mediaState may not exist yet.
        const state = item.mediaState;
        let list = Array.isArray(state && state.list) ? state.list.slice() : [];
        if (!list.length && typeof scanMediaCandidates === 'function') {
          try { list = scanMediaCandidates() || []; } catch (e) { list = []; }
        }
        const directOf = kind => list.find(entry => entry && entry.kind === kind && entry.url
          && /^https?:\/\//i.test(entry.url) && !/^blob:/i.test(entry.url) && !entry.downloadOnly) || null;
        const video = directOf('video');
        const audio = directOf('audio');
        caps.video = !!video;
        caps.audio = !!audio;
        if (video) item.downloadVideoCandidate = video;
        if (audio) item.downloadAudioCandidate = audio;
        if (!caps.video) {
          // The player may expose a blob: URL whose backing file is still
          // fetchable.  Ask the browser: a same-origin media URL that resolves
          // with a video content-type is genuinely downloadable.
          const anchor = item.anchorVideo && item.anchorVideo.isConnected ? item.anchorVideo : null;
          const sourceUrl = String((video && video.url) || (anchor && (anchor.currentSrc || anchor.src)) || '');
          if (/^(https?|blob):/i.test(sourceUrl)) {
            try {
              const head = await fetch(sourceUrl, { method: 'HEAD', credentials: 'include' });
              const type = String(head.headers.get('content-type') || '');
              const size = Number(head.headers.get('content-length') || 0);
              if (head.ok && /^video\//i.test(type) && size > 1024) {
                caps.video = true;
                caps.videoHint = '下载完整视频 · ' + Math.round(size / 1024 / 1024) + 'MB';
                if (!item.downloadVideoCandidate) {
                  item.downloadVideoCandidate = { url: sourceUrl, kind: 'video', srcKind: 'direct', duration: 0 };
                }
              }
            } catch (e) { /* blob: cannot be HEAD-ed; stays unavailable */ }
          }
        }
        if (!caps.video && !caps.audio) {
          // Nothing usable in the DOM (blob players are the norm on streaming
          // sites).  Fall back to the network sniffer: any media response the
          // page itself loaded is downloadable with the page's own cookies.
          try {
            const sniffed = await EXT.runtime.sendMessage({ type: 'ldp:getCapturedMedia' });
            const entries = (sniffed && Array.isArray(sniffed.urls) ? sniffed.urls : [])
              .slice()
              .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
            const pick = kind => entries.find(entry => entry && entry.kind === kind && /^https?:\/\//i.test(String(entry.url || ''))) || null;
            const hls = pick('hls');
            const video = pick('video');
            const audio = pick('audio');
            if (video) {
              caps.video = true;
              item.downloadVideoCandidate = { url: video.url, kind: 'video', srcKind: 'sniffed', duration: 0 };
              if (video.contentType) caps.videoHint = '下载视频 · ' + video.contentType;
            } else if (hls) {
              caps.video = true;
              caps.hls = true;
              item.downloadVideoCandidate = { url: hls.url, kind: 'video', srcKind: 'hls', duration: 0 };
              caps.videoHint = '下载视频 · HLS 流（分片合并）';
            }
            if (audio) {
              caps.audio = true;
              item.downloadAudioCandidate = { url: audio.url, kind: 'audio', srcKind: 'sniffed', duration: 0 };
            }
          } catch (e) { /* no sniffer data */ }
        }
        if (!caps.video && !caps.audio) caps.note = '当前视频没有可直接下载的文件';
      }
    } catch (e) {
      caps.note = String(e && e.message || e || '');
    }
    caps.pending = false;
    setDownloadCapability(item, caps);
    return caps;
  }

  function updateDownloadProgress(item, percent, text, tone) {
    if (!item || !item.ui) return;
    const box = item.ui.downloadProgress;
    const bar = item.ui.downloadProgressBar;
    const label = item.ui.downloadProgressText;
    if (!box) return;
    const done = Number(percent) >= 100;
    box.hidden = false;
    box.dataset.tone = tone || (done ? 'good' : '');
    if (bar) bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
    if (label) label.textContent = text || (done ? '已准备完成' : '正在准备下载…');
  }

  function hideDownloadProgress(item) {
    const box = item && item.ui && item.ui.downloadProgress;
    if (box) box.hidden = true;
  }

  function buildDownloadProgress() {
    const box = el('div', 'download-progress');
    const track = el('div', 'download-progress-track');
    const bar = el('i', 'download-progress-bar');
    track.appendChild(bar);
    const text = el('span', 'download-progress-text', '');
    box.appendChild(track);
    box.appendChild(text);
    box.hidden = true;
    return { box, bar, text };
  }

  /** 流式下载，按已接收字节回报进度（拿不到 content-length 时按"已下载"显示）。 */
  /**
   * Download an HLS (m3u8) stream: resolve the playlist into segments, fetch
   * them in order with real progress, then concatenate.  MPEG-TS segments
   * concatenate losslessly, so the result is a playable .ts file — that is how
   * most live/VOD streams can be saved without a server-side muxer.
   */
  async function downloadHlsStream(item, playlistUrl, options) {
    const opts = options || {};
    const label = opts.label || '视频';
    const filename = opts.filename || 'hls-stream.ts';
    updateDownloadProgress(item, 2, '正在解析' + label + '播放列表…');
    let playlist = null;
    try {
      playlist = await EXT.runtime.sendMessage({ type: 'ldp:hlsPlaylist', url: playlistUrl });
    } catch (e) {
      throw new Error('无法读取播放列表：' + String(e && e.message || e || ''));
    }
    if (!playlist || !playlist.ok) {
      throw new Error((playlist && playlist.detail) || '播放列表解析失败');
    }
    if (playlist.encrypted) {
      throw new Error('该 HLS 流使用 ' + (playlist.keyMethod || 'AES') + ' 加密，浏览器内无法解密');
    }
    const segments = playlist.segments || [];
    if (!segments.length) throw new Error('播放列表里没有分片');
    const parts = [];
    let received = 0;
    for (let i = 0; i < segments.length; i += 1) {
      if (item.closed) throw new Error('已关闭');
      const index = i + 1;
      const basePercent = (i / segments.length) * 100;
      updateDownloadProgress(item, Math.min(99, basePercent), '正在下载' + label + '分片 ' + index + '/' + segments.length);
      let chunk = null;
      try {
        // Direct fetch keeps the page's cookies; most segment CDNs allow CORS.
        const response = await fetch(segments[i], { credentials: 'include' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        chunk = await response.arrayBuffer();
      } catch (e) {
        // Fall back to the service worker, which bypasses CORS.
        const viaBg = await EXT.runtime.sendMessage({ type: 'ldp:hlsSegment', url: segments[i] });
        if (!viaBg || !viaBg.ok || !viaBg.base64) {
          throw new Error('分片 ' + index + ' 下载失败：' + String((viaBg && viaBg.detail) || e && e.message || e || ''));
        }
        const binary = atob(viaBg.base64);
        const bytes = new Uint8Array(binary.length);
        for (let k = 0; k < binary.length; k += 1) bytes[k] = binary.charCodeAt(k);
        chunk = bytes.buffer;
      }
      parts.push(chunk);
      received += chunk.byteLength;
      const sizeText = Math.round(received / 1024 / 1024 * 10) / 10 + 'MB';
      updateDownloadProgress(item, Math.min(99, ((i + 1) / segments.length) * 100),
        '已下载' + label + ' ' + sizeText + ' · 分片 ' + index + '/' + segments.length);
    }
    updateDownloadProgress(item, 99, '正在合并' + label + '…');
    const blob = new Blob(parts, { type: 'video/mp2t' });
    updateDownloadProgress(item, 100, '已准备完成，开始保存');
    return { blob, filename, size: blob.size };
  }

  async function fetchBlobWithProgress(url, onProgress, options) {
    const init = Object.assign({ credentials: 'include' }, options || {});
    const response = await fetch(url, init);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const total = Number(response.headers.get('content-length') || 0);
    const type = response.headers.get('content-type') || 'application/octet-stream';
    if (!response.body || typeof response.body.getReader !== 'function' || !total) {
      const blob = await response.blob();
      if (onProgress) onProgress(blob.size || 1, blob.size || 1, true);
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (onProgress) onProgress(received, total);
    }
    if (onProgress) onProgress(total, total, true);
    return new Blob(chunks, { type });
  }

  /**
   * 先把整份文件在后台下载完，再触发"保存"。
   * 这样用户点下载后看到的是真实进度，而不是浏览器下载条突然出现又失败。
   */
  async function prepareAndSave(item, options) {
    const opts = options || {};
    const label = opts.label || '媒体';
    updateDownloadProgress(item, 1, '正在准备' + label + '…');
    let blob = null;
    try {
      blob = await fetchBlobWithProgress(opts.url, (received, total, finished) => {
        if (finished) return;
        const percent = total ? Math.min(99, (received / total) * 100) : 30;
        const size = total ? Math.round(total / 1024 / 1024) + 'MB' : '';
        updateDownloadProgress(item, percent, '正在下载' + label + (size ? ' · ' + size : '') + ' · ' + Math.round(percent) + '%');
      }, opts.init);
    } catch (e) {
      // 页面侧被 CORS/防盗链挡住时交给后台下载（后台带 Referer，但会走浏览器下载条）。
      const detail = String(e && e.message || e);
      updateDownloadProgress(item, 0, '页面侧受限（' + detail + '），改用后台下载…');
      requestMediaDownload(item, { url: opts.url, kind: opts.kind }, opts.kind, opts.filename);
      setTimeout(() => hideDownloadProgress(item), 2000);
      return false;
    }
    if (!blob || !blob.size) {
      updateDownloadProgress(item, 0, '下载到的文件为空', 'bad');
      return false;
    }
    updateDownloadProgress(item, 100, '下载完成，正在保存 ' + Math.round(blob.size / 1024 / 1024) + 'MB…');
    const ok = downloadBlob(blob, opts.filename);
    setTimeout(() => hideDownloadProgress(item), ok ? 2500 : 0);
    if (!ok) updateDownloadProgress(item, 0, '保存失败，请重试', 'bad');
    return ok;
  }
  /* ---------------------------------------------------------------------------
   * 总结目录（TOC）
   * 用户诉求：总结按「第一部分 / 第二部分」分段时，
   *   1) 滚动时当前章节标题吸顶；
   *   2) 右侧有个目录按钮，默认只有按钮，点开才展开目录；
   *   3) 点目录项直接跳到对应段落。
   * 实现：渲染后给每个标题加唯一 id，用 IntersectionObserver 之外的
   * 轻量滚动计算决定「当前章节」，并把当前章节标题用 position:sticky 钉住。
   * ------------------------------------------------------------------------- */
  const TOC_MIN_HEADINGS = 2;

  function collectSummaryHeadings(root) {
    if (!root) return [];
    const nodes = Array.from(root.querySelectorAll('h1,h2,h3,h4'));
    return nodes.filter(node => String(node.textContent || '').trim().length > 0);
  }

  /**
   * Scroll a summary heading into view inside its own scroll container.
   * `scrollIntoView` respects nested scrollers and is far more reliable than
   * adding offsetTop (which is relative to the positioned answer card, not the
   * scroller) — that mismatch is why TOC clicks appeared to do nothing.
   */
  function jumpToHeading(scroller, heading) {
    if (!scroller || !heading || !scroller.isConnected || !heading.isConnected) return false;
    const applyActive = () => {
      try {
        const headings = Array.from(scroller.querySelectorAll('h1,h2,h3,h4'));
        const index = headings.indexOf(heading);
        if (index < 0) return;
        headings.forEach((h, i) => {
          const active = i === index;
          h.classList.toggle('toc-sticky', active);
          h.classList.toggle('toc-passed', i < index);
          if (active) h.dataset.tocBadge = '当前'; else delete h.dataset.tocBadge;
        });
      } catch (e) { /* ignore */ }
    };
    // Compute the destination in the scroller's own coordinate space.  Smooth
    // scrollTo is used first because it is what users expect; a hard jump
    // follows if the smooth animation was suppressed (reduced-motion, hidden
    // tab, or an ancestor clipping the scroll).
    let target = null;
    try {
      const scRect = scroller.getBoundingClientRect();
      const hRect = heading.getBoundingClientRect();
      target = Math.max(0, scroller.scrollTop + (hRect.top - scRect.top) - 4);
    } catch (e) { target = null; }
    if (target === null) return false;
    try { scroller.scrollTo({ top: target, behavior: 'smooth' }); }
    catch (e) { try { scroller.scrollTop = target; } catch (e2) { /* ignore */ } }
    applyActive();
    // Verify and, if needed, force the position synchronously.  Without this a
    // clip/overflow ancestor can swallow the animated scroll entirely and the
    // click appears to do nothing.
    let tries = 0;
    const settle = () => {
      tries += 1;
      if (!scroller.isConnected || !heading.isConnected) return;
      const moved = Math.abs(scroller.scrollTop - target) <= 8;
      if (!moved && tries <= 6) { requestAnimationFrame(settle); return; }
      if (!moved) {
        try { scroller.scrollTop = target; } catch (e) { /* ignore */ }
      }
      applyActive();
    };
    requestAnimationFrame(settle);
    return true;
  }

  function bindSummaryToc(item, root) {
    if (!item || !root) return;
    const headings = collectSummaryHeadings(root);
    const panel = item.ui && item.ui.panel;
    const existing = panel && panel.querySelector('.summary-toc');
    if (headings.length < TOC_MIN_HEADINGS) {
      if (existing) existing.remove();
      if (item._tocScroll) {
        try { (item._tocScrollTarget || root).removeEventListener('scroll', item._tocScroll); } catch (e) { /* ignore */ }
        item._tocScroll = null;
        item._tocScrollTarget = null;
      }
      return;
    }
    const idPrefix = 'ldp-toc-' + (item.id || Math.random().toString(36).slice(2));
    headings.forEach((node, index) => {
      if (!node.id || headings.some((other, i) => i !== index && other.id === node.id)) node.id = idPrefix + '-' + index;
      node.dataset.tocIndex = String(index);
    });

    const shellEl = panel || root;
    let nav = shellEl.querySelector('.summary-toc');
    if (!nav) {
      const wrap = document.createElement('div');
      wrap.className = 'summary-toc';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'summary-toc-toggle';
      toggle.title = '目录';
      toggle.setAttribute('aria-label', '目录');
      toggle.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2 3.5h12a.75.75 0 0 1 0 1.5H2a.75.75 0 0 1 0-1.5Zm0 4h12a.75.75 0 0 1 0 1.5H2a.75.75 0 0 1 0-1.5Zm0 4h8a.75.75 0 0 1 0 1.5H2a.75.75 0 0 1 0-1.5Z"/></svg>';
      const list = document.createElement('div');
      list.className = 'summary-toc-list';
      list.hidden = true;
      wrap.appendChild(toggle);
      wrap.appendChild(list);
      shellEl.appendChild(wrap);
      nav = wrap;
      toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const open = list.hidden;
        list.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        wrap.classList.toggle('open', open);
      });
      // 点外面收起，避免挡住总结正文。
      // ⚠ 不能只挂在 document 上：总结 UI 在 closed shadow root 里，
      // document 层拿到的是被重定向过的 composedPath（只剩 host），
      // 于是「点目录项自己」会被误判成「点外面」——列表在 pointerdown
      // 瞬间就被隐藏，元素随之消失，mouseup/click 都收不到，
      // 表现就是「点目录没有任何反应」。
      // 正确做法：在 shadow root 内部再挂一个监听，用真实的内部路径判断。
      const closeIfOutside = event => {
        if (!wrap.isConnected || list.hidden) return;
        const path = event.composedPath ? event.composedPath() : [];
        if (path.includes(wrap)) return;
        list.hidden = true;
        wrap.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      };
      const rootNode = (() => { try { return wrap.getRootNode(); } catch (e) { return document; } })();
      if (rootNode && rootNode !== document && rootNode.addEventListener) {
        // Inside the same shadow tree events are not retargeted, so this sees
        // the real target and can tell "inside the outline" from "outside".
        rootNode.addEventListener('pointerdown', closeIfOutside, true);
      }
      document.addEventListener('pointerdown', event => {
        // Events originating inside our closed shadow root are retargeted to the
        // host; treat those as "inside" so the root-level listener decides.
        const target = event.target;
        const host = rootNode && rootNode.host ? rootNode.host : null;
        if (host && (target === host || (host.contains && host.contains(target)))) return;
        closeIfOutside(event);
      }, true);
    }
    const list = nav.querySelector('.summary-toc-list');
    list.innerHTML = '';
    headings.forEach((node, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'summary-toc-item';
      button.dataset.target = node.id;
      const level = Math.min(4, Math.max(1, Number(node.tagName.slice(1)) || 1));
      button.dataset.level = String(level);
      button.textContent = String(node.textContent || '').trim();
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        list.hidden = true;
        nav.classList.remove('open');
        jumpToHeading(root, node);
      });
      list.appendChild(button);
    });

    // 当前章节高亮 + 吸顶标题
    if (item._tocScroll) {
      try { (item._tocScrollTarget || root).removeEventListener('scroll', item._tocScroll); } catch (e) { /* ignore */ }
      item._tocScrollTarget = null;
    }
    let raf = 0;
    const sync = () => {
      raf = 0;
      if (!root.isConnected) return;
      const items = Array.from(list.querySelectorAll('.summary-toc-item'));
      // Compare positions in the scroller's coordinate space; offsetTop refers
      // to the positioned answer card, which is not the scroll container.
      const scrollerRect = root.getBoundingClientRect();
      let active = 0;
      headings.forEach((node, index) => {
        const nodeRect = node.getBoundingClientRect();
        if (nodeRect.top - scrollerRect.top <= 56) active = index;
      });
      items.forEach((button, index) => button.classList.toggle('active', index === active));
      headings.forEach((node, index) => {
        const isActive = index === active;
        node.classList.toggle('toc-sticky', isActive);
        node.classList.toggle('toc-passed', index < active);
        if (isActive) node.dataset.tocBadge = '当前'; else delete node.dataset.tocBadge;
      });
    };
    item._tocScroll = () => { if (!raf) raf = requestAnimationFrame(sync); };
    item._tocScrollTarget = root;
    root.addEventListener('scroll', item._tocScroll, { passive: true });
    sync();
  }

  function refreshSummaryToc(item) {
    if (!item || !item.ui) return;
    const answers = [item.ui.videoOut, item.ui.mediaOut, item.ui.textAIOut, item.ui.aiOut].filter(Boolean);
    const root = item.ui.panel && item.ui.panel.querySelector('.summary-scroll');
    const target = answers.find(node => node.isConnected && collectSummaryHeadings(node).length >= TOC_MIN_HEADINGS);
    if (!target || !root) { bindSummaryToc(item, root || (answers[0] && answers[0].parentElement)); return; }
    bindSummaryToc(item, root);
  }

  function downloadSummarySubtitles(item) {
    const info = summarySubtitleState(item);
    if (!info || !info.text.trim()) { toast(item, '当前没有可下载的字幕'); return false; }
    const srt = buildSrtDocument(info.text, info.cues, info.duration);
    if (!srt) { toast(item, '字幕内容为空，无法生成 SRT'); return false; }
    const blob = new Blob(['\ufeff' + srt], { type: 'application/x-subrip;charset=utf-8' });
    const ok = downloadBlob(blob, cleanBaseDownloadName(item) + '.srt');
    toast(item, ok ? '字幕 SRT 已开始下载' : '字幕下载失败');
    return ok;
  }

  /* ---------------------------------------------------------------------------
   * 总结追问（Follow-up）
   * 总结完成后，正文下方常驻一个对话框：对总结里没讲清的地方可以立刻追问。
   * 上下文链：已有总结 + 原始字幕/正文节选 + 最近几轮问答。
   * ------------------------------------------------------------------------- */
  const FOLLOWUP_HISTORY_LIMIT = 12;

  function summaryContextFor(item) {
    if (!item) return { summary: '', source: '', media: false, title: document.title || '' };
    if (item.mediaState) {
      const state = item.mediaState;
      return {
        summary: String(state.answer || state.transcript || '').slice(0, 12000),
        source: String(state.transcript || '').slice(0, 9000),
        media: true,
        title: String(state.boundTitle || item.title || document.title || '')
      };
    }
    if (item.videoState) {
      const state = item.videoState;
      return {
        summary: String(state.answer || state.transcript || '').slice(0, 12000),
        source: String(state.transcript || '').slice(0, 9000),
        media: true,
        title: String(item.title || document.title || '')
      };
    }
    return {
      summary: String(item.aiAnswer || '').slice(0, 12000),
      source: String(item.pageText || '').slice(0, 9000),
      media: false,
      title: String(item.title || document.title || '')
    };
  }

  function followupBusyUI(item, busy) {
    const ui = item && item.ui;
    if (!ui || !ui.followupSend) return;
    ui.followupSend.disabled = !!busy;
    ui.followupSend.textContent = busy ? '回答中…' : '追问';
    // Never disable the field itself: voice input / IME composition can be in
    // progress, and a disabled element silently drops every character.
  }

  function appendFollowupTurn(item, role, text) {
    const list = item.ui && item.ui.followupList;
    if (!list) return null;
    const row = el('div', 'followup-turn followup-' + (role === 'user' ? 'ask' : 'answer'));
    const label = el('span', 'followup-role', role === 'user' ? '你' : 'AI');
    const body = el('div', 'followup-text' + (role === 'assistant' ? ' markdown' : ''));
    body.textContent = String(text || '');
    body.style.fontSize = summaryFontSizeValue(item) + 'px';
    row.appendChild(label);
    row.appendChild(body);
    list.appendChild(row);
    list.hidden = false;
    const scroller = item.ui.panel && item.ui.panel.querySelector('.summary-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return body;
  }

  async function askFollowup(item, question) {
    const ask = String(question || '').trim();
    if (!item || item.closed || !ask) return;
    if (item.followupBusy) { toast(item, '正在回答上一个问题，请稍等'); return; }
    const ctx = summaryContextFor(item);
    if (!ctx.summary && !ctx.source) { toast(item, '还没有总结内容，先完成一次总结再追问'); return; }
    const history = Array.isArray(item.followupHistory) ? item.followupHistory : (item.followupHistory = []);
    item.followupBusy = true;
    followupBusyUI(item, true);
    appendFollowupTurn(item, 'user', ask);
    history.push({ role: 'user', text: ask.slice(0, 2000) });
    const answerNode = appendFollowupTurn(item, 'assistant', '正在思考…');
    const request = {
      action: 'followup',
      text: (ctx.source || ctx.summary).slice(0, 20000),
      summary: ctx.summary,
      question: ask.slice(0, 4000),
      history: history.slice(-6),
      media: !!ctx.media,
      title: ctx.title,
      url: location.href,
      provider: item.aiVendor || aiConfig.provider,
      endpoint: aiProviderConfig(item.aiVendor || aiConfig.provider).endpoint,
      model: (aiConfig.selectedModels && aiConfig.selectedModels[item.aiVendor || aiConfig.provider]) || aiConfig.model
    };
    const finish = text => {
      item.followupBusy = false;
      followupBusyUI(item, false);
      if (answerNode && answerNode.isConnected) {
        answerNode.classList.add('markdown');
        answerNode.innerHTML = markdownToHtml(String(text || '（没有返回内容）'));
        if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item);
      }
      history.push({ role: 'assistant', text: String(text || '').slice(0, 2000) });
      if (history.length > FOLLOWUP_HISTORY_LIMIT) history.splice(0, history.length - FOLLOWUP_HISTORY_LIMIT);
      const scroller = item.ui && item.ui.panel && item.ui.panel.querySelector('.summary-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    };
    const fail = detail => {
      item.followupBusy = false;
      followupBusyUI(item, false);
      if (answerNode && answerNode.isConnected) {
        answerNode.classList.remove('markdown');
        answerNode.textContent = '追问失败：' + String(detail || '接口没有返回内容');
        answerNode.dataset.tone = 'bad';
      }
    };
    if (!EXT || !EXT.runtime || !EXT.runtime.sendMessage) { fail('扩展后台不可用'); return; }
    const timer = setTimeout(() => fail('追问超过 120 秒没有返回'), 120000);
    try {
      EXT.runtime.sendMessage({ namespace: 'LPS_EXT', type: 'ldp:ai', request }, response => {
        clearTimeout(timer);
        let lastError = null;
        try { lastError = EXT.runtime.lastError; } catch (e) { /* ignore */ }
        if (lastError) { fail(String(lastError.message || lastError)); return; }
        if (!response || !response.ok) { fail((response && (response.detail || response.reason)) || '接口错误'); return; }
        finish(response.text || '');
      });
    } catch (e) {
      clearTimeout(timer);
      fail(e && e.message ? e.message : '请求发送失败');
    }
  }

  function buildFollowupBox(item) {
    // Reuse the existing composer instead of rebuilding it.  IME sessions, voice
    // input targets, selection and focus are bound to the element: recreating it
    // on a panel re-render silently dropped whatever the input method was doing,
    // which is why only plain keyboard typing appeared to work.
    if (item.ui && item.ui.followupBox) {
      // The caller re-appends it; keep the very same node (and its IME state).
      return item.ui.followupBox;
    }
    // A previous render's composer may still be attached.  Remove it so ids stay
    // unique and clicks cannot land on a detached twin.
    try {
      const panel = item.ui && item.ui.panel;
      if (panel) panel.querySelectorAll('.followup-box').forEach(node => node.remove());
    } catch (e) { /* ignore */ }
    const wrap = el('div', 'followup-box');
    const head = el('div', 'followup-head');
    const title = el('span', 'followup-title', '继续追问');
    const hint = el('span', 'followup-hint', '对总结里不清楚的地方直接提问');
    head.appendChild(title);
    head.appendChild(hint);
    const list = el('div', 'followup-list');
    list.hidden = true;
    const row = el('div', 'followup-input-row');
    const input = document.createElement('textarea');
    input.className = 'followup-input';
    input.rows = 1;
    input.placeholder = '例如：第二部分说的“容错系统”具体怎么做？';
    input.spellcheck = false;
    const send = el('button', 'text-button followup-send', '追问');
    send.type = 'button';
    const submit = () => {
      const value = String(input.value || '').trim();
      if (!value) { input.focus(); return; }
      input.value = '';
      input.style.height = '';
      item.followupDraft = '';
      askFollowup(item, value);
    };
    send.addEventListener('click', submit);
    // Keep a draft on the item.  Voice input and IME composition can commit
    // hundreds of ms after the field was focused; if the panel re-renders in
    // between, the new textarea is empty and the text looked "lost".
    input.value = String(item.followupDraft || '');
    const saveDraft = () => {
      item.followupDraft = input.value;
      item.followupFocusWanted = true;
      input.style.height = 'auto';
      input.style.height = Math.min(108, Math.max(30, input.scrollHeight)) + 'px';
    };
    input.addEventListener('focus', () => { item.followupFocusWanted = true; });
    input.addEventListener('blur', () => {
      // A re-render removes the node without a real blur; only a genuine
      // blur (focus moved elsewhere) should clear the intent.
      setTimeout(() => {
        if (!input.isConnected) return;   // rebuilt, keep the intent
        if (document.activeElement !== input) item.followupFocusWanted = false;
      }, 0);
    });
    input.addEventListener('input', saveDraft);
    input.addEventListener('compositionend', saveDraft);
    // `beforeinput` fires first for IME/voice insertion; sync afterwards in case
    // the platform only delivers that event.
    input.addEventListener('beforeinput', () => { setTimeout(saveDraft, 0); });
    input.addEventListener('paste', () => { setTimeout(saveDraft, 0); });
    input.addEventListener('drop', () => { setTimeout(saveDraft, 0); });
    input.addEventListener('change', saveDraft);
    if (input.value) saveDraft();
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    // Make the composer behave like a plain <textarea>: nothing outside it may
    // observe, cancel or re-route its input events.  Global shortcut, gesture
    // and "click outside" handlers used to interfere with IME / voice input and
    // paste.  stopPropagation never calls preventDefault, so the browser's own
    // editing behaviour (typing, composition, paste, drop) stays intact.
    ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'copy',
      'compositionstart', 'compositionupdate', 'compositionend', 'textInput',
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick',
      'contextmenu', 'dragstart', 'dragover', 'dragenter', 'drop', 'selectstart'
    ].forEach(type => {
      wrap.addEventListener(type, event => { event.stopPropagation(); }, true);
    });
    row.appendChild(input);
    row.appendChild(send);
    wrap.appendChild(head);
    wrap.appendChild(list);
    wrap.appendChild(row);
    input.dataset.followupAlive = '1';
    item.ui.followupBox = wrap;
    item.ui.followupList = list;
    item.ui.followupInput = input;
    item.ui.followupSend = send;
    // Match the current summary size immediately instead of waiting for the
    // next A± click.
    try { applySummaryTextStyle(item); } catch (e) { /* ignore */ }
    // If the user was typing (very likely with voice input, which commits text
    // into a focused field), carry the focus and caret over to the rebuilt
    // textarea.  Losing focus mid-dictation made voice input look dead.
    if (item.followupFocusWanted) {
      setTimeout(() => {
        try {
          if (item.closed || !input.isConnected) return;
          const active = document.activeElement;
          const hostActive = active === wrap.closest('[data-ldp-host]') || active === (item.ui && item.ui.win);
          if (hostActive || !active || item.followupFocusWanted) {
            input.focus({ preventScroll: true });
            const end = input.value.length;
            try { input.setSelectionRange(end, end); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      }, 0);
    }
    return wrap;
  }

  /** 追问区只应在有总结内容之后出现；提前建好会让空面板显得很吵。 */
  function syncFollowupVisibility(item) {
    const box = item && item.ui && item.ui.followupBox;
    if (!box) return;
    const ctx = summaryContextFor(item);
    const ready = !!(String(ctx.summary || '').trim() || String(ctx.source || '').trim());
    box.hidden = !ready;
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
        item.ui.win.querySelectorAll(SUMMARY_TEXT_SELECTOR).forEach(node => { node.style.fontSize = summaryFontSizeValue(item) + 'px'; });
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

  function mediaSourceNote(state) {
    const value = state || {};
    const sourceText = value.candidate
      ? (value.candidate.kind === 'audio' ? '音频链路' : '视频链路') + ' · ' + (value.candidate.srcKind || '直链') + (value.candidate.duration ? ' · ' + Math.round(value.candidate.duration) + ' 秒' : '')
      : '正在扫描页面媒体…';
    const noteHtml = value.textMode
      ? '当前页面没有可提取的音视频，已降级为网页正文总结。'
      : '优先提取音频；没有独立音轨时使用视频链路。媒体只发送到你配置的硅基流动接口。';
    const subtitleNote = value.subtitleError ? '\n字幕不可用：' + value.subtitleError : '';
    return noteHtml + subtitleNote + (value.candidate ? '\n来源：' + sourceText : '');
  }

  function renderMediaSummaryPanel(item) {
    item.panelMode = 'media';
    const body = panelFrame(item, '音视频内容总结', 'close');
    configureSummaryWindow(item);
    item.ui.panel.classList.add('media-panel');
    const state = item.mediaState || {};
    const source = el('p', 'note', mediaSourceNote(state));
    item.ui.mediaSource = source;
    const status = el('div', 'media-summary-status', state.error ? '未能提取媒体' : (state.busy ? '正在处理…' : '准备中…'));
    const progress = el('div', 'media-progress');
    const progressBar = el('span', 'media-progress-bar');
    const progressPercent = el('span', 'media-progress-percent', '0%');
    progress.appendChild(progressBar);
    progress.appendChild(progressPercent);
    progress.style.position = 'relative';
    progressPercent.style.cssText = 'position:absolute;right:0;top:-17px;color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums';
    const out = el('div', 'media-summary-answer markdown summary-answer-card');
    const meta = el('div', 'media-summary-meta', '');
    const actions = el('div', 'ai-actions summary-actions');
    const copy = el('button', 'text-button', '复制总结');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = String((item.mediaState && item.mediaState.answer) || '').trim();
      if (!text) { toast(item, '还没有可复制的总结'); return; }
      copySummaryText(item, text, '已复制总结');
    });
    const videoDownload = el('button', 'text-button summary-action-secondary', '下载视频');
    videoDownload.type = 'button';
    videoDownload.hidden = true;
    videoDownload.disabled = true;
    videoDownload.addEventListener('click', () => downloadVideoFromSummary(item));
    const audioDownload = el('button', 'text-button summary-action-secondary', '下载音频');
    audioDownload.type = 'button';
    audioDownload.hidden = true;
    audioDownload.disabled = true;
    audioDownload.addEventListener('click', () => downloadAudioFromSummary(item));
    const downloadProgress = buildDownloadProgress();
    const subtitleDownload = el('button', 'text-button summary-subtitle-button summary-action-primary', '下载字幕 SRT');
    subtitleDownload.type = 'button';
    subtitleDownload.hidden = true;
    subtitleDownload.addEventListener('click', () => downloadSummarySubtitles(item));
    const retry = el('button', 'text-button', '重新总结');
    retry.type = 'button';
    retry.addEventListener('click', () => startMediaSummary(item));
    const cancel = el('button', 'text-button', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      if (item.mediaState) {
        item.mediaState.cancelled = true;
        item.mediaState.busy = false;
      }
      stopAIPort(item);
      hideSummaryLoading(item);
      if (item.ui && item.ui.win) item.ui.win.style.display = '';
      if (status) status.textContent = '已取消';
      if (out) { out.classList.remove('streaming'); out.textContent = '已取消本次总结。'; out.dataset.tone = ''; }
      publishSidePanel(item, '已取消', '');
      toast(item, '已取消');
    });
    actions.appendChild(videoDownload);
    actions.appendChild(audioDownload);
    actions.appendChild(subtitleDownload);
    actions.appendChild(copy);
    actions.appendChild(retry);
    actions.appendChild(cancel);
    if (typeof addSummaryAppearance === 'function') addSummaryAppearance(item, actions);
    const scroll = el('div', 'summary-scroll');
    scroll.appendChild(source);
    scroll.appendChild(status);
    scroll.appendChild(progress);
    if (typeof addSummarySteps === 'function') {
      const stepLabels = state.candidate && state.candidate.kind === 'audio'
        ? ['扫描字幕', '选择音频', '语音转写', 'AI 总结']
        : ['扫描字幕', '选择视频', '视频转音频', '语音转写', 'AI 总结'];
      addSummarySteps(item, scroll, 'media', stepLabels);
    }
    scroll.appendChild(out);
    scroll.appendChild(meta);
    scroll.appendChild(downloadProgress.box);
    body.appendChild(scroll);
    body.appendChild(buildFollowupBox(item));
    body.appendChild(actions);
    item.ui.mediaStatus = status;
    item.ui.mediaProgress = progressBar;
    item.ui.mediaPercent = progressPercent;
    item.ui.mediaOut = out;
    item.ui.mediaMeta = meta;
    item.ui.mediaDownload = videoDownload;
    item.ui.mediaAudioDownload = audioDownload;
    item.ui.mediaSubtitleDownload = subtitleDownload;
    item.ui.downloadProgress = downloadProgress.box;
    item.ui.downloadProgressBar = downloadProgress.bar;
    item.ui.downloadProgressText = downloadProgress.text;
    if (typeof applySummaryTextStyle === 'function') applySummaryTextStyle(item, out);
    publishSidePanel(item, state.error ? '未能提取媒体' : (state.busy ? '正在处理…' : '准备中…'), state.error ? 'bad' : '');
    if (state.answer) { out.innerHTML = markdownToHtml(state.answer); if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item); }
    else if (state.error) { out.textContent = state.error; out.dataset.tone = 'bad'; }
    else out.textContent = state.textMode ? '正在读取网页正文…' : '正在读取媒体…';
    updateSummarySubtitleButton(item);
    setTimeout(() => {
      detectDownloadCapability(item).catch(() => { /* ignore */ });
      if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
    }, 80);
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
      transcript: '',
      transcriptCues: [],
      transcriptDuration: 0,
      error: '',
      textMode: !candidates.length,
      list: candidates,
      anchorVideo: opts.video || findActiveVideoElement(),
      candidate: candidates[0] || null,
      prompt: ''
    };
    openPanel(item, 'media');
    hideSummaryWindow(item);
    showSummaryLoading(item, '正在扫描页面媒体…');
    ensureGenericMediaHook();
    const hasDirect = candidates.length > 0;
    // If the first scan found nothing, give the MAIN-world hook a moment to
    // observe the player's network requests and rescan before falling back to
    // webpage text.  MSE-only pages have no <video src> to scan directly.
    setTimeout(() => {
      if (!item || item.closed || !item.mediaState || item.mediaState.busy) return;
      if (!item.mediaState.list.length) {
        const refreshed = scanMediaCandidates();
        if (refreshed.length) {
          item.mediaState.list = refreshed;
          item.mediaState.candidate = refreshed[0];
          item.mediaState.textMode = false;
        } else {
          item.mediaState.textMode = true;
        }
      }
      startMediaSummary(item);
    }, hasDirect ? 60 : 450);
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

  function openDouyinLinkSummary(value, fallbackTitle, point) {
    const source = httpUrl(value);
    if (!source) return null;
    const item = openWindow('', fallbackTitle || '抖音视频总结', null, point, { bare: true });
    if (!item) return null;
    item.summaryProtected = true;
    item.mediaState = {
      busy: true,
      cancelled: false,
      answer: '',
      transcript: '',
      transcriptCues: [],
      transcriptDuration: 0,
      error: '',
      subtitleError: '',
      textMode: false,
      list: [],
      anchorVideo: null,
      candidate: null,
      boundAwemeId: '',
      prompt: ''
    };
    showSummaryLoading(item, '正在解析抖音视频…');
    requestDouyinResolve(source).then(resolved => {
      if (!item || item.closed || !item.mediaState) return;
      const state = item.mediaState;
      if (state.cancelled) return;
      const audio = resolved && Array.isArray(resolved.audio) ? resolved.audio.find(url => /^https?:\/\//i.test(String(url || ''))) : '';
      const video = resolved && Array.isArray(resolved.video) ? resolved.video.find(url => /^https?:\/\//i.test(String(url || ''))) : '';
      if (!resolved || !resolved.ok || (!audio && !video)) {
        state.busy = false;
        state.error = '抖音视频解析失败：' + String((resolved && (resolved.detail || resolved.reason)) || '没有返回可用媒体地址');
        openPanel(item, 'media');
        hideSummaryLoading(item);
        if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
        return;
      }
      const duration = Number(resolved.duration) || 0;
      const title = resolved.title || fallbackTitle || '抖音视频';
      const awemeId = String(resolved.videoId || '');
      const entries = [];
      if (audio) entries.push({ element: null, kind: 'audio', url: audio, srcKind: 'direct', duration, title, visible: false, boundAwemeId: awemeId });
      if (video) entries.push({ element: null, kind: 'video', url: video, srcKind: 'direct', duration, title, visible: false, boundAwemeId: awemeId, verifiedVideo: true });
      state.list = entries;
      state.candidate = entries[0] || null;
      state.busy = false;
      state.textMode = false;
      state.boundAwemeId = String(resolved.videoId || '');
      if (resolved.title) {
        item.title = String(resolved.title).slice(0, 180);
        item.fallbackTitle = item.title;
        if (typeof renderTitle === 'function') renderTitle(item);
      }
      openPanel(item, 'media');
      if (typeof hideSummaryWindow === 'function') hideSummaryWindow(item);
      startMediaSummary(item);
    }).catch(error => {
      if (!item || item.closed || !item.mediaState || item.mediaState.cancelled) return;
      item.mediaState.busy = false;
      item.mediaState.error = '抖音视频解析失败：' + String(error && error.message || error || '网络错误');
      openPanel(item, 'media');
      hideSummaryLoading(item);
      if (typeof revealSummaryWindow === 'function') revealSummaryWindow(item);
    });
    return item;
  }

  function openPageOrMediaSummary() {
    const candidates = scanMediaCandidates();
    const candidateVideo = candidates.find(candidate => candidate.element && String(candidate.element.tagName || '').toUpperCase() === 'VIDEO');
    const domVideo = Array.from(document.querySelectorAll('video')).find(video => {
      const rect = video.getBoundingClientRect();
      return rect && rect.width >= 160 && rect.height >= 40 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const videoElement = findActiveVideoElement() || (candidateVideo ? candidateVideo.element : domVideo);
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
    resetSummaryLoadingProgress(item);
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
      if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
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
    // The panel may be rebuilt while the stream runs; always resolve the live
    // answer node before writing to it.
    const currentOut = () => liveSummaryOut(item, 'media') || out;
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
          if (meta) meta.textContent = (state.boundTitle ? '当前视频：' + state.boundTitle + ' · ' : '') + '已加载完成 · 总结来源：音频（ASR） · 文本模型 ' + (response.model || '');
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
    let streamWatchdog = 0;
    let keepAlive = 0;
    let renderTimer = 0;
    keepAlive = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (e) { /* ignore */ } }, 15000);
    const armStreamWatchdog = () => {
      if (streamWatchdog) clearTimeout(streamWatchdog);
      streamWatchdog = setTimeout(() => {
        if (streamDone) return;
        streamDone = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        finishWithFallback('流式总结 90 秒没有返回新内容');
      }, 90000);
    };
    const endStream = () => {
      streamDone = true;
      if (streamWatchdog) clearTimeout(streamWatchdog);
      streamWatchdog = 0;
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = 0;
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = 0;
    };
    armStreamWatchdog();
    const started = Date.now();
    let answer = '';
    const renderPartial = () => {
      if (streamDone) return;
      const target = currentOut();
      if (!target) return;
      target.classList.add('markdown');
      target.innerHTML = markdownToHtml(answer);
      if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item);
      showStreamDots(item, target);
    };
    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = 0;
        renderPartial();
        // Streaming replaces the answer HTML on every tick; keep the TOC in
        // sync so the active chapter and sticky heading stay accurate.
        if (typeof refreshSummaryToc === 'function' && collectSummaryHeadings(out).length >= TOC_MIN_HEADINGS) refreshSummaryToc(item);
      }, 60);
    };
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
      if (!msg) return;
      if (msg.type === 'ping') return;
      if (msg.type === 'delta') {
        answer += String(msg.text || '');
        armStreamWatchdog();
        scheduleRender();
        if (status) status.textContent = '正在生成总结 · 已用 ' + Number(msg.elapsed || ((Date.now() - started) / 1000)).toFixed(1) + ' 秒';
        if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, Math.min(96, 82 + Math.min(14, answer.length / 100)), '正在生成总结…');
        return;
      }
      if (msg.type === 'done') {
        endStream();
        state.answer = answer;
        state.busy = false;
        if (out) { out.classList.remove('streaming'); out.classList.add('markdown'); out.innerHTML = markdownToHtml(answer);
      if (typeof refreshSummaryToc === 'function') refreshSummaryToc(item); hideStreamDots(item); out.dataset.tone = 'good'; }
        if (status) { status.textContent = '已加载完成'; status.classList.remove('streaming'); }
        if (item.ui && item.ui.mediaProgress) item.ui.mediaProgress.style.width = '100%';
        if (item.ui && item.ui.mediaPercent) item.ui.mediaPercent.textContent = '100%';
        if (meta) meta.textContent = (state.boundTitle ? '当前视频：' + state.boundTitle + ' · ' : '') + '已加载完成 · 总结来源：音频（ASR） · 文本模型 ' + (msg.model || '') + ' · 总耗时 ' + Math.max(0.1, (Date.now() - (state.startedAt || started)) / 1000).toFixed(1) + ' 秒';
        if (typeof markSummaryStep === 'function') markSummaryStepLabel(item, 'media', 'AI 总结', 'done');
        if (typeof updateSummaryLoading === 'function') updateSummaryLoading(item, 100, '总结完成');
      if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
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
    port.onDisconnect.addListener(() => {
      if (streamDone) return;
      endStream();
      item.aiPort = null;
      finishWithFallback('后台连接断开');
    });
    try { port.postMessage({ type: 'start', request }); } catch (e) { endStream(); finishWithFallback('请求发送失败'); }
  }

  function videoActivityScore(video) {
    if (!video || !video.isConnected) return -1;
    let score = 0;
    try {
      if (!video.paused) score += 100;
      if (Number(video.currentTime) > 0.05) score += 40;
      if (Number(video.readyState) >= 2) score += 15;
      if (Number(video.videoWidth) > 0) score += 10;
      const rect = video.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 45 && rect.bottom > 0 && rect.top < window.innerHeight) score += 25;
    } catch (e) { /* ignore */ }
    return score;
  }
  function findActiveVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'))
      .filter(video => video && video.isConnected && isVideoSummaryEligible(video)
        && (video.currentSrc || video.src || video.srcObject || video.readyState > 0));
    return videos.sort((a, b) => videoActivityScore(b) - videoActivityScore(a))[0] || null;
  }
  function findCaptureVideoElement() {
    return findActiveVideoElement();
  }

  function addMediaCandidateOnce(list, entry) {
    if (!Array.isArray(list) || !entry || !entry.url) return;
    const exists = list.some(item => item && item.url === entry.url && item.kind === entry.kind);
    if (!exists) list.unshift(entry);
  }

  function douyinDetailBoundId(detail, currentId, mediaDuration) {
    const detailId = String(detail && detail.awemeId || '');
    const detailDuration = Number(detail && detail.duration) || 0;
    const durationMatches = !mediaDuration || !detailDuration
      || Math.abs(douyinDurationSeconds(detailDuration) - mediaDuration) < 3;
    if (!detailId || !durationMatches) return '';
    if (currentId) return detailId === String(currentId) ? detailId : '';
    let pageVideoId = '';
    try { pageVideoId = (location.pathname.match(/\/video\/(\d+)/) || [])[1] || ''; } catch (e) { /* ignore */ }
    return pageVideoId && detailId === pageVideoId ? detailId : '';
  }

  function appendDouyinDetailCandidates(list, detail, detailId, mediaDuration, title) {
    if (!Array.isArray(list) || !detail || !detailId) return;
    const duration = Number(detail.duration) ? douyinDurationSeconds(detail.duration) : (Number(mediaDuration) || 0);
    const videoUrl = detail.video && detail.video[0];
    const audioUrl = detail.audio && detail.audio[0];
    if (audioUrl) addMediaCandidateOnce(list, {
      element: null, kind: 'audio', url: audioUrl, srcKind: 'direct', duration,
      title: String(title || document.title || ''), visible: false, boundAwemeId: detailId
    });
    if (videoUrl) addMediaCandidateOnce(list, {
      element: null, kind: 'video', url: videoUrl, srcKind: 'direct', duration,
      title: String(title || document.title || ''), visible: false, boundAwemeId: detailId,
      verifiedVideo: true
    });
  }

  function selectMediaCandidate(state) {
    const list = (state && state.list) || [];
    if (/douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
      // The recommendation feed keeps several preloaded <video> nodes and the
      // webRequest stream contains URLs for ads, effects and neighbouring
      // clips.  A media URL is only usable when it is attached to the exact
      // player the user opened the summary for.  Never fall through to a
      // "latest" URL or another visible player: that summarized a different
      // video while looking successful.
      const anchor = state && state.anchorVideo && state.anchorVideo.isConnected ? state.anchorVideo : null;
      if (anchor) {
        return list.find(candidate => !candidate.unbound && candidate.element === anchor) || null;
      }
      const activeVideo = list
        .filter(candidate => !candidate.unbound && candidate.kind === 'video' && candidate.element)
        .sort((a, b) => videoActivityScore(b.element) - videoActivityScore(a.element))[0];
      return activeVideo && videoActivityScore(activeVideo.element) > 0 ? activeVideo : null;
    }
    // Candidates flagged `downloadOnly` exist purely so "下载视频" has a real
    // file; they must never be chosen as the thing to summarize.
    const usable = list.filter(candidate => !candidate.downloadOnly);
    return usable.find(candidate => candidate.url && !/^blob:/i.test(candidate.url) && candidate.kind === 'audio')
      || usable.find(candidate => candidate.url && !/^blob:/i.test(candidate.url))
      || usable[0] || null;
  }

  async function startMediaSummary(item) {
    if (!item || item.closed || !item.mediaState) return;
    const state = item.mediaState;
    // Check busy before tearing down the active stream.  Previously a retry
    // button clicked during streaming disconnected the port and then returned,
    // leaving the UI stuck in "busy" until the watchdog fired.
    if (state.busy) { toast(item, '正在处理中，请先取消当前任务'); return; }
    resetSummaryLoadingProgress(item);
    if (item.aiPort) { try { item.aiPort.disconnect(); } catch (e) { /* ignore */ } item.aiPort = null; }
    state.busy = true;
    state.cancelled = false;
    state.error = '';
    state.answer = '';
    state.transcript = '';
    state.transcriptCues = [];
    state.transcriptDuration = 0;
    state.startedAt = Date.now();
    state.summaryResourcesCleared = false;
    const anchorVideo = state.anchorVideo && state.anchorVideo.isConnected
      ? state.anchorVideo
      : (item.anchorVideo && item.anchorVideo.isConnected ? item.anchorVideo : null);
    if (anchorVideo) state.anchorVideo = anchorVideo;
    const douyinHost = /douyin\.com|iesdouyin\.com/i.test(location.hostname);
    const targetAwemeId = douyinHost ? currentDouyinAwemeId(anchorVideo) : '';
    state.boundAwemeId = targetAwemeId;
    updateSummarySubtitleButton(item);
    if (typeof markSummaryStep === 'function') markSummaryStep(item, 'media', 0, 'active');
    if (douyinHost) {
      // Do not merge tab-wide webRequest URLs here.  That list also contains
      // preloaded neighbours, live streams, ads and UI effect clips, and the
      // old code could pick one as the "current" media.
      const fresh = scanMediaCandidates();
      if (fresh.length) { state.list = fresh; state.textMode = false; }
    }
    if (!state.list || !state.list.length) state.list = scanMediaCandidates();
    // A direct Douyin player may expose the muxed MP4 as currentSrc while the
    // browser still cannot decode its audio track.  The player's paired
    // audio-only DASH request shares the same `l` request-log token; retain it
    // as a bound fallback without letting it outrank the exact video anchor.
    const pairedAudioUrls = douyinHost ? douyinAudioTracksForVideo(anchorVideo) : [];
    for (const audioUrl of pairedAudioUrls) {
      if (!audioUrl || (state.list || []).some(entry => entry && entry.url === audioUrl)) continue;
      state.list.push({
        element: null,
        kind: 'audio',
        url: audioUrl,
        srcKind: 'direct',
        duration: Number(anchorVideo && anchorVideo.duration) || 0,
        title: document.title || '',
        visible: false,
        boundAwemeId: targetAwemeId
      });
    }
    // Douyin URL resolution is deliberately handled after candidate selection:
    // the exact <video> node is already a valid, correctly-bound source even
    // when every CDN resolver is unavailable.  Trying network resolvers here
    // used to add 20+ seconds and let the recommendation feed advance before
    // the summary had even started.
    if (/kuaishou\.com/i.test(location.hostname) && !state.list.some(candidate => candidate.url && !/^blob:/i.test(candidate.url))) {
      updateSummaryLoading(item, 14, '正在解析快手视频地址…');
      const resolved = await requestKuaishouResolve(location.href);
      if (resolved && resolved.url) {
        state.list.unshift({ element: null, kind: 'video', url: resolved.url, srcKind: 'direct', duration: Number(resolved.duration) || 0, title: resolved.title || document.title || '', visible: true });
        state.textMode = false;
      }
    }
    if (/bilibili\.com/i.test(location.hostname)) {
      // The player uses separate DASH video/audio `.m4s` files, which cannot be
      // saved as one playable MP4.  Resolve the progressive (muxed) MP4 so both
      // "下载视频" and the summary have a real, directly downloadable source.
      updateSummaryLoading(item, 14, '正在解析 B 站音视频地址…');
      const [biliMedia, biliAudio] = await Promise.all([
        typeof bilibiliProgressiveMedia === 'function' ? bilibiliProgressiveMedia() : Promise.resolve(null),
        typeof bilibiliAudioUrl === 'function' ? bilibiliAudioUrl() : Promise.resolve('')
      ]);
      if (biliMedia && biliMedia.url) {
        state.list.unshift({
          element: null, kind: 'video', url: biliMedia.url, srcKind: 'direct',
          duration: Number(biliMedia.duration) || 0, title: biliMedia.title || document.title || '',
          visible: true, verifiedVideo: true, downloadOnly: true
        });
        state.biliMedia = biliMedia;
        state.textMode = false;
      }
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
    const candidate = selectMediaCandidate(state);
    if (!candidate) {
      state.busy = false;
      state.error = (state.subtitleError ? '字幕不可用：' + state.subtitleError + '；' : '') + '没有检测到可提取的 <video>、<audio> 或媒体流。若是 Canvas / DRM / 跨域媒体，浏览器无法读取。';
      if (out) { out.textContent = state.error; out.dataset.tone = 'bad'; }
      if (status) status.textContent = '没有可提取媒体';
      revealSummaryWindow(item);
      return;
    }
    state.candidate = candidate;
    state.transcriptDuration = Number(candidate.duration) || 0;
    if (typeof markSummaryStep === 'function') markSummaryStep(item, 'media', candidate.kind === 'audio' ? 1 : 2, 'active');
    if (typeof setSummaryEstimate === 'function') setSummaryEstimate(item, candidate.duration ? Math.max(20, Math.min(300, candidate.duration / 8 + 20)) : 60);
    if (item.ui && item.ui.mediaDownload) item.ui.mediaDownload.hidden = true;
    if (item.ui && item.ui.mediaAudioDownload) item.ui.mediaAudioDownload.hidden = true;
    if (/douyin\.com/i.test(location.hostname) && (!candidate.url || candidate.srcKind === 'blob' || candidate.srcKind === 'stream')) {
      updateSummaryLoading(item, 16, '正在读取抖音详情并优先解析音频…');
      const currentId = state.boundAwemeId || currentDouyinAwemeId(anchorVideo);
      // Capture the exact player's SourceBuffer bytes now, before a 9–12 second
      // detail request gives the recommendation feed time to replace the node.
      // This snapshot is still the clicked clip even if playback advances.
      const anchorBlob = String(anchorVideo && (anchorVideo.currentSrc || anchorVideo.src) || '');
      state.mseChunksPromise = /^blob:/i.test(anchorBlob) ? requestDouyinMseChunks(anchorBlob) : null;
      // Even when the DOM does not expose an id, a canonical /video/{id} page
      // can still resolve it in the MAIN-world hook.  Skipping the request in
      // that case was why some detail pages fell back to the MSE blob and never
      // exposed the direct MP4 download URL.
      let canonicalVideoPage = false;
      try { canonicalVideoPage = /\/video\/\d+/.test(location.pathname); } catch (e) { /* ignore */ }
      const detail = (currentId || canonicalVideoPage) ? await requestDouyinDetail(currentId, anchorVideo) : null;
      // A Douyin detail response's `music.play_url` is usually the background
      // music, not the spoken audio.  Use the real video stream (or the exact
      // player's MSE/audio request) and never substitute background music for
      // a missing voice track.  The reply must name the same aweme requested.
      const mediaDuration = Number(candidate.duration) || Number(anchorVideo && anchorVideo.duration) || 0;
      const detailId = douyinDetailBoundId(detail, currentId, mediaDuration);
      if (detail && detailId && detail.audio && detail.audio.length) {
        // Prefer the audio-only DASH track returned by the detail API.  It is
        // small, has no video bytes, and is bound to the same aweme id.
        candidate.url = detail.audio[0];
        candidate.srcKind = 'direct';
        candidate.kind = 'audio';
        candidate.boundAwemeId = detailId;
        state.boundAwemeId = detailId;
        if (detail.title) state.boundTitle = String(detail.title).slice(0, 120);
        // Keep the muxed video URL as a separate download candidate.  The
        // summary itself stays audio-only, but "下载视频" must use the real
        // MP4 rather than the MediaSource blob.
        appendDouyinDetailCandidates(state.list, detail, detailId, mediaDuration, state.boundTitle);
      } else if (detail && detailId && detail.video && detail.video.length) {
        candidate.url = detail.video[0];
        candidate.srcKind = 'direct';
        candidate.kind = 'video';
        candidate.boundAwemeId = detailId;
        candidate.verifiedVideo = true;
        state.boundAwemeId = detailId;
        if (detail.title) state.boundTitle = String(detail.title).slice(0, 120);
        appendDouyinDetailCandidates(state.list, detail, detailId, mediaDuration, state.boundTitle);
      } else {
        // Page data is still allowed, but only through the id-filtered path.
        // If it cannot prove ownership we leave the blob candidate in place and
        // let the exact player's MSE audio track be decoded below.
        const douyinVideo = resolveDouyinMediaUrl(anchorVideo);
        const douyinAudio = douyinVideo ? '' : resolveDouyinAudioUrl(anchorVideo);
        const douyinUrl = douyinVideo || douyinAudio;
        if (douyinUrl) {
          candidate.url = douyinUrl;
          candidate.srcKind = 'direct';
          candidate.kind = douyinAudio ? 'audio' : 'video';
          candidate.boundAwemeId = currentId;
        }
      }
      if (candidate.srcKind !== 'blob') state.mseChunksPromise = null;
      if (item.ui && item.ui.mediaSource) item.ui.mediaSource.textContent = mediaSourceNote(state);
    }
    if (item.ui && item.ui.mediaDownload) {
      item.ui.mediaDownload.hidden = !((state.list || []).some(value => value.kind === 'video' && value.url) || candidate.kind === 'video');
    }
    if (item.ui && item.ui.mediaAudioDownload) {
      item.ui.mediaAudioDownload.hidden = !((state.list || []).some(value => value.kind === 'audio' && value.url) || candidate.kind === 'audio' || candidate.kind === 'video');
    }
    updateSummaryLoading(item, 18, candidate.kind === 'audio' ? '已找到音频，正在准备…' : '已找到视频，正在准备本地音频…');
    if (status) status.textContent = candidate.kind === 'audio' ? '正在准备音频链路…' : '正在准备视频链路…';
    if (meta) {
      const identity = String(state.boundTitle || '').trim()
        ? '当前视频：' + String(state.boundTitle).trim()
        : (state.boundAwemeId ? '当前视频 ID：' + state.boundAwemeId : '');
      meta.textContent = [identity, candidate.duration ? '时长 ' + Math.round(candidate.duration) + ' 秒' : ''].filter(Boolean).join(' · ');
    }
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
        const boundAudioCandidates = (state.list || []).filter(entry => !entry.unbound
          && entry.kind === 'audio'
          && entry.url
          && entry.srcKind !== 'blob'
          && entry.srcKind !== 'stream'
          && (!state.boundAwemeId || entry.boundAwemeId === state.boundAwemeId || entry.element === anchorVideo)).slice(0, 4);
        const boundAudioCandidate = boundAudioCandidates[0] || null;
        const expectedDuration = Number(candidate.duration) || Number(anchorVideo && anchorVideo.duration) || 0;
        let audio = null;
        let audioTranscript = '';
        for (const audioEntry of boundAudioCandidates) {
          if (audio || audioTranscript) break;
          if (status) status.textContent = expectedDuration > 600 ? '正在远程分段转写当前视频音轨…' : '正在读取当前视频的独立音轨…';
          updateSummaryLoading(item, 30, expectedDuration > 600 ? '正在远程分段转写当前视频音轨…' : '正在读取当前视频的独立音轨…');
          // Long videos (20–40 min) cannot pass a multi-megabyte data URL
          // through chrome.runtime.sendMessage.  Let the offscreen worker
          // download the audio URL itself and return transcript segments.
          const remote = await requestRemoteTranscript(audioEntry);
          if (remote && remote.ok && remote.text) {
            const remoteDuration = Number(remote.duration) || 0;
            if (!expectedDuration || !remoteDuration || Math.abs(remoteDuration - expectedDuration) < 3) {
              audioTranscript = remote.text;
              if (meta) meta.textContent = '音频已分段转写 · ' + remote.chunks + ' 段 · ' + Math.round(remoteDuration || 0) + ' 秒';
              updateSummaryLoading(item, 68, '音频转写完成，正在生成总结…');
              break;
            }
          }
          const attempt = await extractAudioFromUrl(audioEntry);
          if (attempt && (!expectedDuration || !Number(attempt.duration)
            || Math.abs(Number(attempt.duration) - expectedDuration) < 3)) audio = attempt;
        }
        if (!audio && !audioTranscript) audio = await extractAudioFromVideo(candidate);
        if (state.cancelled || item.closed) { state.busy = false; return; }
        if (!audio && /douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
          // The player is MSE: its blob URL has no file behind it, but the
          // MAIN-world hook has the SourceBuffer bytes.  Reconstruct a local
          // audio blob before trying to clone the player.
          if (status) status.textContent = '正在读取 MSE 音轨分片…';
          updateSummaryLoading(item, 34, '正在读取 MSE 音轨分片…');
          const mseChunks = state.mseChunksPromise
            ? await state.mseChunksPromise
            : await requestDouyinMseChunks((candidate.element || anchorVideo) && (candidate.element || anchorVideo).currentSrc || '');
          state.mseChunksPromise = null;
          if (mseChunks.length) {
            if (status) status.textContent = '正在离线解码 MSE 音轨…';
            updateSummaryLoading(item, 38, '正在离线解码 MSE 音轨…');
            audio = await extractAudioFromMseChunks(mseChunks);
          }
          if (state.cancelled || item.closed) { state.busy = false; return; }
          // Douyin often exposes a separate audio-only DASH stream.  Prefer it
          // over recording the player when the video stream has no audio track.
          // The stream must still belong to this exact aweme.
          const audioCandidate = boundAudioCandidate || (state.list || []).find(entry => !entry.unbound
            && entry.kind === 'audio'
            && entry.url
            && entry.srcKind !== 'blob'
            && entry.srcKind !== 'stream'
            && (!state.boundAwemeId || entry.boundAwemeId === state.boundAwemeId || entry.element === anchorVideo));
          if (!audio && audioCandidate && audioCandidate !== boundAudioCandidate) {
            if (status) status.textContent = '发现独立音频流，正在解码音频…';
            updateSummaryLoading(item, 40, '发现独立音频流，正在解码…');
            audio = await extractAudioFromUrl(audioCandidate);
          }
        }
        if (state.cancelled || item.closed) { state.busy = false; return; }
        if (!audio && boundAudioCandidate) {
          // The audio URL is small and can be transcribed directly by the
          // background worker even when the page's AudioContext cannot decode
          // the container locally.
          payload = { kind: 'audio', url: boundAudioCandidate.url, returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          if (status) status.textContent = '已取得当前视频音轨，正在交给后台转写…';
          updateSummaryLoading(item, 48, '已取得当前视频音轨，正在交给后台转写…');
          if (meta) meta.textContent = '已取得当前视频的独立音轨 · 正在转写…';
        }
        // Direct downloads fail for MSE/blob DRM-free players.  Fall back to
        // capturing only the audio track from the actual <video> element, so
        // the model still receives audio (never a raw video).  Douyin often
        // replaces the <video> node while its SPA navigates, so also search
        // the current page for an active player if the original ref is stale.
        const captureElement = candidate.element && candidate.element.isConnected
          ? candidate.element
          : (/douyin\.com|iesdouyin\.com/i.test(location.hostname) ? findCaptureVideoElement() : null);
        let backgroundVideo = null;
        const captureSpeed = Math.max(2, Math.min(8, Number(settings.captureRate) || 4));
        if (!audio && !audioTranscript && payload.kind !== 'audio' && captureElement && String(captureElement.tagName || '').toUpperCase() === 'VIDEO') {
          // Try an off-screen clone first.  The visible player keeps playing at
          // normal speed while the clone is decoded at 4x/5x and recorded.
          backgroundVideo = await createBackgroundVideo(captureElement);
          if (backgroundVideo) {
            if (status) status.textContent = '正在后台 ' + captureSpeed + '× 捕获音轨，前台播放不受影响…';
            updateSummaryLoading(item, 42, '正在后台 ' + captureSpeed + '× 捕获音轨…');
            audio = await captureStreamAudio(Object.assign({}, candidate, {
              element: backgroundVideo,
              backgroundCapture: true,
              captureRate: captureSpeed
            }), item);
            if (state.cancelled || item.closed) { try { removeBackgroundVideo(backgroundVideo); } catch (e) { /* ignore */ } state.busy = false; return; }
            if (!audio) {
              if (status) status.textContent = '后台捕获不可用，正在尝试音频节点…';
              audio = await captureMediaElementAudio(backgroundVideo, item, {
                background: true,
                captureRate: captureSpeed,
                duration: Number(candidate.duration) || Number(anchorVideo && anchorVideo.duration) || 0
              });
              if (state.cancelled || item.closed) { try { removeBackgroundVideo(backgroundVideo); } catch (e) { /* ignore */ } state.busy = false; return; }
            }
            try { removeBackgroundVideo(backgroundVideo); } catch (e) { /* ignore */ }
          } else if (!/douyin\.com|iesdouyin\.com/i.test(location.hostname)) {
            // Non-Douyin sites may use a MediaSource that cannot be cloned.
            // Keep the older foreground fallback there, but never fast-forward
            // a Douyin feed behind the user's back.
            if (status) status.textContent = '无法后台克隆，正在从播放器转录音轨…';
            updateSummaryLoading(item, 42, '正在把视频音轨转为音频…');
            audio = await captureStreamAudio(Object.assign({}, candidate, { element: captureElement, captureRate: 1 }), item);
            if (state.cancelled || item.closed) { state.busy = false; return; }
            if (!audio) {
              if (status) status.textContent = '播放器音轨不可见，正在用音频节点捕获…';
              audio = await captureMediaElementAudio(captureElement, item, {
                captureRate: 1,
                duration: Number(candidate.duration) || Number(captureElement.duration) || 0
              });
              if (state.cancelled || item.closed) { state.busy = false; return; }
            }
          } else if (status) {
            status.textContent = '该视频无法后台克隆，已停止录制；请重试或刷新页面。';
          }
        }
        if (audioTranscript) {
          payload = { kind: 'audio', transcript: audioTranscript, returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          state.candidate.kind = 'audio';
          updateSummaryLoading(item, 68, '音轨转写完成，正在生成总结…');
          if (status) status.textContent = '音轨转写完成，正在生成总结…';
        } else if (audio) {
          payload = { kind: 'audio', dataUrl: audio.dataUrl, audioChunks: audio.chunks || [audio.dataUrl], returnTranscript: true, prompt: aiConfig.mediaAudioPrompt || MEDIA_AUDIO_PROMPT };
          state.candidate.kind = 'audio';
          updateSummaryLoading(item, 58, '音频提取完成，正在上传到硅基流动…');
          if (meta && audio.duration) meta.textContent = '本地音轨已转为 WAV · ' + Math.round(audio.duration) + ' 秒';
          if (status) status.textContent = '音频提取完成，正在上传到硅基流动…';
        } else if (payload.kind === 'audio' && payload.url) {
          if (status) status.textContent = '已取得当前视频独立音轨，正在上传到硅基流动…';
          updateSummaryLoading(item, 58, '已取得当前视频独立音轨，正在上传到硅基流动…');
        } else if (status) {
          updateSummaryLoading(item, 45, '视频音轨转换失败；未发送原始视频');
          status.textContent = '视频音轨转换失败，已停止（不会把原始视频发给模型）';
        }
      }
      if (candidate.kind === 'video' && payload.kind !== 'audio') {
        // Never send a raw video to the text/ASR worker.  If audio extraction
        // failed, report the real local failure instead of the misleading
        // "视频必须先转为音频" backend error.
        state.busy = false;
        state.error = '没有拿到可用音轨：当前视频是 Blob/MediaSource 流，既没有可直接下载的媒体地址，也无法克隆到后台播放器。已尝试详情接口、页面数据、网络请求和后台音轨捕获；不会在前台快进录制，也不会把原始视频发给模型。请刷新页面后重试，或换一个视频。';
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
      if (!payload.dataUrl && !(payload.kind === 'audio' && (payload.url || payload.transcript))) {
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
        state.transcriptCues = Array.isArray(result.cues) ? result.cues : [];
        state.transcriptDuration = Number(result.duration) || Number(state.candidate && state.candidate.duration) || 0;
        updateSummarySubtitleButton(item);
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
      if (meta) meta.textContent = (state.boundTitle ? '当前视频：' + state.boundTitle + ' · ' : '') + '总结来源：' + (result.kind === 'audio' ? '音频（ASR）' : '媒体') + ' · 模型 ' + (result.model || 'ASR') + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : '') + (result.size ? ' · ' + Math.round(result.size / 1024 / 1024) + 'MB' : '');
      publishSidePanel(item, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''), 'good');
      updateSummaryLoading(item, 100, '总结完成' + (elapsed ? ' · 耗时 ' + elapsed + ' 秒' : ''));
      if (typeof syncFollowupVisibility === 'function') syncFollowupVisibility(item);
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


})(); 
})();





