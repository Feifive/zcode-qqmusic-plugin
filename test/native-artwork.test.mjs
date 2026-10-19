import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {buildNativeLibrary} from '../scripts/lib/native.mjs'
import {createImageIOThumbnailer} from '../plugin/lib/native-artwork.js'
import {extractMagicColors,paletteForArtwork,rgbToHSB,hueBucket} from '../plugin/lib/colors.js'
import {rgbaPNG} from './helpers/png.mjs'
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/artwork.json',import.meta.url)))
const source=entry=>readFileSync(new URL('./fixtures/'+entry.file,import.meta.url))
const bucketsOf=pixels=>{
 const buckets=Array(8).fill(0)
 for(let at=0;at<pixels.length;at+=4){const c=rgbToHSB(...pixels.subarray(at,at+3));if(c.b*100>=12&&c.s*100>11)buckets[hueBucket(c.h)]++}
 return buckets
}
test('frozen ImageIO samples cover Qingtian and the exact original tree album',()=>{
 for(const entry of Object.values(fixtures)){
  assert.equal(createHash('sha256').update(source(entry)).digest('hex'),entry.sha256)
  const reference=entry.imageIO,pixels=Buffer.from(reference.pixels,'base64'),colors=extractMagicColors(pixels,{order:'rgba'})
  assert.equal(pixels.length,400);assert.deepEqual(bucketsOf(pixels),reference.buckets)
  assert.equal(colors.magicColors[0].h,reference.primaryHue);assert.equal(paletteForArtwork(colors).accent,entry.expectedAccent)
 }
 assert.equal(fixtures.tree.songmid,'000CUTL63LNV46');assert.equal(fixtures.tree.songid,105392885)
 assert.equal(fixtures.tree.albumMid,'001Qp10A3tDOIX');assert.equal(fixtures.tree.durationMs,176000)
 assert.deepEqual(fixtures.tree.imageIO.buckets,[1,2,3,5,11,0,0,0]);assert.equal(100-fixtures.tree.imageIO.buckets.reduce((a,b)=>a+b),78)
})
test('production library thumbnail path matches sips pixel-for-pixel and preserves alpha/aspect ratio', {skip:process.platform!=='darwin',timeout:30000},async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'zcode-artwork-')),helper=join(temporary,'now-playing.dylib')
 try{
  buildNativeLibrary(helper,{universal:false})
  const reader=fileURLToPath(new URL('../native/reader.pl',import.meta.url)),thumbnail=createImageIOThumbnailer({reader,helper})
  for(const [name,entry]of Object.entries(fixtures)){
   const bytes=source(entry),result=await thumbnail(bytes),output=join(temporary,name+'.png')
   assert.equal(result.width,10);assert.equal(result.height,10);assert.equal(result.order,'rgba')
   execFileSync('/usr/bin/sips',['-s','format','png','-Z','10',fileURLToPath(new URL('./fixtures/'+entry.file,import.meta.url)),'--out',output])
   const sips=await thumbnail(readFileSync(output))
   assert.deepEqual(result.pixels,sips.pixels,name+' differs from the system thumbnailer')
   assert.equal(paletteForArtwork(extractMagicColors(result.pixels,{order:'rgba'})).accent,entry.expectedAccent,name)
  }
  const transparent=await thumbnail(rgbaPNG(1,1,Buffer.from([153,61,61,0])))
  assert.equal(transparent.pixels[3],0)
  const half=await thumbnail(rgbaPNG(1,1,Buffer.from([200,100,50,128])))
  assert.deepEqual([...half.pixels],[100,50,25,128])
  const wide=await thumbnail(rgbaPNG(40,20,Buffer.from(Array(800).fill([153,61,61,255]).flat())))
  assert.equal(wide.width,10);assert.equal(wide.height,5)
  await assert.rejects(thumbnail(Buffer.from('not an image')),/failed/)
  // Guard oversized headers before attempting full-size Electron decoding.
  const oversized=rgbaPNG(4097,1,Buffer.alloc(4097*4))
  await assert.rejects(thumbnail(oversized),/failed/)
 }finally{rmSync(temporary,{recursive:true,force:true})}
})
