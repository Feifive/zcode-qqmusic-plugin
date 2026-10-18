/**
 * Turns a media-session sample into the payload the dock renders.
 *
 * Pure decision logic on top of the two resolvers (title/artist -> songmid,
 * songmid -> lyric), so it can be exercised without a running Harness.
 */

import { fetchLyric, fetchWordLyric, normalizeName, normalizeTitle, searchSong } from './qqmusic.js'
import { pickSession, splitTitle } from './nowplaying.js'

const HIT_TTL_MS = 30 * 60 * 1000
const MISS_TTL_MS = 5 * 60 * 1000
const LYRIC_TTL_MS = 6 * 60 * 60 * 1000
const STALE_SAMPLE_MS = 12_000
const MAX_ENTRIES = 300
const UNAVAILABLE_ERRORS = new Set(['winrt-unavailable', 'smtc-unavailable', 'powershell-not-found'])

function remember(map, key, value, ttl) {
  map.set(key, { value, at: Date.now(), ttl })
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
}

function recall(map, key) {
  const entry = map.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > entry.ttl) {
    map.delete(key)
    return undefined
  }
  return entry.value
}

export function createPlaybackReporter({ options, log = () => {}, now = () => Date.now() }) {
  const songs = new Map()
  const lyricBodies = new Map()
  const inflight = new Map()

  function resolveSong(track) {
    const key = `${normalizeTitle(track.title)}|${normalizeName(track.artist)}|${normalizeTitle(track.album)}|${Math.round((track.durationMs || 0) / 1000)}`
    const cached = recall(songs, key)
    if (cached !== undefined) return Promise.resolve(cached.songmid ? cached : null)

    const pending = inflight.get(key)
    if (pending !== undefined) return pending

    const lookup = searchSong(track)
      .then((match) => {
        remember(songs, key, match ?? { songmid: '' }, match ? HIT_TTL_MS : MISS_TTL_MS)
        return match
      })
      .catch((error) => {
        log(`search failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      .finally(() => inflight.delete(key))

    inflight.set(key, lookup)
    return lookup
  }

  function resolveLyric(match) {
    const songmid = match.songmid
    const key = `lyric:${songmid}`
    const cached = recall(lyricBodies, songmid)
    if (cached !== undefined) return Promise.resolve(cached.lines.length > 0 ? cached : null)

    const pending = inflight.get(key)
    if (pending !== undefined) return pending

    const lookup = (async () => {
      // Word-level QRC first: it is the same song, just a richer timing map.
      if (match.songid) {
        try {
          const word = await fetchWordLyric(match.songid)
          if (word !== null) return word
        } catch (error) {
          log(`qrc failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const parsed = await fetchLyric(songmid)
      if (parsed === null) return null
      const lines = parsed.lines.map(([start, text], index) => {
        const next = parsed.lines[index + 1]
        return { start, duration: next ? Math.max(0, next[0] - start) : 0, text, words: [] }
      })
      return { offset: parsed.offset, kind: 'lrc', lines }
    })()
      .then((parsed) => {
        remember(lyricBodies, songmid, parsed ?? { offset: 0, kind: 'lrc', lines: [] }, parsed ? LYRIC_TTL_MS : MISS_TTL_MS)
        return parsed
      })
      .catch((error) => {
        log(`lyric failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      .finally(() => inflight.delete(key))

    inflight.set(key, lookup)
    return lookup
  }

  async function report(sample) {
    const base = {
      state: 'idle',
      pollMs: options.pollMs,
      sampledAt: (sample && sample.at) || 0,
      track: null,
      lyric: null,
      error: null,
    }

    if (!sample) return { ...base, state: 'starting' }
    if (sample.error && UNAVAILABLE_ERRORS.has(sample.error)) {
      return { ...base, state: 'unavailable', error: sample.error }
    }
    if (!sample.at) return { ...base, state: 'starting' }
    if (now() - sample.at > STALE_SAMPLE_MS) return { ...base, state: 'unavailable', error: 'stale-session' }

    const session = pickSession(sample.sessions, options)
    if (session === null) return base

    const { title, artist } = splitTitle(session.title, session.artist)
    if (!title) return base

    const playing = String(session.status ?? '').toLowerCase() === 'playing'
    const track = {
      title,
      artist,
      album: String(session.album ?? ''),
      app: String(session.app ?? ''),
      playing,
      positionMs: Number.isFinite(session.position) ? Math.max(0, session.position) : 0,
      durationMs: Number.isFinite(session.duration) ? Math.max(0, session.duration) : 0,
      // Offer seeking for a known duration; confirm support from the result.
      seekable: session.seek === true || (Number.isFinite(session.duration) && session.duration > 0),
    }
    const payload = { ...base, state: playing ? 'playing' : 'paused', track }

    let match = await resolveSong(track)
    if (match === null && track.artist) {
      // Some players expose only a title; retry without the artist before giving up.
      match = await resolveSong({ ...track, artist: '' })
    }
    if (match === null) return { ...payload, state: 'no-match' }

    track.songmid = match.songmid
    track.albumMid = match.albumMid || ''
    if (!track.artist && match.singer) track.artist = match.singer

    const parsed = await resolveLyric(match)
    if (parsed === null || parsed.lines.length === 0) return { ...payload, state: 'no-lyric' }

    return {
      ...payload,
      lyric: {
        mid: match.songmid,
        kind: parsed.kind,
        offset: parsed.offset,
        lines: parsed.lines,
        index: lineIndexAt(parsed.lines, track.positionMs - parsed.offset),
      },
    }
  }

  return { report }
}

/** Index of the last line whose start time has passed, or -1. */
function lineIndexAt(lines, positionMs) {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].start <= positionMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}
