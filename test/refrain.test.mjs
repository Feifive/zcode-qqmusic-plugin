import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parseRefrainResponse,selectRefrainPoint,refrainPosition,fetchRefrain,createRefrainReader} from '../plugin/lib/refrain.js'
import {createPlaybackReporter} from '../plugin/lib/playback.js'
const mid='0039MnYb0qxYhV',fixture=JSON.parse(readFileSync(new URL('./fixtures/refrain-qingtian.json',import.meta.url),'utf8'))
const segment=(confidence,startMs,endMs=startMs+10000)=>({confidence,startMs,endMs})
const response=data=>({code:0,req:{code:0,data:{refrain:{[mid]:JSON.stringify(data)}}}})
const settle=()=>new Promise(resolve=>setImmediate(resolve))

test('refrain response decodes the nested JSON and retains millisecond timing',()=>{
 const points=parseRefrainResponse(fixture,mid)
 assert.deepEqual(points,[segment(1,84916,154907),segment(1,182925,238498),segment(1,238498,266173)])
 assert.equal(selectRefrainPoint(points,269000).startMs,84916)
})
test('low confidence, malformed responses and invalid intervals never produce points',()=>{
 for(const data of [{cfd_funclevel:.499,chorus_seg_times:'100,200'},{cfd_funclevel:2,chorus_seg_times:'100,200'},{cfd_funclevel:1,chorus_seg_times:'NaN,200|-1,2|,2|200,100|1,Infinity|0,86400001'}])assert.deepEqual(parseRefrainResponse(response(data),mid),[])
 assert.deepEqual(parseRefrainResponse(response({cfd_funclevel:.5,chorus_seg_times:'100.5,200|bad|300,400'}),mid),[segment(.5,100.5,200),segment(.5,300,400)])
 for(const body of [null,{...fixture,code:1},{code:0,req:{code:1}},response(null),{code:0,req:{code:0,data:{refrain:{[mid]:'not JSON'}}}}])assert.deepEqual(parseRefrainResponse(body,mid),[])
 assert.deepEqual(parseRefrainResponse(fixture,'anotherSong'),[])
})
test('only the highest-confidence point is selected, with the earliest start breaking ties',()=>{
 const points=[segment(.8,10000),segment(.9,70000),segment(.9,30000),segment(.4,0)]
 assert.deepEqual(selectRefrainPoint(points,100000),segment(.9,30000))
 assert.equal(selectRefrainPoint([segment(1,100000),segment(.8,10000)],100000).startMs,10000)
 for(const duration of [0,-1,NaN,Infinity])assert.equal(selectRefrainPoint(points,duration),null)
 assert.equal(selectRefrainPoint([],100000),null)
})
test('marker positions require the matching song, valid confidence and a known duration',()=>{
 const point={songmid:mid,...segment(1,25000)}
 assert.equal(refrainPosition(point,mid,100000),.25)
 assert.equal(refrainPosition(point,'anotherSong',100000),null)
 assert.equal(refrainPosition({...point,confidence:.4},mid,100000),null)
 assert.equal(refrainPosition(point,mid,0),null)
 assert.equal(refrainPosition(point,mid,20000),null)
})
test('refrain requests use the documented POST contract and handle failure without fake markers',async()=>{
 let request
 const points=await fetchRefrain(mid,{fetcher:async(url,options)=>{request={url,options};return{ok:true,text:async()=>JSON.stringify(fixture)}}})
 assert.equal(request.url,'https://u.y.qq.com/cgi-bin/musicu.fcg');assert.equal(request.options.method,'POST');assert.equal(request.options.redirect,'error')
 assert.deepEqual(JSON.parse(request.options.body),{comm:{ct:19,cv:1873},req:{module:'music.mir.MirInfo',method:'GetRefrain',param:{songMidList:[mid]}}})
 assert.equal(points.length,3)
 await assert.rejects(fetchRefrain('../invalid',{fetcher:()=>{throw Error('must not fetch')}}),/identity/)
 await assert.rejects(fetchRefrain(mid,{fetcher:async()=>({ok:false})}),/unavailable/)
 await assert.rejects(fetchRefrain(mid,{fetcher:async()=>({ok:true,text:async()=>' '.repeat(131073)})}),/large/)
})
test('background requests deduplicate per song, isolate late replies and retry failures',async()=>{
 const jobs=new Map();let requests=0,time=0
 const reader=createRefrainReader({now:()=>time,fetchInfo:id=>{requests++;return new Promise((resolve,reject)=>jobs.set(id,{resolve,reject}))}})
 assert.equal(reader.get('A'),null);assert.equal(reader.get('A'),null);assert.equal(reader.get('B'),null);await settle();assert.equal(requests,2)
 jobs.get('A').resolve([segment(1,10000)]);await settle()
 assert.equal(reader.get('A')[0].startMs,10000);assert.equal(reader.get('B'),null)
 jobs.get('B').reject(Error('offline'));await settle();assert.deepEqual(reader.get('B'),[])
 time=300001;reader.get('B');await settle();assert.equal(requests,3)
 jobs.get('B').resolve([segment(.9,20000)]);await settle()
 assert.equal(reader.get('B')[0].startMs,20000);assert.equal(reader.get('A')[0].startMs,10000)
 assert.equal(reader.get('../invalid'),null)
 time=6*60*60_000+1;assert.equal(reader.get('A'),null);await settle();assert.equal(requests,4)
 jobs.get('A').resolve([]);await settle()
})
test('pending refrain requests do not block lyrics, and late replies cannot mark another song',async()=>{
 const before=globalThis.fetch,jobs=new Map()
 globalThis.fetch=async url=>{
  const u=new URL(url)
  if(u.pathname.includes('search_')){const title=u.searchParams.get('w').startsWith('A')?'A':'B';return{ok:true,text:async()=>JSON.stringify({data:{song:{list:[{songmid:title,songname:title,singer:[{name:'fixture'}],interval:100}]}}})}}
  return{ok:true,text:async()=>JSON.stringify({lyric:'[00:00.00]歌词'})}
 }
 try{
  const reader=createRefrainReader({fetchInfo:id=>new Promise(resolve=>jobs.set(id,resolve))})
  const reporter=createPlaybackReporter({options:{apps:['qqmusic']},refrainReader:reader})
  const sample=title=>({at:Date.now(),sessions:[{app:'com.tencent.QQMusicMac',title,artist:'fixture',status:'paused',position:0,duration:100000}]})
  const timeout=Symbol('blocked'),first=await Promise.race([reporter.report(sample('A')),new Promise(resolve=>setImmediate(()=>resolve(timeout)))])
  assert.notEqual(first,timeout);assert.ok(first.lyric.lines.length);assert.equal(first.refrain,null)
  const second=await reporter.report(sample('B'));assert.equal(second.refrain,null)
  jobs.get('A')([segment(1,10000)]);await settle();assert.equal((await reporter.report(sample('B'))).refrain,null)
  jobs.get('B')([segment(.9,30000),segment(.9,20000),segment(.7,5000)]);await settle()
  assert.deepEqual((await reporter.report(sample('B'))).refrain,{songmid:'B',...segment(.9,20000)})
 }finally{globalThis.fetch=before}
})
test('refrain information remains available when the lyric service has no lyrics',async()=>{
 const before=globalThis.fetch
 globalThis.fetch=async url=>({ok:true,text:async()=>new URL(url).pathname.includes('search_')?JSON.stringify({data:{song:{list:[{songmid:'A',songname:'A',singer:[{name:'fixture'}]}]}}}):JSON.stringify({lyric:''})})
 try{
  const reporter=createPlaybackReporter({options:{apps:['qqmusic']},refrainReader:{get:()=>[segment(1,25000)]}})
  const result=await reporter.report({at:Date.now(),sessions:[{app:'com.tencent.QQMusicMac',title:'A',artist:'fixture',status:'paused',duration:100000}]})
  assert.equal(result.state,'no-lyric');assert.equal(result.refrain.startMs,25000)
 }finally{globalThis.fetch=before}
})
