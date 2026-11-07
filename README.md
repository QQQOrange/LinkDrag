# LinkDrag

**LinkDrag** is a Chromium Manifest V3 extension for previewing links in place, inspecting images at full resolution, and generating AI summaries for pages and media. This is the first public release: **v1.0.10**.

**LinkDrag** 是一款 Chromium Manifest V3 扩展：直接在网页中预览链接、查看高清原图，并为网页正文和音视频生成 AI 总结。这是第一个正式版本：**v1.0.10**。

<p>
  <a href="#中文">简体中文</a> ·
  <a href="#english">English</a>
</p>

---

<a id="中文"></a>

## 简体中文

### 功能

#### 链接预览

- 拖拽链接、长按链接、`Alt + 点击`链接，或把鼠标停在链接上约 600ms，即可在当前页面浮出预览。
- 支持多窗口、窗口层叠/排列、画中画、贴边收起、拖拽移动、缩放和会话恢复。
- 链接旁的预览按钮和 AI 总结按钮永远不会覆盖链接本体；图标型小链接也会自动避让。
- 支持嵌套预览、阅读模式、只读快照、查找栏、强制暗色、窗口透明度、字号和动画设置。
- 站点可单独暂停；工具栏弹窗提供全局开关、当前站点状态、最近预览和快捷入口。
- 右键菜单可预览链接、选中网址或打开设置。
- 快捷键 `Alt+Shift+L` 暂停/恢复当前站点，可在浏览器扩展快捷键页修改。

#### 图片预览

- 拖拽图片直接查看原图，不会先打开一个缩略网页。
- 自动从 `srcset`、链接地址和页面候选中选择最高清版本。
- 支持图片缩放、平移、适应窗口和会话恢复。

#### AI 页面总结

- 点击链接旁的 AI 按钮，读取网页正文并发送到你配置的 AI 接口。
- 支持 DeepSeek、硅基流动、通义千问、Kimi、OpenAI、Ollama，以及任意 OpenAI 兼容接口。
- API Key 只保存在本机 `chrome.storage.local`，不写入页面 DOM。
- 可配置模型、接口地址、提示词，并支持拉取模型/测试连接。

#### AI 音视频总结

- 点击视频旁的 AI 按钮或工具栏「总结页面音视频」。
- 优先读取字幕；没有字幕时优先寻找独立音频流；只有视频时先抽取音轨，再送 ASR，最后把转写文本交给文本 AI。
- 支持原生 VTT/SRT、YouTube 字幕、Bilibili 字幕与音频流。
- 多平台媒体发现：抖音、快手、B站、YouTube、TikTok、小红书、Instagram、X/Twitter 等公开视频；优先使用页面声明、JSON-LD、`og:video`/`og:audio` 和平台 CDN 地址。快手额外走 GraphQL 详情接口，抖音走详情 API + 页面/网络多路兜底。
- 抖音推荐流/精选流单页刷新后会重新绑定当前正在播放的视频，并从最新网络请求、播放器父节点、页面数据和详情接口多路寻找真实媒体地址。
- 音视频总结窗口支持下载视频、下载音频、下载 SRT 字幕和复制总结。
- **SRT 字幕**：有真实字幕后保留时间轴；纯 ASR 没有时间戳时按媒体时长生成连续、合法的估计时间轴。
- 媒体流只有在没有可访问的直接地址时才使用播放器音轨捕获作为最后兜底；不会把原始视频直接发给 AI。
- 需要录制兜底时会优先克隆一个**离屏播放器**，在后台以默认 4×（设置范围 2–8×）加速播放并捕获音轨；前台正常播放不受影响。抖音的 MSE 流无法克隆时会直接停止，不会在你看的播放器上偷偷快进。

#### 界面与主题

- 亮色/暗色 UI 自动主题只看**页面 UI 的颜色**（页头、导航、侧栏、页面底色等），并排除视频、音频、画布和播放器舞台；深色视频不会把浅色页面误判成夜间 UI。系统偏好作为辅助，也可以强制日间或强制夜间。
- 中文/英文两种界面语言，默认简体中文，可在「选项与诊断」或页面内完整设置中切换为 English。
- 总结窗口采用单滚动内容区和独立底部操作栏，长内容不会被按钮遮挡。
- 设置、帮助、AI 配置、动画和快捷键均可在扩展中调整。

