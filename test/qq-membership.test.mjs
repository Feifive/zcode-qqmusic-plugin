import { test } from 'node:test'
import assert from 'node:assert/strict'
import { membershipEntitlements, membershipFields, membershipSnapshotFields } from '../plugin/lib/qq-membership.js'
import { createQQProfile } from '../plugin/lib/qq-profile.js'
import { createQQGateway } from '../plugin/lib/qq-gateway.js'
import { createQQSession } from '../plugin/lib/qq-session.js'
import { membershipText } from '../plugin/lib/qq-account-ui.js'

const at = Date.parse('2026-10-19T12:00:00+08:00')
const data = () => ({ identity: { vip: 2, HugeVip: -1, level: 3, nextlevel: 4, yearflag: 2, eight: 1, twelve: 1,
  overdate: '2099-01-01', HugeVipEnd: '2026-10-20 12:00:00', eightEnd: '2026-11-01', twelveEnd: '2099-02-01' }, send: '2099-01-01' })
const account = () => ({ uin: '1152921504606846999', nickname: '会员', loginType: 'wx', loggedInAt: at,
  ...membershipSnapshotFields(data(), 'login', at) })

test('revised product matrix and the reported annual VIP3 account render correct modern names', async () => {
  const cases = [
    [{ vip: 0, HugeVip: 0, level: 3 }, ''],
    [{ vip: 1, HugeVip: 0, level: 3 }, '豪华绿钻 VIP3'],
    [{ vip: 1, HugeVip: 1, level: 3 }, '超级会员 SVIP3'],
  ]
  for (const [identity, expected] of cases) assert.equal(membershipText(membershipFields({ identity }, at)), expected)
  const fields = membershipSnapshotFields({ svip: 1, identity: { vip: 1, HugeVip: 0, level: 3, nextlevel: 4,
    yearflag: 1, eight: 1, twelve: 0, overdate: '2099-01-01', eightEnd: '2099-01-01' } }, 'login', at)
  const rights = membershipEntitlements(fields.membershipSnapshot, at)
  assert.equal(rights.luxuryVip, true); assert.equal(rights.superVip, false)
  assert.equal(rights.annual, true); assert.equal(rights.eightYuanPack, true)
  // 0.3.13 saved the raw identity correctly, so reclassify it locally instead
  // of discarding the login or issuing another membership request.
  const stored = { cookies: { qm_keyst: 'secret' }, account: { uin: '123456789', loginType: 'qq', nickname: '测试',
    ...fields, membershipVersion: 3, membership: { kind: 'vip', label: '绿钻会员', level: 3 } } }
  const app = createQQSession({ now: () => at, storage: { load: () => stored } })
  assert.equal(membershipText((await app.handle({ action: 'status' })).account.membership), '豪华绿钻 VIP3')
  assert.equal(stored.cookies.qm_keyst, 'secret')
})

test('VIP flags use nonzero semantics while each pay package requires exactly one', () => {
  const rights = membershipEntitlements(data(), at)
  for (const field of ['greenVip', 'luxuryVip', 'superVip', 'annual', 'eightYuanPack', 'twelveYuanPack']) assert.equal(rights[field], true)
  assert.equal(rights.nextLevel, 4)
  assert.equal(membershipText(membershipFields(data(), at)), '超级会员 SVIP3')
  const unusual = membershipEntitlements({ identity: { vip: '2', HugeVip: '-1', eight: 2, twelve: -1 } }, at)
  assert.equal(unusual.greenVip, true); assert.equal(unusual.luxuryVip, true); assert.equal(unusual.superVip, true)
  assert.equal(unusual.eightYuanPack, false); assert.equal(unusual.twelveYuanPack, false)
  for (const value of ['', 'broken', null, [], {}, NaN, Infinity]) {
    assert.equal(membershipFields({ identity: { vip: value, HugeVip: value, eight: value, twelve: value } }, at), undefined)
  }
  assert.equal(membershipFields({ identity: { eight: 1, twelve: 0 } }, at).kind, 'member')
})

test('parallel rights and exact raw expirations are preserved without retaining login credentials', () => {
  const fields = membershipSnapshotFields({ ...data(), musickey: 'secret', refresh_key: 'private',
    identity: { ...data().identity, token: 'private' }, userinfo: { cookie: 'private' } }, 'login', at)
  assert.deepEqual(fields.membershipSnapshot.identity, data().identity)
  assert.equal(fields.membershipSnapshot.send, data().send)
  assert.equal(fields.membershipSnapshot.source, 'login')
  assert.doesNotMatch(JSON.stringify(fields), /secret|private|token|userinfo/)
  assert.equal(membershipFields({ identity: { level: 3 }, send: '2099-01-01' }, at), undefined)
})

