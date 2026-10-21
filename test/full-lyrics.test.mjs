import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lyricLineTarget, fullLyricsLayout, createFullLyrics } from '../plugin/lib/full-lyrics.js'
import { seekIdentity } from '../plugin/lib/seek.js'

const snapshot = () => ({ track: { app: 'com.tencent.QQMusicMac', title: '歌曲', artist: '歌手', album: '专辑', songmid: 'mid', durationMs: 100000 },
  lyric: { mid: 'mid', offset: 1200, lines: [{ start: 0 }, { start: 5000 }, { start: 99000 }, { start: -1 }, { start: NaN }] } })

test('lyric targets add offset, clamp negative offsets and reject rows past the recording', () => {
  const s = snapshot(), key = seekIdentity(s.track)
  assert.equal(lyricLineTarget(s, 0, key), 1200); assert.equal(lyricLineTarget(s, 1, key), 6200)
  assert.equal(lyricLineTarget(s, 2, key), null)
  s.lyric.offset = -2000
  assert.equal(lyricLineTarget(s, 0, key), 0); assert.equal(lyricLineTarget(s, 1, key), 3000)
  for (const index of [-1, 1.5, 3, 4, 50]) assert.equal(lyricLineTarget(s, index, key), null)
  s.lyric.offset = NaN; assert.equal(lyricLineTarget(s, 0, key), null)
})

test('old lyric rows never target another track, album, version or lyric identity', () => {
  const original = snapshot(), key = seekIdentity(original.track)
  for (const change of [{ title: '歌曲 (Live)' }, { songmid: 'other' }, { album: '另一张专辑' }, { artist: '另一位歌手' }, { app: 'other' }, { durationMs: 200000 }]) {
    const s = snapshot(); Object.assign(s.track, change); assert.equal(lyricLineTarget(s, 1, key), null)
  }
  const s = snapshot(); s.lyric.mid = 'other'; assert.equal(lyricLineTarget(s, 1, key), null)
  s.lyric.mid = s.track.songmid = ''; assert.equal(lyricLineTarget(s, 1, seekIdentity(s.track)), null)
})

test('full lyrics fit above/below the dock, narrow viewports and a short window', () => {
  const base = { anchor: { left: 200, top: 600, bottom: 632, width: 600 }, viewport: { width: 1000, height: 800 }, origin: { left: 100, top: 600 } }
  assert.deepEqual(fullLyricsLayout(base), { width: 520, height: 440, left: 140, top: -448 })
  for (const [width, height, top] of [[320, 640, 450], [1000, 800, 40], [250, 200, 80]]) {
    const result = fullLyricsLayout({ anchor: { left: 0, top, bottom: top + 32, width: width - 10 }, viewport: { width, height } })
    assert.ok(result.left >= 16); assert.ok(result.top >= 16)
    assert.ok(result.left + result.width <= width - 16); assert.ok(result.top + result.height <= height - 16)
  }
  assert.equal(fullLyricsLayout({ ...base, viewport: { width: NaN, height: 800 } }), null)
})

// An offline DOM double exercises the controller's real event handlers without
// launching a browser, fetching resources or claiming to validate CSS layout.
class Element extends EventTarget {
  constructor() {
    super(); this.hidden = false; this.disabled = false; this.children = []; this.attributes = new Map(); this.classes = new Set()
    this.clientHeight = 120; this.offsetHeight = 30; this.offsetTop = 0; this.scrollTop = 0
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) }
  }
  setAttribute(key, value) { this.attributes.set(key, value) }
  removeAttribute(key) { this.attributes.delete(key) }
  getAttribute(key) { return this.attributes.get(key) }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes; nodes.forEach((node, i) => node.offsetTop = i * 30) }
  scrollTo(value) { this.scrollTop = value.top; this.lastScroll = value }
  focus() { this.focused = true }
  click() { if (this.disabled) return; this.dispatchEvent(new Event('click')); return this.onclick?.() }
}
function withDOM(run) {
  const oldDocument = globalThis.document, oldMatchMedia = globalThis.matchMedia
  globalThis.document = { createElement: () => new Element() }; globalThis.matchMedia = () => ({ matches: true })
  try { return run() } finally { globalThis.document = oldDocument; globalThis.matchMedia = oldMatchMedia }
}
function controllerFixture() {
  const nodes = Object.fromEntries(['.lyrics-body', '.lyrics-notice', '.lyrics-follow', '.lyrics-close', '.lyrics-title', '.lyrics-artist'].map(name => [name, new Element()]))
  const root = new Element(), toggle = new Element(); root.hidden = true; root.querySelector = name => nodes[name]
  const s = snapshot(); s.lyric.offset = 0; s.lyric.lines = Array.from({ length: 20 }, (_, i) => ({ start: i * 4000, text: i === 3 ? '<img onerror=attack>' : `line ${i}` }))
  const context = { snapshot: s, available: true, demo: false, position: 16000 }, calls = []
  const controller = createFullLyrics({ root, toggle, getContext: () => context, onLayout: () => {}, onSeek: async target => calls.push(target) })
  return { nodes, root, toggle, context, calls, controller, rows: () => nodes['.lyrics-body'].children }
}

