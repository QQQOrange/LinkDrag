# LinkDrag — 缺陷核查与修复记录（v1.0）

本文件记录把 v20.3.0 油猴脚本移植为 Chromium MV3 扩展时，实际核查出的缺陷、修法与验证方式。只列能影响功能/数据/安全的问题，不把纯文案和样式偏好算作缺陷。

## 一、移植层缺陷

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `T.openInTab` | 原实现只派发一个 `ldp-open-tab` 事件，扩展环境没有监听者，`T.openInTab` 实际会落到 `a.click()`；沙箱/CSP 页面可能被拦截 | 改为 `chrome.runtime.sendMessage({type:'ldp:openTab'})`，由后台 `chrome.tabs.create` 打开；保留 GM / anchor 兜底 |
| 2 | `migrateLegacy` | 扩展里没有 `GM_getValue`，函数直接引用会抛 `ReferenceError`（被 catch 吞掉，但启动路径不干净） | 扩展环境直接跳过 GM 旧键迁移 |
| 3 | `fetchPageText` | 依赖 `GM_xmlhttpRequest`，油猴环境外不可用 | 新增 Service Worker `ldp:fetch`：跨域 fetch、真实状态码、最终重定向地址、20s 超时、12MB 上限、编码嗅探 |
| 4 | `storage` 初始化 | `chrome.storage.local.get` 失败时 `extReady` 永远为 false，后续 `whenStoreReady` 不执行 | 无论成功/失败/空对象都调用 `onExtStoreReady()`，并读取 `chrome.runtime.lastError` |
| 5 | 工具栏/弹窗消息 | `tabs.sendMessage` 不指定 frameId 时可能由子框架应答，状态显示成 iframe 的 host | 所有顶层操作显式 `frameId: 0`（右键菜单按点击 frame 发） |
| 6 | 右键菜单重建 | `onInstalled`、`onStartup`、worker 唤醒、storage 变化可能并发 `removeAll/create`，互相把菜单清空 | 串行化重建队列 `scheduleMenuRebuild()`；只在 `contextMenu` 变化时重建 |
| 7 | 关闭动画 | 隐藏标签页里 WAAPI `animation.finished` 可能长时间不 resolve，关闭窗口的 DOM 会以 `pointer-events:none` 幽灵层残留 | 动画 `.finished` 之外加 `closeDuration + 180ms` 定时兜底；`removed` 幂等 |

## 二、预览核心缺陷（原脚本继承）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 8 | `acceptInfo` / `navigate` / reader / snapshot | 预览 iframe 内跳转后 `item.url` 更新但 `originalUrl` 仍是打开时的地址；阅读模式、快照、刷新、新标签页会操作旧页面 | `acceptInfo` 同步 `originalUrl`；新增 `currentPageUrl()`，上述路径全部改用它 |
| 9 | 悬停小窗 `peekHover` | 从链接 A 移到链接 B 时，旧窗口的 `peekScheduleHide(140)` 在 140ms 后调用 `peekHide()`，把 B 刚设的 `peekTimer/peekPending` 清掉，B 永远不弹 | 切换链接时立即 `peekHide(true)` 再为 B 重设定时器 |
| 10 | 悬停预热 `peekArmWarm` | 移出链接时清掉预热定时器但没清 `peekWarmUrl`；再次移回同一链接命中去重早退，预热永久失效 | 移出/收起时重置 `peekWarmUrl`，并捕获定时器触发时的 URL |
| 11 | `openWindow` / `maxWindows` | 设置、帮助等 bare 窗口也占用 `maxWindows`，打开设置会静默挤掉真实预览 | maxWindows 只统计非 bare 窗口 |
| 12 | 快照空壳检测 | 只有 2 段正文的短页面（例如 XFO 测试页）文本长度 <200 且无图片，被误判为「JS 生成的空壳」 | 增加结构证据：`article/main/h1-p/pre/blockquote` ≥2 个且文本 ≥40 字时不算空壳；提示文案改成同时承认 SPA 与短页面 |
| 13 | 快照 `<meta>` 清洗 | 只移除 CSP、refresh、x-frame-options，漏掉 `content-security-policy-report-only` | 一并移除 |
| 14 | 强制暗色 | 对图片窗口也会走 `applyForceDark`，虽不可见但状态不一致；图片窗口的按钮还会被主题刷新重新显示 | 图片窗口跳过 forceDark；`updateThemeButtons` 对 imageMode 强制隐藏该按钮 |
| 15 | 图片窗口缩放恢复 | `openWindow` 初始 zoom 用 0.5–2 范围，图片布局保存的 3x/5x 会被夹成 2x | 图片窗口使用 0.1–8 范围恢复 |
| 16 | `findLink` 图片链接 | 新图片手势启用后，图片外层的 `<a>` 仍可能被旧链接手势先打开成网页预览 | 图片路径优先；图片预览开关关闭时恢复普通链接行为 |
| 17 | 子框架图片 | 预览 iframe 内拖拽图片没有顶层入口，`open` 消息只处理普通链接 | 子框架新增 `openImage` 消息（带 token/source 校验），顶层构造嵌套图片窗口；实测通过 |
| 18 | 图片拖动取消 | 图片预览的 pointerdown 里 `preventDefault()` 会抑制双击（适应窗口 / 1:1） | 移除 pointerdown 的 preventDefault，图片本身 `draggable=false` |

