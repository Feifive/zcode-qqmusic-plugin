import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarURL, profileFields, membershipFields, createQQProfile } from '../plugin/lib/qq-profile.js'
import { createQQGateway } from '../plugin/lib/qq-gateway.js'
import { createQQSession } from '../plugin/lib/qq-session.js'
import { membershipSnapshotFields } from '../plugin/lib/qq-membership.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBJoAAAAASUVORK5CYII=', 'base64')
const saved = () => ({ cookies: { qm_keyst: 'secret-music-key', encrypt_uin: 'private-enc' },
  account: { uin: '1152921504606846999', nickname: '登录昵称', loginType: 'wx', loggedInAt: 10 } })
const vipResponse = data => Response.json({ code: 0, req: { code: 0, data } })

test('music profile prefers the account creator, decodes names and ignores playlist authors', () => {
  const fields = profileFields({ creator: { nick: '音乐 &amp; 朋友&#x1f3b5;', headpic: 'http://y.gtimg.cn/music/avatar.jpg' },
    nickname: 'QQ nickname', cdlist: [{ nickname: 'Another person', avatar: 'https://q.qlogo.cn/other' }] })
  assert.equal(fields.nickname, '音乐 & 朋友🎵'); assert.equal(fields.avatarUrl, 'https://y.gtimg.cn/music/avatar.jpg')
  assert.equal(profileFields({ profile: { nickName: '微信音乐', avatarUrl: '//thirdwx.qlogo.cn/mmopen/test' } }).avatarUrl, 'https://thirdwx.qlogo.cn/mmopen/test')
  assert.equal(profileFields({ cdlist: [{ nickname: 'Another person' }] }).nickname, '')
  for (const url of ['https://qlogo.cn.evil.example/a', 'file:///tmp/a', 'data:image/svg+xml,test', 'https://user:pass@q.qlogo.cn/a', 'https://q.qlogo.cn:444/a']) assert.equal(avatarURL(url), '')
})

test('current vip identifies luxury Green Diamond and HugeVip identifies Super VIP, independently of legacy svip', () => {
  assert.deepEqual(membershipFields({ identity: { vip: 1, level: 3 } }), { kind: 'luxury', label: '豪华绿钻', level: 3 })
  assert.deepEqual(membershipFields({ identity: { vip: 1, HugeVip: '1', level: 8 }, userinfo: { music_level: 0, expire: -1 } }), { kind: 'svip', label: '超级会员', level: 8 })
  for (const svip of [true, 1, '1', 0, undefined]) {
    assert.deepEqual(membershipFields({ svip, identity: { vip: 1, HugeVip: 1, level: 3 } }), { kind: 'svip', label: '超级会员', level: 3 })
  }
  assert.deepEqual(membershipFields({ svip: 1, identity: { level: 3 } }), { kind: 'member', label: '音乐会员', level: 3 })
  assert.equal(membershipFields({ identity: { vip: 1, svip: 1, level: 3 } }).kind, 'luxury')
  assert.equal(membershipFields({ identity: { vip: 0, HugeVip: 0 } }), null)
  for (const data of [undefined, {}, { code: 500003 }, { userinfo: { music_level: 8 } }, { identity: {} }]) assert.equal(membershipFields(data), undefined)
  assert.equal(membershipFields({ identity: { vip: 1, level: -3 } }).level, null)
})

test('profile fetch preserves long IDs and embeds bounded avatars without sending cookies to the CDN', async () => {
  const calls = []
  const gateway = createQQGateway({ fetchImpl: async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options })
    if (parsed.hostname === 'u.y.qq.com') return vipResponse({ identity: { vip: 1, HugeVip: 0, level: 8 } })
    if (parsed.hostname === 'c.y.qq.com') return Response.json({ code: 0, data: { creator: { nick: 'QQ 音乐昵称', headpic: 'https://y.gtimg.cn/profile.png' } } })
    return new Response(png)
  } })
  const fields = await createQQProfile({ gateway, now: () => 123 }).read(saved())
  assert.equal(fields.nickname, 'QQ 音乐昵称'); assert.match(fields.avatarDataUrl, /^data:image\/png;base64,/)
  assert.equal(fields.membership.label, '豪华绿钻'); assert.equal(fields.membershipFetchedAt, 123)
  const homepage = calls.find(call => call.url.hostname === 'c.y.qq.com')
  assert.equal(homepage.url.searchParams.get('userid'), saved().account.uin)
  const vip = JSON.parse(calls.find(call => call.url.hostname === 'u.y.qq.com').options.body)
  assert.equal(vip.comm.uin, saved().account.uin); assert.equal(vip.comm.authst, 'secret-music-key')
  assert.equal(vip.req.module, 'VipLogin.VipLoginInter')
  assert.equal(calls.find(call => call.url.hostname === 'y.gtimg.cn').options.headers.Cookie, undefined)
})

