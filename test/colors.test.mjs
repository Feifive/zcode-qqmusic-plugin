import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {colorRules,rgbToHSB,hsbToRGB,hueBucket,extractMagicColors,mapMagicColor,inRange,playerColorsWithMagicColor,paletteForArtwork} from '../plugin/lib/colors.js'
import {createPaletteReader,artworkURL,fetchArtwork} from '../plugin/lib/artwork.js'
const hsv=(h,s=.6,b=.6)=>({h,s,b})
const rgba=(...samples)=>Uint8Array.from(samples.flatMap(([r,g,b,count=1])=>Array.from({length:count},()=>[r,g,b,255]).flat()))
const settle=()=>new Promise(resolve=>setImmediate(resolve))

test('all light/dark rules and multi-color constants match the palette fixture',()=>{
 const expected=JSON.parse(readFileSync(new URL('./fixtures/color-rules.json',import.meta.url),'utf8'))
 assert.deepEqual(colorRules,expected)
 assert.equal(colorRules.mapping.light.length,26);assert.equal(colorRules.mapping.dark.length,26)
})
test('extraction uses the eight exact hue families and keeps at most three distinct families',()=>{
 const boundaries=[[0,0],[20.999,0],[21,1],[40.999,1],[41,2],[76,3],[156,4],[191,5],[257,6],[296,7],[330,0],[359.9,0]]
 for(const [h,bucket]of boundaries)assert.equal(hueBucket(h),bucket)
 const image=rgba([153,61,61,40],[61,153,61,30],[61,61,153,20],[153,61,153,10])
 const result=extractMagicColors(image,{order:'rgba'})
 assert.equal(result.magicColors.length,3)
 assert.deepEqual(result.magicColors.map(c=>hueBucket(c.h)),[0,3,5])
 assert.equal(extractMagicColors(rgba([153,61,61,100]),{order:'rgba'}).magicColors.length,1)
})
test('vivid selection minimizes distance to S=.6 B=.6 before the exact softening formula',()=>{
 const result=extractMagicColors(rgba([255,0,0,90],[153,61,61,10]),{order:'rgba'})
 const expected=rgbToHSB(153,61,61)
 assert.equal(result.magicColors[0].h,expected.h)
 assert.equal(result.magicColors[0].s,expected.s*.2+.5)
 assert.equal(result.magicColors[0].b,.6*.2+.5)
 const bgra=extractMagicColors(rgba([61,61,153,100]))
 assert.deepEqual(bgra.magicColors,result.magicColors)
})
test('achromatic thresholds, luminance split, dominance and pureColor follow the specification',()=>{
 const white=extractMagicColors(rgba([255,255,255,100]),{order:'rgba'})
 assert.deepEqual(white.magicColors,[]);assert.deepEqual(white.pureColor,hsv(0,0,1))
 const black=extractMagicColors(rgba([0,0,0,100]),{order:'rgba'})
 assert.deepEqual(black.pureColor,hsv(0,0,0))
 assert.equal(extractMagicColors(rgba([188,188,188,60],[187,187,187,40]),{order:'rgba'}).pureColor.b,1)
 assert.equal(extractMagicColors(rgba([188,188,188,40],[187,187,187,60]),{order:'rgba'}).pureColor.b,0)
 const darkDominant=extractMagicColors(rgba([0,0,0,60],[153,61,61,40]),{order:'rgba'})
 assert.equal(darkDominant.magicColors.length,1);assert.equal(darkDominant.pureColor.b,0)
 assert.equal(extractMagicColors(rgba([30,0,0,100]),{order:'rgba'}).magicColors.length,0)
 assert.equal(extractMagicColors(rgba([31,0,0,100]),{order:'rgba'}).magicColors.length,1)
})
test('mapping checks every hue boundary, zero-to-360, grayscale priority and first match',()=>{
 for(const light of [true,false]){
  const rules=light?colorRules.mapping.light:colorRules.mapping.dark
  for(const rule of rules.slice(1))for(const h of rule.h)assert.deepEqual(mapMagicColor(hsv(h),{light}),rule.value)
  assert.deepEqual(mapMagicColor(hsv(0),{light}),rules[25].value)
  assert.deepEqual(mapMagicColor(hsv(120,.11),{light}),rules[0].value)
  assert.deepEqual(mapMagicColor(hsv(120,.8,.1199),{light}),rules[0].value)
  assert.deepEqual(mapMagicColor(null,{light}),rules[0].value)
 }
 assert.equal(inRange(5,[10,1]),true);assert.equal(inRange(5,[]),false)
 assert.equal(mapMagicColor(hsv(30),{rules:[{h:[20,40],op:'and',value:['x']}]}),null)
 assert.deepEqual(mapMagicColor(hsv(30),{rules:[{h:[20,40],value:['first']},{h:[30,30],value:['second']}]}),['first'])
 assert.deepEqual(mapMagicColor(hsv(30),{rules:[{h:[40,20],s:[50,70],b:[50,70],op:'and',value:['x']}]}),['x'])
})
test('parallel player palette has its separate 137 boundary, custom priority, and green fallback',()=>{
 assert.deepEqual(playerColorsWithMagicColor(hsv(137)),colorRules.multiColors.groups[10].map(c=>'#'+c))
 assert.deepEqual(mapMagicColor(hsv(137)),colorRules.mapping.light[12].value)
 assert.deepEqual(playerColorsWithMagicColor(hsv(137,.12)),Array(5).fill('#00F168'))
 assert.deepEqual(playerColorsWithMagicColor(hsv(137),'#F3616F'),colorRules.multiColors.groups[24].map(c=>'#'+c))
 assert.deepEqual(playerColorsWithMagicColor(null,'A0A0A6'),colorRules.multiColors.groups[25].map(c=>'#'+c))
 assert.equal(paletteForArtwork({magicColors:[hsv(0)]},true).accent,'#F3616F')
 assert.equal(paletteForArtwork({magicColors:[hsv(0)]},false).accent,'#9A232E')
 assert.equal(paletteForArtwork({magicColors:[],pureColor:null}).accent,'#00F168')
 assert.equal(paletteForArtwork(null).accent,'#00F168')
 assert.deepEqual(hsbToRGB(hsv(120,1,1)),[0,255,0])
})
test('asynchronous cover fetches deduplicate by album, do not cross tracks, and retry failures',async()=>{
 const jobs=new Map();let requests=0,time=0
 const reader=createPaletteReader({now:()=>time,fetchImage:id=>{requests++;return new Promise((resolve,reject)=>jobs.set(id,{resolve,reject}))},decode:x=>({pixels:x,order:'bgra'})})
 assert.equal(reader.get('A'),null);assert.equal(reader.get('A'),null);reader.get('B');await settle();assert.equal(requests,2)
 jobs.get('A').resolve(rgba([61,61,153,100]));await settle()
 assert.equal(reader.get('B'),null);assert.ok(reader.get('A').magicColors.length)
 jobs.get('B').reject(Error('offline'));await settle();assert.deepEqual(reader.get('B'),{magicColors:[],pureColor:null})
 assert.equal(requests,2);time=300001;reader.get('B');await settle();assert.equal(requests,3)
 jobs.get('B').resolve(rgba([61,153,61,100]));await settle();assert.notDeepEqual(reader.get('A'),reader.get('B'))
})
test('artwork reads only a bounded image response at the fixed QQ Music CDN',async()=>{
 assert.equal(artworkURL('../../secret'),null)
 const response=(type,length,body)=>({ok:true,headers:new Headers({'content-type':type,'content-length':String(length)}),body:(async function*(){yield Buffer.from(body)})()})
 await assert.rejects(fetchArtwork('abc',{fetcher:async()=>response('text/html',2,'no')}),/type/)
 await assert.rejects(fetchArtwork('abc',{fetcher:async()=>response('image/jpeg',3_000_000,'no')}),/large/)
 assert.equal((await fetchArtwork('abc',{fetcher:async()=>response('image/jpeg',2,'ok')})).toString(),'ok')
})

