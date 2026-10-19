// Explicit integration check: requires QQ Music to be playing and network access.
// An empty media sample must fail, rather than passing as an idle UI smoke test.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { createPlaybackReporter } from '../plugin/lib/playback.js'
import { pickSession } from '../plugin/lib/nowplaying.js'
import { createLocalSongReader } from '../plugin/lib/local-song.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const reader = resolve(root, 'native/reader.pl'), helper = resolve(root, 'dist/now-playing-universal.dylib')
const capture = () => JSON.parse(execFileSync('/usr/bin/perl', [reader, helper], { env: { ...process.env, ZCODE_MUSIC_ACTION: 'snapshot' }, encoding: 'utf8', timeout: 5000 }))
const first = capture()
const session = pickSession(first.sessions)
assert.ok(session, 'No QQ Music session detected. Start playback before running the live test.')
assert.equal(session.status, 'playing', 'QQ Music must be playing for the progression check.')
await setTimeout(1200)
const second = capture()
const next = pickSession(second.sessions)
assert.ok(next, 'QQ Music session disappeared.')
if (next.title === session.title && next.duration === session.duration && next.position >= session.position) {
  assert.ok(next.position > session.position + 500, 'Playback position did not advance.')
}
const reporter = createPlaybackReporter({ options: { apps: ['qqmusic'], anyApp: false, pollMs: 2000 }, log: console.error,
  resolveLocalIdentity: createLocalSongReader({ reader, helper }) })
const result = await reporter.report(second)
assert.equal(result.state, 'playing', `Expected playing with resolved lyrics, got ${result.state}`)
assert.ok(result.lyric?.lines.length, 'No lyrics resolved for the active song.')
console.log(JSON.stringify({ state: result.state, title: result.track.title, artist: result.track.artist, matchSource: result.track.matchSource,
  songid: result.track.songid, songmid: result.track.songmid, albumMid: result.track.albumMid, favoriteEligible: result.track.favoriteEligible,
  positionMs: result.track.positionMs, kind: result.lyric.kind, lines: result.lyric.lines.length, currentLine: result.lyric.lines[result.lyric.index]?.text }, null, 2))
