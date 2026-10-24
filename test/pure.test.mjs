/**
 * 纯函数测试：node --test test/
 *
 * 重点在 `sanitizePanelAction`——它是唯一的安全边界。客户端发来的动作最终会拼进
 * Folia 页面的执行上下文，所以白名单、枚举、数值夹取任何一处漏了都是注入面。
 * 其余几个函数是「换算错了不会报错、只会安静失效」的那一类（SSE 路径、端口、
 * 曲目合成），也一并钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OBS_PORT,
  configuredPort,
  eventsUrlFor,
  trackFromBridge,
  sanitizePanelAction,
  PANEL_OPS,
  PANEL_ENUMS,
  VISUALIZER_MODES,
  LYRICS_MAX_CHARS,
  INDEX_MAX,
  LYRIC_OFFSET_MAX_MS,
} from '../lib/pure.js'

/* ── configuredPort ────────────────────────────────────────────────────── */

test('configuredPort: 合法端口原样返回', () => {
  assert.equal(configuredPort({ OBS_BROWSER_SOURCE_PORT: 32108 }), 32108)
  assert.equal(configuredPort({ OBS_BROWSER_SOURCE_PORT: 1 }), 1)
  assert.equal(configuredPort({ OBS_BROWSER_SOURCE_PORT: 65535 }), 65535)
})

test('configuredPort: 缺配置 / 越界 / 非整数一律回默认值', () => {
  for (const config of [null, undefined, {}, { OBS_BROWSER_SOURCE_PORT: 0 },
    { OBS_BROWSER_SOURCE_PORT: 65536 }, { OBS_BROWSER_SOURCE_PORT: -1 },
    { OBS_BROWSER_SOURCE_PORT: 32108.5 }, { OBS_BROWSER_SOURCE_PORT: 'abc' },
    { OBS_BROWSER_SOURCE_PORT: NaN }, { OBS_BROWSER_SOURCE_PORT: Infinity }]) {
    assert.equal(configuredPort(config), DEFAULT_OBS_PORT, JSON.stringify(config))
  }
})

test('configuredPort: 数字字符串按数字处理', () => {
  assert.equal(configuredPort({ OBS_BROWSER_SOURCE_PORT: '32109' }), 32109)
})

/* ── eventsUrlFor ──────────────────────────────────────────────────────── */

test('eventsUrlFor: 舞台页换成 SSE 路径，token 保留', () => {
  assert.equal(
    eventsUrlFor('http://127.0.0.1:32108/obs?obs=1&token=abc'),
    'http://127.0.0.1:32108/obs/events?token=abc',
  )
})

test('eventsUrlFor: 去掉 obs 参数，其余查询参数保留', () => {
  const out = eventsUrlFor('http://127.0.0.1:32108/obs?obs=1&token=t&x=1')
  const url = new URL(out)
  assert.equal(url.pathname, '/obs/events')
  assert.equal(url.searchParams.get('obs'), null)
  assert.equal(url.searchParams.get('token'), 't')
  assert.equal(url.searchParams.get('x'), '1')
})

test('eventsUrlFor: 空值与非字符串返回 null', () => {
  for (const value of [null, undefined, '', 0, false, {}, []]) {
    assert.equal(eventsUrlFor(value), null, String(value))
  }
})

test('eventsUrlFor: 无法解析的地址返回 null 而不是抛异常', () => {
  assert.equal(eventsUrlFor('not a url'), null)
  assert.equal(eventsUrlFor('http://'), null)
})

/* ── trackFromBridge ───────────────────────────────────────────────────── */

const config = {
  hasTrack: true,
  song: { id: 3372251060, name: 'Departure', },
  songArtist: '朝倉紀行',
  songAlbum: 'OST II',
  coverUrl: 'https://p4.music.126.net/a.jpg',
}
const clock = {
  playerState: 'PLAYING',
  currentTime: 12.3456,
  duration: 116.4,
  sentAtMs: 1792764000000,
  playbackRate: 1,
}

test('trackFromBridge: config + clock 合成为一条曲目', () => {
  const track = trackFromBridge({ config, clock })
  assert.equal(track.title, 'Departure')
  assert.equal(track.artist, '朝倉紀行')
  assert.equal(track.album, 'OST II')
  assert.equal(track.playerState, 'PLAYING')
  assert.equal(track.positionMs, 12346)   // 秒 → 毫秒并取整
  assert.equal(track.durationMs, 116400)
  assert.equal(track.sampledAtMs, 1792764000000)
  assert.equal(track.source, 'obs')
  assert.equal(track.songId, 3372251060)
})

test('trackFromBridge: 封面同时给出远程地址与同源代理地址', () => {
  const track = trackFromBridge({ config, clock })
  assert.equal(track.coverUrl, 'https://p4.music.126.net/a.jpg')
  assert.equal(track.coverPath, `/folia-bg/cover?k=${encodeURIComponent('3372251060')}`)
})

