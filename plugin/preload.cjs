;(() => {
  const { contextBridge, ipcRenderer } = require('electron')
  contextBridge.exposeInMainWorld('zcodeMusic', Object.freeze({
    runtime: () => ipcRenderer.invoke('zcode-music:runtime'),
    update: action => ipcRenderer.invoke('zcode-music:update', action),
    snapshot: () => ipcRenderer.invoke('zcode-music:snapshot'),
    control: (action, positionMs) => ipcRenderer.invoke('zcode-music:control', { action, positionMs }),
    configure: (config) => ipcRenderer.invoke('zcode-music:configure', config),
  }))
})()
