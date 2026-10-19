import { createQQGateway, hash33, joinCookies, parseJsonPreserveBigInt } from './qq-gateway.js'
import { hasMembershipSnapshot, membershipSnapshotFields } from './qq-membership.js'
export { MEMBERSHIP_VERSION, membershipFields } from './qq-membership.js'

const text = (data, keys) => keys.map(key => data?.[key]).find(value => typeof value === 'string' && value.trim())?.trim() || ''
const nicknameKeys = ['nickname', 'nick', 'name', 'user_name', 'strNickname', 'stringName', 'wx_nickname', 'nickName']
const avatarKeys = ['headpic', 'headPic', 'headurl', 'headUrl', 'headPicUrl', 'head_pic_url', 'avatar', 'avatar_url', 'avatarUrl', 'face', 'logo']

export function avatarURL(raw) {
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return ''
    if (!['qlogo.cn', 'gtimg.cn', 'qq.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return ''
    url.protocol = 'https:'
    return url.href
  } catch { return '' }
}

function decodeName(raw) {
  return raw.replace(/&#(x[\da-f]+|\d+);/gi, (whole, code) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (whole, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key])
    .trim().slice(0, 100)
}

export function profileFields(data) {
  // Prefer the music homepage creator, then login/user-info fields. Do not
  // recursively search playlist authors, whose profiles belong to other people.
  const sources = [data?.creator, data?.profile, data?.user_info, data?.userInfo, data?.baseInfo, data?.info, data]
  return {
    nickname: decodeName(sources.map(source => text(source, nicknameKeys)).find(Boolean) || ''),
    avatarUrl: sources.map(source => avatarURL(text(source, avatarKeys))).find(Boolean) || '',
  }
}

export function createQQProfile({ gateway = createQQGateway(), now = Date.now } = {}) {
  async function image(raw, signal) {
    let url = avatarURL(raw)
    for (let hop = 0; url && hop < 3; hop++) {
      // No account cookies go to the image CDN. Validate each redirect too.
      const response = await gateway.request(url, { signal, timeoutMs: 3500, maxBytes: 256 * 1024 })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        url = location ? avatarURL(new URL(location, url).href) : ''
        continue
      }
      if (response.status !== 200 || response.body.length > 256 * 1024) return ''
      const bytes = response.body
      const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg'
          : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) ? 'gif'
            : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : ''
      return type ? `data:image/${type};base64,${bytes.toString('base64')}` : ''
    }
    return ''
  }

  async function read(session, signal) {
    const { account, cookies } = session
    let fields = { nickname: '', avatarUrl: avatarURL(account.avatarUrl || '') }
    let fetched = false
    const gtk = String(hash33(cookies.qm_keyst || '', 5381))
    // Only legacy sessions without an identity snapshot need this supplement.
    // A failed read never invalidates login or overwrites known entitlements.
    const vipTask = (async () => {
      if (hasMembershipSnapshot(account)) return {}
      try {
        const response = await gateway.request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'POST', signal, timeoutMs: 4000, maxBytes: 128 * 1024,
          headers: { Cookie: joinCookies(cookies), 'Content-Type': 'application/json', Origin: 'https://y.qq.com' },
          body: JSON.stringify({ comm: { ct: 24, cv: 0, platform: 'yqq', uin: account.uin,
            authst: cookies.qm_keyst, tmeLoginType: account.loginType === 'wx' ? '1' : '2', g_tk: Number(gtk), g_tk_new_20200303: Number(gtk) },
            req: { module: 'VipLogin.VipLoginInter', method: 'vip_login_base', param: {} } }),
        })
        if (response.status !== 200) return undefined
        const body = parseJsonPreserveBigInt(response.text)
        return body.code === 0 && body.req?.code === 0 ? membershipSnapshotFields(body.req.data, 'fallback', now()) : {}
      } catch { return undefined }
    })()
    try {
      // Keep IDs as strings, including WeChat music IDs above 2^53.
      const query = new URLSearchParams({ format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
        cid: '205360838', ct: '24', cv: '4747474', platform: 'yqq.json', needNewCode: '0',
        uin: account.uin, userid: account.uin, loginUin: account.uin, hostUin: '0', reqfrom: '1', reqtype: '0',
        g_tk: gtk, g_tk_new_20200303: gtk })
      const response = await gateway.request(`https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg?${query}`, {
        signal, timeoutMs: 4000, maxBytes: 1024 * 1024,
        headers: { Cookie: joinCookies(cookies), Referer: 'https://y.qq.com/portal/profile.html' } })
      if (response.status === 200) {
        const body = parseJsonPreserveBigInt(response.text)
        if (body.code === 0 && body.data) {
          const profile = profileFields(body.data)
          fields = { nickname: profile.nickname, avatarUrl: profile.avatarUrl || fields.avatarUrl }
          fetched = Boolean(profile.nickname || profile.avatarUrl)
        }
      }
    } catch { /* Profile failure preserves the login response's name/avatar. */ }
    const membershipData = await vipTask || {}
    const membershipKnown = hasMembershipSnapshot(account) || hasMembershipSnapshot(membershipData)
    if (signal?.aborted) throw Error('Profile request cancelled')
    let avatarDataUrl = ''
    // A QQ number can use QQ's standard avatar service; a WeChat music ID is
    // a different identity and must never be passed to that service as a QQ ID.
    const fallback = account.loginType === 'qq' && /^\d{5,12}$/.test(account.uin)
      ? `https://q.qlogo.cn/headimg_dl?dst_uin=${account.uin}&spec=100` : ''
    try { avatarDataUrl = await image(fields.avatarUrl || fallback, signal) }
    catch (error) { if (signal?.aborted) throw error }
    if (!fetched && !avatarDataUrl && !membershipData.membershipSnapshot) return null
    return { ...(fields.nickname ? { nickname: fields.nickname } : {}),
      ...(avatarDataUrl ? { avatarDataUrl } : {}), ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
      ...membershipData,
      profileComplete: Boolean(fetched && avatarDataUrl && membershipKnown), profileFetchedAt: now() }
  }
  return { read }
}
