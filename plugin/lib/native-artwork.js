import { deflateSync } from 'node:zlib'
import { boxAverage, detectPixelOrder } from './resampling.js'

function crc32(bytes) {
  let crc=0xffffffff
  for(const byte of bytes){
    crc^=byte
    for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)
  }
  return (crc^0xffffffff)>>>0
}
// Build an opaque red PNG so the decoder can identify its own channel order.
export function onePixelPNG() {
  const chunk=(type,data)=>{
    const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12)
    out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),out.length-4)
    return out
  }
  const header=Buffer.alloc(13)
  header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))])
}
export function createArtworkDecoder(nativeImage) {
  let order
  return bytes=>{
    order??=detectPixelOrder(nativeImage.createFromBuffer(onePixelPNG()).toBitmap())
    const image=nativeImage.createFromBuffer(bytes)
    if(image.isEmpty())throw Error('Invalid cover image')
    const {width,height}=image.getSize()
    return {
      pixels:boxAverage(image.toBitmap(),width,height),order,
      thumbnail:image.resize({width:40,height:40,quality:'good'}).toDataURL(),
      preview:{image:image.toDataURL(),width,height},
    }
  }
}
