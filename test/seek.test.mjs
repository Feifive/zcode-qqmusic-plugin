import {test} from 'node:test'
import assert from 'node:assert/strict'
import {seekRatio,createSeekInteraction} from '../plugin/lib/seek.js'
const track=()=>({app:'com.tencent.QQMusicMac',title:'A',artist:'artist',durationMs:100000,positionMs:20000})
function fixture(send=async()=>({ok:true})){
 const context={available:true,track:track()},calls=[],events=[]
 const seek=createSeekInteraction({getContext:()=>context,send:position=>{calls.push(position);return send(position)},onSettled:async()=>{events.push('refresh')},onFailure:()=>events.push('failure')})
 return{context,calls,events,seek}
}
test('seek ratios clamp both ends and reject unusable geometry',()=>{
 assert.equal(seekRatio(-100,{left:10,width:100}),0);assert.equal(seekRatio(60,{left:10,width:100}),.5);assert.equal(seekRatio(200,{left:10,width:100}),1)
 for(const rect of [{left:0,width:0},{left:NaN,width:10},{left:0,width:Infinity}])assert.equal(seekRatio(5,rect),null)
})
test('dragging previews independently of live samples and submits once on release',async()=>{
 let complete;const f=fixture(()=>new Promise(resolve=>{complete=resolve}))
 assert.equal(f.seek.begin(.2),true);f.seek.move(.8);f.context.track.positionMs=30000
 assert.equal(f.seek.preview(),80000);assert.equal(f.calls.length,0)
 const done=f.seek.finish(.75)
 assert.equal(f.seek.busy,true);assert.equal(f.seek.preview(),75000);assert.deepEqual(f.calls,[75000])
 assert.equal(f.seek.begin(.1),false);await f.seek.finish(.9);assert.equal(f.calls.length,1)
 complete({ok:true});await done
 assert.equal(f.seek.busy,false);assert.equal(f.seek.preview(),null);assert.deepEqual(f.events,['refresh'])
})
test('cancel, song changes, disabled state and unknown duration never submit a gesture',async()=>{
 const f=fixture();f.seek.begin(.6);f.seek.cancel();await f.seek.finish(.6)
 f.seek.begin(.6);f.context.track.title='B';await f.seek.finish(.6)
 f.seek.begin(.6);f.context.available=false;await f.seek.finish(.6)
 assert.equal(f.calls.length,0);assert.equal(f.seek.enabled,false)
 f.context.available=true;f.context.track.durationMs=0;assert.equal(f.seek.begin(.6),false)
})
test('failures and exceptions refresh playback before displaying the failure',async()=>{
 for(const send of [async()=>({ok:false}),async()=>{throw Error('IPC failed')}]){
  const f=fixture(send);f.seek.begin(.4);await f.seek.finish(.4)
  assert.deepEqual(f.events,['refresh','failure']);assert.equal(f.seek.busy,false);assert.equal(f.seek.preview(),null)
 }
})
test('keyboard positioning clamps to track bounds and stale pending previews do not cross songs',async()=>{
 const f=fixture();await f.seek.keyboard(-5000);await f.seek.keyboard(150000)
 assert.deepEqual(f.calls,[0,100000])
 let complete;const pending=fixture(()=>new Promise(resolve=>{complete=resolve}))
 const done=pending.seek.keyboard(50000);pending.context.track.title='B'
 assert.equal(pending.seek.preview(),null);assert.equal(pending.seek.enabled,false)
 complete({ok:true});await done;assert.equal(pending.seek.enabled,true)
})
test('seek sends the captured track identity with its target, not a later context',async()=>{
 const t=track(),calls=[]
 const seek=createSeekInteraction({getContext:()=>({available:true,track:t}),send:async(...args)=>{calls.push(args);return{ok:true}},onSettled:async()=>{},onFailure:()=>{}})
 await seek.keyboard(12345)
 assert.deepEqual(JSON.parse(calls[0][1]),[t.app,null,t.title,t.artist,null,t.durationMs]);assert.equal(calls[0][0],12345)
})
