# dsh-folia-embed

把本机**已安装**的 [Folia](https://github.com/chthollyphile/folia-major) 的歌词舞台，作为 DeepSeek Harness 的窗口背景，并把 Folia 的播放控制搬到 DSH 右下角。

不重画歌词。插件只做一件事：把 Folia 自带的 **OBS 浏览器源**页面
（`http://127.0.0.1:32108/obs?obs=1&token=…`）挂到窗口最底层，然后把 DSH 的
底色改成透明，让它在后面透出来。歌词滚动、可视化、主题、字体、封面配色全部由
Folia 自己渲染，插件版本随 Folia 一起升级。

## 安装

**设置 → 插件 → 添加插件 → 安装第三方插件**，填：

```
github:Aca233/dsh-folia-embed
```

装完重启 DSH。插件声明了 `dsh.bundle`，所以会被写进 profile 的
`dsh.profile.bundles` 并自动挂载，不需要手改 `cordis.patch.yml`。

命令行等价写法（`dsh` 不在 PATH 时用 DSH 自带的那份）：

```bash
dsh plugin --profile desktop add github:Aca233/dsh-folia-embed
```

从本机源码装（改代码时用，`link:` 装的是活目录）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-folia-embed
```

`github:` 走的是 `git ls-remote` + git 克隆，国内网络下常常连不上 `github.com:443`
（报 `ERR_PNPM_GIT_RESOLVE_FAILED` / `os error 10060`）。这时换一个 GitHub 加速前缀，
把仓库 tarball 地址包起来；插件管理器认 `.tar.gz` 结尾的 URL，会当成 tarball 装，
同样写进 `dsh.profile.bundles`：

```
https://gh-proxy.com/https://github.com/Aca233/dsh-folia-embed/archive/refs/heads/master.tar.gz
```

`gh-proxy.com` 只是示例，任何能转发 GitHub 归档的加速前缀都行（换掉前缀即可）。
注意 `codeload.github.com/.../tar.gz` 这种地址**不能**直接用：插件管理器只接受
`.tgz` / `.tar.gz` 结尾的 URL，`.../tar.gz/refs/heads/master` 会被判成「不是 tarball」
而拒绝。用 `github.com/<owner>/<repo>/archive/refs/heads/<branch>.tar.gz` 这个形式。

装之前先按下面的「前置条件」把 Folia 装好并开好 OBS 浏览器源——插件本身不带渲染器，
Folia 不在就没东西可铺。

## 前置条件

从零安装原软件（下载渠道、安装、开启 OBS 源、调试端口、自检、卸载）见
**[INSTALL.md](./INSTALL.md)**。装好之后只要确认三件事：

1. 安装并运行 Folia（Windows 安装版，默认路径
   `%LOCALAPPDATA%\Programs\Folia\Folia.exe`）。
2. 在 Folia 里打开 **OBS 浏览器源**（设置 → 连接与集成 → OBS 浏览器源，默认端口 `32108`）。
   设置项落在 `%APPDATA%\Folia\config.json`：

   ```json
   {
     "OBS_BROWSER_SOURCE_ENABLED": true,
     "OBS_BROWSER_SOURCE_PORT": 32108,
     "OBS_BROWSER_SOURCE_TOKEN": "<Folia 自动生成的随机串>"
   }
   ```

   token 不用手动抄——插件在 Host 侧读这个文件并拼好 URL。

3. Folia 以 `--remote-debugging-port=9223 --remote-allow-origins=*` 启动（右下角控制面板
   需要它）。最省事的办法是在插件设置页点「启动 Folia」；要自己双击启动，就按
   INSTALL.md 第 5 节改快捷方式。只开背景不碰面板的话，这一步可以跳过。

## 用法

设置 → **Folia 背景**：

| 项 | 作用 |
| --- | --- |
| 作为窗口背景 | 总开关 |
| 画面压暗 | 在 Folia 画面上盖黑，0–85%（默认 20%） |
| 面板不透明度 | 界面磨砂层不透明度，10–100%，默认 35%（侧栏自动再加 12% 保证可读） |
| 磨砂模糊 | 背景模糊强度，0–40px，默认 4px（0 = 清晰原画，同时省掉每帧一次全屏重采样） |
| 渲染分辨率 | Folia 逐帧重画画布的分辨率，50–100%，默认 100%（画面大且掉帧时往下调） |
| 右下角浮动开关 | 不打开设置也能切背景 |
| 右下角播放控制 | 显示/收起播放卡 |

面板里还会显示实时状态（是否安装 / 是否运行 / OBS 源是否开启），并提供
「启动 Folia」「重新检测」两个按钮。

### 右下角播放控制卡

浮在窗口右下角（默认开）。整块对应 Folia 歌曲页右下角那个控制面板，五个标签页
一一对应：

| 标签页 | 内容 |
| --- | --- |
| 封面 | 大封面、歌名 / 歌手 / 专辑、收藏 / 队列位置 / 时长 |
| 歌词 | 歌词来源、时间轴偏移 −/+、在线匹配、导入 / 导出歌词、音频增益（关闭 / 单曲 / 专辑） |
| 控制 | 音量 + 静音、循环 / 智能过渡 / 音频效果器、歌词样式、背景类型、全屏叠色 / 半屏渐变、播放页透明背景 / 封面、主题来源（默认 / AI / 自定义）、午夜晕染 + 生成 AI 主题 |
| 播放列表 | 整条队列，当前曲目高亮，可点播 / 打乱 |
| 音质 | 音源支持的档位（网易云：标准 / 极高 / 无损 / Hi-Res） |

底部是进度条（可拖拽、可键盘操作：`←/→` 5 秒，`Shift+←/→` 30 秒）与
上一首 / 播放暂停 / 下一首，右上角 `×` 收起。

### 面板外观怎么对齐 Folia

尺寸与配色不是估的，是从 Folia 渲染进程里量出来的（CDP 读 `st-window`
的计算样式），照抄进 `client.js` 的 `.dfe-panel` 一组选择器：

| 项 | 值 |
| --- | --- |
| 宽 / 圆角 / 内边距 | 360px / 20px / 12px |
| 底色 | `rgba(28, 28, 31, .8)`，`backdrop-filter: blur(40px) saturate(1.3)` |
| 外阴影 | `0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.09)` |
| 文字 | 主色 `#f4f4f5`，次级 62%，三级 42% |
| 头部 | 48px 封面（8px 圆角）+ 14px/600 歌名 + 12px/62% 歌手 + 32px 红心 |
| 标签栏 | **固定在面板最底边**，轨道 `white/7%`、10px 圆角、2px 内边距、13px 字，选中态是 `white/18%` 胶囊 |
| 三格开关 | 64px 高、10px 圆角，选中态 `white/18%` |
| 分段控件 | 轨道 `white/7%`、8px 圆角，选中态 `white/18%` 胶囊 |
| 开关 | 40×24 轨道 + 18px 圆钮，开启时轨道转白、钮转深 |

