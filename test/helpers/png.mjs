import {deflateSync} from 'node:zlib'
const crc32=bytes=>{
 let crc=0xffffffff
 for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
 return(crc^0xffffffff)>>>0
}
export function rgbaPNG(width,height,pixels){
 const chunk=(type,data)=>{
  const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(data.length+12)
  out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),out.length-4);return out
 }
 const header=Buffer.alloc(13)
 header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6
 const rows=[]
 for(let y=0;y<height;y++)rows.push(Buffer.from([0]),Buffer.from(pixels.subarray(y*width*4,(y+1)*width*4)))
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))])
}
