// DOM Range uses UTF-16 offsets, not a count of code points or characters.
// QRC tokens concatenate to the displayed line (apart from trimmed edge spaces
// and an optional untimed tail). Keep exact offsets for spaces and punctuation.
export function wordTextRanges(text, words) {
  const source = words.map(word => String(word.text ?? '')).join('')
  const leading = source.length - source.trimStart().length
  const contiguous = text.startsWith(source.trim())
  let cursor = 0
  let searchFrom = 0
  const ranges = []
  for (const word of words) {
    const token = String(word.text ?? '')
    let from, to
    if (contiguous) {
      from = Math.max(0, Math.min(text.length, cursor - leading))
      to = Math.max(from, Math.min(text.length, cursor + token.length - leading))
    } else {
      const needle = token.trim()
      from = needle ? text.indexOf(needle, searchFrom) : -1
      to = from + needle.length
    }
    cursor += token.length
    if (from < 0 || to <= from || !Number.isFinite(word.start)) continue
    searchFrom = to
    ranges.push({ from, to, start: word.start, duration: Math.max(0, Number(word.duration) || 0) })
  }
  return ranges
}

// Select the latest started word. Summing each word's partial duration leaves
// unfinished earlier words behind when QRC durations overlap (e.g. fast rap).
export function sweepPositionAt(words, time, width) {
  let active = -1
  for (let i = 0; i < words.length; i++) if (words[i].start <= time) active = i
  if (active < 0) return 0
  const word = words[active]
  const progress = word.duration > 0 ? Math.min(1, Math.max(0, (time - word.start) / word.duration)) : 1
  const x = active === words.length - 1 && progress === 1 ? width : word.left + (word.right - word.left) * progress
  return Math.min(width, Math.max(0, x))
}

export function followWordOffset(x, width, viewportWidth) {
  return Math.min(Math.max(0, width - viewportWidth), Math.max(0, x - viewportWidth * 0.55))
}