## 三、独立审查补修（第二轮）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 19 | `openWindow` / `saveLayout` | 图片窗口与网页窗口共用 `layoutKey(origin)`，图片窗口的 0.1–8 缩放和几何会覆盖同站点网页窗口布局；网页恢复又把 zoom 夹到 2 | 图片窗口 layout key 使用 `image:` 前缀，彻底分开布局槽位 |
| 20 | `window.message` 监听 | `innerScroll` / `sync` / `stage` / `ldpSelect` 在 token 校验前处理，任意页面脚本可伪造滚动、提前撤骨架屏，`ldpSelect` 甚至能打开任意 URL | 所有 token-bearing 消息先按 `event.source` 找到唯一 item 并校验 token；删除无发送方的 `ldpSelect`；`open/openImage` 加 8 次/10 秒限流 |
| 21 | 图片双击 1:1 | `Math.max(actual, 2)` 强制至少 2 倍，fit=0.6 时实际显示 120%，与文案“1:1”不符 | 直接 `clamp(1/fit, 0.1, 8)`；实测 38% → 100%，图片宽 1600px |
| 22 | `restoreSession` | 先关闭旧窗口、后设置 `restoringSession`，最后一个 close 会把当前会话标记 closed、清空 tab mark；恢复全失败时会话丢失 | 关闭旧窗口移入 `restoringSession=true` 的 try/finally 内 |
| 23 | 含图链接 hover | 任意 `img` 都让 hover 小窗/浮出按钮失效，16px 图标也中招；损坏大图又可能让链接/图片两边都不触发 | 统一用 `imageElementAtEvent` + `imageInfoFromElement` 判定；渲染尺寸 <48×48 的图标不抢占链接手势 |
| 24 | `runShortcut` | 图片窗口的快捷键缩放仍用网页 0.5–2 范围，会把 4× 图片压回 2× | 按 `imageMode` 分支使用 0.25 步进、0.1–8 范围与 `renderImageZoom` |
| 25 | 图片加载 | 候选多时最坏可等 12×25s，长时间空白 | 加 45 秒总截止时间，单候选超时随剩余时间收缩 |
| 26 | 图片重载 | 同一 URL 再次赋值 `src` 可能不触发 load，重载后一直转圈 | 重载前清空旧 `src`/事件，再重新导航 |
| 27 | 图片窗口不透明度 | `windowOpacity` 只作用于 iframe，图片窗口不跟随；且内容底色挡住背景 | image-viewer 也套 `--win-mask` / `--win-opacity`，content 改透明 |
| 28 | 图片查找快捷键 | `Alt+Shift+F` 在图片窗口仍打开查找栏 | `runShortcut('find')` 对 imageMode 早退 |
| 29 | 页面内拖拽 / drop | 慢速拖拽超过原 1.5 秒去重窗口后，手势已开一个窗口，drop 又开一个，用户看到两个相同预览 | 用 mousedown 建立拖拽序列时间点，dragstart 标记 `dragging`；drop 检测到本次序列已由 `openWindow` 开过窗口就阻止默认行为并跳过。实测手势 + drop、原生 dragstart + drop、图片 + drop 均只 1 个窗口 |
| 30 | 首次使用说明 | 每个页面/预览首次打开自动弹完整使用说明，安装后还会自动打开欢迎页，用户不需要 | 删除预览自动调用与安装欢迎页；默认 `showHelpOnce=false`，从工具栏「?」手动打开说明，设置页移除旧开关 |
| 31 | 自动主题 | 页面暗色但窗口仍亮色；页面切换明暗后 UI 不更新 | 打开预览时强制重新采样页面底色；MutationObserver 的防抖回调改同步 `renderTheme(true)`，不再依赖可能被后台节流的 rAF。实测页面 #101214 → 窗口 `data-theme=dark`、`--bg=rgb(16,18,20)`；切回 #f7f7f7 → light |
| 32 | 窗口 UI | 旧版侧边竖条工具、米色边框、图标对比低；不同窗口类型视觉不统一 | 重做窗口 chrome：品牌+域名胶囊标题栏、窗口左侧外挂命令轨道、磨砂玻璃层次、统一 30px 图标按钮、现代圆角/阴影；图片 fit 改为读取实际 stage 尺寸 |
| 33 | 工具条贴边 | 命令轨道完全贴在窗口左边缘，视觉拥挤 | 外挂轨道与窗口留 15px 间距；窗口靠近屏幕左侧时自动向右让位，保证轨道可见 |
| 34 | 设置面板 | 设置窗口是一条很长的表单，原生控件密集、层级不清楚 | 改为左侧分类导航 + 分组内容；开关使用现代 pill switch，下拉/输入/数字控件统一风格，操作与诊断独立分组 |

## 四、已验证与保留项

- v20.0.1 的 `adoptStyles` 修复保留：同一 shadow root 上窗口 CSS 与浮出按钮 CSS 用「key → sheet」映射，不再互相剔除。
- 中键监听保持删除：`auxclick` 不注册，中键回到浏览器原生「后台新标签页」。
- 悬停小窗收起必定 `peekStopFrame()`，媒体随 iframe 文档销毁。
- 快照只读 sandbox 不含 `allow-scripts` / `allow-same-origin`；图片/阅读模式抓取都走后台，不依赖页面 CORS。
- 阅读模式抓取现在检查 HTTP 状态码，4xx 不再被当成正文重排。

## 五、自动化验证结果（Edge 156.0.4314.58，headless + CDP）