test('album color uses QQ green for pending, missing, failed and malformed artwork in both skins',()=>{
 for(const light of [true,false])for(const artwork of [null,undefined,{}, {magicColors:[],pureColor:null}, {magicColors:[{h:NaN,s:.6,b:.6}],pureColor:{h:800,s:0,b:0}}, {magicColors:{find:'invalid'}}, {pureColor:{h:0,s:-1,b:1}}]){
  const palette=paletteForArtwork(artwork,light)
  assert.equal(palette.accent,'#00F168');assert.equal(palette.base,'#00F168');assert.deepEqual(palette.player,Array(5).fill('#00F168'))
 }
 // pureColor describes the background gradient, never the song-page palette.
 for(const pixels of [rgba([255,255,255,100]),rgba([0,0,0,100])]){
  const artwork=extractMagicColors(pixels,{order:'rgba'})
  assert.deepEqual(artwork.magicColors,[])
  for(const light of [true,false]){
   const palette=paletteForArtwork(artwork,light)
   assert.equal(palette.accent,'#00F168');assert.equal(palette.base,'#00F168')
   assert.deepEqual(palette.player,Array(5).fill('#00F168'))
   assert.equal(palette.surface,light?'#FFFFFF':'#1E1E1F')
  }
 }
 for(const light of [true,false])for(const magicColors of [undefined,[],[null,{h:NaN,s:.6,b:.6}]]){
  assert.equal(paletteForArtwork({magicColors,pureColor:hsv(30)},light).accent,'#00F168')
 }
})
test('album mapping misses and mapping errors fall back to QQ green without consulting grayscale rules',()=>{
 for(const light of [true,false]){
  const name=light?'light':'dark',rules=colorRules.mapping[name]
  try{
   colorRules.mapping[name]=[]
   assert.equal(paletteForArtwork({magicColors:[hsv(30)]},light).accent,'#00F168')
   colorRules.mapping[name]=[{h:[0,360],value:['#123456']}]
   assert.equal(paletteForArtwork({magicColors:[hsv(30)]},light).accent,'#00F168')
   colorRules.mapping[name]=null
   assert.equal(paletteForArtwork({magicColors:[hsv(30)]},light).accent,'#00F168')
  }finally{colorRules.mapping[name]=rules}
 }
})
test('decode and empty/transparent extraction failures retain the QQ green fallback',async()=>{
 for(const decode of [()=>{throw Error('decode failed')},()=>new Uint8Array(),()=>new Uint8Array(400)]){
  const reader=createPaletteReader({fetchImage:async()=>Buffer.from('cover'),decode:()=>({pixels:decode(),order:'bgra'})})
  assert.equal(paletteForArtwork(reader.get('album')).accent,'#00F168')
  await settle()
  assert.equal(paletteForArtwork(reader.get('album')).accent,'#00F168')
 }
 for(const pixels of [null,[],new Uint8Array(),new Uint8Array(3),new Uint8Array(400)])assert.throws(()=>extractMagicColors(pixels),/pixels/)
})

