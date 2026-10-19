import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createQQGateway, hash33, parseJsonPreserveBigInt } from '../plugin/lib/qq-gateway.js'
import { createQQAuth } from '../plugin/lib/qq-auth.js'
import { createQQSession, createSessionStorage } from '../plugin/lib/qq-session.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBJoAAAAASUVORK5CYII=', 'base64')
const cookieHeaders = pairs => { const headers = new Headers(); pairs.forEach(pair => headers.append('set-cookie', pair)); return headers }
function queued(steps) {
  const calls = []
  const gateway = createQQGateway({ fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), ...options })
    assert.ok(steps.length, 'Unexpected network request')
    const step = steps.shift()
    if (step instanceof Error) throw step
    return step
  } })
  return { auth: createQQAuth({ gateway }), gateway, calls }
}
const success = type => ({ cookies: { qm_keyst: 'secret-music-key', encrypt_uin: 'secret-enc-uin' },
  account: { uin: '1152921504606846999', nickname: '测试账号', loginType: type, loggedInAt: 123 } })
function fixture(overrides = {}) {
  let time = 1000, saved = null, checks = 0
  const auth = { create: async type => ({ type, qrsig: 'secret-qr-sig', imageDataUrl: 'data:image/png;base64,AAA=', expiresAt: time + 120000 }),
    check: async () => { checks++; return { status: 'success', session: success('qq') } }, ...overrides.auth }
  const storage = { load: () => saved, save: state => { saved = state; return true }, clear: () => { saved = null }, ...overrides.storage }
  const session = createQQSession({ auth, storage, now: () => time, id: () => 'test-login' })
  return { handle: session.handle, auth, storage, saved: () => saved, checks: () => checks, advance: ms => { time += ms } }
}

test('hash33 uses separate QR and GTK seeds and JSON preserves large account IDs', () => {
  assert.equal(hash33('abc'), 108966)
  assert.equal(hash33('abc', 5381), 193485963)
  assert.deepEqual(parseJsonPreserveBigInt('{"musicid":1152921504606846999,"uin":"1152921504606846999","n":-9007199254740993,"small":123,"e":1e3,"text":"id:123 \\\"456\\\""}'),
    { musicid: '1152921504606846999', uin: '1152921504606846999', n: '-9007199254740993', small: 123, e: 1000, text: 'id:123 "456"' })
  for (const raw of ['{"id":1', '{"id":}', 'true trailing', '[01]']) assert.throws(() => parseJsonPreserveBigInt(raw))
})

test('QQ login follows QR, redirects, OAuth and music credentials exchange in order', async () => {
  const { auth, calls } = queued([
    new Response(png, { headers: cookieHeaders(['qrsig=qr-signature; Path=/']) }),
    new Response("ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?x=1','0','登录成功','小明');", { headers: cookieHeaders(['uin=o0123456; Path=/']) }),
    new Response(null, { status: 302, headers: { location: 'https://graph.qq.com/oauth2.0/login_jump', 'set-cookie': 'p_skey=web-key; Path=/' } }),
    new Response('ok'),
    new Response(null, { status: 302, headers: { location: 'https://y.qq.com/portal/wx_redirect.html?code=oauth-code', 'set-cookie': 'p_skey=; Max-Age=0' } }),
    Response.json({ code: 0, req: { code: 0, data: { musicid: '123456', musickey: 'music-key', encrypt_uin: 'encrypted-uin',
      identity: { vip: 1, HugeVip: 2, level: 3, yearflag: 1, eight: 1, eightEnd: '2099-01-01' } } } }),
  ])
  const qr = await auth.create('qq')
  assert.equal(qr.type, 'qq'); assert.ok(qr.imageDataUrl.startsWith('data:image/png;base64,'))
  const result = await auth.check(qr)
  assert.equal(result.status, 'success'); assert.equal(result.session.cookies.qm_keyst, 'music-key')
  assert.equal(result.session.cookies.uin, '123456'); assert.equal(result.session.cookies.encrypt_uin, 'encrypted-uin')
  assert.equal(result.session.account.nickname, '小明')
  assert.equal(result.session.account.membership.label, '超级会员')
  assert.equal(result.session.account.membershipSnapshot.source, 'login')
  assert.equal(result.session.account.membershipSnapshot.identity.eight, 1)
  assert.equal(result.session.account.membershipSnapshot.identity.HugeVip, 2)
  assert.equal(calls[1].url.searchParams.get('ptqrtoken'), String(hash33('qr-signature')))
  const oauth = new URLSearchParams(calls[4].body)
  assert.equal(oauth.get('g_tk'), String(hash33('web-key', 5381)))
  assert.match(calls[5].headers.Cookie, /p_skey=web-key/)
  assert.equal(JSON.parse(calls[5].body).req.module, 'QQConnectLogin.LoginServer')
  assert.equal(JSON.parse(calls[5].body).req.param.code, 'oauth-code')
})