| 场景 | 结果 |
|---|---|
| 普通链接拖拽打开 iframe 预览 | 通过（`second.html`，标题正确，无异常） |
| 拖拽去重（手势 + drop / 慢拖 / 图片） | 通过：每个场景窗口数均为 1，不再出现两个相同预览 |
| 外部 URL 拖入页面 | 通过：仍正常打开 1 个预览 |
| 首次使用说明 | 通过：预览打开时 `.panel` 保持隐藏，不再自动弹说明 |
| 自动主题跟随 | 通过：暗色 #101214 → `data-theme=dark`；切回 #f7f7f7 → light |
| 现代化窗口 UI | 通过：标题栏品牌/域名、左侧命令轨道、图片 1:1/适应、设置面板布局均正常 |
| 现代化设置面板 | 通过：10 个分类导航、switch/select/number 控件、选项卡切换和即时保存正常 |
| 设置内 AI 接口 | 通过：默认 DeepSeek 地址/模型、仅填写 API Key 保存；AI 面板提示与 mock 接口调用正常 |
| AI 多服务商与模型 | 通过：DeepSeek / 硅基流动 / 通义千问 / Kimi / OpenAI / Ollama 预设；填写 Key 后可拉取云端模型列表 |
| AI 流式输出 | 通过：mock SSE 分块返回，界面逐字显示、光标动画、生成中计时，完成后显示用时与模型 |
| AI 连接测试 | 通过：设置页「测试连接」返回成功、耗时和模型；失败时显示接口错误 |
| 模型搜索与切换 | 通过：拉取模型后设置页/选项页出现搜索框；AI 面板模型选择器可覆盖本次请求模型 |
| 模型列表显示 | 通过：拉取后显示模型胶囊列表，搜索框过滤列表；AI 页面助手立即显示拉取到的模型 |
| AI 提示词/Markdown | 通过：总结提示词可编辑并持久化；mock Markdown 输出渲染为标题/列表/代码/链接，无原始符号 |
| AI 输出空间 | 通过：AI 面板 640px，回答区域完整展开显示，不出现内部折叠滚动条 |
| AI 模型记忆 | 通过：选择 mock-model-b 后关闭并重开 AI 页面助手，默认仍为 mock-model-b |
| 模型选择器 UI | 通过：浏览器原生 select 已替换为自定义模型弹层，带搜索，无灰色系统列表 |
| 厂商菜单交互 | 通过：AI 面板/设置页厂商菜单点击空白处自动折叠，选择厂商后自动收起；胶囊不显示「切换服务商」 |
| 快捷 AI 按钮 | 通过：链接旁出现 AI 按钮，点击后自动打开预览、抓取正文并生成 Markdown 总结 |
| 快捷 AI 白/黑名单 | 通过：设置 → 快捷 AI 可开关按钮并配置当前页面域名白名单/黑名单 |
| 域名列表编辑 | 通过：粘贴 `https://sub.example.com/path` 自动提取 `sub.example.com`；列表内可改为 `new.example.com`，× 可删除并写入设置 |
| 视频一键总结 | 通过：本地 `<video>` + `captions.vtt` 的「AI 总结」按钮出现；点击后读取字幕并用 mock AI 生成 Markdown 总结 |
| 视频字幕来源 | 通过：支持 HTML5 track / YouTube / Bilibili / 页面字幕区域的字幕优先提取；无字幕时给出明确提示 |
| 音视频 API | 通过：mock 媒体接口收到 `video_url` content，返回 Markdown；媒体总结面板显示完成状态 |
| 侧边栏同步 | 通过：媒体总结结果写入 `LPS_SIDE_PANEL`，侧边栏可读取 |
| 抖音 Blob 提取 | 通过：页面 `RENDER_DATA` / `_ROUTER_DATA` / `play_addr.url_list` / performance 资源回退提取真实媒体地址 |
| 当前页总结弹层 | 通过：当前页总结只打开一个裸总结窗口，不额外加载预览页面 |
| 紧凑总结窗口 | 通过：窗口尺寸与总结面板一致（约 680×420），无外层大空白窗口 |
| 总结框贴边 | 通过：默认右侧贴边；设置可切换左侧；透明度 40–100%；标题栏可拖动 |
| 总结加载进度 | 通过：点击后先显示顶部进度卡，完成后才显示总结窗口 |
| 总结背景不模糊 | 通过：加载与展示阶段 backdrop 为透明且无 blur |
| 总结耗时 | 通过：完成状态显示总耗时（最小显示 0.1 秒） |
| 媒体提取回退 | 通过：无字幕视频自动走音频/视频链路；On-demand MAIN hook + performance 回退捕获真实 URL |
| YouTube/B站字幕 | 通过：字幕轨道解析、请求超时和页面字幕回退；YouTube 播放器响应使用平衡括号解析 |
| 长音频兜底 | 通过：Qwen 500/50507 时自动 ASR 转写再总结 |
| 设置页直开 | 通过：全屏独立设置页，无空预览小窗；滚轮不关闭 |
| 设置高对比度 | 通过：设置页固定中性浅色高对比度配色 |
| API Key 测试 | 通过：普通 API Key / 媒体 API Key 各有独立测试按钮 |
| 媒体模型 | 通过：媒体总结模型独立配置并传递到后台 |
| 链接文本 AI | 通过：链接 AI 直接打开左右侧长条 AI 总结窗，不加载预览 iframe |
| B站/YouTube 字幕 | 通过：页面上下文 Cookie 优先，B站分P cid 支持 |
| 抖音分享解析 | 通过：短链→iesdouyin→_ROUTER_DATA→play_addr，playwm→play |
| ASR 上传 | 通过：multipart file + SenseVoiceSmall，返回 text |
| 媒体接口迁移 | 通过：默认/旧配置迁移到 `/v1/audio/transcriptions` |
| 字幕优先 | 通过：任意含视频页面先探测字幕，无字幕才媒体链路 |
| 媒体模型搜索 | 通过：拉取媒体模型后支持搜索选择 |
| ASR Key 实测 | 通过：测试按钮真实 multipart 上传静音 WAV 到 ASR 端点 |
| 字幕总结容错 | 通过：流式端口断开后自动走非流式请求 |
| B站字幕回退 | 通过：wbi/v2、player/v2、dm/view 三层接口 |
| B站长音频 | 通过：最低码率音轨 + 5 分钟 WAV 分段 ASR（本地 mock） |
| 版本号 | 通过：Manifest / 设置面板 / 选项页统一显示 v1.8.3 |
| 页面点击不取消 | 通过：总结期间 backdrop pointer-events:none |
| 字号/透明度 | 通过：窗口内滑杆/A±与设置持久化 |
| 本地视频转音频 | 通过：WAV 音轨视频先本地解码为 WAV，再发送音频链路；失败回退视频 |
| 视频总结提示词 | 通过：默认模板改为专业视频分析师结构（概括/概要/要点/结论/观看价值） |
| 版本号 | 通过：Manifest / 设置面板 / 选项页统一显示 v1.7.2 |
| 阅读进度条 | 通过：阅读 iframe 内固定进度条存在，随滚动使用 scroll-driven 进度 |
| 阅读模式增强 | 通过：文章目录生成、导出面板、正文读取；阅读工具按模式显隐 |
| AI 页面助手 | 通过：无配置时给出配置提示；本地 mock OpenAI 接口返回 `MOCK_AI_OK`，面板正常显示 |
| 图片拖拽选择高清候选 | 通过：`src=full.png`，`naturalWidth=1600`，不是 320px thumb |
| 图片窗口关闭后 DOM 回收 | 通过：隐藏标签页下也在兜底计时后移除，不残留幽灵层 |
| 图片双击 1:1 | 通过：38% → 100%，图片实际宽度 1600px |
| 图片重载（同一 URL） | 通过：重载后仍为 1600px，loader 正常收起 |
| 图片/网页布局 key 隔离 | 通过：网页 150% → 图片 147% → 重开网页仍 150% |
| 含图链接（16px 图标）hover | 通过：浮出按钮正常出现，没有被图片判定吞掉 |
| 图片容器为 `<a>` 拖拽（事件目标重定向） | 通过：按指针位置找到内部 img，仍选 full.png |
| 预览 iframe 内图片拖拽 | 通过：顶层出现嵌套 `image-mode` 窗口，`img=full.png` |
| 阅读模式后台抓取 | 通过：`blob:` iframe，正文/标题正确，无异常 |
| X-Frame-Options: DENY 快照 | 通过：`blob:` 快照；结构检测不误报空壳 |
| 工具栏弹窗读取状态 | 通过：host、运行中、预览数、图片开关正确，无异常 |
| 扩展重载后旧标签页补注入 | 通过：`chrome.scripting.executeScript` 后 `ldp:ping` 正常应答 |
| 站点暂停/恢复 | 通过：状态变「本站已暂停」、预览数归零；再点恢复「运行中」 |
| 选项页 | 通过：版本、开关、存储占用、按钮样式正常，无异常 |
| Service Worker | 版本 21.0.0，无未捕获异常 |

