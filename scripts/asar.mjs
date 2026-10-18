import { createHash } from 'node:crypto'

export const hash = buffer => createHash('sha256').update(buffer).digest('hex')
export function parseAsar(buffer) {
  if (buffer.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR pickle')
  const length = buffer.readUInt32LE(12)
  const headerString = buffer.subarray(16, 16 + length).toString()
  return { header: JSON.parse(headerString), headerString, data: buffer.subarray(8 + buffer.readUInt32LE(4)) }
}
export function entry(header, path, create = false) {
  const parts = path.split('/')
  let parent = header
  for (const part of parts.slice(0, -1)) {
    if (create) (parent.files ??= {})[part] ??= { files: {} }
    parent = parent.files?.[part]
    if (!parent) throw new Error(`Missing ASAR directory: ${path}`)
  }
  return { parent, name: parts.at(-1), value: parent.files?.[parts.at(-1)] }
}
export function readEntry(archive, path) {
  const { value } = entry(archive.header, path)
  if (!value || value.unpacked || value.link) throw new Error(`Not a packed file: ${path}`)
  return archive.data.subarray(Number(value.offset), Number(value.offset) + value.size)
}
export function patchAsar(source, replacements) {
  const { header, data } = parseAsar(source)
  const buffers = [data]
  let offset = data.length
  for (const [path, content] of replacements) {
    const { parent, name } = entry(header, path, true)
    const blockSize = 4 * 1024 * 1024
    const blocks = []
    for (let i = 0; i < content.length; i += blockSize) blocks.push(hash(content.subarray(i, i + blockSize)))
    if (!blocks.length) blocks.push(hash(Buffer.alloc(0)))
    parent.files[name] = { size: content.length, offset: String(offset), integrity: { algorithm: 'SHA256', hash: hash(content), blockSize, blocks } }
    buffers.push(content)
    offset += content.length
  }
  const json = Buffer.from(JSON.stringify(header))
  const pad = (4 - json.length % 4) % 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + json.length + pad, 4)
  prefix.writeUInt32LE(4 + json.length + pad, 8)
  prefix.writeUInt32LE(json.length, 12)
  return { buffer: Buffer.concat([prefix, json, Buffer.alloc(pad), ...buffers]), headerHash: hash(json) }
}