标签栏在底部这点和常见的「标签在上」相反，但 Folia 就是这样——面板从右侧手柄
展开时，标签一直贴在底边不动，换页只是中间内容在变。

**歌词样式 / 背景类型这两行会展开二级菜单**：点中间那块（`‹ 值 ›` 里带图标的
长条）弹出 3 列网格，每格是 16:10 缩略图加名字，选中项描边加粗。弹层是
`#2b2b30`、14px 圆角、`8px 0 4px` 内边距，挂在面板这一层（不是内容滚动区里，
否则会被 `overflow` 裁掉）；触发块上方空间不足 260px 时自动朝下弹。

背景类型那 6 个图标（通用 / 莫奈 / 漫游 / 隐现 / 嵌入 / 空）是 Folia 自己的
SVG，原样抄的。歌词样式在 Folia 里是实时画布预览（拿当前这首歌逐帧渲染 14 个
小窗），插件不去复刻那套渲染管线，用同风格的单色线性图标代替——这是在「多开
14 个渲染实例」和「外观统一」之间的取舍。

曲目与播放位置仍来自 Folia 的 OBS SSE 事件流（`config` 事件带歌曲与封面，
`clock` 事件约 4 Hz 带播放位置）；面板上的各项状态与动作走 `/folia-bg/panel`，
读写的都是 Folia 自己的 store，不另存一份。

