// Compatibility with the old npm entry point; all state now lives in Application Support.
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const restore=process.argv.includes('--restore')
const target=process.argv.slice(2).find(a=>!a.startsWith('--'))
const r=spawnSync(process.execPath,[fileURLToPath(new URL('./manage.mjs',import.meta.url)),restore?'uninstall':'install',...(target?['--app',target]:[])],{stdio:'inherit',env:process.env})
process.exitCode=r.status??1