## 六、仍需注意的边界

- 受保护页面无法注入，这是浏览器限制，不应视为 bug。
- 图片服务器热链保护可能让所有候选都 403；会显示失败提示，可新标签页打开。
- 浏览器第三方 Cookie 政策可能让部分登录态抓取失败；失败有状态码/原因提示。
- 真正「无限嵌套」受浏览器 iframe 层级与站点 frame 策略约束；扩展已支持预览 iframe 内的一层嵌套图片/链接，但不可能绕过站点拒绝嵌入。

## 七、v1.9.42 复审补修

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `content.js` 主 UI | 页面可读取 open shadow root 中的 AI/媒体 API Key，并可改写 endpoint | 改 closed shadow root；已保存 Key 不写入页面 DOM；页面内设置留空表示保留，换 Key 到选项页 |
| 2 | `content.js` 阅读/快照 | 阅读正文仍是可执行同源沙箱；快照保留音视频/表单/内嵌框架 | 阅读改用无脚本源沙箱；快照移除可交互元素并去掉 `allow-forms` |
| 3 | `content.js` 异步抓取 | 慢速快照/正文回调覆盖已跳转的窗口 | 用 `generation`/URL 双重校验丢弃过期响应 |
| 4 | `content.js` 会话 | 只打开设置/说明（bare）会被当成「关闭全部预览」 | 只有真实预览窗口关闭（forceClosed）或本标签页曾拥有预览时才写 closed |
| 5 | `content.js` 窗口上限 | 全部固定时仍继续 push，窗口可超过 maxWindows | 上限只统计非 bare 预览；无可回收候选时拒绝并提示 |
| 6 | `content.js` 导入/默认 | 导入 `enabled:false`、恢复默认后未统一应用设置/快捷键/主题 | 统一调用 `applyPageEnableState`、`refreshShortcuts`、`syncThemeObserver` |
| 7 | `content.js` 媒体 | 44.1/48 kHz 音频二次换算，长音频后续分段加速/静音 | 统一按输出 16 kHz 时间轴换算；新增 `test/audio_resample.test.js` |
| 8 | `content.js` / `offscreen.js` | 取消后仍在跑；流式端口/watchdog 回退不释放；retry 先断端口再因 busy 返回 | 统一释放端口、先判 busy、取消时停端口并恢复 UI |
| 9 | `content.js` / `background.js` | B 站多 P 音频只取第一 P；YouTube cipher-only URL 必 403 | 统一解析 `?p=` 的 cid；无签名解密能力时明确拒绝 cipher-only 音频 |
| 10 | `content.js` / hooks | 页面可伪造媒体 URL 触发带 Cookie 抓取；fetch 包装复制大响应 | 拒绝 localhost/私网媒体候选；fetch/XHR 仅扫描小体积文本响应；Douyin 用 PerformanceObserver |
| 11 | `background.js` / DNR | 全局改写 Origin/Referer，破坏第三方 CORS/CSRF 边界 | 只保留媒体 CDN 的 Referer；移除 Origin 和 douyin 主站规则，文档同步 |
| 12 | 构建链 | `build_content.py` 字符串补丁锚点漂移，已无法重建当前 content.js | 改为单一维护源 `src/extension.content.js` + manifest 版本占位符；旧构建器归档 `tools/legacy/` |