test('known expiry dates downgrade only the expired entitlement, using China-local dates', () => {
  const before = membershipFields(data(), at)
  assert.equal(before.kind, 'svip')
  const after = membershipEntitlements(data(), Date.parse('2026-10-20T12:00:00+08:00'))
  assert.equal(after.superVip, false); assert.equal(after.luxuryVip, true); assert.equal(after.greenVip, true); assert.equal(after.eightYuanPack, true)
  assert.equal(membershipFields(data(), Date.parse('2026-10-20T12:00:01+08:00')).kind, 'luxury')
  assert.equal(membershipFields({ identity: { vip: 1, overdate: '2026-10-19' } }, Date.parse('2026-10-19T23:59:58+08:00')).kind, 'luxury')
  assert.equal(membershipFields({ identity: { vip: 1, overdate: '2026-10-19' } }, Date.parse('2026-10-20T00:00:00+08:00')), null)
  assert.equal(membershipFields({ identity: { vip: 1, overdate: 'unknown format' } }, at).kind, 'luxury')
})

test('profile refresh does not query VIP or overwrite membership when login already supplied identity', async () => {
  const session = { account: account(), cookies: { qm_keyst: 'secret' } }, calls = []
  const gateway = createQQGateway({ fetchImpl: async url => {
    const host = new URL(url).hostname; calls.push(host)
    assert.equal(host, 'c.y.qq.com', 'must not probe VIP for a login snapshot')
    return Response.json({ code: 0, data: { creator: { nick: '音乐昵称' } } })
  } })
  const fields = await createQQProfile({ gateway, now: () => at }).read(session)
  assert.equal(fields.nickname, '音乐昵称'); assert.equal(fields.membershipSnapshot, undefined)
  assert.equal(calls.length, 1); assert.equal(session.account.membership.kind, 'svip')
})

test('identity survives encrypted-session storage boundaries and is interpreted locally after restoration', async () => {
  let stored = null, time = at
  const storage = { load: () => stored, save: state => { stored = JSON.parse(JSON.stringify(state)); return true }, clear: () => { stored = null } }
  const auth = { create: async () => ({ type: 'qq', expiresAt: at + 120000 }),
    check: async () => ({ status: 'success', session: { cookies: { qm_keyst: 'secret' }, account: account() } }) }
  const app = createQQSession({ storage, auth, now: () => time, id: () => 'login' })
  await app.handle({ action: 'start', type: 'qq' })
  const loggedIn = await app.handle({ action: 'poll', id: 'login' })
  assert.equal(loggedIn.account.membership.kind, 'svip'); assert.equal(loggedIn.account.entitlements.annual, true)
  assert.equal(loggedIn.account.entitlements.eightYuanPack, true)
  assert.doesNotMatch(JSON.stringify(loggedIn), /secret|membershipSnapshot/)
  time += 7 * 3600000
  const restored = createQQSession({ storage, now: () => time })
  assert.equal((await restored.handle({ action: 'status' })).account.membership.kind, 'svip', 'must not discard a login snapshot after six hours')
  time = Date.parse('2026-10-20T12:00:01+08:00')
  assert.equal((await restored.handle({ action: 'status' })).account.membership.kind, 'luxury')
  assert.equal(stored.account.membershipSnapshot.identity.HugeVip, -1, 'raw flags stay intact when derived rights expire')
})

test('legacy sessions supplement missing identity once and skip VIP on later profile refreshes', async () => {
  const old = { uin: '1152921504606846999', nickname: '旧账号', loginType: 'wx' }
  let stored = { account: old, cookies: { qm_keyst: 'secret' } }, probes = 0, time = at
  const gateway = createQQGateway({ fetchImpl: async url => {
    if (new URL(url).hostname === 'u.y.qq.com') { probes++; return Response.json({ code: 0, req: { code: 0, data: data() } }) }
    return Response.json({ code: 0, data: { creator: { nick: '新昵称' } } })
  } })
  const app = createQQSession({ now: () => time, storage: { load: () => stored, save: state => { stored = state; return true } },
    profile: createQQProfile({ gateway, now: () => time }) })
  const state = await app.handle({ action: 'profile' })
  assert.equal(state.account.membership.kind, 'svip'); assert.equal(probes, 1)
  assert.equal(stored.account.membershipSnapshot.source, 'fallback')
  time += 7 * 3600000
  await app.handle({ action: 'profile' }); assert.equal(probes, 1)
})
