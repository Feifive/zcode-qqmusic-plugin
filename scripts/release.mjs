import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createPrivateKey,createPublicKey,sign} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import store from '../loader/store.cjs'
const root=fileURLToPath(new URL('..',import.meta.url)),out=join(root,'dist')
mkdirSync(out,{recursive:true})
const {version}=JSON.parse(readFileSync(join(root,'package.json')))
const key=createPrivateKey(readFileSync(process.env.ZCODE_MUSIC_SIGNING_KEY_FILE||join(root,'.release-private-key.pem')))
const publicKey=readFileSync(join(root,'loader/release-key.pem'),'utf8')
if(createPublicKey(key).export({type:'spki',format:'pem'})!==publicKey)throw Error('Signing key does not match pinned release key')
execFileSync('/usr/bin/clang',['-O2','-dynamiclib','-arch','arm64','-arch','x86_64','-mmacosx-version-min=12.0','-DZCODE_MUSIC_LIBRARY','-fobjc-arc','-fmodules','-fmodules-cache-path=/tmp/zcode-clang-cache','-framework','AppKit',join(root,'native/now-playing.m'),'-o',join(out,'now-playing-universal.dylib')],{stdio:'inherit'})
execFileSync('/usr/bin/codesign',['--force','--sign','-',join(out,'now-playing-universal.dylib')],{stdio:'inherit'})
const files={}
for(const name of ['main.cjs','renderer.js','renderer.css','lyric-timing.js'])files['plugin/'+name]=readFileSync(join(root,'plugin',name))
for(const name of readdirSync(join(root,'plugin/lib')))if(name.endsWith('.js'))files['plugin/lib/'+name]=readFileSync(join(root,'plugin/lib',name))
files['native/reader.pl']=readFileSync(join(root,'native/reader.pl'))
files['native/now-playing.dylib']=readFileSync(join(out,'now-playing-universal.dylib'))
files['package.json']=Buffer.from(JSON.stringify({name:'zcode-music-runtime',version,type:'module'}))
const manifest={format:1,version,loader:1,zcodeVersions:['3.15.3'],files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{sha256:store.digest(b),size:b.length,mode:0o644}]))}
const bytes=Buffer.from(JSON.stringify(manifest))
const bundle={manifest:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64'),files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,b.toString('base64')]))}
store.verifyManifest(bundle,publicKey,'3.15.3')
mkdirSync(join(root,'release'),{recursive:true})
writeFileSync(join(root,`release/zcode-music-${version}.json`),JSON.stringify(bundle)+'\n')
writeFileSync(join(out,'runtime.json'),JSON.stringify(bundle)+'\n')
console.log('Signed plugin release '+version+' (universal macOS); signing key stays local.')