test('QQ web cookies alone cannot count as a successful music login; untrusted redirects never receive cookies', async () => {
  const incomplete = queued([
    new Response("ptuiCB('0','0','','0','ok','user');", { headers: cookieHeaders(['uin=123', 'p_skey=web-only']) }),
    new Response(null, { status: 302, headers: { location: 'https://y.qq.com/?code=code' } }),
    Response.json({ code: 0, req: { code: 0, data: {} } }),
  ])
  await assert.rejects(incomplete.auth.check({ type: 'qq', qrsig: 'sig' }), /未取得 QQ 音乐登录凭据/)
  const hostile = queued([new Response("ptuiCB('0','0','https://evil.example/','0','ok','user');", { headers: cookieHeaders(['p_skey=web-only']) })])
  await assert.rejects(hostile.auth.check({ type: 'qq', qrsig: 'sig' }), /跳转地址无效/)
  assert.equal(hostile.calls.length, 1)
  const blocked = queued([new Response('', { status: 403 })])
  assert.match((await blocked.auth.check({ type: 'qq', qrsig: 'sig' })).message, /微信扫码/)
})

test('WeChat QR polling retains 18-digit music IDs and sends the right login payload', async () => {
  const { auth, calls } = queued([
    new Response('<img src="/connect/qrcode/wx-uuid">'), new Response(png),
    new Response("window.wx_errcode=405;window.wx_code='wx-code';"),
    new Response('{"code":0,"req":{"code":0,"data":{"musicid":1152921504606846999,"musickey":"W_X_key","nickname":"微信用户","identity":{"vip":-1,"HugeVip":0,"level":3,"twelve":1}}}}'),
  ])
  const qr = await auth.create('wx'), result = await auth.check(qr)
  assert.equal(result.session.account.uin, '1152921504606846999')
  assert.equal(result.session.cookies.login_type, '2'); assert.equal(result.session.cookies.qm_keyst, 'W_X_key')
  assert.equal(result.session.account.membership.kind, 'luxury')
  assert.equal(result.session.account.membershipSnapshot.source, 'login')
  assert.equal(result.session.account.membershipSnapshot.identity.twelve, 1)
  assert.equal(calls[2].url.searchParams.get('uuid'), 'wx-uuid')
  assert.equal(JSON.parse(calls[3].body).req.module, 'music.login.LoginServer')
  assert.equal(JSON.parse(calls[3].body).req.param.code, 'wx-code')
  for (const [code, expected] of [[408, 'waiting'], [404, 'scanned'], [402, 'expired'], [403, 'cancelled']]) {
    const pending = queued([new Response(`window.wx_errcode=${code};`)])
    assert.equal((await pending.auth.check(qr)).status, expected)
  }
})

test('gateway fails over on network errors, HTTP failures and rejected API responses', async () => {
  const { gateway, calls } = queued([Error('offline'), new Response('', { status: 503 }),
    Response.json({ code: 0, req: { code: 0, data: { musickey: 'key' } } })])
  assert.equal((await gateway.login({ module: 'Login', method: 'Login', param: {}, referer: 'https://y.qq.com/' })).data.musickey, 'key')
  assert.deepEqual(calls.map(call => call.url.hostname), ['u.y.qq.com', 'szu.y.qq.com', 'shu.y.qq.com'])
  const rejected = queued(Array.from({ length: 3 }, () => Response.json({ code: 0, req: { code: 500003 } })))
  await assert.rejects(rejected.gateway.login({ module: 'Login', method: 'Login', param: {} }), /凭据兑换失败/)
})

test('gateway cancellation applies through body reads and stops endpoint fallback', async () => {
  let reads = 0
  const gateway = createQQGateway({ fetchImpl: async (_url, { signal }) => ({ status: 200, headers: new Headers(), arrayBuffer: () => new Promise((_resolve, reject) => {
    reads++; signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
  }) }) })
  await assert.rejects(gateway.request('https://y.qq.com/', { timeoutMs: 10 }), /aborted/)
  assert.equal(reads, 1)
  const controller = new AbortController(); controller.abort()
  let attempts = 0
  const cancelled = createQQGateway({ fetchImpl: async () => { attempts++; throw Error('aborted') } })
  await assert.rejects(cancelled.login({ signal: controller.signal, module: 'Login', method: 'Login', param: {} }), /aborted/)
  assert.equal(attempts, 1)
})

test('session public state hides secrets, saves only after music auth, restores and logs out', async () => {
  const app = fixture(), created = await app.handle({ action: 'start', type: 'qq' })
  assert.equal(created.login.status, 'waiting')
  assert.doesNotMatch(JSON.stringify(created), /secret-qr-sig/)
  assert.equal(app.saved(), null)
  const loggedIn = await app.handle({ action: 'poll', id: created.login.id })
  assert.equal(loggedIn.account.nickname, '测试账号'); assert.equal(loggedIn.persistence, 'encrypted')
  assert.doesNotMatch(JSON.stringify(loggedIn), /secret-music-key|secret-enc-uin|cookies/)
  assert.equal(app.saved().cookies.qm_keyst, 'secret-music-key')
  const restored = createQQSession({ storage: app.storage, auth: { create() { throw Error('must not probe') } } })
  assert.equal((await restored.handle({ action: 'status' })).account.uin, '1152921504606846999')
  assert.equal((await restored.handle({ action: 'logout' })).account, null); assert.equal(app.saved(), null)
})

