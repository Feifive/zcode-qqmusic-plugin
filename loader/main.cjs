// Fixed bootstrap: installed once. Ordinary releases live outside ZCode.app.
const {app,ipcMain} = require('electron')
const fs = require('node:fs')
const {join,resolve} = require('node:path')
const {homedir} = require('node:os')
const {fileURLToPath,pathToFileURL} = require('node:url')
const store = require('./store.cjs')
const root = join(homedir(),'Library/Application Support/ZCode Music')
const key = fs.readFileSync(join(__dirname,'release-key.pem'),'utf8')
const rendererPath = resolve(__dirname,'../../renderer/index.html')
const trusted = event => {try{return event.senderFrame===event.sender.mainFrame&&fileURLToPath(new URL(event.senderFrame.url))===rendererPath}catch{return false}}
try {
  const zcodeVersion=app.getVersion()
  const runtime=store.selectRuntime(root,key,zcodeVersion)
  const updates=require('./updates.cjs').createUpdater({root,key,zcodeVersion,runningVersion:runtime.manifest.version})
  app.whenReady().then(()=>{
    ipcMain.handle('zcode-music:runtime',event=>{
      if(!trusted(event))throw Error('Untrusted music plugin sender')
      return{baseURL:pathToFileURL(runtime.dir+'/').href,version:runtime.manifest.version,recovered:runtime.recovered}
    })
    ipcMain.handle('zcode-music:update',async(event,action)=>{
      if(!trusted(event))throw Error('Untrusted music plugin sender')
      if(action==='status')return updates.status()
      if(action==='check')return updates.check()
      if(action==='install')return updates.install()
      if(action==='rollback')return updates.rollback()
      if(action==='restart'){setTimeout(()=>{app.relaunch();app.quit()},250);return{ok:true}}
      throw Error('Unknown update action')
    })
  }).catch(e=>console.error('[zcode-music-loader]',e))
  require(join(runtime.dir,'plugin/main.cjs'))({runtimeDir:runtime.dir,rendererPath,settingsDir:root})
} catch(error) { console.error('[zcode-music-loader]',error.message) }
