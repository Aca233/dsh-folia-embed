# 安装 Folia（原软件）

`dsh-folia-embed` **不内置任何渲染器**，只复用本机已安装的 Folia。这份文档从零走到
「插件能用」，Windows 为主，macOS / Linux 只列差异。

写这份文档时核过的事实：本机安装版 `0.7.21`、官方仓库 `chthollyphile/folia-major`
（AGPL-3.0）、最新正式版 `v0.7.21 "Realeco"`（2026-10-18 发布）。版本号会变，下面的
路径和参数不会。

---

## 1. 下载

| 渠道 | 地址 | 说明 |
| --- | --- | --- |
| GitHub Releases | <https://github.com/chthollyphile/folia-major/releases/latest> | 全平台正式版，首选 |
| 夸克网盘 | <https://pan.quark.cn/s/6e4c6fa3bc6f> | 国内网络慢时用，仅 Windows + Apple silicon 正式版 |
| 百度云 | <https://pan.baidu.com/s/1f0x3g-8PMcNCO-TJ5z1rPw?pwd=flia> | 提取码 `flia`，同上 |

正式版当前的 Windows 安装包是 `Folia-Setup-0.7.21.exe`（约 237 MB）。同一 Release
里还有 macOS 的 `.dmg` / `.zip`（x64 与 arm64 各一份）、Linux 的 `.deb` / `.rpm` /
`.tar.gz`，不要下错。

> [!WARNING]
> 同一个 Releases 页面上还挂着两个预发布渠道：`limo`（Nightly，每天构建）和
> `cielo`（Canary）。它们的外观接口和内部结构随时会变，**装正式版**。原因见第 10 节。

---

## 2. 安装

1. 双击 `Folia-Setup-<版本>.exe`。
2. 安装器是 NSIS 向导，**不是一键安装**：会问安装位置，并给一个「创建桌面快捷方式」的
   勾选。构建配置里没开 `perMachine`，所以没有「仅当前用户 / 所有用户」那一页——固定
   装进当前用户目录，不需要管理员权限，卸载项登记在 `HKCU`（`UninstallString` 带
   `/currentuser`）。
3. 已安装的 `Folia.exe` 不带 Authenticode 签名（PE 证书表为空），首次运行 Windows 可能
   弹「未知发布者」。这是项目本身的签名状态，不是下载损坏。
4. 装完的默认路径：

   ```
   %LOCALAPPDATA%\Programs\Folia\Folia.exe
   ```

   完整安装目录约 **583 MB**，其中 `resources\models\` 下两个分析模型占 133 MB
   （`beat_this-wgsl.bin` 41 MB、`htdemucs-wgsl.bin` 92 MB），用于节拍检测与智能过渡。
   这两个文件随安装包一起发，Folia 不会再联网补下——删了就只剩重装能恢复。

插件会在这两个位置找 Folia；另外 `%APPDATA%\Folia\config.json` 存在也算「已安装」——
所以装在别的盘、别的目录，只要跑过一次 Folia，状态里就不会报「未检测到」。代价是：
在别处装了但没启动过，状态会误报未安装，手动启动一次即可。

「启动 Folia」按钮只认上面那两个路径；装在别处的，自己启动，背景和面板照常可用。

---

## 3. 首次启动：先让它能放歌

Folia 自己不带曲库，得接一个音源。启动后按需要选一个：

| 音源 | 是否需要登录 | 备注 |
| --- | --- | --- |
| 网易云 / QQ 音乐 / 酷狗 | 视平台与档位而定 | 未登录通常只能拿到低码率或试听，音质页的档位也会受限 |
| 本地音乐库 | 否 | 指定一个文件夹即可，读音频元数据、同目录歌词与封面 |
| Navidrome | 需要填服务器地址与账号 | 自建音乐服务器 |

**这一步不能跳过。** 没有正在播放的歌曲时，OBS 舞台页是空的，DSH 背景就是一片黑，
右下角控制面板也会显示「Folia 里还没有正在播放的歌曲」。

歌词同理：本地库会自动匹配同目录 `.lrc`，也可以在线匹配。没有歌词时画面仍然在，只是
没有滚动文字（具体表现取决于当前用的歌词动画）。

---

## 4. 开启 OBS 浏览器源（背景必需）

路径：**设置 → 连接与集成 → OBS 浏览器源**，把开关打开。

- 默认端口 `32108`，只监听 `127.0.0.1`，不对局域网开放。
- 打开后 Folia 自动生成一个 32 字节随机 token，拼成地址
  `http://127.0.0.1:32108/obs?obs=1&token=<随机串>`，就是设置页上那条「OBS 地址」。