test('cover thumbnails share the album cache with colors and never cross album identities',async()=>{
 const jobs=new Map();let requests=0
 const thumbs={A:'data:image/png;base64,QUFB',B:'data:image/png;base64,QkJC'}
 const reader=createPaletteReader({fetchImage:id=>{requests++;return new Promise(resolve=>jobs.set(id,resolve))},decode:id=>({order:'bgra',pixels:rgba([61,153,61,100]),thumbnail:thumbs[id]})})
 assert.equal(reader.get('A'),null);assert.equal(reader.get('A'),null);assert.equal(reader.get('B'),null)
 await settle();assert.equal(requests,2)
 jobs.get('A')('A');await settle()
 assert.equal(reader.get('A').thumbnail,thumbs.A);assert.equal(reader.get('B'),null)
 jobs.get('B')('B');await settle()
 assert.equal(reader.get('B').thumbnail,thumbs.B);assert.equal(reader.get('A').thumbnail,thumbs.A)
 assert.equal(requests,2);assert.equal(reader.get('../../invalid'),null)
})
test('cover cache only exports bounded inline PNG thumbnails',async()=>{
 for(const thumbnail of ['https://example.com/image.png','data:image/svg+xml;base64,QUFB','data:image/png;base64,'+'A'.repeat(65536),null]){
  const reader=createPaletteReader({fetchImage:async()=>null,decode:()=>({order:'bgra',pixels:rgba([61,153,61,100]),thumbnail})})
  reader.get('album');await settle()
  assert.equal(reader.get('album').thumbnail,undefined)
  assert.ok(reader.get('album').magicColors.length)
 }
})

test('original cover previews reuse the cache, stay album-scoped and reject invalid image data',async()=>{
 const image='data:image/png;base64,QUFB',jobs=new Map();let requests=0
 const reader=createPaletteReader({fetchImage:id=>{requests++;return new Promise(resolve=>jobs.set(id,resolve))},decode:preview=>({order:'bgra',pixels:rgba([61,153,61,100]),preview})})
 assert.equal(reader.preview('A'),null);assert.equal(requests,0)
 reader.get('A');reader.get('B');await settle()
 jobs.get('A')({image,width:300,height:300});await settle()
 assert.deepEqual(reader.preview('A'),{image,width:300,height:300});assert.equal(reader.preview('B'),null)
 assert.equal(reader.get('A').preview,undefined);assert.equal(requests,2)
 jobs.get('B')({image:'https://example.com/image.png',width:300,height:300});await settle()
 assert.equal(reader.preview('B'),null);assert.equal(reader.preview('../../invalid'),null)
 assert.deepEqual(reader.preview('A'),{image,width:300,height:300})
})