test('cancel, refresh, logout and expiry discard late successful responses', async () => {
  for (const action of ['cancel', 'start', 'logout', 'expiry']) {
    let finish, oldSignal
    const app = fixture({ auth: { check: (_qr, signal) => { oldSignal = signal; return new Promise(resolve => { finish = resolve }) } } })
    const created = await app.handle({ action: 'start', type: 'qq' })
    const poll = app.handle({ action: 'poll', id: created.login.id })
    if (action === 'expiry') { app.advance(120001); await app.handle({ action: 'status' }) }
    else await app.handle({ action, id: created.login.id, type: 'wx' })
    assert.equal(oldSignal.aborted, true)
    finish({ status: 'success', session: success('qq') })
    await poll
    assert.equal(app.saved(), null); assert.equal((await app.handle({ action: 'status' })).account, null)
  }
})

test('cancel while creating QR prevents late images, and polling deduplicates and throttles', async () => {
  let finish
  const app = fixture({ auth: { create: () => new Promise(resolve => { finish = resolve }) } })
  const creating = app.handle({ action: 'start', type: 'qq', id: 'known-request' })
  await app.handle({ action: 'cancel', id: 'known-request' })
  finish({ type: 'qq', qrsig: 'secret', expiresAt: 999999 })
  assert.equal((await creating).login, null)
  let complete, count = 0
  const polling = fixture({ auth: { check: () => { count++; return new Promise(resolve => { complete = resolve }) } } })
  await polling.handle({ action: 'start', type: 'qq' })
  const a = polling.handle({ action: 'poll', id: 'test-login' }), b = polling.handle({ action: 'poll', id: 'test-login' })
  assert.equal(count, 1); complete({ status: 'waiting' }); await Promise.all([a, b])
  await polling.handle({ action: 'poll', id: 'wrong-id' }); await polling.handle({ action: 'poll', id: 'test-login' })
  assert.equal(count, 1)
})

test('unavailable encryption stays in memory; save failures do not silently keep old credentials', async () => {
  const memory = fixture({ storage: { save: () => false } })
  await memory.handle({ action: 'start', type: 'qq' })
  const state = await memory.handle({ action: 'poll', id: 'test-login' })
  assert.equal(state.persistence, 'memory'); assert.match(state.notice, /仅在本次运行/)
  assert.equal(memory.saved(), null)
  let cleared = false
  const failed = fixture({ storage: { save: () => { throw Error('disk full') }, clear: () => { cleared = true } } })
  await failed.handle({ action: 'start', type: 'qq' })
  assert.match((await failed.handle({ action: 'poll', id: 'test-login' })).notice, /保存失败/)
  assert.equal(cleared, true)
})

test('transient polling failures retry, stop after three failures and expire without probing accounts', async () => {
  const app = fixture({ auth: { check: async () => { throw Error('offline') } } })
  await app.handle({ action: 'start', type: 'qq' })
  for (let attempt = 1; attempt <= 3; attempt++) {
    const state = await app.handle({ action: 'poll', id: 'test-login' })
    assert.equal(state.login.status, attempt < 3 ? 'waiting' : 'error')
    app.advance(1600)
  }
  await app.handle({ action: 'start', type: 'wx' })
  app.advance(120001)
  const expired = await app.handle({ action: 'poll', id: 'test-login' })
  assert.equal(expired.login.status, 'expired'); assert.equal(expired.login.imageDataUrl, null)
  const corrupt = fixture({ storage: { load: () => { throw Error('cannot decrypt secret') } } })
  const state = await corrupt.handle({ action: 'status' })
  assert.equal(state.account, null); assert.match(state.notice, /无法解密/)
  assert.doesNotMatch(JSON.stringify(state), /secret/)
})

test('session file uses encrypted bytes, restrictive permissions and atomic replacement', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-login-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A real cipher exercises byte storage; Electron supplies the Keychain-backed
  // encrypt/decrypt methods in production, not this test key.
  const key = randomBytes(32)
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString() } }
  const storage = createSessionStorage({ settingsDir: dir, safeStorage })
  assert.equal(storage.load(), null); assert.equal(storage.save(success('wx')), true)
  const file = join(dir, 'qq-session.enc'), bytes = readFileSync(file)
  assert.equal(bytes.includes(Buffer.from('secret-music-key')), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(storage.load(), success('wx')); assert.deepEqual(readdirSync(dir), ['qq-session.enc'])
  storage.clear(); assert.equal(storage.load(), null)
  const unavailable = createSessionStorage({ settingsDir: dir, safeStorage: { isEncryptionAvailable: () => false } })
  assert.equal(unavailable.save(success('wx')), false); assert.deepEqual(readdirSync(dir), [])
})
