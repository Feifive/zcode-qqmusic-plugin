import {test} from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,sign} from 'node:crypto'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import vm from 'node:vm'
import store from '../loader/store.cjs'
import {createUpdater,download} from '../loader/updates.cjs'
const keys=generateKeyPairSync('ed25519'),key=keys.publicKey.export({type:'spki',format:'pem'})
const required=['package.json','plugin/main.cjs','plugin/renderer.js','plugin/renderer.css','plugin/lyric-timing.js','plugin/lib/colors.js','plugin/lib/color-rules.js','native/reader.pl','native/now-playing.dylib']
function bundle(version,change={}){
 const data=Object.fromEntries(required.map(p=>[p,Buffer.from(version+':'+p)]))
 const manifest={format:1,version,loader:1,zcodeVersions:['3.15.3'],files:Object.fromEntries(Object.entries(data).map(([p,b])=>[p,{size:b.length,sha256:store.digest(b),mode:0o644}])),...change}
 const m=Buffer.from(JSON.stringify(manifest))
 return{manifest:m.toString('base64'),signature:sign(null,m,keys.privateKey).toString('base64'),files:Object.fromEntries(Object.entries(data).map(([p,b])=>[p,b.toString('base64')]))}
}
const temp=t=>{const dir=mkdtempSync(join(tmpdir(),'zcode-update-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}
test('atomic external updates preserve the app, settings, active release and rollback target',t=>{
 const root=temp(t);writeFileSync(join(root,'ZCode.app'),'app bytes');writeFileSync(join(root,'settings.json'),'{"colorMode":"theme"}')
 store.activateBundle(root,bundle('0.3.0'),key,'3.15.3')
 store.activateBundle(root,bundle('0.3.1'),key,'3.15.3')
 assert.deepEqual(store.readActive(root),{current:'0.3.1',previous:'0.3.0'})
 assert.equal(store.selectRuntime(root,key,'3.15.3').manifest.version,'0.3.1')
 assert.equal(store.rollback(root,key,'3.15.3'),'0.3.0')
 assert.equal(readFileSync(join(root,'ZCode.app'),'utf8'),'app bytes')
 assert.equal(readFileSync(join(root,'settings.json'),'utf8'),'{"colorMode":"theme"}')
})
test('unsigned, modified, incompatible, path-escaping and same-version replacement releases leave activation untouched',t=>{
 const root=temp(t),good=bundle('0.3.0');store.activateBundle(root,good,key,'3.15.3')
 const badSignature={...bundle('0.3.1'),signature:'AAAA'}
 const badContents=bundle('0.3.1');badContents.files['plugin/main.cjs']=Buffer.from('evil').toString('base64')
 const badPath=bundle('0.3.1',{files:{'../escape':{size:0,sha256:store.digest(''),mode:0o644}}})
 for(const bad of [badSignature,badContents,badPath,bundle('0.3.1',{loader:2}),bundle('0.3.1',{zcodeVersions:['9.0.0']}),bundle('0.3.0',{note:'different'})])assert.throws(()=>store.activateBundle(root,bad,key,'3.15.3'))
 assert.deepEqual(store.readActive(root),{current:'0.3.0',previous:null})
 assert.equal(store.selectRuntime(root,key,'3.15.3').manifest.version,'0.3.0')
})
test('startup falls back from corrupted current release and refuses symlink escape',t=>{
 const root=temp(t);store.activateBundle(root,bundle('0.3.0'),key,'3.15.3');store.activateBundle(root,bundle('0.3.1'),key,'3.15.3')
 writeFileSync(join(root,'versions/0.3.1/plugin/main.cjs'),'corrupt')
 const selected=store.selectRuntime(root,key,'3.15.3');assert.equal(selected.manifest.version,'0.3.0');assert.equal(selected.recovered,true)
 const file=join(root,'versions/0.3.0/plugin/main.cjs'),outside=join(root,'outside');writeFileSync(outside,readFileSync(file));rmSync(file);symlinkSync(outside,file)
 assert.throws(()=>store.selectRuntime(root,key,'3.15.3'),/No verified/)
})
test('interrupted update locks refuse concurrent writes without discarding the active release',t=>{
 const root=temp(t);store.activateBundle(root,bundle('0.3.0'),key,'3.15.3');writeFileSync(join(root,'install.lock'),'another process')
 assert.throws(()=>store.activateBundle(root,bundle('0.3.1'),key,'3.15.3'),/EEXIST/)
 assert.equal(store.readActive(root).current,'0.3.0')
})
test('GitHub update downloads verify before activation, detect restart, and can rollback',async t=>{
 const root=temp(t);store.activateBundle(root,bundle('0.3.0'),key,'3.15.3')
 const release=bundle('0.3.1');let downloads=0
 const fetcher=async url=>{downloads++;return Response.json(String(url).includes('/latest')?{tag_name:'v0.3.1',assets:[{name:'zcode-music-0.3.1.json',browser_download_url:'https://github.com/Feifive/zcode-qqmusic-plugin/releases/download/v0.3.1/zcode-music-0.3.1.json'}]}:release)}
 const u=createUpdater({root,key,zcodeVersion:'3.15.3',runningVersion:'0.3.0',fetcher})
 assert.equal((await u.check()).available,true)
 const [a,b]=await Promise.all([u.install(),u.install()]);assert.equal(a.installedVersion,'0.3.1');assert.equal(b.restartRequired,true);assert.equal(downloads,2)
 assert.equal(u.rollback().installedVersion,'0.3.0')
})
test('untrusted redirect hosts, huge responses, invalid signatures and missing release assets cannot install code',async t=>{
 for(const url of ['http://github.com/x','https://evil.example/x','https://github.com:444/x','https://u:p@github.com/x'])await assert.rejects(download(url,100,()=>{throw Error('must not fetch')}),/Untrusted/)
 await assert.rejects(download('https://github.com/x',100,async()=>new Response(null,{status:302,headers:{location:'https://evil.example/file'}})),/Untrusted/)
 await assert.rejects(download('https://github.com/x',10,async()=>Response.json({data:'large response'})),/large/)
 const root=temp(t);store.activateBundle(root,bundle('0.3.0'),key,'3.15.3')
 const u=createUpdater({root,key,zcodeVersion:'3.15.3',runningVersion:'0.3.0',fetcher:async()=>Response.json({tag_name:'v0.3.1',assets:[]})})
 await assert.rejects(u.check(),/缺少/);assert.equal(store.readActive(root).current,'0.3.0')
})
test('fixed loader runtime and update IPC reject subframes and remote frames',async()=>{
 const handlers=new Map(),frame={url:'file:///app/out/renderer/index.html'},app={getVersion:()=> '3.15.3',whenReady:()=>Promise.resolve()}
 const require=name=>{
  if(name==='electron')return{app,ipcMain:{handle:(n,f)=>handlers.set(n,f)}}
  if(name==='node:fs')return{readFileSync:()=>key}
  if(name==='node:path')return{join:(...p)=>p.join('/'),resolve:()=>'/app/out/renderer/index.html'}
  if(name==='node:os')return{homedir:()=>'/user'}
  if(name==='node:url')return{fileURLToPath:u=>u.pathname,pathToFileURL:p=>new URL('file://'+p)}
  if(name==='./store.cjs')return{selectRuntime:()=>({dir:'/version',manifest:{version:'0.3.0'}})}
  if(name==='./updates.cjs')return{createUpdater:()=>({status:()=>({version:'0.3.0'})})}
  if(name==='/version/plugin/main.cjs')return()=>{}
  throw Error(name)
 }
 vm.runInNewContext(readFileSync(new URL('../loader/main.cjs',import.meta.url),'utf8'),{require,__dirname:'/app/out/main/zcode-music-loader',console,URL,setTimeout})
 await Promise.resolve()
 for(const event of [{senderFrame:{url:frame.url},sender:{mainFrame:frame}},{senderFrame:{url:'https://evil.example'},sender:{mainFrame:frame}}]){
  assert.throws(()=>handlers.get('zcode-music:runtime')(event),/Untrusted/)
  await assert.rejects(handlers.get('zcode-music:update')(event,'install'),/Untrusted/)
 }
 assert.equal(handlers.get('zcode-music:runtime')({senderFrame:frame,sender:{mainFrame:frame}}).version,'0.3.0')
})

test('a signed installer can repair damaged bytes without replacing a valid same-version release',t=>{
 const root=temp(t),release=bundle('0.3.0');store.activateBundle(root,release,key,'3.15.3')
 const file=join(root,'versions/0.3.0/plugin/renderer.js');writeFileSync(file,'broken')
 store.activateBundle(root,release,key,'3.15.3')
 assert.equal(readFileSync(file,'utf8'),'0.3.0:plugin/renderer.js')
 assert.equal(store.selectRuntime(root,key,'3.15.3').manifest.version,'0.3.0')
})