### 安装

#### 从 ZIP 安装（开发版）

1. 下载 `dist/LinkDrag-v1.0.10.zip` 并解压。
2. 打开 `edge://extensions` 或 `chrome://extensions`。
3. 开启右上角「开发人员模式」。
4. 点击「加载解压缩的扩展」，选择解压后的 `LinkDrag` 文件夹。
5. 打开普通网页测试拖拽、悬停、长按或 `Alt + 点击`。

也可以直接加载仓库中的 `extension` 目录。

#### 文件页面

若需要预览 `file://` 页面，在扩展详情页打开「允许访问文件网址」，然后刷新本地页面。

### 使用

| 操作 | 效果 |
|---|---|
| 拖拽链接 | 在当前页打开预览窗口 |
| 长按链接 | 打开预览 |
| `Alt + 点击` | 打开预览 |
| 悬停链接约 600ms | 打开悬停小窗 |
| 链接旁预览按钮 | 打开预览 |
| 链接旁 AI 按钮 | 打开网页 AI 总结 |
| 视频旁 AI 按钮 | 打开视频总结 |
| 工具栏图标 | 全局开关、当前站点控制、最近预览 |
| 右键菜单 | 预览链接 / 选中网址 / 页面设置 |

### AI 配置

打开「选项与诊断」或「页面内完整设置」：

1. 选择 AI 服务商。
2. 填写接口地址和模型。
3. 填写 API Key；本地 Ollama 可留空。
4. 需要音视频总结时，单独填写媒体总结 API Key（硅基流动 ASR）。
5. 保存并测试连接。

只有点击 AI 按钮、总结入口或追问时，才会向配置的接口发送对应正文/音频转写文本。API Key 不会注入页面 DOM。

### 语言

- 默认：**简体中文**
- 可选：**English**
- 入口：选项与诊断页的「界面语言」，或页面内完整设置顶部的「界面语言」。
- 选择 English 后，该选择会持久保存，后续页面和总结窗口使用英文 UI；可以随时切回简体中文。

### 权限与隐私

扩展申请以下权限：

- `storage` / `unlimitedStorage`：保存设置、布局、历史和本地 API 配置。
- `tabs` / `scripting`：读取当前标签页并注入内容脚本。
- `contextMenus`：提供右键预览菜单。
- `sidePanel`：显示内容总结侧边栏。
- `offscreen`：在后台处理音视频转写。
- `downloads`：下载视频、音频和 SRT 字幕。
- `declarativeNetRequest`：仅对受支持的媒体 CDN 补充必要请求头，不修改页面响应。
- `webRequest`：只观察当前标签页的媒体请求 URL，用于找到抖音等站点的真实视频/音频地址；不读取账号密码，不修改请求内容。
- `<all_urls>`：在普通网页中注入预览和总结能力。

API Key 保存在本机 `chrome.storage.local`。扩展不会自动上传浏览历史；只有你主动触发 AI 总结时才会发送对应内容到你自己配置的接口。

### 已知限制

- `chrome://`、`edge://`、扩展商店和 PDF 内置查看器属于浏览器保护页面，无法注入。
- 受 DRM 保护或站点严格禁止读取的媒体无法导出。
- HLS 的 MPEG-TS 分片、部分跨域防盗链和需要登录签名的媒体可能无法处理。
- 纯 ASR 没有原始时间戳时，SRT 时间轴是按媒体时长生成的估计值。
- MediaSource 流无法直接读取且没有可用网络地址时，才使用播放器音轨录制作为兜底；录制优先走离屏克隆和后台倍速，若无法克隆则停止，不会在前台快进。

### 开发与测试

要求：Node.js、Python 3、Chromium/Edge 120+。

