import { colorRules } from './color-rules.js'
export { colorRules }
export function rgbToHSB(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min
  let h = 0
  if (delta) {
    if (max === r) h = ((g-b)/delta)%6
    else if (max === g) h = (b-r)/delta+2
    else h = (r-g)/delta+4
    h = (h*60+360)%360
  }
  return { h, s: max ? delta/max : 0, b: max }
}
export function hsbToRGB({ h, s, b }) {
  const c=b*s, x=c*(1-Math.abs((h/60)%2-1)), m=b-c
  const values=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x]
  return values.map(v=>Math.round((v+m)*255))
}
export function colorHex(color) {
  return '#' + hsbToRGB(color).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()
}
export function relativeLuminance(rgb) {
  const v=rgb.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4})
  return .2126*v[0]+.7152*v[1]+.0722*v[2]
}
export function hueBucket(hue) {
  const h=Math.trunc(hue)
  if(h<21||h>=330)return 0
  if(h<41)return 1
  if(h<76)return 2
  if(h<156)return 3
  if(h<191)return 4
  if(h<257)return 5
  if(h<296)return 6
  return 7
}
// Input must be the 10×10 thumbnail. Keep HSB precision across IPC and mapping;
// rounding the magic color to 8-bit hex first can select an adjacent rule.
export function extractMagicColors(pixels, { order='bgra', count=3, premultiplied=true }={}) {
  const buckets=Array.from({length:8},(_,index)=>({index,colors:[]}))
  let light=0,dark=0
  for(let i=0;i+3<pixels.length;i+=4){
    const alpha=pixels[i+3]/255
    if(alpha===0)continue
    const unpremultiply=n=>Math.max(0,Math.min(255,n/(premultiplied?alpha:1)))
    const rgb=[unpremultiply(pixels[i+(order==='bgra'?2:0)]),unpremultiply(pixels[i+1]),unpremultiply(pixels[i+(order==='bgra'?0:2)])]
    const hsb=rgbToHSB(...rgb)
    if(hsb.b*100<12||hsb.s*100<=11){
      if(relativeLuminance(rgb)>=.5)light++;else dark++
    }else buckets[hueBucket(hsb.h)].colors.push(hsb)
  }
  const ranked=buckets.sort((a,b)=>b.colors.length-a.colors.length||a.index-b.index)
  const maxBucket=ranked[0].colors.length
  const colors=[]
  for(const bucket of ranked){
    if(!bucket.colors.length||colors.length>=count)break
    const distance=c=>(c.s-.6)**2+(c.b-.6)**2
    let best=bucket.colors[0]
    for(const candidate of bucket.colors)if(distance(candidate)<distance(best))best=candidate
    colors.push({h:best.h,s:best.s*.2+.5,b:best.b*.2+.5})
  }
  const pureColor=dark<=maxBucket&&maxBucket>0&&light<=maxBucket?colors[0]:{h:0,s:0,b:dark<=light?1:0}
  return { magicColors:colors,pureColor }
}
function validColor(c){return c&&['h','s','b'].every(k=>Number.isFinite(c[k]))&&c.h>=0&&c.h<=360&&c.s>=0&&c.s<=1&&c.b>=0&&c.b<=1}
export function inRange(component, range) {
  return Array.isArray(range)&&range.length===2&&component>=Math.min(...range)&&component<=Math.max(...range)
}
export function mapMagicColor(color, { light=true, rules=light?colorRules.mapping.light:colorRules.mapping.dark, treatZeroHueAs360=true, defaultOp='or' }={}) {
  const c=validColor(color)?color:{h:0,s:0,b:0}
  let h=Math.trunc(c.h);if(h===0&&treatZeroHueAs360)h=360
  const s=Math.trunc(c.s*100),b=Math.trunc(c.b*100)
  for(const rule of rules){
    const hIn=inRange(h,rule.h),sIn=inRange(s,rule.s),bIn=inRange(b,rule.b)
    const match=(rule.op||defaultOp)==='and'?(hIn&&sIn&&bIn):(hIn||sIn||bIn)
    if(match)return [...rule.value]
  }
  return null
}
export function playerColorsWithMagicColor(color, customHex='') {
  const {groups,hueBounds,fallback}=colorRules.multiColors
  const custom=String(customHex).replace(/^#/,'').toUpperCase()
  if(custom&&custom!=='000000'){
    const group=groups.find(values=>values.includes(custom))
    if(group)return group.map(hex=>'#'+hex)
  }
  if(validColor(color)&&color.s*100>=13&&color.b*100>=13){
    const index=hueBounds.findIndex(bound=>bound>=Math.trunc(color.h))
    if(index>=0)return groups[index].map(hex=>'#'+hex)
  }
  return Array(5).fill(fallback)
}
export function paletteForArtwork(artwork, light=true) {
  if(!artwork)return null
  const primary=artwork.magicColors?.find(validColor)||(validColor(artwork.pureColor)?artwork.pureColor:null)
  const mapped=mapMagicColor(primary,{light})
  return mapped?{base:mapped[0],accent:mapped[1],surface:mapped[2],player:playerColorsWithMagicColor(primary)}:null
}
