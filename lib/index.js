/**
 * dsh-folia-embed —— Host 半侧
 *
 * 只做四件事，全部围绕「复用已安装的 Folia」：
 *   1. GET  /folia-bg/status   读 %APPDATA%\Folia\config.json，探测 127.0.0.1:<port>/obs/health，
 *      把「装没装 / 跑没跑 / OBS 源开没开 / 可用的 OBS 地址」一次性交给浏览器半侧。
 *   2. POST /folia-bg/launch   拉起本机已安装的 Folia.exe（用户点按钮才触发）。
 *   3. GET  /folia-bg/player   从 Folia 的 /obs/events SSE 取当前曲目与播放进度。
 *   4. POST /folia-bg/control  通过 Windows SMTC 控制播放（播放/暂停/上一首/下一首/跳转）。
 *   5. GET  /folia-bg/panel    整块控制面板快照（音量/循环/主题/歌词/队列…）。
 *   6. POST /folia-bg/panel    面板动作（白名单 op → Folia 自己的 store / 面板回调）。
 *   什么都不重画。歌词动效完全由 Folia 自己的 /obs 页面渲染。
 *
 * 为什么读状态走 OBS 的 SSE：那是 Folia 自己推给 OBS 浏览器源的同一份数据
 * （config = 曲目/歌词/封面，clock = 位置/时长/播放态），字段齐全且无需改 Folia。
 *
 * 为什么控制走 Windows SMTC 而不是 Folia 的 Stage API：Folia 渲染层用
 * navigator.mediaSession.setActionHandler 注册了 play / pause / previoustrack /
 * nexttrack，并持续 setPositionState()。这些注册在系统层面就是一条 SMTC 会话，
 * 于是任何本机进程都能用系统 API 控制它——不需要在 Folia 里打开 Stage 模式，
 * 不需要额外装软件，也不需要和 Folia 自己的 UI 抢状态。
 * （Stage API 默认关闭，且需要用户手动开启并配 token，不符合「装好就能用」。）
 *
 * 为什么整块面板走 CDP（9223）而不是 SMTC：SMTC 只有播放控制，读不到音量、
 * 循环、主题、歌词偏移、队列。Folia 的桌面快捷方式本身带
 * `--remote-debugging-port=9223`，于是它的渲染进程就是一个标准 DevTools 端点：
 * 在页面里直接调用 Folia 自己的 zustand store 与面板回调，能读到、也能改到
 * 面板上的每一项。这条路同样不需要改 Folia、不需要额外开关。
 * 安全边界：9223 只监听 127.0.0.1，动作在 Host 侧过白名单，浏览器半侧拿不到
 * 调试地址，也拼不出任意表达式。
 *
 * 为什么走 webServer 具名路由而不是让渲染进程直接 fetch 127.0.0.1:32108：
 *   · 渲染进程是 dsh-app://app，跨源访问要 CORS；相对路径 /folia-bg/* 走官方
 *     的 dsh-app 代理（已带认证 cookie），零 CORS 配置。
 *   · token 与端口只在 Host 侧读盘，浏览器半侧拿到的是一条可直接塞进 iframe 的 URL。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-folia-embed'
export const inject = ['webServer']

const DEFAULT_OBS_PORT = 32108
const HEALTH_TIMEOUT_MS = 1500
const STATUS_CACHE_MS = 2000
const SSE_RETRY_MS = 2000
/* SSE 的 clock 是 4 Hz；10 s 没有任何事件说明流已经死了。 */
const STALE_STREAM_MS = 10_000
const AGENT_IDLE_MS = 5 * 60 * 1000
const BODY_LIMIT_BYTES = 4096
/* 面板路由要收整份 LRC（sanitizePanelAction 允许 2 MB 正文），JSON 转义还会再涨一点。 */
const PANEL_BODY_LIMIT_BYTES = 3 * 1024 * 1024

const HERE = dirname(fileURLToPath(import.meta.url))
const SMTC_SCRIPT = join(HERE, 'smtc-agent.ps1')

function roamingDir() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
}

function foliaConfigPath() {
  return join(roamingDir(), 'Folia', 'config.json')
}

