import {test} from 'node:test'
import assert from 'node:assert/strict'
import {searchSong,normalizeTitle} from '../plugin/lib/qqmusic.js'
import {createPlaybackReporter} from '../plugin/lib/playback.js'
const original={songname:'POP/STARS',songmid:'000FTx4w1obE49',songid:219006430,albummid:'003MS9qR3iluHl',albumname:'POP/STARS',interval:191,singer:[{name:'K/DA;Madison Beer;曺薇娟 (MIYEON);Jaira Burns;田小娟 (SOYEON)'}]}
const instrumental={...original,songname:'POP/STARS (纯音乐)',songmid:'instrumental',songid:219006429}
const remix={songname:'POP/STARS (Moving-Point Remix)',songmid:'002TT59Y3T08Pl',songid:323544271,interval:50,singer:[{name:'KDA'}]}
async function withSearch(list,fn){const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({data:{song:{list}}})});try{await fn()}finally{globalThis.fetch=previous}}

test('POP/STARS resolves the original with semicolon-packed performers instead of the 50-second Remix',async()=>{
 await withSearch([original,instrumental,remix],async()=>{
  const match=await searchSong({title:'POP/STARS',artist:'K/DA',durationMs:191000,album:'POP/STARS'})
  assert.equal(match.songid,219006430);assert.equal(match.albumMid,'003MS9qR3iluHl')
  assert.equal(match.singer.split(' / ')[0],'K/DA')
 })
})
test('exact requested editions outrank reordered live, instrumental and remix search results',async()=>{
 await withSearch([remix,instrumental,original],async()=>{
  assert.equal((await searchSong({title:'POP/STARS',artist:'K/DA'})).songid,219006430)
  assert.equal((await searchSong({title:'POP/STARS (Moving-Point Remix)',artist:'K/DA',durationMs:50000})).songid,323544271)
  assert.equal((await searchSong({title:'POP/STARS (纯音乐)',artist:'K/DA',durationMs:191000})).songid,219006429)
 })
 assert.notEqual(normalizeTitle('歌曲 (Live)'),normalizeTitle('歌曲'))
})
test('duration distinguishes identically titled recordings when artist and title both match',async()=>{
 await withSearch([{...original,songmid:'short',songid:1,interval:50},original],async()=>{
  assert.equal((await searchSong({title:'POP/STARS',artist:'K/DA',durationMs:191000})).songid,219006430)
 })
})
test('reporter song cache keeps the original and Remix identities separate',async()=>{
 const previous=globalThis.fetch;let searches=0
 globalThis.fetch=async url=>{
  const u=new URL(url)
  if(u.pathname.includes('search_')){searches++;return{ok:true,text:async()=>JSON.stringify({data:{song:{list:[remix,instrumental,original]}}})}}
  if(u.pathname.includes('lyric_download'))return{ok:true,text:async()=>'<content><![CDATA[[0,1000]test(0,1000)]]></content>'}
  return{ok:true,text:async()=>JSON.stringify({lyric:'[00:00.00]test'})}
 }
 try{
  const reporter=createPlaybackReporter({options:{apps:['qqmusic'],anyApp:false,pollMs:2000}})
  const sample=(title,duration)=>({at:Date.now(),sessions:[{app:'com.tencent.QQMusicMac',title,artist:'K/DA',status:'paused',position:0,duration}]})
  const a=await reporter.report(sample('POP/STARS',191000))
  const b=await reporter.report(sample('POP/STARS (Moving-Point Remix)',50000))
  assert.equal(a.track.songmid,original.songmid);assert.equal(b.track.songmid,remix.songmid)
  assert.ok(a.lyric.lines.length);assert.ok(b.lyric.lines.length);assert.equal(searches,2)
 }finally{globalThis.fetch=previous}
})
