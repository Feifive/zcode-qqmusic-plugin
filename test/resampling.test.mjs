import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {inflateSync} from 'node:zlib'
import {boxAverage} from '../plugin/lib/resampling.js'
import {createArtworkDecoder,createImageIOThumbnailer} from '../plugin/lib/native-artwork.js'
import {createPaletteReader} from '../plugin/lib/artwork.js'
import {extractMagicColors,paletteForArtwork} from '../plugin/lib/colors.js'

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
test('diagnostic box averaging preserves channels and weights non-divisible edges',()=>{
 assert.deepEqual([...boxAverage(Uint8Array.from([10,20,30,40,30,40,50,60,50,60,70,80,70,80,90,100]),2,2,1)],[40,50,60,70])
 const input=Uint8Array.from([0,0,0,255,120,60,0,255,240,120,0,255])
 assert.deepEqual([...boxAverage(input,3,1,2)],[40,20,0,255,200,100,0,255,40,20,0,255,200,100,0,255])
 for(const [pixels,w,h,size] of [[input,0,1,2],[input,3,1,0],[input,3.5,1,2],[input,2,1,2],[new Uint16Array(12),3,1,2]])assert.throws(()=>boxAverage(pixels,w,h,size),/bitmap/)
})
test('historical Qingtian box average matches the accent but differs from the native thumbnail pixels',()=>{
 const source=inflateSync(readFileSync(new URL('./fixtures/qingtian-rgba.deflate',import.meta.url)))
 assert.equal(source.length,300*300*4)
 const pixels=boxAverage(source,300,300)
 const colors=extractMagicColors(pixels,{order:'rgba'})
 assert.equal(colors.magicColors[0].h,182);assert.equal(paletteForArtwork(colors).accent,'#2DBADE')
 const expected=JSON.parse(readFileSync(new URL('./fixtures/artwork.json',import.meta.url))).qingtian.imageIO
 assert.notDeepEqual(Buffer.from(pixels),Buffer.from(expected.pixels,'base64'))
})
test('decoder passes through native thumbnail pixels unchanged and only uses Electron resizing for display',async()=>{
 const pixels=Buffer.alloc(400);let decoded=0;const resizes=[]
 const image={isEmpty:()=>false,getSize:()=>({width:300,height:300}),toBitmap:()=>{throw Error('Must not extract full-size bitmap')},
  toDataURL:()=>'data:image/png;base64,QUFB',resize:options=>{resizes.push(options);return{toDataURL:()=>'data:image/png;base64,QkJC'}}}
 const decoder=createArtworkDecoder({createFromBuffer:()=>image},{thumbnail:async bytes=>{decoded++;assert.equal(bytes.toString(),'encoded JPEG');return{pixels,order:'rgba'}}})
 const result=await decoder(Buffer.from('encoded JPEG'))
 assert.equal(result.pixels,pixels);assert.equal(result.order,'rgba');assert.equal(decoded,1)
 assert.deepEqual(resizes,[{width:40,height:40,quality:'good'}]);assert.equal(result.thumbnail,'data:image/png;base64,QkJC')
 assert.deepEqual(result.preview,{image:'data:image/png;base64,QUFB',width:300,height:300})
})
function mockRunner(handler){
 const calls=[]
 const run=(file,args,options,callback)=>{
  const call={file,args,options,callback,input:null};calls.push(call)
  return{stdin:{on(){},end(bytes){call.input=bytes;queueMicrotask(()=>handler(call))}}}
 }
 return{calls,thumbnail:createImageIOThumbnailer({reader:'/runtime/native/reader.pl',helper:'/runtime/native/now-playing.dylib',run})}
}
const output=(extras={})=>JSON.stringify({engine:'imageio',order:'rgba',width:1,height:1,pixels:Buffer.from([153,61,61,255]).toString('base64'),...extras})
test('thumbnailer sends bounded binary stdin to the fixed helper and serializes albums',async()=>{
 const jobs=[];const f=mockRunner(call=>jobs.push(call))
 const a=f.thumbnail(Buffer.from('album-a')),b=f.thumbnail(Buffer.from('album-b'))
 await settle();assert.equal(f.calls.length,1)
 const call=jobs.shift();assert.equal(call.file,'/usr/bin/perl');assert.deepEqual(call.args,['/runtime/native/reader.pl','/runtime/native/now-playing.dylib'])
 assert.equal(call.options.env.ZCODE_MUSIC_ACTION,'artwork');assert.equal(call.options.timeout,3000);assert.equal(call.options.maxBuffer,8192)
 assert.equal(call.input.toString(),'album-a');call.callback(null,output());assert.deepEqual([...(await a).pixels],[153,61,61,255])
 await settle();assert.equal(f.calls.length,2);jobs.shift().callback(null,output());await b
 for(const bad of [Buffer.alloc(0),Buffer.alloc(2*1024*1024+1),'bytes'])await assert.rejects(f.thumbnail(bad),/input/)
 assert.equal(f.calls.length,2)
})
test('malformed output, timeouts and old helpers fail without a box/nativeImage fallback; the queue recovers',async()=>{
 const results=[JSON.stringify({error:'mediaremote-unavailable'}),'null',...[{engine:'wrong'},{order:'bgra'},{width:11},{height:0},{pixels:'bad'},{pixels:'AAAA'}].map(output),'invalid JSON']
 for(const result of results){
  const f=mockRunner(call=>call.callback(null,result))
  await assert.rejects(f.thumbnail(Buffer.from('cover')),/Invalid ImageIO/)
 }
 let attempt=0
 const f=mockRunner(call=>{if(!attempt++)call.callback(Error('timeout'));else call.callback(null,output())})
 await assert.rejects(f.thumbnail(Buffer.from('cover')),/failed/);assert.equal((await f.thumbnail(Buffer.from('cover'))).order,'rgba')
 const decoder=createArtworkDecoder({createFromBuffer:()=>{throw Error('Electron must not be consulted')}},{thumbnail:async()=>{throw Error('ImageIO failed')}})
 const reader=createPaletteReader({fetchImage:async()=>Buffer.from('cover'),decode:decoder})
 reader.get('album');await settle();assert.equal(paletteForArtwork(reader.get('album')).accent,'#00F168')
})
test('album cache waits for asynchronous ImageIO work, deduplicates it and does not cross songs',async()=>{
 const a=deferred(),b=deferred();let calls=0
 const reader=createPaletteReader({fetchImage:async id=>id,decode:id=>{calls++;return id==='A'?a.promise:b.promise}})
 reader.get('A');reader.get('A');reader.get('B');await settle();assert.equal(calls,2)
 const pixels=Uint8Array.from([153,61,61,255]);a.resolve({pixels,order:'rgba'});await settle()
 assert.equal(paletteForArtwork(reader.get('A')).accent,'#F3616F');assert.equal(reader.get('B'),null)
 b.resolve({pixels:Uint8Array.from([61,153,61,255]),order:'rgba'});await settle()
 assert.notDeepEqual(reader.get('A'),reader.get('B'))
})
