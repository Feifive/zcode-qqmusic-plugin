;(async()=>{
  if(window.__zcodeMusicLoader)return
  window.__zcodeMusicLoader=true
  if(!window.zcodeMusic?.runtime)return
  const runtime=await window.zcodeMusic.runtime()
  const script=document.createElement('script')
  script.src=new URL('plugin/renderer.js',runtime.baseURL).href
  script.onerror=()=>console.error('[zcode-music] Could not load plugin; run the installer to repair.')
  document.head.append(script)
})().catch(e=>console.error('[zcode-music-loader]',e))
