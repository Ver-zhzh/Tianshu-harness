/**
 * Tests for semantic-index.ts — isStale, incrementalUpdate, fallback rebuild.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SemanticIndex } from '../semantic-index.js'

const TEST_DIR = join(tmpdir(), 'rivet-si-test')

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }) } catch { /* cleanup */ }
}

describe('semantic-index', () => {
  setup()

  it('rebuild indexes source files', () => {
    try { rmSync(join(TEST_DIR, '.rivet'), { recursive: true }) } catch {}
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'hello.ts'), 'export function hello() { return "world" }')
    const idx = new SemanticIndex(TEST_DIR)
    const result = idx.rebuild(10)
    assert.ok(result.indexed >= 1)
    assert.ok(idx.chunkCount > 0)
  })

  it('isStale detects modified files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'stale.ts'), 'const x = 1')
    const idx = new SemanticIndex(TEST_DIR, undefined, { staleTtlMs: 0 })
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    // Modify the file
    writeFileSync(join(TEST_DIR, 'src', 'stale.ts'), 'const x = 2')
    assert.equal(idx.isStale(), true)
  })

  it('isStale detects new files', () => {
    // Clean snapshot from previous tests
    try { rmSync(join(TEST_DIR, '.rivet'), { recursive: true }) } catch {}
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'a.ts'), 'const a = 1')
    const idx = new SemanticIndex(TEST_DIR, undefined, { staleTtlMs: 0 })
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    // Add a new file not in the index
    writeFileSync(join(TEST_DIR, 'src', 'b.ts'), 'const b = 2')
    assert.equal(idx.isStale(), true)
  })

  it('isStale detects deleted files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'del.ts'), 'const d = 1')
    const idx = new SemanticIndex(TEST_DIR, undefined, { staleTtlMs: 0 })
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    rmSync(join(TEST_DIR, 'src', 'del.ts'))
    assert.equal(idx.isStale(), true)
  })

  it('incrementalUpdate reindexes changed files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'inc.ts'), 'const i = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    writeFileSync(join(TEST_DIR, 'src', 'inc.ts'), 'const i = 2')
    const update = idx.incrementalUpdate()
    assert.equal(update.reindexed, 1)
    assert.equal(idx.isStale(), false)
  })

  it('incrementalUpdate removes deleted files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'rem.ts'), 'const r = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    rmSync(join(TEST_DIR, 'src', 'rem.ts'))
    const update = idx.incrementalUpdate()
    assert.equal(update.removed, 1)
  })

  it('incrementalUpdate falls back to rebuild when >20% changed', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    // Create 6 files
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(TEST_DIR, 'src', `fb${i}.ts`), `const fb${i} = ${i}`)
    }
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    // Delete 2 files (33% change → triggers fallback)
    rmSync(join(TEST_DIR, 'src', 'fb0.ts'))
    rmSync(join(TEST_DIR, 'src', 'fb1.ts'))
    const update = idx.incrementalUpdate()
    assert.equal(update.fallbackRebuild, true)
  })

  it('persistMeta saves and loadMeta restores chunks', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'persist.ts'), 'export const p = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    const chunkCount = idx.chunkCount
    assert.ok(chunkCount > 0)

    // Simulate process restart: new SemanticIndex loads from disk
    const idx2 = new SemanticIndex(TEST_DIR)
    assert.equal(idx2.chunkCount, chunkCount) // chunks restored
    assert.equal(idx2.isStale(), false)
  })

  it('search returns results after rebuild', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'searchable.ts'), 'export function authenticateUser(token: string) { return true }')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    const hits = idx.search('authenticate user token', 5)
    assert.ok(hits.length >= 1)
    assert.ok(hits[0]!.file.includes('searchable.ts'))
  })

  it('isStale returns cached verdict within TTL without rescanning', () => {
    const dir = join(TEST_DIR, 'ttl-cache')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'c.ts'), 'const c = 1')
    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 60_000 })
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    // Change on disk is invisible while the cached verdict is still fresh
    writeFileSync(join(dir, 'src', 'c.ts'), 'const c = 2')
    assert.equal(idx.isStale(), false)
  })

  it('isStale rescans after TTL expiry and rebuild rewrites the cache', async () => {
    const dir = join(TEST_DIR, 'ttl-expiry')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'e.ts'), 'const e = 1')
    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 30 })
    idx.rebuild(10)

    writeFileSync(join(dir, 'src', 'e.ts'), 'const e = 2')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(idx.isStale(), true) // TTL expired → real scan sees the change

    // Rebuild must overwrite the cached `true` with an accurate fresh verdict
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)
  })

  it('incrementalUpdate rewrites the staleness cache', async () => {
    const dir = join(TEST_DIR, 'ttl-incr')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'u.ts'), 'const u = 1')
    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 30 })
    idx.rebuild(10)

    writeFileSync(join(dir, 'src', 'u.ts'), 'const u = 2')
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(idx.isStale(), true)

    idx.incrementalUpdate()
    assert.equal(idx.isStale(), false) // fresh verdict cached — no TTL wait needed
  })

  it('staleTtlMs 0 disables the cache', () => {
    const dir = join(TEST_DIR, 'ttl-zero')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'z.ts'), 'const z = 1')
    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    idx.rebuild(10)

    writeFileSync(join(dir, 'src', 'z.ts'), 'const z = 2')
    assert.equal(idx.isStale(), true) // every call rescans
  })

  it('rebuild 不跟随指向工作区外的符号链接（工作区隔离绕过回归）', () => {
    const dir = join(TEST_DIR, 'symlink-escape')
    const vault = join(TEST_DIR, 'symlink-vault')
    for (const d of [dir, vault]) {
      if (existsSync(d)) rmSync(d, { recursive: true })
      mkdirSync(d, { recursive: true })
    }
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export function ok() { return 1 }')
    writeFileSync(join(vault, 'secret-config.json'), '{"db_password": "CANARY_SYMLINK_ESCAPE"}')
    try {
      symlinkSync(vault, join(dir, 'evil-link'))
    } catch {
      return // 平台不支持 symlink（如 Windows 无权限 CI）时跳过
    }

    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    const stats = idx.rebuild(50)
    assert.equal(stats.indexed, 1) // 只索引了 src/ok.ts
    assert.equal(idx.search('db_password', 10).length, 0) // 搜索无泄漏
    const snapshot = readFileSync(join(dir, '.rivet', 'semantic-index.json'), 'utf-8')
    assert.ok(!snapshot.includes('CANARY_SYMLINK_ESCAPE')) // 快照无泄漏
    assert.ok(idx.chunkCount > 0) // 正常文件仍被索引
  })

  it('目录被换成 symlink 后重读不越界（TOCTOU 回归）', () => {
    const dir = join(TEST_DIR, 'dirswap-escape')
    const vault = join(TEST_DIR, 'dirswap-vault')
    for (const d of [dir, vault]) {
      if (existsSync(d)) rmSync(d, { recursive: true })
      mkdirSync(d, { recursive: true })
    }
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'notes.json'), '{"note": "harmless"}')
    writeFileSync(join(vault, 'notes.json'), '{"db_password": "CANARY_DIRSWAP_ESCAPE"}')

    const idx = new SemanticIndex(dir, undefined, { staleTtlMs: 0 })
    idx.rebuild(50)
    assert.equal(idx.isStale(), false)

    // 索引完成后把 sub 换成指向外部 vault 的 symlink
    renameSync(join(dir, 'sub'), join(dir, 'sub-real'))
    try {
      symlinkSync(vault, join(dir, 'sub'))
    } catch {
      return // 平台不支持 symlink 时跳过
    }
    assert.equal(idx.isStale(), true) // 内容变化被检出（fail-closed 判 stale）
    idx.incrementalUpdate()
    assert.equal(idx.search('db_password', 10).length, 0) // 外部内容未入库
  })

  teardown()
})
