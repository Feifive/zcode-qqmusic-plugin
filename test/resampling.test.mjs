import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {inflateSync} from 'node:zlib'
import {boxAverage,detectPixelOrder} from '../plugin/lib/resampling.js'
import {createArtworkDecoder,onePixelPNG} from '../plugin/lib/native-artwork.js'
import {createPaletteReader} from '../plugin/lib/artwork.js'
import {extractMagicColors,paletteForArtwork} from '../plugin/lib/colors.js'

test('box averaging preserves every channel and averages all source pixels',()=>{
  assert.deepEqual([...boxAverage(Uint8Array.from([10,20,30,40,30,40,50,60,50,60,70,80,70,80,90,100]),2,2,1)],[40,50,60,70])
  const same=boxAverage(Uint8Array.from([11,22,33,255]),1,1)
  assert.equal(same.length,400)
  for(let i=0;i<400;i+=4)assert.deepEqual([...same.slice(i,i+4)],[11,22,33,255])
})
test('non-divisible dimensions weight partial edge pixels by their covered area',()=>{
  const input=Uint8Array.from([0,0,0,255,120,60,0,255,240,120,0,255])
  assert.deepEqual([...boxAverage(input,3,1,2)],[40,20,0,255,200,100,0,255,40,20,0,255,200,100,0,255])
  for(const [pixels,w,h,size] of [[input,0,1,2],[input,3,1,0],[input,3.5,1,2],[input,2,1,2],[new Uint16Array(12),3,1,2]])assert.throws(()=>boxAverage(pixels,w,h,size),/bitmap/)
})
test('generated red PNG is a complete 1x1 RGBA image and detects either channel order',()=>{
  const png=onePixelPNG(),chunks=new Map()
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a')
  for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.subarray(at+4,at+8).toString();chunks.set(type,png.subarray(at+8,at+8+size));if(type==='IHDR')assert.equal(png.readUInt32BE(at+8+size),0x1f15c489);at+=size+12}
  assert.equal(chunks.get('IHDR').readUInt32BE(0),1);assert.equal(chunks.get('IHDR').readUInt32BE(4),1)
  assert.equal(chunks.get('IHDR')[8],8);assert.equal(chunks.get('IHDR')[9],6)
  assert.deepEqual([...inflateSync(chunks.get('IDAT'))],[0,255,0,0,255]);assert.equal(chunks.get('IEND').length,0)
  assert.equal(detectPixelOrder([255,0,0,255]),'rgba');assert.equal(detectPixelOrder([0,0,255,255]),'bgra')
  for(const bad of [[],[0,0,0,255],[255,0,0,128],[0,255,0,255]])assert.throws(()=>detectPixelOrder(bad),/pixel order/)
})
const source=inflateSync(readFileSync(new URL('./fixtures/qingtian-rgba.deflate',import.meta.url)))
test('Qingtian full-size cover averages to cyan and the blue #2DBADE palette',()=>{
  assert.equal(source.length,300*300*4)
  const colors=extractMagicColors(boxAverage(source,300,300),{order:'rgba'})
  assert.equal(colors.magicColors[0].h,182)
  assert.equal(paletteForArtwork(colors).accent,'#2DBADE')
})
test('native decoder probes once, averages full-size pixels and only resizes the display cover',()=>{
  for(const order of ['rgba','bgra']){
    let probes=0;const resizes=[],pixels=Buffer.from(source)
    if(order==='bgra')for(let i=0;i<pixels.length;i+=4)[pixels[i],pixels[i+2]]=[pixels[i+2],pixels[i]]
    const image={isEmpty:()=>false,getSize:()=>({width:300,height:300}),toBitmap:()=>pixels,toDataURL:()=>'data:image/png;base64,QUFB',resize:options=>{resizes.push(options);return{toDataURL:()=>'data:image/png;base64,QkJC'}}}
    const decoder=createArtworkDecoder({createFromBuffer:bytes=>{
      if(bytes.equals(onePixelPNG())){probes++;return{toBitmap:()=>Buffer.from(order==='rgba'?[255,0,0,255]:[0,0,255,255])}}
      return image
    }})
    for(let i=0;i<2;i++){
      const decoded=decoder(Buffer.from('cover'))
      assert.equal(decoded.order,order);assert.equal(decoded.pixels.length,400)
      assert.equal(paletteForArtwork(extractMagicColors(decoded.pixels,{order:decoded.order})).accent,'#2DBADE')
      assert.deepEqual(decoded.preview,{image:'data:image/png;base64,QUFB',width:300,height:300})
      assert.equal(decoded.thumbnail,'data:image/png;base64,QkJC')
    }
    assert.equal(probes,1);assert.equal(resizes.length,2)
    for(const size of resizes)assert.deepEqual(size,{width:40,height:40,quality:'good'})
  }
})
test('album cache honors decoder channel order and falls back to QQ green on a failed probe',async()=>{
  for(const order of ['rgba','bgra']){
    const pixels=Uint8Array.from(order==='rgba'?[153,61,61,255]:[61,61,153,255])
    const reader=createPaletteReader({fetchImage:async()=>null,decode:()=>({pixels,order})})
    reader.get('album');await new Promise(resolve=>setImmediate(resolve))
    assert.equal(paletteForArtwork(reader.get('album')).accent,'#F3616F')
  }
  const decoder=createArtworkDecoder({createFromBuffer:()=>({toBitmap:()=>Buffer.from([0,0,0,255])})})
  const reader=createPaletteReader({fetchImage:async()=>null,decode:decoder})
  reader.get('album');await new Promise(resolve=>setImmediate(resolve))
  assert.equal(paletteForArtwork(reader.get('album')).accent,'#00F168')
})
