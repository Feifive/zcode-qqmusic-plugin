import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {parseAsar,readEntry,patchAsar,hash} from '../asar.mjs'
export const LOADER_MARKER='zcode-music-loader/main.cjs'
export function patchLoader(source,projectRoot){
 const archive=parseAsar(source),pkg=JSON.parse(readEntry(archive,'package.json'))
 if(pkg.name!=='@zcode/desktop'||pkg.version!=='3.15.3')throw Error('尚未适配此 ZCode 版本：'+pkg.version)
 const main=readEntry(archive,'out/main/index.js').toString(),preload=readEntry(archive,'out/preload/index.cjs').toString(),html=readEntry(archive,'out/renderer/index.html').toString()
 if(main.includes(LOADER_MARKER)||preload.includes('zcodeMusic'))throw Error('所选应用已包含音乐插件，请使用未修改的官方应用')
 const assets=archive.header.files.out.files.renderer.files.assets.files
 if(!Object.keys(assets).some(n=>n.startsWith('styles-')&&['chat-composer-input-surface','data-v4-timeline-scroll','data-following'].every(s=>readEntry(archive,'out/renderer/assets/'+n).includes(s))))throw Error('ZCode 界面挂载点已改变')
 const replacements=new Map([
 ['out/main/index.js',Buffer.from(main+'\n// ZCode Music fixed loader v1\nimport "./'+LOADER_MARKER+'";\n')],
 ['out/preload/index.cjs',Buffer.concat([Buffer.from(preload+'\n'),readFileSync(join(projectRoot,'plugin/preload.cjs'))])],
 ['out/renderer/index.html',Buffer.from(html.replace('</head>','<script defer src="./zcode-music-loader.js"></script>\n</head>'))],
 ['out/renderer/zcode-music-loader.js',readFileSync(join(projectRoot,'loader/renderer.js'))],
 ])
 for(const name of ['main.cjs','store.cjs','updates.cjs','release-key.pem'])replacements.set('out/main/zcode-music-loader/'+name,readFileSync(join(projectRoot,'loader',name)))
 const result=patchAsar(source,replacements)
 for(const[p,b]of replacements)if(!readEntry(parseAsar(result.buffer),p).equals(b))throw Error('Loader archive verification failed')
 return {...result,version:pkg.version,originalHash:hash(source),patchedHash:hash(result.buffer)}
}
