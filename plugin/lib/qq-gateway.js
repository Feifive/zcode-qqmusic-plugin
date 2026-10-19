// Login protocol adapted from kendu76/dsh-music-player (MIT).
// Copyright (c) 2026 kendu76
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const QQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const ENDPOINTS = ['u.y.qq.com', 'szu.y.qq.com', 'shu.y.qq.com']

export function hash33(text, seed = 0) {
  let value = seed
  for (let i = 0; i < text.length; i++) value = (value * 33 + text.charCodeAt(i)) >>> 0
  return value & 0x7fffffff
}

// Tokenize strings as a unit so digits in quoted values stay untouched. JSON.parse
// still validates the complete document; unsafe integer literals become strings.
export function parseJsonPreserveBigInt(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token, number) => {
    return number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number)) ? JSON.stringify(number) : token
  }))
}

export function responseCookies(headers) {
  const result = Object.create(null)
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0], index = pair.indexOf('=')
    if (index < 1) continue
    const key = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim()
    if (value) result[key] = value
  }
  return result
}

export function joinCookies(cookies) {
  return Object.entries(cookies).filter(([key, value]) => /^[\w-]+$/.test(key) && typeof value === 'string' && value && !/[;\r\n]/.test(value))
    .map(([key, value]) => `${key}=${value}`).join('; ')
}

export function createQQGateway({ fetchImpl = globalThis.fetch } = {}) {
  async function request(url, { signal, timeoutMs = 12000, maxBytes = 2 * 1024 * 1024, ...options } = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/', ...options.headers } })
      // Keep timeout/cancellation active through body consumption too.
      let body
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > maxBytes) throw Error('QQ response too large')
            chunks.push(value)
          }
          body = Buffer.concat(chunks, size)
        } finally { await reader.cancel().catch(() => {}) }
      } else body = Buffer.from(await response.arrayBuffer())
      if (body.length > maxBytes) throw Error('QQ response too large')
      return { status: response.status, headers: response.headers, body, text: body.toString('utf8') }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async function login({ module, method, param, cookies = {}, referer, wx = false, signal }) {
    const body = JSON.stringify({ comm: { ...(wx ? { tmeAppID: 'qqmusic', tmeLoginType: '1' } : {}),
      g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 }, req: { module, method, param } })
    for (const host of ENDPOINTS) {
      try {
        const response = await request(`https://${host}/cgi-bin/musicu.fcg`, { method: 'POST', signal, body,
          headers: { Referer: referer, Origin: 'https://y.qq.com', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: joinCookies(cookies) } })
        if (response.status !== 200) continue
        const parsed = parseJsonPreserveBigInt(response.text)
        if (parsed.code !== 0 || parsed.req?.code !== 0) continue
        return { cookies: { ...cookies, ...responseCookies(response.headers) }, data: parsed.req.data || {} }
      } catch (error) { if (signal?.aborted) throw error }
    }
    throw Error('QQ 音乐凭据兑换失败，请重新扫码')
  }
  return { request, login }
}
