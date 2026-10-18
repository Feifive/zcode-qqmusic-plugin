import { extractMagicColors } from './colors.js'
import { inlinePNG } from './cover.js'
const MAX_BYTES=2*1024*1024
export function artworkURL(albumMid){
  return typeof albumMid==='string'&&/^[a-zA-Z0-9]{1,64}$/.test(albumMid)?`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`:null
}
export async function fetchArtwork(albumMid,{fetcher=fetch}={}){
  const url=artworkURL(albumMid)
  if(!url)throw Error('Invalid album identity')
  const response=await fetcher(url,{signal:AbortSignal.timeout(6000),redirect:'error'})
  if(!response.ok)throw Error('Artwork unavailable')
  if(!/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type')||''))throw Error('Invalid artwork type')
  if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('Artwork too large')
  const chunks=[];let size=0
  for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw Error('Artwork too large');chunks.push(chunk)}
  return Buffer.concat(chunks)
}
// An album-scoped cache prevents late artwork from coloring the next song.
// Fetch/decode never holds up the player's snapshot or lyric timing.
export function createPaletteReader({decode,fetchImage=fetchArtwork,now=Date.now}){
  const cache=new Map()
  return {get(albumMid){
    if(!artworkURL(albumMid))return null
    const old=cache.get(albumMid)
    if(old&&(old.pending||now()<old.expires))return old.result
    const entry={pending:true,result:null,expires:0,ok:false}
    cache.delete(albumMid);cache.set(albumMid,entry)
    if(cache.size>64)cache.delete(cache.keys().next().value)
    Promise.resolve().then(()=>fetchImage(albumMid)).then(decode).then(decoded=>{
      const bitmap=decoded?.pixels
      const order=decoded?.order
      if(!['bgra','rgba'].includes(order))throw Error('Invalid artwork pixel order')
      entry.result=extractMagicColors(bitmap,{order})
      const thumbnail=decoded?.thumbnail
      if(inlinePNG(thumbnail))entry.result.thumbnail=thumbnail
      const preview=decoded?.preview
      if(inlinePNG(preview?.image,2*1024*1024)&&Number.isFinite(preview.width)&&Number.isFinite(preview.height)&&preview.width>0&&preview.height>0)entry.preview=preview
      entry.ok=true
    }).catch(()=>{entry.result={magicColors:[],pureColor:null}}).finally(()=>{
      entry.pending=false;entry.expires=now()+(entry.ok?6*60*60_000:5*60_000)
    })
    return null
  },preview(albumMid){
    return artworkURL(albumMid)?cache.get(albumMid)?.preview||null:null
  }}
}
