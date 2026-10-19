import { createQQGateway, parseJsonPreserveBigInt } from './qq-gateway.js'
import { matchesSongMetadata, songFields, searchSong, parseLyricText } from './qqmusic.js'
import { decryptQrc } from './qrc.js'

const encode = value => Buffer.from(String(value || ''), 'utf8').toString('base64')
const validID = value => ['number', 'string'].includes(typeof value) && /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0

function bundledLyric(data) {
  try {
    if (typeof data.lyric !== 'string' || data.lyric.length > 131072) return null
    if (data.crypt === 1) {
      if (!/^[0-9a-f]+$/i.test(data.lyric) || data.lyric.length % 16) return null
      return parseLyricText(decryptQrc(data.lyric))
    }
    if (data.crypt !== 0) return null
    return parseLyricText(data.lyric) || parseLyricText(Buffer.from(data.lyric, 'base64').toString('utf8'))
  } catch { return null }
}

// Public metadata only: this resolver never receives account cookies. Every
// returned identity is checked against authoritative details for that exact ID.
export function createSongResolver({ gateway = createQQGateway(), search = searchSong, timeoutMs = 4000 } = {}) {
  return async track => {
    if ([track?.title, track?.artist, track?.album ?? ''].some(value => typeof value !== 'string' || value.length > 1024)
      || !track.title.trim() || !track.artist.trim()) return null
    const details = new Map()
    async function detail(id) {
      if (!validID(id)) return null
      id = Number(id)
      if (!details.has(id)) details.set(id, (async () => {
        const result = await gateway.request(`https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songid=${id}&format=json`,
          { timeoutMs, maxBytes: 1024 * 1024 })
        if (result.status !== 200) throw Error('Song detail unavailable')
        const body = parseJsonPreserveBigInt(result.text)
        if (body.code !== 0 || !Array.isArray(body.data)) return null
        const raw = body.data.find(song => validID(song?.id ?? song?.songid) && Number(song.id ?? song.songid) === id)
        const song = songFields(raw)
        return song && matchesSongMetadata(track, song) ? song : null
      })())
      return details.get(id)
    }
    try {
      const result = await gateway.request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST', timeoutMs, maxBytes: 1024 * 1024, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comm: { ct: 6, cv: 80600, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0 },
          req_0: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: {
            songName: encode(track.title), singerName: encode(track.artist), albumName: encode(track.album),
            interval: Number.isFinite(track.durationMs) && track.durationMs > 0 ? Math.round(track.durationMs / 1000) : 0,
            ct: 6, cv: 80600, crypt: 1, qrc: 1,
          } } }),
      })
      if (result.status === 200) {
        const body = parseJsonPreserveBigInt(result.text), data = body.req_0?.data
        if (body.code === 0 && body.req_0?.code === 0 && validID(data?.songID)) {
          const song = await detail(data.songID)
          if (song) return { ...song, verified: true, matchSource: 'metadata', lyric: bundledLyric(data) }
        }
      }
    } catch { /* A failed metadata match may still have an exact search result. */ }
    const candidate = await search(track, { timeoutMs })
    if (!candidate || !matchesSongMetadata(track, candidate)) return null
    try {
      const song = await detail(candidate.songid)
      return song ? { ...song, verified: true, matchSource: 'search', lyric: null } : null
    } catch { throw Error('Song identity verification unavailable') }
  }
}
