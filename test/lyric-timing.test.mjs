import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wordTextRanges, sweepPositionAt, followWordOffset } from '../plugin/lyric-timing.js'

test('QRC text ranges preserve UTF-16 offsets, spaces, punctuation and trimmed edges', () => {
  const words = [
    { text: '  你', start: 0, duration: 100 },
    { text: '好😀, ', start: 100, duration: 100 },
    { text: 'world  ', start: 200, duration: 100 },
  ]
  const text = '你好😀, world'
  const ranges = wordTextRanges(text, words)
  assert.deepEqual(ranges.map(range => text.slice(range.from, range.to)), ['你', '好😀, ', 'world'])
  assert.deepEqual(ranges.map(range => [range.from, range.to]), [[0, 1], [1, 6], [6, 11]])
})
test('unequal English glyph widths use their measured pixel boundaries', () => {
  const words = [
    { start: 0, duration: 1000, left: 0, right: 90 }, // WWW
    { start: 1000, duration: 1000, left: 90, right: 105 }, // iii
  ]
  assert.equal(sweepPositionAt(words, 500, 105), 45)
  assert.equal(sweepPositionAt(words, 1000, 105), 90)
  assert.equal(sweepPositionAt(words, 1500, 105), 97.5)
})
test('fast overlapping QRC words reach the current word immediately', () => {
  const words = [
    { start: 0, duration: 1200, left: 0, right: 80 },
    { start: 200, duration: 1000, left: 80, right: 100 },
    { start: 400, duration: 100, left: 100, right: 160 },
  ]
  assert.equal(sweepPositionAt(words, 400, 160), 100)
  assert.equal(sweepPositionAt(words, 450, 160), 130)
  assert.equal(sweepPositionAt(words, 500, 160), 160)
})
test('gaps, zero-duration tokens and seeking use the absolute word timeline', () => {
  const words = [
    { start: 1000, duration: 100, left: 0, right: 40 },
    { start: 2000, duration: 0, left: 40, right: 80 },
  ]
  assert.equal(sweepPositionAt(words, 900, 84), 0)
  assert.equal(sweepPositionAt(words, 1500, 84), 40)
  assert.equal(sweepPositionAt(words, 2000, 84), 84)
  assert.equal(sweepPositionAt(words, 1050, 84), 20)
})
test('long English lines keep the sung word visible rather than running an independent marquee', () => {
  assert.equal(followWordOffset(100, 1000, 200), 0)
  const x = 650
  const offset = followWordOffset(x, 1000, 200)
  assert.equal(x - offset, 110)
  assert.equal(followWordOffset(1000, 1000, 200), 800)
  assert.equal(followWordOffset(50, 100, 200), 0)
})
