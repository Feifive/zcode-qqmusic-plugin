// QQ/WeChat login protocol adapted from dsh-music-player; MIT notice in qq-gateway.js.
import { createQQGateway, hash33, responseCookies, joinCookies } from './qq-gateway.js'
import { profileFields } from './qq-profile.js'
import { membershipSnapshotFields } from './qq-membership.js'

const QQ_SHOW = 'https://ssl.ptlogin2.qq.com/ptqrshow'
const QQ_CHECK = 'https://ssl.ptlogin2.qq.com/ptqrlogin'
const WX_CONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
const WX_CHECK = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
const WX_APPID = 'wx48db31d50e334801'
const REDIRECT = type => `https://y.qq.com/portal/wx_redirect.html?login_type=${type}&surl=https://y.qq.com/`
const pick = (data, ...keys) => keys.map(key => data?.[key]).find(value => typeof value === 'string' && value.trim() || typeof value === 'number' && value > 0)
const value = (data, ...keys) => String(pick(data, ...keys) || '').trim()

function musicSession({ cookies, data }, type, fallbackName = '') {
  // p_skey/skey belong to QQ web login and must never count as a music key.
  const key = value(data, 'musickey', 'music_key', 'qqmusic_key', 'qm_keyst', 'strMusicKey') || value(cookies, 'qm_keyst', 'qqmusic_key', 'musickey')
  const uin = value(data, 'musicid', 'musicId', 'userid', 'user_id', 'uin') || value(cookies, 'musicid', 'uin', 'ptui_loginuin', 'p_uin')
  if (!key || !uin) throw Error('扫码已确认，但未取得 QQ 音乐登录凭据，请重新扫码')
  const normalized = { ...cookies, uin, musicid: uin, musickey: key, qqmusic_key: key, qm_keyst: key, login_type: type === 'wx' ? '2' : '1' }
  for (const [target, keys] of Object.entries({ encrypt_uin: ['encrypt_uin', 'encryptUin', 'encuin', 'euin', 'str_encrypt_uin'],
    refresh_key: ['refresh_key', 'refreshKey'], refresh_token: ['refresh_token', 'refreshToken'],
    openid: ['openid', 'openId', 'wxopenid', 'strOpenid'], unionid: ['unionid', 'unionId', 'wxunionid', 'strUnionid'],
    wxaccess_token: ['access_token', 'accessToken', 'wxaccess_token'] })) {
    const field = value(data, ...keys)
    if (field) normalized[target] = field
  }
  const profile = profileFields(data)
  return { cookies: normalized, account: { uin, nickname: profile.nickname || fallbackName.slice(0, 100),
    avatarUrl: profile.avatarUrl, loginType: type, loggedInAt: Date.now(), ...membershipSnapshotFields(data, 'login') } }
}

function qrImage(response) {
  if (response.status !== 200 || response.body.length > 1024 * 1024) throw Error('二维码获取失败，请重试')
  const png = response.body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = response.body[0] === 255 && response.body[1] === 216
  if (!png && !jpeg) throw Error('二维码图片无效，请重试')
  return `data:image/${png ? 'png' : 'jpeg'};base64,${response.body.toString('base64')}`
}

