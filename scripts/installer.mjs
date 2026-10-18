import {readFileSync,writeFileSync,mkdirSync,cpSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import store from '../loader/store.cjs'
const root=fileURLToPath(new URL('..',import.meta.url)),{version}=JSON.parse(readFileSync(join(root,'package.json')))
const bundleFile=join(root,`release/zcode-music-${version}.json`)
const envelope=JSON.parse(readFileSync(bundleFile))
const manifest=store.verifyManifest(envelope,readFileSync(join(root,'loader/release-key.pem')),'3.15.3')
if(manifest.version!==version)throw Error('Release version differs from package.json')
for(const [name,entry]of Object.entries(manifest.files)){
 if(name.startsWith('plugin/')||name==='native/reader.pl'){if(store.digest(readFileSync(join(root,name)))!==entry.sha256)throw Error('Signed release differs from current source; regenerate with npm run release: '+name)}
}
const app=join(root,'dist/ZCode Music Installer.app'),contents=join(app,'Contents'),resources=join(contents,'Resources')
rmSync(app,{recursive:true,force:true});mkdirSync(join(contents,'MacOS'),{recursive:true});mkdirSync(resources,{recursive:true})
for(const name of ['scripts','loader','plugin/preload.cjs'])cpSync(join(root,name),join(resources,name),{recursive:true,dereference:true})
mkdirSync(join(resources,'dist'));cpSync(bundleFile,join(resources,'dist/runtime.json'))
writeFileSync(join(resources,'package.json'),JSON.stringify({type:'module'}))
writeFileSync(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.feifive.zcode-music-installer</string><key>CFBundleName</key><string>ZCode Music Installer</string><key>CFBundleExecutable</key><string>installer</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`)
execFileSync('/usr/bin/clang',['-O2','-arch','arm64','-arch','x86_64','-mmacosx-version-min=12.0','-fobjc-arc','-framework','Cocoa','-framework','UniformTypeIdentifiers',join(root,'native/installer.m'),'-o',join(contents,'MacOS/installer')],{stdio:'inherit'})
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'})
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'})
const zip=join(root,`dist/ZCode-Music-Installer-${version}-macOS.zip`)
rmSync(zip,{force:true});execFileSync('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',app,zip])
console.log(zip)
