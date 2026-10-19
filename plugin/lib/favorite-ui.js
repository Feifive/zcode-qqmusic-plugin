// Renderer state only. Account credentials and the playlist live in main.
export function createFavoriteState({ request, onChange = () => {}, onNotice = () => {}, now = Date.now }) {
  let key = '', songmid = '', generation = 0, operation = 0, checkedAt = -Infinity
  let reading = false, writing = false, disposed = false
  let value = { status: 'unavailable', liked: null, message: '暂无可收藏的歌曲' }
  const notify = () => { if (!disposed) onChange(view()) }
  const messageOf = error => String(error?.message || '收藏操作失败，请重试')
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  function view() {
    const label = writing ? '正在保存收藏…' : value.status === 'ready'
      ? value.liked ? '取消喜欢' : '加入我喜欢'
      : value.status === 'logged-out' ? '登录 QQ 音乐后收藏'
      : value.status === 'loading' ? '正在读取收藏状态…'
      : value.status === 'error' ? `${value.message}；点击刷新状态` : value.message
    return { ...value, busy: writing || reading, disabled: writing || ['unavailable', 'loading'].includes(value.status), label }
  }
  function accept(result) {
    if (result?.songmid !== songmid || !['ready', 'logged-out', 'unavailable', 'error'].includes(result.status)
      || result.status === 'ready' && typeof result.liked !== 'boolean') throw Error('收藏状态未能确认，请重试')
    value = { ...result, liked: result.status === 'error' ? value.liked : result.liked,
      message: result.message || (result.status === 'error' ? '收藏状态暂时不可用' : '') }
  }
  async function read(force = false) {
    if (disposed || reading || writing || !songmid || value.status === 'unavailable') return
    const ticket = generation, order = ++operation
    reading = true; checkedAt = now()
    try {
      const result = await request({ action: 'status', songmid, force })
      if (disposed || ticket !== generation || order !== operation) return
      accept(result)
    } catch (error) {
      if (disposed || ticket !== generation || order !== operation) return
      value = { ...value, status: 'error', message: messageOf(error) }
    } finally {
      if (ticket === generation && order === operation) { reading = false; notify() }
    }
  }
  function sync(snapshot, demo = false) {
    if (disposed) return
    const track = snapshot?.track
    const available = !demo && snapshot?.enabled !== false && snapshot?.state !== 'disabled' && track?.favoriteEligible === true && Boolean(track?.songmid)
    const nextKey = `${available}:${demo}:${track?.songmid || ''}:${track?.title || ''}:${track?.artist || ''}`
    if (key !== nextKey) {
      key = nextKey; generation++; operation++; reading = writing = false; checkedAt = -Infinity
      songmid = available ? track.songmid : ''
      value = available ? { status: 'loading', liked: null, message: '' }
        : { status: 'unavailable', liked: null, message: demo ? '预览歌曲不能收藏' : '未能准确匹配 QQ 音乐歌曲，暂不能收藏' }
      notify()
    }
    if (available && now() - checkedAt >= 5000) void read()
  }
  async function click() {
    if (disposed || view().disabled || writing) return
    if (value.status === 'logged-out') { onNotice('请在下方登录 QQ 音乐后收藏'); return }
    if (value.status === 'error') { await read(true); return }
    if (value.status !== 'ready') return
    const before = { ...value }, ticket = generation, order = ++operation
    reading = false; writing = true
    value = { ...value, liked: !before.liked }; notify()
    try {
      const result = await request({ action: 'set', songmid, liked: value.liked, revision: before.revision })
      if (disposed || ticket !== generation || order !== operation) return
      accept(result)
      if (result.status !== 'ready') onNotice(result.message || '请重新确认收藏状态')
    } catch (error) {
      if (disposed || ticket !== generation || order !== operation) return
      value = { ...before, status: 'error', message: messageOf(error) }
      onNotice(value.message)
    } finally {
      if (ticket === generation && order === operation) { writing = false; checkedAt = now(); notify() }
    }
  }
  return { sync, click, view, invalidate() { key = ''; generation++; reading = writing = false },
    dispose() { disposed = true; generation++ } }
}
