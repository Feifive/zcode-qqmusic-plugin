// Average the exact source area covered by each output pixel, including partial
// edge pixels when the source dimensions are not divisible by the target size.
// Channel order and premultiplied alpha are preserved for color extraction.
export function boxAverage(pixels, width, height, size=10) {
  if (!ArrayBuffer.isView(pixels) || pixels.BYTES_PER_ELEMENT!==1 || ![width,height,size].every(n=>Number.isSafeInteger(n)&&n>0) || pixels.length!==width*height*4) throw Error('Invalid artwork bitmap')
  const output=new Uint8Array(size*size*4)
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const left=x*width/size,right=(x+1)*width/size,top=y*height/size,bottom=(y+1)*height/size
    const sums=[0,0,0,0],area=(right-left)*(bottom-top)
    for(let sy=Math.floor(top);sy<Math.ceil(bottom);sy++)for(let sx=Math.floor(left);sx<Math.ceil(right);sx++){
      const weight=(Math.min(right,sx+1)-Math.max(left,sx))*(Math.min(bottom,sy+1)-Math.max(top,sy))
      const source=(sy*width+sx)*4
      for(let channel=0;channel<4;channel++)sums[channel]+=pixels[source+channel]*weight
    }
    const target=(y*size+x)*4
    for(let channel=0;channel<4;channel++)output[target+channel]=Math.round(sums[channel]/area)
  }
  return output
}
export function detectPixelOrder(redPixel) {
  if(redPixel?.length===4&&redPixel[1]===0&&redPixel[3]===255){
    if(redPixel[0]===255&&redPixel[2]===0)return 'rgba'
    if(redPixel[0]===0&&redPixel[2]===255)return 'bgra'
  }
  throw Error('Unrecognized artwork pixel order')
}
