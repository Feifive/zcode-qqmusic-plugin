import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto'
import vm from 'node:vm'
import {parseAsar,readEntry,patchAsar,hash} from '../scripts/asar.mjs'
import {patchLoader,LOADER_MARKER} from '../scripts/lib/patch.mjs'
import store from '../loader/store.cjs'
import {createUpdater} from '../loader/updates.cjs'

const repository=fileURLToPath(new URL('..',import.meta.url))
function archive(version='3.15.3'){
 const header=Buffer.from('{"files":{}}'),padding=(4-header.length%4)%4,prefix=Buffer.alloc(16)
 prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(8+header.length+padding,4);prefix.writeUInt32LE(4+header.length+padding,8);prefix.writeUInt32LE(header.length,12)
 return patchAsar(Buffer.concat([prefix,header,Buffer.alloc(padding)]),new Map([
  ['package.json',Buffer.from(JSON.stringify({name:'@zcode/desktop',version}))],['out/main/index.js',Buffer.from('export default {}')],['out/preload/index.cjs',Buffer.from('// preload')],['out/renderer/index.html',Buffer.from('<head></head>')],['out/renderer/assets/styles-fixture.css',Buffer.from('chat-composer-input-surface data-v4-timeline-scroll data-following')],
 ])).buffer
}
function fixture(t){
 const dir=fs.mkdtempSync(join(tmpdir(),'zcode-installer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const project=join(dir,'project'),home=join(dir,'home'),root=join(home,'Library/Application Support/ZCode Music'),app=join(dir,'ZCode.app'),asar=join(app,'Contents/Resources/app.asar')
 fs.mkdirSync(dirname(asar),{recursive:true});fs.writeFileSync(asar,archive());fs.mkdirSync(root,{recursive:true});fs.writeFileSync(join(root,'settings.json'),'{"colorMode":"theme"}')
 for(const name of ['loader','plugin/preload.cjs'])fs.cpSync(join(repository,name),join(project,name),{recursive:true})
 const keys=generateKeyPairSync('ed25519'),key=keys.publicKey.export({type:'spki',format:'pem'})
 fs.writeFileSync(join(project,'loader/release-key.pem'),key)
 const required=['package.json','plugin/main.cjs','plugin/renderer.js','plugin/renderer.css','plugin/lyric-timing.js','plugin/lib/colors.js','plugin/lib/color-rules.js','native/reader.pl','native/now-playing.dylib']
 const files=Object.fromEntries(required.map(name=>[name,Buffer.from('fixture:'+name)]))
 const manifest=Buffer.from(JSON.stringify({format:1,version:'1.0.0',loader:1,zcodeVersions:['3.15.3'],files:Object.fromEntries(Object.entries(files).map(([name,b])=>[name,{size:b.length,sha256:hash(b),mode:0o644}]))}))
 fs.mkdirSync(join(project,'dist'));fs.writeFileSync(join(project,'dist/runtime.json'),JSON.stringify({manifest:manifest.toString('base64'),signature:sign(null,manifest,keys.privateKey).toString('base64'),files:Object.fromEntries(Object.entries(files).map(([name,b])=>[name,b.toString('base64')]))}))
 const source=fs.readFileSync(join(repository,'scripts/manage.mjs'),'utf8').replace(/^import .*\n/gm,'').replace(/^const project=.*\n/m,'const project=fixtureProject\n')
 async function run(command,args=[]){
  const output=[],errors=[],process={platform:'darwin',argv:['node','manage.mjs',command,'--app',app,...args],env:{},exitCode:0}
  const execFileSync=(exe,argv)=>{
   if(exe==='/usr/bin/ditto')fs.cpSync(argv[0],argv[1],{recursive:true})
   else assert.ok(['/usr/bin/codesign','/usr/libexec/PlistBuddy'].includes(exe),'Unexpected command '+exe)
   return Buffer.alloc(0)
  }
  await vm.runInNewContext('(async()=>{'+source+'})()',{
   ...fs,join,resolve,dirname,randomUUID,fileURLToPath,parseAsar,readEntry,hash,patchLoader,LOADER_MARKER,store,createUpdater,execFileSync,spawnSync:()=>({status:1}),homedir:()=>home,fixtureProject:project,process,console:{log:message=>output.push(message),error:message=>errors.push(message)},Buffer,
  })
  return{status:process.exitCode,output:output.join('\n'),error:errors.join('\n')}
 }
 return{run,app,asar,root,original:fs.readFileSync(asar),record:()=>JSON.parse(fs.readFileSync(join(root,'installation.json'),'utf8'))}
}
test('fresh install, external update and uninstall preserve settings and the matching official backup',async t=>{
 const f=fixture(t)
 assert.equal((await f.run('install')).status,0)
 const installed=fs.readFileSync(f.asar)
 assert.ok(readEntry(parseAsar(installed),'out/main/index.js').includes(LOADER_MARKER))
 assert.ok(fs.readFileSync(join(f.record().backup,'Contents/Resources/app.asar')).equals(f.original))
 assert.equal((await f.run('install')).status,0);assert.ok(fs.readFileSync(f.asar).equals(installed))
 assert.equal((await f.run('uninstall')).status,0);assert.ok(fs.readFileSync(f.asar).equals(f.original))
 assert.equal(fs.readFileSync(join(f.root,'settings.json'),'utf8'),'{"colorMode":"theme"}')
})
test('repair uses only the recorded backup and refuses a backup from another official version',async t=>{
 const f=fixture(t);assert.equal((await f.run('install')).status,0)
 const damaged=patchAsar(fs.readFileSync(f.asar),new Map([['out/renderer/index.html',Buffer.from('<head>damaged</head>')]])).buffer
 fs.writeFileSync(f.asar,damaged)
 assert.equal((await f.run('repair')).status,0);assert.ok(!fs.readFileSync(f.asar).equals(damaged))
 const record=f.record(),backup=archive('3.15.2');fs.writeFileSync(join(record.backup,'Contents/Resources/app.asar'),backup)
 record.originalHash=hash(backup);fs.writeFileSync(join(f.root,'installation.json'),JSON.stringify(record));fs.writeFileSync(f.asar,damaged)
 const result=await f.run('repair')
 assert.equal(result.status,1);assert.match(result.error,/原包备份校验失败/);assert.ok(fs.readFileSync(f.asar).equals(damaged))
})
test('an unrecorded loader and unsupported command options cannot modify the application',async t=>{
 const f=fixture(t),installed=patchLoader(f.original,join(repository)).buffer
 fs.writeFileSync(f.asar,installed)
 const result=await f.run('install');assert.equal(result.status,1);assert.match(result.error,/缺少加载器安装记录/);assert.ok(fs.readFileSync(f.asar).equals(installed))
 await assert.rejects(f.run('install',['--unknown','value']),/Usage/)
 assert.ok(fs.readFileSync(f.asar).equals(installed))
})
