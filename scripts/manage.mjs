import {openSync,closeSync,existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,copyFileSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {parseAsar,readEntry,hash} from './asar.mjs'
import {patchLoader,LOADER_MARKER} from './lib/patch.mjs'
import store from '../loader/store.cjs'
import {createUpdater} from '../loader/updates.cjs'
// Electron's Node mode normally treats .asar paths as directories. The installer
// must read and hash the actual archive bytes, not an entry inside it.
process.noAsar = true
const project=fileURLToPath(new URL('..',import.meta.url))
const argv=process.argv.slice(2),command=argv[0]||'install'
const option=name=>{const i=argv.indexOf('--'+name);return i<0?null:argv[i+1]}
const app=resolve(option('app')||'/Applications/ZCode.app')
const root=join(homedir(),'Library/Application Support/ZCode Music')
const recordFile=join(root,'installation.json'),activeFile=join(root,'active.json')
const key=readFileSync(join(project,'loader/release-key.pem'),'utf8')
const asar=a=>join(a,'Contents/Resources/app.asar')
const run=(p,args)=>execFileSync(p,args,{stdio:['ignore','pipe','pipe']})
const closed=()=>{const p=spawnSync('/usr/bin/pgrep',['-x','ZCode']);if(p.status===0)throw Error('请先完全退出 ZCode（⌘Q），再继续安装或卸载。');if(p.status!==1)throw Error('无法检查 ZCode 是否已退出')}
const inspect=a=>{const bytes=readFileSync(asar(a)),archive=parseAsar(bytes),pkg=JSON.parse(readEntry(archive,'package.json'));if(pkg.name!=='@zcode/desktop')throw Error('所选应用不是官方 ZCode');return{bytes,archive,version:pkg.version,sha:hash(bytes),main:readEntry(archive,'out/main/index.js').toString()}}
function replaceApp(stage){
 const old=app+'.music-old-'+randomUUID()
 renameSync(app,old)
 try{renameSync(stage,app);run('/usr/bin/codesign',['--verify','--deep','--strict',app])}
 catch(e){if(existsSync(app))renameSync(app,stage);renameSync(old,app);throw e}
 rmSync(old,{recursive:true,force:true})
}
async function main(){
 if(process.platform!=='darwin')throw Error('目前仅支持 macOS')
 if(!app.endsWith('.app'))throw Error('请选择 ZCode.app')
 const current=inspect(app)
 const record=existsSync(recordFile)?JSON.parse(readFileSync(recordFile,'utf8')):null
 const loaded=current.main.includes(LOADER_MARKER)
 if(command==='status')return{...store.readActive(root),loaderInstalled:loaded,zcodeVersion:current.version,root}
 if(command==='update'){
  if(!loaded)throw Error('请先安装或修复加载器')
  const updates=createUpdater({root,key,zcodeVersion:current.version,runningVersion:store.readActive(root).current||'0.0.0'})
  const status=await updates.check()
  if(!status.available)return{message:'已是最新版本',...status}
  return{message:'更新已安装，重新打开 ZCode 后生效',...await updates.install()}
 }
 if(command==='rollback'){const version=store.rollback(root,key,current.version);return{message:'已回退至 '+version+'，重新打开 ZCode 后生效'}}
 if(command==='uninstall'){
  if(!loaded&&!current.main.includes('zcode-music/main.cjs'))return{message:'ZCode 当前没有加载器，备份和设置已保留'}
  if(!record||record.patchedHash!==current.sha)throw Error('ZCode 已被其它版本修改，拒绝覆盖。请用对应版本的官方安装包恢复。')
  closed()
  const original=inspect(record.backup)
  if(original.sha!==record.originalHash)throw Error('原包备份校验失败')
  const stage=join(dirname(app),'.ZCode.music-restore-'+randomUUID()+'.app')
  try{run('/usr/bin/ditto',[record.backup,stage]);replaceApp(stage)}finally{rmSync(stage,{recursive:true,force:true})}
  return{message:'已卸载加载器并恢复原包，插件设置和版本备份已保留'}
 }
 if(!['install','repair'].includes(command))throw Error('Unknown command')
 const bundle=JSON.parse(readFileSync(join(project,'dist/runtime.json'),'utf8'))
 store.verifyManifest(bundle,key,current.version)
 // If a compatible loader is already installed, only activate the external payload.
 if(loaded&&record?.patchedHash===current.sha){
  const pinned=readEntry(current.archive,'out/main/zcode-music-loader/release-key.pem').toString()
  if(pinned!==key)throw Error('加载器发布密钥不同，请使用原发布者的安装器')
  const m=store.activateBundle(root,bundle,key,current.version)
  return{message:'已更新插件至 '+m.version+'；ZCode 应用包未修改，重新打开后生效'}
 }
 closed()
 let source=app,original=current
 if(loaded||current.main.includes('zcode-music/main.cjs')){
  const candidates=[option('backup'),record?.backup,join(project,'backup/ZCode.app')].filter(Boolean)
  source=candidates.find(p=>existsSync(asar(p)))
  if(!source)throw Error('LEGACY_BACKUP_REQUIRED: 检测到旧版插件，请选择原始备份 backup/ZCode.app')
  original=inspect(source)
 }
 const patched=patchLoader(original.bytes,project)
 const backup=join(root,'backups',original.version+'-'+original.sha.slice(0,12),'ZCode.app')
 mkdirSync(dirname(backup),{recursive:true,mode:0o700})
 if(!existsSync(backup))run('/usr/bin/ditto',[source,backup])
 if(inspect(backup).sha!==original.sha)throw Error('原包备份校验失败')
 const stage=join(dirname(app),'.ZCode.music-stage-'+randomUUID()+'.app')
 const oldActive=existsSync(activeFile)?readFileSync(activeFile):null
 const oldRecord=existsSync(recordFile)?readFileSync(recordFile):null
 try{
  run('/usr/bin/ditto',[backup,stage])
  writeFileSync(asar(stage),patched.buffer)
  run('/usr/libexec/PlistBuddy',['-c',`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${patched.headerHash}`,join(stage,'Contents/Info.plist')])
  run('/usr/bin/codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements,flags,runtime',stage])
  run('/usr/bin/codesign',['--verify','--deep','--strict',stage])
  store.activateBundle(root,bundle,key,current.version)
  closed()
  store.atomic(recordFile,{app,backup,originalHash:original.sha,patchedHash:patched.patchedHash,loader:1,installedAt:new Date().toISOString()})
  replaceApp(stage)
 }catch(e){if(oldRecord)writeFileSync(recordFile,oldRecord);else rmSync(recordFile,{force:true});if(oldActive)writeFileSync(activeFile,oldActive);else rmSync(activeFile,{force:true});throw e}
 finally{rmSync(stage,{recursive:true,force:true})}
 return{message:'已安装插件 '+JSON.parse(Buffer.from(bundle.manifest,'base64')).version+'；以后普通插件升级无需修改 ZCode 应用包',root}
}
let lock
try{
 mkdirSync(root,{recursive:true,mode:0o700})
 lock=openSync(join(root,'manager.lock'),'wx',0o600)
 console.log(JSON.stringify(await main(),null,2))
}catch(e){console.error(e.stderr?.toString()||e.message);process.exitCode=1}
finally{if(lock!==undefined){closeSync(lock);rmSync(join(root,'manager.lock'),{force:true})}}
