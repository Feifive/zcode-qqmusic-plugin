/**
 * QQ Music lookups used by the lyric dock: turn a now-playing title/artist into
 * a song identity, then fetch its timestamped lyric — word by word when QQ
 * Music serves a QRC, line by line otherwise.
 *
 * These are the public web endpoints y.qq.com itself calls. They only answer
 * when the request looks like a y.qq.com page load, so the referer and user
 * agent below are part of the protocol, not cosmetic headers.
 */

import { decryptQrc, parseQrc } from './qrc.js'

const REFERER = 'https://y.qq.com/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  referer: REFERER,
  'user-agent': USER_AGENT,
  accept: 'application/json, text/plain, */*',
}

/** Sentinel the resolvers use for "the service answered, but knows nothing". */
export const NOT_FOUND = null

/**
 * Minimum resemblance for an accepted search hit. An exact title scores 100 and
 * a matching artist 60, so anything below this matched neither.
 */
const MIN_MATCH_SCORE = 40

async function getText(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal })
    if (!response.ok) throw new Error(`QQ Music responded ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, timeoutMs) {
  const text = await getText(url, timeoutMs)
  return JSON.parse(text)
}

/** Case/space/parenthetical-insensitive comparison form of a title or name. */
export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・,，.。!！?？'"“”‘’\-_/]/g, '')
    .trim()
}

// Keep edition words in titles: Live, instrumental and Remix recordings are
// different tracks, even when their parenthesized labels look like decoration.
export function normalizeTitle(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')
}

function singersOf(song) {
  const names = Array.isArray(song?.singer) ? song.singer.map(entry => entry?.name ?? '')
    : typeof song?.singer === 'string' ? [song.singer] : []
  // Search results can put all performers in one singer.name field.
  // Do not split '/' — it is part of real names such as K/DA and AC/DC.
  return names.flatMap(name => name.split(/[;；]/)).map(name => name.trim()).filter(Boolean)
}

/**
 * How much a candidate song name resembles the wanted title.
 * 100 = same name, 45 = the candidate carries extra words ("晴天 (Live)"),
 * 30 = the candidate is a shorter fragment of the wanted title (ranking only).
 */
function nameScore(songName, wantedName) {
  if (!songName || !wantedName) return 0
  if (songName === wantedName) return 100
  const candidateIsLonger = songName.length > wantedName.length
  const short = candidateIsLonger ? wantedName : songName
  const long = candidateIsLonger ? songName : wantedName
  if (short.length < Math.max(2, Math.ceil(long.length * 0.6))) return 0
  if (!long.includes(short)) return 0
  return candidateIsLonger ? 45 : 30
}

function scoreCandidate(song, title, artist, index, total, durationMs, album) {
  const songName = normalizeName(song?.songname ?? song?.name)
  const wantedName = normalizeName(title)
  const singers = singersOf(song).map(normalizeName)
  const wantedArtist = normalizeName(artist)

  const similarity = nameScore(songName, wantedName)
  let score = similarity + Math.max(0, 10 - index) * 2
  if (normalizeTitle(song?.songname ?? song?.name) === normalizeTitle(title)) score += 40
  else if (similarity === 100) score -= 40
  if (wantedArtist) {
    const wantedArtists = singersOf({ singer: artist }).map(normalizeName)
    if (wantedArtists.every(name => singers.includes(name))) score += 60
    else if (singers.some((name) => name.includes(wantedArtist) || wantedArtist.includes(name))) score += 25
  }
  const seconds = Number(song?.interval ?? song?.duration)
  if (durationMs > 0 && seconds > 0) {
    const delta = Math.abs(seconds * 1000 - durationMs)
    if (delta <= 2000) score += 20
    else if (delta > Math.max(10000, durationMs * .1)) score -= 35
  }
  if (album && normalizeTitle(song?.albumname ?? song?.album?.name) === normalizeTitle(album)) score += 10
  // A slightly later exact match beats an earlier cover.
  if (total > 0) score -= index / total
  return { score, similarity }
}

/**
 * Find the songmid for a now-playing track.
 * @returns {Promise<{songmid: string, name: string, singer: string} | null>}
 */
export async function searchSong({ title, artist, durationMs, album }, options = {}) {
  const query = [title, artist].filter((part) => part && String(part).trim()).join(' ').trim()
  if (!query) return NOT_FOUND
  const timeoutMs = options.timeoutMs ?? 7000
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&inCharset=utf-8&outCharset=utf-8' +
    `&p=1&n=8&w=${encodeURIComponent(query)}`
  const body = await getJson(url, timeoutMs)
  const list = body?.data?.song?.list
  if (!Array.isArray(list) || list.length === 0) return NOT_FOUND

  let best = null
  let bestScore = -Infinity
  let bestSimilarity = 0
  list.forEach((song, index) => {
    if (!song?.songmid) return
    const ranked = scoreCandidate(song, title, artist, index, list.length, durationMs, album)
    if (ranked.score > bestScore) {
      bestScore = ranked.score
      bestSimilarity = ranked.similarity
      best = song
    }
  })
  // Search always answers something; below this threshold the "best" result is
  // unrelated, and showing its lyrics would be worse than showing none.
  if (!best || bestSimilarity < MIN_MATCH_SCORE) return NOT_FOUND
  return {
    songmid: String(best.songmid),
    songid: Number.isSafeInteger(Number(best.songid)) ? Number(best.songid) : 0,
    songtype: Number.isInteger(Number(best.songtype)) ? Number(best.songtype) : 0,
    albumMid: String(best.albummid ?? best.album?.mid ?? ''),
    album: String(best.albumname ?? best.album?.name ?? ''),
    durationMs: Math.max(0, Number(best.interval ?? best.duration) || 0) * 1000,
    name: String(best.songname ?? best.name ?? ''),
    singer: singersOf(best).join(' / '),
  }
}

/**
 * Fetch word-by-word QRC lyrics as timed lines.
 *
 * The response contains an XML document. For `encode="1"`, convert the
 * hexadecimal payload before parsing its line and word timestamps.
 *
 * @returns {Promise<{offset: number, kind: 'qrc', lines: Array<object>} | null>}
 */
export async function fetchWordLyric(songid, options = {}) {
  if (!songid) return NOT_FOUND
  const timeoutMs = options.timeoutMs ?? 8000
  const url =
    'https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg?version=15&miniversion=82&lrctype=4&g_tk=5381' +
    `&musicid=${encodeURIComponent(songid)}`
  let xml
  try {
    xml = await getText(url, timeoutMs)
  } catch {
    return NOT_FOUND
  }
  const content = /<content[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/i.exec(xml)
  if (!content) return NOT_FOUND
  const payload = content[1].trim()
  if (payload === '') return NOT_FOUND

  const looksHex = /^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0 && payload.length >= 16
  const text = looksHex ? decryptQrc(payload) : payload
  const lines = parseQrc(text)
  if (lines.length === 0) return NOT_FOUND
  return { offset: 0, kind: 'qrc', lines }
}

/**
 * Fetch and parse the line-level (LRC) lyric for a songmid.
 * @returns {Promise<{offset: number, lines: Array<[number, string]>} | null>}
 */
export async function fetchLyric(songmid, options = {}) {
  if (!songmid) return NOT_FOUND
  const timeoutMs = options.timeoutMs ?? 7000
  const url =
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1&g_tk=5381' +
    `&songmid=${encodeURIComponent(songmid)}`
  const body = await getJson(url, timeoutMs)
  const lrc = typeof body?.lyric === 'string' ? body.lyric : ''
  if (!lrc.trim()) return NOT_FOUND
  const parsed = parseLrc(lrc)
  if (parsed.lines.length === 0) return NOT_FOUND
  return parsed
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[(ti|ar|al|by|re|ve|length|offset|kana):([^\]]*)\]$/i

function fractionToMs(digits) {
  if (digits === undefined) return 0
  if (digits.length === 1) return Number(digits) * 100
  if (digits.length === 2) return Number(digits) * 10
  return Number(digits.slice(0, 3))
}

/**
 * Parse an LRC body into sorted `[milliseconds, text]` pairs.
 * Lines carrying only metadata tags (`[ti:]`, `[offset:]`, …) are consumed as
 * metadata; a line may carry several timestamps (repeated chorus lines).
 */
export function parseLrc(lrc) {
  let offset = 0
  const lines = []

  for (const rawLine of String(lrc).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const meta = META_TAG.exec(line)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const parsed = Number.parseInt(meta[2].trim(), 10)
        if (Number.isFinite(parsed)) offset = parsed
      }
      continue
    }

    TIME_TAG.lastIndex = 0
    const stamps = []
    let match
    while ((match = TIME_TAG.exec(line)) !== null) {
      stamps.push(Number(match[1]) * 60_000 + Number(match[2]) * 1000 + fractionToMs(match[3]))
    }
    if (stamps.length === 0) continue

    const text = line.replace(TIME_TAG, '').trim()
    for (const at of stamps) lines.push([at, text])
  }

  lines.sort((left, right) => left[0] - right[0])
  return { offset, lines }
}

/**
 * Index of the line that should be on screen at `positionMs`, or -1 before the
 * first line starts.
 */
export function lyricIndexAt(lines, positionMs) {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle][0] <= positionMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}
