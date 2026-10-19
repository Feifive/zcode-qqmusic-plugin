// Format the already identified product; this does not infer membership type
// from legacy API flags such as svip.
export function membershipText(membership) {
  const labels = { luxury: '豪华绿钻', vip: '豪华绿钻', svip: '超级会员', member: '音乐会员' }
  const label = labels[membership?.kind]
  if (!label) return ''
  const level = membership.level
  const prefix = membership.kind === 'svip' ? 'SVIP' : ['luxury', 'vip'].includes(membership.kind) ? 'VIP' : ''
  return label + (prefix && Number.isInteger(level) && level > 0 && level <= 20 ? ` ${prefix}${level}` : '')
}

export const accountMarkup = `
  <section class="account" aria-label="QQ 音乐账号">
    <div class="account-heading"><span>QQ 音乐账号</span><button class="account-logout" hidden>退出登录</button></div>
    <div class="account-person">
      <span class="account-avatar" role="img" aria-label="QQ 音乐头像" hidden><span class="account-avatar-fallback" aria-hidden="true">♪</span><img alt="" width="36" height="36" hidden></span>
      <div class="account-details"><div class="account-name-row"><strong class="account-name" hidden></strong><span class="account-membership" hidden></span></div><p class="account-summary">尚未登录</p></div>
    </div>
    <p class="account-profile-note" role="status" hidden></p>
    <div class="account-methods"><button data-login="qq">QQ 扫码</button><button data-login="wx">微信扫码</button></div>
    <div class="account-login" hidden>
      <div class="account-qr"><img alt="登录二维码" width="168" height="168" hidden><span class="account-placeholder">正在获取二维码…</span></div>
      <p class="account-login-message" role="status" aria-live="polite"></p>
      <div class="account-login-actions"><button class="account-retry" hidden>刷新二维码</button><button class="account-cancel">取消</button></div>
    </div>
    <p class="account-notice" role="status" hidden></p>
  </section>`

