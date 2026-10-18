// Shared by the fixed loader and installer. Release code is never run before verification.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const LOADER_VERSION = 1
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
const allowed = p => /^(package\.json|plugin\/(main\.cjs|renderer\.js|renderer\.css|lyric-timing\.js|lib\/[a-z-]+\.js)|native\/(reader\.pl|now-playing\.dylib))$/.test(p)
const required = ['package.json','plugin/main.cjs','plugin/renderer.js','plugin/renderer.css','plugin/lyric-timing.js','plugin/lib/colors.js','plugin/lib/color-rules.js','native/reader.pl','native/now-playing.dylib']
const digest = b => crypto.createHash('sha256').update(b).digest('hex')
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700})
  const tmp = file + '.' + crypto.randomUUID() + '.tmp'
  try { fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'}); fs.renameSync(tmp,file) }
  finally { fs.rmSync(tmp,{force:true}) }
}
function verifyManifest(envelope, key, zcodeVersion) {
  if (typeof envelope?.manifest !== 'string' || envelope.manifest.length > 40000 || typeof envelope.signature !== 'string') throw Error('Invalid release envelope')
  const bytes = Buffer.from(envelope.manifest,'base64')
  if (!crypto.verify(null,bytes,key,Buffer.from(envelope.signature,'base64'))) throw Error('Release signature mismatch')
  const m = JSON.parse(bytes)
  if (m.format !== 1 || !VERSION.test(m.version) || !Number.isInteger(m.loader) || m.loader < 1 || m.loader > LOADER_VERSION) throw Error('Unsupported release or loader version; run the new installer')
  if (!Array.isArray(m.zcodeVersions) || !m.zcodeVersions.includes(zcodeVersion)) throw Error('This release does not support ZCode '+zcodeVersion)
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw Error('Invalid release files')
  const files = Object.entries(m.files)
  if (files.length > 64 || required.some(p=>!Object.hasOwn(m.files,p))) throw Error('Incomplete release')
  let total = 0
  for (const [p,v] of files) {
    if (!allowed(p) || !v || !/^[a-f0-9]{64}$/.test(v.sha256) || !Number.isInteger(v.size) || v.size < 0 || ![0o644,0o755].includes(v.mode)) throw Error('Invalid release file: '+p)
    total += v.size
  }
  if (total > 8*1024*1024) throw Error('Release too large')
  return m
}
function verifyDirectory(dir, key, zcodeVersion) {
  const sealPath = path.join(dir,'release.json')
  if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(sealPath).isSymbolicLink()) throw Error('Symbolic release path')
  const seal = JSON.parse(fs.readFileSync(sealPath,'utf8'))
  const m = verifyManifest(seal,key,zcodeVersion)
  if (path.basename(dir) !== m.version && !path.basename(dir).startsWith('.stage-')) throw Error('Release directory version mismatch')
  const real = fs.realpathSync(dir) + path.sep
  for (const [p,v] of Object.entries(m.files)) {
    const file = path.join(dir,p)
    if (!fs.realpathSync(file).startsWith(real) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw Error('Unsafe release path')
    const bytes = fs.readFileSync(file)
    if (bytes.length !== v.size || digest(bytes) !== v.sha256) throw Error('Release file checksum mismatch: '+p)
  }
  return {manifest:m,seal,dir}
}
function readActive(root) {
  try { const a=JSON.parse(fs.readFileSync(path.join(root,'active.json'),'utf8'));return {current:VERSION.test(a.current)?a.current:null,previous:VERSION.test(a.previous)?a.previous:null} }
  catch { return {current:null,previous:null} }
}
function withLock(root, fn) {
  fs.mkdirSync(root,{recursive:true,mode:0o700})
  const lock = path.join(root,'install.lock')
  const fd = fs.openSync(lock,'wx',0o600)
  try { fs.writeSync(fd,String(process.pid));return fn() }
  finally { fs.closeSync(fd);fs.rmSync(lock,{force:true}) }
}
function activateBundle(root, envelope, key, zcodeVersion) {
  const m=verifyManifest(envelope,key,zcodeVersion)
  if (!envelope.files || Object.keys(envelope.files).length !== Object.keys(m.files).length) throw Error('Payload file count mismatch')
  const decoded = new Map()
  for (const [p,v] of Object.entries(m.files)) {
    if (typeof envelope.files[p] !== 'string' || envelope.files[p].length > Math.ceil(v.size/3)*4+4) throw Error('Invalid payload: '+p)
    const b = Buffer.from(envelope.files[p],'base64')
    if (b.length !== v.size || digest(b) !== v.sha256) throw Error('Payload checksum mismatch: '+p)
    decoded.set(p,b)
  }
  return withLock(root,()=>{
    const versions=path.join(root,'versions'),dest=path.join(versions,m.version)
    fs.mkdirSync(versions,{recursive:true,mode:0o700})
    let intact=false
    if (fs.existsSync(dest)) {
      let seal
      try { seal=JSON.parse(fs.readFileSync(path.join(dest,'release.json'),'utf8'));verifyManifest(seal,key,zcodeVersion) } catch { seal=null }
      if (seal && seal.manifest !== envelope.manifest) throw Error('Version already exists with different contents')
      try { verifyDirectory(dest,key,zcodeVersion);intact=true } catch { /* signed payload can repair a damaged copy */ }
    }
    if (!intact) {
      const stage=path.join(versions,'.stage-'+crypto.randomUUID())
      fs.mkdirSync(stage,{mode:0o700})
      try {
        for(const [p,b] of decoded){const file=path.join(stage,p);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,b,{mode:m.files[p].mode,flag:'wx'})}
        atomic(path.join(stage,'release.json'),{manifest:envelope.manifest,signature:envelope.signature})
        verifyDirectory(stage,key,zcodeVersion)
        const damaged=fs.existsSync(dest)?path.join(versions,'.damaged-'+crypto.randomUUID()):null
        if(damaged)fs.renameSync(dest,damaged)
        try { fs.renameSync(stage,dest) }
        catch(error){if(damaged)fs.renameSync(damaged,dest);throw error}
      } finally {fs.rmSync(stage,{force:true,recursive:true})}
    }
    const active=readActive(root)
    atomic(path.join(root,'active.json'),{current:m.version,previous:active.current===m.version?active.previous:active.current})
    return m
  })
}
function selectRuntime(root,key,zcodeVersion) {
  const a=readActive(root)
  for(const version of [...new Set([a.current,a.previous].filter(Boolean))]) {
    try {
      const r=verifyDirectory(path.join(root,'versions',version),key,zcodeVersion)
      if(version!==a.current)withLock(root,()=>atomic(path.join(root,'active.json'),{current:version,previous:null}))
      return {...r,recovered:version!==a.current,active:a}
    } catch { /* a corrupt current version may use the last verified version */ }
  }
  throw Error('No verified music plugin version. Run ZCode Music Installer to repair.')
}
function rollback(root,key,zcodeVersion) {
  return withLock(root,()=>{
    const a=readActive(root)
    if(!a.previous)throw Error('没有可回退的版本')
    verifyDirectory(path.join(root,'versions',a.previous),key,zcodeVersion)
    atomic(path.join(root,'active.json'),{current:a.previous,previous:a.current})
    return a.previous
  })
}
function compare(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return Math.sign(x[i]-y[i])}return 0}
module.exports={LOADER_VERSION,VERSION,digest,atomic,verifyManifest,verifyDirectory,activateBundle,readActive,selectRuntime,rollback,compare,withLock}
