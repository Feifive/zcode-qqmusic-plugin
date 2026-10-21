import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

async function boot(saved){
 const handlers=new Map(),reads=[];let persisted=saved
 const path='/official/app.asar/out/renderer/index.html'
 const app={whenReady:()=>Promise.resolve()}
 const require=name=>{
  if(name==='electron')return{app,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)}}
  if(name==='node:child_process')return{execFile:()=>{throw Error('Unexpected media control')}}
  if(name==='node:fs')return{readFileSync:file=>{reads.push(file);if(persisted===undefined)throw Error('Missing settings');return persisted},mkdirSync(){},writeFileSync:(_file,text)=>{persisted=text},renameSync(){}}
  if(name==='node:url')return{fileURLToPath:u=>u.pathname,pathToFileURL:p=>new URL('file://'+p)}
  if(name==='node:path')return{join:(...parts)=>parts.join('/'),resolve:()=>path}
  throw Error(name)
 }
 vm.runInNewContext(readFileSync(new URL('../plugin/main.cjs',import.meta.url),'utf8')+'\nmodule.exports({runtimeDir:"/runtime",rendererPath:"/official/app.asar/out/renderer/index.html",settingsDir:"/settings"})',{module:{exports:null},require,__dirname:'/runtime/plugin',console,Date,URL})
 await Promise.resolve()
 const frame={url:'file://'+path},event={senderFrame:frame,sender:{mainFrame:frame}}
 return{configure:c=>handlers.get('zcode-music:configure')(event,c),snapshot:()=>handlers.get('zcode-music:snapshot')(event),saved:()=>persisted,reads}
}
test('first launch reads only the configured settings file and saves defaults there',async()=>{
 const first=await boot()
 assert.deepEqual(first.reads,['/settings/settings.json'])
 const state=first.configure({enabled:false})
 assert.equal(state.showCover,true);assert.equal(state.colorMode,'album')
 assert.equal(JSON.parse(first.saved()).enabled,false)
})
test('color choice preserves existing album appearance and persists theme choice across restarts',async()=>{
 const first=await boot('{"enabled":false,"anyApp":true}')
 assert.equal((await first.snapshot()).colorMode,'album')
 assert.equal(first.configure({colorMode:'theme'}).colorMode,'theme')
 assert.deepEqual(JSON.parse(first.saved()),{enabled:false,anyApp:true,colorMode:'theme',showCover:true})
 const restarted=await boot(first.saved())
 assert.equal((await restarted.snapshot()).colorMode,'theme')
 assert.equal(restarted.configure({anyApp:false}).colorMode,'theme')
 assert.equal(restarted.configure({colorMode:'invalid'}).colorMode,'theme')
 assert.equal(restarted.configure({colorMode:'album'}).colorMode,'album')
 assert.equal((await restarted.snapshot()).colorMode,'album')
})

test('cover visibility defaults on, persists off and survives unrelated setting changes',async()=>{
 const first=await boot('{"enabled":false,"colorMode":"theme"}')
 assert.equal((await first.snapshot()).showCover,true)
 assert.equal(first.configure({showCover:false}).showCover,false)
 const restarted=await boot(first.saved())
 assert.equal((await restarted.snapshot()).showCover,false)
 assert.equal(restarted.configure({colorMode:'album'}).showCover,false)
 assert.equal(restarted.configure({showCover:'true'}).showCover,false)
 assert.equal(restarted.configure({showCover:true}).showCover,true)
})
test('cover preview requests are read-only and cannot modify settings',async()=>{
 const app=await boot('{"enabled":false,"showCover":false}')
 const before=app.saved()
 const preview=await app.configure({coverPreview:true,enabled:true,showCover:true})
 assert.equal(preview.image,null)
 assert.equal(app.saved(),before)
 assert.equal((await app.snapshot()).showCover,false)
})
test('cache status and clear do not change preferences or account settings',async()=>{
 const app=await boot('{"enabled":false,"colorMode":"theme","showCover":false}')
 const before=app.saved()
 const empty={songs:0,lyrics:0,refrains:0,localSongs:0,artworks:0}
 assert.deepEqual(JSON.parse(JSON.stringify(await app.configure({cache:'status',enabled:true}))),empty)
 assert.deepEqual(JSON.parse(JSON.stringify(app.configure({cache:'clear',enabled:true}))),empty)
 assert.equal(app.saved(),before)
 assert.equal((await app.snapshot()).state,'disabled')
 assert.throws(()=>app.configure({cache:'delete-all'}),/无效的缓存操作/)
})
