import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPlaybackReporter} from '../plugin/lib/playback.js'
import {createPaletteReader} from '../plugin/lib/artwork.js'
import {createRefrainReader} from '../plugin/lib/refrain.js'

test('music cache counters report entries in each reader without fetching more data',async()=>{
 let fetched=0
 const refrain=createRefrainReader({fetchInfo:async()=>{fetched++;return[]}})
 const reporter=createPlaybackReporter({options:{apps:['qqmusic']},refrainReader:refrain,
   resolveIdentity:async()=>({songmid:'song1',albumMid:'album1',songid:1,lyric:{kind:'lrc',offset:0,lines:[{start:0,text:'歌词',duration:1000,words:[]}]}})})
 const sample={at:Date.now(),sessions:[{app:'com.tencent.QQMusicMac',title:'歌曲',artist:'歌手',album:'专辑',status:'playing',position:100,duration:1000}]}
 await reporter.report(sample)
 const before=fetched
 assert.deepEqual(reporter.cacheStats(),{songs:1,lyrics:1,refrains:1,localSongs:0})
 assert.equal(fetched,before,'status must not fetch additional data')
 const artwork=createPaletteReader({fetchImage:async()=>new Uint8Array(),decode:async()=>({pixels:new Uint8Array(400),order:'rgba'})})
 assert.equal(artwork.cacheSize(),0)
 artwork.get('album1')
 assert.equal(artwork.cacheSize(),1)
})
