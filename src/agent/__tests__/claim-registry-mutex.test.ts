import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SessionRegistry } from '../session-registry.js'
import { resolveBetterSqlite3 } from '../../repo/native-resolver.js'
import { preWriteClaimPaths, makePathClaimResolver, claimPathCandidates } from '../pre-write-claims.js'
import { FileHistory } from '../file-history.js'
import { makeOwnershipGuard } from '../checkpoint.js'

const Database = resolveBetterSqlite3(import.meta.url)

function messageFrom(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('claim worker timed out')), 20_000)
    const onExit = (code: number | null) => finish(new Error(`claim worker exited: ${code}`))
    const onMessage = (message: unknown) => finish(null, message)
    const finish = (error: Error | null, message?: unknown) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('message', onMessage)
      child.off('error', onError)
      if (error) reject(error)
      else resolve(message)
    }
    const onError = (error: Error) => finish(error)
    child.once('exit', onExit)
    child.once('error', onError)
    child.once('message', onMessage)
  })
}

describe('claim registry mutex and path identity', { skip: !Database }, () => {
  let dir: string
  let registry: SessionRegistry
  let raw: any
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'claim-mutex-'))
    registry = await SessionRegistry.create(dir)
    raw = new Database(join(dir, 'registry.db'))
    raw.pragma('busy_timeout = 3000')
  })
  afterEach(() => {
    raw.close()
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const types of [Array(6).fill('exclusive'), ['exclusive', 'shared_read', 'exclusive', 'shared_read', 'exclusive', 'shared_read'], Array(6).fill('shared_read')]) {
    it(`serializes independent processes (${types.join(', ')})`, async () => {
      const children: ChildProcess[] = []
      try {
        await Promise.all(types.map(async (type, i) => {
          const child = fork(fileURLToPath(new URL('./fixtures/claim-mutex-worker.ts', import.meta.url)), [dir, `peer-${i}`, type], {
            execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          })
          children.push(child)
          let errors = ''
          child.stderr!.on('data', chunk => { errors += String(chunk) })
          const ready = await messageFrom(child)
          assert.equal(ready.ready, true, errors)
        }))
        const results = children.map(child => messageFrom(child))
        for (const child of children) child.send('go')
        const acquired = (await Promise.all(results)).filter(r => r.acquired).length
        const rows = raw.prepare('SELECT session_id, claim_type FROM claims WHERE file_path = ?').all('src/file.ts')
        assert.equal(rows.length, acquired, 'every successful acquisition must persist exactly one owner row')
        assert.ok(rows.length > 0, 'real SQLite must be used, not the null backend')
        if (rows.some((r: any) => r.claim_type === 'exclusive')) assert.equal(rows.length, 1, 'exclusive must not coexist with another owner')
        else assert.ok(rows.every((r: any) => r.claim_type === 'shared_read'))
        if (types.every(type => type === 'shared_read')) assert.equal(acquired, types.length, 'shared readers must coexist')
      } finally {
        await Promise.all(children.map(child => new Promise<void>(resolve => {
          if (child.exitCode !== null) return resolve()
          child.once('exit', () => resolve())
          child.kill()
        })))
      }
    })
  }

  it('does not upgrade our shared claim past a peer reader', () => {
    registry.register('a', '/workspace')
    registry.register('b', '/workspace')
    assert.equal(registry.acquireClaim('a', 'x.ts', 'shared_read'), true)
    assert.equal(registry.acquireClaim('b', 'x.ts', 'shared_read'), true)
    assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), false)
    registry.releaseClaim('b', 'x.ts')
    assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), true)
    assert.equal(registry.checkClaim('x.ts')?.claimType, 'exclusive')
    assert.equal(registry.acquireClaim('b', 'x.ts', 'shared_read'), false)
    assert.equal(registry.acquireClaim('a', 'x.ts', 'shared_read'), true)
    assert.equal(registry.checkClaim('x.ts')?.claimType, 'exclusive', 'renewal must not silently downgrade exclusive')
  })

  it('fails closed when the conflict query fails', () => {
    const db = (registry as any).db
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (sql.includes('SELECT') && sql.includes('FROM claims')) throw new Error('injected read failure')
      return prepare(sql)
    }
    try {
      assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), false)
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0)
    } finally { db.prepare = prepare }
  })

  it('rejects renewal when the touch write fails', () => {
    assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), true)
    const touched = registry.claimLiveness('x.ts')!.lastTouchedAt
    const db = (registry as any).db
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (sql.startsWith('UPDATE claims SET claim_type')) throw new Error('injected touch failure')
      return prepare(sql)
    }
    try {
      assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), false)
      assert.equal(registry.claimLiveness('x.ts')!.lastTouchedAt, touched)
    } finally { db.prepare = prepare }
  })

  it('changes the CAS credential for renewals in the same millisecond', t => {
    t.mock.method(Date, 'now', () => Date.parse('2026-10-11T00:00:00.000Z'))
    registry.acquireClaim('a', 'x.ts', 'exclusive')
    const touched = registry.claimLiveness('x.ts')!.lastTouchedAt
    registry.acquireClaim('a', 'x.ts', 'exclusive')
    assert.notEqual(registry.claimLiveness('x.ts')!.lastTouchedAt, touched)
    assert.equal(registry.releaseClaimIfUnchanged('a', 'x.ts', touched), false)
  })

  it('rejects acquisition on write-lock timeout and succeeds after unlock', () => {
    ;(registry as any).db.pragma('busy_timeout = 1')
    raw.exec('BEGIN IMMEDIATE')
    try {
      assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), false)
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 0)
    } finally { raw.exec('ROLLBACK') }
    assert.equal(registry.acquireClaim('a', 'x.ts', 'exclusive'), true)
  })

  it('consolidates legacy owner aliases without dropping a conflicting live owner', async () => {
    registry.register('a', 'C:\\workspace')
    registry.register('b', 'C:/workspace')
    raw.exec('DROP INDEX IF EXISTS idx_claims_owner_file')
    const insert = raw.prepare('INSERT INTO claims (session_id, file_path, claim_type, acquired_at, last_touched_at) VALUES (?, ?, ?, ?, ?)')
    const earlier = '2026-10-11T00:00:00.000Z'
    const later = '2026-10-11T00:00:01.000Z'
    insert.run('a', './src/file.ts', 'exclusive', earlier, earlier)
    insert.run('a', 'C:\\workspace\\src\\file.ts', 'shared_read', later, later)
    insert.run('a', 'src/file.ts', 'exclusive', earlier, earlier)
    insert.run('b', '.\\src\\file.ts', 'exclusive', earlier, earlier)
    const reopened = await SessionRegistry.create(dir)
    try {
      const rows = raw.prepare('SELECT session_id, file_path, claim_type, last_touched_at FROM claims ORDER BY session_id').all()
      assert.deepEqual(rows, [
        { session_id: 'a', file_path: 'src/file.ts', claim_type: 'exclusive', last_touched_at: later },
        { session_id: 'b', file_path: 'src/file.ts', claim_type: 'exclusive', last_touched_at: earlier },
      ])
      assert.equal(reopened.acquireClaim('a', 'src/file.ts', 'exclusive'), false, 'legacy conflicting owners block even our renewal')
      assert.equal(reopened.acquireClaim('b', 'src/file.ts', 'exclusive'), false)
      assert.equal(reopened.checkClaim('src/file.ts', 'a')?.sessionId, 'b')
      assert.equal(reopened.claimLiveness('src/file.ts', 'a')?.ownerSessionId, 'b')
      assert.equal(makePathClaimResolver(reopened, 'a', 'C:\\workspace').isOwnedByOther('src/file.ts'), true)
      assert.throws(() => insert.run('a', 'src/file.ts', 'exclusive', earlier, later), /UNIQUE/)
      const again = await SessionRegistry.create(dir)
      again.close()
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 2, 'reopening is idempotent')
      reopened.releaseClaim('b', 'C:/workspace/src/file.ts')
      assert.equal(reopened.acquireClaim('a', 'src/file.ts', 'exclusive'), true)
    } finally { reopened.close() }
  })

  it('does not permit claims after schema initialization fails', async () => {
    raw.exec('DROP TABLE claims; CREATE TABLE claims (broken TEXT)')
    const broken = await SessionRegistry.create(dir)
    try { assert.equal(broken.acquireClaim('a', 'x.ts', 'exclusive'), false) }
    finally { broken.close() }
  })

  it('does not permit claims when the database cannot be opened', async () => {
    const brokenDir = join(dir, 'cannot-open')
    mkdirSync(join(brokenDir, 'registry.db'), { recursive: true })
    const broken = await SessionRegistry.create(brokenDir)
    try { assert.equal(broken.acquireClaim('a', 'x.ts', 'exclusive'), false) }
    finally { broken.close() }
  })

  it('rewind and rollback lookups see the peer reader behind our own row', async () => {
    const target = join(dir, 'file.txt')
    writeFileSync(target, 'before')
    const guard = makeOwnershipGuard(registry, 'a', dir)
    const history = new FileHistory(join(dir, 'backups'), 'a', guard)
    await history.trackEdit(target, 'edit')
    writeFileSync(target, 'peer content')
    registry.register('a', dir)
    registry.register('b', dir)
    registry.acquireClaim('a', './file.txt', 'shared_read')
    registry.acquireClaim('b', 'file.txt', 'shared_read')
    assert.equal(guard.blockerOf!(target)?.sessionId, 'b')
    const result = await history.rewindToBoundary(new Set(['edit']))
    assert.deepEqual(result.skipped, [target])
    assert.equal(readFileSync(target, 'utf8'), 'peer content')
  })

  it('raw rewind registry lookup sees peer readers behind our own row', async () => {
    const target = join(dir, 'outside.txt')
    // An approved outside-workspace path retains its absolute claim key.
    registry.register('a', '/workspace')
    registry.register('b', '/workspace')
    registry.acquireClaim('a', target, 'shared_read')
    registry.acquireClaim('b', target, 'shared_read')
    writeFileSync(target, 'before')
    const history = new FileHistory(join(dir, 'backups'), 'a', registry)
    await history.trackEdit(target, 'edit')
    writeFileSync(target, 'peer content')
    const result = await history.rewindToBoundary(new Set(['edit']))
    assert.deepEqual(result.skipped, [target])
    assert.equal(readFileSync(target, 'utf8'), 'peer content')
  })

  for (const cwd of ['/workspace', 'C:\\workspace', 'C:/workspace']) {
    it(`uses one write/query/release key across path shapes (${cwd})`, () => {
      registry.register('a', cwd)
      registry.register('b', cwd)
      const paths = ['./src/file.ts', 'src/file.ts', '.\\src\\file.ts', `${cwd}/src/file.ts`, `${cwd}\\src\\file.ts`, 'src/../src/file.ts']
      for (const path of paths) {
        const keys = preWriteClaimPaths({ id: 'write', name: 'write_file', input: { file_path: path } }, cwd)
        assert.deepEqual(keys, ['src/file.ts'], path)
        assert.equal(registry.acquireClaim('a', keys[0]!, 'exclusive'), true)
      }
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get().n, 1)
      const resolver = makePathClaimResolver(registry, 'b', cwd)
      for (const path of paths) assert.equal(resolver.isOwnedByOther(path), true, path)
      assert.equal(registry.acquireClaim('b', './src/file.ts', 'exclusive'), false, 'worker/raw acquisition also normalizes')
      const touched = registry.claimLiveness('./src/file.ts')!.lastTouchedAt
      assert.equal(registry.releaseClaimIfUnchanged('a', '.\\src\\file.ts', touched), true)
      assert.equal(registry.acquireClaim('b', 'src/file.ts', 'exclusive'), true)
      registry.releaseClaim('b', './src/file.ts')
      assert.equal(registry.checkClaim('src/file.ts'), null)
    })
  }

  it('lookup candidates retain legacy mixed Windows ./ keys', () => {
    const candidates = claimPathCandidates('C:\\workspace', 'src/file.ts')
    for (const key of ['./src/file.ts', './src\\file.ts', '.\\src\\file.ts']) assert.ok(candidates.includes(key), key)
  })
})