export function createAccountUI({ root, api, onAccountChange = () => {} }) {
  const $ = selector => root.querySelector(selector)
  let opened = false, disposed = false, ticket = 0, timer, expiryTimer, loginId = null, loginType = 'qq'
  let profileAttempt = '', avatarKey = ''
  const call = payload => api.configure({ account: payload })
  const active = state => ['loading', 'waiting', 'scanned'].includes(state?.status)
  function clearTimers() { clearTimeout(timer); clearTimeout(expiryTimer) }
  function error(message) { $('.account-notice').textContent = message; $('.account-notice').hidden = false }
  function paintAvatar(account) {
    const url = account?.avatarDataUrl || ''
    const key = `${account?.uin || ''}:${account?.loggedInAt || ''}:${url}`
    $('.account-avatar').hidden = !account
    $('.account-avatar-fallback').textContent = account?.nickname?.trim().slice(0, 1) || '♪'
    if (key === avatarKey) return
    avatarKey = key
    const image = document.createElement('img')
    image.alt = ''; image.width = image.height = 36; image.hidden = true; image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.onload = () => { if ($('.account-avatar img') === image && avatarKey === key) image.hidden = false }
    image.onerror = () => { image.hidden = true }
    $('.account-avatar img').replaceWith(image)
    if (url.length < 360000 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) image.src = url
  }
  async function loadProfile(state, current) {
    if (!opened || disposed || !state.account) return
    const key = `${current}:${state.account.uin}:${state.account.loggedInAt}`
    if (key === profileAttempt) return
    profileAttempt = key
    $('.account-profile-note').hidden = false; $('.account-profile-note').textContent = '正在更新账号资料…'
    try {
      const next = await call({ action: 'profile' })
      if (current !== ticket || !opened || disposed) return
      // Keep the latest QR state if profile and QR polling finish out of order.
      render({ ...state, account: next.account, notice: next.notice }, false)
      $('.account-profile-note').hidden = true
    } catch {
      if (current === ticket && opened && !disposed) $('.account-profile-note').textContent = '账号资料暂时不可用'
    }
  }
  let latestState, accountKey
  function render(state, refresh = true) {
    if (!refresh && latestState) state = { ...latestState, account: state.account, notice: state.notice }
    latestState = state
    const account = state.account, login = state.login
    const nextAccountKey = `${account?.uin || ''}:${account?.loggedInAt || ''}`
    if (accountKey !== nextAccountKey) { accountKey = nextAccountKey; onAccountChange() }
    if (!account) $('.account-profile-note').hidden = true
    $('.account-name').hidden = !account
    $('.account-name').textContent = account?.nickname || account?.uin || ''
    $('.account-name').title = account?.nickname || account?.uin || ''
    $('.account-summary').textContent = account ? `${account.loginType === 'wx' ? '微信' : 'QQ'}已登录` : '尚未登录'
    const membership = account?.membership
    const badgeText = membershipText(membership)
    $('.account-membership').hidden = !badgeText
    $('.account-membership').dataset.kind = membership?.kind || ''
    $('.account-membership').textContent = badgeText
    const rights = account?.entitlements
    $('.account-membership').title = [badgeText, rights?.annual ? '年费' : '', rights?.eightYuanPack ? '8 元付费包' : '',
      rights?.twelveYuanPack ? '12 元付费包' : ''].filter(Boolean).join(' · ')
    paintAvatar(account)
    if (refresh) loadProfile(state, ticket)
    $('.account-logout').hidden = !account
    $('.account-methods').hidden = Boolean(account && (!login || login.status === 'success'))
    $('.account-login').hidden = !login
    $('.account-notice').hidden = !state.notice
    $('.account-notice').textContent = state.notice || ''
    root.querySelectorAll('[data-login]').forEach(button => {
      button.setAttribute('aria-pressed', String(Boolean(login && button.dataset.login === login.type)))
    })
    if (!login) return
    loginId = login.id; loginType = login.type
    const image = $('.account-qr img')
    const validImage = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(login.imageDataUrl || '')
    $('.account-qr').hidden = !validImage && login.status !== 'loading'
    if (validImage) { if (image.getAttribute('src') !== login.imageDataUrl) image.src = login.imageDataUrl }
    else image.removeAttribute('src')
    image.hidden = !validImage
    $('.account-placeholder').hidden = validImage
    $('.account-placeholder').textContent = login.status === 'loading' ? '正在获取二维码…' : login.status === 'success' ? '✓ 已登录' : '请刷新二维码'
    $('.account-login-message').textContent = login.status === 'waiting' ? `请使用${login.type === 'wx' ? '微信' : 'QQ'}扫描二维码` : login.message
    $('.account-retry').hidden = active(login) || login.status === 'success'
    $('.account-cancel').textContent = login.status === 'success' ? '完成' : '取消'
  }
  function schedule(state, current) {
    clearTimers()
    if (!opened || disposed || !active(state.login) || current !== ticket) return
    timer = setTimeout(() => poll(current), 1800)
    if (state.login.expiresAt) expiryTimer = setTimeout(() => {
      if (current !== ticket || disposed || !opened) return
      // Enforce local QR expiry while a long poll is still outstanding.
      const id = loginId
      ticket++; clearTimers()
      render({ ...state, login: { ...state.login, status: 'expired', imageDataUrl: null, message: '二维码已过期，请刷新' } })
      call({ action: 'cancel', id }).catch(() => {})
    }, Math.max(0, state.login.expiresAt - Date.now()))
  }
  async function poll(current) {
    try {
      const state = await call({ action: 'poll', id: loginId })
      if (current !== ticket || disposed || !opened) return
      render(state); schedule(state, current)
    } catch {
      if (current !== ticket || disposed || !opened) return
      error('登录连接失败，正在重试…')
      timer = setTimeout(() => poll(current), 2500)
    }
  }
  async function start(type) {
    const current = ++ticket
    clearTimers(); loginType = type; loginId = crypto.randomUUID()
    const requestId = loginId
    // Keep the existing account summary while a replacement QR is fetched.
    $('.account-login').hidden = false
    $('.account-methods').hidden = false; $('.account-qr').hidden = false
    $('.account-qr img').hidden = true; $('.account-qr img').removeAttribute('src')
    $('.account-placeholder').hidden = false; $('.account-placeholder').textContent = '正在获取二维码…'
    $('.account-login-message').textContent = '正在连接登录服务…'
    $('.account-retry').hidden = true; $('.account-cancel').textContent = '取消'
    try {
      const state = await call({ action: 'start', type, id: requestId })
      if (current !== ticket || disposed || !opened) return
      render(state); schedule(state, current)
    } catch {
      if (current !== ticket || disposed || !opened) return
      error('二维码获取失败，请重试'); $('.account-retry').hidden = false
    }
  }
  async function cancel() {
    const current = ++ticket, id = loginId
    clearTimers(); loginId = null; $('.account-login').hidden = true
    $('.account-qr img').removeAttribute('src')
    try {
      const state = await call({ action: 'cancel', id })
      if (current === ticket && opened && !disposed) render(state)
    } catch { if (current === ticket && opened && !disposed) error('取消登录失败，请重试') }
  }
  root.querySelectorAll('[data-login]').forEach(button => { button.onclick = () => start(button.dataset.login) })
  $('.account-retry').onclick = () => start(loginType)
  $('.account-cancel').onclick = cancel
  $('.account-logout').onclick = async () => {
    const current = ++ticket
    clearTimers()
    try {
      const state = await call({ action: 'logout' })
      if (current === ticket && opened && !disposed) { loginId = null; render(state) }
    } catch { if (current === ticket && !disposed) error('退出登录失败，请重试') }
  }
  return {
    async open() {
      if (opened || disposed) return
      opened = true
      const current = ++ticket
      try {
        const state = await call({ action: 'status' })
        if (current !== ticket || !opened || disposed) return
        render(state); schedule(state, current)
      } catch { if (current === ticket && !disposed) error('账号状态读取失败，请重试') }
    },
    close() { if (!opened) return; opened = false; cancel() },
    dispose() { opened = false; disposed = true; ticket++; clearTimers(); if (loginId) call({ action: 'cancel', id: loginId }).catch(() => {}) },
  }
}
