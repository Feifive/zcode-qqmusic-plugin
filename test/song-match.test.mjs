import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createSongResolver} from '../plugin/lib/song-match.js'
import {createQQGateway} from '../plugin/lib/qq-gateway.js'
import {searchSong,songFields,parseLyricText,matchesSongMetadata} from '../plugin/lib/qqmusic.js'
import {createPlaybackReporter} from '../plugin/lib/playback.js'
const {tree}=JSON.parse(readFileSync(new URL('./fixtures/artwork.json',import.meta.url)))
const track={title:tree.title,artist:tree.artist,album:tree.album,durationMs:tree.durationMs}
const raw={id:tree.songid,mid:tree.songmid,name:tree.title,type:0,singer:[{name:tree.artist}],album:{mid:tree.albumMid,name:tree.album},interval:176}
const confirmed={...songFields(raw),verified:true,matchSource:'metadata'}
const lyric={offset:0,kind:'qrc',lines:[{start:0,duration:1000,text:'测试',words:[{start:0,duration:1000,text:'测试'}]}]}
const rpc=(data,code=0)=>({code:0,req_0:{code,data}})
function fixture({match=rpc({songID:tree.songid,crypt:0,lyric:'[00:00.00]测试'}),detail={code:0,data:[raw]},candidate=null}={}){
 const calls=[],searches=[]
 const gateway={request:async(url,options)=>{
  calls.push({url,options})
  const result=url.includes('musicu.fcg')?match:detail
  if(result instanceof Error)throw result
  return{status:200,text:JSON.stringify(result)}
 }}
 return{calls,searches,resolve:createSongResolver({gateway,search:async(...args)=>{searches.push(args);return candidate}})}
}

test('metadata match posts base64 title/artist/album and seconds, then resolves exact-ID details',async()=>{
 const f=fixture(),song=await f.resolve(track)
 assert.equal(song.songid,tree.songid);assert.equal(song.songmid,tree.songmid);assert.equal(song.albumMid,tree.albumMid)
 assert.equal(song.verified,true);assert.equal(song.matchSource,'metadata');assert.equal(song.lyric.kind,'lrc')
 assert.equal(f.searches.length,0);assert.equal(f.calls.length,2)
 const {options}=f.calls[0],body=JSON.parse(options.body),param=body.req_0.param
 assert.equal(f.calls[0].url,'https://u.y.qq.com/cgi-bin/musicu.fcg')
 assert.equal(body.req_0.module,'music.musichallSong.PlayLyricInfo');assert.equal(body.req_0.method,'GetPlayLyricInfo')
 for(const [key,value]of [['songName',track.title],['singerName',track.artist],['albumName',track.album]])assert.equal(Buffer.from(param[key],'base64').toString(),value)
 assert.equal(param.interval,176);assert.equal(param.crypt,1);assert.equal(param.qrc,1);assert.equal(param.ct,6)
 assert.equal(options.timeoutMs,4000);assert.equal(options.maxBytes,1024*1024);assert.equal(options.headers.Cookie,undefined)
 assert.equal(new URL(f.calls[1].url).searchParams.get('songid'),String(tree.songid))
})

test('zero/unsafe IDs and candidate vectors are never treated as a confirmed identity',async()=>{
 for(const data of [{songID:0,vecSongID:[tree.songid]},{songID:true},{songID:[tree.songid]},{songID:'9007199254740993'},{songID:-1},{songMID:tree.songmid}]){
  const f=fixture({match:rpc(data)});assert.equal(await f.resolve(track),null);assert.equal(f.calls.length,1);assert.equal(f.searches.length,1)
 }
 for(const match of [rpc({songID:tree.songid},24001),{...rpc({songID:tree.songid}),code:1}]){
  const f=fixture({match});assert.equal(await f.resolve(track),null);assert.equal(f.calls.length,1)
 }
})

