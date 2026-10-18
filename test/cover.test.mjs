import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inlinePNG,coverPreviewLayout,createCoverPreview} from '../plugin/lib/cover.js'
const png='data:image/png;base64,QUFB'
test('cover images only accept bounded inline PNG data',()=>{
 assert.equal(inlinePNG(png),png)
 for(const value of [null,'https://example.com/a.png','data:image/svg+xml;base64,QUFB','data:image/png;base64,<>',png+' '.repeat(65536)])assert.equal(inlinePNG(value),'')
})
test('cover preview uses original size above the cover and fits narrow or short windows',()=>{
 const original=coverPreviewLayout({width:300,height:300,anchor:{left:250,top:600,width:20},viewport:{width:1000,height:800},origin:{left:100,top:590}})
 assert.deepEqual(original,{width:300,height:300,left:10,top:-298})
 const fit=coverPreviewLayout({width:600,height:300,anchor:{left:2,top:200,width:20},viewport:{width:240,height:300}})
 assert.equal(fit.width,224);assert.equal(fit.height,112);assert.equal(fit.left,8);assert.equal(fit.top,80)
 const nearRight=coverPreviewLayout({width:300,height:300,anchor:{left:900,top:600,width:20},viewport:{width:1000,height:800}})
 assert.equal(nearRight.left,692)
 assert.equal(coverPreviewLayout({width:300,height:300,anchor:{left:0,top:8,width:20},viewport:{width:1000,height:800}}),null)
})
function clock(){let now=0,id=0;const tasks=new Map();return{setTimer:(fn,delay)=>{tasks.set(++id,{fn,at:now+delay});return id},clearTimer:id=>tasks.delete(id),async tick(ms){now+=ms;for(const[key,task]of [...tasks])if(task.at<=now){tasks.delete(key);await task.fn()}},size:()=>tasks.size}}
test('cover preview waits two seconds and cancels when the pointer leaves',async()=>{
 const c=clock();let requested=0,shown=0
 const preview=createCoverPreview({...c,request:async()=>{requested++;return{image:png}},isCurrent:()=>true,onShow:()=>shown++,onHide:()=>{}})
 preview.schedule({album:'A'});await c.tick(1999);assert.equal(requested,0)
 await c.tick(1);assert.equal(requested,1);assert.equal(shown,1)
 preview.schedule({album:'B'});await c.tick(1000);preview.cancel();await c.tick(2000)
 assert.equal(requested,1);assert.equal(shown,1)
})
test('late preview replies after switching songs or disabling covers never show',async()=>{
 const c=clock();let finish,shown=0,album='A'
 const preview=createCoverPreview({...c,request:()=>new Promise(resolve=>{finish=resolve}),isCurrent:context=>context.album===album,onShow:()=>shown++,onHide:()=>{}})
 preview.schedule({album:'A'});const pending=c.tick(2000)
 album='B';preview.cancel();finish({image:png});await pending
 assert.equal(shown,0)
})
test('invalid preview data and request errors leave preview hidden',async()=>{
 for(const request of [async()=>({image:'https://example.com/a.png'}),async()=>{throw Error('unavailable')}]){
  const c=clock();let shown=0
  const preview=createCoverPreview({...c,request,isCurrent:()=>true,onShow:()=>shown++,onHide:()=>{}})
  preview.schedule({});await c.tick(2000);assert.equal(shown,0)
 }
})
