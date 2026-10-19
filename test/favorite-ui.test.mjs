import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFavoriteState } from '../plugin/lib/favorite-ui.js'
const snapshot = (songmid = 'a') => ({ enabled: true, state: 'playing', track: { songmid, title: songmid, artist: 'artist', favoriteEligible: true } })
const state = (songmid = 'a', liked = false) => ({ songmid, status: 'ready', liked, revision: 'account-revision' })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))

test('heart reads state, optimistically toggles immediately, blocks double click and rolls back errors', async () => {
  const wait = deferred(), calls = [], notices = []
  const ui = createFavoriteState({ request: payload => { calls.push(payload); return payload.action === 'status' ? Promise.resolve(state()) : wait.promise }, onNotice: text => notices.push(text) })
  ui.sync(snapshot()); await flush(); assert.equal(ui.view().liked, false)
  const write = ui.click(); assert.equal(ui.view().liked, true); assert.equal(ui.view().disabled, true)
  await ui.click(); assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], { action: 'set', songmid: 'a', liked: true, revision: 'account-revision' })
  wait.reject(Error('保存失败')); await write
  assert.equal(ui.view().liked, false); assert.equal(ui.view().status, 'error'); assert.deepEqual(notices, ['保存失败'])
  await ui.click(); assert.equal(calls.at(-1).action, 'status'); assert.equal(calls.at(-1).force, true)
})

test('old song writes and out-of-order reads cannot repaint a new song or override an optimistic click', async () => {
  let time = 0; const read = deferred(), write = deferred(); let reads = 0
  const ui = createFavoriteState({ now: () => time, request: p => p.action === 'set' ? write.promise
    : p.songmid === 'b' ? Promise.resolve(state('b', true)) : ++reads === 1 ? Promise.resolve(state()) : read.promise })
  ui.sync(snapshot()); await flush(); time = 6000; ui.sync(snapshot()); const save = ui.click()
  read.resolve(state()); await flush(); assert.equal(ui.view().liked, true)
  ui.sync(snapshot('b')); await flush(); write.reject(Error('old song failed')); await save
  assert.equal(ui.view().songmid, 'b'); assert.equal(ui.view().liked, true); assert.equal(ui.view().status, 'ready')
})

test('demo/unmatched tracks never request favorites and logged-out heart opens login without writing', async () => {
  const calls = [], notices = []
  const ui = createFavoriteState({ request: async payload => { calls.push(payload); return { songmid: payload.songmid, status: 'logged-out', liked: null } }, onNotice: text => notices.push(text) })
  ui.sync(snapshot(), true); await ui.click(); assert.equal(calls.length, 0); assert.equal(ui.view().disabled, true)
  ui.sync({ ...snapshot(), track: { songmid: 'a' } }); await ui.click(); assert.equal(calls.length, 0)
  ui.sync(snapshot()); await flush(); await ui.click(); assert.equal(calls.length, 1); assert.equal(notices.length, 1)
  ui.invalidate(); ui.sync(snapshot()); await flush(); assert.equal(calls.length, 2)
})

test('dispose ignores late results; status refresh does not hammer backend on every snapshot', async () => {
  const wait = deferred(), calls = []
  const ui = createFavoriteState({ request: p => { calls.push(p); return wait.promise } })
  for (let i = 0; i < 100; i++) ui.sync(snapshot())
  assert.equal(calls.length, 1); ui.dispose(); wait.resolve(state()); await flush()
  assert.equal(ui.view().liked, null)
})
