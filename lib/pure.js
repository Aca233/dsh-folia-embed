/**
 * dsh-folia-embed —— 纯函数
 *
 * 这里只放不碰 I/O、不依赖 DSH 运行时的函数，目的是让它们能被单独测试。
 * `lib/index.js` 从这里 import，`test/pure.test.mjs` 直接测这一份——测的就是
 * 线上跑的那份代码，不是一份复制品。
 *
 * 其中 `sanitizePanelAction` 是唯一的安全边界：客户端发来的动作要拼进 Folia
 * 页面的执行上下文，所以白名单、枚举、数值夹取一个都不能漏。
 */

export const DEFAULT_OBS_PORT = 32108

/** 从 Folia 的 config.json 里取 OBS 端口；越界或非整数一律回默认值。 */
export function configuredPort(config) {
  const port = Number(config?.OBS_BROWSER_SOURCE_PORT)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_OBS_PORT
}

/* health 给的 url 是给 iframe 用的「舞台页」（/obs?obs=1&token=…）。
   SSE 在另一个路径上（/obs/events?token=…）。两者只差 pathname，token 相同。
   用错路径不会报错，只会安静地收不到任何事件——所以这个换算必须是对的。 */
export function eventsUrlFor(pageUrl) {
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

/** 把 OBS 的 config + clock 合成为一条曲目状态。 */
export function trackFromBridge(state) {
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

/* ── 面板动作的安全边界 ──────────────────────────────────────────────────── */

export const PANEL_OPS = new Set([
  'volume', 'mute', 'loop', 'like', 'quality',
  'lyricOffset', 'replayGain', 'matchOnlineLyrics',
  'changeLyricsSource', 'clearLyrics', 'importLyrics', 'exportLyrics',
  'bgMode', 'visualizer', 'backgroundMode', 'backgroundLayout',
  'daylight', 'automix', 'generateAITheme',
  'playIndex', 'shuffle', 'removeIndex', 'moveNext', 'moveEnd', 'eqEnabled',
])

export const PANEL_ENUMS = {
  loop: new Set(['off', 'all', 'one']),
  quality: new Set(['standard', 'high', 'ultra', 'lossless', 'hires']),
  replayGain: new Set(['off', 'track', 'album']),
  bgMode: new Set(['default', 'ai', 'custom']),
  backgroundMode: new Set(['common', 'monet', 'nomand', 'latent', 'url', 'sora']),
  backgroundLayout: new Set(['full-overlay', 'half-pane-gradient']),
  changeLyricsSource: new Set(['online', 'imported']),
}

export const VISUALIZER_MODES = new Set([
  'still', 'classic', 'cadenza', 'partita', 'fume', 'monet', 'cappella',
  'tilt', 'claddagh', 'diorama', 'pendolo', 'sonnet', 'tempera', 'lumiere',
])

/** 歌词正文上限：整份 LRC 走 JSON 过一遍，超过这个量级已经不是歌词了。 */
export const LYRICS_MAX_CHARS = 2 * 1024 * 1024
/** 队列索引上限。148 首的队列留足余量，同时挡住 Number.MAX_SAFE_INTEGER 之类的值。 */
export const INDEX_MAX = 20_000
/** 歌词时间轴偏移的可调范围（毫秒）。 */
export const LYRIC_OFFSET_MAX_MS = 60_000

/* 数值型 op 只接受真正的数字。`Number()` 会把 null / '' / true 静默转成 0 或 1，
   客户端从来只发数字，所以这里不做这层宽容——边界上少一条隐式转换就少一类意外。 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* 把客户端发来的动作规整成页面里能安全内插的对象：只保留白名单 op 与已知枚举，
 * 数值一律夹到合理区间。任何多余字段都被丢掉，避免表达式拼接被注入。 */
export function sanitizePanelAction(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'action required' }
  const op = typeof raw.op === 'string' ? raw.op : ''
  if (!PANEL_OPS.has(op)) return { error: 'unsupported action' }
  const action = { op }
  switch (op) {
    case 'volume': {
      const value = finiteNumber(raw.value)
      if (value === null) return { error: 'volume needs value' }
      action.value = Math.min(1, Math.max(0, value))
      return { action }
    }
    case 'lyricOffset': {
      const value = finiteNumber(raw.value)
      if (value === null) return { error: 'lyricOffset needs value' }
      action.value = Math.round(Math.min(LYRIC_OFFSET_MAX_MS, Math.max(-LYRIC_OFFSET_MAX_MS, value)))
      return { action }
    }
    case 'mute':
    case 'like':
    case 'daylight':
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
      if (text.length > LYRICS_MAX_CHARS) return { error: 'lyrics too large' }
      if (!/^[^\\/:*?"<>|]{1,200}$/.test(name)) return { error: 'bad filename' }
      action.text = text
      action.name = name
      return { action }
    }
    case 'playIndex':
    case 'removeIndex':
    case 'moveNext':
    case 'moveEnd': {
      const index = finiteNumber(raw.index)
      if (index === null || !Number.isInteger(index) || index < 0 || index > INDEX_MAX) {
        return { error: 'bad index' }
      }
      action.index = index
      return { action }
    }
    case 'visualizer': {
      const value = typeof raw.value === 'string' ? raw.value : ''
      if (!VISUALIZER_MODES.has(value)) return { error: 'bad visualizer mode' }
      action.value = value
      return { action }
    }
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
