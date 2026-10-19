import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { selectLocalSong, createLocalSongReader } from '../plugin/lib/local-song.js'
import { createPlaybackReporter } from '../plugin/lib/playback.js'

const track = { app: 'com.tencent.QQMusicMac', title: '一棵会开花的树', artist: '谢春花', album: '谢春花作品选集 (2015)', durationMs: 176000 }
const row = { songid: '105392885', storageType: 13, songmid: '000CUTL63LNV46', albumMid: '001Qp10A3tDOIX',
  name: track.title, singer: track.artist, album: track.album, durationMs: track.durationMs }
const protocol = songs => ({ schema: 'qqmusic-songs-v1', songs })

test('local identity requires all four metadata fields and an exact QQ Music app', () => {
  const song = selectLocalSong(track, [row])
  assert.equal(song.songid, 105392885); assert.equal(song.songmid, row.songmid)
  assert.equal(song.albumMid, row.albumMid); assert.equal(song.matchSource, 'local'); assert.equal(song.verified, true)
  assert.equal(song.songtype, 0, 'desktop storage type 13 must not be sent as web playlist songType')
  for (const change of [{ app: 'other.qqmusic' }, { app: '' }, { title: '' }, { artist: '' }, { artist: ';' }, { album: '' },
    { durationMs: 0 }, { durationMs: NaN }, { durationMs: 176.5 }, { durationMs: 86400001 }, { title: 'a'.repeat(1025) }, { title: 'x\0y' }]) {
    assert.equal(selectLocalSong({ ...track, ...change }, [row]), null, JSON.stringify(change))
  }
})

test('local version, album, complete performer set and duration are hard gates', () => {
  for (const change of [{ name: track.title + ' (Live)' }, { name: '一颗会开花的树' }, { singer: track.artist + '\n另一位歌手' },
    { singer: '谢春花 (翻唱)' }, { album: '另一张专辑' }, { durationMs: 177001 }, { durationMs: 0 }, { durationMs: '176000' },
    { album: '' }, { songmid: '' }, { albumMid: '../../id' }, { songid: '9007199254740993' }, { songid: true }, { storageType: 0 }]) {
    assert.equal(selectLocalSong(track, [{ ...row, ...change }]), null, JSON.stringify(change))
  }
  assert.ok(selectLocalSong(track, [{ ...row, durationMs: 177000 }]))
  const duet = { ...track, artist: 'Aki阿杰 / 银临' }
  assert.ok(selectLocalSong(duet, [{ ...row, singer: '银临\nAki阿杰' }]))
  assert.ok(selectLocalSong({ ...track, artist: 'K/DA' }, [{ ...row, singer: 'K/DA' }]))
  assert.equal(selectLocalSong({ ...track, artist: 'K/DA' }, [{ ...row, singer: 'K / DA' }]), null)
  assert.equal(selectLocalSong({ ...track, title: '歌曲 (Live)' }, [{ ...row, name: '歌曲 Live' }]), null)
})

test('different IDs, conflicting copies and matching incomplete rows are ambiguous', () => {
  assert.equal(selectLocalSong(track, [row, { ...row, songid: '12', songmid: 'otherMid' }]), null)
  assert.ok(selectLocalSong(track, [row, { ...row }]))
  for (const change of [{ songmid: 'otherMid' }, { albumMid: 'otherAlbum' }, { durationMs: 0 }, { storageType: 99 }]) {
    assert.equal(selectLocalSong(track, [row, { ...row, ...change }]), null)
  }
  assert.equal(selectLocalSong(track, Array(65).fill(row)), null)
  assert.equal(selectLocalSong(track, [null, row]), null)
  assert.ok(selectLocalSong(track, [{ ...row, name: '无关歌曲' }, row]))
})

function readerFixture() {
  let output = protocol([row]), signature = 1, time = 1000, failure = null, absent = false, gated = false
  const calls = [], callbacks = []
  const stat = async path => {
    if (absent) throw Object.assign(Error(), { code: 'ENOENT' })
    return { ino: path.endsWith('-wal') ? signature : 1, size: 100, mtimeMs: 100, ctimeMs: 100, dev: 1 }
  }
  const run = (file, args, options, callback) => {
    const call = { file, args, options, input: null }; calls.push(call)
    const stdin = new EventEmitter()
    stdin.end = input => { call.input = JSON.parse(input); if (gated) callbacks.push(callback); else queueMicrotask(() => callback(failure, typeof output === 'string' ? output : JSON.stringify(output))) }
    return { stdin }
  }
  const read = createLocalSongReader({ reader: '/runtime/native/reader.pl', helper: '/runtime/native/now-playing.dylib', run, stat, now: () => time })
  return { read, calls, change: () => signature++, tick: () => time += 10000, missing: value => absent = value,
    output: value => output = value, fail: value => failure = value, gate: () => gated = true,
    finish: () => callbacks.splice(0).forEach(cb => cb(null, JSON.stringify(output))) }
}

test('native queries use fixed executable/arguments, bounded I/O and JSON stdin', async () => {
  const f = readerFixture(), input = { ...track, title: "name' OR 1=1; --" }
  await f.read(input)
  const call = f.calls[0]
  assert.equal(call.file, '/usr/bin/perl'); assert.deepEqual(call.args, ['/runtime/native/reader.pl', '/runtime/native/now-playing.dylib'])
  assert.deepEqual(call.input, { title: input.title }); assert.equal(call.options.env.ZCODE_MUSIC_ACTION, 'local-song')
  assert.equal(call.options.timeout, 1500); assert.equal(call.options.maxBuffer, 1024 * 1024)
  for (const change of [{ album: '' }, { app: 'com.google.Chrome' }, { durationMs: 0 }]) await f.read({ ...track, ...change })
  assert.equal(f.calls.length, 1)
})