test('failed membership reads preserve the valid music profile; WeChat IDs never use QQ avatar fallback', async () => {
  const calls = []
  const gateway = createQQGateway({ fetchImpl: async url => {
    const parsed = new URL(url); calls.push(parsed.hostname)
    return parsed.hostname === 'c.y.qq.com'
      ? Response.json({ code: 0, data: { creator: { nick: '音乐用户' } } })
      : Response.json({ code: 0, req: { code: 500003 } })
  } })
  const fields = await createQQProfile({ gateway }).read(saved())
  assert.equal(fields.nickname, '音乐用户'); assert.equal(fields.membership, undefined)
  assert.equal(fields.avatarDataUrl, undefined); assert.equal(calls.length, 2)
})

test('avatar redirects cannot escape QQ hosts and oversized images are rejected during streaming', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }),
    new Response(Buffer.alloc(256 * 1024 + 1)), new Response('<svg onload="alert(1)"></svg>')]) {
    const calls = []
    const gateway = createQQGateway({ fetchImpl: async url => {
      const parsed = new URL(url); calls.push(parsed.hostname)
      if (parsed.hostname === 'u.y.qq.com') return vipResponse({ identity: { vip: 0 } })
      if (parsed.hostname === 'c.y.qq.com') return Response.json({ code: 0, data: { creator: { nick: '测试', headpic: 'https://y.gtimg.cn/avatar' } } })
      return response
    } })
    const result = await createQQProfile({ gateway }).read(saved())
    assert.equal(result.avatarDataUrl, undefined); assert.equal(result.membership, null)
    assert.equal(calls.includes('evil.example'), false)
  }
})

test('existing encrypted sessions gain profile and membership without another login and cache successful reads', async () => {
  let stored = saved(), reads = 0, time = 1000
  const app = createQQSession({ storage: { load: () => stored, save: state => { stored = state; return true }, clear() {} },
    now: () => time, profile: { read: async () => { reads++; return { nickname: '音乐昵称', avatarDataUrl: 'data:image/png;base64,AAAA',
      ...membershipSnapshotFields({ identity: { vip: 1, HugeVip: 0, level: 8 } }, 'fallback', time),
      profileComplete: true, profileFetchedAt: time } } } })
  assert.equal((await app.handle({ action: 'status' })).account.nickname, '登录昵称')
  const [first, second] = await Promise.all([app.handle({ action: 'profile' }), app.handle({ action: 'profile' })])
  assert.equal(reads, 1); assert.equal(first.account.nickname, '音乐昵称'); assert.equal(second.account.membership.label, '豪华绿钻')
  assert.equal(stored.cookies.qm_keyst, 'secret-music-key'); assert.equal(stored.account.nickname, '音乐昵称')
  assert.doesNotMatch(JSON.stringify(first), /secret-music-key|private-enc|cookies|avatarUrl/)
  await app.handle({ action: 'profile' }); assert.equal(reads, 1)
  time += 6 * 3600000 + 1
  assert.equal((await app.handle({ action: 'status' })).account.membership.label, '豪华绿钻')
  await app.handle({ action: 'profile' }); assert.equal(reads, 2)
})

test('upgrade invalidates a cached Super VIP label immediately while preserving the login and avatar', async () => {
  let stored = saved(), reads = 0
  const time = 100000000
  Object.assign(stored.account, { avatarDataUrl: 'data:image/png;base64,AAAA', profileComplete: true,
    profileFetchedAt: time, membershipFetchedAt: time, membership: { kind: 'svip', label: '超级会员', level: 3 } })
  const app = createQQSession({ now: () => time, storage: { load: () => stored, save: state => { stored = state; return true } },
    profile: { read: async () => { reads++; return { ...membershipSnapshotFields({ identity: { vip: 1, HugeVip: 0, level: 3 } }, 'fallback', time),
      profileFetchedAt: time, profileComplete: true } } } })
  const initial = await app.handle({ action: 'status' })
  assert.equal(initial.account.membership, null); assert.equal(initial.account.nickname, '登录昵称')
  assert.equal(initial.account.avatarDataUrl, 'data:image/png;base64,AAAA')
  const refreshed = await app.handle({ action: 'profile' })
  assert.equal(reads, 1); assert.equal(refreshed.account.membership.label, '豪华绿钻'); assert.equal(refreshed.account.membership.level, 3)
  assert.equal(stored.cookies.qm_keyst, 'secret-music-key')
})

test('profile failures and interrupted requests never log out users or restore a logged-out account', async () => {
  let stored = saved(), complete, readSignal
  const app = createQQSession({ storage: { load: () => stored, save: state => { stored = state; return true }, clear: () => { stored = null } },
    profile: { read: (_session, signal) => { readSignal = signal; return new Promise(resolve => { complete = resolve }) } } })
  const pending = app.handle({ action: 'profile' })
  await app.handle({ action: 'logout' }); assert.equal(readSignal.aborted, true)
  complete({ nickname: '迟到资料' }); assert.equal((await pending).account, null); assert.equal(stored, null)
  const failure = createQQSession({ storage: { load: saved }, profile: { read: async () => { throw Error('500003') } } })
  assert.equal((await failure.handle({ action: 'profile' })).account.nickname, '登录昵称')
})