test('wrong edition, artist, album, duration or ID in authoritative details rejects the server match',async()=>{
 const invalid=[{...raw,id:1},{...raw,name:track.title+' (Live)'},{...raw,singer:[{name:'另一个歌手'}]},
  {...raw,album:{name:'另一张专辑',mid:'other'}},{...raw,album:{}},{...raw,interval:195},{...raw,interval:0},{...raw,mid:''}]
 for(const song of invalid){
  const f=fixture({detail:{code:0,data:[song]}})
  assert.equal(await f.resolve(track),null,JSON.stringify(song));assert.equal(f.searches.length,1)
 }
})

test('a failed or rejected primary match falls back to strict search and ID details',async()=>{
 for(const match of [rpc({songID:0}),rpc({songID:0},24001),new Error('timeout'),{code:0,req_0:{code:0,data:{songID:42}}}]){
  const f=fixture({match,candidate:songFields(raw)})
  const song=await f.resolve(track);assert.equal(song.songid,tree.songid);assert.equal(song.matchSource,'search');assert.equal(song.lyric,null)
  assert.equal(f.searches.length,1)
 }
 const f=fixture({match:rpc({songID:0}),candidate:{...songFields(raw),name:track.title+' (Live)'}})
 assert.equal(await f.resolve(track),null);assert.equal(f.calls.length,1)
 const missingDetail=fixture({match:rpc({songID:0}),candidate:songFields(raw),detail:{code:0,data:[]}})
 assert.equal(await missingDetail.resolve(track),null)
})

test('bad bundled lyrics do not discard a verified identity and rejected details are not fetched twice',async()=>{
 const f=fixture({match:rpc({songID:tree.songid,crypt:1,lyric:'not hex'})})
 const song=await f.resolve(track);assert.equal(song.verified,true);assert.equal(song.lyric,null)
 const rejected=fixture({candidate:songFields(raw),detail:{code:0,data:[{...raw,interval:195}]}})
 assert.equal(await rejected.resolve(track),null);assert.equal(rejected.calls.length,2)
})

test('Live fallback validates the full detail title even when the short name omits the edition',async()=>{
 const live={...raw,id:235067530,mid:'0030kxg60IncwM',title:track.title+' (Live)',interval:184,album:{name:'谢春花·专场',mid:'0021syht4TgK3R'}}
 const input={...track,title:live.title,durationMs:184000,album:live.album.name}
 const f=fixture({match:rpc({songID:0},24001),candidate:songFields(live),detail:{code:0,data:[live]}})
 const song=await f.resolve(input)
 assert.equal(song.matchSource,'search');assert.equal(song.name,live.title);assert.equal(song.songid,live.id)
 assert.equal(matchesSongMetadata(track,songFields(live)),false)
})

test('missing artist and overlong metadata stop before requests; no artist-stripping retry occurs',async()=>{
 for(const input of [null,{...track,title:123},{...track,artist:''},{...track,title:''},{...track,album:'a'.repeat(1025)}]){
  const f=fixture();assert.equal(await f.resolve(input),null);assert.equal(f.calls.length,0);assert.equal(f.searches.length,0)
 }
})

test('temporary detail transport failures are not cached as a five-minute miss',async()=>{
 const f=fixture({match:rpc({songID:0}),candidate:songFields(raw),detail:new Error('timeout')})
 let time=1000
 const reporter=createPlaybackReporter({options:{apps:['qqmusic']},now:()=>time,refrainReader:{get:()=>null},resolveIdentity:f.resolve})
 await reporter.report(sample(time));assert.equal(f.searches.length,1)
 await reporter.report(sample(time));assert.equal(f.searches.length,2)
})

test('search rejects ambiguity, missing known fields, invalid IDs, and similar titles without ranking them',async()=>{
 const before=globalThis.fetch
 try{
  const resolveList=async(list,wanted=track)=>{
   globalThis.fetch=async()=>Response.json({data:{song:{list}}})
   return searchSong(wanted)
  }
  assert.equal((await resolveList([raw])).songmid,tree.songmid)
  assert.equal(await resolveList([raw,{...raw,id:12,mid:'anotherMID'}]),null)
  assert.equal((await resolveList([raw,{...raw}])).songid,tree.songid)
  for(const wrong of [{...raw,name:'一颗会开花的树'},{...raw,name:track.title+' (Live)'},{...raw,singer:[{name:'谢春花翻唱'}]},
   {...raw,album:{}},{...raw,interval:0},{...raw,id:true},{...raw,id:'9007199254740993'},{...raw,mid:'../../wrong'}])assert.equal(await resolveList([wrong]),null)
  assert.equal(await resolveList([raw],{...track,artist:''}),null)
 }finally{globalThis.fetch=before}
})

