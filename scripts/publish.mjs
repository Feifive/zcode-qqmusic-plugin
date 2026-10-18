// Use an existing Git credential locally or the short-lived GitHub Actions token.
// Credentials stay in memory and are sent only to GitHub API/upload endpoints.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
process.chdir(fileURLToPath(new URL('..',import.meta.url)))
const repo='Feifive/zcode-qqmusic-plugin'
if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==repo)throw Error('Unexpected publishing repository')
let token=process.env.GITHUB_TOKEN
if(!token){
 const remote=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim()
 if(remote!=='https://github.com/'+repo+'.git')throw Error('Publishing remote does not match the configured repository')
 const credential=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\npath='+repo+'.git\n\n',encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})
 token=credential.split('\n').find(l=>l.startsWith('password='))?.slice(9)
 if(!token)throw Error('No existing GitHub credential; authenticate Git first')
}
const {version}=JSON.parse(readFileSync('package.json'))
const api='https://api.github.com/repos/'+repo
const headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
async function request(url,method='GET',body){const r=await fetch(url,{method,redirect:'error',headers:{...headers,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('GitHub release request failed: '+r.status);return r.json()}
if(!process.env.GITHUB_REPOSITORY){
 if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Commit tracked changes before publishing')
 const identity=await request('https://api.github.com/user')
 if(identity.login!=='Feifive')throw Error('Publishing credential does not belong to Feifive')
}
const existing=await fetch(api+'/releases/tags/v'+version,{headers,redirect:'error'})
let release
if(existing.ok){release=await existing.json();if(!release.draft){console.log('Release v'+version+' is already published; immutable version left unchanged.');process.exit(0)}}
else if(existing.status!==404)throw Error('Cannot check existing release: '+existing.status)
if(!release)release=await request(api+'/releases','POST',{tag_name:'v'+version,target_commitish:process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),name:'ZCode Music '+version,draft:true,body:readFileSync(`release/notes-${version}.md`,'utf8')})
for(const [name,file,type]of [[`zcode-music-${version}.json`,`release/zcode-music-${version}.json`,'application/json'],[`ZCode-Music-Installer-${version}-macOS.zip`,`dist/ZCode-Music-Installer-${version}-macOS.zip`,'application/zip']]){
 const bytes=readFileSync(file),sha='sha256:'+createHash('sha256').update(bytes).digest('hex'),old=release.assets?.find(a=>a.name===name)
 if(old){if(old.digest!==sha)throw Error('Draft contains a different asset; inspect the draft before retrying: '+name);continue}
 const url=release.upload_url.replace(/\{.*$/,'')+'?name='+encodeURIComponent(name)
 if(new URL(url).hostname!=='uploads.github.com')throw Error('Unexpected release upload endpoint')
 const r=await fetch(url,{method:'POST',redirect:'error',headers:{...headers,'Content-Type':type},body:bytes})
 if(!r.ok)throw Error('Release asset upload failed: '+r.status)
}
release=await request(api+'/releases/'+release.id,'PATCH',{draft:false,make_latest:'true'})
console.log('Published '+release.html_url)
