// Inline cover data is produced by the media helper; remote image URLs are not used by the UI.
export function inlinePNG(value, maxLength=65536) {
  return typeof value==='string'&&value.length<=maxLength&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)?value:''
}
export function coverPreviewLayout({width,height,anchor,viewport,origin={left:0,top:0}}) {
  if(![width,height,anchor?.left,anchor?.top,anchor?.width,viewport?.width,viewport?.height,origin.left,origin.top].every(Number.isFinite)||width<=0||height<=0)return null
  const availableWidth=viewport.width-16,availableHeight=anchor.top-16
  if(availableWidth<=0||availableHeight<=0)return null
  const scale=Math.min(1,availableWidth/width,availableHeight/height)
  const w=width*scale,h=height*scale
  const left=Math.max(8,Math.min(viewport.width-w-8,anchor.left+anchor.width/2-w/2))
  return {width:w,height:h,left:left-origin.left,top:anchor.top-h-8-origin.top}
}
export function createCoverPreview({request,isCurrent,onShow,onHide,delay=2000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let ticket=0,timer=null
  function cancel() {
    if(timer!==null)clearTimer(timer)
    timer=null;ticket++
    onHide()
  }
  function schedule(context) {
    cancel()
    const ownTicket=ticket
    timer=setTimer(async()=>{
      timer=null
      const current=response=>ownTicket===ticket&&isCurrent(context,response)
      try {
        const response=await request()
        const image=inlinePNG(response?.image,2*1024*1024)
        if(image&&current(response))onShow(image,()=>current(response))
      }catch{if(ownTicket===ticket)cancel()}
    },delay)
  }
  return {schedule,cancel}
}