test('QRC XML extraction omits wrappers and LRC parsing retains offset and line durations',()=>{
 const parsed=parseLyricText('<?xml version="1.0"?><QrcInfos><Lyric_1 LyricContent="[100,200]测(100,100)试(200,100)"/></QrcInfos>')
 assert.equal(parsed.kind,'qrc');assert.equal(parsed.lines[0].text,'测试');assert.equal(parsed.lines[0].words.length,2)
 const lrc=parseLyricText('[offset:120]\n[00:01.00]A\n[00:03.00]B')
 assert.equal(lrc.kind,'lrc');assert.equal(lrc.offset,120);assert.equal(lrc.lines[0].duration,2000)
 assert.equal(parseLyricText('unusable'),null)
 assert.equal(matchesSongMetadata(track,{...confirmed,album:''}),false)
})

test('real gateway limits oversized match responses and never sends authentication headers',async()=>{
 const calls=[]
 const gateway=createQQGateway({fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('x'.repeat(1024*1024+1))}})
 assert.equal(await createSongResolver({gateway,search:async()=>null})(track),null)
 assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Cookie,undefined)
})

const sample=(time,overrides={})=>({at:time,sessions:[{app:'com.tencent.QQMusicMac',title:track.title,artist:track.artist,album:track.album,duration:track.durationMs,status:'paused',position:0,...overrides}]})
test('reporter shares one verified identity and bundled lyrics across cover/favorites/lyrics without a second download',async()=>{
 const before=globalThis.fetch;globalThis.fetch=()=>{throw Error('Unexpected lyric download')}
 let time=1000,resolutions=0
 const mids=[]
 try{
  const reporter=createPlaybackReporter({options:{apps:['qqmusic']},now:()=>time,refrainReader:{get:mid=>{mids.push(mid);return null}},
   resolveIdentity:async()=>{resolutions++;return{...confirmed,lyric}}})
  for(let i=0;i<2;i++){
   const result=await reporter.report(sample(time))
   assert.equal(result.track.songmid,tree.songmid);assert.equal(result.track.albumMid,tree.albumMid);assert.equal(result.track.favoriteEligible,true)
   assert.equal(result.track.matchSource,'metadata');assert.equal(result.lyric.mid,tree.songmid);assert.equal(result.lyric.kind,'qrc')
  }
  assert.equal(resolutions,1);assert.ok(mids.every(mid=>mid===tree.songmid))
  time+=30*60000+1;await reporter.report(sample(time));assert.equal(resolutions,2)
 }finally{globalThis.fetch=before}
})

test('reporter coalesces pending identity lookups and keeps missed metadata keys separate',async()=>{
 let time=1000,resolutions=0,finish
 const pending=new Promise(resolve=>{finish=resolve})
 const reporter=createPlaybackReporter({options:{apps:['qqmusic']},now:()=>time,refrainReader:{get:()=>null},resolveIdentity:()=>{resolutions++;return pending}})
 const a=reporter.report(sample(time)),b=reporter.report(sample(time))
 assert.equal(resolutions,1);finish({...confirmed,lyric});assert.equal((await a).track.songmid,(await b).track.songmid)
 let misses=0
 const unavailable=createPlaybackReporter({options:{apps:['qqmusic']},now:()=>time,refrainReader:{get:()=>null},resolveIdentity:async()=>{misses++;return null}})
 assert.equal((await unavailable.report(sample(time))).state,'no-match');await unavailable.report(sample(time));assert.equal(misses,1)
 await unavailable.report(sample(time,{album:'另一专辑'}));assert.equal(misses,2)
 time+=5*60000+1;await unavailable.report(sample(time));assert.equal(misses,3)
})
