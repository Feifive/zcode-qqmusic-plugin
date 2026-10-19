// QQ playlist protocol adapted from dsh-music-player (MIT notice: qq-gateway.js).
import { createQQGateway, hash33, joinCookies, parseJsonPreserveBigInt } from './qq-gateway.js'

const PAGE_SIZE = 300, TTL = 10 * 60 * 1000
const midOf = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : ''
const idOf = value => /^\d{1,64}$/.test(String(value ?? '')) && BigInt(value) > 0n ? String(value) : ''

function pageSongs(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 5) return null
  for (const key of ['songlist', 'song_info', 'songInfoList', 'songinfo', 'songs', 'musiclist']) {
    if (Array.isArray(data[key])) return data[key]
  }
  for (const value of Object.values(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = pageSongs(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

function commFor(session) {
  const uin = session.account.uin, key = session.cookies.qm_keyst
  const gtk = hash33(key, 5381)
  return { ct: 11, cv: 14090008, v: 14090008, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
    notice: 0, platform: 'yqq.json', needNewCode: 1, tmeAppID: 'qqmusic', uid: uin, qq: uin, loginUin: uin,
    authst: key, tmeLoginType: key.startsWith('W_X') || session.account.loginType === 'wx' ? '1' : '2',
    g_tk: gtk, g_tk_new_20200303: gtk }
}

export function createQQFavorites({ gateway = createQQGateway(), now = Date.now } = {}) {
  let owner = '', epoch = 0, controller = new AbortController(), cache = null, pending = null, writing = false
  let retryAt = 0, sequence = 0
  const changes = new Map()
  function reset() {
    controller.abort(); controller = new AbortController(); owner = ''; epoch++; cache = pending = null
    writing = false; retryAt = 0; sequence = 0; changes.clear()
  }
  function identify(session) {
    const key = `${session.account.uin}:${session.cookies.qm_keyst}`
    if (owner !== key) { reset(); owner = key }
    return epoch
  }
  function current(ticket) { if (ticket !== epoch) throw Error('登录账号已变化，请重试') }
  function known(track) { return cache.mids.has(track.songmid) || cache.ids.has(String(track.songid)) }
  function state(track, status = 'ready', message = '') {
    return { songmid: track.songmid, status, liked: status === 'ready' ? known(track) : null, message }
  }

  async function call(session, method, param, write = false) {
    const signal = controller.signal
    const module = write ? 'music.musicasset.PlaylistDetailWrite' : 'music.srfDissInfo.DissInfo'
    const body = JSON.stringify({ comm: commFor(session), req_0: { module, method, param } })
    // Writes are deliberately sent once: retrying an ambiguous timeout can
    // race a later action. Read requests may use the alternate QQ gateways.
    const hosts = write ? ['u.y.qq.com'] : ['u.y.qq.com', 'szu.y.qq.com', 'shu.y.qq.com']
    for (const host of hosts) {
      if (signal.aborted) break
      try {
        const result = await gateway.request(`https://${host}/cgi-bin/musicu.fcg`, { method: 'POST', body,
          signal, timeoutMs: 8000, maxBytes: 2 * 1024 * 1024,
          headers: { Cookie: joinCookies(session.cookies), Origin: 'https://y.qq.com', 'Content-Type': 'application/json' } })
        if (result.status !== 200) continue
        const parsed = parseJsonPreserveBigInt(result.text), response = parsed.req_0 || parsed[module]
        if (Number(parsed.code) !== 0 || !response || Number(response.code) !== 0) continue
        if (response.data?.retCode !== undefined && Number(response.data.retCode) !== 0) continue
        return response.data || {}
      } catch { if (signal.aborted) break }
    }
    throw Error(write ? '收藏操作未能确认，请刷新状态后重试' : '读取「我喜欢」失败，请重试；若持续失败请重新登录')
  }

  async function load(session, ticket) {
    const encUin = session.cookies.encrypt_uin || session.cookies.encuin || session.cookies.euin
    if (!encUin && session.account.loginType === 'wx') throw Error('当前微信登录缺少账号标识，请重新扫码')
    const ids = new Set(), mids = new Set(), pages = new Set(), started = sequence
    for (let offset = 0; offset < 30000;) {
      const data = await call(session, 'CgiGetDiss', { disstid: 0, dirid: 201, tag: true, song_begin: offset,
        song_num: PAGE_SIZE, userinfo: true, orderlist: true, enc_host_uin: encUin || session.account.uin })
      current(ticket)
      let songs = pageSongs(data)
      if (!songs && data.total_song_num != null && Number(data.total_song_num) === 0) songs = []
      if (!songs) throw Error('「我喜欢」返回了无法识别的歌曲列表')
      const entries = songs.map(song => song?.songInfo || song?.song_info || song || {})
        .map(song => ({ mid: midOf(song.songmid || song.mid), id: idOf(song.songid || song.id) }))
      if (entries.some(song => !song.mid && !song.id)) throw Error('无法识别「我喜欢」中的歌曲编号')
      const fingerprint = JSON.stringify(entries)
      if (songs.length && pages.has(fingerprint)) throw Error('「我喜欢」分页未能完整读取，请重试')
      pages.add(fingerprint)
      for (const song of entries) { if (song.mid) mids.add(song.mid); if (song.id) ids.add(song.id) }
      const rawTotal = data.total_song_num ?? data.total_song_cnt ?? data.totalSongNum
      const total = rawTotal == null ? null : Number(rawTotal)
      const hasTotal = Number.isSafeInteger(total) && total >= 0
      offset += songs.length
      if (!songs.length && hasTotal && offset < total) throw Error('「我喜欢」分页未能完整读取，请重试')
      if (hasTotal ? offset >= total : songs.length < PAGE_SIZE) {
        // Do not let a read started before a successful write undo that write.
        for (const [mid, change] of changes) {
          if (change.sequence > started || now() - change.at < 5000) {
            if (change.liked) { mids.add(mid); ids.add(change.id) } else { mids.delete(mid); ids.delete(change.id) }
          } else changes.delete(mid)
        }
        current(ticket); cache = { ids, mids, expiresAt: now() + TTL }; retryAt = 0
        return
      }
    }
    throw Error('「我喜欢」歌曲过多，未能完整确认收藏状态')
  }

  async function status(session, track, force = false) {
    const ticket = identify(session)
    if (cache && now() < cache.expiresAt && !force) return state(track)
    if (now() < retryAt && !force) return state(track, 'error', '收藏状态暂时不可用，点击重试')
    if (!pending) {
      const task = load(session, ticket).finally(() => { if (pending === task) pending = null })
      pending = task
    }
    try { await pending; current(ticket); return state(track) }
    catch (error) { current(ticket); retryAt = now() + 30000; return state(track, 'error', error.message) }
  }

  async function set(session, track, liked) {
    const ticket = identify(session)
    if (writing) throw Error('正在保存收藏，请稍后再试')
    writing = true
    try {
      const before = await status(session, track)
      current(ticket)
      if (before.status !== 'ready') throw Error(before.message)
      if (before.liked === liked) return before
      const songId = Number(track.songid), songType = Number(track.songtype || 0)
      if (!Number.isSafeInteger(songId) || songId <= 0 || !Number.isInteger(songType) || songType < 0 || songType > 100) throw Error('缺少有效歌曲编号，无法收藏')
      await call(session, liked ? 'AddSonglist' : 'DelSonglist', { dirId: 201, tid: 0, bFmtUtf8: true,
        v_songInfo: [{ songId, songType }] }, true)
      current(ticket)
      if (liked) { cache.mids.add(track.songmid); cache.ids.add(String(songId)) }
      else { cache.mids.delete(track.songmid); cache.ids.delete(String(songId)) }
      changes.set(track.songmid, { id: String(songId), liked, sequence: ++sequence, at: now() })
      cache.expiresAt = now() + TTL
      return state(track)
    } catch (error) { if (ticket === epoch && cache) cache.expiresAt = 0; throw error }
    finally { if (ticket === epoch) writing = false }
  }
  return { status, set, reset }
}
