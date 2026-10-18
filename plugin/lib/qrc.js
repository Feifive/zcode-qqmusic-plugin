/**
 * QQ Music QRC (word-by-word lyric) decoding.
 *
 * The payload QQ Music serves for karaoke lyrics is not LRC: it is a hex cipher
 * that decrypts into a zlib stream holding a text document whose lines look like
 *
 *   [startMs,durationMs](wordStartMs,wordDurationMs)word(…)(…)…
 *
 * The cipher is a DES-family construction with three fixed 8-byte keys applied
 * as D(K3) → E(K2) → D(K1). It differs from textbook DES in its bit ordering, so
 * this module implements the rounds on plain bit arrays: slower than a table
 * implementation, but the result is read once per song and cached.
 *
 * The permutations below are the public DES constants (S/E/P) plus the
 * interoperability tables for this variant; the round wiring is standard Feistel.
 */

import { inflateSync } from 'node:zlib'

const KEY_K1 = Buffer.from('!@#)(*$%', 'latin1')
const KEY_K2 = Buffer.from('123ZXC!@', 'latin1')
const KEY_K3 = Buffer.from('!@#)(NHL', 'latin1')

const SBOX = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

const E_BOX = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
]

const P_BOX = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
]

// Key-schedule halves in this variant's virtual bit space.
const PC1_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35]
const PC1_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3]
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]

// Compression table is zero-based; the D half is consumed one slot earlier than
// the textbook schedule would (interoperability quirk of this variant).
const PC2 = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26,
  19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33,
  52, 45, 41, 49, 35, 28, 31,
]

// Block permutations, one-based over a big-endian 64-bit block.
const IP = [
  34, 42, 50, 58, 2, 10, 18, 26, 36, 44, 52, 60, 4, 12, 20, 28,
  38, 46, 54, 62, 6, 14, 22, 30, 40, 48, 56, 64, 8, 16, 24, 32,
  33, 41, 49, 57, 1, 9, 17, 25, 35, 43, 51, 59, 3, 11, 19, 27,
  37, 45, 53, 61, 5, 13, 21, 29, 39, 47, 55, 63, 7, 15, 23, 31,
]

const FP = [
  37, 5, 45, 13, 53, 21, 61, 29, 38, 6, 46, 14, 54, 22, 62, 30,
  39, 7, 47, 15, 55, 23, 63, 31, 40, 8, 48, 16, 56, 24, 64, 32,
  33, 1, 41, 9, 49, 17, 57, 25, 34, 2, 42, 10, 50, 18, 58, 26,
  35, 3, 43, 11, 51, 19, 59, 27, 36, 4, 44, 12, 52, 20, 60, 28,
]

/** Read the key as 64 virtual bits ordered by two little-endian 32-bit words. */
function keyBitStream(key) {
  const bits = new Array(64)
  for (let position = 0; position < 64; position += 1) {
    const word = position >>> 5
    const within = position & 31
    const byte = word * 4 + 3 - (within >>> 3)
    const bit = 7 - (within & 7)
    bits[position] = (key[byte] >>> bit) & 1
  }
  return bits
}

function rotateLeft(bits, count) {
  const out = new Array(bits.length)
  for (let i = 0; i < bits.length; i += 1) out[i] = bits[(i + count) % bits.length]
  return out
}

/** Expand one 8-byte key into sixteen 48-bit round keys (reverse order for decrypt). */
function roundKeys(key, direction) {
  const stream = keyBitStream(key)
  let c = PC1_C.map((index) => stream[index])
  let d = PC1_D.map((index) => stream[index])
  const keys = []
  for (let round = 0; round < 16; round += 1) {
    c = rotateLeft(c, SHIFTS[round])
    d = rotateLeft(d, SHIFTS[round])
    const schedule = new Array(48)
    for (let i = 0; i < 48; i += 1) {
      const position = PC2[i]
      if (position < 28) schedule[i] = c[position]
      else {
        const index = position - 27
        schedule[i] = index < 28 ? d[index] : 0
      }
    }
    keys.push(schedule)
  }
  return direction === 'd' ? keys.reverse() : keys
}

function feistel(right, schedule) {
  const expanded = new Array(48)
  for (let i = 0; i < 48; i += 1) expanded[i] = right[E_BOX[i] - 1] ^ schedule[i]
  const mixed = new Array(32)
  for (let group = 0; group < 8; group += 1) {
    const offset = group * 6
    const row = (expanded[offset] << 1) | expanded[offset + 5]
    const column =
      (expanded[offset + 1] << 3) | (expanded[offset + 2] << 2) | (expanded[offset + 3] << 1) | expanded[offset + 4]
    const value = SBOX[group][row * 16 + column]
    mixed[group * 4] = (value >>> 3) & 1
    mixed[group * 4 + 1] = (value >>> 2) & 1
    mixed[group * 4 + 2] = (value >>> 1) & 1
    mixed[group * 4 + 3] = value & 1
  }
  return P_BOX.map((index) => mixed[index - 1])
}