- 设置落在 `%APPDATA%\Folia\config.json`：

  ```json
  {
    "OBS_BROWSER_SOURCE_ENABLED": true,
    "OBS_BROWSER_SOURCE_PORT": 32108,
    "OBS_BROWSER_SOURCE_TOKEN": "<Folia 自动生成>"
  }
  ```

**token 不用抄。** 插件的 Host 半侧直接读这个文件拼 URL；抄进任何文档、截图、仓库
都是泄密（它等价于一条能看画面的通行证）。设置页那条地址在插件里也只以
`token=***` 的形式回显。

改了端口的话，插件下次读 config 会自动跟上，不需要改插件配置。

---

## 5. 让调试端口可用（控制面板必需）

右下角那块控制面板走的是 Chromium 的 DevTools 协议，**只有带
`--remote-debugging-port=9223` 启动的 Folia 才有这个端口**。Folia 自己不会加这个参数
（`electron/main.cjs` 里没有对应的 `appendSwitch`），所以得从启动方式上补。

三种办法，任选一种：

### 5.1 从 DSH 启动（最省事）

插件设置页点 **「启动 Folia」**。插件拉起进程时会自己带上：

```
--remote-debugging-port=9223 --remote-allow-origins=*
```

Folia 有单实例锁：已经在跑的时候再点，新进程拿不到锁，只会把旧窗口叫到前面然后退出，
参数等于没生效。所以**先退出 Folia，再点这个按钮**。

### 5.2 改快捷方式（自己双击启动时生效）

1. 右键桌面上的 `Folia` 快捷方式 → **属性**。
2. 在「目标」末尾加一个空格，再粘贴：

   ```
   --remote-debugging-port=9223 --remote-allow-origins=*
   ```

   改完大致是：

   ```
   "C:\Users\<你>\AppData\Local\Programs\Folia\Folia.exe" --remote-debugging-port=9223 --remote-allow-origins=*
   ```

3. 确定，然后**完全退出 Folia 再重新打开**。开始菜单里那个快捷方式是另一份文件，
   两个都要改，否则从开始菜单启动还是不带参数。

### 5.3 命令行

```bash
"%LOCALAPPDATA%\Programs\Folia\Folia.exe" --remote-debugging-port=9223 --remote-allow-origins=*
```

---

## 6. 自检

Folia 跑起来之后，两条命令能判断装好没有（Git Bash / cmd 都行；Windows PowerShell 5.1
里 `curl` 是 `Invoke-WebRequest` 的别名，要写 `curl.exe`）：

```bash
# 背景用的舞台页：应当返回 enabled:true 和一条带 token 的地址
curl http://127.0.0.1:32108/obs/health

# 控制面板用的调试端口：应当返回一个 type 为 page、title 为 Folia 的条目
curl http://127.0.0.1:9223/json/list
```

`/obs/health` 只在 OBS 源**开着**的时候才有响应——源关着时 Folia 根本不监听 `32108`，
这条命令会直接连不上（不是返回 `enabled:false`）。所以：

- 连不上 `32108`：Folia 没跑，或者 OBS 源没开。两者先用任务管理器区分。
- 连上但 `enabled` 为 `false`：理论上不会出现，真遇到了说明服务在、开关刚被关掉，
  重启 Folia 即可。
- 端口被别的程序占着：Folia 启动时会打一行 `[OBS] Failed to start browser source server
  during app startup`，但只在它自己的控制台里，普通启动看不到。这时状态里 OBS 会一直
  显示未开启——在设置里换个端口即可，插件读 config，会自动跟上。

对应到插件里的三种状态：

| 现象 | 缺的是哪一步 |
| --- | --- |
| 设置页「未检测到 Folia」 | 第 2 节，安装路径不对或没装 |
| 「OBS 浏览器源未开启」 | 第 4 节，开关没打开（或端口被占，见上） |
| 背景正常、控制面板提示需要 `--remote-debugging-port=9223` | 第 5 节，启动参数没带上 |

`/obs/health` 的返回里有 `clientCount`：大于 0 说明确实有页面连着舞台，可以用来确认
DSH 的 iframe 有没有连上。

---

