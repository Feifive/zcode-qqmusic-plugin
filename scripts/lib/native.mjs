import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../..', import.meta.url))
export function buildNativeLibrary(output, { universal = true } = {}) {
  execFileSync('/usr/bin/clang', ['-O2', '-dynamiclib', ...(universal ? ['-arch', 'arm64', '-arch', 'x86_64'] : []),
    '-mmacosx-version-min=12.0', '-DZCODE_MUSIC_LIBRARY', '-fobjc-arc', '-fmodules', '-fmodules-cache-path=/tmp/zcode-clang-cache',
    '-framework', 'AppKit', '-framework', 'ImageIO', '-framework', 'CoreGraphics', '-lsqlite3',
    join(root, 'native/now-playing.m'), join(root, 'native/artwork.m'), join(root, 'native/local-song.m'), '-o', output], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' })
}