function cryptBlock(input, keys) {
  const block = new Array(64)
  for (let i = 0; i < 8; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) block[i * 8 + bit] = (input[i] >>> (7 - bit)) & 1
  }
  const permuted = IP.map((index) => block[index - 1])
  let left = permuted.slice(0, 32)
  let right = permuted.slice(32)

  for (let round = 0; round < 15; round += 1) {
    const fed = feistel(right, keys[round])
    const next = left.map((bit, i) => bit ^ fed[i])
    left = right
    right = next
  }
  const last = feistel(right, keys[15])
  left = left.map((bit, i) => bit ^ last[i])

  const merged = left.concat(right)
  const final = FP.map((index) => merged[index - 1])
  const out = Buffer.alloc(8)
  for (let i = 0; i < 64; i += 1) if (final[i]) out[i >> 3] |= 1 << (7 - (i & 7))
  return out
}

/**
 * Decrypt one hex payload into the QRC document text.
 * @param {string} hex encrypted bytes as served by QQ Music
 * @returns {string} the decrypted QRC text
 */
export function decryptQrc(hex) {
  if (typeof hex !== 'string' || hex.trim() === '') throw new Error('qrc: empty payload')
  const cipher = Buffer.from(hex.trim(), 'hex')
  if (cipher.length === 0 || cipher.length % 8 !== 0) throw new Error('qrc: payload is not block aligned')

  const keys3 = roundKeys(KEY_K3, 'd')
  const keys2 = roundKeys(KEY_K2, 'e')
  const keys1 = roundKeys(KEY_K1, 'd')
  const plain = Buffer.alloc(cipher.length)
  for (let offset = 0; offset < cipher.length; offset += 8) {
    const first = cryptBlock(cipher.subarray(offset, offset + 8), keys3)
    const second = cryptBlock(first, keys2)
    cryptBlock(second, keys1).copy(plain, offset)
  }

  let inflated = inflateSync(plain)
  if (inflated.length >= 3 && inflated[0] === 0xef && inflated[1] === 0xbb && inflated[2] === 0xbf) {
    inflated = inflated.subarray(3)
  }
  return inflated.toString('utf8')
}

const LINE = /^\[(\d+),(\d+)\](.*)$/
const STAMP = /\((\d+),(\d+)\)/g

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * Parse QRC text into timed lines with per-word spans.
 *
 * In QRC a timestamp trails the glyph it times — `晴(0,160)天(160,160)` means
 * 晴 starts at 0 and 天 at 160 — so the run of text before each stamp is that
 * word, and anything after the final stamp has no word timing of its own.
 *
 * @param {string} text decrypted QRC document
 * @returns {Array<{start: number, duration: number, text: string, words: Array<{start: number, duration: number, text: string}>}>}
 */
export function parseQrc(text) {
  const lines = []
  for (const raw of unescapeXml(String(text ?? '')).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const match = LINE.exec(line)
    if (!match) continue

    const start = Number(match[1])
    const duration = Number(match[2])
    if (!Number.isFinite(start) || !Number.isFinite(duration)) continue

    const body = match[3]
    const stamps = []
    STAMP.lastIndex = 0
    let found
    while ((found = STAMP.exec(body)) !== null) {
      stamps.push({ at: found.index, end: found.index + found[0].length, start: Number(found[1]), duration: Number(found[2]) })
    }

    if (stamps.length === 0) {
      const lineText = body.trim()
      if (lineText !== '') lines.push({ start, duration, text: lineText, words: [] })
      continue
    }

    const words = []
    let cursor = 0
    for (const stamp of stamps) {
      const token = body.slice(cursor, stamp.at)
      cursor = stamp.end
      words.push({ start: stamp.start, duration: stamp.duration, text: token })
    }
    const tail = body.slice(cursor)

    const plain = words.map((word) => word.text).join('') + tail
    const lineText = plain.trim()
    // Drop the leading empty segment some lines carry before their first glyph.
    const timed = words.filter((word) => word.text !== '')
    if (lineText === '' && timed.length === 0) continue
    lines.push({ start, duration, text: lineText, words: timed })
  }
  return lines
}
