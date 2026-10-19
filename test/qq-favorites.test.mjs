import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQQFavorites } from '../plugin/lib/qq-favorites.js'
import { createQQSession } from '../plugin/lib/qq-session.js'
import { hash33 } from '../plugin/lib/qq-gateway.js'

const session = { account: { uin: '1152921504606846999', loginType: 'qq' }, cookies: { qm_keyst: 'test-key', encrypt_uin: 'enc-account' } }
const track = { songmid: 'song-mid', songid: 123, songtype: 0, favoriteEligible: true }
const response = (data, code = 0) => ({ status: 200, text: JSON.stringify({ code: 0, req_0: { code, data } }) })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(handler = () => response({ songlist: [] })) {
  const calls = []; let time = 1000
  const gateway = { async request(url, options) { const body = JSON.parse(options.body); calls.push({ url, ...options, ...body }); return handler(body, calls.length, options) } }
  return { service: createQQFavorites({ gateway, now: () => time }), calls, advance: ms => { time += ms } }
}

test('favorites paginate beyond 300 and send string account IDs, encrypted owner and both GTK fields', async () => {
  const page = Array.from({ length: 300 }, (_, i) => ({ mid: `mid${i}`, id: i + 1000 }))
  const { service, calls } = fixture((body, n) => response({ total_song_num: 301, nested: { songlist: n === 1 ? page : [{ mid: track.songmid, id: track.songid }] } }))
  assert.equal((await service.status(session, track)).liked, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(c => c.req_0.param.song_begin), [0, 300])
  const read = calls[0]
  assert.equal(read.req_0.module, 'music.srfDissInfo.DissInfo')
  assert.equal(read.req_0.param.dirid, 201); assert.equal(read.req_0.param.enc_host_uin, 'enc-account')
  assert.equal(read.comm.uid, session.account.uin); assert.equal(read.comm.loginUin, session.account.uin)
  assert.equal(read.comm.g_tk, hash33(session.cookies.qm_keyst, 5381)); assert.equal(read.comm.g_tk_new_20200303, read.comm.g_tk)
  assert.match(read.headers.Cookie, /qm_keyst=test-key/)
  assert.equal(JSON.stringify(await service.status(session, track)).includes('test-key'), false)
})

test('server page caps, large numeric IDs and nested songInfo do not hide existing likes', async () => {
  const big = '1152921504606846999'
  const { service, calls } = fixture((body, n) => n === 1 ? response({ total_song_num: 2, songs: [{ mid: 'first', id: 9 }] })
    : { status: 200, text: `{"code":0,"req_0":{"code":0,"data":{"total_song_num":2,"songInfoList":[{"songInfo":{"id":${big}}}]}}}` })
  assert.equal((await service.status(session, { ...track, songmid: 'unmatched', songid: big })).liked, true)
  assert.deepEqual(calls.map(c => c.req_0.param.song_begin), [0, 1])
})

test('malformed, incomplete and repeated pages never become a false unliked state', async () => {
  for (const data of [{}, { songs: [{}] }, { total_song_num: 3, songs: [] }]) {
    const { service } = fixture(() => response(data))
    assert.equal((await service.status(session, track)).status, 'error')
  }
  const { service, calls } = fixture(() => response({ total_song_num: 1000, songs: [{ mid: 'same', id: 1 }] }))
  assert.equal((await service.status(session, track)).status, 'error'); assert.equal(calls.length, 2)
})

test('QQ may fall back to a plaintext owner; WeChat requires encrypted owner', async () => {
  const qq = { ...session, cookies: { qm_keyst: 'key' } }
  const { service, calls } = fixture()
  assert.equal((await service.status(qq, track)).status, 'ready')
  assert.equal(calls[0].req_0.param.enc_host_uin, session.account.uin)
  const wx = { ...qq, account: { ...qq.account, loginType: 'wx' }, cookies: { qm_keyst: 'W_X_key' } }
  assert.equal((await service.status(wx, track)).status, 'error'); assert.equal(calls.length, 1)
  wx.cookies.encrypt_uin = 'encrypted'
  service.reset(); assert.equal((await service.status(wx, track)).status, 'ready'); assert.equal(calls[1].comm.tmeLoginType, '1')
})

