const fs = require('node:fs')
const path = require('node:path')
const store = require('./store.cjs')
const REPOSITORY = 'Feifive/zcode-qqmusic-plugin'
const hosts = new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'])
async function download(url,limit,fetcher=fetch) {
  for(let i=0;i<5;i++) {
    const u=new URL(url)
    if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.username||u.password||u.port)throw Error('Untrusted update address')
    const response=await fetcher(u,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'ZCode-Music-Plugin','Accept':'application/vnd.github+json'}})
    if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),u).href;await response.body?.cancel();continue}
    if(!response.ok)throw Error(response.status===404?'还没有可用的正式发布版本':'更新请求失败：HTTP '+response.status)
    if(Number(response.headers.get('content-length'))>limit)throw Error('Update response too large')
    const chunks=[];let size=0
    for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body.cancel().catch(()=>{});throw Error('Update response too large')}chunks.push(chunk)}
    return JSON.parse(Buffer.concat(chunks).toString())
  }
  throw Error('Too many update redirects')
}
function createUpdater({root,key,zcodeVersion,runningVersion,fetcher}) {
  let candidate,flight
  async function check() {
    const r=await download('https://api.github.com/repos/'+REPOSITORY+'/releases/latest',1024*1024,fetcher)
    const version=String(r.tag_name||'').replace(/^v/,'')
    if(r.draft||r.prerelease||!store.VERSION.test(version))throw Error('Invalid release metadata')
    const asset=r.assets?.find(a=>a.name===`zcode-music-${version}.json`)
    if(!asset)throw Error('新版缺少插件更新包，请稍后重试')
    candidate={version,url:asset.browser_download_url}
    return status()
  }
  function status(){const a=store.readActive(root);return{runningVersion,installedVersion:a.current,previousVersion:a.previous,latestVersion:candidate?.version||null,available:Boolean(candidate&&store.compare(candidate.version,a.current||runningVersion)>0),restartRequired:a.current!==runningVersion,repository:REPOSITORY}}
  async function install() {
    if(flight)return flight
    flight=(async()=>{
      if(!candidate)await check()
      if(!status().available)return status()
      const expected=candidate
      const bundle=await download(expected.url,12*1024*1024,fetcher)
      const m=store.verifyManifest(bundle,key,zcodeVersion)
      if(m.version!==expected.version)throw Error('Release version mismatch')
      store.activateBundle(root,bundle,key,zcodeVersion)
      return status()
    })().finally(()=>{flight=null})
    return flight
  }
  return {status,check,install,rollback:()=>{if(flight)throw Error('更新正在进行');store.rollback(root,key,zcodeVersion);return status()}}
}
module.exports={REPOSITORY,download,createUpdater}