/** Folia 用 electron-store({ projectName: 'Folia' })，落盘就是 userData/config.json。 */
function readFoliaConfig() {
  try {
    const parsed = JSON.parse(readFileSync(foliaConfigPath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return null
  }
}

function foliaExePath() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const candidates = [
    join(local, 'Programs', 'Folia', 'Folia.exe'),
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Folia', 'Folia.exe'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

function configuredPort(config) {
  const port = Number(config?.OBS_BROWSER_SOURCE_PORT)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_OBS_PORT
}

async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/obs/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) return null
    const body = await response.json()
    return body && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

/* health 给的 url 是给 iframe 用的「舞台页」（/obs?obs=1&token=…）。
   SSE 在另一个路径上（/obs/events?token=…）。两者只差 pathname，token 相同。 */
function eventsUrlFor(pageUrl) {
  if (typeof pageUrl !== 'string' || pageUrl === '') return null
  try {
    const url = new URL(pageUrl)
    url.pathname = '/obs/events'
    url.searchParams.delete('obs')
    return url.toString()
  } catch {
    return null
  }
}

/* ── 状态（带 2s 缓存，避免 iframe 重载 + 面板轮询同时打 Folia） ─────────── */

let statusCache = { at: 0, value: null }
let statusInFlight = null

async function buildStatusUncached() {
  const exe = foliaExePath()
  const config = readFoliaConfig()
  const installed = exe !== null || config !== null
  const port = configuredPort(config)
  const health = await probeHealth(port)

  if (health === null) {
    return {
      installed,
      running: false,
      enabled: Boolean(config?.OBS_BROWSER_SOURCE_ENABLED),
      port,
      url: null,
      reason: installed ? 'not-running' : 'not-installed',
    }
  }

  const enabled = health.enabled === true
  const liveUrl = typeof health.url === 'string' && health.url ? health.url : null
  return {
    installed: true,
    running: true,
    enabled,
    port: Number.isInteger(Number(health.port)) ? Number(health.port) : port,
    clients: Number.isInteger(Number(health.clientCount)) ? Number(health.clientCount) : 0,
    url: enabled ? liveUrl : null,
    reason: enabled ? (liveUrl ? 'ok' : 'token-missing') : 'disabled',
  }
}

async function buildStatus({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && statusCache.value !== null && now - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value
  }
  if (statusInFlight !== null) return statusInFlight
  statusInFlight = buildStatusUncached()
    .then((value) => {
      statusCache = { at: Date.now(), value }
      return value
    })
    .finally(() => { statusInFlight = null })
  return statusInFlight
}

/* 把一条 SSE 响应拆成事件回调。中继与桥各连一条流，解析逻辑只写一份。 */
async function readSse(response, signal, onEvent) {
  if (!response.ok || response.body === null) {
    throw new Error(`obs sse ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      let eventName = 'message'
      const dataLines = []
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length === 0) continue
      try {
        onEvent(eventName, JSON.parse(dataLines.join('\n')))
      } catch { /* 单条坏数据不影响整条流 */ }
    }
  }
  if (signal.aborted) throw new Error('obs sse aborted')
}

/* ── Folia OBS SSE 桥：把 config / clock 缓存成当前曲目状态 ─────────────── */

function createObsBridge() {
  const state = { config: null, clock: null, updatedAt: 0 }
  let controller = null
  let connectedUrl = null
  let running = false
  let lastUsed = 0
  let retryTimer = null

  const handleEvent = (eventName, payload) => {
    if (!payload || typeof payload !== 'object') return
    if (eventName === 'config') {
      state.config = payload
      state.updatedAt = Date.now()
    } else if (eventName === 'clock') {
      state.clock = payload
      state.updatedAt = Date.now()
    }
  }

  async function pump(url, signal) {
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'text/event-stream' },
    })
    await readSse(response, signal, handleEvent)
  }

  function scheduleRetry(url) {
    if (!running || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      /* 期间可能已经有别的连接顶上来了（url 变化），别去打断它。 */
      if (running && controller === null) void connect(url)
    }, SSE_RETRY_MS)
  }

  async function connect(url) {
    if (!running) return
    if (controller !== null && connectedUrl === url) return
    controller?.abort()
    const own = new AbortController()
    controller = own
    connectedUrl = url
    let ended = false
    try {
      await pump(url, own.signal)
      ended = true
    } catch { /* 断流统一走下面的重连 */ }
    /* 流结束了就必须把 controller 清掉，否则 scheduleRetry → connect 会因为
       「已有同 url 的连接」直接返回，永远重连不上（这是之前 SSE 静默死掉的
       真实原因：状态停在最后一帧，卡片看起来像卡住了）。 */
    if (controller === own) {
      controller = null
      connectedUrl = null
    }
    if (ended && running) scheduleRetry(url)
  }

  return {
    state,
    /** 按需连接；url 变化时重连。 */
    ensure(url) {
      if (typeof url !== 'string' || url === '') return
      lastUsed = Date.now()
      if (!running) {
        running = true
        void connect(url)
        return
      }
      if (connectedUrl !== url) void connect(url)
    },
    get idle() {
      return running && Date.now() - lastUsed > AGENT_IDLE_MS
    },
    stop() {
      running = false
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
      controller?.abort()
      controller = null
      connectedUrl = null
    },
  }
}

/* ── 时钟中继 ────────────────────────────────────────────────────────────
 * 为什么需要它：Folia 主窗口被 DSH 完全遮住后，Chromium 把它的
 * requestAnimationFrame 节流到 1 FPS（实测 1005 ms/帧）。而它发布给 OBS
 * 浏览器源的 clock 正是在 rAF 里采的 currentTime——于是发布值最多滞后一帧，
 * 且新旧帧交替时忽快忽慢。舞台页对每帧都做「currentTime + 已过去的时间」外推，
 * 新帧一到就硬对齐，实测 23% 的帧往回跳，中位 148 ms、最深 264 ms。
 *
 * 修法：舞台页支持 ?obsPort=<port> 从别处读事件流。Host 自己订阅 Folia 的
 * 事件流，把 clock 里的 currentTime 换成页面里 <audio>.currentTime 的真实值
 * （音频元素由音频线程推进，不受 rAF 节流影响），其余事件原样转发。
 * 只转发、不重画：舞台页仍然是 Folia 自己那套渲染。 */
const RELAY_SAMPLE_MS = 100
/* 时钟与频谱合成一次采样：两者都是 20 Hz 级别，分开发只会把 CDP 往返翻倍。
   走 agent 的 audioSample：它复用 audioEl() 的选择逻辑（页面里有两个 <audio>，
   取最后一个会拿到已被换下来的旧元素）。agent 没注入时先注入再读。 */
const SAMPLE_PROBE = `(() => {
  if (!window.__dfeHost || typeof window.__dfeHost.audioSample !== 'function') return null;
  return window.__dfeHost.audioSample();
})()`

/* 舞台页在 32108 上跑，中继在 DSH 的端口上——跨源，EventSource 要 CORS。
   只对回环源放行：这是本机只读的播放位置，不涉及凭据。 */
function allowRelayOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return null
  try {
    const url = new URL(origin)
    const host = url.hostname
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
    return loopback ? origin : null
  } catch {
    return null
  }
}

function createClockRelay(panel) {
  const clients = new Set()
  let controller = null
  let running = false
  let retryTimer = null
  let lastClock = null
  /* 歌词、封面、主题、可视化设置全在 config 事件里，而 Folia 只在每条新 SSE
     连接建立时重放一次 config。中继是「有订阅方才连上游」，上游断开期间
     config 不会再发；舞台页重连或刷新后就永远等不到它——表现就是背景只剩
     可视化、歌词一片空白。所以缓存最后一份 config，新订阅方接上时立刻补发。 */
  let lastConfig = null
  let sampleTimer = null
  let sampling = false

  function send(client, eventName, payload) {
    try {
      client.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      clients.delete(client)
    }
  }

  function broadcast(eventName, payload) {
    for (const client of clients) send(client, eventName, payload)
  }

  /* 页面里的真实播放时间 + 频谱，一次 CDP 往返取回。
     读失败时返回 null，由调用方退回外推；undefined 表示上一次采样还没回来。 */
  async function sampleAudio() {
    if (sampling) return undefined
    sampling = true
    try {
      return await panel.audioSample()
    } catch {
      return null
    } finally {
      sampling = false
    }
  }

  function emitAudio(sample) {
    const spectrum = sample && sample.spectrum
    if (!spectrum || !Array.isArray(spectrum.spectrum) || spectrum.spectrum.length === 0) return
    /* 舞台页只认这几个字段：audioPower / bands / spectrum / sentAtMs。 */
    const [bass, lowMid, mid, vocal, treble] = spectrum.bands
    broadcast('audio', {
      audioPower: (bass + lowMid) / 2,
      bands: { bass, lowMid, mid, vocal, treble },
      spectrum: spectrum.spectrum,
      sentAtMs: Number(sample.clock && sample.clock.atMs) > 0 ? Number(sample.clock.atMs) : Date.now(),
    })
  }

  function emitClock() {
    const base = lastClock
    if (base === null) return
    void sampleAudio().then((sample) => {
      if (sample === undefined) return
      const audio = sample && sample.clock
      if (audio === null || audio === undefined) {
        /* 读不到音频元素时，按上一帧的外推值续上，至少保持单调。 */
        const elapsed = Math.max(0, (Date.now() - base.sentAtMs) / 1000)
        broadcast('clock', { ...base, currentTime: base.currentTime + elapsed, sentAtMs: Date.now() })
        return
      }
      const duration = audio.duration > 0 ? audio.duration : Number(base.duration) || 0
      const state = audio.ended ? 'IDLE' : (audio.paused ? 'PAUSED' : 'PLAYING')
      const next = {
        ...base,
        currentTime: Math.max(0, Number(audio.currentTime) || 0),
        duration,
        playerState: state,
        /* 用页面里采样的时刻，而不是现在。舞台页会按 sentAtMs 外推到「此刻」，
           用后者等于把 CDP 往返时间重复算了一遍，每帧都会往回退十几毫秒。 */
        sentAtMs: Number(audio.atMs) > 0 ? Number(audio.atMs) : Date.now(),
        playbackRate: 1,
      }
      lastClock = next
      broadcast('clock', next)
      emitAudio(sample)
    })
  }

  function startSampling() {
    if (sampleTimer !== null) return
    /* 用 Node 侧的定时器，不依赖页面 rAF——这正是要绕开的东西。 */
    sampleTimer = setInterval(emitClock, RELAY_SAMPLE_MS)
    if (typeof sampleTimer.unref === 'function') sampleTimer.unref()
  }

  function stopSampling() {
    if (sampleTimer !== null) { clearInterval(sampleTimer); sampleTimer = null }
  }

  async function pump(url, signal) {
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'text/event-stream' },
    })
    await readSse(response, signal, (eventName, payload) => {
      if (eventName === 'clock') {
        /* 记住 duration / 播放态等字段，值本身由采样覆盖。 */
        lastClock = payload
        return
      }
      if (eventName === 'config') lastConfig = payload
      /* audio 事件丢掉：中继自己按 20 Hz 推真实频谱，
         转发 Folia 那份只会是 1 FPS 的旧值，反而把画面拽回去。 */
      if (eventName === 'audio') return
      broadcast(eventName, payload)
    })
  }

  function scheduleRetry(url) {
    if (!running || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (running && controller === null) void connect(url)
    }, SSE_RETRY_MS)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  async function connect(url) {
    if (!running) return
    if (controller !== null) return
    const own = new AbortController()
    controller = own
    try {
      await pump(url, own.signal)
    } catch { /* 断流统一走重连 */ }
    if (controller === own) controller = null
    if (running) scheduleRetry(url)
  }

  return {
    /** 舞台页接上时调用；没有订阅方就断开上游，省一条常驻连接。 */
    attach(res, req) {
      const origin = allowRelayOrigin(req)
      const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }
      if (origin !== null) {
        headers['Access-Control-Allow-Origin'] = origin
        headers.Vary = 'Origin'
      }
      res.writeHead(200, headers)
      res.write(': relay\n\n')
      clients.add(res)
      /* 补发最后一份 config：舞台页自己也是一连上就等这一帧，而 Folia 只在
         上游连接建立时推一次。没有它，背景只剩可视化、歌词一片空白。 */
      if (lastConfig !== null) send(res, 'config', lastConfig)
      res.on('close', () => {
        clients.delete(res)
        if (clients.size === 0) {
          stopSampling()
          running = false
          if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
          controller?.abort()
          controller = null
        }
      })
      return clients.size
    },
    start(url) {
      if (typeof url !== 'string' || url === '') return
      if (running && controller !== null) return
      running = true
      startSampling()
      void connect(url)
    },
    /** 有订阅方但上游还没起（例如页面先连上、状态后到）。 */
    get clientCount() {
      return clients.size
    },
    stop() {
      running = false
      stopSampling()
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
      controller?.abort()
      controller = null
      for (const client of clients) { try { client.end() } catch { /* 已断开 */ } }
      clients.clear()
    },
  }
}

/** 把 OBS 的 config + clock 合成为一条曲目状态。 */
function trackFromBridge(state) {
  const config = state.config
  const clock = state.clock
  if (config === null && clock === null) return null
  const song = config?.song ?? null
  const hasTrack = config?.hasTrack === true || Number(clock?.duration) > 0
  if (!hasTrack) return null
  const title = typeof song?.name === 'string' ? song.name : null
  const coverUrl = typeof config?.coverUrl === 'string' && config.coverUrl ? config.coverUrl : null
  return {
    title,
    artist: typeof config?.songArtist === 'string' ? config.songArtist : null,
    album: typeof config?.songAlbum === 'string' ? config.songAlbum : null,
    coverUrl,
    /* 同源封面地址。key 只用于让 <img> 在换歌时重新请求，不影响 Host 取哪张图。 */
    coverPath: coverUrl === null ? null : `/folia-bg/cover?k=${encodeURIComponent(String(song?.id ?? title ?? ''))}`,
    songId: song?.id ?? null,
    playerState: typeof clock?.playerState === 'string' ? clock.playerState : 'IDLE',
    positionMs: Math.round((Number(clock?.currentTime) || 0) * 1000),
    durationMs: Math.round((Number(clock?.duration) || 0) * 1000),
    sampledAtMs: Number(clock?.sentAtMs) || null,
    playbackRate: Number(clock?.playbackRate) || 1,
    canSeek: true,
    source: 'obs',
  }
}

/* ── Windows SMTC 代理：常驻一个 PowerShell 子进程，走行协议 ────────────── */

function createSmtcAgent() {
  let child = null
  let buffer = ''
  let seq = 0
  let disposed = false
  const pending = new Map()
  let cooldownUntil = 0
  let idleTimer = null
  let lastUsed = 0

  function failAll(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function kill() {
    if (child === null) return
    const dying = child
    child = null
    buffer = ''
    failAll(new Error('smtc agent stopped'))
    try { dying.kill() } catch { /* 已经退出 */ }
  }

  function spawnAgent() {
    if (disposed || Date.now() < cooldownUntil) return null
    if (child !== null) return child
    let next
    try {
      next = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', SMTC_SCRIPT,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      cooldownUntil = Date.now() + 60_000
      return null
    }
    child = next
    let responded = false
    next.stdout.setEncoding('utf8')
    next.stdout.on('data', (chunk) => {
      responded = true
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        const entry = pending.get(message.id)
        if (entry === undefined) continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      }
    })
    next.stderr.on('data', () => { /* PowerShell 的噪声不往上抛 */ })
    next.on('error', () => { cooldownUntil = Date.now() + 60_000; kill() })
    next.on('exit', () => {
      if (child !== next) return
      kill()
      /* 一条响应都没给出就退出，多半是这台机器上 SMTC 不可用（精简版系统、
         未登录会话等）。退避一段时间，避免每秒轮询都把 PowerShell 拉起来一次。 */
      if (!responded) cooldownUntil = Date.now() + 120_000
    })
    if (idleTimer !== null) { clearInterval(idleTimer); idleTimer = null }
    idleTimer = setInterval(() => {
      if (pending.size === 0 && Date.now() - lastUsed > AGENT_IDLE_MS) kill()
    }, 60_000)
    return child
  }

  function send(action, payload = {}, timeoutMs = 8000) {
    const process_ = spawnAgent()
    if (process_ === null) return Promise.reject(new Error('smtc agent unavailable'))
    lastUsed = Date.now()
    const id = ++seq
    const line = `${JSON.stringify({ id, action, ...payload })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('smtc agent timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        process_.stdin.write(line)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  return {
    send,
    /** 提前把子进程拉起来（PowerShell 冷启动约 2s），让第一次点按不必等。 */
    warm() {
      lastUsed = Date.now()
      spawnAgent()
    },
    get alive() { return child !== null },
    dispose() {
      disposed = true
      if (idleTimer !== null) { clearInterval(idleTimer); idleTimer = null }
      kill()
    },
  }
}

function trackFromSmtc(session) {
  if (!session || typeof session !== 'object') return null
  const status = String(session.status || '')
  const playerState = status === 'Playing' ? 'PLAYING' : status === 'Paused' ? 'PAUSED' : 'IDLE'
  return {
    title: typeof session.title === 'string' ? session.title : null,
    artist: typeof session.artist === 'string' ? session.artist : null,
    album: typeof session.album === 'string' ? session.album : null,
    coverUrl: typeof session.cover === 'string' ? session.cover : null,
    coverPath: null,
    songId: null,
    playerState,
    positionMs: Number(session.positionMs) || 0,
    durationMs: Number(session.durationMs) || 0,
    sampledAtMs: Number(session.sampledAtMs) || Date.now(),
    playbackRate: 1,
    canSeek: session.canSeek === true,
    source: 'smtc',
  }
}

/* ── HTTP 工具 ─────────────────────────────────────────────────────────── */

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 拉一次远程封面并缓存；只接受 Folia 自己给的 http(s) 地址。 */
async function fetchCover(url) {
  if (coverCache.url === url && coverCache.body !== null) return coverCache
  if (!/^https?:\/\//i.test(url)) return null
  const response = await fetch(url, {
    signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
    cache: 'no-store',
    headers: { Accept: 'image/*' },
  })
  if (!response.ok) return null
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > COVER_MAX_BYTES) return null
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length === 0 || body.length > COVER_MAX_BYTES) return null
  const type = response.headers.get('content-type') ?? 'image/jpeg'
  coverCache = { url, type, body }
  return coverCache
}

/** 拉起 Folia。只在用户点按钮时调用；已运行则直接返回当前状态。 */
function launchFolia() {
  const exe = foliaExePath()
  if (exe === null) return { launched: false, error: 'not-installed' }
  try {
    /* DSH 的 Host 本身是 `Electron.exe --expose-internals <script>` 跑起来的，
       env 里带着 ELECTRON_RUN_AS_NODE=1。原样继承的话 Folia.exe 会以纯 Node
       模式启动、不建窗口就退出，所以必须摘掉这两个开关。 */
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    /* 面板控制依赖 9223。用户自己的快捷方式已经带了这两个参数，但从这里拉起时
       也得补上，否则「从 DSH 启动」的 Folia 只有播放控制、没有整块面板。 */
    const args = [`--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*']
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env })
    child.on('error', () => {})
    child.unref()
    return { launched: true }
  } catch (error) {
    return { launched: false, error: String(error?.message ?? error) }
  }
}

const CONTROL_ACTIONS = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'seek'])

/* ── 控制面板桥：Folia 自带的 CDP 调试端口 ────────────────────────────────
 *
 * Folia 的桌面快捷方式带 `--remote-debugging-port=9223`，于是它的渲染进程对外
 * 暴露了一个标准 DevTools 协议端点。这是唯一能「读写整块面板」的通道：OBS 的
 * SSE 只读、SMTC 只能播放控制，而 9223 可以在页面里直接调用 Folia 自己的
 * zustand store 和面板回调——所以音量、循环、主题、歌词偏移、队列增删全部
 * 走这一条，不需要改 Folia，也不需要在 Folia 里开任何开关。
 *
 * 为什么把动作放在 Host：渲染进程是 dsh-app://app，连不上 127.0.0.1:9223，
 * 也不该拿到调试端口的地址。浏览器半侧只发「op + 参数」，Host 侧按白名单
 * 翻译成页面里的表达式。
 */
const CDP_PORT = 9223
const CDP_TIMEOUT_MS = 5000
const CDP_LIST_TIMEOUT_MS = 1500
/* 注入助手用内容指纹做版本：改一次源码，指纹就变，页面里的旧助手会被换掉。
 * 手动递增的版本号很容易忘，导致改了逻辑却仍在跑旧代码。
 * 指纹取自助手源码本身，所以必须先写成不含指纹的模板，再回填。
 *
 * 注入到 Folia 页面里的常驻助手。只做两件事：把 store 解析一次缓存起来，
 * 以及把「白名单动作」翻译成对 store / 面板回调的调用。
 * 面板回调（onLike / onPlaySong / onBgModeChange …）是 useImperativeHandle 的
 * 转发函数，面板关掉后依然有效；实测关闭面板后照常可用。 */
const AGENT_BODY = `(() => {
  const VERSION = '__DFE_AGENT_VERSION__';
  if (window.__dfeHost && window.__dfeHost.version === VERSION) return 'ok';
  const H = { version: VERSION, mods: null, props: null };

  function findPanel() {
    const root = document.getElementById('root');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.indexOf('__reactContainer') === 0);
    if (!key) return null;
    const seen = new Set();
    const stack = [root[key]];
    let guard = 0;
    while (stack.length > 0 && guard < 40000) {
      guard += 1;
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      if (props && props.model && props.model.panelProps && props.model.panelProps.playback) {
        return props.model.panelProps;
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  }

  async function ensureMods() {
    if (H.mods) return H.mods;
    const links = Array.prototype.slice.call(document.querySelectorAll('link[rel=modulepreload]')).map((l) => l.href);
    const mods = {};
    for (const url of links) {
      let mod;
      try { mod = await import(url); } catch (error) { continue; }
      for (const value of Object.keys(mod).map((k) => mod[k])) {
        if (!value) continue;
        /* 播放器注册表不是 store：它提供 getAudioQualityLevels / getProviderLabel，
           用来还原「音质」页里该平台实际支持的档位。 */
        if (typeof value.getAudioQualityLevels === 'function' && typeof value.getProviderLabel === 'function') {
          mods.registry = value;
          continue;
        }
        let state = null;
        try { state = typeof value.getState === 'function' ? value.getState() : null; } catch (error) { continue; }
        if (!state || typeof state !== 'object' || typeof value.setState !== 'function') continue;
        if (state.setCurrentSong && state.playQueue) mods.playback = value;
        else if (state.handleSetVolume && 'audioQuality' in state) mods.provider = value;
        else if (state.handleSetVisualizerMode) mods.visualizer = value;
        else if (state.handleToggleCoverColorBg) mods.appearance = value;
        else if (state.handleSetGlobalLyricTimelineOffsetMs) mods.themeSettings = value;
        else if (state.handleToggleTransparentPlayerBackground) mods.bottomBar = value;
        else if (state.handleToggleAutomix) mods.bootstrap = value;
      }
    }
    H.mods = mods;
    return mods;
  }

  /* 页面里同时存在两个 <audio>：一个是被 Folia 换下来的旧元素（src 已清空、
   * 停在上一首的位置），一个是当前在放的那个。取第一个会拿到旧的——位置、
   * 时长、暂停状态全是错的，所以必须按 store 里的 audioSrc 精确匹配；
   * 本地文件是 blob: 地址，匹配不上时退回「最后一个有 src 的元素」。 */
  function audioEl(store) {
    const list = Array.prototype.slice.call(document.querySelectorAll('audio'));
    const want = store && typeof store.audioSrc === 'string' ? store.audioSrc : '';
    if (want) {
      const exact = list.find((a) => a.src === want || a.currentSrc === want);
      if (exact) return exact;
    }
    let best = null;
    for (const el of list) {
      if (!el.src && !el.currentSrc) continue;
      best = el;
    }
    return best;
  }

  function lyricFlags(state) {
    if (!state || typeof state !== 'object') return null;
    return {
      lyricsSource: state.lyricsSource || '',
      hasOnlineOverride: state.hasOnlineOverride === true,
      matchedIsPureMusic: state.matchedIsPureMusic === true,
      imported: !!state.importedLyrics,
      matchedSongId: state.matchedSongId || null,
    };
  }

  async function snapshot(withQueue) {
    const mods = await ensureMods();
    const playback = mods.playback ? mods.playback.getState() : null;
    if (!playback) return { ok: false, reason: 'store-missing' };
    const provider = mods.provider ? mods.provider.getState() : {};
    const visualizer = mods.visualizer ? mods.visualizer.getState() : {};
    const appearance = mods.appearance ? mods.appearance.getState() : {};
    const themeSettings = mods.themeSettings ? mods.themeSettings.getState() : {};
    const bottomBar = mods.bottomBar ? mods.bottomBar.getState() : {};
    const bootstrap = mods.bootstrap ? mods.bootstrap.getState() : {};
    const found = findPanel();
    if (found) H.props = found;
    const panelPlayback = (found ? found.playback : null) || (H.props ? H.props.playback : null) || {};
    const song = playback.currentSong || null;
    const queue = playback.playQueue || [];
    const audio = audioEl(playback);
    const durationMs = audio && isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : 0;
    const positionMs = audio && isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0;
    const playing = audio ? audio.paused === false : playback.playerState === 'PLAYING';
    const index = song ? queue.findIndex((item) => item && item.id === song.id) : -1;
    const model = panelPlayback.themeSourceModel || null;
    const monet = visualizer.monetBackgroundTuning || {};
    const eq = provider.audioEqualizerSettings || {};
    const flags = lyricFlags(panelPlayback.onlineLyricsState);
    /* 平台名与可选音质档位来自 Folia 自己的 provider 注册表：
       网易云只支持 standard/high/lossless/hires，没有 ultra，
       「音质」页的列表必须按这个过滤，不能写死五档。 */
    const providerId = song && song.sourceRef && song.sourceRef.kind === 'online' ? song.sourceRef.providerId : '';
    let providerLabel = '';
    let qualityLevels = [];
    if (mods.registry && providerId) {
      try { providerLabel = String(mods.registry.getProviderLabel(providerId) || '') } catch (error) {}
      try {
        const levels = mods.registry.getAudioQualityLevels(providerId);
        if (Array.isArray(levels)) qualityLevels = levels.filter((level) => typeof level === 'string');
      } catch (error) {}
    }
    /* 歌词页的来源列表：面板模型没有暴露 lyricSources，按 Folia 自己的规则还原——
       在线曲目至少一条「在线」，有导入歌词时再追加一条「已导入」。 */
    const imported = !!(flags && flags.imported);
    const lyricSources = [];
    if (song && providerId) lyricSources.push({ key: 'online', label: providerLabel || '在线' });
    if (imported) lyricSources.push({ key: 'imported', label: '已导入' });
    const activeLyricSource = flags && flags.lyricsSource === 'imported' && imported ? 'imported' : 'online';
    const gain = song && song.replayGain ? song.replayGain : null;
    const result = {
      ok: true,
      available: true,
      song: song ? {
        id: song.id,
        name: song.name || '',
        artist: (song.artists || []).map((a) => a && a.name).filter(Boolean).join(' / '),
        album: song.album ? song.album.name || '' : '',
        durationMs: Number(song.durationMs) || durationMs,
        coverUrl: (song.album && song.album.coverUrl) || playback.cachedCoverUrl || '',
      } : null,
      positionMs: positionMs,
      durationMs: durationMs,
      playing: playing,
      playerState: playback.playerState || 'IDLE',
      queueIndex: index,
      queueLength: queue.length,
      volume: Number(provider.volume) || 0,
      muted: provider.isMuted === true,
      loopMode: provider.loopMode || 'off',
      audioQuality: provider.audioQuality || '',
      eqPreset: eq.preset || 'flat',
      eqEnabled: eq.enabled === true,
      liked: panelPlayback.isLiked === true,
      hasLyrics: panelPlayback.hasLyrics === true,
      onlineLyricsState: flags,
      providerId: providerId,
      providerLabel: providerLabel,
      qualityLevels: qualityLevels,
      lyricSources: lyricSources,
      activeLyricSource: activeLyricSource,
      canClearLyrics: !!(flags && (flags.hasOnlineOverride || flags.imported)),
      /* ReplayGain 的两个值直接来自曲目：面板上「单曲 −8.6 dB」这一行就是它。
         没有专辑增益时该项显示「不可用」，与 Folia 一致。 */
      replayGainValues: gain ? {
        trackGain: typeof gain.trackGain === 'number' ? gain.trackGain : null,
        albumGain: typeof gain.albumGain === 'number' ? gain.albumGain : null,
      } : null,
      lyricOffsetMs: Number(playback.lyricTimelineOffsetMs) || 0,
      replayGainMode: playback.replayGainMode || 'off',
      lyricProvider: themeSettings.preferredAlternativeLyricSource || '',
      autoUseBestLyric: themeSettings.autoUseBestLyric === true,
      visualizerMode: visualizer.visualizerMode || '',
      backgroundMode: visualizer.visualizerBackgroundMode || '',
      backgroundLayout: monet.backgroundLayout || '',
      backgroundSource: monet.backgroundSource || '',
      transparentPlayerBackground: bottomBar.transparentPlayerBackground === true,
      useCoverColorBg: appearance.useCoverColorBg === true,
      isDaylight: appearance.isDaylight === true,
      automixEnabled: bootstrap.automixEnabled === true,
      transitionMode: bootstrap.transitionMode || '',
      coverUrl: (song && song.album && song.album.coverUrl) || playback.cachedCoverUrl || '',
      theme: {
        activeSource: model ? model.activeSource : 'default',
        name: (model && model.current && model.current.label) || (panelPlayback.theme && panelPlayback.theme.name) || '',
        hasCustom: panelPlayback.hasCustomTheme === true,
        canGenerate: panelPlayback.canGenerateAITheme === true,
        generating: panelPlayback.isGeneratingTheme === true,
        options: model && model.options
          ? Object.keys(model.options).map((k) => ({ key: k, available: !!(model.options[k] && model.options[k].available) }))
          : [],
      },
    };
    if (withQueue) {
      result.queue = queue.map((item, i) => ({
        i: i,
        id: item && item.id,
        name: (item && item.name) || '',
        artist: item && item.artists ? item.artists.map((a) => a && a.name).filter(Boolean).join(' / ') : '',
        album: item && item.album ? item.album.name || '' : '',
        durationMs: Number(item && item.durationMs) || 0,
        current: i === index,
      }));
    }
    return result;
  }

  async function act(action) {
    const mods = await ensureMods();
    const playback = mods.playback ? mods.playback.getState() : null;
    const provider = mods.provider ? mods.provider.getState() : null;
    const visualizer = mods.visualizer ? mods.visualizer.getState() : null;
    const appearance = mods.appearance ? mods.appearance.getState() : null;
    const themeSettings = mods.themeSettings ? mods.themeSettings.getState() : null;
    const bottomBar = mods.bottomBar ? mods.bottomBar.getState() : null;
    const bootstrap = mods.bootstrap ? mods.bootstrap.getState() : null;
    const found = findPanel();
    if (found) H.props = found;
    const panelPlayback = (found ? found.playback : null) || (H.props ? H.props.playback : null) || null;
    const panelQueue = (found ? found.queue : null) || (H.props ? H.props.queue : null) || null;
    const audio = audioEl(playback);
    switch (action.op) {
      case 'play':
        if (audio && audio.paused) { try { await audio.play(); } catch (error) {} }
        return 'ok';
      case 'pause':
        if (audio && audio.paused === false) audio.pause();
        return 'ok';
      case 'toggle':
        if (panelPlayback && typeof panelPlayback.onTogglePlay === 'function') { panelPlayback.onTogglePlay(); return 'ok'; }
        if (audio) {
          if (audio.paused) { try { await audio.play(); } catch (error) {} } else audio.pause();
        }
        return 'ok';
      case 'next':
        if (panelPlayback && panelPlayback.onNextTrack) panelPlayback.onNextTrack();
        return 'ok';
      case 'prev':
        if (panelPlayback && panelPlayback.onPrevTrack) panelPlayback.onPrevTrack();
        return 'ok';
      case 'seek': {
        const ms = Math.max(0, Number(action.positionMs) || 0);
        if (audio && isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.min(ms, audio.duration * 1000) / 1000;
        }
        return 'ok';
      }
      case 'volume': {
        const value = Math.min(1, Math.max(0, Number(action.value) || 0));
        if (panelPlayback && panelPlayback.onVolumeChange) panelPlayback.onVolumeChange(value);
        else if (provider) provider.handleSetVolume(value);
        return 'ok';
      }
      case 'mute':
        if (panelPlayback && panelPlayback.onToggleMute && (panelPlayback.isMuted === true) !== (action.value === true)) {
          panelPlayback.onToggleMute();
        }
        return 'ok';
      case 'loop':
        if (provider) provider.handleSetLoopMode(String(action.value));
        return 'ok';
      case 'like':
        if (panelPlayback && panelPlayback.onLike && (panelPlayback.isLiked === true) !== (action.value === true)) {
          panelPlayback.onLike();
        }
        return 'ok';
      case 'quality':
        if (provider) provider.setAudioQuality(String(action.value));
        return 'ok';
      case 'lyricOffset':
        if (playback) playback.setLyricTimelineOffsetMs(Math.round(Number(action.value) || 0));
        return 'ok';
      case 'replayGain':
        if (playback) playback.setReplayGainMode(String(action.value));
        return 'ok';
      case 'lyricProvider':
        if (themeSettings) themeSettings.handleSetPreferredAlternativeLyricSource(String(action.value));
        return 'ok';
      case 'matchOnline':
        if (panelPlayback && panelPlayback.onMatchOnline) await panelPlayback.onMatchOnline();
        return 'ok';
      case 'matchOnlineLyrics':
        if (panelPlayback && panelPlayback.onMatchOnlineLyrics) await panelPlayback.onMatchOnlineLyrics();
        return 'ok';
      /* 「歌词来源」分段：Folia 自己的 pY 页用 onChangeOnlineLyricsSource，
         它会把 importedLyrics 一起回写；切到 imported 而没有导入内容时它内部
         会自己拒绝，这里不需要额外判断。 */
      case 'changeLyricsSource':
        if (panelPlayback && panelPlayback.onChangeOnlineLyricsSource) {
          await panelPlayback.onChangeOnlineLyricsSource(String(action.value));
        }
        return 'ok';
      case 'clearLyrics':
        if (panelPlayback && panelPlayback.onClearOnlineLyricsState) await panelPlayback.onClearOnlineLyricsState();
        return 'ok';
      /* 导入歌词：浏览器侧用 FileReader 读出文本后整段送进来，走 Folia 自己的
         导入流程（解析 + 落盘 + 刷新播放页歌词），格式识别交给它。 */
      case 'importLyrics':
        if (panelPlayback && panelPlayback.onImportOnlineLyrics) {
          await panelPlayback.onImportOnlineLyrics(String(action.text), String(action.name));
        }
        return 'ok';
      case 'bgMode':
        if (panelPlayback && panelPlayback.onBgModeChange) panelPlayback.onBgModeChange(String(action.value));
        return 'ok';
      case 'visualizer':
        if (visualizer) visualizer.handleSetVisualizerMode(String(action.value));
        return 'ok';
      case 'backgroundMode':
        if (visualizer) visualizer.handleSetVisualizerBackgroundMode(String(action.value));
        return 'ok';
      case 'backgroundLayout':
        if (visualizer) visualizer.handleSetMonetBackgroundTuning({ backgroundLayout: String(action.value) });
        return 'ok';
      case 'backgroundSource':
        if (visualizer) visualizer.handleSetMonetBackgroundTuning({ backgroundSource: String(action.value) });
        return 'ok';
      case 'daylight':
        if (appearance) appearance.setDaylightPreference(action.value === true);
        return 'ok';
      case 'transparent':
        if (bottomBar) bottomBar.handleToggleTransparentPlayerBackground(action.value === true);
        return 'ok';
      case 'coverColorBg':
        if (appearance) appearance.handleToggleCoverColorBg(action.value === true);
        return 'ok';
      case 'automix':
        if (bootstrap) bootstrap.handleToggleAutomix(action.value === true);
        return 'ok';
      case 'generateAITheme':
        if (panelPlayback && panelPlayback.onGenerateAITheme) panelPlayback.onGenerateAITheme();
        return 'ok';
      case 'playIndex': {
        if (panelQueue && panelQueue.onPlaySong && playback) {
          const list = playback.playQueue || [];
          const target = list[Number(action.index)];
          if (target) await panelQueue.onPlaySong(target, list);
        }
        return 'ok';
      }
      case 'shuffle':
        if (panelQueue && panelQueue.onShuffle) panelQueue.onShuffle();
        return 'ok';
      case 'removeIndex':
        if (panelQueue && panelQueue.onRemoveSong) panelQueue.onRemoveSong(Number(action.index));
        return 'ok';
      case 'moveNext':
        if (panelQueue && panelQueue.onMoveSongToNext) panelQueue.onMoveSongToNext(Number(action.index));
        return 'ok';
      case 'moveEnd':
        if (panelQueue && panelQueue.onMoveSongToEnd) panelQueue.onMoveSongToEnd(Number(action.index));
        return 'ok';
      /* 导出：把当前播放页歌词按标准 LRC 拼成文本回给 Host。Folia 自己的导出
         走内部模块（还能写 fia / 带翻译轨），这里只做最通用的 LRC——够用户在
         别的播放器里接着用，也不去复制它的序列化逻辑。 */
      case 'exportLyrics': {
        const lyrics = playback && playback.lyrics;
        const lines = lyrics && Array.isArray(lyrics.lines) ? lyrics.lines : [];
        if (lines.length === 0) return { text: '' };
        const stamp = (seconds) => {
          const total = Math.max(0, Number(seconds) || 0);
          const minutes = Math.floor(total / 60);
          const rest = total - minutes * 60;
          return '[' + String(minutes).padStart(2, '0') + ':' + (rest < 10 ? '0' : '') + rest.toFixed(2) + ']';
        };
        const rows = [];
        for (const line of lines) {
          const text = typeof line.fullText === 'string' ? line.fullText : '';
          if (text === '') continue;
          rows.push(stamp(line.startTime) + text);
          const extra = line.translation || line.translatedText;
          if (typeof extra === 'string' && extra !== '') rows.push(stamp(line.startTime) + extra);
        }
        const song = playback && playback.currentSong;
        const rawName = song && typeof song.name === 'string' ? song.name : 'lyrics';
        const safeName = rawName.replace(/[\\\\/:*?"<>|]/g, '_').slice(0, 120) || 'lyrics';
        return { text: rows.join('\\n'), name: safeName + '.lrc' };
      }
      case 'eqPreset':
        if (provider) provider.handleApplyAudioSoundPreset(String(action.value));
        return 'ok';
      /* 效果器的总开关在 audioEqualizerSettings.enabled 上；handleSetAudioEqualizerSettings
         是整体替换（内部还会跑一遍校验/夹值），所以先取当前值再展开。 */
      case 'eqEnabled':
        if (provider) {
          const current = provider.audioEqualizerSettings || {};
          provider.handleSetAudioEqualizerSettings({ ...current, enabled: action.value === true });
        }
        return 'ok';
      default:
        return 'unsupported';
    }
  }

  /* 中继用的一次采样：时钟 + 频谱。合成一次调用是为了把每秒的 CDP 往返
     从 30 次压到 10 次——两者都是 20 Hz 级别，分开轮询没有收益。
     时钟直接读当前在放的那个 <audio>，不经过 rAF；页面里同时存在两个
     <audio>（一个是被换下来的旧元素），所以复用 audioEl() 的选择逻辑。 */
  function audioSample() {
    const mods = H.mods;
    const playback = mods && mods.playback ? mods.playback.getState() : null;
    const el = audioEl(playback);
    if (!el) return null;
    const clock = {
      currentTime: el.currentTime,
      duration: isFinite(el.duration) ? el.duration : 0,
      paused: el.paused,
      ended: el.ended,
      /* 在页面里同一时刻打时间戳。Host 侧再用 Date.now() 打点会多算一次
         CDP 往返（实测 5–15 ms），舞台页按这个时间戳外推，多算的部分就会
         变成一次可见的回退。 */
      atMs: Date.now(),
    };
    let spectrum = null;
    try {
      spectrum = audioSpectrum(el);
    } catch (error) {
      spectrum = null;
    }
    return { clock, spectrum };
  }

  /* 中继用的频谱。Folia 自己的 analyser 只在 rAF 里读，窗口被遮住时 rAF 掉到
     1 FPS，频谱就每秒才更新一次——可视化会一顿一顿。这里从 <audio> 的
     captureStream() 自建一条分析链，按需 20 Hz 采样，不碰 Folia 的渲染。
     频段切分与缩放照抄 Folia 自己的算法（20–150 / 150–400 / 400–1200 /
     1000–3500 / 3500–12000 Hz），这样视觉上与原版一致。 */
  const AUDIO_BANDS = [[20, 150, 1.8], [150, 400, 2], [400, 1200, 2], [1000, 3500, 1.5], [3500, 12000, 2]];
  const analyserState = { el: null, src: null, ctx: null, source: null, analyser: null, bins: null, failed: false };

  /* 换歌时 Folia 往往复用同一个 <audio> 元素、只换 src。captureStream() 绑的是
     抓取那一刻的媒体源，src 一换，旧流的轨道还在但输出全是 0——所以按
     currentSrc 判断，变了就重建整条分析链。 */
  function ensureAnalyser(el) {
    const src = el.currentSrc || el.src || '';
    if (analyserState.el === el && analyserState.src === src && analyserState.analyser) return analyserState;
    releaseAnalyser();
    if (analyserState.failed || typeof el.captureStream !== 'function') return null;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(el.captureStream());
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserState.el = el;
      analyserState.src = src;
      analyserState.ctx = ctx;
      analyserState.source = source;
      analyserState.analyser = analyser;
      analyserState.bins = new Uint8Array(analyser.frequencyBinCount);
      return analyserState;
    } catch (error) {
      /* 取流被拒（跨源媒体等）就永久退回 Folia 自己的值，不要每帧重试。 */
      analyserState.failed = true;
      releaseAnalyser();
      return null;
    }
  }

  function releaseAnalyser() {
    const { ctx, source } = analyserState;
    analyserState.el = null;
    analyserState.src = null;
    analyserState.ctx = null;
    analyserState.source = null;
    analyserState.analyser = null;
    analyserState.bins = null;
    try { source?.disconnect() } catch (error) {}
    try { ctx?.close() } catch (error) {}
  }

  /* 返回 { spectrum, bands } 或 null（拿不到就交给调用方退回 Folia 的值）。 */
  function audioSpectrum(el) {
    if (!el || el.paused || el.ended) return null;
    const state = ensureAnalyser(el);
    if (!state) return null;
    state.analyser.getByteFrequencyData(state.bins);
    const bins = state.bins;
    const binHz = state.ctx.sampleRate / state.analyser.fftSize;
    const average = (fromHz, toHz) => {
      const from = Math.max(0, Math.floor(fromHz / binHz));
      const to = Math.min(bins.length - 1, Math.floor(toHz / binHz));
      if (to < from) return 0;
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += bins[i];
      return sum / (to - from + 1);
    };
    const bands = AUDIO_BANDS.map(([from, to, power]) => Math.pow(average(from, to) / 255, power) * 255);
    /* CDP 的 returnByValue 会把 Uint8Array 序列化成 {"0":…,"1":…} 的对象，
       必须在这里转成普通数组，否则舞台上拿到的是空/无效频谱。 */
    return { spectrum: Array.prototype.slice.call(bins), bands };
  }

  window.__dfeHost = {
    version: VERSION,
    snapshot: snapshot,
    act: act,
    audioSample: audioSample,
    reset: () => { H.mods = null; H.props = null; releaseAnalyser(); return 'ok'; },
  };
  return 'ok';
})()`

const AGENT_VERSION = createHash('sha1').update(AGENT_BODY).digest('hex').slice(0, 12)
const AGENT_SOURCE = AGENT_BODY.split('__DFE_AGENT_VERSION__').join(AGENT_VERSION)

const PANEL_OPS = new Set([
  'play', 'pause', 'toggle', 'next', 'prev', 'seek',
  'volume', 'mute', 'loop', 'like', 'quality',
  'lyricOffset', 'replayGain', 'lyricProvider', 'matchOnline', 'matchOnlineLyrics',
  'changeLyricsSource', 'clearLyrics', 'importLyrics', 'exportLyrics',
  'bgMode', 'visualizer', 'backgroundMode', 'backgroundLayout', 'backgroundSource',
  'daylight', 'transparent', 'coverColorBg', 'automix', 'generateAITheme',
  'playIndex', 'shuffle', 'removeIndex', 'moveNext', 'moveEnd', 'eqPreset', 'eqEnabled',
])

const PANEL_ENUMS = {
  loop: new Set(['off', 'all', 'one']),
  quality: new Set(['standard', 'high', 'ultra', 'lossless', 'hires']),
  replayGain: new Set(['off', 'track', 'album']),
  lyricProvider: new Set(['netease', 'qq', 'kugou', 'spotify', 'amll']),
  bgMode: new Set(['default', 'ai', 'custom']),
  backgroundMode: new Set(['common', 'monet', 'nomand', 'latent', 'url', 'sora']),
  backgroundLayout: new Set(['full-overlay', 'half-pane-gradient']),
  backgroundSource: new Set(['cover-derived', 'uploaded-global']),
  eqPreset: new Set(['flat', 'lofi', 'radio', 'hall', 'vocal', 'bass', 'custom1', 'custom2']),
  changeLyricsSource: new Set(['online', 'imported']),
}

const VISUALIZER_MODES = new Set([
  'still', 'classic', 'cadenza', 'partita', 'fume', 'monet', 'cappella',
  'tilt', 'claddagh', 'diorama', 'pendolo', 'sonnet', 'tempera', 'lumiere',
])

/* 把客户端发来的动作规整成页面里能安全内插的对象：只保留白名单 op 与已知枚举，
 * 数值一律夹到合理区间。任何多余字段都被丢掉，避免表达式拼接被注入。 */
function sanitizePanelAction(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'action required' }
  const op = typeof raw.op === 'string' ? raw.op : ''
  if (!PANEL_OPS.has(op)) return { error: 'unsupported action' }
  const action = { op }
  const index = Number(raw.index)
  switch (op) {
    case 'seek': {
      const positionMs = Number(raw.positionMs)
      if (!Number.isFinite(positionMs) || positionMs < 0) return { error: 'seek needs positionMs' }
      action.positionMs = Math.round(Math.min(positionMs, 24 * 60 * 60 * 1000))
      return { action }
    }
    case 'volume': {
      const value = Number(raw.value)
      if (!Number.isFinite(value)) return { error: 'volume needs value' }
      action.value = Math.min(1, Math.max(0, value))
      return { action }
    }
    case 'lyricOffset': {
      const value = Number(raw.value)
      if (!Number.isFinite(value)) return { error: 'lyricOffset needs value' }
      action.value = Math.round(Math.min(60_000, Math.max(-60_000, value)))
      return { action }
    }
    case 'mute':
    case 'like':
    case 'daylight':
    case 'transparent':
    case 'coverColorBg':
    case 'automix':
    case 'eqEnabled':
      action.value = raw.value === true
      return { action }
    /* 导入歌词的正文直接进页面执行上下文，只做长度与文件名白名单的约束：
       内容本身是纯文本，用 JSON.stringify 内插，不存在拼接注入。 */
    case 'importLyrics': {
      const text = typeof raw.text === 'string' ? raw.text : ''
      const name = typeof raw.name === 'string' ? raw.name : ''
      if (text.length === 0) return { error: 'importLyrics needs text' }
      if (text.length > 2 * 1024 * 1024) return { error: 'lyrics too large' }
      if (!/^[^\\/:*?"<>|]{1,200}$/.test(name)) return { error: 'bad filename' }
      action.text = text
      action.name = name
      return { action }
    }
    case 'playIndex':
    case 'removeIndex':
    case 'moveNext':
    case 'moveEnd':
      if (!Number.isInteger(index) || index < 0 || index > 20_000) return { error: 'bad index' }
      action.index = index
      return { action }
    case 'visualizer': {
      const value = typeof raw.value === 'string' ? raw.value : ''
      if (!VISUALIZER_MODES.has(value)) return { error: 'bad visualizer mode' }
      action.value = value
      return { action }
    }
    case 'play':
    case 'pause':
    case 'toggle':
    case 'next':
    case 'prev':
    case 'matchOnline':
    case 'matchOnlineLyrics':
    case 'clearLyrics':
    case 'exportLyrics':
    case 'generateAITheme':
    case 'shuffle':
      return { action }
    default: {
      const allowed = PANEL_ENUMS[op]
      const value = typeof raw.value === 'string' ? raw.value : ''
      if (!allowed || !allowed.has(value)) return { error: 'bad value' }
      action.value = value
      return { action }
    }
  }
}

/* 最近一次面板快照里的封面地址。封面路由优先用它——同一份数据来自 Folia 自己的
 * 页面，不是外部参数，所以不会变成 SSRF 跳板。 */
let panelCoverUrl = null

function createCdpBridge() {
  let socket = null
  let connecting = null
  let sequence = 0
  let lastError = null
  const pending = new Map()

  function failAll(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function reset() {
    const dying = socket
    socket = null
    failAll(new Error('cdp reset'))
    try { dying?.close() } catch { /* 已经断开 */ }
  }

  async function listPages() {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
      signal: AbortSignal.timeout(CDP_LIST_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`cdp list ${response.status}`)
    const list = await response.json()
    if (!Array.isArray(list)) throw new Error('cdp list malformed')
    const page = list.find((entry) => entry && entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
    if (!page) throw new Error('cdp page missing')
    return page
  }

  function attach(page) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* 忽略 */ }
        reject(new Error('cdp connect timeout'))
      }, CDP_TIMEOUT_MS)
      ws.onopen = () => { clearTimeout(timer); resolve(ws) }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('cdp connect failed')) }
    })
  }

  function rawCall(ws, method, params, timeoutMs) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('cdp timeout'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async function ensure() {
    if (socket !== null && socket.readyState === 1) return socket
    if (connecting !== null) return connecting
    connecting = (async () => {
      const page = await listPages()
      const ws = await attach(page)
      socket = ws
      ws.onmessage = (event) => {
        let message = null
        try { message = JSON.parse(typeof event.data === 'string' ? event.data : '') } catch { return }
        const entry = message && pending.get(message.id)
        if (entry === undefined) return
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      }
      ws.onclose = () => { if (socket === ws) { socket = null } }
      ws.onerror = () => { /* 关闭事件会跟上，统一走 reset */ }
      await rawCall(ws, 'Runtime.enable', {}, CDP_TIMEOUT_MS)
      return ws
    })().catch((error) => {
      lastError = String(error?.message ?? error)
      socket = null
      throw error
    }).finally(() => { connecting = null })
    return connecting
  }

  async function evaluate(expression) {
    let failure = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const ws = await ensure()
        const reply = await rawCall(ws, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }, CDP_TIMEOUT_MS)
        if (reply?.error) throw new Error(String(reply.error.message || 'cdp error'))
        const details = reply?.result?.exceptionDetails
        if (details) throw new Error(String(details.exception?.description || details.text || 'evaluate failed'))
        return reply?.result?.result?.value
      } catch (error) {
        failure = error
        reset()
      }
    }
    throw failure ?? new Error('cdp unavailable')
  }

  async function ensureAgent() {
    const value = await evaluate(AGENT_SOURCE)
    if (value !== 'ok') throw new Error('cdp agent failed')
  }

  return {
    get lastError() { return lastError },
    async snapshot(withQueue) {
      const read = (flag) => `window.__dfeHost && window.__dfeHost.version === '${AGENT_VERSION}' ? window.__dfeHost.snapshot(${flag ? 'true' : 'false'}) : null`
      const first = await evaluate(read(withQueue))
      if (first && typeof first === 'object' && first.ok === true) return first
      await ensureAgent()
      const second = await evaluate(read(withQueue))
      if (second && typeof second === 'object' && second.ok === true) return second
      throw new Error('panel snapshot failed')
    },
    /** 中继用：一次读出页面里的真实音频时钟与频谱。agent 不在就先注入一次。 */
    async audioSample() {
      const value = await evaluate(SAMPLE_PROBE)
      if (value && typeof value === 'object') return value
      await ensureAgent()
      const retry = await evaluate(SAMPLE_PROBE)
      return retry && typeof retry === 'object' ? retry : null
    },
    async act(action) {
      const literal = JSON.stringify(action)
      const run = () => `window.__dfeHost ? window.__dfeHost.act(${literal}) : null`
      let value = await evaluate(run())
      if (value === null || value === undefined) {
        await ensureAgent()
        value = await evaluate(run())
      }
      return value
    },
    reset,
    dispose() {
      reset()
      connecting = null
    },
  }
}

/* 封面走 Host 代理：OBS 的 config.coverUrl 是 https://p4.music.126.net/... 这样的
   远程地址，直接塞进 dsh-app:// 页面会被 CSP / referrer 策略挡掉。这里由 Host
   取一次、缓存一份，浏览器侧只请求同源的 /folia-bg/cover。
   URL 不接受外部参数——只转发 Folia 自己通过 SSE 推过来的那一条，避免变成 SSRF 跳板。 */
const COVER_TIMEOUT_MS = 6000
const COVER_MAX_BYTES = 3 * 1024 * 1024
let coverCache = { url: null, type: null, body: null }

/* ── 注册 ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  const bridge = createObsBridge()
  const agent = createSmtcAgent()
  const panel = createCdpBridge()
  const relay = createClockRelay(panel)
  /* 舞台页要从 DSH 的监听端口读中继流，这个端口在 /folia-bg/status 里交给
     浏览器半侧，再由它拼进 iframe 的 ?obsPort=。 */
  const relayPort = Number(ctx.webServer.port) || null

  ctx.effect(() => () => {
    bridge.stop()
    relay.stop()
    agent.dispose()
    panel.dispose()
  }, 'dsh-folia-embed: player runtime')

  /* 背景关掉、播放卡收起后没人再调 /player，SSE 会一直挂在 Folia 上。
     5 分钟没人用就主动断开；下次轮询时 ensure() 会自己重连。 */
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (bridge.idle) bridge.stop()
    }, 60_000)
    return () => clearInterval(timer)
  }, 'dsh-folia-embed: stream reaper')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      try {
        sendJson(res, 200, { ok: true, relayPort, relayClients: relay.clientCount, ...(await buildStatus({ fresh: true })) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-folia-embed: status route')

  /* 舞台页的时钟中继。iframe 里把 obsPort 指到 DSH 的监听端口，
     舞台页就会来这条路由读事件流，而 Host 把 clock 的 currentTime
     换成页面里音频元素的真实时间——绕开被遮挡节流到 1 FPS 的 rAF。
     config / audio 等其余事件原样转发，舞台页仍然按 Folia 自己的逻辑渲染。

     路径必须是 /obs/events：舞台页把它写死在代码里（`new URL('/obs/events', base)`），
     只有 host 部分由 obsPort 决定。DSH 侧没有别的插件占用这个路径。 */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/obs/events',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      /* 上游 URL 不接受外部参数：只认 Folia 自己 /obs/health 给的那一条。 */
      const status = await buildStatus()
      const eventsUrl = eventsUrlFor(status.url)
      if (eventsUrl === null) {
        sendJson(res, 503, { ok: false, error: 'obs unavailable' })
        return
      }
      relay.attach(res, req)
      relay.start(eventsUrl)
    },
  }), 'dsh-folia-embed: clock relay route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/launch',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      const result = launchFolia()
      if (!result.launched) {
        sendJson(res, 409, { ok: false, ...result })
        return
      }
      statusCache = { at: 0, value: null }
      sendJson(res, 200, { ok: true, ...result })
    },
  }), 'dsh-folia-embed: launch route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/player',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      try {
        const status = await buildStatus()
        let track = null
        /* 注意：status.url 是舞台页（/obs?...），SSE 在 /obs/events 上，得换算。 */
        const eventsUrl = eventsUrlFor(status.url)
        if (eventsUrl !== null) {
          bridge.ensure(eventsUrl)
          /* SSE 每 250 ms 就有一帧 clock，10 s 没动静说明流已断，不能拿旧曲目
             继续显示（那会是一张停在上一首歌的卡片）。 */
          const fresh = Date.now() - bridge.state.updatedAt < STALE_STREAM_MS
          if (fresh) track = trackFromBridge(bridge.state)
        }
        /* 只有 OBS 源根本连不上时才退回 SMTC 读曲目。SMTC 的时间轴精度很差
           （实测同一首歌能比 OBS 落后几十秒），两路混用会让进度条来回跳；
           既然 OBS 能连上，位置就只信 OBS。SSE 首帧只需几十毫秒，
           这一次返回 null 换来的是一段「空卡片」，不会造成跳变。 */
        if (track === null && eventsUrl === null && status.running) {
          /* Folia 在跑就意味着有可控制的对象：顺手预热子进程，让第一次点按
             不必等 PowerShell 冷启动的 2 秒。 */
          agent.warm()
          try {
            const reply = await agent.send('status', {}, 6000)
            track = trackFromSmtc(reply?.session)
          } catch { track = null }
        }
        sendJson(res, 200, {
          ok: true,
          available: track !== null,
          installed: status.installed,
          running: status.running,
          track,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-folia-embed: player route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/cover',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      const url = bridge.state.config?.coverUrl ?? panelCoverUrl
      if (typeof url !== 'string' || url === '') {
        res.writeHead(404, { 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      try {
        const cover = await fetchCover(url)
        if (cover === null) {
          res.writeHead(404, { 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': cover.type,
          'Content-Length': cover.body.length,
          'Cache-Control': 'no-store',
        })
        res.end(cover.body)
      } catch {
        res.writeHead(502, { 'Cache-Control': 'no-store' })
        res.end()
      }
    },
  }), 'dsh-folia-embed: cover route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/control',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      const action = typeof body?.action === 'string' ? body.action : ''
      if (!CONTROL_ACTIONS.has(action)) {
        sendJson(res, 400, { ok: false, error: 'unsupported action' })
        return
      }
      const payload = {}
      if (action === 'seek') {
        const positionMs = Number(body?.positionMs)
        if (!Number.isFinite(positionMs) || positionMs < 0) {
          sendJson(res, 400, { ok: false, error: 'seek needs positionMs' })
          return
        }
        payload.positionMs = Math.round(positionMs)
      }
      try {
        const reply = await agent.send(action, payload)
        if (reply?.ok !== true) {
          sendJson(res, 502, { ok: false, error: reply?.error ?? 'control failed' })
          return
        }
        const track = trackFromSmtc(reply.session)
        if (track !== null && action === 'seek') {
          /* seek 之后 OBS 的 clock 要等下一帧（最多 250 ms）才更新；先用 SMTC
             的快照顶上，避免进度条在 1 s 内被旧采样拉回去。
             只对 seek 这么做：SMTC 的播放状态是异步刷新的，暂停/播放刚下发时
             它还报着旧状态，写回去反而会让客户端误判 1 秒。 */
          bridge.state.clock = {
            ...(bridge.state.clock ?? {}),
            currentTime: track.positionMs / 1000,
            sentAtMs: track.sampledAtMs,
          }
        }
        sendJson(res, 200, { ok: true, changed: reply.changed === true, track })
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-folia-embed: control route')

  /* GET  /folia-bg/panel —— 整块面板的快照（曲目、音量、循环、主题、歌词、
     队列……）。?queue=1 时连队列一起带回来，只在播放列表页打开时请求。
     POST /folia-bg/panel —— 面板动作，body: { op, value?, index?, positionMs? }。
     所有 op 先在 Host 侧过白名单与枚举，再拼进页面表达式；浏览器侧拿不到
     9223 的地址，也无法拼出任意表达式。
     失败一律回 200 + { ok:false, available:false, reason }：客户端拿它当
     「9223 没开」的降级信号，不该在控制台刷成错误。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/folia-bg/panel',
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      if (req.method === 'GET') {
        const wantQueue = /[?&]queue=1\b/.test(req.url ?? '')
        try {
          const snapshot = await panel.snapshot(wantQueue)
          if (typeof snapshot.coverUrl === 'string' && snapshot.coverUrl !== '') panelCoverUrl = snapshot.coverUrl
          sendJson(res, 200, { ...snapshot, available: true })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            available: false,
            reason: String(error?.message ?? error),
            hint: 'Folia 需要用带 --remote-debugging-port=9223 的快捷方式启动',
          })
        }
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'GET or POST only' })
        return
      }
      let body
      try {
        body = await readJsonBody(req, PANEL_BODY_LIMIT_BYTES)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        return
      }
      const checked = sanitizePanelAction(body)
      if (checked.error) {
        sendJson(res, 400, { ok: false, error: checked.error })
        return
      }
      try {
        const result = await panel.act(checked.action)
        if (result === 'unsupported') {
          sendJson(res, 400, { ok: false, error: 'unsupported action' })
          return
        }
        /* exportLyrics 会带回来一段文本，其余动作只回 'ok'。 */
        if (result && typeof result === 'object') {
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          available: false,
          reason: String(error?.message ?? error),
          hint: 'Folia 需要用带 --remote-debugging-port=9223 的快捷方式启动',
        })
      }
    },
  }), 'dsh-folia-embed: panel route')
}