test('trackFromBridge: 没有封面时 coverPath 为 null，不是 "?k=null"', () => {
  const track = trackFromBridge({ config: { ...config, coverUrl: '' }, clock })
  assert.equal(track.coverUrl, null)
  assert.equal(track.coverPath, null)
})

test('trackFromBridge: coverPath 里的歌名会被转义，不能带出查询参数', () => {
  const track = trackFromBridge({
    config: { ...config, coverUrl: 'https://x/a.jpg', song: { id: undefined, name: 'a&b=c d' } },
    clock,
  })
  assert.ok(!track.coverPath.includes('&b'), track.coverPath)
  assert.ok(!track.coverPath.includes(' '), track.coverPath)
  assert.equal(track.coverPath, `/folia-bg/cover?k=${encodeURIComponent('a&b=c d')}`)
})

test('trackFromBridge: 没歌时返回 null', () => {
  assert.equal(trackFromBridge({ config: null, clock: null }), null)
  assert.equal(trackFromBridge({ config: { hasTrack: false }, clock: { duration: 0 } }), null)
  assert.equal(trackFromBridge({ config: {}, clock: {} }), null)
})

test('trackFromBridge: 只有 clock 没有 config 也能出曲目（播放态来自 clock）', () => {
  const track = trackFromBridge({ config: null, clock: { duration: 10, currentTime: 1 } })
  assert.equal(track.title, null)
  assert.equal(track.playerState, 'IDLE')
  assert.equal(track.coverPath, null)
})

/* ── sanitizePanelAction：白名单 ───────────────────────────────────────── */

test('sanitize: 非对象 / 缺 op / 未知 op 一律拒绝', () => {
  for (const raw of [null, undefined, 'volume', 42, [], {}, { op: '' },
    { op: 'nope' }, { op: 123 }, { op: 'constructor' }, { op: '__proto__' },
    { op: 'toString' }, { op: 'eval' }]) {
    const out = sanitizePanelAction(raw)
    assert.ok(out.error, `expected error for ${JSON.stringify(raw)}`)
    assert.equal(out.action, undefined)
  }
})

test('sanitize: 白名单里的每个 op 都不会落到 unsupported', () => {
  const needsValue = { loop: 'off', quality: 'high', replayGain: 'off', bgMode: 'default',
    backgroundMode: 'common', backgroundLayout: 'full-overlay', changeLyricsSource: 'online' }
  for (const op of PANEL_OPS) {
    let raw = { op }
    if (op === 'volume' || op === 'lyricOffset') raw.value = 0
    else if (op === 'importLyrics') { raw.text = 'x'; raw.name = 'a.lrc' }
    else if (['playIndex', 'removeIndex', 'moveNext', 'moveEnd'].includes(op)) raw.index = 0
    else if (op === 'visualizer') raw.value = 'classic'
    else if (needsValue[op]) raw.value = needsValue[op]
    const out = sanitizePanelAction(raw)
    assert.equal(out.error, undefined, `${op} 被拒: ${out.error}`)
    assert.equal(out.action.op, op)
  }
})

/* ── sanitizePanelAction：数值夹取 ─────────────────────────────────────── */

test('sanitize volume: 夹到 [0,1]', () => {
  assert.equal(sanitizePanelAction({ op: 'volume', value: 0.5 }).action.value, 0.5)
  assert.equal(sanitizePanelAction({ op: 'volume', value: 5 }).action.value, 1)
  assert.equal(sanitizePanelAction({ op: 'volume', value: -5 }).action.value, 0)
})

test('sanitize volume: 非数字 / 非有限数拒绝', () => {
  // 注意 '0.25' 也拒绝：客户端只发数字，边界上不做 Number() 的隐式转换。
  for (const value of [undefined, null, '', '0.25', 'abc', NaN, Infinity, -Infinity, {}, true]) {
    assert.ok(sanitizePanelAction({ op: 'volume', value }).error, JSON.stringify(value))
  }
})

test('sanitize lyricOffset: 夹到 ±上限并取整', () => {
  assert.equal(sanitizePanelAction({ op: 'lyricOffset', value: 1234.7 }).action.value, 1235)
  assert.equal(sanitizePanelAction({ op: 'lyricOffset', value: 1e9 }).action.value, LYRIC_OFFSET_MAX_MS)
  assert.equal(sanitizePanelAction({ op: 'lyricOffset', value: -1e9 }).action.value, -LYRIC_OFFSET_MAX_MS)
})

test('sanitize index: 只接受 [0, INDEX_MAX] 的整数', () => {
  for (const op of ['playIndex', 'removeIndex', 'moveNext', 'moveEnd']) {
    assert.equal(sanitizePanelAction({ op, index: 0 }).action.index, 0)
    assert.equal(sanitizePanelAction({ op, index: INDEX_MAX }).action.index, INDEX_MAX)
    for (const index of [-1, INDEX_MAX + 1, 1.5, '3', null, undefined, NaN, Infinity, true]) {
      assert.ok(sanitizePanelAction({ op, index }).error, `${op} ${String(index)}`)
    }
  }
})

