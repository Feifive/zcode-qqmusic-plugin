const validMid=value=>typeof value==='string'&&/^[a-zA-Z0-9]{1,64}$/.test(value)
const validSegment=value=>value&&Number.isFinite(value.confidence)&&value.confidence>=.5&&value.confidence<=1&&Number.isFinite(value.startMs)&&Number.isFinite(value.endMs)&&value.startMs>=0&&value.endMs>value.startMs&&value.endMs<=86400000

export function parseRefrainResponse(body,songmid) {
  if(!validMid(songmid)||body?.code!==0||body.req?.code!==0)return []
  const raw=body.req.data?.refrain?.[songmid]
  if(typeof raw!=='string'||raw.length>65536)return []
  try{
    const data=JSON.parse(raw),confidence=data?.cfd_funclevel
    if(!Number.isFinite(confidence)||confidence<.5||confidence>1||typeof data.chorus_seg_times!=='string')return []
    const parts=data.chorus_seg_times.split('|')
    if(parts.length>128)return []
    // The service supplies one confidence for the song; all its segments share it.
    return parts.flatMap(part=>{
      const times=part.split(',').map(value=>value.trim())
      if(times.length!==2||!times.every(value=>/^\d+(?:\.\d+)?$/.test(value)))return []
      const segment={confidence,startMs:Number(times[0]),endMs:Number(times[1])}
      return validSegment(segment)?[segment]:[]
    })
  }catch{return []}
}
export function selectRefrainPoint(segments,durationMs) {
  if(!Array.isArray(segments)||!Number.isFinite(durationMs)||durationMs<=0)return null
  let best=null
  for(const segment of segments){
    if(!validSegment(segment)||segment.startMs>=durationMs)continue
    if(!best||segment.confidence>best.confidence||(segment.confidence===best.confidence&&segment.startMs<best.startMs))best=segment
  }
  return best
}
export function refrainPosition(refrain,songmid,durationMs) {
  if(!validMid(songmid)||refrain?.songmid!==songmid||!selectRefrainPoint([refrain],durationMs))return null
  return refrain.startMs/durationMs
}
export async function fetchRefrain(songmid,{fetcher=fetch}={}) {
  if(!validMid(songmid))throw Error('Invalid song identity')
  const response=await fetcher('https://u.y.qq.com/cgi-bin/musicu.fcg',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
    headers:{referer:'https://y.qq.com/','content-type':'application/json'},
    body:JSON.stringify({comm:{ct:19,cv:1873},req:{module:'music.mir.MirInfo',method:'GetRefrain',param:{songMidList:[songmid]}}}),
  })
  if(!response.ok)throw Error('Refrain unavailable')
  const text=await response.text()
  if(text.length>131072)throw Error('Refrain response too large')
  return parseRefrainResponse(JSON.parse(text),songmid)
}
// Requests are deduplicated per song and never hold up playback snapshots.
export function createRefrainReader({fetchInfo=fetchRefrain,now=Date.now}={}) {
  const cache=new Map()
  return{get(songmid){
    if(!validMid(songmid))return null
    const old=cache.get(songmid)
    if(old&&(old.pending||now()<old.expires))return old.result
    const entry={pending:true,result:null,expires:0}
    cache.delete(songmid);cache.set(songmid,entry)
    if(cache.size>300)cache.delete(cache.keys().next().value)
    Promise.resolve().then(()=>fetchInfo(songmid)).then(result=>{entry.result=Array.isArray(result)?result.filter(validSegment):[]}).catch(()=>{entry.result=[]}).finally(()=>{
      entry.pending=false;entry.expires=now()+(entry.result.length?6*60*60_000:5*60_000)
    })
    return null
  }}
}
