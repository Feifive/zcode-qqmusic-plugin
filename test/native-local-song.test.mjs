import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const schema = 'CREATE TABLE SONGS(id BIGINT,type INTEGER,name TEXT,singer TEXT,album TEXT,K_SONG_RESERVE1 TEXT,K_SONG_RESERVE9 TEXT,K_SONG_RESERVE12 INTEGER,PRIMARY KEY(id,type));'
const insert = "INSERT INTO SONGS VALUES(105392885,13,'一棵会开花的树','谢春花','谢春花作品选集 (2015)','000CUTL63LNV46','001Qp10A3tDOIX',176000);"
const title = '一棵会开花的树'

test('native local reader binds SQL, validates schema, bounds candidates and observes live WAL without writing', { skip: process.platform !== 'darwin', timeout: 20000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'zcode-local-test-')), executable = join(temp, 'local-reader')
  let writer
  try {
    execFileSync('/usr/bin/clang', ['-O2', '-DZCODE_MUSIC_LOCAL_TEST', '-fobjc-arc', '-fmodules', '-fmodules-cache-path=/tmp/zcode-clang-cache',
      '-framework', 'Foundation', '-lsqlite3', fileURLToPath(new URL('../native/local-song.m', import.meta.url)), '-o', executable])
    const run = (path, input = { title }) => JSON.parse(execFileSync(executable, [path], { input: JSON.stringify(input), timeout: 2000, encoding: 'utf8' }))
    const db = join(temp, 'library.sqlite')
    execFileSync('/usr/bin/sqlite3', [db], { input: schema + insert })
    const before = readFileSync(db)
    const result = run(db)
    assert.equal(result.schema, 'qqmusic-songs-v1'); assert.equal(result.songs.length, 1)
    assert.deepEqual(result.songs[0], { songid: '105392885', storageType: 13, name: title, singer: '谢春花', album: '谢春花作品选集 (2015)',
      songmid: '000CUTL63LNV46', albumMid: '001Qp10A3tDOIX', durationMs: 176000 })
    assert.deepEqual(run(db, { title: "' OR 1=1; DROP TABLE SONGS; --" }).songs, [])
    assert.deepEqual(readFileSync(db), before, 'identity reads must not change the main database')
    assert.ok(run(db, { title: 'x\0y' }).error)
    assert.ok(run(db, { title: 'x'.repeat(1025) }).error)
    const missing = join(temp, 'missing.sqlite')
    assert.ok(run(missing).error); assert.equal(existsSync(missing), false, 'read-only open must not create a database')
    const incompatible = join(temp, 'incompatible.sqlite')
    execFileSync('/usr/bin/sqlite3', [incompatible], { input: 'CREATE TABLE SONGS(id INTEGER,name TEXT);' })
    assert.ok(run(incompatible).error)
    const corrupt = join(temp, 'corrupt.sqlite')
    writeFileSync(corrupt, 'not a SQLite database')
    assert.ok(run(corrupt).error)

    // Keep a writer connection alive so committed pages stay in WAL, then
    // hold its write lock. The reader must see the new committed song without
    // copying/ignoring WAL or acquiring a write transaction.
    writer = spawn('/usr/bin/sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    writer.stderr.on('data', data => errors += data)
    const ready = new Promise((resolve, reject) => {
      writer.stdout.on('data', data => { output += data; if (output.includes('writer-ready')) resolve() })
      writer.once('error', reject)
      writer.once('exit', code => { if (!output.includes('writer-ready')) reject(Error(`Writer exited ${code}: ${errors}`)) })
    })
    writer.stdin.write("PRAGMA journal_mode=WAL;\nINSERT INTO SONGS VALUES(12,13,'WAL only','Singer','Album','walMid','albumMid',100000);\nBEGIN IMMEDIATE;\n.print writer-ready\n")
    await ready
    const walBefore = readFileSync(db + '-wal'), mainBefore = readFileSync(db)
    assert.equal(run(db, { title: 'WAL only' }).songs[0].songid, '12')
    assert.deepEqual(readFileSync(db + '-wal'), walBefore); assert.deepEqual(readFileSync(db), mainBefore)
    const exit = once(writer, 'exit'); writer.stdin.end('ROLLBACK;\n.quit\n'); await exit; writer = null
    assert.equal(errors, '')
    // In rollback-journal mode an exclusive writer really blocks readers.
    // Fail promptly and return no partial identities, then recover afterward.
    const locked = join(temp, 'locked.sqlite')
    execFileSync('/usr/bin/sqlite3', [locked], { input: schema + insert })
    writer = spawn('/usr/bin/sqlite3', [locked], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lockReady = new Promise(resolve => writer.stdout.on('data', data => { if (String(data).includes('locked')) resolve() }))
    writer.stdin.write('BEGIN EXCLUSIVE;\n.print locked\n'); await lockReady
    assert.ok(run(locked).error)
    const lockExit = once(writer, 'exit'); writer.stdin.end('ROLLBACK;\n.quit\n'); await lockExit; writer = null
    assert.equal(run(locked).songs.length, 1)
    execFileSync('/usr/bin/sqlite3', [db], { input: "WITH RECURSIVE ids(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<65) INSERT INTO SONGS SELECT n+100,13,'Many','Singer','Album','mid','album',1000 FROM ids;" })
    assert.equal(run(db, { title: 'Many' }).error, 'too-many-local-candidates')
  } finally {
    writer?.kill()
    rmSync(temp, { recursive: true, force: true })
  }
})