test('successful add/delete use official playlist fields and update the cached collection', async () => {
  const { service, calls } = fixture(body => response(body.req_0.method === 'CgiGetDiss' ? { songs: [] } : { retCode: 0 }))
  assert.equal((await service.set(session, track, true)).liked, true)
  assert.equal((await service.status(session, track)).liked, true)
  assert.equal((await service.set(session, track, true)).liked, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].req_0.module, 'music.musicasset.PlaylistDetailWrite')
  assert.equal(calls[1].req_0.method, 'AddSonglist')
  assert.deepEqual(calls[1].req_0.param, { dirId: 201, tid: 0, bFmtUtf8: true, v_songInfo: [{ songId: 123, songType: 0 }] })
  assert.equal((await service.set(session, track, false)).liked, false)
  assert.equal(calls[2].req_0.method, 'DelSonglist')
})

test('a timed out or rejected write is sent once and never changes cached likes optimistically', async () => {
  for (const failure of [() => { throw Error('network secret-key') }, () => response({ retCode: 10006 }), () => response({}, 500003)]) {
    const { service, calls } = fixture(body => body.req_0.method === 'CgiGetDiss' ? response({ songs: [] }) : failure())
    await assert.rejects(service.set(session, track, true), /收藏操作未能确认/)
    assert.equal(calls.length, 2)
    assert.equal((await service.status(session, track)).liked, false)
  }
})

test('status coalesces reads, expires after ten minutes, backs off failures and allows forced retry', async () => {
  const wait = deferred(), f = fixture(() => wait.promise)
  const a = f.service.status(session, track), b = f.service.status(session, track)
  assert.equal(f.calls.length, 1); wait.resolve(response({ songs: [] })); await Promise.all([a,b])
  await f.service.status(session, track); assert.equal(f.calls.length, 1)
  f.advance(600001); await f.service.status(session, track); assert.equal(f.calls.length, 2)
  const bad = fixture(() => { throw Error('no') })
  assert.equal((await bad.service.status(session, track)).status, 'error'); assert.equal(bad.calls.length, 3)
  await bad.service.status(session, track); assert.equal(bad.calls.length, 3)
  await bad.service.status(session, track, true); assert.equal(bad.calls.length, 6)
})

test('logout aborts an in-flight read without sending old account cookies to fallback hosts', async () => {
  const wait = deferred(), f = fixture((body,n,options) => n === 1 ? wait.promise : response({ songs: [] }))
  const old = f.service.status(session, track)
  f.service.reset(); assert.equal(f.calls[0].signal.aborted, true)
  await f.service.status({ ...session, cookies: { ...session.cookies, qm_keyst: 'new-key' } }, track)
  wait.reject(Error('aborted'))
  await assert.rejects(old, /账号已变化/)
  assert.equal(f.calls.length, 2); assert.match(f.calls[1].headers.Cookie, /new-key/)
})

test('slow refresh cannot undo a successful write; concurrent writes are rejected', async () => {
  const wait = deferred(), f = fixture((body,n) => n === 2 ? wait.promise : response(body.req_0.method === 'CgiGetDiss' ? { songs: [] } : {}))
  await f.service.status(session, track)
  const refresh = f.service.status(session, track, true)
  assert.equal((await f.service.set(session, track, true)).liked, true)
  wait.resolve(response({ songs: [] })); assert.equal((await refresh).liked, true)
  const block = deferred(), other = fixture(body => body.req_0.method === 'CgiGetDiss' ? response({ songs: [] }) : block.promise)
  const write = other.service.set(session, track, true)
  await assert.rejects(other.service.set(session, track, true), /正在保存/)
  block.resolve(response({})); await write
})

test('session gates login, accurate matches and account revision without exposing credentials', async () => {
  let saved = session, sets = 0, resets = 0
  const favorites = { status: async () => ({ songmid: track.songmid, status: 'ready', liked: false }),
    set: async () => { sets++; return { songmid: track.songmid, status: 'ready', liked: true } }, reset() { resets++ } }
  const account = createQQSession({ storage: { load: () => saved, clear() { saved = null } }, favorites })
  const state = await account.favorite({ action: 'status' }, track)
  assert.equal(state.status, 'ready'); assert.equal(JSON.stringify(state).includes('test-key'), false)
  await assert.rejects(account.favorite({ action: 'set', liked: true, revision: 'stale' }, track), /账号已变化/)
  assert.equal((await account.favorite({ action: 'set', liked: true, revision: state.revision }, track)).liked, true)
  assert.equal(sets, 1)
  assert.equal((await account.favorite({ action: 'status' }, { ...track, favoriteEligible: false })).status, 'unavailable')
  await account.handle({ action: 'logout' }); assert.equal(resets, 1)
  assert.equal((await account.favorite({ action: 'set', liked: true, revision: state.revision }, track)).status, 'logged-out')
})
