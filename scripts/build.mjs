// Development-only loader preview; ordinary plugin releases use npm run release.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {patchLoader} from './lib/patch.mjs'
const root=fileURLToPath(new URL('..',import.meta.url)),app=resolve(process.argv[2]||'backup/ZCode.app')
const result=patchLoader(readFileSync(join(app,'Contents/Resources/app.asar')),root)
mkdirSync(join(root,'dist'),{recursive:true})
writeFileSync(join(root,'dist/app.asar'),result.buffer)
writeFileSync(join(root,'dist/manifest.json'),JSON.stringify({loader:1,version:result.version,sourceAsarHash:result.originalHash,patchedAsarHash:result.patchedHash,headerHash:result.headerHash},null,2))
console.log('Fixed loader built. Runtime updates do not rebuild this archive.')
