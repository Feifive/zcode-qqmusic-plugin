import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createQQAuth } from './qq-auth.js'
import { MEMBERSHIP_VERSION, hasMembershipSnapshot, membershipFields, membershipEntitlements } from './qq-membership.js'
import { createQQFavorites } from './qq-favorites.js'

export function createSessionStorage({ settingsDir, safeStorage }) {
  const file = join(settingsDir, 'qq-session.enc')
  const available = () => safeStorage?.isEncryptionAvailable() === true
  return {
    available,
    load() {
      if (!available()) return null
      try { return JSON.parse(safeStorage.decryptString(readFileSync(file))) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
    save(session) {
      if (!available()) return false
      const encrypted = safeStorage.encryptString(JSON.stringify(session))
      mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' })
        renameSync(temp, file)
      } finally { rmSync(temp, { force: true }) }
      return true
    },
    clear() { rmSync(file, { force: true }) },
  }
}

const messages = { waiting: '请使用手机扫码登录', scanned: '已扫码，请在手机上确认', success: '已登录 QQ 音乐',
  expired: '二维码已过期，请刷新', cancelled: '已取消登录', error: '登录失败，请重试' }
const active = state => ['loading', 'waiting', 'scanned'].includes(state?.status)

// Only the public account and QR image cross IPC. Cookies and polling secrets
// stay in this closure, including after restoring from encrypted storage.
export function createQQSession({ storage, auth = createQQAuth(), profile = null, favorites = createQQFavorites(), now = Date.now, id = randomUUID } = {}) {
  let session = null, login = null, qr = null, controller, revision = 0, inflight = null, checkedAt = -Infinity, failures = 0
  let persistence = 'memory', notice = ''
  let favoriteRevision = id()
  let profileTask = null, profileController, profileCheckedAt = -Infinity
  try {
    const saved = storage.load()
    if (saved?.cookies?.qm_keyst && typeof saved.account?.uin === 'string' && ['qq', 'wx'].includes(saved.account.loginType)) {
      session = saved
      if (!hasMembershipSnapshot(saved.account) && saved.account.membershipVersion !== MEMBERSHIP_VERSION) {
        // Keep credentials/name/avatar, but refresh labels produced by an old
        // parser immediately instead of waiting out the six-hour profile cache.
        session = { ...saved, account: { ...saved.account, membership: null, membershipFetchedAt: 0,
          profileFetchedAt: 0, profileComplete: false } }
      }
      persistence = 'encrypted'
    }
  } catch { notice = '保存的登录信息无法解密，请重新扫码' }

  function expire() {
    if (active(login) && login.expiresAt && now() >= login.expiresAt) {
      controller?.abort(); revision++; inflight = null; qr = null
      login = { ...login, status: 'expired', imageDataUrl: null, message: messages.expired }
    }
  }
  function status() {
    expire()
    return { account: session ? { uin: session.account.uin, nickname: session.account.nickname, avatarDataUrl: session.account.avatarDataUrl || '',
      membership: hasMembershipSnapshot(session.account) ? membershipFields(session.account.membershipSnapshot, now()) : null,
      entitlements: hasMembershipSnapshot(session.account) ? membershipEntitlements(session.account.membershipSnapshot, now()) : null,
      loginType: session.account.loginType, loggedInAt: session.account.loggedInAt } : null,
      login: login ? { ...login } : null, persistence, notice }
  }
  function stop() {
    controller?.abort(); controller = null; revision++; inflight = null; qr = null; login = null
    if (profileTask) profileCheckedAt = -Infinity
    profileController?.abort(); profileTask = null
  }
  async function refreshProfile() {
    if (!session || !profile) return status()
    if (profileTask) return profileTask
    const ttl = session.account.profileComplete ? 6 * 3600000 : 300000
    if (now() - profileCheckedAt < 300000 || now() - (session.account.profileFetchedAt || -Infinity) < ttl) return status()
    profileCheckedAt = now()
    const current = session, ticket = revision
    profileController = new AbortController()
    const signal = profileController.signal
    const task = (async () => {
      try {
        const fields = await profile.read(current, signal)
        if (session !== current || ticket !== revision || signal.aborted || !fields) return status()
        session = { ...current, account: { ...current.account, ...fields } }
        if (persistence === 'encrypted') {
          // Profile failures must never discard a valid saved music session.
          try { storage.save(session) } catch { /* retry metadata on a future run */ }
        }
      } catch { /* Optional profile lookup never changes login validity. */ }
      return status()
    })().finally(() => { if (profileTask === task) profileTask = null })
    profileTask = task
    return task
  }
  async function start(type, requestId) {
    if (!['qq', 'wx'].includes(type)) throw Error('不支持的登录方式')
    stop(); controller = new AbortController()
    const ticket = revision, signal = controller.signal
    login = { id: typeof requestId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(requestId) ? requestId : id(), type, status: 'loading', imageDataUrl: null, expiresAt: null, message: '正在获取二维码…' }
    failures = 0; checkedAt = -Infinity
    try {
      const created = await auth.create(type, signal)
      if (ticket !== revision) return status()
      qr = created
      login = { ...login, status: 'waiting', imageDataUrl: qr.imageDataUrl, expiresAt: qr.expiresAt, message: messages.waiting }
    } catch {
      if (ticket === revision) login = { ...login, status: 'error', message: '二维码获取失败，请检查网络后重试' }
    }
    return status()
  }
  async function poll(loginId) {
    expire()
    if (!login || login.id !== loginId || !qr || !active(login)) return status()
    if (inflight) return inflight
    if (now() - checkedAt < 1500) return status()
    checkedAt = now()
    const ticket = revision, signal = controller.signal
    const task = (async () => {
      try {
        const result = await auth.check(qr, signal)
        expire()
        if (ticket !== revision) return status()
        if (result.status === 'success') {
          if (!result.session?.cookies?.qm_keyst || !result.session?.account?.uin) throw Error('Missing music credentials')
          const next = result.session
          persistence = 'memory'
          notice = '系统加密存储不可用，登录仅在本次运行中保留'
          try {
            if (storage.save(next)) { persistence = 'encrypted'; notice = '' }
            else storage.clear() // Do not restore a previous account on restart.
          } catch {
            notice = '登录成功，但凭据保存失败；重启后请重新扫码'
            try { storage.clear() } catch { notice = '登录成功，但旧凭据未能清除；重启后可能恢复旧账号' }
          }
          session = next
          favorites.reset()
          favoriteRevision = id()
          profileController?.abort(); profileTask = null
          profileCheckedAt = -Infinity
        }
        failures = 0
        const state = Object.hasOwn(messages, result.status) ? result.status : 'error'
        login = { ...login, status: state, message: result.message || messages[state] }
        if (!active(login)) { qr = null; login.imageDataUrl = null }
      } catch {
        if (ticket !== revision) return status()
        failures++
        if (failures >= 3) {
          qr = null; login = { ...login, status: 'error', imageDataUrl: null, message: '登录连接或凭据兑换失败，请刷新二维码重试' }
        } else login = { ...login, message: '连接暂时中断，正在重试…' }
      }
      return status()
    })().finally(() => { if (inflight === task) inflight = null })
    inflight = task
    return task
  }
  async function handle(payload) {
    switch (payload?.action) {
      case 'status': return status()
      case 'profile': return refreshProfile()
      case 'start': return start(payload.type, payload.id)
      case 'poll': return poll(payload.id)
      case 'cancel':
        if (payload.id === login?.id) stop()
        return status()
      case 'logout':
        stop()
        // Do not report logout success if the saved credentials could not be removed.
        storage.clear(); favorites.reset(); favoriteRevision = id(); session = null; persistence = 'memory'; notice = ''
        return status()
      default: throw Error('不支持的账号操作')
    }
  }
  async function favorite(payload, track) {
    if (!session) return { status: 'logged-out', songmid: track?.songmid || '', liked: null, message: '请先登录 QQ 音乐' }
    if (!track?.favoriteEligible || !track.songmid || !Number.isSafeInteger(track.songid) || track.songid <= 0) {
      return { status: 'unavailable', songmid: track?.songmid || '', liked: null, message: '未能准确匹配 QQ 音乐歌曲，暂不能收藏' }
    }
    const current = session, revision = favoriteRevision
    let result
    if (payload.action === 'status') result = await favorites.status(current, track, payload.force === true)
    else if (payload.action === 'set' && typeof payload.liked === 'boolean') {
      if (payload.revision !== revision) throw Error('登录账号已变化，请刷新收藏状态后重试')
      result = await favorites.set(current, track, payload.liked)
    } else throw Error('不支持的收藏操作')
    if (session?.cookies.qm_keyst !== current.cookies.qm_keyst || favoriteRevision !== revision) throw Error('登录账号已变化，请重试')
    return { ...result, revision }
  }
  return { handle, favorite, dispose() { stop(); favorites.reset() } }
}
