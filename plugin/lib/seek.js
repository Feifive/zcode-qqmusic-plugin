export function seekIdentity(track) {
  return track ? JSON.stringify([track.app,track.songmid,track.title,track.artist,track.album,track.durationMs]) : ''
}
export function seekRatio(clientX, rect) {
  return Number.isFinite(clientX)&&Number.isFinite(rect?.left)&&Number.isFinite(rect?.width)&&rect.width>0 ? Math.max(0,Math.min(1,(clientX-rect.left)/rect.width)) : null
}
// Keep the preview until the confirmed snapshot arrives. A song change or a
// hidden/disabled dock cancels an unfinished gesture without sending a command.
export function createSeekInteraction({getContext,send,onSettled,onFailure}) {
  let gesture=null,pending=null
  function context() {
    const value=getContext(),duration=value.track?.durationMs
    const current=value.available&&Number.isFinite(duration)&&duration>0 ? {key:seekIdentity(value.track),duration} : null
    if(gesture?.key!==current?.key)gesture=null
    return current
  }
  async function submit(current, position) {
    const job={...current,position:Math.min(86400000,Math.max(0,Math.min(current.duration,Math.round(position))))}
    pending=job;gesture=null
    let failed=false
    try{failed=!(await send(job.position,job.key))?.ok}catch{failed=true}
    try{await onSettled()}finally{if(pending===job)pending=null}
    if(failed)onFailure()
  }
  return {
    get busy(){return pending!==null},
    get dragging(){context();return gesture!==null},
    get enabled(){return Boolean(context())&&!pending},
    preview(){const current=context(),state=gesture||pending;return current&&state?.key===current.key?state.position:null},
    begin(ratio){
      const current=context()
      if(!current||pending||gesture||!Number.isFinite(ratio))return false
      gesture={...current,position:Math.max(0,Math.min(1,ratio))*current.duration};return true
    },
    move(ratio){context();if(gesture&&Number.isFinite(ratio))gesture.position=Math.max(0,Math.min(1,ratio))*gesture.duration},
    finish(ratio){
      this.move(ratio)
      const current=context()
      return gesture&&current ? submit(current,gesture.position) : Promise.resolve()
    },
    cancel(){gesture=null},
    keyboard(position){const current=context();return current&&!pending&&!gesture&&Number.isFinite(position)?submit(current,position):Promise.resolve()},
  }
}
