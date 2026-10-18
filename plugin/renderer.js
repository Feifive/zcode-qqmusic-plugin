;(async () => {
  if (window.__zcodeMusicDock) return
  window.__zcodeMusicDock = true
  const api = window.zcodeMusic
  if (!api) return
  const scriptURL = document.currentScript?.src || new URL('./zcode-music.js', location.href).href
  const { wordTextRanges, sweepPositionAt, followWordOffset } = await import(new URL('./lyric-timing.js', scriptURL).href)
  const { paletteForArtwork, relativeLuminance } = await import(new URL('./lib/colors.js', scriptURL).href)
  const host = document.createElement('div')
  host.id = 'zcode-music-plugin'
  host.hidden = true
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `<link rel="stylesheet" href="${new URL('./renderer.css', scriptURL)}">
    <div class="dock" hidden>
      <button class="track" title="打开 QQ 音乐歌词设置"><span class="note">♪</span><span class="name"></span><span class="meter"><i></i><i></i><i></i></span></button>
      <div class="lyric"><span></span></div>
      <div class="transport"><span class="time"></span><div class="controls">
        <button data-action="prev" aria-label="上一首" title="上一首"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5v14M19 5 9 12l10 7V5Z"/></svg></button>
        <button data-action="toggle" aria-label="播放" title="播放"><svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m8 5 11 7-11 7V5Z"/></svg><svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5v14M15 5v14"/></svg></button>
        <button data-action="next" aria-label="下一首" title="下一首"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 5v14M5 5l10 7-10 7V5Z"/></svg></button>
      </div></div><div class="progress"><i></i></div>
    </div>
    <div class="idle"><button class="launcher" title="QQ 音乐歌词设置" aria-label="QQ 音乐歌词设置">♪</button></div>
    <section class="panel" hidden aria-label="QQ 音乐歌词设置">
      <header><span>♪ QQ 音乐歌词</span><button class="close" aria-label="关闭设置">×</button></header>
      <p class="status">正在连接播放器…</p>
      <label><span>显示同步歌词</span><input class="enabled" type="checkbox" checked></label>
      <label><span>也跟随其他播放器</span><input class="any-app" type="checkbox"></label>
      <label><span>配色来源</span><select class="color-mode" aria-label="配色来源"><option value="theme">跟随 ZCode 主题色</option><option value="album" selected>跟随专辑色</option></select></label>
      <button class="demo">预览歌词条</button>
      <div class="updates" hidden><div class="update-heading"><span class="version"></span><button class="check-update">检查更新</button></div><p class="update-status" role="status"></p><div class="update-actions"><button class="install-update" hidden>更新并重启</button><button class="restart-update" hidden>重启生效</button><button class="rollback-update" hidden>回退并重启</button></div></div>
      <p class="hint">在 QQ 音乐播放歌曲，歌词将自动出现。仅跟随系统当前播放的媒体会话。</p>
    </section>`
  const $ = s => shadow.querySelector(s)
  const dock = $('.dock'), viewport = $('.lyric'), line = $('.lyric span'), status = $('.status')
  let data = { state: 'starting' }, demo = false, disposed = false, timer, surface, lineKey = '', lastTrack = ''
  let busy = false, configuring = 0
  let geometryDirty = true, measuredWords = [], textWidth = 0, viewportWidth = 0
  $('link').addEventListener('load', () => { geometryDirty = true })
  document.fonts?.ready.then(() => { geometryDirty = true })
  const onFontsLoaded = () => { geometryDirty = true }
  document.fonts?.addEventListener('loadingdone', onFontsLoaded)
  const messages = { idle: '等待 QQ 音乐播放', starting: '正在连接播放器…', disabled: '歌词插件已关闭', unavailable: '系统播放信息暂时不可用', 'no-match': '未找到匹配歌曲', 'no-lyric': '这首歌暂无歌词', error: '歌词暂时不可用' }
  const demoData = {
    state: 'playing', sampledAt: Date.now(), enabled: true,
    artworkColors: {magicColors:[{h:166,s:.62,b:.64}],pureColor:{h:166,s:.62,b:.64}},
    track: { title: '歌词条预览', artist: 'QQ 音乐', playing: true, positionMs: 0, durationMs: 32000 },
    lyric: { offset: 0, lines: [
      { start: 0, duration: 8000, text: '让音乐陪你，把灵感写成代码', words: [{ text: '让音乐', start: 0, duration: 2200 }, { text: '陪你，', start: 2200, duration: 1400 }, { text: '把灵感', start: 3600, duration: 2000 }, { text: '写成代码', start: 5600, duration: 2400 }] },
      { start: 8000, duration: 8000, text: '一句歌词，一点专注，慢慢向前', words: [] },
      { start: 16000, duration: 8000, text: '这是界面演示，播放器不会被操作', words: [] },
      { start: 24000, duration: 8000, text: '播放你的下一首歌，继续此刻的灵感', words: [] },
    ] },
  }
  let demoStart = 0
  let paletteKey = '', colorCheckAt = 0
  const colorCanvas = document.createElement('canvas')
  colorCanvas.width = colorCanvas.height = 1
  const colorContext = colorCanvas.getContext('2d', {willReadFrequently:true})
  function lightSkin() {
    const layers = []
    for (let el=host.parentElement;el;el=el.parentElement) {
      colorContext.clearRect(0,0,1,1)
      colorContext.fillStyle = getComputedStyle(el).backgroundColor
      colorContext.fillRect(0,0,1,1)
      const rgba = [...colorContext.getImageData(0,0,1,1).data]
      layers.push(rgba)
      if (rgba[3]===255) break
    }
    let background = matchMedia('(prefers-color-scheme: dark)').matches?[24,24,24]:[255,255,255]
    for (const c of layers.reverse()) background = background.map((n,i)=>c[i]*c[3]/255+n*(1-c[3]/255))
    return relativeLuminance(background)>=.5
  }
  function paintPalette(snapshot) {
    const colorMode = $('.color-mode').value
    const key = colorMode + ':' + JSON.stringify(snapshot.artworkColors||null)
    if (key===paletteKey && Date.now()<colorCheckAt) return
    paletteKey=key; colorCheckAt=Date.now()+750
    const colors = colorMode === 'album' ? paletteForArtwork(snapshot.artworkColors,lightSkin()) : null
    for (const [property,value] of Object.entries({'--music-accent':colors?.accent,'--music-base':colors?.base,'--music-surface':colors?.surface})) {
      if (value) {
        if(host.style.getPropertyValue(property)!==value)host.style.setProperty(property,value)
      } else host.style.removeProperty(property)
    }
    dock.classList.toggle('magic',Boolean(colors))
  }
  const fmt = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
  function togglePanel(open = $('.panel').hidden) {
    $('.panel').hidden = !open
    if (open) { $('.close').focus(); updateStatus() }
  }
  let updateBusy = false
  async function updateStatus(action = 'status') {
    if (!api.update || updateBusy) return
    updateBusy = true
    $('.updates').hidden = false
    shadow.querySelectorAll('.updates button').forEach(b => { b.disabled = true })
    if (action === 'check') $('.update-status').textContent = '正在检查更新…'
    if (action === 'install') $('.update-status').textContent = '正在下载并安装更新…'
    try {
      const state = await api.update(action)
      if (action === 'restart') return
      $('.version').textContent = `版本 ${state.runningVersion}`
      $('.install-update').hidden = !state.available || state.restartRequired
      $('.restart-update').hidden = !state.restartRequired
      $('.rollback-update').hidden = !state.previousVersion
      $('.update-status').textContent = state.restartRequired ? `已安装 ${state.installedVersion}，重启后生效` : state.available ? `发现新版本 ${state.latestVersion}` : action === 'check' ? '已是最新版本' : ''
      if (action === 'install' || action === 'rollback') await api.update('restart')
    } catch (error) {
      $('.update-status').textContent = '操作未完成：' + String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    } finally {
      updateBusy = false
      shadow.querySelectorAll('.updates button').forEach(b => { b.disabled = false })
    }
  }
  $('.check-update').onclick = () => updateStatus('check')
  $('.install-update').onclick = () => updateStatus('install')
  $('.restart-update').onclick = () => updateStatus('restart')
  $('.rollback-update').onclick = () => updateStatus('rollback')
  $('.track').onclick = () => togglePanel()
  $('.launcher').onclick = () => togglePanel()
  $('.close').onclick = () => togglePanel(false)
  shadow.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(false) })
  function outside(e) { if (!e.composedPath().includes(host)) togglePanel(false) }
  document.addEventListener('pointerdown', outside)
  async function configure({ keepDemo = false } = {}) {
    configuring++
    try {
      await api.configure({ enabled: $('.enabled').checked, anyApp: $('.any-app').checked, colorMode: $('.color-mode').value })
      if (!keepDemo) {
        demo = false
        $('.demo').textContent = '预览歌词条'
      }
      colorCheckAt = 0
      paint()
    } catch { status.textContent = '设置保存失败，请重试' }
    finally { configuring--; refresh() }
  }
  $('.enabled').onchange = configure
  $('.any-app').onchange = configure
  $('.color-mode').onchange = () => configure({ keepDemo: true })
  $('.demo').onclick = () => {
    demo = !demo
    demoStart = Date.now()
    $('.demo').textContent = demo ? '退出预览' : '预览歌词条'
    status.textContent = demo ? '正在预览 · 演示内容' : messages[data.state] || '已连接播放器'
    lineKey = ''
    paint()
  }
  shadow.querySelectorAll('[data-action]').forEach(button => {
    button.onclick = async () => {
      if (demo || busy) return
      busy = true
      shadow.querySelectorAll('[data-action]').forEach(b => { b.disabled = true })
      try {
        const result = await api.control(button.dataset.action)
        if (!result.ok) { status.textContent = '播放控制失败，请在 QQ 音乐中操作'; togglePanel(true) }
        await refresh()
      } catch { status.textContent = '播放控制失败'; togglePanel(true) }
      finally { busy = false; shadow.querySelectorAll('[data-action]').forEach(b => { b.disabled = demo }) }
    }
  })
  let timeline = null
  function syncDockVisibility() {
    // Use ZCode's own follow state: measuring scrollHeight here would include
    // this sticky dock and could toggle it repeatedly as its height changes.
    const hidden = !surface || timeline?.getAttribute('data-following') === 'false'
    if (host.hidden === hidden) return
    host.hidden = hidden
    if (hidden) togglePanel(false)
    else { geometryDirty = true; colorCheckAt = 0 }
  }
  const followObserver = new MutationObserver(syncDockVisibility)
  function followTimeline(next) {
    if (timeline !== next) {
      followObserver.disconnect()
      timeline = next
      if (timeline) followObserver.observe(timeline, { attributes: true, attributeFilter: ['data-following'] })
    }
    syncDockVisibility()
  }
  function mount() {
    const candidates = [...document.querySelectorAll('.chat-composer-input-surface')]
    const next = candidates.find(el => el.getBoundingClientRect().width > 0 && el.closest('[aria-hidden="true"]') === null)
    if (!next) { if(surface)resize.unobserve(surface);host.remove(); surface = null; followTimeline(null); return }
    if (surface!==next) { if(surface)resize.unobserve(surface);resize.observe(next) }
    surface = next
    if (host.parentNode !== next.parentNode || host.nextSibling !== next) next.before(host)
    host.style.width = `${next.getBoundingClientRect().width}px`
    followTimeline(next.closest('[data-v4-timeline-scroll="true"]'))
  }
  async function refresh() {
    if (disposed) return
    try {
      data = await api.snapshot()
      if (!configuring) $('.color-mode').value = data.colorMode === 'theme' ? 'theme' : 'album'
      if (!demo) {
        status.textContent = messages[data.state] || `${data.track?.playing ? '正在播放' : '已暂停'} · ${data.track?.title || 'QQ 音乐'}`
        $('.enabled').checked = data.enabled !== false
        $('.any-app').checked = data.anyApp === true
      }
    } catch { data = { state: 'error' }; status.textContent = messages.error }
    paint()
    clearTimeout(timer)
    if (!disposed) timer = setTimeout(refresh, document.hidden ? 10000 : 2000)
  }
  function paint() {
    if (host.hidden) return
    const snapshot = demo ? demoData : data
    paintPalette(snapshot)
    const track = snapshot.track
    const visible = Boolean(track) && snapshot.state !== 'disabled'
    dock.hidden = !visible
    $('.idle').hidden = visible
    if (!visible) return
    const id = `${demo}:${track.title}:${track.artist}`
    if (lastTrack !== id) {
      $('.name').textContent = `${track.title}${track.artist ? ` · ${track.artist}` : ''}`
      $('.track').title = `${track.title} — ${track.artist || 'QQ 音乐'} · 点击打开歌词设置`
      lastTrack = id
    }
    const age = Date.now() - (snapshot.sampledAt || Date.now())
    const position = demo ? (Date.now() - demoStart) % 32000 : Math.min(track.durationMs || Infinity, track.positionMs + (track.playing ? Math.max(0, age) : 0))
    const time = position - (snapshot.lyric?.offset || 0)
    const lines = snapshot.lyric?.lines || []
    let index = -1
    for (let i = 0; i < lines.length && lines[i].start <= time; i++) index = i
    const current = lines[index]
    const key = `${id}:${index}:${snapshot.state}:${snapshot.lyric?.mid || ''}:${current?.words?.length || 0}:${current?.text || ''}`
    if (lineKey !== key) {
      line.textContent = current?.text || (lines.length ? '♪' : messages[snapshot.state] || '正在获取歌词…')
      lineKey = key
      viewport.classList.remove('enter')
      void viewport.offsetWidth
      viewport.classList.add('enter')
      geometryDirty = true
    }
    if (geometryDirty) {
      geometryDirty = false
      const bounds = line.getBoundingClientRect()
      textWidth = bounds.width
      viewportWidth = viewport.clientWidth
      measuredWords = []
      const node = line.firstChild
      if (node?.nodeType === Node.TEXT_NODE && current?.words?.length) {
        const range = document.createRange()
        for (const word of wordTextRanges(line.textContent, current.words)) {
          range.setStart(node, word.from)
          range.setEnd(node, word.to)
          const rect = range.getBoundingClientRect()
          measuredWords.push({ ...word, left: rect.left - bounds.left, right: rect.right - bounds.left })
        }
      }
      const distance = Math.max(0, textWidth - viewportWidth)
      line.style.setProperty('--overflow', `${-distance}px`)
      line.style.setProperty('--marquee-duration', `${Math.max(7, distance / 24)}s`)
      line.classList.toggle('scroll', measuredWords.length === 0 && distance > 2)
      line.classList.toggle('word-timed', measuredWords.length > 0)
      line.classList.toggle('untimed', measuredWords.length === 0)
    }
    if (measuredWords.length) {
      const x = sweepPositionAt(measuredWords, time, textWidth)
      line.style.setProperty('--sweep-x', `${x}px`)
      line.style.transform = `translateX(${-followWordOffset(x, textWidth, viewportWidth)}px)`
    } else {
      line.style.removeProperty('transform')
    }
    const timeText = `${fmt(position)} / ${fmt(track.durationMs)}`
    if ($('.time').textContent !== timeText) $('.time').textContent = timeText
    $('.progress i').style.width = `${Math.min(100, Math.max(0, position / (track.durationMs || Infinity) * 100))}%`
    dock.classList.toggle('playing', track.playing)
    const toggle = $('.controls [data-action="toggle"]')
    const label = track.playing ? '暂停' : '播放'
    if (toggle.title !== label) { toggle.title = label; toggle.setAttribute('aria-label', label) }
    shadow.querySelectorAll('[data-action]').forEach(b => { if (b.disabled !== (demo || busy)) b.disabled = demo || busy })
  }
  // Observe React navigation without reaching into React's internal state.
  const observer = new MutationObserver(mount)
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true })
  const resize = new ResizeObserver(() => { if (surface) host.style.width = `${surface.getBoundingClientRect().width}px` })
  resize.observe(document.body)
  const lyricResize = new ResizeObserver(() => { geometryDirty = true })
  lyricResize.observe(viewport)
  let frame
  function animate() {
    if (!document.hidden) paint()
    frame = requestAnimationFrame(animate)
  }
  window.addEventListener('pagehide', () => {
    disposed = true; clearTimeout(timer); cancelAnimationFrame(frame); observer.disconnect(); followObserver.disconnect(); resize.disconnect(); lyricResize.disconnect()
    document.fonts?.removeEventListener('loadingdone', onFontsLoaded)
    document.removeEventListener('pointerdown', outside); host.remove()
  }, { once: true })
  mount()
  refresh()
  frame = requestAnimationFrame(animate)
})().catch(error => console.error('[zcode-music] renderer initialization failed', error))