```powershell
# 生成 extension/content.js
python tools\build_content.py

# 检查生成物
python tools\build_content.py --check

# 回归测试
node --test test\audio_resample.test.js
node --test test\srt.test.js
node --test test\media_url_kind.test.js
node --test test\douyin_urls.test.js
node --test test\i18n_static.test.js
node --test test\security_static.test.js

# 打包
powershell -ExecutionPolicy Bypass -File .\打包ZIP.ps1
```

### 目录结构

```text
LinkDrag/
├─ extension/            可直接加载的扩展目录
│  ├─ manifest.json
│  ├─ i18n.js            中英文 UI 层
│  ├─ content.js         页面内预览 / AI / 媒体逻辑
│  ├─ background.js      Service Worker
│  ├─ options.*          选项与诊断页
│  ├─ popup.*            工具栏弹窗
│  └─ sidepanel.*        内容总结侧边栏
├─ src/                  内容脚本的唯一维护源
├─ tools/                构建与测试辅助
├─ test/                 回归测试
└─ README.md
```

### 版本

**v1.0.10** — 首个 LinkDrag 正式版本。

---

<a id="english"></a>

## English

### Features

#### Link previews

- Drag a link, long-press it, `Alt + click` it, or hover for about 600ms to open an in-page preview.
- Multiple windows, cascading/tiling, picture-in-picture, edge collapse, drag/resize and session restore.
- Preview and AI buttons beside links never cover the link itself, including small icon-only links.
- Nested previews, reader mode, read-only snapshots, find bar, forced dark mode, opacity, font size and animation settings.
- Pause per site; the toolbar popup provides global controls, current-site status, recent previews and shortcuts.
- Right-click menu for links, selected URLs and settings.
- `Alt+Shift+L` pauses/resumes the current site; rebind it from the browser's extension shortcuts page.

#### Image preview

- Drag an image to inspect the original, without opening a thumbnail page first.
- Picks the highest-resolution candidate from `srcset`, the wrapping link and page data.
- Zoom, pan, fit-to-window and session restore.

#### AI page summaries

- Click the AI button beside a link to read the page and send it to your configured AI endpoint.
- Presets for DeepSeek, SiliconFlow, Qwen, Kimi, OpenAI, Ollama and any OpenAI-compatible endpoint.
- API keys stay in local `chrome.storage.local`; they are not written into page DOM.
- Configurable endpoint/model/prompt, model discovery and connection tests.

#### AI media summaries

- Use the AI button beside a video or the toolbar's “Summarize page media”.
- Subtitles first; otherwise an independent audio stream; otherwise extract audio from video, run ASR, then send the transcript to a text model.
- Native VTT/SRT, YouTube captions, Bilibili captions and audio streams are supported.
- Multi-platform discovery: Douyin, Kuaishou, Bilibili, YouTube, TikTok, Xiaohongshu, Instagram and X/Twitter when the page exposes public media. It uses page declarations, JSON-LD, `og:video`/`og:audio` and platform CDN URLs; Kuaishou also has a GraphQL detail resolver, and Douyin uses a detail API plus page/network fallbacks.
- On Douyin recommendation/featured feeds, LinkDrag rebinds the currently playing video after an in-place feed refresh and searches the latest network requests, player parent data, page data and detail API for the real media URL.
- Media summary windows can download video, download audio, download SRT subtitles and copy the summary.
- **SRT subtitles**: real subtitle cues keep their timestamps; plain ASR without timestamps receives a valid continuous estimated timeline based on media duration.
- Player capture is a last-resort fallback only when no accessible direct URL exists; raw video is never sent to the AI model.
- When capture is unavoidable, LinkDrag first clones the player off-screen and records its audio at 4× by default (2–8× configurable); the visible player keeps normal playback. If a Douyin MSE stream cannot be cloned, LinkDrag stops instead of silently fast-forwarding the player you are watching.

#### UI and themes

- Automatic light/dark UI samples **page UI surfaces** (header, navigation, sidebar, page background) and explicitly excludes video, audio, canvas and player stages; a dark video cannot make a light page switch to the night UI. The OS preference is a secondary signal; explicit light/dark remains available.
- Simplified Chinese and English UI. Simplified Chinese is the default; English can be selected and becomes the persisted default for subsequent pages.
- Summary windows use one content scroller with a separate fixed action bar, so long content is never hidden behind buttons.
- Settings, help, AI configuration, animation and shortcuts are configurable.