## 八、v1.9.43 交互与字幕补修

| 位置 | 改动 | 验证 |
|---|---|---|
| 视频总结 / 音视频总结 | 新增「下载字幕 SRT」按钮；有真实字幕时保留 VTT/SRT/YouTube/Bilibili 时间轴，ASR/纯文本按媒体时长生成连续估计时间轴 | `test/srt.test.js` 4/4；无头 Edge 实际下载 `视频总结测试.srt`，时间轴与 5 条 VTT 字幕一致 |
| 总结窗口 CSS | 增加渐变强调条、品牌图标、来源卡片、内容卡片、渐变进度条、吸底操作栏；默认宽度从 34% 提升到 38% | 无头 Edge 截图检查，视频/媒体窗口布局正常，无控制台异常 |
| `media_hook.js` | Bilibili 字幕结果携带 `from`/`to` cue 时间轴 | 静态语法检查通过；字幕链路保留时间轴 |
| `media_hook.js` / `content.js` | 字幕按钮在无转写、文本降级、取消/重试时自动隐藏；下载文件名使用标题并清理非法字符 | 点击实际触发下载，toast「字幕 SRT 已开始下载」 |

## 九、v1.9.44 媒体链路修复

| 位置 | 改动 | 验证 |
|---|---|---|
| `mediaUrlKind` / 媒体候选 | 先读取 URL 的 `mime`/`mime_type`，避免 YouTube/DASH 的音频 `.m4s` 被当成视频；同名候选会从视频改成音频 | `test/media_url_kind.test.js` 3/3 |
| `downloadMediaVideo` | 下载前用 `<video preload="metadata">` 探测 `videoWidth/videoHeight`，确认有画面；没有画面时不下载并给出提示 | 纯音频测试页「下载视频」保持隐藏；代码路径静态检查通过 |
| `startMediaSummary` | 视频优先直接解码音轨；失败后用 `captureStreamAudio` 只捕获音频轨，再转 WAV/ASR；仍失败则停止，原始视频不会进入任何模型 | 媒体总结无未捕获异常；音频页实际生成 2 条 SRT；视频字幕页实际生成 5 条 SRT |
| `ensureSummaryAppearanceCSS` | 样式表原先挂在 `document.head`，无法穿透 closed shadow root，导致 A−/A+ 使用浏览器原生按钮颜色；改为挂到 shadow root | 样式作用域修正，按钮使用 `var(--surface)`/`var(--text)`，随主题切换 |

## 十、v1.9.45 抖音、滚动与视频下载补修

| 位置 | 改动 | 验证 |
|---|---|---|
| `douyin_hook.js` / `douyinPageDataUrls` | 收集 `play_addr`、`play_addr_h264`、`play_addr_h265`、`play_addr_bytevc1`、`bit_rate[].play_addr` 及 `music.play_url` 的字符串/对象形式 | `test/douyin_urls.test.js` 3/3 |
| `startMediaSummary` | Douyin 优先真实视频候选，不再让 `music.play_url` 背景音乐优先；详情解析失败时先从页面数据找视频地址 | 静态检查通过；候选选择测试通过 |
| `captureStreamAudio` / `captureMediaElementAudio` | `captureStream` 无音轨时增加 `createMediaElementSource` 音频节点捕获，覆盖 Blob/MediaSource | 代码路径通过；无未捕获异常 |
| `downloadMediaVideo` | Blob/MediaSource 使用 MediaRecorder 录制实际画面并下载 WebM；纯音频候选仍被拦截 | Blob 视频实测下载原 MP4（788,493 bytes）；纯音频流提示阻止下载 |
| 总结窗口 CSS/DOM | `.summary-scroll` 作为唯一滚动容器，底部操作栏移到滚动区外；答案卡片不设内部滚动/最大高度 | 长文本实测：`scrollHeight=2340`、`clientHeight=627`，滚到底部 `actionOverlap=false`，无第二滚动条 |

## 十一、v1.9.46 当前视频与主题补修

