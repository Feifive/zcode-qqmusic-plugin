import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(root, 'package.json')))
const stage = join(root, 'dist', `zcode-music-plugin-${version}`)
const zip = `${stage}-source.zip`
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const name of ['package.json', 'README.md', 'INSTALL-OTHER-MAC.md', 'preview.html', '.gitignore', 'plugin', 'native', 'scripts', 'test', 'loader', 'release']) {
  cpSync(join(root, name), join(stage, name), { recursive: true, dereference: true })
}
mkdirSync(join(stage, 'research'), { recursive: true })
cpSync(join(root, 'research/qqmusic-magic-color-spec.md'), join(stage, 'research/qqmusic-magic-color-spec.md'))
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', stage, zip])
console.log(zip)
