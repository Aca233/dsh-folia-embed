/**
 * dsh-folia-embed —— 浏览器半侧
 *
 * 做法：在 body 最底层铺一个 fixed 的 iframe，指向 Folia 自带的 OBS 浏览器源
 * （http://127.0.0.1:32108/obs?obs=1&token=…）。歌词动效、可视化、配色全部由
 * Folia 自己渲染，本插件一行动画都不写——这就是「不重复造轮子」。
 *
 * 让背景能透出来的关键：
 *   1. `--dsw-alias-bg-base` / `--dsw-specific-sidebar-fill` 覆盖成 transparent，
 *      这是 frame / 中栏 / 底栏 / 对话容器 / 侧栏共用的底色。一处覆盖，整条
 *      链路都变透明，不会出现多层半透明叠加把背景糊死。
 *   2. 只在 frame 这一层画一次磨砂面板（--dfe-panel + backdrop-filter），
 *      用 `:has(>[data-shell-overlay])` 选中，不依赖哈希过的 class 名。
 *
 * 状态从 Host 侧 `/folia-bg/status` 取（相对路径走 dsh-app 代理），token 与
 * 端口只在 Host 读盘，浏览器侧拿到的就是一条可直接塞进 iframe 的 URL。
 */
window.__ModuleLoader__.load({
  id: 'dsh-folia-embed',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useSyncExternalStore } = React

    const NS = 'dsh-folia-embed'
    const STORE_KEY = NS + '/settings/v2'
    const LEGACY_STORE_KEY = NS + '/settings/v1'
    const LAYER_ID = 'dfe-layer'
    const STYLE_ID = 'dfe-style'
    const POLL_MS = 4000
    const PLAYER_POLL_MS = 1000
    /* 面板快照比播放进度重（要跨一次 CDP 往返 + 读十几个 store），轮询放慢到
       1.5 s；拖动滑块的瞬间用乐观更新顶上去，不靠轮询回显。 */
    const PANEL_POLL_MS = 1500

    /* 默认值走「清晰优先」：歌词要看得见，所以模糊压到 4px、压暗 20%、
       面板 35%。渲染分辨率默认 100%——实测前台运行时 OBS 页面本身能跑到
       140+ FPS，之前的「掉帧」是窗口被浏览器降频造成的误判，不需要降采样。 */
    const DEFAULTS = Object.freeze({ on: false, dim: 20, panel: 35, blur: 4, render: 100, pill: true, player: true })

    /* ── 本地设置 ───────────────────────────────────────────────────────── */

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /* 旧版默认值（45/62/18）。存档里三个值正好等于它，说明用户没调过，
       迁移时换成新的清晰默认值；否则说明是自己调过的，原样保留。 */
    const LEGACY_DEFAULTS = Object.freeze({ dim: 45, panel: 62, blur: 18 })

    function parseStored(key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null')
        return raw && typeof raw === 'object' ? raw : null
      } catch {
        return null
      }
    }

    function readSettings() {
      const current = parseStored(STORE_KEY)
      if (current !== null) return normalize(current, false)
      const legacy = parseStored(LEGACY_STORE_KEY)
      if (legacy !== null) return normalize(legacy, true)
      return { ...DEFAULTS }
    }

    function normalize(raw, fromLegacy) {
      const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
      const next = {
        on: raw.on === true,
        dim: clamp(num(raw.dim, DEFAULTS.dim), 0, 85),
        panel: clamp(num(raw.panel, DEFAULTS.panel), 10, 100),
        blur: clamp(num(raw.blur, DEFAULTS.blur), 0, 40),
        render: clamp(num(raw.render, DEFAULTS.render), 50, 100),
        pill: raw.pill !== false,
        player: raw.player !== false,
      }
      if (!fromLegacy) return next
      const untouched = next.dim === LEGACY_DEFAULTS.dim
        && next.panel === LEGACY_DEFAULTS.panel
        && next.blur === LEGACY_DEFAULTS.blur
      return untouched ? { ...next, dim: DEFAULTS.dim, panel: DEFAULTS.panel, blur: DEFAULTS.blur } : next
    }

    let settings = readSettings()
    const settingsListeners = new Set()

    const settingsStore = {
      get: () => settings,
      subscribe: (listener) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    }

    function patchSettings(patch) {
      settings = { ...settings, ...patch }
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(settings))
      } catch { /* 隐私模式等场景忽略 */ }
      for (const listener of settingsListeners) listener()
    }

    /* ── Host 侧状态 ───────────────────────────────────────────────────── */

    const EMPTY_STATUS = Object.freeze({
      loaded: false,
      installed: false,
      running: false,
      enabled: false,
      url: null,
      reason: 'loading',
    })
    let status = EMPTY_STATUS
    const statusListeners = new Set()

    const statusStore = {
      get: () => status,
      subscribe: (listener) => {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
    }

    function setStatus(next) {
      const merged = { ...EMPTY_STATUS, ...next, loaded: true }
      const same = status.loaded
        && merged.url === status.url
        && merged.relayPort === status.relayPort
        && merged.reason === status.reason
        && merged.installed === status.installed
        && merged.running === status.running
        && merged.enabled === status.enabled
      if (same) return
      status = merged
      for (const listener of statusListeners) listener()
    }

    async function refreshStatus() {
      try {
        const response = await fetch('/folia-bg/status', { cache: 'no-store' })
        const data = await response.json()
        if (!response.ok || !data || data.ok !== true) {
          setStatus({ reason: 'host-error', url: null })
          return
        }
        setStatus({
          installed: data.installed === true,
          running: data.running === true,
          enabled: data.enabled === true,
          url: typeof data.url === 'string' && data.url ? data.url : null,
          port: data.port,
          relayPort: Number.isInteger(Number(data.relayPort)) && Number(data.relayPort) > 0
            ? Number(data.relayPort)
            : null,
          reason: typeof data.reason === 'string' ? data.reason : 'unknown',
        })
      } catch {
        setStatus({ reason: 'host-unreachable', url: null })
      }
    }

    async function launchFolia() {
      try {
        const response = await fetch('/folia-bg/launch', { method: 'POST' })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data.ok !== true) {
          const reason = data.error === 'not-installed' ? 'not-installed'
            : data.error === 'unsupported-platform' ? 'unsupported-platform'
              : 'launch-failed'
          setStatus({ reason, url: null })
          return
        }
        setStatus({ running: true, reason: 'starting' })
        setTimeout(refreshStatus, 1500)
        setTimeout(refreshStatus, 4500)
        setTimeout(refreshStatus, 9000)
      } catch {
        setStatus({ reason: 'host-unreachable', url: null })
      }
    }

    /* ── 播放器状态 ────────────────────────────────────────────────────── */

    /* 进度条不能直接用 Host 给的 positionMs 画。Folia 的 OBS clock 是 4 Hz
       （每 250 ms 一帧），直接拿来做进度条会一顿一顿地跳；两帧之间一旦有网络
       抖动还会往回退。这里的做法是：只在「本地推算值」和「Host 采样值」差得
       足够多（换歌、拖动、暂停恢复）时才重新锚定，其余时间用 performance.now()
       自己往前推——画面就是连续的 60 Hz 而不是 4 Hz。 */
    const DRIFT_TOLERANCE_MS = 900

    const PLAYER_IDLE = Object.freeze({ available: false, track: null })

    let player = PLAYER_IDLE
    let anchor = null
    const playerListeners = new Set()

    const playerStore = {
      get: () => player,
      subscribe: (listener) => {
        playerListeners.add(listener)
        return () => playerListeners.delete(listener)
      },
    }

    /* 每秒都会拿到一个新的 track 对象，但卡片上真正会变的只有这几个字段。
       逐字段比对，避免在整屏逐帧重绘的 iframe 上再叠一层无意义的 React 渲染。 */
    const VIEW_FIELDS = ['title', 'artist', 'album', 'coverPath', 'playerState']

    function sameView(a, b) {
      if (a === b) return true
      if (!a || !b) return false
      if (Math.abs((Number(a.durationMs) || 0) - (Number(b.durationMs) || 0)) >= 1000) return false
      for (const field of VIEW_FIELDS) {
        if (a[field] !== b[field]) return false
      }
      return true
    }

    function setPlayer(next) {
      if (player.available === next.available && sameView(player.track, next.track)) return
      player = next
      for (const listener of playerListeners) listener()
    }

    function sameTrack(a, b) {
      if (!a || !b) return false
      return a.title === b.title
        && a.artist === b.artist
        && Math.abs((Number(a.durationMs) || 0) - (Number(b.durationMs) || 0)) < 1500
    }

    /* 播放卡是否展开。轮询循环必须看得见它：收起后卡片只剩一颗 48px 的胶囊，
       上面一个字都不显示，却还在每秒打一次 /player、1.5 秒一次 CDP 往返
       （Host → WebSocket → 页面 evaluate，是本插件最贵的一条路径）。
       收起时降到慢心跳，展开时立刻补一次。 */
    let cardOpen = true
    const cardOpenListeners = new Set()

    const cardOpenStore = {
      get: () => cardOpen,
      subscribe: (listener) => {
        cardOpenListeners.add(listener)
        return () => cardOpenListeners.delete(listener)
      },
    }

    function setCardOpen(next) {
      if (cardOpen === next) return
      cardOpen = next
      for (const listener of cardOpenListeners) listener()
      /* 展开时立刻补一次：收起期间只走慢心跳，最新一帧可能已经过期了。 */
      if (next) {
        void refreshPlayer()
        void refreshPanel()
      }
    }

    function projectPosition() {
      if (anchor === null) return { positionMs: 0, durationMs: 0, playing: false }
      const duration = anchor.durationMs || 0
      const elapsed = anchor.playing ? (performance.now() - anchor.at) * anchor.rate : 0
      let position = anchor.positionMs + elapsed
      if (duration > 0) position = Math.min(duration, position)
      return { positionMs: Math.max(0, position), durationMs: duration, playing: anchor.playing }
    }

    function anchorTo(track, at, guardUntil) {
      anchor = {
        track,
        positionMs: Number(track.positionMs) || 0,
        durationMs: Number(track.durationMs) || 0,
        playing: track.playerState === 'PLAYING',
        rate: Number(track.playbackRate) > 0 ? Number(track.playbackRate) : 1,
        at,
        guardUntil,
      }
    }

    /* 用户刚拖动/暂停之后，Folia 那边要过一会儿才会把新位置写进 clock 事件。
       这期间的采样还是旧值，若照常按漂移重新锚定，进度条会先被拽回原处再跳到
       目标——也就是肉眼看到的「回退」。所以动作后留一小段观察窗，窗内只更新
       曲目信息，不拿旧样本覆盖本地推算。 */
    const CONTROL_GUARD_MS = 1200

    /* 拖动/方向键改位置：本地立刻跳过去，并开一个观察窗挡住还没更新的旧样本。 */
    function retarget(positionMs) {
      if (anchor === null) return
      const at = performance.now()
      anchor = {
        ...anchor,
        positionMs: clamp(Number(positionMs) || 0, 0, anchor.durationMs || Number.MAX_SAFE_INTEGER),
        at,
        guardUntil: at + CONTROL_GUARD_MS,
      }
    }

    let playerInFlight = false

    async function refreshPlayer() {
      if (playerInFlight) return
      playerInFlight = true
      try {
        const response = await fetch('/folia-bg/player', { cache: 'no-store' })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data || data.ok !== true || data.track == null) {
          anchor = null
          setPlayer(PLAYER_IDLE)
          return
        }
        const track = data.track
        const now = performance.now()
        if (anchor === null || !sameTrack(anchor.track, track)) {
          anchorTo(track, now)
        } else {
          const projected = projectPosition()
          const drift = (Number(track.positionMs) || 0) - projected.positionMs
          const playing = track.playerState === 'PLAYING'
          /* 观察窗内（刚拖动/暂停/播放）只接受「样本已经追上来了」的更新；
             仍旧落后的旧样本一律忽略，免得进度条被拽回去。 */
          const guarded = anchor.guardUntil !== undefined && now < anchor.guardUntil
          if (guarded && (Math.abs(drift) > DRIFT_TOLERANCE_MS || playing !== anchor.playing)) {
            anchor = { ...anchor, track, durationMs: Number(track.durationMs) || anchor.durationMs }
          } else if (Math.abs(drift) > DRIFT_TOLERANCE_MS || playing !== anchor.playing) {
            anchorTo(track, now)
          } else {
            anchor = { ...anchor, track, durationMs: Number(track.durationMs) || anchor.durationMs }
          }
        }
        setPlayer({ available: true, track })
      } catch {
        /* 一次失败不清空：保留上一帧，避免卡片闪断。 */
      } finally {
        playerInFlight = false
      }
    }

    async function sendControl(action, positionMs) {
      const body = positionMs === undefined ? { action } : { action, positionMs }
      const response = await fetch('/folia-bg/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok !== true) return false
      if (action === 'next' || action === 'prev') {
        anchor = null
        setTimeout(refreshPlayer, 520)
        return true
      }
      /* 锚点按「我们下发的意图」挪，不用回包的快照。SMTC 的位置和播放态都是
         异步刷新的，刚下发时往往还是旧值——拿它覆盖本地锚点，进度条就会先跳
         回去再跳回来，也就是肉眼看到的「回退」。真的不一致的话，420 ms 后的
         那次 refreshPlayer 会用 OBS 的 clock 校正回来。 */
      if (anchor !== null) {
        const at = performance.now()
        const guardUntil = at + CONTROL_GUARD_MS
        /* 暂停前先把「此刻推算到的位置」写进锚点。否则 anchor.positionMs 还停在
           上一次采样（或上一次拖动）的位置，projectPosition 在暂停态直接返回它，
           进度条就会往回缩一段。 */
        const frozen = projectPosition().positionMs
        if (action === 'seek') anchor = { ...anchor, positionMs: Number(positionMs) || 0, at, guardUntil }
        else if (action === 'play') anchor = { ...anchor, positionMs: frozen, playing: true, at, guardUntil }
        else if (action === 'pause') anchor = { ...anchor, positionMs: frozen, playing: false, at, guardUntil }
        else if (action === 'toggle') anchor = { ...anchor, positionMs: frozen, playing: !anchor.playing, at, guardUntil }
      }
      setTimeout(refreshPlayer, 420)
      return true
    }

    function formatTime(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    }

    /* ── 控制面板状态（Host 侧 CDP 桥） ────────────────────────────────
     *
     * /folia-bg/panel 返回 Folia 面板的整份快照；动作走同一个地址的 POST。
     * 与 playerStore 分开是因为两者节奏不同：播放进度要 1 s 一次，面板状态
     * 只在打开面板、或者用户动过之后才需要刷新。
     *
     * 快照失败（Folia 没开、9223 没监听）不是错误，是一种状态：面板照常显示
     * 上一份数据，并挂一条「面板不可用」的提示，不去刷控制台。
     */
    const PANEL_IDLE = Object.freeze({ available: false, reason: null, data: null, queue: null })

    let panelState = PANEL_IDLE
    const panelListeners = new Set()
    let panelInFlight = false

    const panelStore = {
      get: () => panelState,
      subscribe: (listener) => {
        panelListeners.add(listener)
        return () => panelListeners.delete(listener)
      },
    }

    function setPanel(next) {
      if (panelState.available === next.available
        && panelState.reason === next.reason
        && panelState.data === next.data
        && panelState.queue === next.queue) return
      panelState = next
      for (const listener of panelListeners) listener()
    }

    /* 队列只在播放列表页可见时才拉：148 条记录 + 每条的封面字段会让一次快照
       从几 KB 涨到几十 KB，而它每秒都要过一遍。 */
    let wantQueue = false

    async function refreshPanel() {
      if (panelInFlight) return
      panelInFlight = true
      try {
        const response = await fetch(`/folia-bg/panel${wantQueue ? '?queue=1' : ''}`, { cache: 'no-store' })
        const data = await response.json().catch(() => null)
        if (!data || data.ok !== true) {
          /* 保留上一份 data 与 queue：9223 偶发超时不该让面板闪成空白。 */
          setPanel({ ...panelState, available: false, reason: (data && data.reason) || 'unreachable' })
          return
        }
        setPanel({
          available: true,
          reason: null,
          data,
          queue: Array.isArray(data.queue) ? data.queue : panelState.queue,
        })
        /* 面板快照里的曲目信息比 OBS 的 SSE 更新（直接读 store），顺手用来
           校正锚点：换歌时不用等下一次 /player 轮询。 */
        if (anchor !== null && data.song && data.durationMs > 0) {
          const track = anchor.track
          if (track && sameTrack(track, {
            title: data.song.name,
            artist: data.song.artist,
            durationMs: data.song.durationMs,
          })) {
            anchor = { ...anchor, durationMs: data.durationMs }
          }
        }
      } catch {
        setPanel({ ...panelState, available: false, reason: 'unreachable' })
      } finally {
        panelInFlight = false
      }
    }

    /* 下发动作。调用方不需要 await 出结果，但要能知道成功与否（例如收藏按钮
       失败时不打勾）。成功后立刻刷一次快照，让开关状态跟手。 */
    async function panelAction(action) {
      try {
        const response = await fetch('/folia-bg/panel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action),
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data || data.ok !== true) return false
        if (action.op === 'playIndex' || action.op === 'next' || action.op === 'prev') anchor = null
        setTimeout(refreshPanel, 220)
        return true
      } catch {
        return false
      }
    }

    /* 面板上的滑杆要跟手：先本地改一份，再下发。下一次快照回来时自然对齐，
       中间不会出现「拖到 40 又弹回 83」的抖动。 */
    function patchPanelData(patch) {
      if (panelState.data === null) return
      setPanel({ ...panelState, data: { ...panelState.data, ...patch } })
    }

    /* ── 样式 ──────────────────────────────────────────────────────────── */

    const CSS = `
#${LAYER_ID}{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background:transparent;contain:strict}
#${LAYER_ID}>iframe{position:absolute;left:50%;top:50%;display:block;border:0;background:transparent;transform:translate(-50%,-50%) scale(var(--dfe-zoom,1.06));filter:var(--dfe-filter,none)}
#${LAYER_ID}>.dfe-scrim{position:absolute;inset:0;pointer-events:none;background:rgb(0 0 0 / var(--dfe-dim,0.45))}
html[data-dfe-on] #root{position:relative;z-index:1;background:transparent}
html[data-dfe-on] #root div:has(>[data-shell-overlay]){background:var(--dfe-panel,rgb(10 11 16 / 0.62)) !important}
.dfe-pill{position:fixed;right:14px;bottom:14px;z-index:30;display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font:500 12px/1 var(--dsw-font-family,system-ui);cursor:pointer;box-shadow:0 2px 10px rgb(0 0 0 / 12%);transition:color .12s,transform .12s}
.dfe-pill:hover{color:var(--dsw-alias-label-primary)}
.dfe-pill:active{transform:scale(.97)}
.dfe-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dfe-dot[data-state=live]{background:#3ddc84}
.dfe-dot[data-state=wait]{background:#f5a524}
.dfe-settings{display:flex;flex-direction:column;gap:18px;padding:4px 0 24px}
.dfe-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1)}
.dfe-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dfe-label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dfe-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dfe-value{font:500 12px/1 var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary);min-width:42px;text-align:right}
.dfe-srange{width:100%;accent-color:var(--dsw-alias-brand-primary)}
.dfe-sbtn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:500 12px/1 var(--dsw-font-family,system-ui);padding:7px 12px;cursor:pointer}
.dfe-sbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dfe-sbtn[disabled]{opacity:.5;cursor:default}
.dfe-sbtn[data-primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dfe-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dfe-actions{display:flex;flex-wrap:wrap;gap:8px}
.dfe-url{font:11px/16px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary);word-break:break-all;max-height:48px;overflow:auto}
@keyframes dfe-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dfe-panel[data-dragging]{cursor:grabbing;user-select:none}
.dfe-close{appearance:none;border:0;background:transparent;color:var(--dfe-t2);cursor:pointer;width:32px;height:32px;border-radius:8px;display:inline-grid;place-items:center;font-size:16px;line-height:1;padding:0;flex:none;transition:background-color .12s,color .12s}
.dfe-close:hover{background:var(--dfe-fill);color:#f4f4f5}
.dfe-track{--dfe-p:0;position:relative;height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.dfe-track::before{content:'';position:absolute;left:0;right:0;height:4px;border-radius:999px;background:var(--dfe-track)}
.dfe-fill{position:absolute;left:0;width:100%;height:4px;border-radius:999px;background:#f4f4f5;pointer-events:none;transform:scaleX(var(--dfe-p));transform-origin:left center}
.dfe-knob{position:absolute;left:calc(var(--dfe-p) * 100%);width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 14%),0 1px 3px rgb(0 0 0 / 35%);transform:translateX(-50%);pointer-events:none;opacity:0;transition:opacity .12s}
.dfe-track:hover .dfe-knob,.dfe-track[data-dragging] .dfe-knob{opacity:1}
.dfe-times{display:flex;justify-content:space-between;font:400 12px/1 var(--dsw-font-family,system-ui);font-variant-numeric:tabular-nums;color:var(--dfe-t2);margin-top:2px}
.dfe-controls{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px}
.dfe-icon{appearance:none;border:0;background:transparent;color:var(--dfe-t2);cursor:pointer;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:background-color .12s,color .12s,scale .12s}
.dfe-icon:hover{background:var(--dfe-fill);color:#f4f4f5}
.dfe-icon:active{scale:.96}
.dfe-icon[disabled]{opacity:.35;cursor:default;background:transparent}
.dfe-icon[data-main]{width:40px;height:40px;border-radius:999px;background:#f4f4f5;color:#17171a}
.dfe-icon[data-main]:hover{background:#fff;color:#17171a}
.dfe-icon svg{width:16px;height:16px;fill:currentColor}
.dfe-icon[data-main] svg{width:18px;height:18px}
.dfe-settings-player{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:12px}

/* ── 整块控制面板 ──────────────────────────────────────────────────── */
/* 尺寸、配色、圆角、字号全部照抄 Folia 歌曲页右下角那块面板
   （st-window + --pn-glass，360px 宽、20px 圆角、12px 内边距）。 */
.dfe-panel{position:fixed;right:14px;bottom:54px;z-index:29;width:360px;max-width:calc(100vw - 2rem);display:flex;flex-direction:column;padding:12px;border-radius:20px;background:var(--dfe-glass,rgb(28 28 31 / .72));color:#f4f4f5;box-shadow:0 30px 80px rgb(0 0 0 / 55%),0 0 0 1px rgb(255 255 255 / 9%);backdrop-filter:blur(40px) saturate(1.3);font:400 12px/1.4 var(--dsw-font-family,system-ui);animation:dfe-in .16s ease-out;  --dfe-t2:rgb(244 244 245 / 62%);--dfe-t3:rgb(244 244 245 / 42%);--dfe-line:rgb(244 244 245 / 8%);--dfe-fill:rgb(244 244 245 / 7%);--dfe-fill2:rgb(244 244 245 / 12%);--dfe-track:rgb(244 244 245 / 17%);--dfe-raise:rgb(255 255 255 / 18%);--dfe-like:#f2607a;--dfe-knob:#ececee}
.dfe-panel-head{display:flex;align-items:center;gap:12px;height:48px;flex:none;min-width:0}
.dfe-panel-cover{width:48px;height:48px;border-radius:8px;flex:none;object-fit:cover;background:var(--dfe-fill);box-shadow:inset 0 0 0 1px var(--dfe-line)}
.dfe-panel-cover[data-empty]{display:flex;align-items:center;justify-content:center;color:var(--dfe-t2);font-size:18px}
.dfe-panel-meta{display:flex;flex-direction:column;min-width:0;flex:1}
.dfe-panel-title{font-size:14px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-panel-sub{font-size:12px;line-height:18px;color:var(--dfe-t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-star{appearance:none;border:0;background:transparent;cursor:pointer;width:32px;height:32px;border-radius:8px;color:var(--dfe-t2);display:inline-grid;place-items:center;flex:none;padding:0;transition:background-color .12s,color .12s,scale .12s}
.dfe-star:hover{background:var(--dfe-fill);color:#f4f4f5}
.dfe-star:active{scale:.96}
.dfe-star[data-on]{color:var(--dfe-like)}
.dfe-star svg{width:17px;height:17px;fill:currentColor}
.dfe-panel-line{height:1px;flex:none;margin-top:12px;background:var(--dfe-line)}
.dfe-panel-body{padding-top:8px;display:flex;flex-direction:column;gap:10px;max-height:min(58vh,430px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dfe-panel-body::-webkit-scrollbar{width:6px}
.dfe-panel-body::-webkit-scrollbar-thumb{background:var(--dfe-fill2);border-radius:999px}
.dfe-panel-foot{flex:none;margin-top:12px;display:flex;flex-direction:column;gap:6px}
/* 标签栏固定在面板最底边，和 Folia 一致：轨道 fill/7%，圆角 10，内边距 2，13px 字。 */
.dfe-tabs{display:flex;width:100%;height:36px;padding:2px;border-radius:10px;background:var(--dfe-fill);flex:none;margin-top:12px}
.dfe-tab{position:relative;flex:1 1 auto;min-width:0;height:100%;border:0;background:transparent;border-radius:8px;padding:0 10px;font:400 13px/1 var(--dsw-font-family,system-ui);color:var(--dfe-t2);cursor:pointer;display:flex;align-items:center;justify-content:center;white-space:nowrap;transition:color .12s}
.dfe-tab:hover{color:#f4f4f5}
.dfe-tab[data-on]{color:#f4f4f5}
.dfe-tab[data-on]::before{content:'';position:absolute;inset:0;border-radius:8px;background:var(--dfe-raise);box-shadow:0 1px 2px rgb(0 0 0 / 20%)}
.dfe-tab>span{position:relative;z-index:1;overflow:hidden;text-overflow:ellipsis}
.dfe-sec{display:flex;flex-direction:column;gap:8px}
.dfe-sec-label{font-size:11.5px;line-height:15px;font-weight:400;color:var(--dfe-t3)}
.dfe-divider{height:1px;background:var(--dfe-line);margin:2px 4px}
/* 分段控件：轨道 fill/7% + 2px 内边距，选中态是一枚 raise/18% 胶囊。 */
.dfe-seg{display:flex;width:100%;padding:2px;border-radius:8px;background:var(--dfe-fill)}
.dfe-seg-btn{appearance:none;border:0;background:transparent;cursor:pointer;flex:1 1 auto;min-width:0;height:28px;padding:0 10px;border-radius:6px;font:400 13px/1 var(--dsw-font-family,system-ui);color:var(--dfe-t2);transition:background-color .12s,color .12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-seg-btn:hover{color:#f4f4f5}
.dfe-seg-btn[data-on]{background:var(--dfe-raise);color:#f4f4f5;box-shadow:0 1px 2px rgb(0 0 0 / 20%)}
.dfe-seg-btn[disabled]{opacity:.4;cursor:default}
/* ‹ 值 › 选择器：两侧 28px 方块，中间 48px 高的一整块。 */
/* ‹ 值 › 选择器展开的二级菜单：照 Folia 的 st-pop —— #2b2b30、14px 圆角、
   上 8 / 下 4 的内边距、3 列 16:10 缩略图网格。挂在 body 上，fixed 定位。 */
.dfe-pop{position:absolute;z-index:60;padding:8px 0 4px;border-radius:14px;background:#2b2b30;color:#f4f4f5;box-shadow:0 14px 36px rgb(0 0 0 / 34%),0 0 0 1px rgb(244 244 245 / 16%);max-height:min(360px,60vh);overflow-y:auto;overscroll-behavior:contain;animation:dfe-pop-in .14s ease-out;transform-origin:center bottom;scrollbar-width:thin;scrollbar-color:rgb(244 244 245 / 22%) transparent}
.dfe-pop::-webkit-scrollbar{width:6px}
.dfe-pop::-webkit-scrollbar-thumb{background:rgb(244 244 245 / 22%);border-radius:999px}
.dfe-pop[data-up]{transform-origin:center top}
@keyframes dfe-pop-in{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
.dfe-pop-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:4px}
.dfe-pop-item{appearance:none;border:0;background:transparent;cursor:pointer;padding:0;display:flex;flex-direction:column;min-width:0;border-radius:8px;color:var(--dfe-t2);font:400 12px/18px var(--dsw-font-family,system-ui);transition:color .12s}
.dfe-pop-item:hover{color:#f4f4f5}
.dfe-pop-thumb{position:relative;display:grid;place-items:center;width:100%;aspect-ratio:16/10;border-radius:8px;background:#151517;box-shadow:inset 0 0 0 1px var(--dfe-line);color:var(--dfe-t2);transition:scale .12s}
.dfe-pop-thumb svg{width:18px;height:18px;fill:currentColor;opacity:.55}
.dfe-pop-item:active .dfe-pop-thumb{scale:.97}
.dfe-pop-item[data-on] .dfe-pop-thumb{box-shadow:inset 0 0 0 2px #f4f4f5}
.dfe-pop-item[data-on] .dfe-pop-thumb svg{opacity:1}
.dfe-pop-label{margin-top:6px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-pop-item[data-on] .dfe-pop-label{font-weight:600;color:#f4f4f5}
.dfe-picker{position:relative;display:flex;align-items:center;gap:4px}
.dfe-step{appearance:none;border:0;background:transparent;color:var(--dfe-t3);cursor:pointer;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;flex:none;padding:0;transition:background-color .12s,color .12s}
.dfe-step:hover{background:var(--dfe-fill);color:#f4f4f5}
.dfe-step[disabled]{opacity:.35;cursor:default;background:transparent}
.dfe-picker-main{appearance:none;border:0;background:transparent;cursor:pointer;flex:1 1 auto;min-width:0;height:48px;border-radius:10px;padding:0 8px 0 6px;display:flex;align-items:center;gap:10px;text-align:left;transition:background-color .12s}
.dfe-picker-main:hover{background:var(--dfe-fill)}
.dfe-picker-art{width:48px;height:30px;flex:none;border-radius:6px;background:var(--dfe-fill);box-shadow:inset 0 0 0 1px var(--dfe-line);display:grid;place-items:center;color:var(--dfe-t2);font-size:13px}
.dfe-picker-text{display:flex;flex-direction:column;min-width:0}
.dfe-picker-label{font-size:11.5px;line-height:15px;color:var(--dfe-t3)}
.dfe-picker-value{font-size:14px;line-height:19px;color:#f4f4f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 音量：1px 轨道 + 白色 16px 圆钮，和 Folia 控制页同一套。 */
.dfe-vol{display:flex;align-items:center;gap:8px;height:40px}
.dfe-vol-num{width:38px;flex:none;text-align:right;font:400 12px/1 var(--dsw-font-family,system-ui);font-variant-numeric:tabular-nums;color:var(--dfe-t2)}
.dfe-range{appearance:none;-webkit-appearance:none;flex:1;min-width:0;height:16px;background:transparent;cursor:pointer;touch-action:none}
.dfe-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dfe-track)}
.dfe-range::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 14%),0 1px 3px rgb(0 0 0 / 35%)}
.dfe-range::-moz-range-track{height:4px;border-radius:999px;background:var(--dfe-track)}
.dfe-range::-moz-range-progress{height:4px;border-radius:999px;background:#f4f4f5}
.dfe-range::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 14%),0 1px 3px rgb(0 0 0 / 35%)}
.dfe-mini{appearance:none;border:0;background:transparent;color:var(--dfe-t2);cursor:pointer;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:none;transition:background-color .12s,color .12s}
.dfe-mini:hover{background:var(--dfe-fill);color:#f4f4f5}
.dfe-mini svg{width:15px;height:15px;fill:currentColor}
/* 三格开关（循环 / 智能过渡 / 音频效果器）：64px 高、10px 圆角。 */
.dfe-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}
.dfe-tile{appearance:none;border:0;background:var(--dfe-fill);color:var(--dfe-t2);cursor:pointer;min-height:64px;min-width:0;border-radius:10px;padding:10px 10px 9px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;text-align:left;font:400 12px/16px var(--dsw-font-family,system-ui);transition:background-color .12s,color .12s,box-shadow .12s}
.dfe-tile:hover{background:var(--dfe-fill2);color:#f4f4f5}
.dfe-tile[data-on]{background:var(--dfe-raise);color:#f4f4f5}
.dfe-tile svg{width:18px;height:18px;fill:currentColor;opacity:.62}
.dfe-tile[data-on] svg{opacity:1}
.dfe-tile span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 开关：40×24 轨道 + 18px 圆钮。 */
.dfe-switchrow{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 0}
.dfe-switchrow>span:first-child{flex:1;min-width:0;font-size:14px;line-height:20px;color:#f4f4f5}
.dfe-switch{appearance:none;border:0;background:var(--dfe-track);cursor:pointer;position:relative;width:40px;height:24px;border-radius:999px;flex:none;padding:0;transition:background-color .12s}
.dfe-switch[data-on]{background:#f4f4f5}
.dfe-switch::after{content:'';position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:var(--dfe-knob);box-shadow:0 1px 2px rgb(0 0 0 / 30%);transition:translate .12s,background-color .12s}
.dfe-switch[data-on]::after{translate:16px 0;background:#17171a}
.dfe-switch[disabled]{opacity:.4;cursor:default}
.dfe-btnrow{display:flex;gap:8px;align-items:center}
.dfe-btnrow>.dfe-seg{flex:1;min-width:0}
.dfe-btn{appearance:none;border:0;background:var(--dfe-fill);color:var(--dfe-t2);cursor:pointer;height:32px;border-radius:8px;padding:0 12px;font:400 12px/1 var(--dsw-font-family,system-ui);display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background-color .12s,color .12s}
.dfe-btn:hover{background:var(--dfe-fill2);color:#f4f4f5}
.dfe-btn[disabled]{opacity:.4;cursor:default}
.dfe-btn[data-on]{background:var(--dfe-raise);color:#f4f4f5}
.dfe-chiprow{display:flex;flex-wrap:wrap;gap:6px}
.dfe-chip{appearance:none;border:0;background:var(--dfe-fill);color:var(--dfe-t2);cursor:pointer;height:28px;padding:0 10px;border-radius:8px;font:400 12px/1 var(--dsw-font-family,system-ui);transition:background-color .12s,color .12s}
.dfe-chip:hover{background:var(--dfe-fill2);color:#f4f4f5}
.dfe-chip[data-on]{background:var(--dfe-raise);color:#f4f4f5}
.dfe-queue{display:flex;flex-direction:column;gap:1px}
.dfe-qhead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dfe-qcount{font-size:12px;color:var(--dfe-t2)}
.dfe-qrow{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px;cursor:pointer;position:relative;min-width:0}
.dfe-qrow:hover{background:var(--dfe-fill)}
.dfe-qrow[data-current]{background:var(--dfe-fill2)}
.dfe-qidx{width:18px;flex:none;text-align:center;font:400 10.5px/1 var(--ds-font-family-code,ui-monospace,monospace);color:var(--dfe-t3)}
.dfe-qmeta{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dfe-qname{font-size:12px;color:#f4f4f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-qsub{font-size:10.5px;color:var(--dfe-t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfe-qacts{display:none;gap:1px;flex:none}
.dfe-qrow:hover .dfe-qacts{display:flex}
.dfe-qrow:hover .dfe-qdur{display:none}
.dfe-qdur{font:400 10.5px/1 var(--ds-font-family-code,ui-monospace,monospace);color:var(--dfe-t3);flex:none}
.dfe-warn{margin:0 0 8px;padding:7px 9px;border-radius:8px;background:rgb(227 169 73 / 16%);color:var(--dfe-t2);font-size:11px;line-height:1.5}
/* 封面页：Folia 那块大封面是 10px 圆角、按面板宽度撑满。 */
.dfe-cover-big{width:100%;height:200px;border-radius:10px;object-fit:cover;background:var(--dfe-fill);box-shadow:inset 0 0 0 1px var(--dfe-line);display:block}
.dfe-cover-big[data-empty]{display:flex;align-items:center;justify-content:center;color:var(--dfe-t2);font-size:30px}
.dfe-secrow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px}
.dfe-secrow>.dfe-sec-label{flex:none}
.dfe-panel-tip{font-size:11px;line-height:1.55;color:var(--dfe-t3)}
/* 面板级提示条：不参与内容区滚动，所以加一点上边距和一条细分隔线，
   免得贴在标签栏上像内容的一部分。 */
.dfe-notice{margin-top:8px;padding-top:8px;border-top:1px solid var(--dfe-line);color:var(--dfe-t2)}
.dfe-notice[data-note]{color:var(--dfe-t3)}
.dfe-panel-tip[data-note]{color:#f4f4f5}
.dfe-empty{padding:6px 2px;font-size:12px;color:var(--dfe-t3);line-height:18px}
.dfe-collapsed{position:fixed;right:14px;bottom:54px;z-index:29;width:48px;height:48px;border-radius:999px;border:1px solid rgb(255 255 255 / 10%);background:rgb(255 255 255 / 8%);color:#f4f4f5;cursor:pointer;display:grid;place-items:center;box-shadow:0 10px 30px rgb(0 0 0 / 40%);backdrop-filter:blur(24px) saturate(1.3);animation:dfe-in .16s ease-out;transition:background-color .16s,scale .16s}
.dfe-collapsed:hover{background:rgb(255 255 255 / 14%)}
.dfe-collapsed:active{scale:.96}
.dfe-collapsed svg{width:20px;height:20px;fill:currentColor}
.dfe-qacts .dfe-mini{width:22px;height:22px;font-size:12px;line-height:1}
`

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ── 背景层 ────────────────────────────────────────────────────────── */

    function ensureLayer() {
      const existing = document.getElementById(LAYER_ID)
      if (existing) return existing
      const layer = document.createElement('div')
      layer.id = LAYER_ID
      layer.setAttribute('aria-hidden', 'true')
      const frame = document.createElement('iframe')
      frame.setAttribute('title', 'Folia lyrics background')
      frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('tabindex', '-1')
      const scrim = document.createElement('div')
      scrim.className = 'dfe-scrim'
      layer.append(frame, scrim)
      document.body.prepend(layer)
      return layer
    }

    /* ── 面板颜色 ──────────────────────────────────────────────────────── */

    function panelColor(percent, scheme) {
      const alpha = clamp(percent / 100, 0.1, 1).toFixed(3)
      return scheme === 'dark' ? `rgb(10 11 16 / ${alpha})` : `rgb(255 255 255 / ${alpha})`
    }

    /** 侧栏再压一层，保证左侧导航文字在复杂画面上仍然读得清。 */
    function sidebarColor(percent, scheme) {
      const alpha = clamp(percent / 100 + 0.12, 0.22, 1).toFixed(3)
      return scheme === 'dark' ? `rgb(10 11 16 / ${alpha})` : `rgb(255 255 255 / ${alpha})`
    }

    /* 内置「表面」：卡片、代码块、下拉、输入框。它们原来都是不透明深灰
       （--dsw-alias-bg-layer-* / --dsw-alias-markdown-code-block，以及几张
       卡片头部用的 --dsw-static-neutral-850），铺在 Folia 上就是一块块灰板。
       改成半透明后，底下已经被「磨砂模糊」处理过的画面直接透上来，等于给
       所有内置表面统一加了一层毛玻璃。

       delta 是相对层级的偏移（百分比）：2 层比 1 层实一点，代码块比卡片薄一点。
       透明度跟「面板不透明度」滑块联动，滑到 100% 基本回到原来的实心。 */
    function surfaceColor(percent, scheme, delta = 0) {
      const alpha = clamp(percent / 100 * 0.54 + 0.26 + delta / 100, 0.22, 0.9)
      return scheme === 'dark'
        ? `rgb(22 22 26 / ${alpha.toFixed(3)})`
        : `rgb(255 255 255 / ${clamp(alpha + 0.14, 0.36, 0.94).toFixed(3)})`
    }

    const surfacePair = (percent, delta = 0) => ({
      light: surfaceColor(percent, 'light', delta),
      dark: surfaceColor(percent, 'dark', delta),
    })

    /* 静态色阶是「方案无关」的：组件自己按亮暗去挑 50/100 还是 800/850
       （body[data-ds-dark-theme] .card{--fill:var(--dsw-static-neutral-850)}）。
       所以覆盖时必须保持这个对应关系——50/100 永远给浅色玻璃，800/850 永远给
       深色玻璃，两种方案下取同一个值，不能让它跟着亮暗翻转。 */
    const staticPair = (percent, scheme, delta = 0) => {
      const value = surfaceColor(percent, scheme, delta)
      return { light: value, dark: value }
    }

    /* 播放卡是照 Folia 面板抄的深色玻璃。原来固定 80% 不透明，压在模糊过的
       背景上几乎等于实心；这里让它跟着同一个滑块走。 */
    function glassColor(percent) {
      return `rgb(28 28 31 / ${clamp(percent / 100 * 0.56 + 0.32, 0.32, 0.9).toFixed(3)})`
    }

    function currentScheme() {
      return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
    }

    /* ── 主装配 ────────────────────────────────────────────────────────── */

    function installBackground(ctx) {
      installStyle()
      const root = document.documentElement

      let layer = null
      let mountedUrl = null
      let themeDispose = null
      let appliedKey = null

      /* 舞台页支持 ?obsPort=<port> 从别处读事件流。把它指到 DSH 自己的端口，
         时钟就由 Host 中继：Host 用 CDP 直接读 Folia 页面里 <audio>.currentTime，
         绕开「Folia 窗口被遮住 → rAF 降到 1 FPS → 发布值滞后一帧」这条链。
         拿不到 relayPort 时退回直连 Folia（行为与之前一致，只是仍会有回退）。 */
      const frameUrl = () => {
        if (status.url === null) return null
        const relayPort = status.relayPort
        if (!Number.isInteger(relayPort) || relayPort <= 0) return status.url
        try {
          const url = new URL(status.url)
          url.searchParams.set('obsPort', String(relayPort))
          return url.toString()
        } catch {
          return status.url
        }
      }

      /* 侧栏 / 窗口标题栏用半透明色而不是全透明：背景再花，导航文字也压得住。
         面板滑块或亮暗主题变化时才重新注册，避免每次轮询都重写 token。

         第二组是「内置表面」：卡片、代码块、下拉、输入框。它们原本是不透明深灰，
         铺在 Folia 上就是一整块灰板。这些 class 名都带哈希（kuvljq_card、
         wY20ga_body…），不能直接选中，所以改在 token 层——这是 DSH 的公开
         扩展点，不依赖任何内部 DOM 结构。

         为什么只改 token 就能有毛玻璃效果：iframe 本身已经按「磨砂模糊」滑块
         做了 blur（--dfe-filter），所以表面变半透明后，透上来的是已经模糊过的
         画面，不需要再叠一层 backdrop-filter（那会二次模糊并多吃一份合成开销）。 */
      const applyTheme = () => {
        const scheme = currentScheme()
        const key = `${settings.panel}:${scheme}`
        if (themeDispose !== null && appliedKey === key) return
        themeDispose?.()
        appliedKey = key
        themeDispose = ctx.theme.overrideTokens(NS, {
          '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
          '--dsw-specific-sidebar-fill': {
            light: sidebarColor(settings.panel, 'light'),
            dark: sidebarColor(settings.panel, 'dark'),
          },
          /* 1 层 = 卡片 / 面板底；2 层 = 按钮 / 输入框。
             不碰 3 层：它有三处被当成**前景色**用（徽标和 tooltip 的文字色是
             background: label-primary + color: bg-layer-3），改成半透明会让
             那些文字跟着透，得不偿失。 */
          '--dsw-alias-bg-layer-1': surfacePair(settings.panel, 0),
          '--dsw-alias-bg-layer-2': surfacePair(settings.panel, 2),
          '--dsw-alias-bg-overlay': surfacePair(settings.panel, 6),
          /* 输入框、用户消息气泡、输入框里的圆钮走的是 --dsw-specific-* 这一组，
             跟卡片那批不是一个来源（卡片是 alias/bg-layer-*，气泡是 specific-*）。
             三个 token 都只当 background 用（分别 6 / 3 / 2 处），可以安全改成半透明。 */
          '--dsw-specific-input-major': surfacePair(settings.panel, 0),
          '--dsw-specific-bubble': surfacePair(settings.panel, 1),
          '--dsw-specific-selector': surfacePair(settings.panel, 4),
          /* 代码块比卡片再薄一点，衬着后面的画面看更通透。 */
          '--dsw-alias-markdown-code-block': surfacePair(settings.panel, -4),
          /* 「已编辑 N 个文件」这类卡片头部、计划卡、日程卡直接引用了静态色阶。
             50/100 只在亮色下被选中，800/850 只在暗色下被选中，所以各自钉死
             成对应方案的玻璃色，不让它随亮暗翻转。 */
          '--dsw-static-neutral-50': staticPair(settings.panel, 'light', 0),
          '--dsw-static-neutral-100': staticPair(settings.panel, 'light', 2),
          '--dsw-static-neutral-800': staticPair(settings.panel, 'dark', 2),
          '--dsw-static-neutral-850': staticPair(settings.panel, 'dark', 0),
        })
      }

      const clearTheme = () => {
        themeDispose?.()
        themeDispose = null
        appliedKey = null
      }

      const sync = () => {
        const state = settings
        const active = state.on && status.url !== null
        root.style.setProperty('--dfe-dim', String(clamp(state.dim / 100, 0, 0.85)))
        /* blur 为 0 时整条 filter 直接置 none：全窗高斯模糊是逐帧重算的，
           1080p 下每帧都要把整张 iframe 重采样一遍，是掉帧的最大单一来源。
           放大 1.06 只是为了盖住模糊在边缘采到透明像素，不模糊时一并去掉，
           省掉一次全屏合成。 */
        root.style.setProperty('--dfe-filter', state.blur > 0 ? `blur(${state.blur}px) saturate(1.1)` : 'none')
        /* --dfe-zoom 写在 iframe 自己身上（下面按渲染分辨率算），这里不再往
           <html> 上写一份——那份没有任何选择器读。 */
        root.style.setProperty('--dfe-panel', panelColor(state.panel, currentScheme()))
        root.style.setProperty('--dfe-glass', glassColor(state.panel))
        root.toggleAttribute('data-dfe-on', active)

        if (!active) {
          layer?.remove()
          layer = null
          mountedUrl = null
          clearTheme()
          return
        }

        layer = ensureLayer()
        /* 渲染分辨率：把 iframe 的布局尺寸按比例缩**小**，再用反比放**大**回满屏。
           Folia 的 canvas 按布局尺寸乘 devicePixelRatio 分配，所以 50% 时它只需
           重绘四分之一的像素，最后由合成器放大——这是省 GPU 的那一侧。
           （反过来写，也就是布局放大 + 缩小，只会让 Folia 画得更大更慢。） */
        const scale = clamp(state.render / 100, 0.5, 1)
        const frame = layer.querySelector('iframe')
        if (frame !== null) {
          frame.style.width = `${scale * 100}%`
          frame.style.height = `${scale * 100}%`
          frame.style.setProperty('--dfe-zoom', String(
            (state.blur > 0 ? 1.06 : 1) / scale,
          ))
        }
        const target = frameUrl()
        if (mountedUrl !== target) {
          mountedUrl = target
          if (frame !== null && target !== null) frame.src = target
        }
        /* 面板滑块变化时侧栏色要跟着走，applyTheme 内部按 panel+亮暗做了去重。 */
        applyTheme()
      }

      const offSettings = settingsStore.subscribe(sync)
      const offStatus = statusStore.subscribe(sync)

      /* 主题切换（亮/暗）时重算面板色，并让侧栏色跟着换一套。 */
      const observer = new MutationObserver(() => {
        root.style.setProperty('--dfe-panel', panelColor(settings.panel, currentScheme()))
        root.style.setProperty('--dfe-glass', glassColor(settings.panel))
        if (themeDispose !== null) applyTheme()
      })
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

      refreshStatus()
      const timer = setInterval(() => {
        if (settings.on || !status.loaded) refreshStatus()
      }, POLL_MS)

      sync()

      return () => {
        clearInterval(timer)
        observer.disconnect()
        offSettings()
        offStatus()
        clearTheme()
        root.removeAttribute('data-dfe-on')
        root.style.removeProperty('--dfe-dim')
        root.style.removeProperty('--dfe-filter')
        root.style.removeProperty('--dfe-panel')
        layer?.remove()
        layer = null
        document.getElementById(STYLE_ID)?.remove()
      }
    }

    /* ── 文案 ──────────────────────────────────────────────────────────── */

    const zh = {
      nav: 'Folia 背景',
      title: 'Folia 歌词舞台',
      desc: '把本机已安装的 Folia 的 OBS 浏览器源铺在窗口背后。歌词动效由 Folia 自己渲染，本插件只负责挂载。',
      enable: '作为窗口背景',
      enableHint: '关闭后立即恢复默认纯色背景。',
      dim: '画面压暗',
      dimHint: '在 Folia 画面上盖一层黑色，压低亮度、保证文字可读。',
      panel: '面板不透明度',
      panelHint: '整个界面上那层磨砂玻璃的不透明度；越低越能看见背景。卡片、代码块、播放卡也一起跟着变。',
      blur: '磨砂模糊',
      blurHint: '模糊背景，文字更清楚；调到 0 就是清晰原画。0 还能省掉每帧一次全屏重采样。',
      render: '渲染分辨率',
      renderHint: 'Folia 逐帧重画画布所用的分辨率。100% 最清晰；画面大且掉帧时往下调。',
      pill: '右下角浮动开关',
      pillHint: '不打开设置也能一键开关背景。',
      player: '右下角播放控制',
      playerHint: '把 Folia 的播放控制（上一首 / 播放暂停 / 下一首 / 进度条）搬到 DSH 里。',
      playerEmpty: 'Folia 里还没有正在播放的歌曲。',
      playerNoHost: 'Folia 未运行，无法控制播放。',
      play: '播放',
      pause: '暂停',
      prev: '上一首',
      next: '下一首',
      close: '收起',
      status: '状态',
      installed: '已安装 Folia',
      notInstalled: '未检测到 Folia',
      notInstalledHint: '请先安装 Folia（github.com/chthollyphile/folia-major），步骤见插件仓库的 INSTALL.md。本插件不内置任何渲染器。',
      running: 'Folia 正在运行',
      notRunning: 'Folia 未运行',
      notRunningHint: '点「启动 Folia」，或自己从开始菜单打开。',
      obsOn: 'OBS 浏览器源已开启',
      obsOff: 'OBS 浏览器源未开启',
      obsOffHint: '在 Folia 设置里打开 OBS 浏览器源，端口默认 32108。',
      launch: '启动 Folia',
      refresh: '重新检测',
      launching: '启动中…',
      on: '已开启',
      off: '已关闭',
      reasonHost: 'DSH Host 侧接口不可用',
      reasonHostHint: '插件 Host 半侧未加载，请重启 DeepSeek Harness。',
      unsupportedPlatform: '本插件只支持 Windows：状态检测读的是 %APPDATA%，播放控制走 Windows 的系统媒体会话（SMTC）。当前系统上背景与控制都不可用。',
      pillUnsupported: 'Folia 背景：当前系统不支持',
      pillOff: 'Folia 背景已关闭',
      pillWait: 'Folia 背景等待中',
      pillLive: 'Folia 背景运行中',
      /* ── 控制面板 ── */
      tabCover: '封面',
      tabLyrics: '歌词',
      tabControls: '控制',
      tabQueue: '播放列表',
      tabQuality: '音质',
      like: '收藏',
      unlike: '取消收藏',
      panelOffline: '控制面板不可用：Folia 需要用带 --remote-debugging-port=9223 的方式启动（点「启动 Folia」，或按 INSTALL.md 第 5 节改快捷方式）。',
      panelEmpty: 'Folia 里还没有正在播放的歌曲。',
      lyricSource: '歌词来源',
      lyricDelete: '删除歌词',
      lyricOffset: '时间轴偏移',
      lyricOffsetHint: '正值让歌词延后，负值让歌词提前。',
      lyricOffsetReset: '归零',
      matchOnline: '在线匹配',
      matchOnlineBusy: '匹配中…',
      lyricFile: '导入 / 导出歌词',
      replayGain: '音频增益',
      replayGainOff: '关闭',
      replayGainTrack: '单曲',
      replayGainAlbum: '专辑',
      replayGainHint: '检测到增益数据时，按单曲或专辑统一播放响度。',
      volume: '音量',
      mute: '静音',
      unmute: '取消静音',
      loopOff: '关闭循环',
      loopAll: '列表循环',
      loopOne: '单曲循环',
      automix: '智能过渡',
      equalizer: '音频效果器',
      lyricStyle: '歌词样式',
      bgType: '背景类型',
      bgLayout: '全屏叠色',
      bgLayoutHint: '背景铺满整屏，或在半屏内做渐变。',
      bgLayoutFull: '全屏叠色',
      bgLayoutHalf: '半屏渐变',
      themeSource: '主题来源',
      themeDefault: '默认',
      themeAi: 'AI 主题',
      themeCustom: '自定义',
      themeName: '主题名称',
      themeDaylight: '明暗模式',
      themeLight: '浅色',
      themeDark: '深色',
      generateAI: '生成AI主题',
      generating: '正在生成主题…',
      queueTitle: '播放队列',
      queueShuffle: '打乱',
      queueEmpty: '播放列表为空',
      playNext: '下一首播放',
      moveEnd: '移到队尾',
      queueRemove: '从队列中删除',
      qualityTitle: '默认音质',
      qStandard: '标准',
      qHigh: '极高',
      qUltra: '超高',
      qLossless: '无损',
      qHires: 'Hi-Res',
      eqFlat: '水平', eqLofi: '低保真', eqRadio: '电台', eqHall: '大厅',
      eqVocal: '人声', eqBass: '低音', eqCustom1: '自定义 1', eqCustom2: '自定义 2',
      visStill: '静止', visClassic: '流光', visCadenza: '心象', visPartita: '云阶',
      visFume: '浮名', visMonet: '莫奈', visCappella: '群唱', visTilt: '倾诉',
      visCladdagh: '回环', visDiorama: '镜台', visPendolo: '时计', visSonnet: '商籁',
      visTempera: '凝彩', visLumiere: '绘光',
      bgCommon: '通用', bgMonet: '莫奈', bgNomand: '漫游', bgLatent: '隐现', bgUrl: '嵌入', bgSora: '空',
      providerNetease: '网易云音乐', providerQq: 'QQ 音乐', providerKugou: '酷狗音乐',
      providerSpotify: 'Spotify', providerAmll: 'AMLLDB',
      lyricNoTrack: '这首歌没有歌词。',
      lyricOnline: '在线歌词',
      lyricLocal: '本地歌词',
      lyricEmbedded: '内嵌歌词',
      lyricImported: '已导入',
      lyricMatched: '已匹配',
      lyricPure: '纯音乐',
      playNow: '立即播放',
      expand: '展开面板',
      collapse: '收起面板',
      duration: '时长',
      queuePos: '队列位置',
      sourceLabel: '音源',
      qualityLabel: '音质',
      noLyricSource: '这首歌没有可用的歌词来源。',
      gainUnavailable: '不可用',
      importLyrics: '导入歌词',
      exportLyrics: '导出歌词',
      importDone: '歌词已导入。',
      importFail: '导入失败：格式不支持或文件为空。',
      exportDone: '歌词已导出。',
      exportFail: '导出失败：当前没有可导出的歌词。',
      matchOnlineFail: '在线匹配失败，请稍后再试。',
      actionFail: '操作没有生效：Folia 的调试端口（9223）没有响应。',
      themeNone: '未命名主题',
      queueLoading: '正在读取播放队列…',
      qualityHint: '所选档位只在平台提供时生效；实际码率取决于账号与曲目。',
      eqOn: '已开启',
      eqOff: '已关闭',
    }

    const en = {
      nav: 'Folia Background',
      title: 'Folia lyrics stage',
      desc: 'Puts the OBS browser source of your locally installed Folia behind the window. Folia renders the lyrics; this plugin only mounts them.',
      enable: 'Use as window background',
      enableHint: 'Turning this off restores the default solid background.',
      dim: 'Dim the stage',
      dimHint: 'Overlays black on the Folia stage so text stays readable.',
      panel: 'Panel opacity',
      panelHint: 'Opacity of the frosted panel covering the whole UI; lower reveals more of the backdrop. Cards, code blocks and the player panel follow it.',
      blur: 'Frosted blur',
      blurHint: 'Blurs the backdrop for legibility; 0 keeps the original artwork sharp (and skips a full-screen resample every frame).',
      render: 'Render scale',
      renderHint: 'Resolution Folia repaints its canvas at. 100% is sharpest; lower it when the stage stutters.',
      pill: 'Floating toggle',
      pillHint: 'Toggle the background without opening settings.',
      player: 'Playback control',
      playerHint: 'Bring Folia’s transport (previous / play-pause / next / seek) into DSH.',
      playerEmpty: 'Nothing is playing in Folia right now.',
      playerNoHost: 'Folia is not running; playback cannot be controlled.',
      play: 'Play',
      pause: 'Pause',
      prev: 'Previous',
      next: 'Next',
      close: 'Collapse',
      status: 'Status',
      installed: 'Folia installed',
      notInstalled: 'Folia not found',
      notInstalledHint: 'Install Folia first (github.com/chthollyphile/folia-major); see INSTALL.md in this repo. This plugin ships no renderer of its own.',
      running: 'Folia is running',
      notRunning: 'Folia is not running',
      notRunningHint: 'Press "Launch Folia", or start it yourself from the Start menu.',
      obsOn: 'OBS browser source enabled',
      obsOff: 'OBS browser source disabled',
      obsOffHint: 'Enable the OBS browser source in Folia settings (default port 32108).',
      launch: 'Launch Folia',
      refresh: 'Check again',
      launching: 'Launching…',
      on: 'On',
      off: 'Off',
      reasonHost: 'DSH Host route unavailable',
      reasonHostHint: 'The Host half is not loaded; restart DeepSeek Harness.',
      unsupportedPlatform: 'This plugin supports Windows only: status detection reads %APPDATA%, and playback control goes through the Windows system media session (SMTC). Neither works on this platform.',
      pillUnsupported: 'Folia background: unsupported platform',
      pillOff: 'Folia background off',
      pillWait: 'Folia background waiting',
      pillLive: 'Folia background running',
      /* ── control panel ── */
      tabCover: 'Cover',
      tabLyrics: 'Lyrics',
      tabControls: 'Controls',
      tabQueue: 'Queue',
      tabQuality: 'Quality',
      like: 'Like',
      unlike: 'Unlike',
      panelOffline: 'Panel unavailable: Folia must start with --remote-debugging-port=9223 (use "Launch Folia", or edit the shortcut per INSTALL.md §5).',
      panelEmpty: 'Nothing is playing in Folia right now.',
      lyricSource: 'Lyric source',
      lyricDelete: 'Remove lyrics',
      lyricOffset: 'Timeline offset',
      lyricOffsetHint: 'Positive delays the lyrics, negative advances them.',
      lyricOffsetReset: 'Reset',
      matchOnline: 'Match online',
      matchOnlineBusy: 'Matching…',
      lyricFile: 'Import / export lyrics',
      replayGain: 'ReplayGain',
      replayGainOff: 'Off',
      replayGainTrack: 'Track',
      replayGainAlbum: 'Album',
      replayGainHint: 'Normalises loudness per track or per album when gain data exists.',
      volume: 'Volume',
      mute: 'Mute',
      unmute: 'Unmute',
      loopOff: 'Loop off',
      loopAll: 'Loop all',
      loopOne: 'Loop one',
      automix: 'Smart transition',
      equalizer: 'Equalizer',
      lyricStyle: 'Lyric style',
      bgType: 'Background type',
      bgLayout: 'Full-screen overlay',
      bgLayoutHint: 'Fill the whole screen, or gradient inside a half pane.',
      bgLayoutFull: 'Full overlay',
      bgLayoutHalf: 'Half pane',
      themeSource: 'Theme source',
      themeDefault: 'Default',
      themeAi: 'AI theme',
      themeCustom: 'Custom',
      themeName: 'Theme name',
      themeDaylight: 'Appearance',
      themeLight: 'Light',
      themeDark: 'Dark',
      generateAI: 'Generate AI theme',
      generating: 'Generating theme…',
      queueTitle: 'Queue',
      queueShuffle: 'Shuffle',
      queueEmpty: 'The queue is empty',
      playNext: 'Play next',
      moveEnd: 'Move to end',
      queueRemove: 'Remove from queue',
      qualityTitle: 'Default quality',
      qStandard: 'Standard',
      qHigh: 'High',
      qUltra: 'Ultra',
      qLossless: 'Lossless',
      qHires: 'Hi-Res',
      eqFlat: 'Flat', eqLofi: 'Lo-fi', eqRadio: 'Radio', eqHall: 'Hall',
      eqVocal: 'Vocal', eqBass: 'Bass', eqCustom1: 'Custom 1', eqCustom2: 'Custom 2',
      visStill: 'Still', visClassic: 'Flow', visCadenza: 'Cadenza', visPartita: 'Cloud',
      visFume: 'Fume', visMonet: 'Monet', visCappella: 'Chorus', visTilt: 'Tilt',
      visCladdagh: 'Loop', visDiorama: 'Diorama', visPendolo: 'Pendulum', visSonnet: 'Sonnet',
      visTempera: 'Tempera', visLumiere: 'Lumiere',
      bgCommon: 'Common', bgMonet: 'Monet', bgNomand: 'Nomad', bgLatent: 'Latent', bgUrl: 'URL', bgSora: 'Empty',
      providerNetease: 'NetEase', providerQq: 'QQ Music', providerKugou: 'Kugou',
      providerSpotify: 'Spotify', providerAmll: 'AMLLDB',
      lyricNoTrack: 'This song has no lyrics.',
      lyricOnline: 'Online lyrics',
      lyricLocal: 'Local lyrics',
      lyricEmbedded: 'Embedded lyrics',
      lyricImported: 'Imported',
      lyricMatched: 'Matched',
      lyricPure: 'Instrumental',
      playNow: 'Play now',
      expand: 'Expand panel',
      collapse: 'Collapse panel',
      duration: 'Duration',
      queuePos: 'Queue',
      sourceLabel: 'Source',
      qualityLabel: 'Quality',
      noLyricSource: 'No lyric source is available for this song.',
      gainUnavailable: 'Unavailable',
      importLyrics: 'Import',
      exportLyrics: 'Export',
      importDone: 'Lyrics imported.',
      importFail: 'Import failed: unsupported format or empty file.',
      exportDone: 'Lyrics exported.',
      exportFail: 'Export failed: no lyrics to export.',
      matchOnlineFail: 'Online match failed; try again later.',
      actionFail: 'That did not take effect: Folia\'s debug port (9223) is not responding.',
      themeNone: 'Untitled theme',
      queueLoading: 'Reading the queue…',
      qualityHint: 'A level applies only when the provider offers it; real bitrate depends on the account and track.',
      eqOn: 'On',
      eqOff: 'Off',
    }

    /* ── 组件 ──────────────────────────────────────────────────────────── */

    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    function StatusBadge({ ok, label }) {
      const color = ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'
      return h('span', { className: 'dfe-badge' },
        h('span', { className: 'dfe-dot', style: { background: color } }),
        label,
      )
    }

    function Slider({ label, hint, value, min, max, step, onChange, suffix }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { className: 'dfe-row' },
          h('span', { className: 'dfe-label' }, label),
          h('span', { className: 'dfe-value' }, `${value}${suffix}`),
        ),
        h('input', {
          className: 'dfe-srange',
          type: 'range', min, max, step, value,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('div', { className: 'dfe-hint' }, hint),
      )
    }

    function ToggleRow({ label, hint, on, onClick, onText, offText }) {
      return h('div', { className: 'dfe-row' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          h('span', { className: 'dfe-label' }, label),
          h('span', { className: 'dfe-hint' }, hint),
        ),
        h('button', {
          type: 'button',
          className: 'dfe-sbtn',
          'data-primary': on ? '' : undefined,
          onClick,
        }, on ? onText : offText),
      )
    }

    function SettingsSection(props) {
      const t = props.t
      const state = useStore(settingsStore)
      const live = useStore(statusStore)
      const [busy, setBusy] = useState(false)

      const launch = async () => {
        setBusy(true)
        try {
          await launchFolia()
        } finally {
          setTimeout(() => setBusy(false), 1500)
        }
      }

      const hostBroken = live.reason === 'host-unreachable' || live.reason === 'host-error'
      /* 非 Windows 上「未检测到 Folia」会把人引去翻安装步骤，而那一步做了也没用。
         这里单独说清楚是平台不支持。 */
      const unsupported = live.reason === 'unsupported-platform'
      const statusLines = []
      if (hostBroken) {
        statusLines.push(h('div', { key: 'host', className: 'dfe-hint' }, `${t('reasonHost')} · ${t('reasonHostHint')}`))
      } else if (unsupported) {
        statusLines.push(h('div', { key: 'platform', className: 'dfe-hint' }, t('unsupportedPlatform')))
      } else {
        statusLines.push(h(StatusBadge, { key: 'installed', ok: live.installed, label: live.installed ? t('installed') : t('notInstalled') }))
        if (!live.installed) statusLines.push(h('div', { key: 'installed-hint', className: 'dfe-hint' }, t('notInstalledHint')))
        statusLines.push(h(StatusBadge, { key: 'running', ok: live.running, label: live.running ? t('running') : t('notRunning') }))
        if (!live.running) statusLines.push(h('div', { key: 'running-hint', className: 'dfe-hint' }, t('notRunningHint')))
        statusLines.push(h(StatusBadge, { key: 'obs', ok: live.enabled && live.url !== null, label: live.enabled ? t('obsOn') : t('obsOff') }))
        if (!live.enabled) statusLines.push(h('div', { key: 'obs-hint', className: 'dfe-hint' }, t('obsOffHint')))
      }

      return h('div', { className: 'dfe-settings' },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h('div', { className: 'dfe-hint', style: { marginTop: 6 } }, t('desc')),
        ),

        h('div', { className: 'dfe-card' },
          h('div', { className: 'dfe-row' },
            h('span', { className: 'dfe-label' }, t('status')),
            h('div', { className: 'dfe-actions' },
              !hostBroken && !live.running && live.installed
                ? h('button', {
                  key: 'launch',
                  type: 'button',
                  className: 'dfe-sbtn',
                  'data-primary': '',
                  disabled: busy,
                  onClick: launch,
                }, busy ? t('launching') : t('launch'))
                : null,
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'dfe-sbtn',
                onClick: () => { refreshStatus() },
              }, t('refresh')),
            ),
          ),
          ...statusLines,
          live.url !== null
            ? h('div', { className: 'dfe-url' }, live.url.replace(/token=[^&]+/, 'token=***'))
            : null,
        ),

        h('div', { className: 'dfe-card' },
          h(ToggleRow, {
            label: t('enable'),
            hint: t('enableHint'),
            on: state.on,
            onText: t('on'),
            offText: t('off'),
            onClick: () => patchSettings({ on: !state.on }),
          }),
          h(Slider, {
            label: t('dim'), hint: t('dimHint'),
            value: state.dim, min: 0, max: 85, step: 5, suffix: '%',
            onChange: (value) => patchSettings({ dim: value }),
          }),
          h(Slider, {
            label: t('panel'), hint: t('panelHint'),
            value: state.panel, min: 10, max: 100, step: 5, suffix: '%',
            onChange: (value) => patchSettings({ panel: value }),
          }),
          h(Slider, {
            label: t('blur'), hint: t('blurHint'),
            value: state.blur, min: 0, max: 40, step: 2, suffix: 'px',
            onChange: (value) => patchSettings({ blur: value }),
          }),
          h(Slider, {
            label: t('render'), hint: t('renderHint'),
            value: state.render, min: 50, max: 100, step: 10, suffix: '%',
            onChange: (value) => patchSettings({ render: value }),
          }),
          h(ToggleRow, {
            label: t('pill'), hint: t('pillHint'),
            on: state.pill,
            onText: t('on'),
            offText: t('off'),
            onClick: () => patchSettings({ pill: !state.pill }),
          }),
          h(ToggleRow, {
            label: t('player'), hint: t('playerHint'),
            on: state.player,
            onText: t('on'),
            offText: t('off'),
            onClick: () => patchSettings({ player: !state.player }),
          }),
        ),
      )
    }

    function Pill(props) {
      const t = props.t
      const state = useStore(settingsStore)
      const live = useStore(statusStore)
      if (!state.pill) return null
      const unsupported = live.reason === 'unsupported-platform'
      const active = state.on && live.url !== null
      const dotState = unsupported ? undefined : active ? 'live' : state.on ? 'wait' : undefined
      const label = unsupported ? t('pillUnsupported') : active ? t('pillLive') : state.on ? t('pillWait') : t('pillOff')
      return h('button', {
        type: 'button',
        className: 'dfe-pill',
        title: label,
        'aria-label': label,
        onClick: () => patchSettings({ on: !state.on }),
      }, h('span', { className: 'dfe-dot', 'data-state': dotState }), 'Folia')
    }

    /* ── 播放控制卡 ────────────────────────────────────────────────────── */

    const ICONS = {
      play: 'M8 5v14l11-7z',
      pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
      prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
      next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
      star: 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z',
      trash: 'M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 12.4a1.6 1.6 0 0 1-1.6 1.6H8.6A1.6 1.6 0 0 1 7 20.4z',
      reset: 'M12 4a8 8 0 1 0 7.7 10.3h-2.1A6 6 0 1 1 12 6v3.2L7.6 5.2 12 .8z',
      volume: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2zM18.6 6.4a8 8 0 0 1 0 11.2l-1.4-1.4a6 6 0 0 0 0-8.4z',
      mute: 'M4 9h4l5-4v14l-5-4H4zm11.6 0 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1z',
      bottom: 'M5 20h14v-2H5zM12 3v9.2l3.6-3.6L17 10l-5 5-5-5 1.4-1.4L12 12.2V3z',
      note: 'M10 4h8v4h-6v10a3 3 0 1 1-2-2.8z',
      repeat: 'M7 4h10a3 3 0 0 1 3 3v5h-2V7a1 1 0 0 0-1-1H7v3L3 5.5 7 2zm10 16H7a3 3 0 0 1-3-3v-5h2v5a1 1 0 0 0 1 1h10v-3l4 3.5-4 3.5z',
      blend: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2v14a7 7 0 0 1 0-14z',
      sliders: 'M4 6h7v2H4zm11 0h5v2h-5zM4 11h3v2H4zm7 0h9v2h-9zM4 16h11v2H4zm15 0h1v2h-1zM11 5h2v4h-2zM7 10h2v4H7zm8 5h2v4h-2z',
    }

    function Icon({ name }) {
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('path', { d: ICONS[name] }),
      )
    }

    /* 进度条按 60 Hz 重画，而不是等 Host 的 4 Hz 采样——条形是连续走的。
       但重画走的是直接写 DOM，不是 setState：卡片底下是一整块逐帧重绘的
       iframe，每秒 20 次 React 渲染叠上去只会让掉帧更明显。 */
    const progressNodes = { now: null, duration: null, bar: null }
    let dragPosition = null

    /* 只写真正变了的字段：textContent 和 aria 属性每秒只会变一次，
       没必要每帧都触发一次 DOM 写入 + 无障碍树更新。
       进度本体走一个自定义属性 + scaleX：合成器直接插值，不触发布局。 */
    function paintProgress() {
      const { now, duration, bar } = progressNodes
      if (bar === null) return
      const projected = projectPosition()
      const durationMs = anchor === null ? 0 : anchor.durationMs
      const positionMs = dragPosition !== null ? dragPosition : projected.positionMs
      const ratio = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0
      const value = ratio.toFixed(4)
      if (bar.style.getPropertyValue('--dfe-p') !== value) {
        bar.style.setProperty('--dfe-p', value)
      }
      if (now !== null) {
        const text = formatTime(positionMs)
        if (now.textContent !== text) now.textContent = text
      }
      if (duration !== null) {
        const text = formatTime(durationMs)
        if (duration.textContent !== text) duration.textContent = text
      }
      const seconds = String(Math.round(positionMs / 1000))
      if (bar.getAttribute('aria-valuenow') !== seconds) bar.setAttribute('aria-valuenow', seconds)
    }

    /* 一个循环服务所有卡片实例；没有在播也没有在拖时直接空转，不碰 DOM。 */
    function startProgressLoop() {
      let frame = 0
      const loop = () => {
        if (dragPosition !== null || (anchor !== null && anchor.playing)) paintProgress()
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(frame)
    }

    function clearProgressNodes() {
      progressNodes.now = null
      progressNodes.duration = null
      progressNodes.bar = null
    }

    /* 音量滑杆在拖动时会连续触发 change。每 120 ms 合并一次下发，
       既不丢最后一次值，也不会把 CDP 往返排成队。 */
    let volumeTimer = 0
    let volumePending = null

    function pushVolume(value) {
      volumePending = value
      if (volumeTimer !== 0) return
      volumeTimer = setTimeout(() => {
        volumeTimer = 0
        const next = volumePending
        volumePending = null
        if (next !== null) void panelAction({ op: 'volume', value: next })
      }, 120)
    }

    const VISUALIZERS = ['still', 'classic', 'cadenza', 'partita', 'fume', 'monet', 'cappella',
      'tilt', 'claddagh', 'diorama', 'pendolo', 'sonnet', 'tempera', 'lumiere']
    const BACKGROUND_MODES = ['common', 'monet', 'nomand', 'latent', 'url', 'sora']
    const QUALITY_LEVELS = ['standard', 'high', 'ultra', 'lossless', 'hires']
    const PANEL_TABS = ['cover', 'lyrics', 'controls', 'queue', 'quality']

    function visLabel(t, mode) {
      const key = 'vis' + mode.charAt(0).toUpperCase() + mode.slice(1)
      return t(key) || mode
    }

    function bgLabel(t, mode) {
      const key = 'bg' + mode.charAt(0).toUpperCase() + mode.slice(1)
      return t(key) || mode
    }

    function qualityLabel(t, level) {
      if (level === 'standard') return t('qStandard')
      if (level === 'high') return t('qHigh')
      if (level === 'ultra') return t('qUltra')
      if (level === 'lossless') return t('qLossless')
      if (level === 'hires') return t('qHires')
      return level
    }

    function formatGain(value) {
      if (typeof value !== 'number' || !isFinite(value)) return null
      return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
    }

    function Seg({ value, options, onChange, disabled }) {
      return h('div', { className: 'dfe-seg' }, options.map((option) => h('button', {
        key: option.value,
        type: 'button',
        className: 'dfe-seg-btn',
        'data-on': option.value === value ? '' : undefined,
        disabled: disabled === true || option.disabled === true,
        title: option.title || undefined,
        onClick: () => {
          if (option.disabled === true || option.value === value) return
          onChange(option.value)
        },
      }, option.label)))
    }

/* 二级菜单里每一格左上角的示意图标。背景类型那 6 个是从 Folia 的
   st-pop 里原样抄下来的（它自己就用这套 SVG）；歌词样式同理——
   Folia 有一半样式在预览画布还没画出来时也退回这套图标。 */
const POP_ICONS = {
  /* 歌词样式 */
  still: '<path d="M4 12h16"/>',
  classic: '<path d="M4 8h16" opacity="0.55"/><path d="M4 12h16"/><path d="M4 16h16" opacity="0.55"/>',
  cadenza: '<path d="M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9z"/>',
  partita: '<path d="M4 19h5v-5h5v-5h6"/>',
  fume: '<path d="M6 7.5h9" opacity="0.3"/><path d="M1 12h22"/><path d="M9 16.5h9" opacity="0.3"/>',
  tilt: '<path d="M4 9h16"/><path d="M5 16.5l14-3" opacity="0.55"/>',
  claddagh: '<ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-18 12 12)"/><circle cx="18" cy="9" r="1.5" fill="currentColor" stroke="none"/>',
  monet: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-2-1-3 1-2 3-2h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8z"/><circle cx="8" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1.2" fill="currentColor" stroke="none"/>',
  pendolo: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cappella: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 0 1 0 5.9"/><path d="M17 14.2c2.4.7 4 2.9 4 5.8"/>',
  diorama: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5" opacity="0.55"/>',
  sonnet: '<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  tempera: '<path d="M12 3s6 6.2 6 10a6 6 0 0 1-12 0c0-3.8 6-10 6-10z"/>',
  lumiere: '<path d="M12 3.5 13.6 9l5.4 1.6L13.6 12 12 17.5 10.4 12 5 10.6 10.4 9z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  /* 背景类型（Folia 原样） */
  common: '<path d="M4 17l5-8 5 8z"/><circle cx="17.5" cy="8.5" r="3" opacity="0.55"/>',
  nomand: '<rect x="4" y="4" width="6.5" height="6.5" rx="0.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="0.8" opacity="0.45"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="0.8" opacity="0.45"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="0.8"/>',
  latent: '<path d="M4.5 7.5h.01M9 7.5h.01M13.5 7.5h.01M18 7.5h.01" stroke-width="2.2" opacity="0.55"/><path d="M3 15c3-3.5 6-3.5 9 0s6 3.5 9 0"/>',
  url: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17" opacity="0.55"/>',
  sora: '<path d="M12 5.5l1.2 2.9 2.9 1.2-2.9 1.2L12 13.7l-1.2-2.9-2.9-1.2 2.9-1.2z"/><path d="M5.5 16.5h.01M18 15.5h.01M7 7h.01" stroke-width="2.2" opacity="0.5"/>',
  /* 背景类型的 monet 与歌词样式的同名项共用一枚画框 */
  frame: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M20.5 8.5L8 19.5" opacity="0.55"/>',
}

/* 歌词样式里的 monet 和背景类型里的 monet 不同形，靠 scope 区分。 */
const POP_ICON_OVERRIDES = { 'visualizer:monet': 'monet', 'background:monet': 'frame' }

function popIcon(scope, value) {
  const key = POP_ICON_OVERRIDES[`${scope}:${value}`] || value
  return POP_ICONS[key] || POP_ICONS.common
}

    /* 与 Folia 控制页同款的 ‹ 值 › 选择器：两侧 28px 方块，中间一整块
       48px 高的按钮（左边一枚 48×30 的示意图标，右边上下两行标签/值）。
       点中间那块会展开一个二级菜单，和 Folia 一样。 */
    function Picker({ label, value, art, onStep, onOpen, open }) {
      return h('div', { className: 'dfe-picker' },
        h('button', {
          type: 'button', className: 'dfe-step',
          'aria-label': `${label} −`, onClick: () => onStep(-1),
        }, '‹'),
        h('button', {
          type: 'button', className: 'dfe-picker-main',
          'aria-label': label,
          'aria-expanded': open ? 'true' : 'false',
          onClick: (event) => onOpen(event.currentTarget),
        },
          h('span', { className: 'dfe-picker-art', 'aria-hidden': 'true' }, art || '◈'),
          h('span', { className: 'dfe-picker-text' },
            h('span', { className: 'dfe-picker-label' }, label),
            h('span', { className: 'dfe-picker-value' }, value),
          ),
        ),
        h('button', {
          type: 'button', className: 'dfe-step',
          'aria-label': `${label} +`, onClick: () => onStep(1),
        }, '›'),
      )
    }

    /* 二级菜单挂在面板这一层（不是滚动区里），否则会被内容区的 overflow 裁掉。
       anchor 是触发块相对面板的坐标，左右与上下都按面板边界夹取。 */
    function Popover({ anchor, label, options, value, scope, up, onPick }) {
      return h('div', {
        className: 'dfe-pop',
        role: 'radiogroup',
        'aria-label': label,
        'data-up': up ? '' : undefined,
        style: up
          ? { left: anchor.left, width: anchor.width, bottom: anchor.bottom }
          : { left: anchor.left, width: anchor.width, top: anchor.top },
      },
        h('div', { className: 'dfe-pop-grid' }, options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'radio',
          className: 'dfe-pop-item',
          'data-on': option.value === value ? '' : undefined,
          'aria-checked': option.value === value ? 'true' : 'false',
          onClick: () => onPick(option.value),
        },
          h('span', {
            className: 'dfe-pop-thumb',
            'aria-hidden': 'true',
            dangerouslySetInnerHTML: { __html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${popIcon(scope, option.value)}</svg>` },
          }),
          h('span', { className: 'dfe-pop-label' }, option.label),
        ))),
      )
    }

    function PlayerCard(props) {
      const t = props.t
      const state = useStore(settingsStore)
      const live = useStore(statusStore)
      const current = useStore(playerStore)
      const panel = useStore(panelStore)
      const track = current.track
      const data = panel.data

      const [tab, setTab] = useState('cover')
      /* 展开状态放在模块级：轮询循环要知道卡片是不是收起了。 */
      const open = useSyncExternalStore(cardOpenStore.subscribe, cardOpenStore.get, cardOpenStore.get)
      const setOpen = setCardOpen
      const [dragging, setDragging] = useState(false)
      const [coverBroken, setCoverBroken] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      /* 哪个 ‹ 值 › 选择器的二级菜单开着（null = 都关着）。
         和 Folia 一样：点中间那块展开，选一项或点外面就收起。
         anchor 是触发块相对面板的 top / bottom —— 弹层挂在面板这一层，
         才不会被内容区的 overflow 裁掉。 */
      const [popover, setPopover] = useState(null)
      const panelRef = useRef(null)
      const barRef = useRef(null)
      const nowRef = useRef(null)
      const durationRef = useRef(null)
      const fileRef = useRef(null)

      const key = track === null ? '' : `${track.title ?? ''}|${track.artist ?? ''}`
      useEffect(() => { setCoverBroken(false) }, [key])

      /* 把进度相关的 DOM 节点登记给 rAF 循环；换歌/收起时自然换成新节点。 */
      useEffect(() => {
        progressNodes.bar = barRef.current
        progressNodes.now = nowRef.current
        progressNodes.duration = durationRef.current
        paintProgress()
        return clearProgressNodes
      })

      /* 队列只在播放列表页打开时才拉：一次快照会从几 KB 涨到几十 KB。 */
      useEffect(() => {
        wantQueue = tab === 'queue'
        if (tab === 'queue') void refreshPanel()
      }, [tab])

      useEffect(() => {
        void refreshPanel()
        return () => { wantQueue = false }
      }, [])

      /* 弹层锚点：触发块相对面板的坐标。上方空间够就朝上弹，否则朝下；
         左右按面板宽度夹一下，免得 360px 的弹层顶出面板外。 */
      const anchorPopover = (key, el) => {
        const panel = panelRef.current
        if (panel === null || el === null) return null
        const p = panel.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        const pad = 12
        const width = Math.min(p.width - pad * 2, 336)
        const left = clamp(r.left - p.left, pad, p.width - pad - width)
        return {
          key,
          left,
          width,
          top: r.bottom - p.top + 6,
          bottom: p.bottom - r.top + 6,
          up: r.top - p.top > 260,
        }
      }

      const popoverDef = popover === null ? null : (popover.key === 'visualizer'
        ? {
          label: t('lyricStyle'), scope: 'visualizer',
          value: data ? data.visualizerMode : null,
          options: VISUALIZERS.map((mode) => ({ value: mode, label: visLabel(t, mode) })),
          onPick: (value) => {
            setPopover(null)
            void run({ op: 'visualizer', value }, { visualizerMode: value })
          },
        }
        : {
          label: t('bgType'), scope: 'background',
          value: data ? data.backgroundMode : null,
          options: BACKGROUND_MODES.map((mode) => ({ value: mode, label: bgLabel(t, mode) })),
          onPick: (value) => {
            setPopover(null)
            void run({ op: 'backgroundMode', value }, { backgroundMode: value })
          },
        })

      /* 提示条 4 秒后自己消失。 */
      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      /* 二级菜单：点面板别处、按 Esc、切标签页都要收起。 */
      useEffect(() => {
        if (popover === null) return undefined
        const onDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.dfe-pop') !== null) return
          if (target instanceof Element && target.closest('.dfe-picker') !== null) return
          setPopover(null)
        }
        const onKey = (event) => { if (event.key === 'Escape') setPopover(null) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [popover])

      useEffect(() => { setPopover(null) }, [tab])

      if (!state.player) return null
      /* 非 Windows：控制走 SMTC、面板走 9223，这张卡没有一项能工作，不渲染。 */
      if (live.reason === 'unsupported-platform') return null

      const song = (data && data.song) || null
      const title = song ? song.name : (track ? track.title : null)
      const artist = song ? song.artist : (track ? track.artist : null)
      const album = song ? song.album : (track ? track.album : null)
      /* 封面优先走同源代理（track.coverPath，由 Host 侧 /folia-bg/cover 转发并
         缓存）。song.coverUrl / track.coverUrl 是 p4.music.126.net 这类远程地址——
         实测能显示，但那意味着把用户的 IP / UA 直接打到网易云 CDN，而且换歌时
         每个客户端都要自己去拉一遍原图。代理只在拿不到 coverPath 时兜底
         （例如只剩 SMTC 通道、面板快照不可用的时候）。 */
      const coverUrl = (track && track.coverPath)
        || (song && song.coverUrl)
        || (track && track.coverUrl)
        || null
      const durationMs = track === null ? (song ? song.durationMs : 0) : (Number(track.durationMs) || 0)
      const playing = track ? track.playerState === 'PLAYING' : !!(data && data.playing)
      const offline = panel.available === false

      const ratioFromEvent = (event) => {
        const rect = barRef.current?.getBoundingClientRect()
        if (!rect || rect.width === 0) return 0
        return clamp((event.clientX - rect.left) / rect.width, 0, 1)
      }

      const onPointerDown = (event) => {
        if (!track || durationMs <= 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        dragPosition = ratioFromEvent(event) * durationMs
        setDragging(true)
        paintProgress()
      }

      const onPointerMove = (event) => {
        /* 以 dragPosition 为准，而不是 dragging 这个 state：state 要等一次重渲染
           才生效，若 pointermove 抢在渲染之前到达就会被丢掉。 */
        if (dragPosition === null) return
        dragPosition = ratioFromEvent(event) * durationMs
        paintProgress()
      }

      const onPointerUp = async (event) => {
        if (dragPosition === null) return
        const target = ratioFromEvent(event) * durationMs
        dragPosition = null
        setDragging(false)
        retarget(target)
        paintProgress()
        await sendControl('seek', Math.round(target))
      }

      const onSeekKey = async (event) => {
        if (!track || durationMs <= 0) return
        const step = event.shiftKey ? 30_000 : 5_000
        const from = projectPosition().positionMs
        let target = null
        if (event.key === 'ArrowLeft') target = Math.max(0, from - step)
        else if (event.key === 'ArrowRight') target = Math.min(durationMs, from + step)
        if (target === null) return
        event.preventDefault()
        retarget(target)
        paintProgress()
        await sendControl('seek', Math.round(target))
      }

      /* 面板动作统一走这里：先乐观改本地快照（滑杆、开关立刻跟手），再下发。
         下发失败必须让用户知道——乐观更新会在下一次快照（~1.5 s）被真值覆盖，
         否则用户看到的是「勾上了又自己弹回去」，而没有任何解释。 */
      const run = (action, patch) => {
        if (patch) patchPanelData(patch)
        return panelAction(action).then((ok) => {
          if (!ok) {
            setNotice({ kind: 'err', text: t('actionFail') })
            /* 立刻拉一次真值，别让乐观更新挂在那里等到下一拍。 */
            void refreshPanel()
          }
          return ok
        })
      }

      const onLike = () => {
        if (!data) return
        const next = !data.liked
        void run({ op: 'like', value: next }, { liked: next })
      }

      const onCycleLoop = () => {
        if (!data) return
        const order = ['off', 'all', 'one']
        const next = order[(order.indexOf(data.loopMode) + 1 + order.length) % order.length]
        void run({ op: 'loop', value: next }, { loopMode: next })
      }

      const onVolume = (value) => {
        patchPanelData({ volume: value })
        pushVolume(value)
      }

      const onMute = () => {
        if (!data) return
        const next = !data.muted
        void run({ op: 'mute', value: next }, { muted: next })
      }

      const stepList = (list, value, delta) => {
        const index = list.indexOf(value)
        const from = index < 0 ? 0 : index
        return list[(from + delta + list.length) % list.length]
      }

      const onOffset = (delta) => {
        if (!data) return
        const next = clamp((Number(data.lyricOffsetMs) || 0) + delta * 250, -60_000, 60_000)
        void run({ op: 'lyricOffset', value: next }, { lyricOffsetMs: next })
      }

      const onPickFile = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = async () => {
          const text = typeof reader.result === 'string' ? reader.result : ''
          const ok = text !== '' && await panelAction({ op: 'importLyrics', text, name: file.name })
          setNotice({ kind: ok ? 'ok' : 'err', text: ok ? t('importDone') : t('importFail') })
        }
        reader.onerror = () => setNotice({ kind: 'err', text: t('importFail') })
        reader.readAsText(file)
      }

      /* 导出：Host 侧把 Folia 当前歌词按 LRC 拼好回传，这里落成文件。
         浏览器拒绝下载时退回剪贴板，至少不让操作白点。 */
      const onExport = async () => {
        setBusy(true)
        try {
          const response = await fetch('/folia-bg/panel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'exportLyrics' }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true || !payload.text) {
            setNotice({ kind: 'err', text: t('exportFail') })
            return
          }
          const blob = new Blob([payload.text], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = payload.name || 'lyrics.lrc'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setNotice({ kind: 'ok', text: t('exportDone') })
        } catch {
          setNotice({ kind: 'err', text: t('exportFail') })
        } finally {
          setBusy(false)
        }
      }

      const onMatch = async () => {
        setBusy(true)
        try {
          const ok = await panelAction({ op: 'matchOnlineLyrics' })
          if (!ok) setNotice({ kind: 'err', text: t('matchOnlineFail') })
        } finally {
          setTimeout(() => setBusy(false), 600)
        }
      }

      const queue = Array.isArray(panel.queue) ? panel.queue : null
      const currentIndex = data ? Number(data.queueIndex) : -1
      const queueLength = data ? Number(data.queueLength) || 0 : 0

      /* ── 封面 ── */
      /* Folia 的封面页就是这首歌本身：大封面 + 歌名 / 歌手 / 专辑 + 一行动作。 */
      const coverTab = data === null ? null : h(React.Fragment, null,
        coverUrl && !coverBroken
          ? h('img', {
            className: 'dfe-cover-big', src: coverUrl, alt: '', draggable: false,
            onError: () => setCoverBroken(true),
          })
          : h('div', { className: 'dfe-cover-big', 'data-empty': '', 'aria-hidden': 'true' }, '♪'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 } },
          h('div', { style: { fontSize: 18, fontWeight: 600, lineHeight: '26px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }, title: title || '' },
            title || '—'),
          h('div', { style: { marginTop: 2, fontSize: 13, lineHeight: '20px', color: 'var(--dfe-t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: artist || '' },
            artist || '—'),
          h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dfe-t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: album || '' },
            album || '—'),
        ),
        /* 动作行：收藏 / 队列位置 / 时长 / 音质。Folia 原版是收藏 + 歌单 + 主页 + 选项，
           这里换成 DSH 里真正能用的四个。 */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
          h('button', {
            type: 'button', className: 'dfe-mini',
            'data-on': data.liked ? '' : undefined,
            style: data.liked ? { background: 'var(--dfe-fill)', color: 'var(--dfe-like)' } : { background: 'var(--dfe-fill)' },
            title: data.liked ? t('unlike') : t('like'),
            'aria-label': data.liked ? t('unlike') : t('like'),
            onClick: onLike,
          }, h(Icon, { name: 'star' })),
          h('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 999, background: 'var(--dfe-fill)', fontSize: 12, color: 'var(--dfe-t2)', whiteSpace: 'nowrap' },
          }, `${currentIndex >= 0 ? currentIndex + 1 : '—'} / ${queueLength || '—'}`),
          h('span', { style: { flex: 1, minWidth: 6 } }),
          h('span', {
            style: { height: 28, padding: '0 10px', borderRadius: 999, background: 'var(--dfe-fill)', fontSize: 12, color: 'var(--dfe-t2)', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' },
          }, formatTime(durationMs)),
        ),
      )

      /* ── 歌词 ── */
      const sources = (data && Array.isArray(data.lyricSources)) ? data.lyricSources : []
      const gainTrack = data && data.replayGainValues ? formatGain(data.replayGainValues.trackGain) : null
      const gainAlbum = data && data.replayGainValues ? formatGain(data.replayGainValues.albumGain) : null
      const gainHint = data === null
        ? ''
        : data.replayGainMode === 'track'
          ? (gainTrack || t('gainUnavailable'))
          : data.replayGainMode === 'album'
            ? (gainAlbum || t('gainUnavailable'))
            : t('replayGainHint')

      const lyricsTab = data === null ? null : h(React.Fragment, null,
        h('div', { className: 'dfe-sec' },
          h('div', { className: 'dfe-secrow' },
            h('span', { className: 'dfe-sec-label' }, t('lyricSource')),
            data.canClearLyrics
              ? h('button', {
                type: 'button', className: 'dfe-mini', title: t('lyricDelete'), 'aria-label': t('lyricDelete'),
                onClick: () => { void run({ op: 'clearLyrics' }) },
              }, h(Icon, { name: 'trash' }))
              : null,
          ),
          sources.length > 1
            ? h(Seg, {
              value: data.activeLyricSource,
              options: sources.map((source) => ({ value: source.key, label: source.label })),
              onChange: (value) => { void run({ op: 'changeLyricsSource', value }, { activeLyricSource: value }) },
            })
            : h('div', { className: 'dfe-panel-tip' }, sources.length > 0 ? sources[0].label : t('noLyricSource')),
        ),

        h('div', { className: 'dfe-sec' },
          h('div', { className: 'dfe-secrow' },
            h('span', { className: 'dfe-sec-label' }, t('lyricOffset')),
            data.lyricOffsetMs !== 0
              ? h('button', {
                type: 'button', className: 'dfe-mini', title: t('lyricOffsetReset'), 'aria-label': t('lyricOffsetReset'),
                onClick: () => { void run({ op: 'lyricOffset', value: 0 }, { lyricOffsetMs: 0 }) },
              }, h(Icon, { name: 'reset' }))
              : null,
          ),
          h('div', { className: 'dfe-picker' },
            h('button', {
              type: 'button', className: 'dfe-step', 'aria-label': '−250 ms',
              onClick: () => onOffset(-1),
            }, '‹'),
            h('span', { className: 'dfe-picker-value', style: { flex: 1, textAlign: 'center' } },
              `${data.lyricOffsetMs > 0 ? '+' : ''}${data.lyricOffsetMs} ms`),
            h('button', {
              type: 'button', className: 'dfe-step', 'aria-label': '+250 ms',
              onClick: () => onOffset(1),
            }, '›'),
          ),
          h('div', { className: 'dfe-panel-tip' }, t('lyricOffsetHint')),
        ),

        h('div', { className: 'dfe-btnrow' },
          h('button', {
            type: 'button', className: 'dfe-btn', disabled: busy, onClick: onMatch,
          }, busy ? t('matchOnlineBusy') : t('matchOnline')),
          h('button', {
            type: 'button', className: 'dfe-btn',
            onClick: () => fileRef.current?.click(),
          }, t('importLyrics')),
          h('button', {
            type: 'button', className: 'dfe-btn', disabled: busy || data.hasLyrics !== true, onClick: onExport,
          }, t('exportLyrics')),
        ),
        h('input', {
          type: 'file',
          ref: fileRef,
          accept: '.lrc,.vtt,.ttml,.qrc,.yrc,.krc,.txt,.fia,.json',
          style: { display: 'none' },
          onChange: onPickFile,
        }),

        h('div', { className: 'dfe-divider' }),

        h('div', { className: 'dfe-sec' },
          h('div', { className: 'dfe-secrow' },
            h('span', { className: 'dfe-sec-label' }, t('replayGain')),
            h('span', { className: 'dfe-panel-tip', 'data-note': gainHint !== t('replayGainHint') ? '' : undefined }, gainHint),
          ),
          h(Seg, {
            value: data.replayGainMode,
            options: [
              { value: 'off', label: t('replayGainOff') },
              { value: 'track', label: t('replayGainTrack'), disabled: gainTrack === null },
              { value: 'album', label: t('replayGainAlbum'), disabled: gainAlbum === null },
            ],
            onChange: (value) => { void run({ op: 'replayGain', value }, { replayGainMode: value }) },
          }),
          h('div', { className: 'dfe-panel-tip' }, gainTrack === null && gainAlbum === null
            ? t('gainUnavailable')
            : `${t('replayGainTrack')} ${gainTrack || '—'} · ${t('replayGainAlbum')} ${gainAlbum || t('gainUnavailable')}`),
        ),
      )

      /* ── 控制 ── */
      const themeOptions = (data && data.theme && data.theme.options && data.theme.options.length > 0)
        ? data.theme.options
        : [{ key: 'default', available: true }, { key: 'ai', available: true }, { key: 'custom', available: true }]
      const themeLabel = (key) => (key === 'ai' ? t('themeAi') : key === 'custom' ? t('themeCustom') : t('themeDefault'))
      const themeValue = data && data.theme ? data.theme.activeSource : 'default'
      const themeName = data && data.theme && data.theme.name ? data.theme.name : t('themeNone')

      const controlsTab = data === null ? null : h(React.Fragment, null,
        /* 音量一行：静音钮 + 滑杆 + 百分比，和 Folia 控制页顶部同一行。 */
        h('div', { className: 'dfe-vol' },
          h('button', {
            type: 'button', className: 'dfe-mini',
            title: data.muted ? t('unmute') : t('mute'),
            'aria-label': data.muted ? t('unmute') : t('mute'),
            onClick: onMute,
          }, h(Icon, { name: data.muted ? 'mute' : 'volume' })),
          h('input', {
            className: 'dfe-range',
            type: 'range', min: 0, max: 100, step: 1,
            value: Math.round((data.volume || 0) * 100),
            'aria-label': t('volume'),
            onChange: (event) => onVolume(Number(event.target.value) / 100),
          }),
          h('span', { className: 'dfe-vol-num' }, `${Math.round((data.volume || 0) * 100)}%`),
        ),

        /* 三格：循环 / 智能过渡 / 音频效果器。前两格是开关，第三格是入口。 */
        h('div', { className: 'dfe-grid3' },
          h('button', {
            type: 'button', className: 'dfe-tile',
            'data-on': data.loopMode !== 'off' ? '' : undefined,
            'aria-pressed': data.loopMode !== 'off' ? 'true' : 'false',
            title: data.loopMode === 'off' ? t('loopOff') : data.loopMode === 'one' ? t('loopOne') : t('loopAll'),
            onClick: onCycleLoop,
          },
            h('span', { 'aria-hidden': 'true' }, h(Icon, { name: 'repeat' })),
            h('span', null, data.loopMode === 'off' ? t('loopOff') : data.loopMode === 'one' ? t('loopOne') : t('loopAll')),
          ),
          h('button', {
            type: 'button', className: 'dfe-tile',
            'data-on': data.automixEnabled ? '' : undefined,
            'aria-pressed': data.automixEnabled ? 'true' : 'false',
            onClick: () => {
              const next = !data.automixEnabled
              void run({ op: 'automix', value: next }, { automixEnabled: next })
            },
          },
            h('span', { 'aria-hidden': 'true' }, h(Icon, { name: 'blend' })),
            h('span', null, t('automix')),
          ),
          h('button', {
            type: 'button', className: 'dfe-tile',
            'data-on': data.eqEnabled ? '' : undefined,
            'aria-pressed': data.eqEnabled ? 'true' : 'false',
            onClick: () => {
              const next = !data.eqEnabled
              void run({ op: 'eqEnabled', value: next }, { eqEnabled: next })
            },
          },
            h('span', { 'aria-hidden': 'true' }, h(Icon, { name: 'sliders' })),
            h('span', null, t('equalizer')),
          ),
        ),

        h('div', { className: 'dfe-divider' }),

        h(Picker, {
          label: t('lyricStyle'),
          value: visLabel(t, data.visualizerMode),
          art: '✧',
          open: popover !== null && popover.key === 'visualizer',
          onOpen: (el) => setPopover(popover !== null && popover.key === 'visualizer' ? null : anchorPopover('visualizer', el)),
          onStep: (delta) => {
            const next = stepList(VISUALIZERS, data.visualizerMode, delta)
            void run({ op: 'visualizer', value: next }, { visualizerMode: next })
          },
        }),
        h(Picker, {
          label: t('bgType'),
          value: bgLabel(t, data.backgroundMode),
          art: '▤',
          open: popover !== null && popover.key === 'background',
          onOpen: (el) => setPopover(popover !== null && popover.key === 'background' ? null : anchorPopover('background', el)),
          onStep: (delta) => {
            const next = stepList(BACKGROUND_MODES, data.backgroundMode, delta)
            void run({ op: 'backgroundMode', value: next }, { backgroundMode: next })
          },
        }),
        h('div', { className: 'dfe-sec' },
          h('span', { className: 'dfe-sec-label' }, t('bgLayout')),
          h(Seg, {
            value: data.backgroundLayout,
            options: [
              { value: 'full-overlay', label: t('bgLayoutFull') },
              { value: 'half-pane-gradient', label: t('bgLayoutHalf') },
            ],
            onChange: (value) => { void run({ op: 'backgroundLayout', value }, { backgroundLayout: value }) },
          }),
        ),
        /* 播放页透明背景 / 封面 这两个开关不搬：
           它们是 Folia 自己**主窗口播放页**的显示选项，管的是那个窗口里背景画不画、
           封面要不要当取色来源。DSH 里铺的是 OBS 浏览器源（一个独立的、只画歌词的
           页面），这两项对它没有任何影响——留在面板上只会让人以为点了有用。 */

        h('div', { className: 'dfe-divider' }),

        /* 主题来源：三格分段，每格前面一枚 8px 色点，和 Folia 一致。 */
        h('div', { className: 'dfe-sec' },
          h('div', { className: 'dfe-secrow' },
            h('span', { className: 'dfe-sec-label' }, t('themeSource')),
            h('span', { className: 'dfe-panel-tip' }, themeName),
          ),
          h(Seg, {
            value: themeValue,
            options: themeOptions.map((option) => ({
              value: option.key,
              label: themeLabel(option.key),
              disabled: option.available === false,
            })),
            onChange: (value) => { void run({ op: 'bgMode', value }, { theme: { ...data.theme, activeSource: value } }) },
          }),
        ),
        h('div', { className: 'dfe-btnrow' },
          h(Seg, {
            value: data.isDaylight ? 'light' : 'dark',
            options: [
              { value: 'light', label: t('themeLight') },
              { value: 'dark', label: t('themeDark') },
            ],
            onChange: (value) => { void run({ op: 'daylight', value: value === 'light' }, { isDaylight: value === 'light' }) },
          }),
          h('button', {
            type: 'button', className: 'dfe-btn',
            disabled: !data.theme || data.theme.generating === true || data.theme.canGenerate === false,
            onClick: () => { void run({ op: 'generateAITheme' }, { theme: { ...data.theme, generating: true } }) },
          }, data.theme && data.theme.generating ? t('generating') : t('generateAI')),
        ),
      )

      /* ── 播放列表 ── */
      const queueTab = h(React.Fragment, null,
        h('div', { className: 'dfe-qhead' },
          h('span', { className: 'dfe-qcount' }, `${queueLength}`),
          h('button', {
            type: 'button', className: 'dfe-btn', style: { padding: '5px 10px' },
            onClick: () => { void run({ op: 'shuffle' }) },
          }, t('queueShuffle')),
        ),
        queue === null
          ? h('div', { className: 'dfe-panel-tip' }, t('queueLoading'))
          : queue.length === 0
            ? h('div', { className: 'dfe-empty' }, t('queueEmpty'))
            : h('div', { className: 'dfe-queue' }, queue.map((item) => h('div', {
              key: `${item.i}:${item.id ?? item.name}`,
              className: 'dfe-qrow',
              'data-current': item.current ? '' : undefined,
              role: 'button',
              tabIndex: 0,
              title: item.name,
              onClick: () => { void panelAction({ op: 'playIndex', index: item.i }) },
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void panelAction({ op: 'playIndex', index: item.i })
              },
            },
              h('span', { className: 'dfe-qidx' }, item.current ? '▶' : String(item.i + 1)),
              h('div', { className: 'dfe-qmeta' },
                h('div', { className: 'dfe-qname' }, item.name || '—'),
                h('div', { className: 'dfe-qsub' }, [item.artist, item.album].filter(Boolean).join(' · ') || '—'),
              ),
              h('div', { className: 'dfe-qacts' },
                h('button', {
                  type: 'button', className: 'dfe-mini', title: t('playNext'),
                  onClick: (event) => { event.stopPropagation(); void panelAction({ op: 'moveNext', index: item.i }) },
                }, h(Icon, { name: 'next' })),
                h('button', {
                  type: 'button', className: 'dfe-mini', title: t('moveEnd'),
                  onClick: (event) => { event.stopPropagation(); void panelAction({ op: 'moveEnd', index: item.i }) },
                }, h(Icon, { name: 'bottom' })),
                h('button', {
                  type: 'button', className: 'dfe-mini', title: t('queueRemove'),
                  onClick: (event) => { event.stopPropagation(); void panelAction({ op: 'removeIndex', index: item.i }) },
                }, h(Icon, { name: 'trash' })),
              ),
              h('span', { className: 'dfe-qdur' }, formatTime(item.durationMs)),
            ))),
      )

      /* ── 音质 ── */
      /* Folia 音质页是「账号一行 + 设置行」的列表，不是分段控件。
         这里照它的行距与控件尺寸，把音质档位做成同样的行。 */
      const levels = data && Array.isArray(data.qualityLevels) && data.qualityLevels.length > 0
        ? data.qualityLevels
        : QUALITY_LEVELS
      const usableLevels = levels.filter((level) => QUALITY_LEVELS.includes(level))
      const qualityTab = data === null ? null : h(React.Fragment, null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 56, padding: '4px 0 4px 4px' } },
          h('span', { style: { width: 40, height: 40, borderRadius: 999, background: 'var(--dfe-fill)', display: 'grid', placeItems: 'center', flex: 'none', fontSize: 15, color: 'var(--dfe-t2)' } },
            h(Icon, { name: 'note' })),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              data.providerLabel || '—'),
            h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dfe-t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              data.audioQuality ? qualityLabel(t, data.audioQuality) : '—'),
          ),
        ),
        h('div', { className: 'dfe-divider' }),
        /* 这一行的 Seg 是 width:100% 的，标签再 flex:1 1 0% 会被挤成 0 宽、
           竖排成一列字。所以标签用 auto 宽度 + nowrap，让 Seg 自己收缩。 */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, padding: '6px 4px' } },
          h('span', { style: { flex: 'none', fontSize: 14, lineHeight: '20px', whiteSpace: 'nowrap' } }, t('qualityTitle')),
          h(Seg, {
            value: data.audioQuality,
            options: usableLevels.map((level) => ({
              value: level,
              label: qualityLabel(t, level),
            })),
            onChange: (value) => { void run({ op: 'quality', value }, { audioQuality: value }) },
          }),
        ),
        h('div', { className: 'dfe-panel-tip' }, t('qualityHint')),
        h('div', { className: 'dfe-divider' }),
        h('div', { className: 'dfe-switchrow' },
          h('span', null, t('equalizer')),
          h('button', {
            type: 'button', className: 'dfe-switch',
            'data-on': data.eqEnabled ? '' : undefined,
            role: 'switch',
            'aria-checked': data.eqEnabled ? 'true' : 'false',
            'aria-label': t('equalizer'),
            onClick: () => {
              const next = !data.eqEnabled
              void run({ op: 'eqEnabled', value: next }, { eqEnabled: next })
            },
          }),
        ),
      )

      const bodies = { cover: coverTab, lyrics: lyricsTab, controls: controlsTab, queue: queueTab, quality: qualityTab }
      const labels = { cover: t('tabCover'), lyrics: t('tabLyrics'), controls: t('tabControls'), queue: t('tabQueue'), quality: t('tabQuality') }

      /* 面板数据拿不到时，至少把 OBS 的曲目信息与走带控制留着。 */
      const body = data === null
        ? h('div', { className: 'dfe-empty' }, offline ? t('panelOffline') : (live.running ? t('playerEmpty') : t('playerNoHost')))
        : h(React.Fragment, null,
          offline ? h('div', { className: 'dfe-panel-tip' }, t('panelOffline')) : null,
          bodies[tab],
        )

      const progress = h(React.Fragment, null,
        h('div', {
          className: 'dfe-track',
          ref: barRef,
          role: 'slider',
          tabIndex: 0,
          'aria-label': t('player'),
          'aria-valuemin': 0,
          'aria-valuemax': Math.round(durationMs / 1000),
          'data-dragging': dragging ? '' : undefined,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: () => { dragPosition = null; setDragging(false) },
          onKeyDown: onSeekKey,
        },
          h('div', { className: 'dfe-fill' }),
          h('div', { className: 'dfe-knob' }),
        ),
        h('div', { className: 'dfe-times' },
          h('span', { ref: nowRef }, '0:00'),
          h('span', { ref: durationRef }, formatTime(durationMs)),
        ),
        h('div', { className: 'dfe-controls' },
          h('button', {
            type: 'button', className: 'dfe-icon', title: t('prev'), 'aria-label': t('prev'),
            onClick: () => { void sendControl('prev') },
          }, h(Icon, { name: 'prev' })),
          h('button', {
            type: 'button', className: 'dfe-icon', 'data-main': '',
            title: playing ? t('pause') : t('play'),
            'aria-label': playing ? t('pause') : t('play'),
            onClick: () => { void sendControl('toggle') },
          }, h(Icon, { name: playing ? 'pause' : 'play' })),
          h('button', {
            type: 'button', className: 'dfe-icon', title: t('next'), 'aria-label': t('next'),
            onClick: () => { void sendControl('next') },
          }, h(Icon, { name: 'next' })),
        ),
      )

      if (!open) {
        return h('button', {
          type: 'button',
          className: 'dfe-collapsed',
          title: t('expand'),
          'aria-label': t('expand'),
          onClick: () => setOpen(true),
        }, h(Icon, { name: 'note' }))
      }

      /* 结构照 Folia 那块面板：48px 头部 → 1px 分隔 → 页内容 → 进度条 → 底部标签栏。
         标签栏在**最底下**，和 Folia 一样。 */
      return h('div', { className: 'dfe-panel', ref: panelRef, 'data-dragging': dragging ? '' : undefined },
        h('div', { className: 'dfe-panel-head' },
          coverUrl && !coverBroken
            ? h('img', {
              className: 'dfe-panel-cover',
              src: coverUrl,
              alt: '',
              draggable: false,
              onError: () => setCoverBroken(true),
            })
            : h('div', { className: 'dfe-panel-cover', 'data-empty': '', 'aria-hidden': 'true' }, '♪'),
          h('div', { className: 'dfe-panel-meta' },
            h('div', { className: 'dfe-panel-title', title: title || '' }, title || t('player')),
            h('div', { className: 'dfe-panel-sub', title: artist || '' }, artist || '—'),
          ),
          data !== null
            ? h('button', {
              type: 'button',
              className: 'dfe-star',
              'data-on': data.liked ? '' : undefined,
              title: data.liked ? t('unlike') : t('like'),
              'aria-label': data.liked ? t('unlike') : t('like'),
              'aria-pressed': data.liked ? 'true' : 'false',
              onClick: onLike,
            }, h(Icon, { name: 'star' }))
            : null,
          h('button', {
            type: 'button',
            className: 'dfe-close',
            title: t('collapse'),
            'aria-label': t('collapse'),
            onClick: () => setOpen(false),
          }, '×'),
        ),
        h('div', { className: 'dfe-panel-line' }),
        h('div', { className: 'dfe-panel-body', role: 'tabpanel' }, body),
        /* 提示条挂在面板这一层，不是某个标签页里：动作可能从任何一页发起
           （封面页的收藏、控制页的开关），放在某一页里等于别处看不到。
           role="status" + aria-live 让读屏用户也能听到，而不只是看到一行
           4 秒后消失的小字。 */
        notice !== null
          ? h('div', {
            className: 'dfe-panel-tip dfe-notice',
            'data-note': notice.kind === 'ok' ? '' : undefined,
            role: 'status',
            'aria-live': 'polite',
          }, notice.text)
          : null,
        popoverDef !== null && popover !== null
          ? h(Popover, {
            anchor: popover,
            label: popoverDef.label,
            scope: popoverDef.scope,
            value: popoverDef.value,
            options: popoverDef.options,
            up: popover.up,
            onPick: popoverDef.onPick,
          })
          : null,
        h('div', { className: 'dfe-panel-foot' }, progress),
        h('div', { className: 'dfe-tabs', role: 'tablist' }, PANEL_TABS.map((name) => h('button', {
          key: name,
          type: 'button',
          role: 'tab',
          className: 'dfe-tab',
          'data-on': tab === name ? '' : undefined,
          'aria-selected': tab === name ? 'true' : 'false',
          onClick: () => setTab(name),
        }, h('span', null, labels[name])))),
      )
    }


    /* 播放控制卡第一次出现时把 Host 的 SSE 桥接起来，之后按 1 s 轮询曲目。
       轮询只在 Folia 运行时进行——没跑的时候没必要每秒打一次 health。
       面板快照（音量、主题、队列……）走自己的 1.5 s 节拍：它要跨一次 CDP
       往返，比 SSE 贵得多，没必要跟着 1 s 的进度轮询跑。

       卡片收起后降到 5 秒一次的慢心跳：那时界面上只剩一颗 48px 的胶囊，
       没有任何字段要更新，但完全停掉会让 SSE 闲置断开、展开瞬间空白。
       展开时会立刻补一次，所以心跳慢不会让人看到旧数据。 */
    const COLLAPSED_EVERY = 5

    function installPlayerRuntime() {
      refreshPlayer()
      void refreshPanel()
      let playerTick = 0
      let panelTick = 0
      const active = () => settings.player && (status.running || !status.loaded)
      const timer = setInterval(() => {
        if (!active()) return
        playerTick += 1
        if (cardOpen || playerTick % COLLAPSED_EVERY === 0) refreshPlayer()
      }, PLAYER_POLL_MS)
      const panelTimer = setInterval(() => {
        if (!active()) return
        panelTick += 1
        if (cardOpen || panelTick % COLLAPSED_EVERY === 0) void refreshPanel()
      }, PANEL_POLL_MS)
      const stopLoop = startProgressLoop()
      return () => {
        clearInterval(timer)
        clearInterval(panelTimer)
        stopLoop()
        clearProgressNodes()
        anchor = null
        setPlayer(PLAYER_IDLE)
        setPanel(PANEL_IDLE)
      }
    }

    /* ── 插件入口 ──────────────────────────────────────────────────────── */

    return {
      name: NS,
      inject: ['slots', 'theme', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-folia-embed: dictionaries')

        ctx.effect(() => installBackground(ctx), 'dsh-folia-embed: background layer')

        ctx.effect(() => installPlayerRuntime(), 'dsh-folia-embed: player runtime')

        const t = ctx.locale.bind(NS)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'folia-background',
          order: 60,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, SettingsSection))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-folia-embed-pill',
          order: 80,
          inject: () => ({ t }),
        }, Pill))

        /* 播放卡叠在浮动开关上面（order 更大 → 更靠后挂载），两者都在右下角。 */
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-folia-embed-player',
          order: 81,
          inject: () => ({ t }),
        }, PlayerCard))
      },
    }
  },
})