| 位置 | 改动 | 验证 |
|---|---|---|
| `videoActivityScore` / `selectMediaCandidate` | 抖音按播放中、可见、有画面的 `<video>` 选择当前候选，避免页面预加载的其他视频或背景音乐被当成当前视频 | `test/douyin_urls.test.js` 3/3 |
| `startMediaSummary` | 抖音存在活动视频时优先使用播放器，跳过可能过期的详情 URL；无活动播放器才使用页面数据 | 静态路径检查通过 |
| `refreshVideoAITheme` / `SUMMARY_LOADING_CSS` | AI 浮出按钮、进度卡片统一使用同一套自动主题：页面底色为主、系统偏好为辅；页面浅色即使系统夜间也保持日间，页面深色即使系统日间也保持夜间 | 无头 Edge：显式 light 下按钮 `rgb(255,255,255)`、进度卡片 `rgba(247,248,251,.97)`；显式 dark 下按钮 `rgb(32,36,44)` |
| `downloadMediaVideo` | 抖音候选按活动视频排序，避免下载到另一条推荐视频 | 候选排序逻辑与静态检查通过 |
| `summary-scroll` CSS | 强制 `panel-body` 为 flex、唯一滚动区，答案卡片 `flex:0 0 auto`、`overflow:visible` | 长文本实测 `scrollHeight=2340`、`clientHeight=585`，滚到底部无遮挡；只有内容区滚动条 |

## 十二、v1.9.47 页面感知自动主题

| 位置 | 改动 | 验证 |
|---|---|---|
| `overlayThemeDark` / `getEffectiveDark` | 自动模式同时使用页面真实底色、页面亮暗声明和系统偏好；页面证据权重更高。页面亮时即使系统夜间也走日间 UI，页面暗时即使系统日间也走夜间 UI | 亮色页实测 AI 按钮 `rgb(255,255,255)`、进度卡片 `rgba(247,248,251,.97)`；暗色设置实测按钮 `rgb(32,36,44)` |
| `refreshVideoAITheme` / `SUMMARY_LOADING_CSS` | AI 按钮、加载卡片、进度条统一主题来源，并为按钮补齐 hover 用的 `--surface`/`--accent`/`--border` 变量 | 无头 Edge 实测按钮与进度卡片同主题，无控制台异常 |
## 十三、v1.9.48 推荐流刷新补修

| 位置 | 改动 | 验证 |
|---|---|---|
| `videoAI` 点击 / `openQuickVideoSummary` / `startVideoSummary` | 重新绑定当前连接并活动中的 `<video>`，过滤推荐流刷新前已断开的旧节点 | 静态路径检查通过；候选选择测试通过 |
| `scanMediaCandidates` / `resolveDouyinMediaUrl` | 性能资源按 `startTime` 倒序，优先最近一次视频请求；补充播放器父节点 `data-src`/`data-url`/`data-play-url`/`data-video-url` | 代码检查通过；避免旧 URL 抢在新视频之前 |

## 十四、v1.9.49 网页总结边距与链接按钮避让

| 位置 | 改动 | 验证 |
|---|---|---|
| `renderTextAISummaryPanel` | 网页 AI 总结改用 `.summary-scroll` 内容区 + 独立操作栏；`.text-ai-answer` 取消内部最大高度/滚动 | 无头 Edge：内容区 padding `17px 21px 13px`，正文左边界 745、面板右边界 1166，正文不再贴边；正文 `overflow=visible`，内容区 `overflow-y=auto` |
| `installLauncher.place` | 链接旁预览/AI 两个按钮都放在链接矩形外；优先左右，空间不足移到下方，禁止覆盖链接 | 24×24 图标链接实测：链接 `68–92px`，预览按钮 `96–118px`，AI 按钮 `42–64px`，两者与链接均无交叠 |

## 十五、v1.1.8 抖音 AI 总结错绑其他视频

| 位置 | 改动 | 验证 |
|---|---|---|
| `selectMediaCandidate` / `scanMediaCandidates` | 抖音只接受与点击 `<video>` 完全相同的候选；网络请求、性能资源和页面声明里的未绑定 URL 全部标为 `unbound`，不再作为兜底 | 单元测试覆盖：有锚点时无精确候选返回 `null`，不会落到特效/相邻视频 |
| `resolveDouyinMediaUrl` / `douyinPageDataUrls` | URL 必须带同一 `aweme_id`，页面数据必须在同 `aweme_id` 的对象内；移除未过滤的脚本 URL 扫描 | 静态断言 + 真实抖音页候选列表检查：候选含 blob、多个 unbound CDN，选中的始终是锚点 |
| `requestDouyinDetail` / `douyin_hook` | 详情接口改为返回服务端实际 `detail.aweme_id`，不再回显请求 ID；内容脚本要求 ID 一致且时长匹配 | 回归测试断言 `awemeId: returnedId` |
| `douyin_hook` MSE | `owner` 标记 MediaSource，`id` 标记单个 SourceBuffer；请求时优先只回传当前播放器的音频轨 | 真实抖音页：owner 1 的音频轨 4 片进入解码，时长 20.48s、峰值 0.965 |
| `extractAudioFromMseChunks` | 分组键加入 mime，避免音频/视频分片混在一个 MP4 blob 中 | 修复前 `decodeAudioData` 失败；修复后真实视频成功生成 873,894 字符音频 data URL 并进入 ASR |
| 兜底策略 | 详情与页面数据都无法证明归属时，改用该播放器的 MSE 音轨；仍失败则明确报错，不再选“最新 MP4” | 真实抖音 36 分钟视频：总结请求标题、URL、`aweme_id` 与点击的视频一致，不再出现 effectcdn/直播流 |

