// Explicit integration test. Briefly pauses, resumes and seeks QQ Music,
// then restores its playback state and the corresponding original timeline.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { pickSession, normalizeMacSample } from '../plugin/lib/nowplaying.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = resolve(process.argv[2] || resolve(root, 'dist'))
let previousSample=null
const run = (action,position=0) => {
 const result=JSON.parse(execFileSync('/usr/bin/perl', [resolve(dir, 'reader.pl'), resolve(dir, 'now-playing.dylib')], {
  encoding: 'utf8', timeout: 5500,
  env: { ...process.env, ZCODE_MUSIC_ACTION: action, ZCODE_MUSIC_PLAYER: 'com.tencent.QQMusicMac',ZCODE_MUSIC_POSITION:String(Math.round(position)),ZCODE_MUSIC_SEEK_MODE:'auto',ZCODE_MUSIC_SEEK_VERIFY:'1' },
 }))
 if(action==='seek'&&result.ok)previousSample=null
 return result
}
const sample = () => {
  // Apply the same paused/resumed timeline handling as the main-process IPC.
  previousSample=normalizeMacSample(run('snapshot'),previousSample)
  const session = pickSession(previousSample.sessions)
  assert.ok(session, 'QQ Music must be the current system media player.')
  return session
}
const initial = sample()
const started=Date.now()
const sameTrack=session=>session.app===initial.app&&session.title===initial.title&&session.artist===initial.artist&&session.duration===initial.duration
const ensureTrack=()=>{const current=sample();assert.ok(sameTrack(current),'Track changed from '+initial.title+' to '+current.title+'; refusing to control the new song.');return current}
const targetFor=session=>session.position+15000<session.duration-5000?session.position+15000:Math.max(0,session.position-15000)
function seekTo(position){
 const result=run('seek',position)
 if(result.ok){
  // A successful user seek resumes playback, including when initially paused.
  const current=ensureTrack()
  if(current.status!=='playing')assert.equal(run('play').ok,true,'Could not resume playback after seeking.')
 }
 return result
}
try {
  console.log(JSON.stringify({initial:initial.title,position:initial.position,status:initial.status,duration:initial.duration}))
  assert.ok(initial.duration>30000,'A track longer than 30 seconds is required.')
  assert.equal(run('pause').ok, true, 'Pause command was not confirmed by the player.')
  const paused = ensureTrack()
  assert.equal(paused.status, 'paused')
  await setTimeout(650)
  const stillPaused = sample()
  assert.equal(stillPaused.status, 'paused')
  assert.ok(Math.abs(stillPaused.position - paused.position) < 150, 'Paused position kept advancing.')
  const pausedTarget=targetFor(stillPaused),pausedSeek=seekTo(pausedTarget)
  assert.equal(pausedSeek.ok,true,JSON.stringify(pausedSeek));assert.equal(pausedSeek.verified,true)
  const afterPausedSeek=ensureTrack()
  assert.equal(afterPausedSeek.status,'playing');assert.ok(Math.abs(afterPausedSeek.position-pausedTarget)<2500,'Independent snapshot did not reach the seek target after resuming.')
  assert.equal(run('play').ok, true, 'Play command was not confirmed by the player.')
  const playing = sample()
  assert.equal(playing.status, 'playing')
  await setTimeout(650)
  const resumed = sample()
  assert.equal(resumed.status, 'playing')
  assert.ok(resumed.position > playing.position + 300, 'Resumed position did not advance.')
  const playingTarget=targetFor(ensureTrack()),playingSeek=seekTo(playingTarget)
  assert.equal(playingSeek.ok,true,JSON.stringify(playingSeek));assert.equal(playingSeek.verified,true)
  const afterPlayingSeek=ensureTrack()
  assert.equal(afterPlayingSeek.status,'playing');assert.ok(Math.abs(afterPlayingSeek.position-playingTarget)<2500,'Independent playing snapshot did not reach the seek target.')
  console.log(JSON.stringify({ title: initial.title, pause: 'verified', pausedDeltaMs: stillPaused.position - paused.position, resume: 'verified', resumedDeltaMs: resumed.position - playing.position,pausedSeek:{target:pausedTarget,actual:afterPausedSeek.position},playingSeek:{target:playingTarget,actual:afterPlayingSeek.position} }, null, 2))
} finally {
  ensureTrack()
  const originalPosition=Math.min(initial.duration-1000,initial.position+(initial.status==='playing'?Date.now()-started:0))
  const seekBack=run('seek',originalPosition)
  assert.equal(seekBack.ok,true,'Could not restore the original playhead: '+JSON.stringify(seekBack))
  const confirmed=ensureTrack()
  assert.ok(Math.abs(confirmed.position-originalPosition)<2500,'Original playhead was not confirmed independently.')
  let restored=ensureTrack(),restore
  for(let attempt=0;attempt<3&&restored.status!==initial.status;attempt++){
    restore=run(initial.status === 'playing' ? 'play' : 'pause')
    restored=ensureTrack()
  }
  assert.equal(restored.status,initial.status,'Could not restore the initial playback state: '+JSON.stringify(restore))
  assert.equal(restored.status,initial.status)
  console.log(JSON.stringify({restored:true,confirmedPosition:confirmed.position,status:restored.status}))
}