export function createQQAuth({ gateway = createQQGateway() } = {}) {
  const { request, login } = gateway
  async function create(type, signal) {
    if (type === 'qq') {
      const query = new URLSearchParams({ appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4',
        t: (Date.now() / 1e12).toFixed(17), daid: '383', pt_3rd_aid: '100497308' })
      const response = await request(`${QQ_SHOW}?${query}`, { signal })
      const qrsig = responseCookies(response.headers).qrsig
      if (!qrsig) throw Error('二维码会话获取失败，请重试')
      return { type, qrsig, imageDataUrl: qrImage(response), expiresAt: Date.now() + 120000 }
    }
    if (type !== 'wx') throw Error('不支持的登录方式')
    const query = new URLSearchParams({ appid: WX_APPID, redirect_uri: REDIRECT(2), response_type: 'code',
      scope: 'snsapi_login', state: `zcode-music-${Date.now()}`, href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect' })
    const response = await request(`${WX_CONNECT}?${query}`, { signal })
    if (response.status !== 200) throw Error('微信二维码获取失败，请重试')
    const uuid = /connect\/l\/qrconnect\?uuid=([A-Za-z0-9_-]+)/.exec(response.text)?.[1]
      || /window\.QRLogin\.uuid\s*=\s*["']([A-Za-z0-9_-]+)["']/.exec(response.text)?.[1]
      || /\/connect\/qrcode\/([A-Za-z0-9_-]+)/.exec(response.text)?.[1]
    if (!uuid) throw Error('微信二维码会话获取失败，请重试')
    const image = await request(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`, { signal })
    return { type, uuid, imageDataUrl: qrImage(image), expiresAt: Date.now() + 300000 }
  }

  async function check(qr, signal) {
    if (qr.type === 'wx') {
      const response = await request(`${WX_CHECK}?${new URLSearchParams({ uuid: qr.uuid, _: String(Date.now()) })}`, {
        signal, timeoutMs: 25000, headers: { Referer: WX_CONNECT } })
      if (response.status !== 200) throw Error('微信登录连接暂时不可用')
      const code = /wx_errcode\s*=\s*['"]?(\d+)/.exec(response.text)?.[1]
      const status = { 405: 'success', 402: 'expired', 404: 'scanned', 408: 'waiting', 403: 'cancelled' }[code]
      if (!status) throw Error('微信登录状态暂时不可用')
      if (status !== 'success') return { status }
      const wxCode = /wx_code\s*=\s*["']([^"']+)["']/.exec(response.text)?.[1]
      if (!wxCode) return { status: 'error', message: '微信未返回授权码，请重新扫码' }
      const result = await login({ module: 'music.login.LoginServer', method: 'Login', param: { strAppid: WX_APPID, code: wxCode },
        cookies: { login_type: '2' }, referer: REDIRECT(2), wx: true, signal })
      return { status: 'success', session: musicSession(result, 'wx') }
    }
    const query = new URLSearchParams({ u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: String(hash33(qr.qrsig)),
      ptredirect: '100', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052', action: `0-0-${Date.now()}`,
      js_ver: '21072115', js_type: '1', login_sig: '', pt_uistyle: '40', aid: '716027609', daid: '383',
      pt_3rd_aid: '100497308', has_onekey: '1', pttype: '1', service: 'ptqrlogin', nodirect: '0' })
    const response = await request(`${QQ_CHECK}?${query}`, { signal, headers: { Referer: 'https://xui.ptlogin2.qq.com/', Cookie: `qrsig=${qr.qrsig}` } })
    if (response.status === 403) return { status: 'error', message: 'QQ 登录被风控拦截，请尝试微信扫码' }
    if (response.status !== 200) throw Error('QQ 登录连接暂时不可用')
    const fields = [...response.text.matchAll(/'((?:\\.|[^'\\])*)'/g)].map(match => match[1])
    const status = { 0: 'success', 65: 'expired', 66: 'waiting', 67: 'scanned', 68: 'cancelled' }[fields[0]]
    if (!status) return { status: 'error', message: 'QQ 登录未完成，请刷新二维码重试' }
    if (status !== 'success') return { status }
    let cookies = responseCookies(response.headers), next = fields[2], referer = 'https://y.qq.com/'
    for (let hop = 0; next && hop < 8; hop++) {
      const url = new URL(next)
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['ssl.ptlogin2.qq.com', 'ptlogin2.qq.com', 'ssl.ptlogin2.graph.qq.com', 'ptlogin2.graph.qq.com', 'graph.qq.com', 'y.qq.com'].includes(url.hostname)) {
        throw Error('QQ 登录跳转地址无效')
      }
      const redirect = await request(url.href, { signal, headers: { Referer: referer, Cookie: joinCookies(cookies) } })
      cookies = { ...cookies, ...responseCookies(redirect.headers) }
      const location = redirect.headers.get('location')
      referer = url.href
      next = redirect.status >= 300 && redirect.status < 400 && location ? new URL(location, url).href : ''
    }
    const gtk = hash33(value(cookies, 'p_skey', 'skey', 'qqmusic_key', 'p_lskey', 'lskey', 'qm_keyst'), 5381)
    const oauth = new URLSearchParams({ response_type: 'code', client_id: '100497308', redirect_uri: REDIRECT(1), scope: 'all',
      state: 'state', switch: '', from_ptlogin: '1', src: '1', update_auth: '1', openapi: '80901010_1030',
      g_tk: String(gtk), auth_time: String(Date.now()), ui: 'DFEC5395-9E69-4D3E-96A6-300BB770874D' })
    const authorization = await request('https://graph.qq.com/oauth2.0/authorize', { method: 'POST', signal, body: oauth.toString(),
      headers: { Referer: 'https://xui.ptlogin2.qq.com/', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: joinCookies(cookies) } })
    const location = authorization.headers.get('location') || ''
    const code = /[?&]code=([^&]+)/.exec(location)?.[1] || /[?&]code%3D([^&]+)/.exec(location)?.[1]
    if (!code) throw Error('QQ 音乐授权码兑换失败，请重新扫码')
    cookies = { ...cookies, ...responseCookies(authorization.headers) }
    const result = await login({ module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code: decodeURIComponent(code) },
      cookies, referer: REDIRECT(1), signal })
    return { status: 'success', session: musicSession(result, 'qq', fields[5] || '') }
  }
  return { create, check }
}