## 十六、v1.1.9 拖拽作用域、原图与 AI 按钮范围

| 位置 | 改动 | 验证 |
|---|---|---|
| 顶层 `dragstart` / `hasUrlPayload` / `drop` | 识别选区拖拽和输入框内选区；选中文字拖动时只保留原生行为，不显示拖放层、不解析文字中的 URL、不开预览 | 单元测试 `selectionIntersectsElement`；静态断言拖放路径检查 `__LPS_TEXT_DRAG__` |
| `installLinkDrag` | mousedown/mousemove/dragstart 均跳过与选区相交的链接，避免“选文字”被判定为拖链接 | 选区相交测试 + 全量回归 |
| `imageInfoFromElement` | 扫描多层祖先和邻近节点的 `data-full`/`data-original`/`data-actualsrc` 等原图属性；保留指向查看页的父链接 | `srcset`/原图属性测试；真实缩略图结构检查 |
| `imageOriginalVariants` / `imageUrlsFromHtml` | 支持 `-300x200`、`_thumb`、`/thumb/` 等缩略图变体；查看页抓取 `og:image`、`twitter:image`、`image_src`、preload 和 JSON-LD 图片 | 7 项新增测试通过，含 HTML 元数据顺序 |
| `setupImageViewer` / `upgradeImageViewerFromPage` | 先显示可用缩略图，抓到查看页原图后自动把原图放到候选首位并重新加载 | 代码检查；候选合并逻辑通过 |
| `isVideoSummaryEligible` / `showVideoAI` / `scanVisibleVideo` | 视频 AI 按钮只在悬停符合条件的真实播放器时显示；自动扫描不再展示按钮；评论区、通知、回复、表情、广告、隐藏/过小视频均排除；抖音要求 `feed-active-video`/`xgplayer` 等播放器容器 | 单元测试覆盖主播放器、评论视频、90×60 小视频；静态断言无自动 `showVideoAI(videos[0])` |
| `installVideoSummary` 指针离开 | 不再依赖 `<video>` 的 `mouseout`（播放器常被控制层覆盖收不到），改为判断指针离开视频和按钮矩形后 700ms 收起 | 真实抖音页：未悬停无按钮；悬停主视频出现；移到页面空白或注入的评论视频后隐藏 |
| 总结窗口 CSS | 停靠状态 `cursor:default`，仅 `data-summary-dock="free"` 时使用 `grab/grabbing` | 静态 CSS 断言通过 |

## 十七、v1.1.10 抖音音轨绑定与 AI 按钮首次定位

| 位置 | 改动 | 验证 |
|---|---|---|
| `douyin_hook` 详情请求 | 签名函数抛错或详情请求被 Argus 拦截时，重试带 Cookie 的简化 detail 请求；不再把整个详情响应丢掉 | 真实短链 `https://v.douyin.com/70NAaFJGzWg/`：detail 返回 `ok:true`，同时拿到视频 URL 和音乐 URL |
| `douyinAudioTracksForVideo` / `startMediaSummary` | 按当前视频 `currentSrc` 的 `l` 请求日志令牌绑定独立音频流；当前是 blob 时保留最近音频候选，但逐个解码并用视频时长校验，避免把 26 秒背景音乐当成 132 秒视频音轨 | 单元测试覆盖同 `l` 匹配、跨 `l` 拒绝；真实视频仍正确选择当前 aweme 的音轨 |
| `extractAudioFromVideo` / `captureAudioFromMediaUrl` | 直接视频 URL 的字节解码失败时，用隐藏 `<audio>` 元素在本地按 4× 捕获音轨并转 WAV；不把原始视频发给模型 | 代码路径检查；直接 URL 与 MSE 路径仍有回退 |
| `requestRemoteTranscript` / `offscreen.transcribeRemote` | 长视频（36 分钟）优先让 offscreen 直接下载独立音轨并按 5 分钟分段转写，避免把 52 MB 音频 data URL 塞进 runtime 消息；offscreen 以 16 kHz 解码以降低长音频内存 | 真实长视频：独立音轨 52,217,604 字节、解码时长 2158.55 秒；详情返回同一 aweme 的视频地址 |
| `isVideoSummaryEligible` / `showVideoAI` | 抖音额外要求播放器面积达到视口 18%，排除头像/预览卡片；按钮创建时放在屏幕外，连续 3 帧矩形稳定后才定位显示 | 真实抖音页位置采样：首帧 `hidden`，稳定后才在右上角出现；小卡片测试为 false |
| 回归测试 | 增加详情兜底、音频候选绑定、按钮稳定定位断言 | 全量 Node test：63/63 通过 |

## 十八、v1.1.11 长视频音轨分包

| 位置 | 改动 | 验证 |
|---|---|---|
| `requestRemoteTranscript` / `offscreen.transcribeRemote` | 36 分钟视频改由 offscreen 直接下载独立音轨并每 5 分钟分段转写；长音频不经过超大 data URL 消息，16 kHz 解码降低内存 | 真实长视频详情返回同一 aweme 的视频地址；独立音轨 52,217,604 字节、解码时长 2158.55 秒 |

## 十九、v1.1.12 抖音分享链与详情音轨

