// Browser-only account fixtures for preview.html; never loaded by the plugin.
(() => {
  const favoriteMode = new URLSearchParams(location.search).get('favorite')
  const mode = new URLSearchParams(location.search).get('login') || 'success'
  let account = null, login = null, polls = 0
  const canvas = document.createElement('canvas'), size = 29, ctx = canvas.getContext('2d')
  canvas.width = canvas.height = 168
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 168, 168); ctx.fillStyle = '#111'
  for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
    if ((x * 37 + y * 71 + x * y * 3) % 11 < 5) ctx.fillRect(11 + x * 5, 11 + y * 5, 5, 5)
  }
  for (const [x, y] of [[11, 11], [121, 11], [11, 121]]) {
    ctx.fillStyle = '#fff'; ctx.fillRect(x - 5, y - 5, 45, 45)
    ctx.fillStyle = '#111'; ctx.fillRect(x, y, 35, 35)
    ctx.fillStyle = '#fff'; ctx.fillRect(x + 5, y + 5, 25, 25)
    ctx.fillStyle = '#111'; ctx.fillRect(x + 10, y + 10, 15, 15)
  }
  const imageDataUrl = canvas.toDataURL('image/png')
  const avatar = document.createElement('canvas'), avatarContext = avatar.getContext('2d')
  avatar.width = avatar.height = 72
  avatarContext.fillStyle = '#487668'; avatarContext.fillRect(0, 0, 72, 72)
  avatarContext.fillStyle = '#e8f5ed'; avatarContext.beginPath(); avatarContext.arc(36, 27, 12, 0, Math.PI * 2); avatarContext.fill()
  avatarContext.beginPath(); avatarContext.arc(36, 68, 27, Math.PI, 0); avatarContext.fill()
  const memberKind = new URLSearchParams(location.search).get('member') || 'luxury'
  const membership = { kind: memberKind, label: { member: '音乐会员', luxury: '豪华绿钻', vip: '豪华绿钻', svip: '超级会员' }[memberKind], level: 3 }
  const demoAccount = type => ({ uin: '123456789', nickname: '音乐同行者', loginType: type, loggedInAt: Date.now(),
    avatarDataUrl: mode === 'avatar-error' ? 'data:image/png;base64,AAAA' : avatar.toDataURL('image/png'),
    membership: membership.label ? membership : null })
  if (['account', 'avatar-error'].includes(mode) || favoriteMode && favoriteMode !== 'logged-out') account = demoAccount('wx')
  let liked = favoriteMode === 'liked'
  window.previewFavoriteSnapshot = () => favoriteMode ? { state: 'paused', sampledAt: Date.now(),
    track: { songmid: 'fixture-mid', songid: 123, favoriteEligible: true, title: '晴天', artist: '周杰伦', playing: false, positionMs: 42000, durationMs: 269000 },
    lyric: { offset: 0, lines: [{ start: 0, duration: 269000, text: '故事的小黄花，从出生那年就飘着', words: [] }] } } : { state: 'idle', track: null, lyric: null }
  window.previewFavorite = async payload => {
    if (payload.action === 'set') {
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (favoriteMode === 'error') throw Error('保存失败，请检查网络后重试')
      liked = payload.liked
    }
    return { songmid: payload.songmid, status: account ? 'ready' : 'logged-out', liked: account ? liked : null, revision: 'fixture-account' }
  }
  const state = () => structuredClone({ account, login, persistence: 'memory', notice: '界面演示 · 使用模拟账号资料' })
  window.previewAccount = async payload => {
    if (payload.action === 'start') {
      polls = 0
      login = { id: payload.id, type: payload.type, status: 'waiting', imageDataUrl, expiresAt: Date.now() + (mode === 'expired' ? 5000 : 120000), message: '等待扫码' }
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 3000))
      if (mode === 'error' && login) login = { ...login, status: 'error', imageDataUrl: null, message: 'QQ 登录被风控拦截，请尝试微信扫码' }
    } else if (payload.action === 'poll' && login?.id === payload.id && ['waiting', 'scanned'].includes(login.status) && !['waiting', 'expired'].includes(mode)) {
      polls++
      if (polls < 2) login.status = 'scanned', login.message = '已扫码，请在手机上确认'
      else {
        account = demoAccount(login.type)
        login.status = 'success'; login.imageDataUrl = null; login.message = '已登录 QQ 音乐'
      }
    } else if (payload.action === 'cancel' && login?.id === payload.id) login = null
    else if (payload.action === 'logout') account = null, login = null
    return state()
  }
})()
