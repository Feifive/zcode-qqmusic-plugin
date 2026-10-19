import { execFile } from 'node:child_process'
import { stat as fileStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_ROWS = 64, MAX_DURATION = 86400000
const text = value => typeof value === 'string' && value.length <= 1024 && !value.includes('\0')
const comparison = value => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
// Local data has newline-separated performers. Keep punctuation and aliases:
// removing them could merge distinct performers or recording versions.
const artists = value => [...new Set(value.split(/\r?\n|[;；]|\s+\/\s+/u).map(comparison).filter(Boolean))].sort()
const sameArtists = (a, b) => JSON.stringify(artists(a)) === JSON.stringify(artists(b))
const mid = value => typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value)
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_DURATION

function usableTrack(track) {
  return track?.app === 'com.tencent.QQMusicMac'
    && [track.title, track.artist, track.album].every(value => text(value) && value.trim())
    && artists(track.artist).length > 0
    && duration(track.durationMs)
}

export function selectLocalSong(track, rows) {
  if (!usableTrack(track) || !Array.isArray(rows) || rows.length > MAX_ROWS) return null
  const matches = new Map()
  for (const row of rows) {
    if (!row || ![row.name, row.singer, row.album].every(text)) return null
    if (comparison(row.name) !== comparison(track.title) || !sameArtists(row.singer, track.artist)
      || comparison(row.album) !== comparison(track.album)) continue
    // A matching but incomplete record cannot safely be ignored in favour of
    // another ID. No guessed duration, album mid or unsupported storage type.
    if (!duration(row.durationMs)) return null
    // MediaRemote duration may be rounded to seconds; use a tighter bound than
    // online matching because all four fields are mandatory on this path.
    if (Math.abs(row.durationMs - track.durationMs) > 1000) continue
    const id = row.songid
    if (!['string', 'number'].includes(typeof id) || !/^\d{1,16}$/.test(String(id))
      || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
      || !mid(row.songmid) || !mid(row.albumMid) || row.storageType !== 13) return null
    // SONGS.type=13 is the observed desktop storage kind for ordinary QQ
    // tracks; the playlist web API calls these songType=0, not 13.
    const song = { songid: Number(id), songmid: row.songmid, albumMid: row.albumMid, songtype: 0,
      name: row.name, singer: artists(row.singer).join(' / '), album: row.album, durationMs: row.durationMs,
      verified: true, matchSource: 'local', lyric: null }
    const previous = matches.get(song.songid)
    if (previous && JSON.stringify(previous) !== JSON.stringify(song)) return null
    matches.set(song.songid, song)
  }
  return matches.size === 1 ? matches.values().next().value : null
}

export function createLocalSongReader({ reader, helper, run = execFile, stat = fileStat, now = Date.now } = {}) {
  if (!reader || !helper) throw Error('Missing local song helper path')
  const database = join(homedir(), 'Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac/qqmusic.sqlite')
  let cached = null, pending = null
  async function fingerprint() {
    try {
      const base = await stat(database)
      let wal = null
      try { wal = await stat(database + '-wal') } catch (error) { if (error.code !== 'ENOENT') return null }
      return JSON.stringify([base, wal].map(s => s ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs] : null))
    } catch { return null }
  }
  function query(title) {
    return new Promise(resolve => {
      try {
        const child = run('/usr/bin/perl', [reader, helper], {
          env: { ...process.env, ZCODE_MUSIC_ACTION: 'local-song' }, timeout: 1500, maxBuffer: 1024 * 1024,
        }, (error, stdout) => {
          try {
            if (error) throw error
            const result = JSON.parse(stdout)
            resolve(!result.error && result.schema === 'qqmusic-songs-v1' && Array.isArray(result.songs)
              && result.songs.length <= MAX_ROWS ? result.songs : null)
          } catch { resolve(null) }
        })
        child.stdin.on('error', () => resolve(null))
        child.stdin.end(JSON.stringify({ title }))
      } catch { resolve(null) }
    })
  }
  return async track => {
    if (!usableTrack(track)) return null
    const signature = await fingerprint()
    if (signature === null) { cached = null; return null }
    const key = JSON.stringify([signature, track.title])
    if (cached?.key === key && now() - cached.at < 10000) return selectLocalSong(track, cached.rows)
    if (pending?.key === key) return selectLocalSong(track, await pending.task)
    const task = (async () => {
      const rows = await query(track.title)
      // Do not cache a result across a concurrent database replacement/write.
      if (rows === null || await fingerprint() !== signature) return null
      cached = { key, rows, at: now() }
      return rows
    })()
    const job = { key, task }; pending = job
    try { return selectLocalSong(track, await task) }
    finally { if (pending === job) pending = null }
  }
}
