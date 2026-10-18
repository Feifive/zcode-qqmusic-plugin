import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

async function boot(saved){
 const handlers=new Map();let persisted=saved
 const path='/official/app.asar/out/renderer/index.html'
 const app={whenReady:()=>Promise.resolve(),getAppPath:()=>'/official/app.asar',getPath:()=>'/settings'}
 const require=name=>{
  if(name==='electron')return{app,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)}}
  if(name==='node:child_process')return{execFile:()=>{throw Error('Unexpected media control')}}
  if(name==='node:fs')return{readFileSync:()=>persisted,mkdirSync(){},writeFileSync:(_file,text)=>{persisted=text},renameSync(){}}
  if(name==='node:url')return{fileURLToPath:u=>u.pathname,pathToFileURL:p=>new URL('file://'+p)}
  if(name==='node:path')return{join:(...parts)=>parts.join('/'),resolve:()=>path}
  throw Error(name)
 }
 vm.runInNewContext(readFileSync(new URL('../plugin/main.cjs',import.meta.url),'utf8')+'\nmodule.exports()',{module:{exports:null},require,__dirname:'/official/app.asar/out/main/zcode-music',console,Date,URL})
 await Promise.resolve()
 const frame={url:'file://'+path},event={senderFrame:frame,sender:{mainFrame:frame}}
 return{configure:c=>handlers.get('zcode-music:configure')(event,c),snapshot:()=>handlers.get('zcode-music:snapshot')(event),saved:()=>persisted}
}
test('color choice preserves existing album appearance and persists theme choice across restarts',async()=>{
 const first=await boot('{"enabled":false,"anyApp":true}')
 assert.equal((await first.snapshot()).colorMode,'album')
 assert.equal(first.configure({colorMode:'theme'}).colorMode,'theme')
 assert.deepEqual(JSON.parse(first.saved()),{enabled:false,anyApp:true,colorMode:'theme'})
 const restarted=await boot(first.saved())
 assert.equal((await restarted.snapshot()).colorMode,'theme')
 assert.equal(restarted.configure({anyApp:false}).colorMode,'theme')
 assert.equal(restarted.configure({colorMode:'invalid'}).colorMode,'theme')
 assert.equal(restarted.configure({colorMode:'album'}).colorMode,'album')
 assert.equal((await restarted.snapshot()).colorMode,'album')
})
