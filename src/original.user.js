// ==UserScript==
// @name         Link-Drag-Preview 完全体 (Link Preview Suite)
// @namespace    https://tampermonkey.net/fox-qqqorange
// @version      20.3.0
// @description  拖拽/长按/Alt点击链接即在当前页浮出预览：多窗口、画中画标题小条、排列版式、预览内查找、同步滚动、阅读模式、窗口记忆与会话恢复、无限嵌套预览、拖放即预览、自定义快捷键。v20.0：① 悬停迷你预览 —— 鼠标在链接上停够阈值（默认 600ms，可调）弹出比画中画略小的略缩图小窗，看到的是完整一屏窗口，点击即开；② 禁止嵌入的站点（X-Frame-Options / CSP）自动改为「抓取快照」只读渲染；③ 悬停 350ms 即预热链接（preconnect + prefetch），打开预览明显变快；④ 页面底端提示条重做成小胶囊，白夜间自动跟随。v20.0.1 修复致命缺陷：adoptStyles 在同一影子根上第二次注入样式时会把上一条（窗口 CSS）剔出 adoptedStyleSheets，导致浮出按钮一出现整份窗口样式失效 —— 窗口变成未加样式的块、图标撑成 730px 的「超大符号」、拖拽后看不到正常窗口（真实 Chromium 已复现，v19.2 起就存在）。v20.1 取色重做：窗口色调跟随网页真实底色（饱和度封顶 12%，可关），深色的彩色网页不再配中性灰窗口；悬停小窗收起即卸载 iframe —— 视频不会再在后台继续播放，并新增「小窗内视频不自动播放」开关。v20.2 小窗声音治理：小窗标题条新增一键「停止播放 / 恢复」按钮（点一下立即卸掉 iframe，一定停声）；「小窗内视频」升级为三档 —— 实时页面·拒绝自动播放（默认）/ 实时页面·不干预 / 静音快照（抓取页面后删掉全部脚本与音视频元素，绝对无声）。v20.2.1 删除「鼠标中键点击链接直接浮出预览」这个接管：它会把浏览器原生的「中键 → 后台新标签页打开链接」吃掉，用户报「中键没开新标签页反而弹预览小窗」，现改为完全交给浏览器（该监听整段移除，不再注册）。v20.2.2 提速与可诊断：①预热拆成两级（preconnect / prefetch）；②空闲时预建窗口外壳；③抓快照带上 HTTP 状态码（4xx/5xx 不再渲染成空白页），并新增「空壳检测」——SPA 快照抓回来却空空如也时就地说明原因，提示条还直接带一个「在新标签页打开」按钮。v20.2.3 回退 v20.2.2 的三项「提速」改动（用户报「更卡了，等半分钟都没进去」）：划过链接不再 preconnect、按下鼠标不再 prefetch 整页、页面加载期不再预建外壳（改到指针首次碰到链接时再排队建），prefetch 回到「位移过半 / 悬停 350ms」两个意图明确点 —— 普通点一下打开网页的体感与 v20.2.1 一致；v20.2.2 的三项「可诊断」能力全部保留。v20.3.0 渐进显示：预览窗不再等整页加载完才一次性显示 —— 页面自身的 DOMContentLoaded 一到就撤掉骨架屏，内容边加载边显示，与直接开新标签页的体感一致（此前要等所有图片字体脚本全部到齐，而 iframe 的网络优先级与缓存分区又天生吃亏，等待被进一步放大）；init 改为设完 src 就按节奏补发，确保子框架能尽早开始上报加载阶段。
// @author       FOX / QQQOrange / 完全体
// @match        http://*/*
// @match        https://*/*
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_addStyle
// @connect      *
// @run-at       document-start
// ==/UserScript==
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
 *  Link Preview Suite v20.3.0
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
  const TAB_MARK_KEY = STORE + '_TAB_MARK';
  const SCHEMA_KEY = STORE + '_SCHEMA';
  const SCHEMA_VERSION = 190;
  const SCRIPT_VERSION = (() => {
    try {
      if (typeof GM_info === 'object' && GM_info && GM_info.script && GM_info.script.version) {
        return String(GM_info.script.version);
      }
    } catch (e) { /* 忽略 */ }
    return '20.3.0';
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
  const SNAPSHOT_SANDBOX = 'allow-forms allow-popups allow-popups-to-escape-sandbox';
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
    openInTab(url) {
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
    }
  };

  const DEFAULTS = {
    remember: true, grouping: 'site', theme: 'auto',
    blur: true, blurAmount: 8, glassBlur: 22, windowOpacity: 100, radius: 26,
    themeSource: 'smart', themeFollow: true, pageTint: true,
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
    showHelpOnce: true
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
    readerFontSize: [12, 28, 1], readerLineHeight: [120, 260, 10]
  };
  const ANIM_CHOICES = [['none', '关闭'], ['apple', '苹果线性'], ['spring', '物理回弹']];
  const ENUMS = {
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
        if (!all || typeof all !== 'object') return;
        for (const k of Object.keys(all)) extCache[k] = all[k];
        onExtStoreReady();
      });
    } catch (e) { /* 忽略 */ }
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
    if (key === ' ') key = 'space';
    if (key === 'escape') key = 'esc';
    parts.push(key);
    return parts.join('+');
  }
  function isEditingInPage() {
    const ae = document.activeElement;
    if (!ae || ae === document.body) return false;
    if (ae.isContentEditable) return true;
    return /^(input|textarea|select)$/i.test(ae.localName || '');
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
      const consider = (node, name, w) => {
        const info = readBackground(node, name);
        if (!info) return false;
        let big = true;
        try {
          const rect = node.getBoundingClientRect();
          const v = viewport();
          big = rect.width * rect.height > v.w * v.h * 0.35;
        } catch (e) { /* 忽略 */ }
        if (!big && w < 2) return false;
        cands.push({ info, w: big ? w : w * 0.45, big });
        return true;
      };
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
      const solid = cands.find(c => c.big && c.info.alpha >= 0.9) || cands.find(c => c.info.alpha >= 0.9);
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
    if (!settings.pageTint) return '恒定中性灰（已关闭色调跟随）';
    if (!base) return '中性灰（拿不到页面底色）';
    const hsl = rgbToHsl(base.r, base.g, base.b);
    if (hsl.s < 0.04) return '中性灰（页面底色本身无彩，无色相可取）';
    const s = Math.min(hsl.s, TINT_MAX_S);
    return '跟随页面色相 ' + Math.round(hsl.h) + '°，饱和度 '
      + Math.round(s * 100) + '%（页面原始 ' + Math.round(hsl.s * 100) + '%，已封顶）';
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
    const baseHsl = baseColor ? rgbToHsl(baseColor.r, baseColor.g, baseColor.b) : null;
    // 底色明度直接用页面自己的，只做区间夹紧（不是档位）
    const rawL = baseHsl ? baseHsl.l : (isDark ? 0.10 : 0.92);
    const bgL = isDark ? clamp(rawL, 0.045, 0.20) : clamp(rawL, 0.82, 0.985);

    // 色调跟随：取网页真实底色的色相，饱和度封顶；底色太灰就不取（无色相可言）
    let hue = 0, sat = 0;
    if (settings.pageTint && baseHsl && baseHsl.s >= 0.04) {
      hue = baseHsl.h;
      sat = Math.min(baseHsl.s, TINT_MAX_S);
    }

    // 在页面底色上做小幅明度位移：暗色向上抬、亮色向下压，保持与页面一致的深浅关系
    const dir = isDark ? 1 : -1;
    const lv = d => clamp(bgL + dir * d, 0.02, 0.99);
    // g = 面（底色 / 描边 / 悬停 / 选中…）：带完整封顶饱和度
    // gt = 字（正文 / 次要文字 / 强调色 / 提示条）：只沾三成色调
    const g = l => makeCss(hue, sat, l);
    const gt = l => makeCss(hue, sat * 0.35, l);

    // 遮罩 / 投影一律中性黑：旧版的 rgba(3,5,10) 在灰底页面上能看出蓝
    if (isDark) return {
      bg: g(bgL),
      surface: g(lv(0.045)),
      head: g(lv(0.022)),
      hover: g(lv(0.062)),
      selected: g(clamp(bgL + 0.14, 0.14, 0.30)),
      border: g(clamp(bgL + 0.13, 0.10, 0.55)),
      text: gt(0.93),
      muted: gt(0.64),
      accent: gt(0.84),
      overlay: 'rgba(2,2,4,.58)',
      scrim: 'rgba(2,2,4,.44)',
      shadow: '0 12px 34px -12px rgba(0,0,0,.55),0 34px 80px -32px rgba(0,0,0,.66),0 2px 10px -4px rgba(0,0,0,.50)',
      toast: gt(0.93),
      'toast-text': gt(0.10)
    };
    return {
      bg: g(bgL),
      surface: g(lv(0.045)),
      head: g(lv(0.022)),
      hover: g(lv(0.062)),
      selected: g(lv(0.075)),
      border: g(clamp(bgL - 0.11, 0.42, 0.94)),
      text: gt(0.17),
      muted: gt(0.46),
      accent: gt(0.32),
      overlay: 'rgba(18,18,22,.26)',
      scrim: 'rgba(18,18,22,.22)',
      shadow: '0 10px 30px -12px rgba(10,10,14,.20),0 30px 72px -32px rgba(10,10,14,.28),0 2px 8px -3px rgba(10,10,14,.10)',
      toast: gt(0.20),
      'toast-text': gt(0.95)
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
    play: '<path d="M8 5.4v13.2L19 12 8 5.4Z"/>'
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }
  const button = (action, name, title) =>
    `<button type="button" class="btn" data-action="${action}" title="${title}" aria-label="${title}">${icon(name)}</button>`;

  /* ---- 浮出按钮（全局与子框架共用，性能敏感） ---------------------------------------- */
  const LAUNCHER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M6.6 7h.01M9.6 7h.01"/></svg>';
  const LAUNCHER_CSS = `[hidden]{display:none!important}
.ldp-launcher{--glass-base:var(--head,#dfe2e7);--glass-fill:color-mix(in srgb,var(--glass-base) var(--glass-a,100%),transparent);position:absolute;z-index:6;width:${LAUNCHER_SIZE}px;height:${LAUNCHER_SIZE}px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--border,#cbcbcb);border-radius:var(--r-ctl,9px);background:var(--glass-fill,#dfe2e7);backdrop-filter:var(--glass-filter,none);-webkit-backdrop-filter:var(--glass-filter,none);color:var(--accent,#4a4a4a);box-shadow:0 1px 5px -1px rgba(10,10,14,.22);pointer-events:auto;cursor:pointer;animation:ldp-in .16s cubic-bezier(.42,0,.58,1)}
.ldp-launcher:hover{background:var(--hover,#d1d8e3);border-color:color-mix(in srgb,var(--accent,#396bb5) 55%,transparent)}
.ldp-launcher:active{transform:scale(.95)}
.ldp-launcher:focus-visible{outline:2px solid var(--accent,#396bb5);outline-offset:1px}
.ldp-launcher svg{width:15px;height:15px;display:block;pointer-events:none}
/* 子框架里没有取色引擎，深色时只覆盖底色与强调色；磨砂与圆角仍由 applyFrameChrome 统一写入 */
:host([data-ldp-frame][data-theme="dark"]) .ldp-launcher{--glass-base:#20222d;--hover:#2c2e3a;--accent:#c9c9c9}
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
--bg:#eaeaea;--surface:#e2e2e2;--head:#e5e5e5;--text:#2d2d2d;--muted:#6f6f6f;--border:#cbcbcb;--hover:#d5d5d5;--accent:#4a4a4a;--selected:#d3d3d3;
--overlay:rgba(18,18,22,.26);--scrim:rgba(18,18,22,.22);
--shadow:0 10px 30px -12px rgba(10,10,14,.20),0 30px 72px -32px rgba(10,10,14,.28),0 2px 8px -3px rgba(10,10,14,.10);
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
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}`;

  const TEMPLATE_HTML = `<template id="ldp-win-tpl"><section class="window" role="dialog"><div class="header"><span class="grip">${icon('grip')}</span><span class="title"></span>${button('read', 'read', '阅读模式')}${button('pip', 'pip', '画中画')}${button('forceDark', 'dark', '强制暗色')}${button('theme', 'moon', '切换主题')}${button('pin', 'pin', '固定窗口')}${button('reload', 'refresh', '刷新')}${button('new', 'external', '新标签页')}${button('close', 'close', '关闭')}</div><div class="findbar" hidden><input type="text" class="fb-input" placeholder="在预览页内查找（回车下一个 / Shift+回车上一个）"><span class="fb-label">0/0</span><button type="button" class="btn fb-btn" data-action="findPrev" title="上一个（Shift+回车）">▲</button><button type="button" class="btn fb-btn" data-action="findNext" title="下一个（回车）">▼</button><label class="fb-opt" title="区分大小写"><input type="checkbox" class="fb-case">Aa</label><label class="fb-opt" title="全词匹配"><input type="checkbox" class="fb-ww">词</label><span class="fb-hint"></span><button type="button" class="btn fb-btn" data-action="findClose" title="关闭（Esc）">✕</button></div><div class="content"><div class="progress-bar"></div><iframe title="网页预览" sandbox="${FULL_SANDBOX}" allow="fullscreen"></iframe><div class="shield" hidden></div><div class="loader" hidden><div class="globe-icon">${icon('globe')}</div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="hint" hidden><button type="button" class="hint-close" data-action="hideHint">×</button><button type="button" class="hint-act" data-action="openTab" hidden></button><span class="hint-text"></span></div></div><div class="toolbar">${button('url', 'link', '复制网址')}<div class="divider"></div>${button('plus', 'plus', '放大')}${button('minus', 'minus', '缩小')}${button('resetZoom', 'reset', '100%')}<span class="zoom-label">100%</span><div class="divider"></div>${button('resetSize', 'fit', '重置尺寸')}<button type="button" class="btn" data-action="grid" title="排列版式" hidden>${icon('layout')}</button><button type="button" class="btn" data-action="arrange" title="智能排列" hidden>${icon('grid')}</button>${button('find', 'search', '预览内查找')}${button('history', 'history', '预览历史')}${button('help', 'help', '使用说明')}${button('settings', 'settings', '设置')}</div><div class="panel" hidden></div><div class="toast" hidden></div>${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `<div class="resize ${d}" data-direction="${d}"></div>`).join('')}</section></template><div class="backdrop" hidden></div><div class="snap-indicator"></div><div class="drop-overlay" hidden><div class="drop-ring"></div><div class="drop-card"><span class="drop-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><path d="m7.6 10.6 4.4 4.4 4.4-4.4"/><path d="M4.5 20.5h15"/></svg></span><span class="drop-text">松手即在此页浮出预览</span></div></div><div class="hover-peek" hidden><div class="peek-head"><span class="peek-title"></span><button type="button" class="peek-btn peek-mute" title="停止播放（静音）" aria-label="停止播放">${icon('mute')}</button><button type="button" class="peek-btn peek-open" title="打开完整预览" aria-label="打开完整预览">${icon('external')}</button></div><div class="peek-body"><div class="peek-stage"><iframe class="peek-frame" title="悬停预览" sandbox="${FULL_SANDBOX}" allow="${PEEK_ALLOW_BLOCK}"></iframe></div><div class="peek-note" hidden><span class="peek-note-ico">${icon('mute')}</span><span class="peek-note-text"></span></div><div class="peek-shield" title="点击打开完整预览"></div></div></div>`;

  /* ==================================================================================
   *  §7 手势：链接命中 / 预热 / 拖拽与长按 / 浮出按钮
   * ================================================================================== */
  /** 从事件路径里找出真正指向外链的那个 <a>（顶层与子框架共用的唯一权威实现） */
  function findLink(event) {
    const path = event.composedPath ? event.composedPath() : [event.target];
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
    const conf = cfg || settings;
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
      if (conf.longPressOpen) {
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
      if (conf.altClickOpen && event.button === 0 && event.altKey
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

  /**
   * 悬停浮出按钮。性能敏感：指针停在同一链接内走 O(1) 快路径，不重复查 DOM；
   * 位置计算合并到 rAF，滚动/缩放期间最多每帧一次。
   */
  function installLauncher(opts) {
    let host = null, btn = null, current = null, hideTimer = 0, themeDark = false;
    let lastX = 0, lastY = 0, rafId = 0;
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
          // 同时带上 x/y 与 clientX/clientY：宿主侧 openWindow 读 point.x/point.y，
          // 子框架侧读 event.clientX/clientY，统一给全，避免两边对不上。
          if (link) opts.onLaunch(link, { x: lastX, y: lastY, clientX: lastX, clientY: lastY });
        });
        target.root.append(btn);
      } else if (!btn.isConnected) {
        target.root.append(btn);
      }
      return true;
    }
    function hide() {
      clearTimeout(hideTimer); hideTimer = 0;
      current = null;
      if (btn && !btn.hidden) btn.hidden = true;
    }
    function place(link, x, y) {
      const rect = link.element.getBoundingClientRect();
      if (!(rect.width > 0 || rect.height > 0)) return false;
      const vw = window.innerWidth, vh = window.innerHeight, gap = 3;
      let left = rect.right + gap;
      if (left + LAUNCHER_SIZE > vw - 4) left = rect.right - LAUNCHER_SIZE - gap;
      left = clamp(left, 4, Math.max(4, vw - LAUNCHER_SIZE - 4));
      const anchorY = Number.isFinite(y) ? y : rect.top + rect.height / 2;
      const low = Math.min(rect.top, rect.bottom - LAUNCHER_SIZE);
      const high = Math.max(rect.top, rect.bottom - LAUNCHER_SIZE);
      let top = clamp(anchorY - LAUNCHER_SIZE / 2, low, high);
      top = clamp(top, 4, Math.max(4, vh - LAUNCHER_SIZE - 4));
      btn.style.left = Math.round(left) + 'px';
      btn.style.top = Math.round(top) + 'px';
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
      const same = current && current.element === link.element && current.url === link.url;
      current = link;
      clearTimeout(hideTimer); hideTimer = 0;
      if (!same || btn.hidden) btn.hidden = false;
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
        lastX = x; lastY = y;
        clearTimeout(hideTimer); hideTimer = 0;
        if (btn && btn.hidden && ensure()) btn.hidden = false;
        return;
      }
      show(link, x, y);
    }
    function handleLeave() {
      if (!current) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 300);
    }
    return { hide, show, setTheme, handleEnter, handleLeave, schedulePlace, isShowing: () => !!current && !!btn && !btn.hidden };
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
    let enabled = false, bridgeToken = '', parentOrigin = '*', threshold = 12,
      longPressDelay = 500, dragHold = 150, launcherEnabled = true,
      frameGlassPx = 22, frameRadiusPx = 26, frameDark = false,
      frameHost = null, frameRoot = null, lastFocusSent = 0, frameBound = false,
      scrollReportSuppressUntil = 0;   // setScroll/sync 引发的程序滚动不回传（防 A↔B 回环）
    // 触发方式以宿主实时下发为准，不读取子框架本地的 settings（那只是宿主配置的副本）
    const bridgeCfg = { longPressOpen: true, altClickOpen: true };
    let frameLauncher = null;
    function send(data) {
      if (!enabled) return;
      try { window.parent.postMessage(Object.assign({ channel: CHANNEL, token: bridgeToken }, data), parentOrigin); }
      catch (e) { /* 忽略 */ }
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
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE_HTML;
    adoptStyles(root, CSS, 'shell');
    shell = {
      host, root,
      backdrop: root.querySelector('.backdrop'),
      snapIndicator: root.querySelector('.snap-indicator')
    };
    document.documentElement.append(host);
    // 窗口重建时把已有窗口重新挂回新的 shadow root
    if (windows.length) for (const item of windows) if (!item.closed) root.append(item.ui.win);
    shell.backdrop.addEventListener('click', () => {
      if (!settings.backdropClose) return;
      const item = [...windows].reverse().find(w => !w.pinned && !isEffPip(w));
      if (item) closeWindow(item);
    });
    renderTheme(true);
  }
  function isEffPip(w) { return w.pip && !w.inArrange; }

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
      renderTheme(false);
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
    const hasModal = windows.some(w => !w.pinned && !isEffPip(w));
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
    setScrollLock(hasAny && settings.lockScroll && (hasModal || settings.lockScrollWhenPip));
    updateThemeButtons();
    if (syncSource && windows.indexOf(syncSource) < 0) syncSource = null;
  }
  function focusWindow(item) {
    if (!item || item.closed) return;
    const index = windows.indexOf(item);
    if (index >= 0 && index !== windows.length - 1) {
      windows.splice(index, 1);
      windows.push(item);
    }
    // 关掉其它窗口的面板时要正常提交输入，不能静默丢掉用户刚填的数字
    for (const w of windows) if (w !== item && !w.closed && !w.ui.panel.hidden) closePanel(w, true);
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
    const prev = item.lastRect;
    if (!force && prev && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h) return;
    item.lastRect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const s = item.ui.win.style;
    s.left = r.x + 'px';
    s.top = r.y + 'px';
    s.width = r.w + 'px';
    s.height = r.h + 'px';
    applyToolbarDock(item, r);
  }
  function renderZoom(item) {
    const f = item.ui.frame;
    f.style.width = (100 / item.zoom) + '%';
    f.style.height = (100 / item.zoom) + '%';
    f.style.transform = `scale(${item.zoom})`;
    item.ui.zoomLabel.textContent = Math.round(item.zoom * 100) + '%';
  }
  function renderTitle(item) {
    const title = item.title || item.fallbackTitle || '网页预览';
    const box = item.ui.title;
    const list = settings.favicon ? faviconCandidates(item.url) : [];
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
      if (w.closed) continue;
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
      win, header: $('.header'), title: $('.title'), content: $('.content'), frame: $('iframe'),
      shield: $('.shield'), loader: $('.loader'), hint: $('.hint'), hintText: $('.hint-text'),
      hintAct: $('.hint-act'),
      toolbar: $('.toolbar'), panel: $('.panel'), toast: $('.toast'), zoomLabel: $('.zoom-label'),
      themeBtn: $('[data-action="theme"]'), fdBtn: $('[data-action="forceDark"]'),
      pipBtn: $('[data-action="pip"]'), arrangeBtn: $('[data-action="arrange"]'),
      gridBtn: $('[data-action="grid"]'),
      progressBar: $('.progress-bar'),
      findBar: $('.findbar'), findInput: $('.fb-input'), findLabel: $('.fb-label'),
      findHint: $('.fb-hint'), findCase: $('.fb-case'), findWord: $('.fb-ww')
    };
    item.ui.findBar.hidden = true;   // 查找栏永远默认关闭
    // 空壳窗口（使用说明 / 设置）没有 iframe，而窗口外壳是透明的，必须补一层底色
    if (item.bare) win.classList.add('bare');
    // 强制暗色：v19.1 起设置里的全局开关决定新窗口的初始状态（此前是无任何效果的死设置）
    item.ui.fdBtn.classList.toggle('selected', !!item.forceDark);
    if (item.forceDark) applyForceDark(item);
    item.ui.gridBtn.hidden = windows.length < 2;
    win.__ldpItem = item;   // 便于扩展 / 调试时从 DOM 反查窗口记录
    shell.root.append(win);

    win.addEventListener('mousedown', () => focusWindow(item), true);
    win.addEventListener('click', event => {
      if (isEffPip(item)) { togglePip(item); return; }
      const arrow = event.target.closest('[data-step]');
      if (arrow) { stepNumber(item, arrow); return; }
      const btn = event.target.closest('[data-action]');
      if (btn) { handleAction(item, btn.dataset.action); return; }
      if (event.target.closest('.panel')) return;      // 面板内部点击不关闭面板
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

  function openWindow(value, fallbackTitle, parent, point, opts) {
    const o = opts || {};
    const bare = !!o.bare;                      // 空壳窗口：只用来放面板，不加载任何页面
    const url = bare ? '' : httpUrl(value);
    if (!bare && (!url || isBlacklisted(url))) return null;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', () => openWindow(value, fallbackTitle, parent, point, opts), { once: true });
      return null;
    }
    ensureShell();
    if (!shell) return null;
    finishGesture();
    if (launcher) launcher.hide();
    peekHide(true);   // v20：开完整预览的瞬间收起悬停小窗，两者不并存
    while (windows.length >= settings.maxWindows) {
      const oldest = windows.find(w => !w.pinned && !isEffPip(w)) || windows.find(w => !w.pinned);
      if (!oldest) break;
      closeWindow(oldest, true);
    }
    const key = bare ? '' : layoutKey(url);
    const saved = settings.remember && key ? layouts[key] : null;
    const item = {
      id: ++sequence,
      token: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      url, originalUrl: url, title: '', fallbackTitle: fallbackTitle || '', key,
      rect: fit(offsetRect(
        saved && saved.w ? saved.w : settings.desktopWidth,
        saved && saved.h ? saved.h : settings.desktopHeight,
        saved && Number.isFinite(saved.ox) ? saved.ox : undefined,
        saved && Number.isFinite(saved.oy) ? saved.oy : undefined
      )),
      zoom: clampNum(saved && saved.zoom, 0.5, 2, 1, false),
      // point 是触发坐标（拖拽 / 长按 / Alt+点击 / 浮出按钮都会带上），
      // 打开与关闭动画都以它为原点。（v20.2.1 起不再有「中键」这个来源）
      pinned: false, pip: false, inArrange: false, closed: false, ready: false,
      generation: 0, point, lastNested: null, lastFocus: document.activeElement,
      // v20.3：seenEarly = 骨架屏已经提前撤掉（子框架上报了 dcl）；initPings = 待发的 init 补发定时器
      seenEarly: false, initPings: [],
      isReaderMode: false, readerSource: null, readerDirty: false, readerMode: '', readerUrl: '',
      forceDark: !!settings.forceDark, bare, dockMode: '',
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
    if (!item || item.closed) return;
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
    if (item.readerUrl) { try { window.URL.revokeObjectURL(item.readerUrl); } catch (e) { /* 忽略 */ } item.readerUrl = ''; }
    if (item.synthUrl) { try { window.URL.revokeObjectURL(item.synthUrl); } catch (e) { /* 忽略 */ } item.synthUrl = ''; }
    const index = windows.indexOf(item);
    if (index >= 0) windows.splice(index, 1);
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
    if (windows.length) scheduleSessionSave();
    else flushSessionNow();
    if (!windows.length && !restoringSession) resumeBackgroundVideos();
    if (silent) {
      item.ui.win.remove();
    } else {
      const animation = animateWindow(item, false);
      const remove = () => item.ui.win.remove();
      if (animation) animation.finished.then(remove, remove);
      else remove();
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
        channel: CHANNEL, type: 'init', token: item.token,
        threshold: settings.threshold, longPressOpen: settings.longPressOpen,
        altClickOpen: settings.altClickOpen, longPressDelay: settings.longPressDelay,
        dragHold: settings.dragHold,
        // 把「界面玻璃磨砂」与「统一圆角」下发给子框架，让预览窗里的浮出按钮
        // 与宿主侧共用同一份玻璃配方与圆角（否则宿主关掉磨砂、窗内按钮还是磨砂的）
        glass: settings.glassBlur, radius: settings.radius,
        linkButton: settings.linkButton, dark: getEffectiveDark()
      }, '*');
    } catch (e) { /* 跨域 / 未就绪 */ }
  }
  function acceptInfo(item, data) {
    const url = httpUrl(data && data.url);
    if (!url) return false;
    if (item.url !== url) item.fallbackTitle = '';
    item.url = url;
    item.title = isStr(data.title) ? data.title.trim().slice(0, 500) : '';
    renderTitle(item);
    return true;
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
    if (item.closed || item.seenEarly || item.isReaderMode || item.bare) return;
    item.seenEarly = true;
    item.ui.loader.hidden = true;
    if (item.progressTimer) { clearTimeout(item.progressTimer); item.progressTimer = 0; }
    item.ui.progressBar.style.width = '88%';
  }
  function navigate(item, url) {
    item.generation++;
    item.ready = false;
    item.seenEarly = false;
    item.title = '';
    item.url = url;
    item.isReaderMode = false;
    item.readerSource = null;
    // v20：从快照回到正常嵌入 —— 恢复完整 sandbox（快照模式会临时收掉 allow-scripts /
    // allow-same-origin），并清掉旧的 blob
    if (item.synthetic) {
      item.synthetic = false;
      if (item.synthUrl) { try { window.URL.revokeObjectURL(item.synthUrl); } catch (e) { /* 忽略 */ } item.synthUrl = ''; }
      try { item.ui.frame.setAttribute('sandbox', FULL_SANDBOX); } catch (e) { /* 忽略 */ }
    }
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
        item.ui.frame.contentWindow.postMessage({ channel: CHANNEL, token: item.token, type: 'request', id, action: 'info' }, '*');
      } catch (e) {
        clearTimeout(timer);
        requests.delete(id);
        resolve(null);
      }
    });
  }
  function onFrameLoad(item) {
    if (item.closed || item.isReaderMode) return;
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
      maybeShowFirstRunHelp(item);
    });
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (!isObj(data) || data.channel !== CHANNEL) return;
    /* 同步滚动：预览窗口内部滚动 → 立刻按比例转发给其它预览窗口。
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
    if (data.type === 'open') {
      const url = httpUrl(data.url);
      if (!url) return;
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
    if (!item || item.closed || item.ui.panel.hidden) return;
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
    else showHistory(item);
    item.ui.panel.hidden = false;
    item.ui.shield.hidden = false;
  }
  /** 面板统一骨架：吸顶头（标题 + 关闭）+ 滚动体。返回滚动体，调用方只管往里塞内容。 */
  function panelFrame(item, title, closeAction) {
    const panel = item.ui.panel;
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
    ['pageTint', '窗口色调跟随网页', 'checkbox'],
    ['blur', '背景毛玻璃', 'checkbox'],
    ['blurAmount', '背景柔化强度(px)', 'number'],
    ['glassBlur', '界面玻璃磨砂(px)', 'number'],
    ['windowOpacity', '窗口不透明度%', 'number'],
    ['radius', '统一圆角(px)', 'number'],
    ['窗口行为'],
    ['spawnMode', '新窗口出现位置', 'select', [['default', '固定默认位置（不跟鼠标）'], ['cursor', '跟随指针 / 手势'], ['cascade', '依次错位铺开']]],
    ['toolbarSide', '工具条停靠', 'select', [['auto', '自动（贴边换边）'], ['left', '固定在左'], ['right', '固定在右'], ['inside', '窗口内（不遮正文）']]],
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
    ['peekVideo', '小窗内视频', 'select', [
      ['block', '实时页面 · 拒绝自动播放（推荐）'],
      ['snapshot', '静音快照（绝对无声）'],
      ['allow', '实时页面 · 不干预（交给页面）']
    ]],
    ['peekVideoNote', '小窗无法远程静音（跨域），标题条上的喇叭按钮可一键停声', 'note'],
    ['threshold', '拖拽阈值(px)', 'number'], ['dragHold', '拖拽按住时长(ms)', 'number'],
    ['warmup', '拖拽时预热链接', 'checkbox'],
    ['高级'],
    ['shortcutsMap', '快捷键设置', 'text', null, '组合=动作，逗号分隔'],
    ['autoFocus', '打开时自动聚焦窗口', 'checkbox'],
    ['favicon', '标题栏显示网站图标', 'checkbox'],
    ['showHelpOnce', '下次开窗再显示一次说明', 'checkbox'],
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
      const wide = name === 'shortcutsMap';
      return `<input type="text" data-setting="${name}" style="width:${wide ? 200 : 140}px;padding:5px;border:1px solid var(--border);border-radius:var(--r-chip);background:var(--surface);color:var(--text)" placeholder="${placeholder || '逗号分隔域名'}">`;
    }
    const [min, max, step] = RANGES[name] || [0, 9999, 1];
    return `<div class="number-control"><input type="number" min="${min}" max="${max}" step="${step}" data-setting="${name}"><div class="number-arrows"><button type="button" data-step="${step}" data-number="${name}" title="增加">▲</button><button type="button" data-step="${-step}" data-number="${name}" title="减少">▼</button></div></div>`;
  }
  function renderSettings(item) {
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
        if (w.closed || !w.ui) continue;
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
    const themeKeys = ['theme', 'themeSource', 'themeFollow', 'pageTint'];
    if (themeKeys.indexOf(name) >= 0) {
      invalidateThemeSample();
      if (name === 'theme' || name === 'themeFollow') syncThemeObserver();
    }
    // 需要下发给子框架的字段：触发参数 + 材质参数（玻璃磨砂 / 统一圆角）
    const bridgeKeys = ['threshold', 'longPressOpen', 'altClickOpen', 'longPressDelay',
      'dragHold', 'linkButton', 'glassBlur', 'radius', 'blurAmount'];
    applySettings(bridgeKeys.indexOf(name) >= 0);
    if (name === 'linkButton' && !settings.linkButton && launcher) launcher.hide();
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
    const item = openWindow('about:blank', '设置', null, null, { bare: true });
    if (!item) return;
    item.title = 'Link Preview 设置';
    renderTitle(item);
    openPanel(item, 'settings');
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
    const body = panelFrame(item, 'Link Preview 使用说明');
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
    switch (action) {
      case 'close':
        commitNumbers(item);
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
        const fw = frameWin(item);
        if (fw) { try { url = fw.location.href || url; } catch (e) { /* 跨域 */ } }
        toast(item, T.copy(url) ? '已复制网址' : '复制失败，请手动复制');
        break;
      }
      case 'plus':
      case 'minus':
      case 'resetZoom': {
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
        const gen = item.generation;
        requestInfo(item).then(result => {
          if (item.closed || item.generation !== gen) return;
          navigate(item, httpUrl(result && result.url) || item.originalUrl);
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
        const tabUrl = item.originalUrl || item.url;
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
        applySettings(true);
        layoutPips.fp = '';
        layoutPips();
        for (const w of windows) if (!w.closed && !w.ui.panel.hidden && w.panelMode === 'settings') renderSettings(w);
        toast(item, '已恢复默认');
        break;
    }
  }
  /** 强制暗色滤镜：阅读模式整篇重绘，普通页面直接给 iframe 上滤镜 */
  function applyForceDark(item) {
    if (item.isReaderMode && item.readerSource) { item.readerDirty = true; renderReaderMode(item); return; }
    try { item.ui.frame.style.filter = item.forceDark ? 'invert(1) hue-rotate(180deg)' : ''; } catch (e) { /* 忽略 */ }
  }

  /* ---- 快捷键 -------------------------------------------------------------------- */
  function topWindow() { return windows[windows.length - 1] || null; }
  function refreshShortcuts() { shortcutsMap = parseShortcuts(settings.shortcutsMap); }
  function runShortcut(action) {
    if (!action) return false;
    const it = topWindow();
    if (action === 'find') { if (!it) return false; toggleFindBar(it); return true; }
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
    try { root.querySelectorAll('a[href]').forEach(a => a.setAttribute('target', '_blank')); } catch (e) { /* 忽略 */ }
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
      if (he === 'content-security-policy' || he === 'refresh' || he === 'x-frame-options') m.remove();
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
          hint(item, '这个页面的内容由 JavaScript 生成，快照（已停用脚本）里只剩空壳。'
            + '想看原样请在新标签页打开。', HINT_OPEN_TAB);
        }
      },
      reason => {
        if (item.closed) return;
        snapshotFailed(item, reason === 'timeout'
          ? '抓取快照超时（20 秒没有响应）。'
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
    const fixSrc = node => {
      const raw = node.getAttribute('src');
      if (raw) { const abs = httpUrl(raw, base); if (abs) node.setAttribute('src', abs); }
      const set = node.getAttribute('srcset');
      if (set) {
        node.setAttribute('srcset', set.split(',').map(part => {
          const seg = part.trim().split(/\s+/);
          const abs = httpUrl(seg[0], base);
          if (abs) seg[0] = abs;
          return seg.join(' ');
        }).join(', '));
      }
    };
    for (const sel of ['img', 'source', 'video', 'audio', 'track', 'embed']) {
      try { doc.querySelectorAll(sel).forEach(fixSrc); } catch (e) { /* 忽略 */ }
    }
    doc.querySelectorAll('video[poster]').forEach(node => {
      const abs = httpUrl(node.getAttribute('poster'), base);
      if (abs) node.setAttribute('poster', abs);
    });
    // v20：补上「不是图片但同样会发请求」的那几类 —— 快照模式下外部样式表 / 内嵌框 /
    // 表单动作地址全靠这一步（阅读模式也用同一个函数，多覆盖几种只会有益无害）。
    const fixAttr = (sel, attr) => {
      try {
        doc.querySelectorAll(sel).forEach(node => {
          const raw = node.getAttribute(attr);
          if (!raw || raw.charAt(0) === '#' || /^(data:|blob:|javascript:|mailto:|tel:)/i.test(raw)) return;
          const abs = httpUrl(raw, base);
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
        const abs = httpUrl(raw, base);
        if (abs) node.setAttribute('href', abs);
      });
    } catch (e) { /* 忽略 */ }
    try {
      doc.querySelectorAll('[style*="url("]').forEach(node => {
        const css = node.getAttribute('style') || '';
        const next = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (whole, quote, raw) => {
          if (/^(data:|blob:|https?:)/i.test(raw)) return whole;
          const abs = httpUrl(raw, base);
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
      const built = readerBuild(item.readerSource, item.originalUrl, settings.readerHideImages);
      item.readerMode = built.mode;
      const html = built.mode === 'empty'
        ? '<p>没能从这个页面里抽出正文。已保留原始页面，可点“刷新”重试，或用“新标签页”直接打开。</p>'
        : built.html;
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
      const readerHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${item.originalUrl.replace(/"/g, '&quot;')}"><style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:${readerFont}px;line-height:${lineH};color:${readerText};max-width:${width}px;margin:0 auto;padding:40px 20px;background:${readerBg}}h1{font-size:1.6em;margin:0 0 .5em}h2,h3{margin-top:1.5em}p{margin:.8em 0}img{max-width:100%;height:auto;border-radius:8px;margin:16px auto;display:block}a{color:${linkColor};text-decoration:none}blockquote{border-left:3px solid ${borderColor};padding-left:16px;opacity:.8;margin:1em 0}pre{background:${codeBg};padding:14px;border-radius:8px;overflow-x:auto;font-size:.9em}table{border-collapse:collapse;width:100%}th,td{border:1px solid ${borderColor};padding:8px;text-align:left}hr{border:none;border-top:1px solid ${borderColor};margin:2em 0}${filter}</style></head><body><h1>${headTitle}</h1>${html}</body></html>`;
      if (item.readerUrl) { try { window.URL.revokeObjectURL(item.readerUrl); } catch (e) { /* 忽略 */ } }
      item.readerUrl = window.URL.createObjectURL(new window.Blob([readerHtml], { type: 'text/html' }));
      item.ui.frame.src = item.readerUrl;
      item.ui.loader.hidden = true;
      if (settings.phoneMode) {
        const v = viewport();
        const rw = Math.min(width + 20, v.w - 16);
        item.rect = fit({ x: (v.w - rw) / 2, y: 20, w: rw, h: v.h - 40 });
        renderGeometry(item, true);
      }
    } catch (e) {
      item.isReaderMode = false;
      item.ui.loader.hidden = true;
      toast(item, '阅读模式渲染失败');
    }
  }
  function toggleReaderMode(item) {
    if (item.isReaderMode) {
      item.isReaderMode = false;
      item.readerSource = null;
      item.readerDirty = false;
      if (item.preReaderRect) { item.rect = fit(item.preReaderRect); item.preReaderRect = null; renderGeometry(item, true); }
      navigate(item, item.originalUrl);
      toast(item, '已退出阅读模式');
      return;
    }
    item.preReaderRect = Object.assign({}, item.rect);
    item.ui.loader.hidden = false;
    toast(item, '正在提取正文...');
    fetchPageText(item.originalUrl,
      text => {
        if (item.closed) return;
        item.readerSource = text || '';
        item.isReaderMode = true;
        item.readerDirty = true;
        renderReaderMode(item);
        const modeName = item.readerMode === 'density' ? '密度抽取' : (item.readerMode === 'fallback' ? '兜底提取' : '');
        toast(item, item.readerSource ? ('已进入阅读模式' + (modeName ? '（' + modeName + '）' : '')) : '正文为空');
      },
      () => {
        if (item.closed) return;
        item.ui.loader.hidden = true;
        item.preReaderRect = null;
        toast(item, '请求失败：该页面可能禁止外部抓取');
      });
  }
  /** 阅读排版（字号 / 行高）：同源时直接改样式，改不动就整篇重绘兜底 */
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
      pinned: !!w.pinned, pip: !!w.pip, forceDark: !!w.forceDark, inArrange: !!w.inArrange
    }));
  }
  function rememberSession() {
    if (!settings.sessionMemory) return 0;
    // 恢复会话时会先把窗口全关掉，那一瞬间 windows 为空会被误判成「用户主动关完了」
    // 从而删掉这个站点刚保存的记录 —— 恢复期间一律不写。
    if (restoringSession) return 0;
    // 会话键走 layoutKey()（与布局记忆同一套分区逻辑），不再写死 location.origin，
    // 否则某个子页面留下的组合会在站点任意页面自动弹出来 —— 用户感知就是「记忆错乱」。
    const key = sessionKey();
    const list = windows.length ? collectWindows() : [];
    if (!list.length) {
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
  function flushSessionNow() {
    if (idleHandle) { try { window.cancelIdleCallback(idleHandle); } catch (e) { /* 忽略 */ } idleHandle = 0; }
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = 0; }
    if (!settings.sessionMemory || restoringSession) return;
    rememberSession();
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
    if (windows.length) {
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
    } finally { restoringSession = false; }
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
    const item = openWindow(rec.url, rec.title || '');
    if (!item) return null;
    if (rec.rect && Number.isFinite(rec.rect.x)) {
      item.rect = fit(rec.rect);
      item.lastRect = null;
      renderGeometry(item, true);
    }
    if (rec.zoom && rec.zoom !== item.zoom) { item.zoom = clampNum(rec.zoom, 0.5, 2, 1, false); renderZoom(item); }
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
  function pageInteractionAllowed(event) {
    return !gesture && !targetInHost(event, shell && shell.host)
      && !windows.some(w => !w.pinned && !isEffPip(w));
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
    if (!settings.hoverPeek || !link.element.isConnected) return;
    // 手势进行中 / 存在模态预览时绝不弹（backdrop 已经盖住了页面，这时弹出只会突兀）
    if (gesture || windows.some(w => !w.pinned && !isEffPip(w))) return;
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
    if (!settings.hoverPeek) { peekLeave(); return; }
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
    // 换了链接：旧小窗若无其事地淡出，新链接重新等阈值
    clearTimeout(peekTimer);
    if (peekEl && !peekEl.hidden && peekLink && peekLink.element !== link.element) peekScheduleHide(140);
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
      peekWarmTimer = 0;
      warmLink(peekWarmUrl);
      if (peekKind() === 'snapshot') peekSnapFetch(peekWarmUrl, null);
    }, PEEK_WARM_MS);
  }
  /** mouseover 离开链接：取消等待中的阈值，已显示的给一点宽限再收 */
  function peekLeave() {
    clearTimeout(peekTimer); peekTimer = 0;
    peekPending = null;
    clearTimeout(peekWarmTimer); peekWarmTimer = 0;
    if (peekEl && !peekEl.hidden) peekScheduleHide(200);
  }

  installLinkDrag(pageInteractionAllowed,
    (link, event) => {
      markPreviewed(link.url);
      openWindow(link.url, link.title, null, { x: event.clientX, y: event.clientY });
    },
    () => settings.threshold, () => settings.longPressDelay, () => settings.dragHold, settings,
    // v20.2.3：stage === 'press' 时只建连接，绝不下载整页（详见 warmLink 的说明）
    (link, stage) => warmLink(link.url, stage));

  launcher = installLauncher({
    isEnabled: () => settings.linkButton,
    // 旧版这里传的是 { clientX, clientY }，而 openWindow 读 point.x / point.y，
    // 于是点浮出按钮开出来的窗口永远落在「默认位置」而不是指针处
    onLaunch: (link, p) => {
      markPreviewed(link.url);
      return openWindow(link.url, link.title, null, {
        x: p && Number.isFinite(p.x) ? p.x : undefined,
        y: p && Number.isFinite(p.y) ? p.y : undefined
      });
    },
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
    if (!dt) return false;
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
    if (!hasUrlPayload(event.dataTransfer)) return;
    dropDepth++;
    showDropOverlay(true);
    armDragWatchdog();
    event.preventDefault();
  }, true);
  window.addEventListener('dragover', event => {
    if (!hasUrlPayload(event.dataTransfer)) return;
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
    if (!settings.shortcuts) return;
    if (event.isComposing || event.keyCode === 229) return;
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
    const raw = event.target;
    const node = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null;
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
        if (settings.linkButton || settings.hoverPeek) scheduleShellWarm();
        // v20：浮出按钮与悬停迷你预览共用同一次 mouseover 判定 —— 两者互不干扰，
        // 各自有独立开关（linkButton / hoverPeek）。
        if (settings.linkButton) launcher.handleEnter(link, event.clientX, event.clientY);
        peekHover(link);
        return;
      }
    }
    if (!settings.linkButton) { if (launcher.isShowing()) launcher.hide(); }
    else launcher.handleLeave();
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
    if (event.key === 'Tab' && windows.length > 1 && !event.defaultPrevented && !fromUI && !isEditingInPage()) {
      const idx = windows.findIndex(w => w.ui.win.classList.contains('active'));
      const next = event.shiftKey ? (idx <= 0 ? windows.length - 1 : idx - 1) : (idx >= windows.length - 1 ? 0 : idx + 1);
      event.preventDefault();
      focusWindow(windows[next]);
    }
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
      else for (const item of windows) if (!item.pip) renderGeometry(item, true);
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
    for (const item of windows) if (!item.closed && !item.ui.panel.hidden) closePanel(item, true);
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
})(); 