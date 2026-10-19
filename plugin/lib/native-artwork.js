import { execFile } from 'node:child_process'

const MAX_BYTES = 2 * 1024 * 1024

export function createImageIOThumbnailer({ reader, helper, run = execFile }) {
  if (!reader || !helper) throw Error('Missing artwork helper path')
  let queue = Promise.resolve()
  return bytes => {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return Promise.reject(Error('Invalid artwork input'))
    // Deduplicate per album in the cache; serialize different albums as well.
    const job = queue.then(() => new Promise((resolve, reject) => {
      const child = run('/usr/bin/perl', [reader, helper], {
        env: { ...process.env, ZCODE_MUSIC_ACTION: 'artwork' }, timeout: 3000, maxBuffer: 8192,
      }, (error, stdout) => {
        if (error) { reject(Error('ImageIO artwork thumbnail failed')); return }
        try {
          const result = JSON.parse(stdout)
          const { width, height, pixels } = result
          if (result.engine !== 'imageio' || result.order !== 'rgba'
            || ![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 10)
            || typeof pixels !== 'string' || pixels.length > 536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pixels)) throw Error()
          const bitmap = Buffer.from(pixels, 'base64')
          if (bitmap.length !== width * height * 4 || bitmap.toString('base64') !== pixels) throw Error()
          resolve({ pixels: bitmap, order: 'rgba', width, height })
        } catch { reject(Error('Invalid ImageIO artwork thumbnail')) }
      })
      child.stdin.on('error', () => reject(Error('ImageIO artwork input failed')))
      child.stdin.end(bytes)
    }))
    queue = job.catch(() => {})
    return job
  }
}

export function createArtworkDecoder(nativeImage, { thumbnail } = {}) {
  if (typeof thumbnail !== 'function') throw Error('Missing ImageIO artwork thumbnailer')
  return async bytes => {
    const decoded = await thumbnail(bytes)
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw Error('Invalid cover image')
    const { width, height } = image.getSize()
    return {
      pixels: decoded.pixels, order: decoded.order,
      thumbnail: image.resize({ width: 40, height: 40, quality: 'good' }).toDataURL(),
      preview: { image: image.toDataURL(), width, height },
    }
  }
}
