// Explicit integration test. Briefly pauses/resumes QQ Music, then restores
// the initial state. Success requires independent state and playhead checks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { pickSession } from '../plugin/lib/nowplaying.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = resolve(process.argv[2] || resolve(root, 'dist'))
const run = action => JSON.parse(execFileSync('/usr/bin/perl', [resolve(dir, 'reader.pl'), resolve(dir, 'now-playing.dylib')], {
  encoding: 'utf8', timeout: 5500,
  env: { ...process.env, ZCODE_MUSIC_ACTION: action, ZCODE_MUSIC_PLAYER: 'com.tencent.QQMusicMac' },
}))
const sample = () => {
  const session = pickSession(run('snapshot').sessions)
  assert.ok(session, 'QQ Music must be the current system media player.')
  return session
}
const initial = sample()
try {
  assert.equal(run('pause').ok, true, 'Pause command was not confirmed by the player.')
  const paused = sample()
  assert.equal(paused.status, 'paused')
  await setTimeout(650)
  const stillPaused = sample()
  assert.equal(stillPaused.status, 'paused')
  assert.ok(Math.abs(stillPaused.position - paused.position) < 150, 'Paused position kept advancing.')
  assert.equal(run('play').ok, true, 'Play command was not confirmed by the player.')
  const playing = sample()
  assert.equal(playing.status, 'playing')
  await setTimeout(650)
  const resumed = sample()
  assert.equal(resumed.status, 'playing')
  assert.ok(resumed.position > playing.position + 300, 'Resumed position did not advance.')
  console.log(JSON.stringify({ title: initial.title, pause: 'verified', pausedDeltaMs: stillPaused.position - paused.position, resume: 'verified', resumedDeltaMs: resumed.position - playing.position }, null, 2))
} finally {
  const restore = run(initial.status === 'playing' ? 'play' : 'pause')
  assert.equal(restore.ok, true, 'Could not restore the initial playback state.')
}