## 实现要点

- **Host 半侧**（`lib/index.js`）注册七条只接受回环地址的本机路由：

  | 路由 | 方法 | 作用 |
  | --- | --- | --- |
  | `/folia-bg/status` | GET | 读 `%APPDATA%\Folia\config.json`，探测 `/obs/health`，返回 `{ installed, running, enabled, url, relayPort, reason }` |
  | `/folia-bg/launch` | POST | 拉起 `Folia.exe` |
  | `/folia-bg/player` | GET | 当前曲目 + 播放位置 + 时长 + 封面地址 |
  | `/folia-bg/cover` | GET | 封面代理（源地址取自 SSE `config.coverUrl`，不接受客户端传入，无 SSRF 面） |
  | `/folia-bg/control` | POST | `play / pause / toggle / next / prev / seek`（SMTC 通道） |
  | `/folia-bg/panel` | GET / POST | 整块控制面板的完整状态快照（`?queue=1` 带队列）与面板动作 |
  | `/obs/events` | GET | 时钟中继：把 Folia 的事件流转给舞台页，`clock`/`audio` 换成真实音频时钟与频谱 |

  渲染进程用相对路径访问，走 `dsh-app://` 代理，不涉及跨源。`/obs/events` 是
  例外——舞台页在 `127.0.0.1:32108` 上跑，跨源读这条流，所以它按回环 Origin
  回 `Access-Control-Allow-Origin`。

- **Client 半侧**（`client.js`）：
  - `ctx.theme.overrideTokens` 把 `--dsw-alias-bg-base` 覆盖为 `transparent`，
    把 `--dsw-specific-sidebar-fill` 覆盖为**半透明**色（`面板不透明度 + 12%`，
    亮/暗各一份）。侧栏保持一层底色，背景再花也不会把导航文字糊掉。
  - body 前置一个 `position:fixed; z-index:0` 的 `#dfe-layer`，内含指向 Folia
    OBS 页的 `iframe` 与一层可调的压暗遮罩。
  - 用 `:has(>[data-shell-overlay])` 选中 frame 那一层，只画**一次**磨砂面板，
    避免多层半透明叠加。
  - 设置存 `localStorage`，状态每 4s 轮询（关闭背景且已加载后停止轮询）。
  - 播放卡按 1 s 轮询 `/folia-bg/player`；轮询结果与上一帧等价时不触发渲染。

### 控制面板怎么接上 Folia

Folia 歌曲页右下角那块面板是 Electron 渲染进程里的普通 DOM，没有对外 HTTP 接口；
它的 Stage API（32107）和 Lyric API（32109）默认关闭且只读，OBS 源页（32108）
是纯展示页，不带任何控制按钮。

真正的通道是 **CDP**：Folia 以
`--remote-debugging-port=9223 --remote-allow-origins=*` 启动时，Host 侧连上去，
在页面里注入一段 agent，由它顺着 React fiber 找到面板自己的
`model.panelProps`（恰好 `playback / queue / library / account` 四个键），
读状态、调它自己的回调。面板上的每个按钮都走这条路径，所以行为和 Folia 里
点一模一样，也不需要插件另存一份状态。

只有播放位置（`clock`）走 OBS SSE —— 实测同一首歌 SMTC 报 8582 ms、
OBS 报 42839 ms，SMTC 的时间轴不可靠。

### 为什么还要一条时钟中继

Folia 把歌词时钟发布给 OBS 浏览器源时，`currentTime` 是在自己的
`requestAnimationFrame` 里采样的。DSH 把背景铺满整窗后，Folia 的主窗口被完全
遮住，Chromium 立刻把它的 rAF 节流到 **1 FPS**（实测 1005 ms/帧，CDP 的
`setFocusEmulationEnabled` / `setWebLifecycleState` / `setIdleOverride` 都解不掉）。
于是每 250 ms 发出的 clock 里，`currentTime` 其实最多滞后一帧、新旧帧交替时
忽快忽慢；舞台页对每帧都做 `currentTime + (now − sentAtMs)` 外推、新帧一到就
硬对齐，实测 **23% 的帧往回跳，中位 148 ms、最深 264 ms**——这就是肉眼看到的
抽搐和回退。频谱同理，Folia 也只在 rAF 里读 analyser，掉到 1 FPS 后可视化一顿一顿。

