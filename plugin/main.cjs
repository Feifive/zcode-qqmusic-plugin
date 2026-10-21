module.exports = function start({ runtimeDir, rendererPath, settingsDir }) {
const { app, ipcMain, nativeImage, safeStorage } = require('electron')
const { execFile } = require('node:child_process')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { join } = require('node:path')
const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs')

const nativeDir = join(runtimeDir, 'native')
const helper = join(nativeDir, 'now-playing.dylib')
const reader = join(nativeDir, 'reader.pl')
const options = { apps: ['qqmusic'], anyApp: false, pollMs: 2000 }
let enabled = true
let colorMode = 'album'
let showCover = true
const settingsFile = join(settingsDir, 'settings.json')
let latest = null
let sampledAt = 0
let inflight
let inflightRevision = -1
let snapshotRevision = 0
let reporter
let previousMediaSample = null
let mediaUtils
let paletteReader
let accountSession

function getAccountSession() {
  accountSession ??= Promise.all([
    import(pathToFileURL(join(__dirname, 'lib/qq-session.js')).href),
    import(pathToFileURL(join(__dirname, 'lib/qq-profile.js')).href),
  ]).then(([{ createQQSession, createSessionStorage }, { createQQProfile }]) => createQQSession({
    storage: createSessionStorage({ settingsDir, safeStorage }), profile: createQQProfile(),
  }))
  return accountSession
}
function account(payload) { return getAccountSession().then(session => session.handle(payload)) }
async function favorite(payload) {
  if (!enabled) return { status: 'unavailable', liked: null, message: '歌词插件已关闭' }
  if (!['status', 'set'].includes(payload?.action) || typeof payload.songmid !== 'string' || payload.songmid.length > 64) throw Error('无效的收藏操作')
  if (payload.action === 'set' && typeof payload.liked !== 'boolean') throw Error('无效的收藏状态')
  const current = await snapshot()
  if (!current.track || current.track.songmid !== payload.songmid) throw Error('当前歌曲已变化，请重试')
  return (await getAccountSession()).favorite(payload, current.track)
}

function trusted(event) {
  try {
    return event.senderFrame === event.sender.mainFrame &&
      fileURLToPath(new URL(event.senderFrame.url)) === rendererPath
  } catch { return false }
}
function run(args = []) {
  const revision = snapshotRevision
  return new Promise(resolve => {
    execFile('/usr/bin/perl', [reader, helper], {
      timeout: 4500, maxBuffer: 64 * 1024,
      env: { ...process.env, ZCODE_MUSIC_ACTION: args[0] || 'snapshot', ZCODE_MUSIC_PLAYER: args[1] || 'com.tencent.QQMusicMac', ZCODE_MUSIC_POSITION: args[2] || '0', ZCODE_MUSIC_EXPECTED_TRACK: args[3] || '' },
    }, async (error, stdout) => {
      try {
        let result = JSON.parse(stdout)
        if ((args[0] || 'snapshot') === 'snapshot') {
          mediaUtils ??= import(pathToFileURL(join(__dirname, 'lib/nowplaying.js')).href)
          result = (await mediaUtils).normalizeMacSample(result, revision === snapshotRevision ? previousMediaSample : null)
          if (revision === snapshotRevision) previousMediaSample = result
        }
        resolve(result)
      }
      catch { resolve({ error: error?.code === 'ENOENT' ? 'helper-not-found' : 'mediaremote-unavailable', sessions: [], at: Date.now() }) }
    })
  })
}
async function snapshot() {
  if (!enabled) return { state: 'disabled', track: null, lyric: null, enabled, anyApp: options.anyApp, colorMode, showCover }
  if (latest && Date.now() - sampledAt < 1400) return latest
  if (inflight && inflightRevision === snapshotRevision) return inflight
  const revision = snapshotRevision
  const task = (async () => {
    reporter ??= Promise.all([
      import(pathToFileURL(join(__dirname, 'lib/playback.js')).href),
      import(pathToFileURL(join(__dirname, 'lib/local-song.js')).href),
    ]).then(([{ createPlaybackReporter }, { createLocalSongReader }]) => createPlaybackReporter({ options,
      resolveLocalIdentity: process.platform === 'darwin' ? createLocalSongReader({ reader, helper, run: execFile }) : undefined,
    }))
    const sample = await run(['snapshot'])
    const result = sample.error ? { state: 'unavailable', track: null, lyric: null, error: sample.error } : await (await reporter).report(sample)
    if (showCover || colorMode === 'album') paletteReader ??= Promise.all([
      import(pathToFileURL(join(__dirname, 'lib/artwork.js')).href),
      import(pathToFileURL(join(__dirname, 'lib/native-artwork.js')).href),
    ]).then(([{createPaletteReader},{createArtworkDecoder,createImageIOThumbnailer}]) => createPaletteReader({
      decode:createArtworkDecoder(nativeImage,{thumbnail:createImageIOThumbnailer({reader,helper})}),
    }))
    const artwork = (showCover || colorMode==='album') ? (await paletteReader).get(result.track?.albumMid) : null
    if (revision !== snapshotRevision) return snapshot()
    latest = { ...result, artworkThumbnail:showCover?artwork?.thumbnail||null:null, artworkColors:colorMode==='album'&&artwork?{magicColors:artwork.magicColors,pureColor:artwork.pureColor}:null, enabled, anyApp: options.anyApp, colorMode, showCover }
    sampledAt = Date.now()
    return latest
  })().finally(() => { if (inflight === task) inflight = null })
  inflight = task; inflightRevision = revision
  return task
}
async function cacheStatus() {
  const [music, artwork] = await Promise.allSettled([
    reporter ? reporter.then(value => value.cacheStats()) : Promise.resolve(null),
    paletteReader ? paletteReader.then(value => value.cacheSize()) : Promise.resolve(0),
  ])
  return {
    songs: music.status === 'fulfilled' ? music.value?.songs ?? 0 : 0,
    lyrics: music.status === 'fulfilled' ? music.value?.lyrics ?? 0 : 0,
    refrains: music.status === 'fulfilled' ? music.value?.refrains ?? 0 : 0,
    localSongs: music.status === 'fulfilled' ? music.value?.localSongs ?? 0 : 0,
    artworks: artwork.status === 'fulfilled' ? artwork.value : 0,
  }
}
function clearCache() {
  snapshotRevision++
  latest = null
  inflight = null
  reporter = null
  paletteReader = null
  return { songs: 0, lyrics: 0, refrains: 0, localSongs: 0, artworks: 0 }
}
async function control(payload, expectedKey) {
  if (!enabled) return { ok: false, error: 'disabled' }
  if (!['toggle', 'next', 'prev', 'seek'].includes(payload?.action)) return { ok: false, error: 'bad-action' }
  if (payload.action === 'seek' && (!Number.isFinite(payload.positionMs) || payload.positionMs < 0 || payload.positionMs > 86400000)) return { ok: false, error: 'bad-position' }
  let expected = null
  if (expectedKey !== undefined) {
    try {
      if (typeof expectedKey !== 'string' || expectedKey.length > 32768) throw Error()
      expected = JSON.parse(expectedKey)
      if (!Array.isArray(expected) || expected.length !== 6
        || ![expected[0], expected[2], expected[3], expected[4]].every(value => typeof value === 'string' && value.length <= 1024)
        || !Number.isFinite(expected[5]) || expected[5] <= 0 || expected[5] > 86400000) throw Error()
    } catch { return { ok: false, error: 'bad-identity' } }
  }
  const { pickSession, splitTitle } = await import(pathToFileURL(join(__dirname, 'lib/nowplaying.js')).href)
  const sample = await run(['snapshot'])
  const session = pickSession(sample.sessions, options)
  if (!session) return { ok: false, error: 'no-player' }
  const named = splitTitle(session.title, session.artist)
  if (expected && (expected[0] !== session.app || expected[2] !== named.title || expected[3] !== named.artist
    || expected[4] !== String(session.album || '') || expected[5] !== session.duration)) return { ok: false, error: 'track-changed' }
  const action = payload.action === 'toggle' ? (session.status === 'playing' ? 'pause' : 'play') : payload.action
  const position = payload.action === 'seek' ? Math.min(Math.round(payload.positionMs), Number.isFinite(session.duration) && session.duration > 0 ? Math.round(session.duration) : 86400000) : undefined
  const expectedRaw = payload.action === 'seek' ? JSON.stringify({ title: session.title || '', artist: session.artist || '', album: session.album || '', duration: session.duration || 0 }) : ''
  let result = await run([action, session.app, position === undefined ? '0' : String(position), expectedRaw])
  snapshotRevision++
  latest = null
  if (result.ok) {
    if (payload.action === 'seek') previousMediaSample = null
    const confirmed = await run(['snapshot'])
    if (payload.action === 'seek') {
      const current = confirmed.sessions?.find(s => s.app === session.app)
      if (!current || current.title !== session.title || current.artist !== session.artist
        || current.album !== session.album || current.duration !== session.duration) result = { ok: false, error: 'player-changed' }
      else if (current.status !== 'playing') {
        const resumed = await run(['play', session.app, '0', expectedRaw])
        if (!resumed.ok) result = { ok: false, error: 'playback-not-started' }
        else await run(['snapshot'])
      }
    }
  }
  snapshotRevision++
  latest = null
  return result
}
app.whenReady().then(() => {
  try {
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
    enabled = saved.enabled !== false
    options.anyApp = saved.anyApp === true
    colorMode = saved.colorMode === 'theme' ? 'theme' : 'album'
    showCover = saved.showCover !== false
  } catch { /* first launch */ }
  ipcMain.handle('zcode-music:snapshot', event => {
    if (!trusted(event)) throw new Error('Untrusted music plugin sender')
    return snapshot()
  })
  ipcMain.handle('zcode-music:configure', (event, config) => {
    if (!trusted(event)) throw new Error('Untrusted music plugin sender')
    // Reuse the fixed loader v1 bridge so existing installations can receive
    // login through an ordinary runtime update without patching ZCode.app.
    if (config && Object.hasOwn(config, 'account')) return account(config.account)
    if (config && Object.hasOwn(config, 'favorite')) return favorite(config.favorite)
    if (config && Object.hasOwn(config, 'cache')) {
      if (config.cache === 'status') return cacheStatus()
      if (config.cache === 'clear') return clearCache()
      throw Error('无效的缓存操作')
    }
    if (config && Object.hasOwn(config, 'seek')) {
      if (typeof config.seek?.expectedKey !== 'string') return { ok: false, error: 'bad-identity' }
      return control({ action: 'seek', positionMs: config.seek.positionMs }, config.seek.expectedKey)
    }
    if (config?.coverPreview === true) {
      if (!enabled || !showCover || !paletteReader) return {albumMid:null,image:null}
      const albumMid=latest?.track?.albumMid
      return paletteReader.then(reader=>({albumMid,image:null,...reader.preview(albumMid)}))
    }
    if (typeof config?.showCover === 'boolean') showCover = config.showCover
    if (typeof config?.enabled === 'boolean') enabled = config.enabled
    if (typeof config?.anyApp === 'boolean') options.anyApp = config.anyApp
    if (['theme', 'album'].includes(config?.colorMode)) colorMode = config.colorMode
    latest = null
    snapshotRevision++
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(settingsFile + '.tmp', JSON.stringify({ enabled, anyApp: options.anyApp, colorMode, showCover }))
    renameSync(settingsFile + '.tmp', settingsFile)
    return { enabled, anyApp: options.anyApp, colorMode, showCover }
  })
  ipcMain.handle('zcode-music:control', async (event, payload) => {
    if (!trusted(event)) throw new Error('Untrusted music plugin sender')
    return control(payload)
  })
}).catch(error => console.error('[zcode-music]', error))
app.on?.('before-quit', () => { accountSession?.then(session => session.dispose()) })

}
