import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join,resolve} from 'node:path'
import vm from 'node:vm'
import {seekIdentity} from '../plugin/lib/seek.js'
const directory=fileURLToPath(new URL('../plugin',import.meta.url)),renderer='/official/renderer/index.html'
const sample=(overrides={})=>({at:Date.now(),sessions:[{app:'com.tencent.QQMusicMac',title:'seek test',artist:'fixture',duration:100000,position:40000,reportedPosition:40000,timelineTimestamp:1000,status:'paused',...overrides}]})
async function boot(queue,saved={enabled:true,colorMode:'theme',showCover:false}){
 const handlers=new Map(),calls=[]
 const frame={url:pathToFileURL(renderer).href},event={senderFrame:frame,sender:{mainFrame:frame}}
 const require=name=>{
  if(name==='electron')return{app:{whenReady:()=>Promise.resolve()},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}}
  if(name==='node:child_process')return{execFile:(_exe,_args,options,callback)=>{calls.push(options.env);assert.ok(queue.length,'Unexpected helper execution');queueMicrotask(()=>callback(null,JSON.stringify(queue.shift())))}}
  if(name==='node:fs')return{readFileSync:()=>JSON.stringify(saved),mkdirSync(){},writeFileSync(){},renameSync(){}}
  if(name==='node:url')return{pathToFileURL,fileURLToPath}
  if(name==='node:path')return{join,resolve:()=>renderer}
  throw Error(name)
 }
 vm.runInNewContext(readFileSync(join(directory,'main.cjs'),'utf8')+'\nmodule.exports({runtimeDir:"/runtime",rendererPath:"/official/renderer/index.html",settingsDir:"/settings"})', {module:{exports:null},require,__dirname:directory,console,Date,URL,process:{env:{}}},{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})
 await Promise.resolve()
 return{calls,event,configure:(payload,source=event)=>handlers.get('zcode-music:configure')(source,payload),control:(payload,source=event)=>handlers.get('zcode-music:control')(source,payload),snapshot:()=>handlers.get('zcode-music:snapshot')(event)}
}
test('seek IPC rejects malformed positions, disabled plugins and untrusted frames before helpers run',async()=>{
 const app=await boot([])
 for(const positionMs of [undefined,null,'1000',NaN,Infinity,-1,86400001])assert.equal((await app.control({action:'seek',positionMs})).error,'bad-position')
 for(const frame of [{url:'https://example.com'},{url:pathToFileURL(renderer).href}])await assert.rejects(app.control({action:'seek',positionMs:5000},{senderFrame:frame,sender:app.event.sender}),/Untrusted/)
 assert.equal(app.calls.length,0)
 const disabled=await boot([],{enabled:false});assert.equal((await disabled.control({action:'seek',positionMs:5000})).error,'disabled');assert.equal(disabled.calls.length,0)
})
test('seek IPC clamps to duration, selects the matching player and preserves helper failures',async()=>{
 const app=await boot([sample({duration:11111}),{ok:false,error:'seek-not-applied'}])
 assert.equal((await app.control({action:'seek',positionMs:50000})).error,'seek-not-applied')
 assert.deepEqual(app.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek'])
 assert.equal(app.calls[1].ZCODE_MUSIC_PLAYER,'com.tencent.QQMusicMac');assert.equal(app.calls[1].ZCODE_MUSIC_POSITION,'11111')
 const noPlayer=await boot([{at:Date.now(),sessions:[{app:'com.google.Chrome',status:'playing'}]}])
 assert.equal((await noPlayer.control({action:'seek',positionMs:5000})).error,'no-player');assert.equal(noPlayer.calls.length,1)
})
test('a confirmed backward seek to zero resets the paused timeline baseline',async()=>{
 const previousFetch=globalThis.fetch
 globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({data:{song:{list:[]}}})})
 try{
  const app=await boot([sample(),{ok:true,verified:true},sample({position:0,reportedPosition:0,status:'playing'}),sample({position:0,reportedPosition:0,status:'playing'})])
  assert.equal((await app.control({action:'seek',positionMs:0})).ok,true)
  assert.deepEqual(app.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek','snapshot'])
  const current=await app.snapshot()
  assert.equal(current.track.positionMs,0);assert.equal(current.track.playing,true);assert.equal(current.track.seekable,true)
 }finally{globalThis.fetch=previousFetch}
})
test('seek IPC keeps automatic playback and starts players that remain paused after positioning',async()=>{
 const auto=await boot([sample(),{ok:true,verified:true},sample({position:60000,reportedPosition:60000,status:'playing'})])
 assert.equal((await auto.control({action:'seek',positionMs:60000})).ok,true)
 assert.deepEqual(auto.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek','snapshot'])
 const app=await boot([sample(),{ok:true,verified:true},sample({position:60000,reportedPosition:60000}),{ok:true,playing:true},sample({position:60000,reportedPosition:60000,status:'playing'})])
 assert.equal((await app.control({action:'seek',positionMs:60000})).ok,true)
 assert.deepEqual(app.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek','snapshot','play','snapshot'])
})
test('seek IPC does not resume a changed track and reports a rejected play command',async()=>{
 const changed=await boot([sample(),{ok:true,verified:true},sample({title:'another song'})])
 assert.equal((await changed.control({action:'seek',positionMs:5000})).error,'player-changed')
 assert.equal(changed.calls.length,3)
 const rejected=await boot([sample(),{ok:true,verified:true},sample({position:5000}),{ok:false,error:'command-not-applied'}])
 assert.equal((await rejected.control({action:'seek',positionMs:5000})).error,'playback-not-started')
 assert.deepEqual(rejected.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek','snapshot','play'])
})

test('guarded seek validates identity and refuses a changed song before issuing a command',async()=>{
 const expectedKey=seekIdentity({app:'com.tencent.QQMusicMac',songmid:'mid',title:'seek test',artist:'fixture',album:'Album',durationMs:100000})
 const invalid=await boot([])
 for(const key of [null,'invalid','[]',JSON.stringify(['app',null,'title','artist','Album',0])])assert.equal((await invalid.configure({seek:{positionMs:5000,expectedKey:key}})).error,'bad-identity')
 assert.equal(invalid.calls.length,0)
 for(const change of [{title:'another'},{artist:'another'},{album:'Other'},{duration:100001}]){
  const changed=await boot([sample({album:'Album',...change})])
  assert.equal((await changed.configure({seek:{positionMs:5000,expectedKey}})).error,'track-changed')
  assert.deepEqual(changed.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot'])
 }
 const good=await boot([sample({album:'Album'}),{ok:true,verified:true},sample({album:'Album',position:5000,status:'playing'})])
 assert.equal((await good.configure({seek:{positionMs:5000,expectedKey},enabled:false})).ok,true)
 assert.deepEqual(good.calls.map(c=>c.ZCODE_MUSIC_ACTION),['snapshot','seek','snapshot'])
 assert.deepEqual(JSON.parse(good.calls[1].ZCODE_MUSIC_EXPECTED_TRACK),{title:'seek test',artist:'fixture',album:'Album',duration:100000})
})


test('favorite IPC validates sender, payload and current song before accessing the account',async()=>{
 const previous=globalThis.fetch
 globalThis.fetch=async url=>{
  const path=new URL(url).pathname,song={songname:'seek test',songmid:'actualMid',songid:123,interval:100,singer:[{name:'fixture'}]}
  if(path.includes('musicu.fcg'))return Response.json({code:0,req_0:{code:24001,data:{songID:0}}})
  if(path.includes('play_single_song'))return Response.json({code:0,data:[song]})
  if(path.includes('search_'))return Response.json({data:{song:{list:[song]}}})
  return{ok:true,text:async()=>'<content><![CDATA[[0,1000]test(0,1000)]]></content>'}
 }
 try {
  const app=await boot([sample()])
  assert.throws(()=>app.configure({favorite:{action:'set',songmid:'actualMid',liked:true}},{senderFrame:{url:'https://example.com'},sender:app.event.sender}),/Untrusted/)
  for(const favorite of [null,{action:'toggle',songmid:'actualMid'},{action:'set',songmid:'actualMid',liked:'yes'}])await assert.rejects(app.configure({favorite}),/无效的收藏/)
  assert.equal(app.calls.length,0)
  await assert.rejects(app.configure({favorite:{action:'set',songmid:'old-mid',liked:true}}),/当前歌曲已变化/)
  assert.equal((await app.configure({favorite:{action:'status',songmid:'actualMid'},enabled:false})).status,'logged-out')
  assert.equal((await app.snapshot()).enabled,true)
 }finally{globalThis.fetch=previous}
})