| 位置 | 改动 | 验证 |
|---|---|---|
| `awemeIdFromVideo` / `douyin_hook.lpsAwemeId` | 抖音详情页的播放器外层只有 `video_<aweme_id>` 类名，没有 `data-aweme-id`。现在同时解析该类名，优先于地址栏和历史 API ID | 真实视频页 `https://www.douyin.com/video/7674218868219799695`：不手动加属性也能拿到 `aweme_id`；回归测试覆盖 |
| `startMediaSummary` | 内容脚本取不到 DOM ID 时，若详情接口返回的 `aweme_id` 与 `/video/{id}` 地址栏一致且时长匹配，则接受该详情；不再因为 `currentId` 为空而丢掉整个详情响应 | 真实视频页：总结从 `blob` 链路切换到 `音频链路 · direct · 464 秒` |
| `douyin_hook.lpsExtractDetailUrls` / `background.collectDouyinApiAudioUrls` | 读取 `video.bit_rate_audio[].audio_meta.url_list`（对象形式 `main_url`/`backup_url`/`fallback_url`），把专用音频 DASH 轨放在 `music.play_url` 之前；背景音乐单独返回，不再冒充语音轨 | 真实详情：返回 3 条音频候选；单元测试断言 `main_url` 优先、背景音乐不进入音频候选 |
| `background.resolveDouyinViaTab` | 先复用已打开的抖音标签页执行同源详情请求；没有时才创建 `active:false` 的临时标签页，解析完成后关闭。避免扩展源 fetch 因 `UIFID` SameSite=Lax 返回 403 | 真实短链 `https://v.douyin.com/qCFsqVKjLHM/`：后台返回 `ok:true`、`videoId=7674218868219799695`、3 条音频地址 |
| `openQuickAISummary` / `openDouyinLinkSummary` | 在任意页面点击抖音分享链接的 AI 按钮时，识别 `v.douyin.com` / 视频页链接并走媒体总结；显示解析进度，失败时在总结窗口给出具体原因 | 本地测试页：短链直接生成 `音频链路 · direct · 464 秒` 总结，mock ASR/文本接口成功；全量 Node test 68/68 通过 |

## 二十、v1.1.13 视频下载与字幕总结下载

| 位置 | 改动 | 验证 |
|---|---|---|
| `startMediaSummary` | 详情返回音频轨时，同时把 `detail.video[0]` 作为独立的视频下载候选；详情返回 ID 与当前 aweme 不一致时仍拒绝 | 真实抖音视频：MP4 下载成功，`20,486,650` 字节 |
| `downloadMediaVideo` / `appendDouyinDetailCandidates` | 下载候选按“直链优先”排序，详情视频标记 `verifiedVideo`，跳过会把抖音 CDN 403 的隐藏 `<video>` 探测 | 真实抖音视频：直接下载详情 MP4，不再走 MSE 录制 |
| `requestMediaDownload` | 页面内先 `fetch` 媒体并 Blob 保存，保留页面 Referer；失败后回退后台 `chrome.downloads`。后台去掉 Chromium 不接受的 `DownloadOptions.headers`，DNR 对 `other` 请求补 Referer | 真实抖音：MP4 与 M4A 均落盘；本地直链视频下载成功 |
| `downloadMediaAudio` / 字幕总结面板 | 视频总结（含字幕总结）新增“下载视频”“下载音频”；点击时才调用 `ensureMediaForDownload` 解析候选，抖音会补详情音频轨和视频直链 | 字幕测试页：字幕总结面板出现两个下载按钮，视频下载 `17,707` 字节 |
| `mediaSourceNote` | 详情解析后刷新面板媒体来源文字，不再显示过期的 `blob` 来源 | 代码路径 + 真实页面检查 |
| `cleanDownloadName` | 文件扩展名从 URL 路径读取，支持 WebM/MOV/MKV/M4A/MP3 等，抖音 MP4 保持 `.mp4` | 本地 WebM 直链下载；抖音 MP4/M4A 文件名正确 |

## 二十一、v1.1.14 全方位性能提速

| 位置 | 改动 | 验证 |
|---|---|---|
| `manifest.content_scripts` | 从 content_scripts 移除 `i18n.js`：内容脚本不读取 `LinkDragI18N`，只有 popup/options/sidepanel 需要它；每个网页 frame 少解析约 20 KB | `test/i18n_static.test.js` 断言 content_scripts 不再包含 i18n.js |
| `subtitleProbeBudget` / `startVideoSummary` | 抖音/TikTok 不再等待无意义的 20 秒字幕探测；普通无字幕页面 3.5 秒后直接转 ASR，YouTube/B 站保留 12 秒 | 静态回归断言；无字幕路径不再存在 `resolve(null), 20000` |
| `offscreen.transcribeRemote` | 5 分钟 ASR 分片最多 2 路并发，结果按原索引组装；失败仍返回具体分片号 | 分包顺序/并发静态断言；全量 Node test 76/76 通过 |
| `requestDouyinDetail` | 详情结果缓存 120 秒，缓存键包含 aweme id、页面路径和当前播放器 blob，避免总结后下载重复请求 | 真实抖音：总结后下载不再等待详情接口 |
| `scheduleShellWarm` / `cancelShellWarm` | 指针仅路过链接后在 idle 回调前离开时取消建壳，避免为不会打开的预览解析整张 UI | 代码路径检查；全量回归 |
| `syncSummaryBackdrop` / 会话定时器 | 没有窗口时立即返回，降低常驻页面的无效遍历 | 静态断言 |