test('full lyrics render safe text, follow the active line and pause on user scrolling', () => withDOM(() => {
  const f = controllerFixture(); f.controller.toggle()
  assert.equal(f.root.hidden, false); assert.equal(f.rows().length, 20); assert.equal(f.rows()[4].getAttribute('aria-current'), 'true')
  assert.equal(f.rows()[3].children[1].textContent, '<img onerror=attack>')
  const body = f.nodes['.lyrics-body']; body.dispatchEvent(new Event('wheel')); body.scrollTop = 333
  f.context.position = 36000; f.controller.update()
  assert.equal(body.scrollTop, 333); assert.equal(f.nodes['.lyrics-follow'].hidden, false)
  assert.equal(f.rows()[9].getAttribute('aria-current'), 'true'); assert.equal(f.rows()[4].getAttribute('aria-current'), undefined)
  f.nodes['.lyrics-follow'].click(); assert.equal(body.scrollTop, 225); assert.equal(f.nodes['.lyrics-follow'].hidden, true)
  f.nodes['.lyrics-close'].click(); assert.equal(f.root.hidden, true); assert.equal(f.toggle.focused, true)
  assert.equal(f.toggle.getAttribute('aria-expanded'), 'false'); f.controller.dispose()
}))

test('old row events cannot seek after same-title album/identity changes; disabled/demo rows never send', () => withDOM(() => {
  const f = controllerFixture(); f.controller.toggle(); const stale = f.rows()[2]
  f.context.snapshot = { ...f.context.snapshot, track: { ...f.context.snapshot.track, album: 'Other', songmid: 'other' }, lyric: { ...f.context.snapshot.lyric, mid: 'other' } }
  f.controller.update(); stale.click(); assert.deepEqual(f.calls, [])
  f.rows()[2].click(); assert.deepEqual(f.calls, [8000])
  f.context.available = false; f.context.demo = true; f.controller.update(); f.rows()[1].click()
  assert.equal(f.calls.length, 1); assert.ok(f.rows().every(row => row.disabled))
  assert.equal(f.nodes['.lyrics-notice'].textContent, '预览模式，不操作播放器')
  f.context.snapshot = { ...f.context.snapshot, lyric: null }; f.controller.update(); assert.equal(f.root.hidden, true)
  f.controller.dispose()
}))

test('a pending seek disables repeated activation and failure leaves the lyrics readable', async () => {
  const oldDocument = globalThis.document, oldMatchMedia = globalThis.matchMedia
  globalThis.document = { createElement: () => new Element() }; globalThis.matchMedia = () => ({ matches: true })
  try {
    const f = controllerFixture(); f.controller.toggle(); f.context.available = false; f.context.busy = true; f.controller.update()
    f.rows()[1].click(); assert.equal(f.calls.length, 0); assert.equal(f.nodes['.lyrics-notice'].textContent, '正在定位…')
    f.context.busy = false; f.context.available = true; f.controller.fail('定位失败，请重试')
    assert.equal(f.root.hidden, false); assert.equal(f.nodes['.lyrics-notice'].textContent, '定位失败，请重试')
    f.controller.dispose()
  } finally { globalThis.document = oldDocument; globalThis.matchMedia = oldMatchMedia }
})