/* ── sanitizePanelAction：枚举 ─────────────────────────────────────────── */

test('sanitize 枚举: 每个枚举 op 只接受白名单里的值', () => {
  for (const [op, allowed] of Object.entries(PANEL_ENUMS)) {
    for (const value of allowed) {
      assert.equal(sanitizePanelAction({ op, value }).action.value, value, `${op}=${value}`)
    }
    for (const value of ['', 'nope', 'OFF', null, undefined, 1, {}]) {
      assert.ok(sanitizePanelAction({ op, value }).error, `${op} 接受了 ${JSON.stringify(value)}`)
    }
  }
})

test('sanitize visualizer: 只接受已知样式', () => {
  for (const value of VISUALIZER_MODES) {
    assert.equal(sanitizePanelAction({ op: 'visualizer', value }).action.value, value)
  }
  for (const value of ['', 'nope', 'Classic', null, 1]) {
    assert.ok(sanitizePanelAction({ op: 'visualizer', value }).error, String(value))
  }
})

test('sanitize 布尔: 只认 true，其余一律 false', () => {
  for (const op of ['mute', 'like', 'daylight', 'automix', 'eqEnabled']) {
    assert.equal(sanitizePanelAction({ op, value: true }).action.value, true)
    for (const value of [false, 'true', 1, 0, null, undefined, {}]) {
      assert.equal(sanitizePanelAction({ op, value }).action.value, false, `${op} ${String(value)}`)
    }
  }
})

/* ── sanitizePanelAction：歌词导入 ─────────────────────────────────────── */

test('sanitize importLyrics: 正常正文与文件名通过', () => {
  const out = sanitizePanelAction({ op: 'importLyrics', text: '[00:00.00]hi', name: 'song.lrc' })
  assert.equal(out.action.text, '[00:00.00]hi')
  assert.equal(out.action.name, 'song.lrc')
})

test('sanitize importLyrics: 空正文 / 超长正文拒绝', () => {
  assert.ok(sanitizePanelAction({ op: 'importLyrics', text: '', name: 'a.lrc' }).error)
  assert.ok(sanitizePanelAction({ op: 'importLyrics', name: 'a.lrc' }).error)
  const huge = 'x'.repeat(LYRICS_MAX_CHARS + 1)
  assert.ok(sanitizePanelAction({ op: 'importLyrics', text: huge, name: 'a.lrc' }).error)
  const exact = 'x'.repeat(LYRICS_MAX_CHARS)
  assert.equal(sanitizePanelAction({ op: 'importLyrics', text: exact, name: 'a.lrc' }).action.text.length, LYRICS_MAX_CHARS)
})

test('sanitize importLyrics: 文件名里的路径分隔符与非法字符一律拒绝', () => {
  for (const name of ['../a.lrc', 'a/b.lrc', 'a\\b.lrc', 'a:b.lrc', 'a*b.lrc',
    'a?b.lrc', 'a"b.lrc', 'a<b.lrc', 'a>b.lrc', 'a|b.lrc', '', 'x'.repeat(201)]) {
    assert.ok(sanitizePanelAction({ op: 'importLyrics', text: 'x', name }).error, JSON.stringify(name))
  }
  for (const name of ['a.lrc', '歌曲名.lrc', 'a b.lrc', 'x'.repeat(200)]) {
    assert.equal(sanitizePanelAction({ op: 'importLyrics', text: 'x', name }).error, undefined, name)
  }
})

/* ── sanitizePanelAction：多余字段被丢弃 ───────────────────────────────── */

test('sanitize: 动作对象里只保留已知字段，别的一律丢掉', () => {
  const out = sanitizePanelAction({
    op: 'volume', value: 0.5,
    text: 'evil', name: 'evil', index: 7, positionMs: 9, extra: { nested: true },
  })
  assert.deepEqual(out.action, { op: 'volume', value: 0.5 })
})

test('sanitize: 已下线的 op 现在被拒绝', () => {
  // 这些曾经在白名单里，但客户端从来没有发过；留着等于白白扩大攻击面。
  for (const op of ['seek', 'play', 'pause', 'toggle', 'next', 'prev',
    'eqPreset', 'lyricProvider', 'matchOnline', 'backgroundSource',
    'transparent', 'coverColorBg']) {
    assert.ok(sanitizePanelAction({ op, value: true, positionMs: 1 }).error, op)
  }
})

test('sanitize: 返回的 action 可以安全内插进页面表达式', () => {
  // Host 侧用 JSON.stringify 内插，所以只要值里没有能闭合表达式的字符就够；
  // 这里钉住「白名单之外的值进不来」这一点。
  const attempts = [
    { op: 'loop', value: "off');alert(1);//" },
    { op: 'visualizer', value: "classic');alert(1);//" },
    { op: 'importLyrics', text: 'x', name: "a');alert(1);//.lrc" },
    { op: 'quality', value: 'high`);alert(1);//' },
  ]
  for (const raw of attempts) {
    assert.ok(sanitizePanelAction(raw).error, JSON.stringify(raw))
  }
})