### Installation

#### Install from ZIP (development build)

1. Download and extract `dist/LinkDrag-v1.0.10.zip`.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `LinkDrag` folder.
5. Open a normal webpage and try dragging, hovering, long-pressing or `Alt + clicking` a link.

You can also load the repository's `extension` directory directly.

#### Local files

To preview `file://` pages, enable **Allow access to file URLs** in the extension details and refresh the local page.

### Usage

| Action | Result |
|---|---|
| Drag a link | Open a preview window in the current page |
| Long-press a link | Open a preview |
| `Alt + click` | Open a preview |
| Hover a link for ~600ms | Open the hover preview |
| Link preview button | Open a preview |
| Link AI button | Open page AI summary |
| Video AI button | Open video summary |
| Toolbar icon | Global controls, current-site controls, recent previews |
| Context menu | Preview link / selected URL / page settings |

### AI setup

Open **Options & diagnostics** or **In-page settings**:

1. Choose an AI provider.
2. Set the endpoint and model.
3. Enter an API key; local Ollama can be left empty.
4. For media summaries, configure the separate SiliconFlow ASR key.
5. Save and test the connection.

Text/audio is sent only when you explicitly click an AI button, summary entry point or follow-up. API keys are never injected into page DOM.

### Language

- Default: **Simplified Chinese (zh-CN)**
- Optional: **English (en)**
- Location: **Options & diagnostics → Interface language**, or the top of **In-page settings**.
- Selecting English persists the choice for future pages and summary windows; you can switch back at any time.

### Permissions and privacy

- `storage` / `unlimitedStorage`: settings, layouts, history and local API configuration.
- `tabs` / `scripting`: inspect the active tab and inject content scripts.
- `contextMenus`: right-click preview actions.
- `sidePanel`: content summary side panel.
- `offscreen`: background audio/video transcription work.
- `downloads`: download video, audio and SRT subtitles.
- `declarativeNetRequest`: add only required headers for supported media CDNs; page responses are not modified.
- `webRequest`: observe media request URLs in the current tab to discover real video/audio URLs (for example Douyin). It does not read credentials or alter request bodies.
- `<all_urls>`: enable previews and summaries on normal webpages.

API keys remain in local `chrome.storage.local`. LinkDrag does not automatically upload browsing history; content is sent only when you explicitly start an AI action and only to the endpoint you configured.

### Known limitations

- `chrome://`, `edge://`, extension stores and the built-in PDF viewer are protected and cannot be injected.
- DRM-protected media and media that the site blocks from reading cannot be exported.
- HLS MPEG-TS segments, some cross-origin hotlink protections and login/signature-gated media may fail.
- For plain ASR without timestamps, SRT timing is estimated from media duration.
- If a MediaSource stream has no readable network URL, player audio recording is used only as a final fallback; it prefers an off-screen clone and background speed-up, and stops rather than fast-forwarding the visible player when cloning is impossible.

### Development and tests

Requirements: Node.js, Python 3, Chromium/Edge 120+.

```powershell
python tools\build_content.py
python tools\build_content.py --check

node --test test\audio_resample.test.js
node --test test\srt.test.js
node --test test\media_url_kind.test.js
node --test test\douyin_urls.test.js
node --test test\i18n_static.test.js
node --test test\security_static.test.js

powershell -ExecutionPolicy Bypass -File .\打包ZIP.ps1
```

### Version

**v1.0.10** — first official LinkDrag release.

---

## License / 许可

This repository is provided as-is for personal and educational use. Third-party service names and trademarks belong to their respective owners. Media-discovery research references [cshuangyy/videdown](https://github.com/cshuangyy/videdown) (MIT); no yt-dlp binary is bundled. / 本项目按现状提供，供个人与学习用途；第三方服务名称与商标归各自所有者。媒体解析思路参考 [cshuangyy/videdown](https://github.com/cshuangyy/videdown)（MIT）；本项目不捆绑 yt-dlp 二进制。