## 7. 目录与文件

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\Folia\` | 程序本体，卸载时删 |
| `%APPDATA%\Folia\config.json` | 全部设置，含 OBS 端口与 token |
| `%APPDATA%\Folia\` 下其余目录 | 曲库缓存（`Cache`、`media-cache`）、封面（`local-cover-assets`）、转码缓存、日志（`logs`）、Chromium 的 `IndexedDB` / `Local Storage` 等 |

想重置设置：**退出 Folia** 后删掉 `config.json`（或整个 `%APPDATA%\Folia`），重启会
重新生成一份默认配置。注意这会连带清掉登录态、歌单缓存和 token，OBS 地址随之变化
（插件读文件，会自动拿到新的）。

---

## 8. 卸载

用安装目录里的 `Uninstall Folia.exe`，或 Windows「应用和功能」里那条 **Folia 0.7.21**。
（当前用户安装会登记在 `HKCU` 的卸载项里，`UninstallString` 带 `/currentuser`。）
NSIS 卸载脚本会**问一次要不要删除用户数据**：

- 选「是」：删掉 `%APPDATA%\Folia`，设置、缓存、登录态一起没。
- 选「否」（默认）：只删程序，配置留着，重装后还在。

卸载前先退出 Folia。卸载不会动 DSH 那边，`dsh-folia-embed` 按插件 README 的卸载步骤单独删。

---

## 9. macOS / Linux

- **macOS**：`.dmg` 拖进 Applications。首次打开会被 Gatekeeper 拦（未签名），右键 →
  「打开」，或系统设置 → 隐私与安全性里放行。
- **Linux**：`.deb` / `.rpm` / `.tar.gz` 三种；Arch 有 AUR 包 `folia-major-bin`，
  另有社区 Flatpak。`tar.gz` 需要自己解压后运行 `folia-major` 可执行文件。
- **启动参数**在 macOS / Linux 上没有快捷方式可改，直接命令行启动：

  ```bash
  # macOS
  /Applications/Folia.app/Contents/MacOS/Folia --remote-debugging-port=9223 --remote-allow-origins=*

  # Linux
  folia-major --remote-debugging-port=9223 --remote-allow-origins=*
  ```

  但**本插件目前只在 Windows 上验证过**：Host 半侧读的是 `%APPDATA%` /
  `%LOCALAPPDATA%`，控制面板注入的 agent 也是按 Windows 版的 DOM 结构写的。macOS /
  Linux 上背景与状态检测大概率能跑，面板不保证。

---

## 10. 版本与渠道

| 渠道 | 标签 | 当前 | 用途 |
| --- | --- | --- | --- |
| 正式版 | `v0.7.21` | 2026-10-18 | **装这个** |
| Nightly | `limo` | 0.7.21-beta… | 每天构建，功能新、会坏 |
| Canary | `cielo` | 0.7.20-alpha… | 更早的实验分支 |

控制面板之所以要钉正式版：它顺着 React fiber 找到面板自己的 `model.panelProps`
（恰好 `playback / queue / library / account` 四个键）再调回调。这是 Folia 的**内部
结构，不是公开 API**，Nightly 改一次组件层级就可能失效。

插件对此有兜底：注入的 agent 带内容哈希版本号，Folia 更新后会自动重注入；但结构本身
变了，重注入也救不回来——那时面板会整块降级成「控制面板不可用」，背景和播放位置不受
影响。遇到这种情况先在 DSH 里切回正式版，再提 issue。

---

## 11. 安全边界

三件事值得知道：

1. **`9223` 只监听 `127.0.0.1`**（已实测：`netstat` 里是 `TCP 127.0.0.1:9223`，不是
   `0.0.0.0`），局域网里别的机器连不上。但本机任何进程、任何网页都能连——
   `--remote-allow-origins=*` 还取消了 Origin 检查。这个端口等价于「能读写 Folia 页面
   里的一切」，包括你的登录态。不用面板时可以不带这个参数启动，或直接关掉 Folia。
2. **`32108` 的 token 是唯一的访问控制**。它只读、只出画面，但拿到就能看你正在放什么。
   怀疑泄露就在设置页点「重新生成 Token」，旧地址立即失效（OBS 那边要同步改，插件不用）。
3. 插件本身不收集任何东西，所有路由只接受回环地址，动作在 Host 侧过白名单与枚举校验。
   详见 [README](./README.md) 的「实现要点」。
