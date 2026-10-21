import { seekIdentity } from './seek.js'

export const fullLyricsMarkup = `<section class="full-lyrics" id="music-full-lyrics" role="dialog" aria-label="整首歌词" hidden>
  <header><div class="lyrics-heading"><strong class="lyrics-title"></strong><span class="lyrics-artist"></span></div><button class="lyrics-close" aria-label="关闭整首歌词" title="关闭整首歌词">×</button></header>
  <div class="lyrics-body" tabindex="0" role="region" aria-label="歌词列表"></div>
  <footer><span class="lyrics-notice" role="status"></span><button class="lyrics-follow" hidden>回到当前歌词</button></footer>
</section>`

const format = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
const documentKey = snapshot => JSON.stringify([seekIdentity(snapshot.track), snapshot.lyric?.mid, snapshot.lyric?.offset,
  snapshot.lyric?.lines?.map(line => [line.start, line.text])])

export function lyricLineTarget(snapshot, index, expectedKey) {
  const track = snapshot?.track, lyric = snapshot?.lyric, line = lyric?.lines?.[index]
  if (!track || expectedKey !== seekIdentity(track) || !track.songmid || lyric?.mid !== track.songmid
    || !Number.isInteger(index) || index < 0 || !Number.isFinite(line?.start) || line.start < 0
    || !Number.isFinite(track.durationMs) || track.durationMs <= 0 || !Number.isFinite(lyric.offset ?? 0)) return null
  // Rendering uses time = position - offset, so seeking must add the offset.
  const position = Math.max(0, line.start + (lyric.offset || 0))
  return position < track.durationMs ? Math.round(position) : null
}

export function fullLyricsLayout({ anchor, viewport, origin = { left: 0, top: 0 } }) {
  const { width, height } = viewport
  if (![width, height, anchor.left, anchor.top, anchor.bottom, anchor.width, origin.left, origin.top].every(Number.isFinite)
    || width < 100 || height < 100) return null
  const gap = 8, margin = 16, w = Math.min(520, width - margin * 2)
  const above = anchor.top - gap - margin, below = height - anchor.bottom - gap - margin
  const up = above >= 180 || above >= below
  const h = Math.min(440, up ? above : below)
  // With very little room around the dock, keep the panel inside the viewport.
  const panelHeight = Math.max(0, Math.min(height - margin * 2, h < 140 ? height - margin * 2 : h))
  const top = h < 140 ? margin : up ? anchor.top - gap - panelHeight : anchor.bottom + gap
  return { width: w, height: panelHeight, left: Math.max(margin, Math.min(width - margin - w, anchor.left + (anchor.width - w) / 2)) - origin.left,
    top: Math.max(margin, Math.min(height - margin - panelHeight, top)) - origin.top }
}

export function createFullLyrics({ root, toggle, getContext, onSeek, onLayout, beforeOpen = () => {} }) {
  const $ = selector => root.querySelector(selector), body = $('.lyrics-body'), notice = $('.lyrics-notice'), follow = $('.lyrics-follow')
  let key = '', lastSnapshot = null, rows = [], active = -1, following = true, needsFollow = false, availability = null, message = ''
  const events = new AbortController(), listen = (node, name, handler, options = {}) => node.addEventListener(name, handler, { ...options, signal: events.signal })
  function close(focus = false) {
    root.hidden = true; toggle.setAttribute('aria-expanded', 'false')
    if (focus) toggle.focus({ preventScroll: true })
  }
  function center() {
    const row = rows[active]
    body.scrollTo({ top: row ? Math.max(0, row.offsetTop - (body.clientHeight - row.offsetHeight) / 2) : 0,
      behavior: needsFollow || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    needsFollow = false
  }
  function manual() { following = false; follow.hidden = false; body.scrollTo({ top: body.scrollTop, behavior: 'instant' }) }
  listen(body, 'wheel', manual, { passive: true })
  listen(body, 'touchmove', manual, { passive: true })
  listen(body, 'pointerdown', event => { if (event.target === body) manual() })
  listen(body, 'keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) manual() })
  listen(follow, 'click', () => { following = true; needsFollow = true; follow.hidden = true; center() })
  listen($('.lyrics-close'), 'click', () => close(true))
  function update() {
    const context = getContext(), snapshot = context.snapshot
    if (!snapshot?.track || !snapshot.lyric?.lines?.length || snapshot.state === 'disabled') { close(); return }
    if (root.hidden) return
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot
      const nextKey = documentKey(snapshot)
      if (key !== nextKey) {
        key = nextKey; active = -1; availability = null; following = true; needsFollow = true; message = ''; follow.hidden = true
        $('.lyrics-title').textContent = snapshot.track.title
        $('.lyrics-artist').textContent = snapshot.track.artist || ''
        const expectedKey = seekIdentity(snapshot.track), capturedKey = key
        rows = snapshot.lyric.lines.map((line, index) => {
          const button = document.createElement('button'), time = document.createElement('span'), text = document.createElement('span')
          button.className = 'lyrics-line'; button.type = 'button'
          time.className = 'lyrics-line-time'; time.textContent = Number.isFinite(line.start) ? format(line.start + (snapshot.lyric.offset || 0)) : '—'
          text.className = 'lyrics-line-text'; text.textContent = String(line.text || '♪')
          button.append(time, text)
          button.setAttribute('aria-label', `${text.textContent}，从 ${time.textContent} 播放`)
          button.onclick = async () => {
            const current = getContext()
            if (!current.available || capturedKey !== key || documentKey(current.snapshot) !== capturedKey) return
            const target = lyricLineTarget(current.snapshot, index, expectedKey)
            if (target === null) return
            following = true; needsFollow = true; follow.hidden = true; message = ''
            try { await onSeek(target) } catch { if (key === capturedKey) message = '定位失败，请重试' }
            update()
          }
          return button
        })
        body.replaceChildren(...rows)
      }
    }
    const state = `${context.available}:${context.demo}`
    if (availability !== state) {
      availability = state
      const expectedKey = seekIdentity(snapshot.track)
      rows.forEach((row, i) => { row.disabled = !context.available || lyricLineTarget(snapshot, i, expectedKey) === null })
    }
    const time = context.position - (snapshot.lyric.offset || 0)
    let index = -1
    for (let i = 0; i < snapshot.lyric.lines.length && snapshot.lyric.lines[i].start <= time; i++) index = i
    if (index !== active) {
      if (rows[active]) { rows[active].classList.remove('current'); rows[active].removeAttribute('aria-current') }
      active = index
      if (rows[active]) { rows[active].classList.add('current'); rows[active].setAttribute('aria-current', 'true') }
      if (following) center()
    } else if (following && needsFollow) center()
    const label = message || (context.demo ? '预览模式，不操作播放器' : context.busy ? '正在定位…' : context.available ? '点击歌词，从这里播放' : '当前歌词暂不可定位')
    if (notice.textContent !== label) notice.textContent = label
  }
  return {
    get open() { return !root.hidden },
    toggle(open = root.hidden) {
      if (!open) { close(); return }
      beforeOpen(); root.hidden = false; toggle.setAttribute('aria-expanded', 'true')
      needsFollow = true; following = true; message = ''; follow.hidden = true; onLayout(); update()
    },
    close, update,
    fail(text) { message = text; update() },
    dispose() { events.abort(); close() },
  }
}
