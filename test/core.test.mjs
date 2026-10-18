import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { patchAsar, parseAsar, readEntry, hash } from '../scripts/asar.mjs'
import { pickSession, splitTitle, normalizeMacSample } from '../plugin/lib/nowplaying.js'
import { parseLrc, lyricIndexAt, searchSong } from '../plugin/lib/qqmusic.js'
import { parseQrc } from '../plugin/lib/qrc.js'

test('ASAR patch preserves original content and creates valid integrity entries', () => {
  const header = Buffer.from(JSON.stringify({ files: { 'original.txt': { offset: '0', size: 5 } } }))
  const pad = (4 - header.length % 4) % 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + header.length + pad, 4)
  prefix.writeUInt32LE(4 + header.length + pad, 8); prefix.writeUInt32LE(header.length, 12)
  const source = Buffer.concat([prefix, header, Buffer.alloc(pad), Buffer.from('hello')])
  const { buffer, headerHash } = patchAsar(source, new Map([['new/中文.js', Buffer.from('你好')]]))
  const result = parseAsar(buffer)
  assert.equal(readEntry(result, 'original.txt').toString(), 'hello')
  assert.equal(readEntry(result, 'new/中文.js').toString(), '你好')
  assert.equal(headerHash, hash(Buffer.from(result.headerString)))
  assert.equal(result.header.files.new.files['中文.js'].integrity.hash, hash(Buffer.from('你好')))
})
test('QQ session filtering never selects a browser unless explicitly enabled', () => {
  const browser = { app: 'com.google.Chrome', status: 'playing' }
  const qq = { app: 'com.tencent.QQMusicMac', status: 'paused' }
  assert.equal(pickSession([browser, qq]), qq)
  assert.equal(pickSession([browser]), null)
  assert.equal(pickSession([browser, qq], { anyApp: true }), browser)
  assert.deepEqual(splitTitle('晴天 - 周杰伦', ''), { title: '晴天', artist: '周杰伦' })
})
test('LRC handles repeated timestamps, offsets and prelude boundary', () => {
  const parsed = parseLrc('[offset:120]\n[00:01.50][00:05.000]你好\n[00:09]世界')
  assert.equal(parsed.offset, 120)
  assert.deepEqual(parsed.lines, [[1500, '你好'], [5000, '你好'], [9000, '世界']])
  assert.equal(lyricIndexAt(parsed.lines, 1499), -1)
  assert.equal(lyricIndexAt(parsed.lines, 5000), 1)
})
test('QQ paused playhead freezes when its unchanged timeline reports zero', () => {
  const track = { app: 'com.tencent.QQMusicMac', title: '歌曲', artist: '歌手', duration: 200000, timelineTimestamp: 500 }
  const playing = { at: 10000, sessions: [{ ...track, status: 'playing', position: 30000 }] }
  const paused = normalizeMacSample({ at: 10200, sessions: [{ ...track, status: 'paused', position: 0 }] }, playing)
  assert.equal(paused.sessions[0].position, 30200)
  const later = normalizeMacSample({ at: 15000, sessions: [{ ...track, status: 'paused', position: 0 }] }, paused)
  assert.equal(later.sessions[0].position, 30200)
})
test('paused playhead retention respects a new track, a reset timeline and valid reported progress', () => {
  const track = { app: 'com.tencent.QQMusicMac', title: '歌曲', artist: '歌手', duration: 200000, timelineTimestamp: 500, status: 'paused', position: 0 }
  const previous = { at: 10000, sessions: [{ ...track, position: 30000 }] }
  for (const changed of [{ title: '下一首', position: 0 }, { timelineTimestamp: 600, position: 0 }, { position: 42000 }]) {
    const next = normalizeMacSample({ at: 11000, sessions: [{ ...track, ...changed }] }, previous)
    assert.equal(next.sessions[0].position, changed.position)
  }
})
test('QQ resuming a stale zero-position timeline excludes time spent paused', () => {
  const track = { app: 'com.tencent.QQMusicMac', title: '歌曲', artist: '歌手', duration: 200000, timelineTimestamp: 500, reportedPosition: 0 }
  const paused = { at: 20000, sessions: [{ ...track, status: 'paused', position: 10000 }] }
  const resumed = normalizeMacSample({ at: 21000, sessions: [{ ...track, status: 'playing', position: 20500 }] }, paused)
  assert.equal(resumed.sessions[0].position, 11000)
  const later = normalizeMacSample({ at: 22000, sessions: [{ ...track, status: 'playing', position: 21500 }] }, resumed)
  assert.equal(later.sessions[0].position, 12000)
})
test('QQ pausing a stale nonzero baseline does not jump back to the previous resume point', () => {
  const track = { app: 'com.tencent.QQMusicMac', title: '歌曲', artist: '歌手', duration: 200000, timelineTimestamp: 500, reportedPosition: 11000 }
  const previous = { at: 20000, sessions: [{ ...track, status: 'playing', position: 25000 }] }
  const paused = normalizeMacSample({ at: 20200, sessions: [{ ...track, status: 'paused', position: 11000 }] }, previous)
  assert.equal(paused.sessions[0].position, 25200)
  const later = normalizeMacSample({ at: 23000, sessions: [{ ...track, status: 'paused', position: 11000 }] }, paused)
  assert.equal(later.sessions[0].position, 25200)
})
test('QRC retains absolute word timing for continuous lyric sweep', () => {
  const lines = parseQrc('[1000,3000]你(1000,1000)好(2000,2000)')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, '你好')
  assert.equal(lines[0].words[1].start, 2000)
})
test('QQ matching rejects unrelated results even when artists match', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: { song: { list: [{ songmid: 'wrong', songname: '完全不同的歌', singer: [{ name: '周杰伦' }] }] } } }) })
  try { assert.equal(await searchSong({ title: '晴天', artist: '周杰伦' }), null) }
  finally { globalThis.fetch = previous }
})
test('IPC rejects webviews and subframes before reading playback or running commands', async () => {
  const handlers = new Map()
  const path = '/official/app.asar/out/renderer/index.html'
  const app = { whenReady: () => Promise.resolve(), getAppPath: () => '/official/app.asar', getPath: () => '/tmp/zcode-music-test-settings' }
  const require = name => {
    if (name === 'electron') return { app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
    if (name === 'node:child_process') return { execFile: () => { throw Error('Unexpected helper execution') } }
    if (name === 'node:fs') return { readFileSync: () => '{"enabled":false}', mkdirSync() {}, writeFileSync() {}, renameSync() {} }
    if (name === 'node:url') return { fileURLToPath: url => new URL(url).pathname, pathToFileURL: value => new URL('file://' + value) }
    if (name === 'node:path') return { join: (...parts) => parts.join('/'), resolve: () => path }
    throw Error(name)
  }
  vm.runInNewContext(readFileSync(new URL('../plugin/main.cjs', import.meta.url), 'utf8')+'\nmodule.exports()', { module:{exports:null}, require, __dirname: '/official/app.asar/out/main/zcode-music', console, Date, URL })
  await Promise.resolve()
  const frame = { url: 'file://' + path }
  const trusted = { senderFrame: frame, sender: { mainFrame: frame } }
  assert.equal((await handlers.get('zcode-music:snapshot')(trusted)).state, 'disabled')
  for (const bad of [
    { senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: frame } },
    { senderFrame: { url: 'file://' + path }, sender: { mainFrame: frame } },
  ]) {
    assert.throws(() => handlers.get('zcode-music:snapshot')(bad), /Untrusted/)
    await assert.rejects(handlers.get('zcode-music:control')(bad, { action: 'next' }), /Untrusted/)
    assert.throws(() => handlers.get('zcode-music:configure')(bad, {}), /Untrusted/)
  }
})
