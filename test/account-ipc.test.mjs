import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

test('account operations use the trusted existing bridge without changing music preferences', async () => {
  const directory = fileURLToPath(new URL('../plugin', import.meta.url)), handlers = new Map()
  const renderer = '/official/renderer/index.html', reads = [], writes = []
  const require = name => {
    if (name === 'electron') return { app: { whenReady: () => Promise.resolve() },
      safeStorage: { isEncryptionAvailable: () => false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }
    if (name === 'node:fs') return { readFileSync: file => { reads.push(file); return '{"enabled":false}' },
      writeFileSync: (...args) => writes.push(args), renameSync() {}, mkdirSync() {} }
    if (name === 'node:url') return { fileURLToPath, pathToFileURL }
    if (name === 'node:path') return { join }
    if (name === 'node:child_process') return { execFile() { throw Error('Must not control playback') } }
    throw Error(name)
  }
  vm.runInNewContext(readFileSync(join(directory, 'main.cjs'), 'utf8') + '\nmodule.exports({runtimeDir:"/runtime",rendererPath:"/official/renderer/index.html",settingsDir:"/settings"})',
    { module: { exports: null }, require, __dirname: directory, Date, URL, console },
    { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
  await Promise.resolve()
  const frame = { url: pathToFileURL(renderer).href }, event = { senderFrame: frame, sender: { mainFrame: frame } }
  const configure = handlers.get('zcode-music:configure')
  const status = await configure(event, { account: { action: 'status' }, enabled: true })
  assert.equal(status.account, null); assert.equal(status.login, null)
  assert.equal((await handlers.get('zcode-music:snapshot')(event)).state, 'disabled')
  assert.equal(writes.length, 0); assert.deepEqual(reads, ['/settings/settings.json'])
  for (const other of [{ url: 'https://evil.example/' }, { url: pathToFileURL(renderer).href }]) {
    assert.throws(() => configure({ senderFrame: other, sender: event.sender }, { account: { action: 'start', type: 'qq' } }), /Untrusted/)
  }
  await assert.rejects(configure(event, { account: { action: 'export-cookies' } }), /不支持的账号操作/)
  await assert.rejects(configure(event, { account: { action: 'start', type: 'other' } }), /不支持的登录方式/)
})