`Page.startScreencast` 能让 Chromium 认为页面「有人在看」从而解除节流，但它同时
把渲染进程 CPU 推到 52%、GPU 推到 55%，不可接受。

所以插件自己中继这条流：iframe 带上 `?obsPort=<DSH 端口>`（舞台页原生支持的
参数），去 `/obs/events` 读 Host 转发的事件。Host 通过 CDP 直接读 Folia 页面里
`<audio>.currentTime`（音频由音频线程推进，不受 rAF 节流影响），并用
`captureStream()` + `AnalyserNode` 自建一条分析链取真实频谱，两者都按 20 Hz
重新发布。时间戳在页面里同一时刻打，避免把 CDP 往返算进外推。

效果（同一首歌、同时段对照）：回退帧 27.1% → 10.8%，**最深回退 236 ms → 8 ms**，
频谱更新 1 Hz → 9 Hz。DSH Host 侧多出约 4% CPU。

两个必须记住的约束：

1. **SMTC 的时间轴不可靠**。所以位置只信 OBS SSE，只有 OBS 源根本连不上时才
   退回 SMTC，且两条来源绝不混用。
2. **OBS 的 SSE 和舞台页不是同一个 URL**。`/obs/health` 返回的 `url` 是给
   iframe 用的舞台页 `/obs?obs=1&token=…`；事件流在 `/obs/events?token=…`，
   两者只差 pathname。用错路径不会报错，只会安静地收不到任何事件。

注入的 agent 带内容哈希版本号，Host 每次调用前比对，Folia 更新后 agent
自动重注入。客户端发来的动作在 Host 侧过白名单（`PANEL_OPS`）、枚举
（`PANEL_ENUMS`）与数值夹取后才拼进页面表达式，任意表达式注入的面为零。

### 进度条的防抖

进度条不跟着 4 Hz 的 `clock` 事件直接跳，而是：

- 以最近一次 OBS 采样为锚点，用 `performance.now()` 自己推进；
- 只有漂移超过 900 ms、换歌、或播放/暂停翻转时才重新锚定；
- 拖动 / 方向键 / 暂停 / 播放之后开一个 1.2 s 的观察窗：窗内的采样如果还是
  动作前的旧值就一律忽略，免得进度条先被拽回去再追上（实测 Folia 的 seek
  反馈约 470 ms 到达，留 1.2 s 有足够余量）；
- 暂停时先把「此刻推算到的位置」写进锚点再冻结，否则会缩回到上一次采样点；
- 条形位置通过 CSS 变量 `--dfe-p` + `transform: scaleX()` 由 rAF 循环直接写
  DOM（60 Hz，合成器插值，不触发布局），而不是每帧 setState 让 React 重渲染；
- 时间文字和 `aria-valuenow` 只在整秒变化时才写。

这样在逐帧重绘的 iframe 之上不会叠出额外的渲染压力，也不会出现「回退一格再
追上」的抖动。

「渲染分辨率」的实现是把 iframe 的**布局尺寸**按比例缩小、再用反比放大回满屏，
让 Folia 按更小的画布逐帧重绘。注意方向和直觉相反：布局放大 + 缩小只会让
Folia 画得更大更慢。

## 卸载

在 **设置 → 插件** 里移除，或在 profile 目录跑：

```bash
dsh plugin --profile desktop remove dsh-folia-embed
```

插件管理器会同时把它从 `dsh.profile.bundles` 里去掉，重启 DSH 即失效。

**如果是早期手工装的**（`node_modules/dsh-folia-embed` 是指向 `~/.dsh/plugins/dsh-folia-embed`
的软链、`cordis.patch.yml` 里有手写的 `- insert: folia-embed`），建议先删掉那条手写
insert，再按上面的方式移除。留着不会崩——loader 按 `id` 合并，两条同名条目只会挂载
一次——但升级后分不清是哪一层在生效。之后可以删掉插件目录和软链。

## 许可

MIT。Folia 本身另有其许可，本插件不打包 Folia 的任何代码或素材。