test('local caches invalidate on WAL replacement, expiry and a newly available database', async () => {
  const f = readerFixture()
  assert.ok(await f.read(track)); assert.ok(await f.read(track)); assert.equal(f.calls.length, 1)
  // Selection is repeated even for cached rows; metadata is never cached by title alone.
  assert.equal(await f.read({ ...track, album: 'different' }), null); assert.equal(f.calls.length, 1)
  f.output(protocol([])); f.change(); assert.equal(await f.read(track), null); assert.equal(f.calls.length, 2)
  f.output(protocol([row])); f.change(); assert.ok(await f.read(track)); assert.equal(f.calls.length, 3)
  f.tick(); assert.ok(await f.read(track)); assert.equal(f.calls.length, 4)
  f.missing(true); assert.equal(await f.read(track), null); assert.equal(f.calls.length, 4)
  f.missing(false); assert.ok(await f.read(track)); assert.equal(f.calls.length, 5)
})

test('native errors, timeouts and invalid responses are retried instead of cached', async () => {
  const f = readerFixture()
  for (const bad of ['invalid JSON', { error: 'busy' }, { schema: 'other', songs: [row] }, protocol(Array(65).fill(row))]) {
    f.output(bad); assert.equal(await f.read(track), null)
  }
  f.output(protocol([row])); f.fail(Error('timeout')); assert.equal(await f.read(track), null)
  f.fail(null); assert.ok(await f.read(track)); assert.equal(f.calls.length, 6)
})

test('concurrent local queries share a read; a write during that read discards the result', async () => {
  const f = readerFixture(); f.gate()
  const a = f.read(track), b = f.read(track)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 1); f.change(); f.finish()
  assert.equal(await a, null); assert.equal(await b, null)
  const c = f.read(track); await new Promise(resolve => setImmediate(resolve)); f.finish()
  assert.ok(await c); assert.equal(f.calls.length, 2)
})

test('local identity precedes online miss caches and shares IDs with lyrics, cover and heart', async () => {
  let local = null, onlineCalls = 0, lyricID = null
  const previous = globalThis.fetch
  globalThis.fetch = async url => { lyricID = new URL(url).searchParams.get('musicid'); return { ok: true, text: async () => '<content><![CDATA[[0,1000]测试(0,1000)]]></content>' } }
  try {
    const reporter = createPlaybackReporter({ options: { apps: ['qqmusic'] }, refrainReader: { get: () => null },
      resolveLocalIdentity: async () => local, resolveIdentity: async () => { onlineCalls++; return null } })
    const sample = () => ({ at: Date.now(), sessions: [{ ...track, duration: track.durationMs, status: 'playing', position: 0 }] })
    assert.equal((await reporter.report(sample())).state, 'no-match'); assert.equal(onlineCalls, 1)
    local = selectLocalSong(track, [row])
    const payload = await reporter.report(sample())
    assert.equal(payload.track.matchSource, 'local'); assert.equal(onlineCalls, 1)
    assert.equal(payload.track.albumMid, row.albumMid); assert.equal(payload.track.favoriteEligible, true)
    assert.equal(payload.lyric.mid, row.songmid); assert.equal(lyricID, row.songid)
    local = { ...local, songid: 123, songmid: 'newMid' }
    assert.equal((await reporter.report(sample())).track.songmid, 'newMid', 'no 30-minute local identity cache')
    local = null
    assert.equal((await reporter.report(sample())).state, 'no-match', 'removed local records must not survive in the online cache')
  } finally { globalThis.fetch = previous }
})

test('a newly available local identity takes priority over a cached online hit', async () => {
  let local = null, calls = 0
  const bundled = { kind: 'lrc', offset: 0, lines: [{ start: 0, duration: 1000, text: 'cached', words: [] }] }
  const online = { ...selectLocalSong(track, [row]), matchSource: 'metadata', lyric: bundled }
  const reporter = createPlaybackReporter({ options: { apps: ['qqmusic'] }, refrainReader: { get: () => null },
    resolveLocalIdentity: async () => local, resolveIdentity: async () => { calls++; return online } })
  const sample = () => ({ at: Date.now(), sessions: [{ ...track, duration: track.durationMs, status: 'playing', position: 0 }] })
  assert.equal((await reporter.report(sample())).track.matchSource, 'metadata')
  local = selectLocalSong(track, [row])
  assert.equal((await reporter.report(sample())).track.matchSource, 'local'); assert.equal(calls, 1)
})

test('local failure falls back online and online cache keys preserve artist aliases', async () => {
  let calls = 0
  const reporter = createPlaybackReporter({ options: { apps: ['qqmusic'] }, refrainReader: { get: () => null },
    resolveLocalIdentity: async () => { throw Error('no access') }, resolveIdentity: async () => { calls++; return null } })
  for (const artist of ['歌手 (甲)', '歌手 (乙)']) {
    await reporter.report({ at: Date.now(), sessions: [{ ...track, artist, duration: 176000, status: 'paused' }] })
  }
  assert.equal(calls, 2)
})
